"""Git 只读快照 —— 控制台只展示事实，不代做 add/commit/reset/checkout。

命令全部写死，不接受前端传参；工作目录收窄到项目根，与目录树共用边界。
"""

from __future__ import annotations

import os
import subprocess

from . import files


def _run(root, *args, timeout: int = 8) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    # 只读操作不拿可选锁；禁止任何交互式凭据提示
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


def _clean(value: str) -> str:
    return value.replace("\x00", "").strip()


def _classify(code: str) -> str:
    if code == "??":
        return "untracked"
    if "U" in code:
        return "conflicted"
    if "R" in code:
        return "renamed"
    if "D" in code:
        return "deleted"
    if "A" in code:
        return "added"
    return "modified"


def _parse_status(output: str, limit: int = 300) -> tuple[list[dict], bool]:
    tokens = [token for token in output.split("\x00") if token]
    entries: list[dict] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        index += 1
        if len(token) < 3:
            continue
        code = token[:2]
        path = token[3:]
        entry = {
            "path": path,
            "code": code,
            "kind": _classify(code),
            "staged": code[0] not in (" ", "?"),
            "unstaged": code[1] not in (" ", "?"),
        }
        # -z 下重命名/复制记录后面紧跟一条“原路径”，没有 XY 前缀
        if code[0] in ("R", "C") and index < len(tokens):
            entry["from"] = tokens[index]
            index += 1
        entries.append(entry)

    truncated = len(entries) > limit
    return entries[:limit], truncated


def snapshot(project_id: str | int | None = None) -> dict:
    root = files.root(project_id)
    if not root.is_dir():
        raise files.PathNotFound(str(root))

    probe = _run(root, "rev-parse", "--is-inside-work-tree")
    if probe.returncode != 0 or probe.stdout.strip() != "true":
        return {"repo": False, "root": str(root), "files": [], "commits": []}

    branch = _run(root, "rev-parse", "--abbrev-ref", "HEAD")
    head = _run(root, "rev-parse", "--short", "HEAD")
    branch_name = _clean(branch.stdout) or "HEAD"
    head_hash = _clean(head.stdout)

    upstream = _run(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    upstream_name = _clean(upstream.stdout) if upstream.returncode == 0 else ""
    ahead = behind = 0
    if upstream_name:
        counts = _run(root, "rev-list", "--left-right", "--count", "HEAD...@{u}")
        if counts.returncode == 0:
            parts = counts.stdout.split()
            if len(parts) == 2 and all(part.isdigit() for part in parts):
                ahead, behind = int(parts[0]), int(parts[1])

    status = _run(root, "status", "--porcelain=v1", "-z", "--untracked-files=normal")
    statuses, truncated = _parse_status(status.stdout) if status.returncode == 0 else ([], False)

    log = _run(root, "log", "--format=%h%x1f%an%x1f%ar%x1f%s", "-n", "15")
    commits: list[dict] = []
    if log.returncode == 0:
        for line in log.stdout.splitlines():
            parts = line.split("\x1f")
            if len(parts) == 4:
                commits.append(
                    {"hash": parts[0], "author": parts[1], "when": parts[2], "subject": parts[3]}
                )

    return {
        "repo": True,
        "root": str(root),
        "branch": branch_name,
        "head": head_hash,
        "detached": branch_name == "HEAD",
        "upstream": upstream_name,
        "ahead": ahead,
        "behind": behind,
        "files": statuses,
        "truncated": truncated,
        "commits": commits,
    }
