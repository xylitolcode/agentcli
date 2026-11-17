"""目录树数据源 —— 右侧文件面板只认这一个口子。

一次只返回一层：前端展开哪个目录就请求哪个目录，避免一次性递归整棵树。
所有路径都要经过 :func:`resolve` 归一化，越出当前边界的一律拒绝 ——
这是这个模块存在的主要理由，别绕过它。

边界分两层：

* 未选项目（总目录浏览阶段）：边界是 ``CONSOLE_PROJECTS_ROOT``，看到的是
  各项目目录；
* 已进入某个项目：边界收窄到该项目根目录，``../`` 跑不回总目录。

``resolve`` 走的是 ``Path.resolve()``，符号链接会被跟到底，所以 ``../``、
绝对路径、指向外面的软链三种越界方式都在同一处被挡住。
"""

from __future__ import annotations

import os
from pathlib import Path

from django.conf import settings

from . import projects


class PathOutsideRoot(Exception):
    """请求的路径跑到了当前边界根目录外面。"""


class PathNotFound(Exception):
    """路径不存在，或者存在但不是目录/文件。"""


def read_text(rel: str, project_id: str | int | None = None) -> dict:
    """只读取文本文件，供前端代码查看器使用。

    控制台不做编辑，所以这里只有读；越界仍由 :func:`resolve` 挡住。大文件截断
    而不是拒绝，二进制给标记，让前端显示提示而不是一屏乱码。
    """
    target = resolve(rel, project_id)
    if not target.is_file():
        raise PathNotFound(rel)

    stat = target.stat()
    limit = int(settings.CONSOLE_FILE_LIMIT)
    with open(target, "rb") as handle:
        data = handle.read(limit + 1)
    truncated = len(data) > limit
    if truncated:
        data = data[:limit]

    sample = data[:4096]
    controls = sum(1 for byte in sample if byte < 9 or 13 < byte < 32)
    binary = b"\x00" in sample or (sample and controls / len(sample) > 0.1)
    text = ""
    encoding = ""
    if not binary:
        # 先按 UTF-8；截断可能切断最后一个多字节字符，去掉尾巴再试一次。
        for candidate in ("utf-8", "gb18030"):
            payloads = [data, data[:-4]] if truncated else [data]
            for payload in payloads:
                try:
                    text = payload.decode(candidate)
                except UnicodeDecodeError:
                    continue
                encoding = candidate
                break
            if encoding:
                break
        if not encoding:
            binary = True

    return {
        "path": to_rel(target, root(project_id)),
        "size": stat.st_size,
        "mtime": stat.st_mtime,
        "truncated": truncated,
        "binary": binary,
        "encoding": encoding,
        "content": text if not binary else "",
        "lines": text.count("\n") + 1 if text else 0,
    }


def root(project_id: str | int | None = None) -> Path:
    """当前边界根：传项目 id 收窄到项目根，否则是总项目目录。"""
    if project_id:
        project = projects.get_project(project_id)
        if project is not None:
            return projects.project_path(project)
    return projects.projects_root()


def to_rel(path: Path, base: Path | None = None) -> str:
    """把绝对路径还原成前端用的相对路径（POSIX 分隔符）。"""
    base = base or root()
    rel = path.relative_to(base).as_posix()
    return "" if rel == "." else rel


def resolve(rel: str, project_id: str | int | None = None) -> Path:
    """相对路径 -> 合法的绝对路径，越界即抛。"""
    base = root(project_id)
    clean = (rel or "").strip().strip("/")
    target = base if not clean else (base / clean).resolve()
    if target != base and not target.is_relative_to(base):
        raise PathOutsideRoot(rel)
    return target


def _safe_stat(entry: os.DirEntry[str]) -> os.stat_result | None:
    try:
        return entry.stat(follow_symlinks=False)
    except OSError:
        return None


def list_dir(rel: str = "", project_id: str | int | None = None) -> dict:
    """列一层目录。返回结构就是 API 的响应体。"""
    base = root(project_id)
    target = resolve(rel, project_id)
    if not target.is_dir():
        raise PathNotFound(rel)

    limit = int(settings.CONSOLE_TREE_LIMIT)
    try:
        with os.scandir(target) as scanner:
            entries = list(scanner)
    except PermissionError as exc:
        raise PathNotFound(rel) from exc
    items: list[dict] = []
    for entry in entries:
        stat = _safe_stat(entry)
        if stat is None:
            continue

        is_link = entry.is_symlink()
        try:
            # 软链要看目标的真实类型，普通项跟不跟随都一样
            is_dir = entry.is_dir(follow_symlinks=is_link)
        except OSError:
            is_dir = False

        # 注意：blocked 判定看的是软链指向哪里，路径本身仍在根内
        try:
            # 必须显式传 base —— 默认的 to_rel() 以总目录为基准，进了项目之后
            # 会多出一层项目名，前端拿这个路径再请求就 404 了
            rel_path: str | None = to_rel(Path(entry.path), base)
        except ValueError:
            rel_path = None
        blocked = is_link and not Path(entry.path).resolve().is_relative_to(base)

        items.append(
            {
                "name": entry.name,
                "path": rel_path,
                "type": "dir" if is_dir else "file",
                "size": None if is_dir else stat.st_size,
                "mtime": stat.st_mtime,
                "hidden": entry.name.startswith("."),
                "link": is_link,
                "blocked": blocked,
            }
        )

    # 目录在前，同类按名字排，隐藏文件靠后
    items.sort(key=lambda i: (i["hidden"], i["type"] != "dir", i["name"].lower()))

    truncated = len(items) > limit
    return {
        "root": str(base),
        "path": to_rel(target, base),
        "entries": items[:limit],
        "total": len(items),
        "truncated": truncated,
    }
