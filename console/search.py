"""工作区搜索：内容检索（rg）+ 文件名检索（rg --files / fd）。

为什么用 ripgrep 而不是 Python 遍历：
  1. 它自带 .gitignore 语义，node_modules / .venv / dist 默认不进结果，
     省得我们自己维护一份排除表（而且那份表一定会和项目实际情况跑偏）；
  2. 单线程 Python 扫若干万文件，页面会安静地卡上好几秒，
     用户会以为搜索坏了 —— 这是最差的一种故障模式。

命令一律写死、参数走 `-e` / `--` 分隔，不接受前端拼 shell 片段；
路径统一经 `files.root()` 收窄到项目根。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from typing import Any

from . import files

MODES = ("content", "file")

# 单次搜索的上限：超过就截断并如实告知，别让前端等一个永远画不完的列表
MAX_MATCHES = 300
MAX_FILES = 300
MAX_LINE_CHARS = 400
MAX_QUERY_CHARS = 200
TIMEOUT = 12

# rg 不存在时的兜底排除项（正常路径下由 rg 自己读 .gitignore）
SKIP_DIRS = {
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    "dist",
    "build",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".next",
    "target",
}

_RG = shutil.which("rg")
_FD = shutil.which("fd")


class SearchError(RuntimeError):
    """搜索本身失败（不是"没结果"）。"""


def _env() -> dict[str, str]:
    env = dict(os.environ)
    env["LC_ALL"] = "C"
    env["GIT_OPTIONAL_LOCKS"] = "0"
    return env


def _run(args: list[str], cwd: str) -> subprocess.CompletedProcess[str]:
    """跑子进程。rg 的语义：0=有结果，1=没结果，2=出错。"""
    try:
        proc = subprocess.run(
            args,
            cwd=cwd,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=TIMEOUT,
            env=_env(),
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise SearchError(f"搜索超时（>{TIMEOUT}s），把关键词收窄一点再试") from exc
    except OSError as exc:
        raise SearchError(f"搜索进程起不来：{exc}") from exc
    if proc.returncode == 2:
        detail = (proc.stderr or "").strip().splitlines()
        raise SearchError(detail[0] if detail else "ripgrep 报错")
    return proc


def _rel(path: str, base: str) -> str:
    """把 rg / fd 的输出统一成「相对 base」的斜杠路径。

    rg 和 fd 都是以 base 为 cwd 跑的，吐出来的已经是相对路径（rg 还会带 "./"）。
    直接把它们丢给 os.path.relpath 是错的 —— relpath 会先按**进程 cwd** 解析成绝对
    路径，于是 cwd 和 base 不一致时（比如搜全仓、base 是 ~/projects）就会拼出
    "agentcli/agentcli/..." 这种双前缀。这里显式按 base 折叠。
    """
    if not os.path.isabs(path):
        path = os.path.join(base, path)
    try:
        rel = os.path.relpath(path, base)
    except ValueError:
        return path.replace(os.sep, "/")
    rel = rel.replace(os.sep, "/")
    while rel.startswith("./"):
        rel = rel[2:]
    return rel


def _clip(text: str) -> str:
    text = text.rstrip("\n\r")
    return text if len(text) <= MAX_LINE_CHARS else text[:MAX_LINE_CHARS] + "…"


def _content(query: str, base: str) -> dict[str, Any]:
    """内容检索，解析 `rg --json` 的流式事件。"""
    args = [
        _RG,
        "--json",
        "--smart-case",
        "--max-count",
        "50",  # 单个文件最多 50 处，避免一个压缩产物刷屏
        "--max-filesize",
        "2M",
        "-e",
        query,
        ".",
    ]
    proc = _run(args, base)

    matches: list[dict[str, Any]] = []
    truncated = False
    for raw in proc.stdout.splitlines():
        if not raw.strip():
            continue
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if event.get("type") != "match":
            continue
        data = event.get("data") or {}
        path = ((data.get("path") or {}).get("text") or "").strip()
        if not path:
            continue
        submatches = data.get("submatches") or []
        line_text = ((data.get("lines") or {}).get("text") or "")
        matches.append(
            {
                "path": _rel(path, base),
                "line": int(data.get("line_number") or 0),
                "col": int((submatches[0] or {}).get("start") or 0) + 1 if submatches else 1,
                "text": _clip(line_text),
                "spans": [
                    [int(sm.get("start") or 0), int(sm.get("end") or 0)] for sm in submatches
                ],
            }
        )
        if len(matches) >= MAX_MATCHES:
            truncated = True
            break

    # 按文件汇总，前端好渲染成「文件 → 命中行」两层
    grouped: dict[str, list[dict[str, Any]]] = {}
    for item in matches:
        grouped.setdefault(item["path"], []).append(item)

    return {
        "groups": [
            {"path": path, "hits": hits, "count": len(hits)} for path, hits in grouped.items()
        ],
        "total": len(matches),
        "files": len(grouped),
        "truncated": truncated,
    }


def _file_search(query: str, base: str) -> dict[str, Any]:
    """文件名检索。fd 在就用 fd（它是专门干这个的），否则退回 rg --files 过滤。"""
    pattern = query or ""
    if _FD:
        args = [
            _FD,
            "--type",
            "f",
            "--hidden",
            "--exclude",
            ".git",
            "--exclude",
            "node_modules",
            "--exclude",
            ".venv",
            "--max-results",
            str(MAX_FILES + 1),
        ]
        if pattern:
            args += ["--ignore-case", pattern]
        proc = _run(args, base)
        paths = [line for line in proc.stdout.splitlines() if line.strip()]
    else:
        proc = _run([_RG, "--files", "--hidden", "-g", "!.git", "-g", "!node_modules"], base)
        paths = []
        lowered = pattern.lower()
        for line in proc.stdout.splitlines():
            if lowered and lowered not in line.lower():
                continue
            paths.append(line)

    truncated = len(paths) > MAX_FILES
    paths = paths[:MAX_FILES]
    return {
        "files": [{"path": _rel(p, base), "name": os.path.basename(p)} for p in paths],
        "total": len(paths),
        "truncated": truncated,
    }


def search(
    query: str,
    project_id: str | int | None = None,
    mode: str = "content",
) -> dict[str, Any]:
    """在项目内搜索。空 query 直接返回空结果 —— 前端不必为此特判。"""
    if mode not in MODES:
        raise ValueError(f"mode 只接受 {'/'.join(MODES)}")
    if len(query) > MAX_QUERY_CHARS:
        raise ValueError(f"关键词超过 {MAX_QUERY_CHARS} 字，收窄一点")

    base = str(files.root(project_id))
    empty = {
        "query": query,
        "mode": mode,
        "root": base,
        "total": 0,
        "truncated": False,
    }
    if not query.strip() and mode == "content":
        return {**empty, "groups": [], "files": 0}
    if not _RG and mode == "content":
        raise SearchError("系统里没有 ripgrep，先装一个：sudo apt install ripgrep")

    if mode == "content":
        return {"query": query, "mode": mode, "root": base, **_content(query, base)}
    return {"query": query, "mode": mode, "root": base, **_file_search(query, base)}
