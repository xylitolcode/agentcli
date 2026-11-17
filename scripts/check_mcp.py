#!/usr/bin/env python3
"""MCP 转接器的桩测：不起真实 agent，只验证 stdio JSON-RPC 与控制面语义。

覆盖：initialize / tools/list / 正常外包 / 参数缺失 / 控制面 403 / 超时夹取 /
未知方法与坏参数不会带崩进程。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "scripts" / "mcp_delegate.py"

REQUESTS: list[dict] = []


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        req = json.loads(self.rfile.read(length) or b"{}")
        REQUESTS.append(req)
        if req.get("prompt") == "deny":
            body = {"ok": False, "error": "外包模式未开启：请用户在控制台打开后再调用"}
            status = 403
        else:
            body = {
                "ok": True, "reply": "leaf-ok", "profile": "stub",
                "child_sid": "child123", "delegation_id": "task123",
            }
            status = 200
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def main() -> int:
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{httpd.server_port}"

    reqs = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
            "name": "delegate_task",
            "arguments": {"target": "stub", "prompt": "ok", "timeout_seconds": 9999},
        }},
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {
            "name": "delegate_task", "arguments": {"target": "stub", "prompt": ""},
        }},
        {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {
            "name": "delegate_task", "arguments": {"target": "stub", "prompt": "deny"},
        }},
        {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {
            "name": "nope", "arguments": {},
        }},
        {"jsonrpc": "2.0", "id": 7, "method": "no/such", "params": {}},
        {"jsonrpc": "2.0", "id": 8, "params": {}},
        {"jsonrpc": "2.0", "id": 9, "method": "ping"},
    ]
    env = os.environ.copy()
    env.update({"AGENTCLI_URL": url, "AGENTCLI_TOKEN": "test-token"})
    proc = subprocess.run(
        [sys.executable, str(SERVER), "--parent-sid", "parent123"],
        input="".join(json.dumps(r, ensure_ascii=False) + "\n" for r in reqs),
        text=True, capture_output=True, timeout=30, env=env, cwd=str(ROOT),
    )
    if proc.returncode != 0:
        print("FAIL 进程退出", proc.returncode, proc.stderr)
        return 1

    rows = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    by_id = {r.get("id"): r for r in rows}
    if len(rows) != 9:
        print(f"FAIL 响应数 {len(rows)} != 9\n{proc.stdout}")
        return 1

    init = by_id[1]["result"]
    assert init["protocolVersion"] == "2024-11-05", init
    assert init["capabilities"]["tools"] == {}, init
    assert by_id[2]["result"]["tools"][0]["name"] == "delegate_task"

    ok = by_id[3]["result"]
    assert ok["isError"] is False and "leaf-ok" in ok["content"][0]["text"], ok
    assert REQUESTS[0]["timeout"] == 300, REQUESTS[0]
    assert REQUESTS[0]["sid"] == "parent123" and REQUESTS[0]["target"] == "stub"

    empty = by_id[4]["result"]
    assert empty["isError"] is True and "不能为空" in empty["content"][0]["text"], empty
    assert len(REQUESTS) == 2, REQUESTS

    denied = by_id[5]["result"]
    assert denied["isError"] is True and "外包模式未开启" in denied["content"][0]["text"], denied

    unknown = by_id[6]["result"]
    assert unknown["isError"] is True and "未知工具" in unknown["content"][0]["text"], unknown

    bad_method = by_id[7]["error"]
    assert bad_method["code"] == -32601, bad_method
    bad_req = by_id[8]["error"]
    assert bad_req["code"] == -32600, bad_req
    assert by_id[9]["result"] == {}

    print("PASS  initialize / tools/list")
    print("PASS  正常外包回执与 timeout 夹取（300s）")
    print("PASS  空 prompt 前置拒绝，未打控制面")
    print("PASS  控制台 403 转 isError 文本")
    print("PASS  未知工具 / 未知方法 / 缺 method 的分类错误")
    print("PASS  ping 与 stdio 循环存活")
    httpd.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
