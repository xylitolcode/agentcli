#!/usr/bin/env python3
"""agentcli 的 MCP 转接器：把 ``delegate_task`` 调回控制面。

由 ``console/bridge.py`` 在拉起交互式 agent 时注入，走 stdio（每行一条
JSON-RPC）。本脚本不碰会话注册表——它只是另一个进程，所有编排动作都
POST 到 ``/api/delegate/``，由控制面在进程内完成建槽、忙锁、台账与回执。
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

PROTOCOL = "2024-11-05"

TOOL = {
    "name": "delegate_task",
    "description": (
        "把子任务外包给本机的另一个 agent（claude / codex / qwen / stub）。"
        "会阻塞到对方跑完并返回回执。只在用户明确要求分工、或你判断另一个 "
        "agent 更适合时使用；普通读写/搜索不要用。外包开关关闭时调用会失败。"
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "target": {
                "type": "string",
                "description": "目标 agent profile：claude / codex / qwen / stub",
            },
            "prompt": {
                "type": "string",
                "description": "完整、自包含的任务描述；对方看不到你的上下文",
            },
            "timeout_seconds": {
                "type": "integer",
                "description": "等待回执的最长秒数，默认 120",
            },
        },
        "required": ["target", "prompt"],
    },
}


def _send(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _reply(mid, result=None, error=None) -> None:
    msg = {"jsonrpc": "2.0", "id": mid}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    _send(msg)


def _delegate(args: dict) -> dict:
    url = os.environ.get("AGENTCLI_URL", "").rstrip("/") + "/api/delegate/"
    token = os.environ.get("AGENTCLI_TOKEN", "")
    sid = PARENT_SID

    body = json.dumps({
        "sid": sid,
        "target": args.get("target") or "",
        "prompt": args.get("prompt") or "",
        "timeout": int(args.get("timeout_seconds") or 120),
    }).encode()

    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json", "X-Agentcli-Token": token},
    )
    try:
        with urllib.request.urlopen(req, timeout=float(args.get("timeout_seconds") or 120) + 15) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        try:
            data = json.loads(exc.read().decode())
        except Exception:
            data = {"ok": False, "error": f"控制面返回 HTTP {exc.code}"}
    except Exception as exc:
        return {"content": [{"type": "text", "text": f"调用控制面失败：{exc}"}], "isError": True}

    if not data.get("ok"):
        text = f"外包失败：{data.get('error') or '未知原因'}"
        return {"content": [{"type": "text", "text": text}], "isError": True}

    reply = data.get("reply") or ""
    meta = f"[{data.get('profile') or 'agent'} · {data.get('child_sid') or ''} · {data.get('delegation_id') or ''}]"
    text = f"外包完成 {meta}\n{reply}" if reply else f"外包完成，但对方没有返回文本 {meta}"
    return {"content": [{"type": "text", "text": text}], "isError": False}


def _handle(msg: dict) -> None:
    method = msg.get("method")
    mid = msg.get("id")
    if mid is None:  # 通知帧，不需要回应
        return

    if method == "initialize":
        _reply(mid, {
            "protocolVersion": PROTOCOL,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "agentcli", "version": "1.0"},
        })
    elif method == "tools/list":
        _reply(mid, {"tools": [TOOL]})
    elif method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        if name != "delegate_task":
            _reply(mid, {"content": [{"type": "text", "text": f"未知工具：{name}"}], "isError": True})
            return
        _reply(mid, _delegate(params.get("arguments") or {}))
    elif method == "ping":
        _reply(mid, {})
    else:
        _reply(mid, error={"code": -32601, "message": f"method not found: {method}"})


PARENT_SID = ""


def main() -> None:
    global PARENT_SID
    argv = sys.argv[1:]
    if "--parent-sid" in argv:
        PARENT_SID = argv[argv.index("--parent-sid") + 1]
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(msg, dict):
            _handle(msg)


if __name__ == "__main__":
    main()
