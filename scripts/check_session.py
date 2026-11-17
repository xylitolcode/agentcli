"""会话保持端到端验证：断开后凭 sid 重连，接回同一个 PTY 进程。

用法（服务需先起来）::

    .venv/bin/uvicorn agentcli.asgi:application --port 8010
    .venv/bin/python scripts/check_session.py

覆盖：
  1. 首连拿到服务端下发的 session sid；
  2. 在 shell 里建标记目录/文件，留下会话状态；
  3. 主动断开 WebSocket（模拟浏览器刷新/断网），服务端不杀进程；
  4. 带同一个 sid 重连，重放缓冲里仍能看到之前的输出；
  5. 旧的目录状态还在（cd 过的目录、留下的文件都还在），证明是同一个进程；
  6. 带失效 sid 连接时，服务端回 session-missing，不报错崩连接。
"""

from __future__ import annotations

import asyncio
import json
import sys

import websockets

BASE = "ws://127.0.0.1:8010/ws/terminal/?profile=bash"
MARK_DIR = "/tmp/agentcli_session_marker"


async def drain(ws, seconds: float) -> str:
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
        if isinstance(message, bytes):
            chunks.append(message)
        else:
            # 文本帧是控制消息（session / session-missing），不进终端文本
            continue
    return b"".join(chunks).decode("utf-8", "replace")


async def read_session_id(ws) -> str:
    """从控制帧里取 sid；二进制终端流原样跳过。"""
    deadline = asyncio.get_running_loop().time() + 3
    while asyncio.get_running_loop().time() < deadline:
        try:
            message = await asyncio.wait_for(ws.recv(), timeout=2)
        except asyncio.TimeoutError:
            break
        if isinstance(message, str):
            payload = json.loads(message)
            if payload.get("type") == "session":
                return payload["sid"]
    return ""


async def main() -> int:
    failures = 0

    def check(name: str, ok: bool, detail: str = "") -> None:
        nonlocal failures
        if not ok:
            failures += 1
        print(f"{'PASS' if ok else 'FAIL'}  {name}{('  <- ' + detail) if detail else ''}")

    # 第一轮：建标记、记住 tty（首连直接起会话，sid 从控制帧取）
    async with websockets.connect(BASE, max_size=None) as ws:
        sid = await read_session_id(ws)
        check("首连拿到 session sid", bool(sid), sid)
        await drain(ws, 0.8)
        await ws.send(b"rm -rf " + MARK_DIR.encode() + b"\n")
        await drain(ws, 0.5)
        await ws.send(f"mkdir -p {MARK_DIR} && echo MARK_BEFORE_$((1+1)) && tty\n".encode())
        out1 = await drain(ws, 1.0)
        check("首轮写入标记命令回显", "MARK_BEFORE_2" in out1, out1.strip().splitlines()[-1][:50] if out1.strip() else "无输出")
        tty1 = next((ln.strip() for ln in out1.splitlines() if "/dev/pts/" in ln), "")
        check("首轮拿到真实 tty", bool(tty1), tty1[:30])

    # 模拟硬刷新：断开，等一拍，再带同 sid 接回
    await asyncio.sleep(0.5)
    async with websockets.connect(BASE + "&sid=" + sid, max_size=None, open_timeout=5) as ws:
        sid2 = await read_session_id(ws)
        check("重连仍拿到同一个 sid", sid2 == sid, f"{sid} -> {sid2}")
        replay = await drain(ws, 0.8)
        check("重连回放包含历史标记", "MARK_BEFORE_2" in replay, replay.strip()[-60:])

        # 验证是同一个进程：标记目录还在，再写一条新输出；顺便再取一次 tty
        await ws.send(f"ls {MARK_DIR} && echo AFTER_RECONNECT_777 && tty\n".encode())
        out2 = await drain(ws, 1.0)
        check("重连后标记目录仍在（同进程）", "AFTER_RECONNECT_777" in out2, out2.strip().splitlines()[-1][:50] if out2.strip() else "无输出")
        import re
        m1 = re.search(r"/dev/pts/\d+", tty1)
        m2 = re.search(r"/dev/pts/\d+", out2)
        tty1, tty2 = m1.group(0) if m1 else "", m2.group(0) if m2 else ""
        check("重连后是同一个 tty 设备", bool(tty1) and tty1 == tty2, f"{tty1} vs {tty2}")
        await ws.close()

    # 失效 sid：应收到 session-missing 控制帧，连接不崩
    async with websockets.connect(BASE + "&sid=deadbeefdeadbeef", max_size=None) as ws:
        msg = await asyncio.wait_for(ws.recv(), timeout=3)
        payload = json.loads(msg) if isinstance(msg, str) else {}
        check("失效 sid 回 session-missing", payload.get("type") == "session-missing", str(payload)[:60])

    # 清理标记目录：开一个全新会话跑 rm，不动上面的被测会话
    async with websockets.connect(BASE, max_size=None) as ws:
        await read_session_id(ws)
        await ws.send(b"rm -rf " + MARK_DIR.encode() + b"\n")
        await drain(ws, 0.5)

    print(f"\n{'全部通过' if failures == 0 else str(failures) + ' 项失败'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
