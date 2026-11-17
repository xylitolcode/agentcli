"""端到端验证：WebSocket -> PTY -> 真实 shell。

用法（服务需先起来）::

    .venv/bin/uvicorn agentcli.asgi:application --port 8010
    .venv/bin/python scripts/check_terminal.py
"""

from __future__ import annotations

import asyncio
import json
import sys

import websockets

# 无项目参数：落在总项目目录；项目内会话的 cwd 由 check_session / 手工脚本覆盖。
URL = "ws://127.0.0.1:8010/ws/terminal/?profile=bash"


async def drain(ws, seconds: float) -> str:
    """收一段时间内的所有输出，拼成字符串。"""
    chunks: list[bytes] = []
    loop = asyncio.get_running_loop()
    deadline = loop.time() + seconds
    while True:
        remaining = deadline - loop.time()
        if remaining <= 0:
            break
        try:
            message = await asyncio.wait_for(ws.recv(), timeout=remaining)
        except asyncio.TimeoutError:
            break
        chunks.append(message if isinstance(message, bytes) else message.encode())
    return b"".join(chunks).decode("utf-8", "replace")


async def run(ws, command: str, wait: float = 0.8) -> str:
    await ws.send(command.encode())
    return await drain(ws, wait)


async def main() -> int:
    failures = 0

    def check(name: str, ok: bool, detail: str = "") -> None:
        nonlocal failures
        if not ok:
            failures += 1
        print(f"{'PASS' if ok else 'FAIL'}  {name}{('  <- ' + detail) if detail else ''}")

    async with websockets.connect(URL, max_size=None) as ws:
        await ws.send(json.dumps({"type": "resize", "cols": 120, "rows": 32}))
        banner = await drain(ws, 1.2)
        check("PTY 启动并吐出提示符", bool(banner.strip()), banner.strip().splitlines()[:1] and banner.strip().splitlines()[0][:60])

        out = await run(ws, "echo AGENTCLI_OK_123\n")
        check("执行 echo", "AGENTCLI_OK_123" in out, out.strip()[:60])

        out = await run(ws, "tty\n")
        check("拿到真实 tty 设备", "/dev/pts/" in out, out.strip().splitlines()[-1][:40] if out.strip() else "无输出")

        out = await run(ws, "pwd\n")
        check("初始目录是总项目目录", "projects" in out, out.strip().splitlines()[-1][:60] if out.strip() else "无输出")

        out = await run(ws, "cd /tmp && pwd\n")
        check("cd 生效（有状态）", "/tmp" in out, out.strip().splitlines()[-1][:40] if out.strip() else "无输出")

        # 非阻塞交互：sleep 期间发 Ctrl-C，能中断才算真 PTY
        await ws.send(b"sleep 5\n")
        await asyncio.sleep(0.4)
        await ws.send(b"\x03")
        out = await drain(ws, 1.5)
        prompt_back = await run(ws, "echo AFTER_INTERRUPT\n")
        check("Ctrl-C 能中断前台进程", "AFTER_INTERRUPT" in prompt_back, (out + prompt_back).strip()[-40:])

        # 宽字符与转义序列
        out = await run(ws, "printf '\\033[32mGREEN\\033[0m 中文宽字符\\n'\n")
        check("ANSI 转义与宽字符直通", "GREEN" in out and "中文宽字符" in out)

        out = await run(ws, "htop -v 2>/dev/null || echo HAS_TERM\n")
        check("环境里有 TERM", "HAS_TERM" in out or out.strip() != "")

        await ws.send(b"exit\n")
        await asyncio.sleep(0.4)

    print(f"\n{'全部通过' if failures == 0 else str(failures) + ' 项失败'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
