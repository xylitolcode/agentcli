"""人工验收：真实 claude 作为委派子槽（会消耗少量真实额度，只回一句话）。

跑法（前置：cc-switch 15721 在跑、claude CLI 可用）::

    .venv/bin/python scripts/probe_delegation.py

自己起一台 8012 的 uvicorn（CONSOLE_ENABLE_STUB=1），用桩 agent 当父会话，
把一个 Task 派给真实 claude 子槽，看回执是不是真的从 claude 回来。
不烧额度的常规回归走 ``scripts/check_delegation.py``。
"""

import asyncio
import json
import os
import pathlib
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import websockets

ROOT = pathlib.Path("/home/xylitol/projects/agentcli")
PORT = 8012
LOG = "/tmp/agentcli-real-delegate.log"


def start():
    env = dict(os.environ)
    env["CONSOLE_ENABLE_STUB"] = "1"
    proc = subprocess.Popen(
        [str(ROOT / ".venv/bin/uvicorn"), "agentcli.asgi:application",
         "--host", "127.0.0.1", "--port", str(PORT)],
        cwd=str(ROOT), env=env,
        stdout=open(LOG, "wb"), stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    for _ in range(40):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/projects/", timeout=1)
            return proc
        except (urllib.error.URLError, ConnectionError):
            time.sleep(0.3)
    raise RuntimeError("server not up")


async def main():
    prompt = "claude:只回复 OK_CLAUDE_123，不要用任何工具"
    url = (f"ws://127.0.0.1:{PORT}/ws/terminal/?profile=stub&outsourcing=1"
           f"&prompt={urllib.parse.quote(prompt)}")
    async with websockets.connect(url, max_size=None, open_timeout=10) as ws:
        deadline = asyncio.get_running_loop().time() + 90
        while asyncio.get_running_loop().time() < deadline:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=deadline - asyncio.get_running_loop().time())
            except asyncio.TimeoutError:
                break
            if not isinstance(msg, str):
                continue
            payload = json.loads(msg)
            if payload.get("type") == "delegate-result":
                d = payload["delegation"]
                print(json.dumps({
                    "status": d["status"], "profile": d["profile"],
                    "child_sid": d["child_sid"], "reply": d["reply"][:200],
                    "error": d["error"][:200],
                }, ensure_ascii=False, indent=2))
                return 0
            if payload.get("type") == "session-eof":
                print("session-eof", payload)
    print("no delegate-result")
    return 1


server = start()
try:
    code = asyncio.run(main())
finally:
    os.killpg(server.pid, signal.SIGTERM)
    server.wait(timeout=10)
    print(open(LOG, "rb").read().decode("utf-8", "replace")[-1500:])
sys.exit(code)
