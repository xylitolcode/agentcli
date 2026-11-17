"""claude hook：把会话身份与工具调用旁路上报给控制台。

交互 TUI 下 stdout 是 ANSI 画面，控制台拿不到 JSONL；这个脚本只做一件事：
读 stdin 的 hook JSON，把 ``session_id`` / ``tool_name`` / ``tool_input`` POST 到
``/api/hook/``，让控制台记准 CLI 会话 id 并给目录树标蓝/标黄。失败一律吞掉：
hook 不能拖慢或打断 agent。
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sid", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--url", required=True)
    args = parser.parse_args()

    raw = sys.stdin.read()
    try:
        payload = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return 0

    body = json.dumps({
        "sid": args.sid,
        "hook_event_name": payload.get("hook_event_name", ""),
        "session_id": payload.get("session_id", ""),
        "tool_name": payload.get("tool_name", ""),
        "tool_input": payload.get("tool_input", {}),
        "cwd": payload.get("cwd", ""),
    }).encode()

    url = args.url.rstrip("/") + "/api/hook/"
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Agentcli-Token": args.token,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=2):
            pass
    except (urllib.error.URLError, TimeoutError, OSError):
        # hook 是旁路：控制台不在也不该影响 agent
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
