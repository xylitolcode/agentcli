"""委派总线：主会话把任务外包给另一个 agent 的**常驻会话槽**。

跟 CLI 内部的子代理（claude Task / qwen agent 在自己进程里起内部上下文）
不是一回事：这里由底座在 ``sessions`` 注册表里开一张「子槽」，用 PTY 承载
非交互 agent，任务描述走 argv，跑完把回执回灌给父会话的事件通道。

链路::

    父会话 PTY 输出
      └─ 适配器解析出 action=delegate 的事件
           └─ delegation.dispatch(parent_session, event)
                ├─ 找/建一张子槽（sid 常驻，role=child，parent_sid 指向父会话）
                ├─ 忙锁：槽正在干活就拒绝（单 agent 串行）
                ├─ 在槽里拉起一代非交互子进程跑 prompt
                ├─ 子槽输出同样过 _parse_agent_stream，它自己抛的 delegate
                │   事件会再接住，派给下一级（a→b→c 的真实链路）
                └─ 子进程 EOF → 采集 result，等下级收口，回执逐级回灌

为什么是「槽常驻、进程按任务换」：claude / codex / qwen 的非交互模式都是
一次性进程，任务描述在 argv 里，跑完即退；进程本身没有持久身份。但**会话
身份**可以在注册表里留住 —— sid / 父子关系 / 委派 id 不随进程消失，下一个
任务复用同一张槽（换一代进程），链路身份才不会断。

进程内单例：跟 ``sessions.registry`` 一样，多 worker 下需要换共享存储。
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field

from . import agents, sessions

logger = logging.getLogger(__name__)

# 子任务最长运行时间（秒）。非交互问答不该长跑，超时按 failed 收。
DELEGATE_TIMEOUT = 120.0
# 子进程输出采集上限（字节），超了截断，避免一个失控子任务撑爆内存。
OUTPUT_LIMIT = 256 * 1024
# 链路层级上限：a→b→c→d 就到顶，挡住互相甩锅式的递归外包。
MAX_CHAIN = 4


@dataclass
class Delegation:
    """一条委派任务台账。"""

    id: str
    parent_sid: str
    # 子任务跑哪个 profile（claude / codex / qwen ...）
    profile: str
    # 委派事件里带的目标代理名（可能是子代理类型，不一定等于 profile）
    target: str | None
    prompt: str
    cwd: str
    # 跑这条任务的子槽 sid（常驻，跨任务复用）
    child_sid: str = ""
    # 链路层级，父会话 depth + 1
    depth: int = 1
    status: str = "pending"  # pending | running | done | failed
    reply: str = ""
    error: str = ""
    created_at: float = field(default_factory=time.monotonic)
    finished_at: float = 0.0
    # 链式外包：本任务又派生的下一级任务 id（a→b→c 时，b 这条指向 c）
    child_id: str = ""
    # 采集子槽输出的观察者（非台账字段，不序列化）
    watcher: object = field(default=None, repr=False, compare=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "parent_sid": self.parent_sid,
            "profile": self.profile,
            "target": self.target,
            "child_sid": self.child_sid,
            "depth": self.depth,
            "prompt": self.prompt,
            "status": self.status,
            "reply": self.reply,
            "error": self.error,
            "child_id": self.child_id,
        }


# 任务台账：delegation id -> Delegation。进程内。
_tasks: dict[str, Delegation] = {}
# 串行化子槽建槽，避免同一目标被并发开出两张槽。
_slot_lock = asyncio.Lock()


def all_tasks() -> list[dict]:
    return [t.to_dict() for t in _tasks.values()]


def tasks_for_parent(parent_sid: str) -> list[dict]:
    return [t.to_dict() for t in _tasks.values() if t.parent_sid == parent_sid]


def pending_for(parent_sid: str) -> list[Delegation]:
    """某会话名下还没收口的委派任务（pending / running）。

    EOF 时用来判断「进程退了但外包活还没交回执」——这种会话的 WebSocket
    不能立刻关，否则回执帧永远到不了前端。
    """
    return [
        t for t in _tasks.values()
        if t.parent_sid == parent_sid and t.status in ("pending", "running")
    ]


def _resolve_profile(target: str | None, fallback: str) -> str:
    """委派目标 -> 底座 profile。

    先认 target 里直接给的 profile 名；认不出就退回父会话自己的 profile。
    CLI 子代理类型（如 claude 的 Explore）不是独立 profile，这里不强行映射。
    """
    available = {a["name"] for a in agents.list_adapters()}
    if target and target in available:
        return target
    return fallback


async def dispatch(
    parent_session,
    event: dict,
    *,
    profile: str,
    cwd: str,
    force: bool = False,
) -> Delegation | None:
    """把一条 delegate 事件派成子任务（落到父会话名下的一张常驻子槽）。

    ``parent_session`` 是注册表会话；回执通过它的观察者通道回灌。
    ``event`` 是归一化后的事件 dict（含 tool/target/text/raw）。
    ``force`` 供显式「重跑」用：跳过外包开关检查（用户手点的动作，不是
    父 agent 自己发的委派）。
    """
    prompt = _extract_prompt(event)
    if not prompt:
        logger.info("委派事件缺任务描述，跳过：%s", event)
        return None

    target = event.get("target")
    child_profile = _resolve_profile(target, profile)
    adapter = agents.get_adapter(child_profile)
    if adapter.kind != "agent":
        logger.info("目标 %s 不是 agent，不派生子任务", child_profile)
        return None

    # 外包模式未开启：不允许 agent 间派发。
    if not force and not getattr(parent_session.runtime, "outsourcing", False):
        logger.info("外包模式未开启，拒绝委派：%s", parent_session.sid)
        return None

    depth = parent_session.runtime.depth + 1
    task = Delegation(
        id=uuid.uuid4().hex[:12],
        parent_sid=parent_session.sid,
        profile=child_profile,
        target=target,
        prompt=prompt,
        cwd=cwd,
        depth=depth,
    )
    _tasks[task.id] = task
    # 链式登记：父任务（若本会话是被外包来的子任务）挂上下一级
    _link_parent(parent_session, task)

    if depth > MAX_CHAIN:
        _fail(parent_session, task, f"链路已到 {MAX_CHAIN} 级，拒绝继续外包")
        return task

    slot = await _slot_for(parent_session, child_profile, target or "", cwd)
    task.child_sid = slot.sid

    # 忙锁：一个 agent 同一时间只做一件事。目标槽正在跑（不管跑的是用户的活
    # 还是别人的外包）就拒绝，进入排队等下一轮，不并行塞第二件。
    if slot.runtime.is_busy() or not slot.runtime.mark_busy("delegate"):
        _fail(parent_session, task,
              f"目标会话忙（{slot.runtime.busy_kind or 'user'}），单 agent 串行")
        return task

    slot.runtime.delegation_id = task.id
    await _launch(parent_session, slot, task)
    return task


async def rerun(child_sid: str) -> tuple[bool, str]:
    """把这张子槽上最近一次委派任务原样再跑一遍。

    子槽是常驻的：sid / 父子关系不变，只换一代进程。前端在子会话 EOF 后给
    「重开」按钮用 —— 用户不该为了再跑一次而重新描述任务。
    """
    items = [t for t in _tasks.values() if t.child_sid == child_sid and t.prompt]
    if not items:
        return False, "这张子槽没有可重跑的任务记录"
    last = max(items, key=lambda t: t.created_at)

    slot = await sessions.registry.get(child_sid)
    if slot is None:
        return False, "子会话已回收，回不到原来的槽"
    parent = await sessions.registry.get(last.parent_sid)
    if parent is None:
        return False, "父会话已回收，重跑没有回执落点"
    if slot.runtime.is_busy():
        return False, "子会话还在忙，等这一轮收口再重跑"

    event = {"tool": "Task", "target": last.target, "text": last.prompt, "raw": {}}
    task = await dispatch(parent, event, profile=last.profile, cwd=last.cwd, force=True)
    if task is None:
        return False, "任务描述为空，无法重跑"
    if task.status == "failed":
        return False, task.error or "重跑派发失败"
    return True, f"已重跑 {task.profile} · {task.id}"


async def _slot_for(parent_session, profile: str, label: str, cwd: str) -> "_Session":
    """取父会话名下的一张子槽；没有就开一张（只有身份，进程按任务再拉）。

    同一父会话、同一 profile、同一目标名复用同一张槽 —— 这就是「常驻」：
    干完活槽还在，下一个任务还是它，sid 不变。
    """
    async with _slot_lock:
        found = sessions.registry.find_child(parent_session.sid, profile, label)
        if found is not None:
            return found

        async def factory(s: sessions._Session) -> None:
            rt = s.runtime
            rt.profile = profile
            rt.kind = "agent"
            rt.cwd = cwd
            rt.parent_sid = parent_session.sid
            rt.role = "child"
            rt.label = label
            rt.depth = parent_session.runtime.depth + 1
            rt.outsourcing = parent_session.runtime.outsourcing
            rt.pinned = True

        slot = await sessions.registry.create(factory)
        logger.info("新建委派子槽：%s profile=%s parent=%s",
                    slot.sid, profile, parent_session.sid)
        return slot


async def _launch(parent_session, slot: sessions._Session, task: Delegation) -> None:
    """在子槽里拉起一代子进程，并挂上采集观察者。"""
    from . import terminal  # 延迟导入：terminal 反向依赖 delegation

    adapter = agents.get_adapter(task.profile)
    base = _base_argv(task.profile)
    if base is None:
        slot.runtime.mark_idle()
        _fail(parent_session, task, f"找不到可执行文件：{task.profile}")
        return

    argv = adapter.build_argv(base, prompt=task.prompt)
    spec = terminal.PtySpec(
        cwd=task.cwd, argv=argv, profile=task.profile,
        kind="agent", prompt=task.prompt,
    )
    task.status = "running"
    watcher = _ChildWatcher(parent_session, slot, task)
    task.watcher = watcher
    await sessions.registry.attach(slot, watcher)

    logger.info("委派子任务 %s：slot=%s profile=%s prompt=%r",
                task.id, slot.sid, task.profile, task.prompt[:80])
    try:
        terminal.spawn_into_session(spec, slot)
    except OSError as exc:
        await sessions.registry.detach(slot, watcher)
        task.watcher = None
        slot.runtime.mark_idle()
        _fail(parent_session, task, f"拉起子会话失败：{exc}")
        return

    asyncio.create_task(_watch_timeout(parent_session, slot, task))


class _ChildWatcher:
    """子槽的采集观察者：攒输出、记 result、EOF 时收口这条委派任务。"""

    def __init__(self, parent_session, slot: sessions._Session, task: Delegation) -> None:
        self.parent_session = parent_session
        self.slot = slot
        self.task = task
        self.raw = bytearray()
        self.result = ""
        # 下级回执帧（链式合并走 _wait_child，这里只留痕便于排查）
        self.nested: list[dict] = []

    def on_output(self, chunk: bytes) -> None:
        room = OUTPUT_LIMIT - len(self.raw)
        if room > 0:
            self.raw.extend(chunk[:room])

    def on_event(self, event: dict) -> None:
        if event.get("kind") == "result" and event.get("text"):
            self.result = str(event["text"])

    def on_delegation(self, payload: dict) -> None:
        self.nested.append(payload)

    def on_eof(self) -> None:
        asyncio.create_task(_finish(
            self.parent_session, self.slot, self.task,
            self.result, bytes(self.raw), self,
        ))


async def _finish(parent_session, slot: sessions._Session, task: Delegation,
                  result_text: str, raw: bytes, watcher: "_ChildWatcher") -> None:
    """子进程退出后收口：取回执、等下级、逐级回灌。"""
    if task.status in ("done", "failed"):
        await _release(slot, task, watcher)
        return
    # 同一轮里刚抛出的 delegate 事件是 ensure_future 派发的，先让它落一次，
    # 否则子进程退出得比派发协程快时，child_id 还没登记就收口了。
    await asyncio.sleep(0.3)

    reply = result_text or _collect_reply(task.profile, raw)
    child = _tasks.get(task.child_id) if task.child_id else None
    if child is not None:
        await _wait_child(child)
        if child.reply:
            reply = f"{reply}\n[下级 {child.profile} 回执] {child.reply}" if reply else child.reply
        if child.error and not reply:
            reply = ""
    error = "" if reply else "子任务没有产出结果（进程退出）"
    if child is not None and child.error and not child.reply:
        error = f"下级任务失败：{child.error}"

    task.status = "failed" if error else "done"
    task.reply = reply
    task.error = error
    task.finished_at = time.monotonic()
    await _release(slot, task, watcher)
    _deliver(parent_session, task)


async def _release(slot: sessions._Session, task: Delegation, watcher: "_ChildWatcher") -> None:
    """收口后摘掉采集观察者、释放串行锁；槽本身留着等下一个任务。"""
    await sessions.registry.detach(slot, watcher)
    task.watcher = None
    slot.runtime.mark_idle()


async def _watch_timeout(parent_session, slot: sessions._Session, task: Delegation) -> None:
    """超时兜底：杀进程、按 failed 收口。"""
    deadline = time.monotonic() + DELEGATE_TIMEOUT
    while time.monotonic() < deadline:
        if task.status in ("done", "failed"):
            return
        await asyncio.sleep(0.25)
    if task.status in ("done", "failed"):
        return

    from . import terminal

    task.status = "failed"
    task.error = f"子任务超时（{DELEGATE_TIMEOUT:.0f}s）"
    task.finished_at = time.monotonic()
    terminal.close_pty(slot.runtime)
    watcher = task.watcher
    if watcher is not None:
        await _release(slot, task, watcher)
    else:
        slot.runtime.mark_idle()
    _deliver(parent_session, task)


def _link_parent(parent_session, task: Delegation) -> None:
    """若当前会话本身是上一级外包任务派生的，把本任务记为它的 child。"""
    parent_task_id = getattr(parent_session.runtime, "delegation_id", "")
    if parent_task_id and parent_task_id in _tasks:
        _tasks[parent_task_id].child_id = task.id


def _fail(parent_session, task: Delegation, error: str) -> None:
    """就地失败收口，并把原因回灌父会话。"""
    task.status = "failed"
    task.error = error
    task.finished_at = time.monotonic()
    logger.info("委派任务 %s 失败：%s", task.id, error)
    _deliver(parent_session, task)


def _extract_prompt(event: dict) -> str:
    """从委派事件里抠任务描述：优先 raw.input.prompt，退回事件文本。"""
    raw = event.get("raw") or {}
    message = raw.get("message") or {}
    content = message.get("content") or []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "tool_use":
            inp = block.get("input") or {}
            for key in ("prompt", "description", "message", "task"):
                if inp.get(key):
                    return str(inp[key]).strip()
    text = event.get("text") or ""
    return text.strip()


async def _wait_child(child: Delegation, timeout: float = DELEGATE_TIMEOUT) -> None:
    """阻塞到链式下级收口（done/failed），超时放弃。"""
    waited = 0.0
    while waited < timeout:
        if child.status in ("done", "failed"):
            return
        await asyncio.sleep(0.05)
        waited += 0.05


def _base_argv(profile: str) -> list[str] | None:
    """从 settings 取登记的可执行路径（复用 terminal.resolve_profile 的白名单）。"""
    from . import terminal

    resolved = terminal.resolve_profile(profile)
    return resolved[1] if resolved else None


def _collect_reply(profile: str, stdout: bytes) -> str:
    """从子槽输出提取最终回执。

    非交互 agent 多为 stream-json：优先取 result 事件；取不到就把最后
    一段文本拼接返回。
    """
    adapter = agents.get_adapter(profile)
    result_text = ""
    text_parts: list[str] = []

    for raw_line in stdout.split(b"\n"):
        line = raw_line.decode("utf-8", "replace").strip()
        if not line:
            continue
        data = adapter._load_json(line)
        if data is None:
            text_parts.append(line)
            continue
        for ev in adapter.parse_events(data):
            if ev.kind == "result" and ev.text:
                result_text = ev.text
            elif ev.kind == "text" and ev.text:
                text_parts.append(ev.text)

    if result_text:
        return result_text[:OUTPUT_LIMIT]
    return "\n".join(text_parts).strip()[:OUTPUT_LIMIT]


def _deliver(parent_session, task: Delegation) -> None:
    """把回执作为 delegate-result 事件推回父会话的全部观察者。"""
    payload = {
        "type": "delegate-result",
        "delegation": task.to_dict(),
    }
    for watcher in list(parent_session.runtime.watchers):
        if hasattr(watcher, "on_delegation"):
            watcher.on_delegation(payload)
