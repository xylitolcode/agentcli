"""Git diff 只读 —— 单个文件的差异，结构化成 hunk 给前端做「上一处/下一处」导航。

与 :mod:`console.gitview` 同一条边界：命令写死、不接受前端传 shell 参数，
路径统一交给 ``files.resolve`` 收窄到项目根。控制台只展示事实，不 add/commit/checkout。
"""

from __future__ import annotations

import os
import re
import subprocess

from django.conf import settings

from . import files, gitview

HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$")

# 单次最多解析多少行，防「整个文件被重排」这种极端 diff 把浏览器拖垮
DIFF_LINE_LIMIT = int(getattr(settings, "CONSOLE_DIFF_LINE_LIMIT", 4000))

MODES = ("worktree", "staged", "unstaged")


def _run(root, *args, timeout: int = 10) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["GIT_OPTIONAL_LOCKS"] = "0"
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["LC_ALL"] = "C"
    return subprocess.run(
        ["git", "-C", str(root), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        env=env,
    )


def _parse(text: str, limit: int = DIFF_LINE_LIMIT) -> dict:
    """把 unified diff 文本解析成 hunks。

    只认 ``@@``/``-``/``+``/``空格`` 四种行，文件头（diff --git、index、---、+++）
    全部丢掉 —— 前端拿路径自己就有，不需要再从头部反解。
    """
    hunks: list[dict] = []
    binary = False
    truncated = False
    current: dict | None = None
    old_no = new_no = 0
    count = 0

    for line in text.splitlines():
        match = HUNK_RE.match(line)
        if match:
            current = {
                "oldStart": int(match.group(1)),
                "oldLines": int(match.group(2) or 1),
                "newStart": int(match.group(3)),
                "newLines": int(match.group(4) or 1),
                "header": match.group(5).strip(),
                "lines": [],
            }
            hunks.append(current)
            old_no, new_no = current["oldStart"], current["newStart"]
            continue

        if current is None:
            if line.startswith(("Binary files", "GIT binary patch")):
                binary = True
            continue

        if line.startswith("\\"):
            # "\ No newline at end of file" 不是内容行
            continue

        if count >= limit:
            truncated = True
            break

        if not line:
            # git 总给上下文行加一个前导空格；真出现裸空行就按上下文兜底
            kind, body = " ", ""
        else:
            kind, body = line[0], line[1:]
            if kind not in (" ", "-", "+"):
                kind, body = " ", line

        entry = {"t": kind, "text": body}
        if kind == "-":
            entry["old"] = old_no
            old_no += 1
        elif kind == "+":
            entry["new"] = new_no
            new_no += 1
        else:
            entry["old"] = old_no
            entry["new"] = new_no
            old_no += 1
            new_no += 1

        current["lines"].append(entry)
        count += 1

    added = sum(1 for hunk in hunks for item in hunk["lines"] if item["t"] == "+")
    removed = sum(1 for hunk in hunks for item in hunk["lines"] if item["t"] == "-")
    return {
        "hunks": hunks,
        "binary": binary,
        "truncated": truncated,
        "stats": {"add": added, "del": removed},
    }


def _status_code(root, rel: str) -> str:
    """当前文件的两字符 porcelain 状态码；不在工作区改动里时返回空串。"""
    result = _run(root, "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", rel)
    if result.returncode != 0:
        return ""
    for token in result.stdout.split("\x00"):
        if len(token) >= 3 and token[3:] == rel:
            return token[:2]
    return ""


def _untracked_diff(root, target, rel: str) -> str:
    """未跟踪文件没有 HEAD 基线，用 --no-index 对着 /dev/null 造一份「全新增」。"""
    result = _run(
        root,
        "diff",
        "--no-index",
        "--no-color",
        "--no-ext-diff",
        "--",
        os.devnull,
        str(target),
    )
    # --no-index 有差异时返回 1，这是正常结果不是错误
    if result.returncode not in (0, 1):
        raise OSError(result.stderr.strip() or "git diff --no-index 失败")
    return result.stdout


def _diff_text(root, rel: str, mode: str, code: str, target) -> str:
    if code == "??":
        return _untracked_diff(root, target, rel)

    if mode == "staged":
        attempts = [["diff", "--cached", "--", rel]]
    elif mode == "unstaged":
        attempts = [["diff", "--", rel]]
    else:
        # worktree = 工作区合并视图：vs HEAD 能一次拿到已暂存 + 未暂存的全部改动；
        # 仓库还没有第一个提交时没有 HEAD，退回暂存区对比
        attempts = [["diff", "HEAD", "--", rel], ["diff", "--cached", "--", rel]]

    for args in attempts:
        result = _run(root, *args, "--no-color", "--no-ext-diff")
        if result.returncode != 0:
            continue
        if result.stdout.strip():
            return result.stdout

    # 已删除、且只在暂存区留了记录时，工作区已经没有文件可比，再试一次暂存区
    if "D" in code and mode == "worktree":
        result = _run(root, "diff", "--cached", "--", rel, "--no-color", "--no-ext-diff")
        if result.returncode == 0:
            return result.stdout
    return ""


def file_diff(path: str, project_id: str | int | None = None, mode: str = "worktree") -> dict:
    """返回单个文件的差异。path 是相对项目根的路径。

    越界由 ``files.resolve`` 抛 ``PathOutsideRoot``，不存在抛 ``PathNotFound``。
    """
    if mode not in MODES:
        mode = "worktree"

    root = files.root(project_id)
    if not root.is_dir():
        raise files.PathNotFound(str(root))

    target = files.resolve(path, project_id)
    rel = files.to_rel(target, root)

    payload = {
        "path": rel,
        "mode": mode,
        "kind": "",
        "repo": False,
        "binary": False,
        "truncated": False,
        "empty": False,
        "hunks": [],
        "stats": {"add": 0, "del": 0},
    }

    probe = _run(root, "rev-parse", "--is-inside-work-tree")
    if probe.returncode != 0 or probe.stdout.strip() != "true":
        payload["empty"] = True
        return payload

    payload["repo"] = True
    # 已删除的文件在工作区不存在，但 git 里还有基线可对比，所以这里不拦

    code = _status_code(root, rel)
    payload["kind"] = gitview._classify(code) if code else ""

    parsed = _parse(_diff_text(root, rel, mode, code, target))
    payload.update(parsed)
    payload["empty"] = not parsed["hunks"] and not parsed["binary"]
    return payload
