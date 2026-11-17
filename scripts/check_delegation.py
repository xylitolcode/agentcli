"""委派链路回归：会话槽常驻、a→b→c、忙锁、槽复用、逐级回灌。

不烧真实额度 —— 全程用 ``scripts/stub_agent.py`` 测试桩（`CONSOLE_ENABLE_STUB=1`
才会登记 stub profile）。脚本自己起一台 uvicorn（端口 8011），跑完收尸，
不碰正在跑的 8010 那台。

用法::

    .venv/bin/python scripts/check_delegation.py

覆盖：
  1. 带初始任务起 agent 会话（URL query prompt），首帧回 sid；
  2. 单次委派：子槽在注册表里有独立 sid，role=child，parent 指向父会话；
  3. 链式委派 a→b→c：子槽自己抛的 delegate 事件被再接住，链路身份
     （delegation id / child_id）闭环，回执逐级合并；
  4. 槽复用：同一父会话、同一目标名的两个任务用同一个 child_sid；
  5. 忙锁：子槽在跑慢任务时，第二个委派被拒，台账记为 failed；
  6. 任务入口忙锁：busy_kind=delegate 时用户输入被拒，中断键放行。
"""

from __future__ import annotations

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

ROOT = pathlib.Path(__file__).resolve().parent.parent
# 脚本直接从仓库根跑起来时，sys.path[0] 是 scripts/，import agentcli 会找不到
sys.path.insert(0, str(ROOT))
PORT = 8011
BASE = f"ws://127.0.0.1:{PORT}/ws/terminal/?profile=stub&outsourcing=1"
LOG = "/tmp/agentcli-delegation-uvicorn.log"


def _start_server() -> subprocess.Popen:
    env = dict(os.environ)
    env["CONSOLE_ENABLE_STUB"] = "1"
    env["PYTHONUNBUFFERED"] = "1"
    log = open(LOG, "wb")
    proc = subprocess.Popen(
        [str(ROOT / ".venv" / "bin" / "uvicorn"), "agentcli.asgi:application",
         "--host", "127.0.0.1", "--port", str(PORT)],
        cwd=str(ROOT), env=env, stdout=log, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    deadline = time.time() + 20
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"uvicorn 启动失败，见 {LOG}")
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/projects/", timeout=1)
            return proc
        except (urllib.error.URLError, ConnectionError):
            time.sleep(0.3)
    raise RuntimeError(f"uvicorn 20s 内没起来，见 {LOG}")


def _stop_server(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def _api(path: str) -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}", timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))


async def _wait_frames(ws, seconds: float, until=None) -> list[dict]:
    """收文本帧（控制消息），直到 until(frames) 命中或超时；二进制终端流丢弃。"""
    frames: list[dict] = []
    loop = asyncio.get_running_loop()
    deadline = loop.time() + seconds
    while True:
        if until and until(frames):
            break
        remaining = deadline - loop.time()
        if remaining <= 0:
            break
        try:
            message = await asyncio.wait_for(ws.recv(), timeout=remaining)
        except asyncio.TimeoutError:
            break
        if not isinstance(message, str):
            continue
        try:
            payload = json.loads(message)
        except json.JSONDecodeError:
            continue
        frames.append(payload)
    return frames


def _results(frames: list[dict]) -> list[dict]:
    return [f for f in frames if f.get("type") == "delegate-result"]


async def _open_task(prompt: str) -> tuple[object, str, list[dict]]:
    """起一个带初始任务的 stub 会话，返回 (ws, sid, 首段控制帧)。"""
    url = BASE + "&prompt=" + urllib.parse.quote(prompt)
    ws = await websockets.connect(url, max_size=None, open_timeout=10)
    frames = await _wait_frames(ws, 5, until=lambda fs: any(f.get("type") == "session" for f in fs))
    sid = next((f["sid"] for f in frames if f.get("type") == "session"), "")
    return ws, sid, frames


def _delegations(parent: str) -> list[dict]:
    return _api(f"/api/delegations/?parent={parent}")["delegations"]


def _sessions() -> list[dict]:
    return _api("/api/sessions/")["sessions"]


def _children_of(sessions: list[dict], sid: str) -> list[dict]:
    return [s for s in sessions if s.get("parent") == sid]


async def unit_busy_gate() -> str:
    """任务入口忙锁的纯逻辑检查（不进服务、不开进程）。"""
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "agentcli.settings")
    import django

    django.setup()

    from console import sessions, terminal

    rt = sessions.Runtime(loop=asyncio.get_running_loop(), kind="agent",
                          busy=True, busy_kind="delegate")

    class FakeSession:
        pass

    s = FakeSession()
    s.runtime = rt
    outbox: asyncio.Queue = asyncio.Queue()

    assert terminal._accept_user_input(s, b"new task", outbox) is False, "忙时应拒绝用户任务"
    assert not outbox.empty(), "拒绝时应回一帧 input-rejected"
    assert terminal._accept_user_input(s, b"\x03", outbox) is True, "中断键应放行"

    rt2 = sessions.Runtime(loop=asyncio.get_running_loop(), kind="agent")
    s2 = FakeSession()
    s2.runtime = rt2
    assert terminal._accept_user_input(s2, b"task", asyncio.Queue()) is True
    assert rt2.busy and rt2.busy_kind == "user", "用户任务应认领串行锁"
    return "忙锁逻辑正确"


async def main() -> int:
    failures = 0

    def check(name: str, ok: bool, detail: str = "") -> None:
        nonlocal failures
        if not ok:
            failures += 1
        print(f"{'PASS' if ok else 'FAIL'}  {name}{('  <- ' + detail) if detail else ''}")

    # 0) 任务入口忙锁（纯逻辑）
    try:
        check("任务入口忙锁", True, await unit_busy_gate())
    except AssertionError as exc:
        check("任务入口忙锁", False, str(exc))

    # 1) 链式：a(父) → b(子槽) → c(孙槽)
    ws, sid, first = await _open_task("chain:1:deep")
    check("带初始任务起会话，首帧回 sid", bool(sid), sid)
    chain_frames = await _wait_frames(ws, 20, until=lambda fs: bool(_results(fs)))
    results = _results(chain_frames)
    check("父会话收到链式回执", bool(results), str(results[-1])[:120] if results else "无 delegate-result")
    reply = (results[-1]["delegation"].get("reply") if results else "") or ""
    check("回执里合并了下级结果", "chain-root:deep" in reply and "leaf-ok:deep" in reply, reply[:120])

    sessions_snapshot = _sessions()
    kids = _children_of(sessions_snapshot, sid)
    check("父会话名下有一张子槽", len(kids) == 1, str([(k["sid"], k["depth"]) for k in kids]))
    if kids:
        b = kids[0]
        check("子槽身份正确（child / parent / pinned）",
              b["role"] == "child" and b["parent"] == sid and b["pinned"],
              f"{b['role']} parent={b['parent']} pinned={b['pinned']}")
        grand = _children_of(sessions_snapshot, b["sid"])
        check("子槽自己又派生了一张孙槽", len(grand) == 1,
              str([(g["sid"], g["depth"]) for g in grand]))
        if grand:
            c = grand[0]
            check("孙槽层级 depth=2", c["depth"] == 2, str(c["depth"]))

        parent_tasks = _delegations(sid)
        check("父会话台账有一条委派", len(parent_tasks) == 1, json.dumps(parent_tasks)[:120])
        if parent_tasks:
            t = parent_tasks[0]
            check("委派任务挂在子槽 sid 上", t["child_sid"] == b["sid"], t["child_sid"])
            check("父任务登记了下一级 child_id", bool(t["child_id"]), t["child_id"])
        child_tasks = _delegations(b["sid"])
        check("子槽台账里有孙级任务", len(child_tasks) == 1, json.dumps(child_tasks)[:120])
        if child_tasks:
            check("孙级任务 done 且有回执",
                  child_tasks[0]["status"] == "done" and "leaf-ok:deep" in child_tasks[0]["reply"],
                  child_tasks[0]["reply"][:80])
    await ws.close()

    # 2) 槽复用：同一父会话内两个先后任务应落在同一个 child_sid
    ws, sid2, _ = await _open_task("seq:reuse")
    seq_frames = await _wait_frames(ws, 25, until=lambda fs: len(_results(fs)) >= 2)
    seq_tasks = _delegations(sid2)
    check("两个先后委派都收口", len(seq_tasks) == 2 and all(t["status"] == "done" for t in seq_tasks),
          json.dumps([(t["status"], t["child_sid"]) for t in seq_tasks]))
    if len(seq_tasks) == 2:
        check("复用同一张子槽（child_sid 不变）",
              seq_tasks[0]["child_sid"] == seq_tasks[1]["child_sid"],
              f"{seq_tasks[0]['child_sid']} vs {seq_tasks[1]['child_sid']}")
    seq_kids = _children_of(_sessions(), sid2)
    check("父会话名下仍只有一张子槽", len(seq_kids) == 1, str(len(seq_kids)))
    await ws.close()

    # 3) 忙锁：慢任务没跑完时第二个委派被拒
    ws, sid3, _ = await _open_task("busy:lock")
    busy_frames = await _wait_frames(ws, 12, until=lambda fs: len(_results(fs)) >= 2)
    busy_tasks = _delegations(sid3)
    failed = [t for t in busy_tasks if t["status"] == "failed"]
    check("第二个委派被忙锁拒绝", bool(failed),
          json.dumps([(t["status"], t["error"]) for t in busy_tasks])[:140])
    if failed:
        check("拒绝原因写明目标忙", "忙" in failed[0]["error"], failed[0]["error"])
        check("被拒任务仍指向同一张槽",
              failed[0]["child_sid"] == (busy_tasks[0]["child_sid"] if busy_tasks else ""),
              failed[0]["child_sid"])
    await ws.close()

    print(f"\n{'全部通过' if failures == 0 else str(failures) + ' 项失败'}")
    return 1 if failures else 0


if __name__ == "__main__":
    server = _start_server()
    try:
        code = asyncio.run(main())
    finally:
        _stop_server(server)
    sys.exit(code)
