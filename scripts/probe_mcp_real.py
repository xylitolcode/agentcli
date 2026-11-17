"""真实 MCP 端到端验收：交互 TUI 里的 agent 自己调 delegate_task。

跟 probe_delegation.py 的区别：那个是 stub 父会话走进程内 dispatch，
本探针起真实交互 TUI，往 PTY 里喂自然语言，显式要求它外包 —— 走的是
完整的 MCP 链路：TUI → mcp_delegate.py (stdio) → /api/delegate/ → 子槽 → 回执。

用法（WSL 内，项目根目录）::

    .venv/bin/python scripts/probe_mcp_real.py            # claude 作父（默认）
    .venv/bin/python scripts/probe_mcp_real.py codex      # codex 作父
    .venv/bin/python scripts/probe_mcp_real.py qwen       # qwen 作父

会消耗少量真实额度（父会话一轮短任务，外包目标 stub 不烧钱）。
前置：对应 CLI 可用、cc-switch 反代在跑、目标目录已信任（project=1 指向 agentcli）。
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
PORT = 8014
LOG = "/tmp/agentcli-mcp-real.log"
# 父会话 profile 从命令行取：python probe_mcp_real.py [claude|codex|qwen]
PARENT = sys.argv[1] if len(sys.argv) > 1 else "claude"

# 显式要求走外包；目标 stub 不烧额度，回执里带这个哨兵方便确认链路真的通了。
PROMPT = (
    "这是一个 MCP 外包验收测试。请务必调用 MCP 工具 agentcli.delegate_task，"
    "参数 target=\"stub\"，prompt=\"只回复一句话 REAL_MCP_DELEGATE_OK_7788，不要调用任何工具\"，"
    "timeout_seconds=60。你必须真的调用这个工具，不要自己直接回答。"
    "工具返回后，把回执内容原样复述给我。"
)


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
    # 真实交互 TUI，带初始 prompt；外包开关强制开
    url = (f"ws://127.0.0.1:{PORT}/ws/terminal/?profile={PARENT}&mode=interactive"
           f"&project=1&outsourcing=1&prompt={urllib.parse.quote(PROMPT)}")
    async with websockets.connect(url, max_size=None, open_timeout=15) as ws:
        # TUI 必须要有合理的窗口尺寸，否则 claude 打印 "screen size is bogus"
        # 并不渲染输入框。前端 xterm 也是连上就发 resize。
        await ws.send(json.dumps({"type": "resize", "cols": 120, "rows": 40}))
        loop = asyncio.get_running_loop()
        opened_at = loop.time()
        result = {"delegate-result": False, "reply": "", "session": ""}
        deadline = loop.time() + 180
        sent = False
        while loop.time() < deadline:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - loop.time()))
            except asyncio.TimeoutError:
                break
            if isinstance(msg, bytes):
                # TUI 的 ANSI 画面。提示词由 argv 预填进输入框，需补一个 Enter 发送。
                # 用「首屏输出后延迟 3 秒」兜底，不依赖在字节流里匹配被折行的文本。
                if not sent and loop.time() - opened_at > 6.0:
                    await ws.send(b"\r")
                    sent = True
                continue
            payload = json.loads(msg)
            mtype = payload.get("type")
            if mtype == "session":
                result["session"] = payload.get("sid", "")
            elif mtype == "delegate-result":
                d = payload["delegation"]
                result["delegate-result"] = True
                result["reply"] = d.get("reply", "")[:300]
                result["profile"] = d.get("profile", "")
                result["status"] = d.get("status", "")
                result["error"] = d.get("error", "")[:200]
                print(json.dumps(result, ensure_ascii=False, indent=2))
                return 0
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print("no delegate-result（检查 TUI 是否弹出信任框、或没加载 agentcli MCP server）")
    return 1


server = start()
try:
    code = asyncio.run(main())
finally:
    os.killpg(server.pid, signal.SIGTERM)
    server.wait(timeout=10)
    print("=== server log tail ===")
    print(open(LOG, "rb").read().decode("utf-8", "replace")[-2000:])
sys.exit(code)
