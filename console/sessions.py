"""PTY 会话注册表 —— 让会话活在连接之外。

原来的模型是「一个 WebSocket 连接 = 一个前台进程」：连接断开就在 ``finally`` 里
把 PTY 进程杀掉。浏览器硬刷新、断网、切标签都会触发断开，于是上下文、目录、
agent 进程全丢。这里把会话抬到注册表这一层：

* 会话由 ``session_id`` 标识，进程、PTY fd、输出缓冲都挂在会话上，不挂在
  连接上；
* 连接断开只摘走当前的「观察者」，进程继续跑，输出继续进环形缓冲；
* 带着同一个 ``session_id`` 重连时，把缓冲里的历史字节回放给新连接，再接管
  后续的实时流；
* 进程退出（EOF）后会话进入 ``dead``，留一段回收窗口让重连能看到最终输出；
* 超时未被任何连接接回的空闲会话，由后台任务兜底清理。

这个注册表是**进程内单例**：uvicorn 单进程运行（当前就是这种起法）没问题。
将来上多 worker，会话亲和得换成共享存储，别在这层假设跨进程可见。
"""

from __future__ import annotations

import asyncio
import collections
import logging
import os
import time
import uuid
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# 重连回放的历史缓冲上限：超出后丢最老的字节。缓冲只服务「刚连上那一下看
# 到之前的画面」，完整回滚终端不依赖它（xterm 自己有 scrollback）。
REPLAY_LIMIT = 256 * 1024
# 进程退出后，死会话留在表里供重连回看的时长（秒）
DEAD_TTL = 30.0
# 有常驻子槽的父会话：它一回收就会级联清掉所有子槽，子代理的「案发现场」
# 也就没了。前端要从房间条点开子会话看屏，所以给这类父会话放宽到 5 分钟。
DEAD_TTL_WITH_CHILDREN = 300.0
# 空闲（没有任何连接挂着）会话的最长保留时长（秒）。超过就主动收尸，
# 避免浏览器关了页面之后 agent 进程在后台一直挂着。
IDLE_TTL = 300.0
# 空闲扫描周期
SWEEP_INTERVAL = 30.0


@dataclass
class Runtime:
    """会话上挂的、跟连接无关的运行时状态。

    一个会话同一时刻只允许一个活动连接（当前产品形态就是单标签）。``watcher``
    是当前连着的那个回调；重连时新观察者先替换旧的，旧连接随后自己断开。
    """

    loop: asyncio.AbstractEventLoop
    pid: int = 0
    fd: int = -1
    cols: int = 100
    rows: int = 30
    profile: str = ""
    kind: str = "shell"
    # interactive：原生 TUI（多轮、上下文归 CLI）；headless：-p/exec 一次性任务
    mode: str = "interactive"
    # CLI 自己的会话 id（只有 resumable 的适配器会填）：控制台 sid 仍是主身份，
    # 这个字段用来在「重开」时 --resume 回同一段上下文。
    agent_sid: str = ""
    resumable: bool = False
    cwd: str = ""
    # 环形缓冲：最近一段输出，供重连回放
    buffer: collections.deque[bytes] = field(default_factory=lambda: collections.deque(maxlen=REPLAY_LIMIT))
    buffer_size: int = 0
    # 观察者列表：一个会话可被多个连接/面板订阅（多标签、父子会话回灌）
    watchers: list[object] = field(default_factory=list)
    # 进程是否已经 EOF / 退出
    eof: bool = False
    # PTY 可读回调是否已经挂到事件循环上（避免重连时重复 add_reader）
    reader_attached: bool = False
    last_active: float = field(default_factory=time.monotonic)
    # agent 适配器归一化后的文件访问记录：rel 路径 -> {"read": bool, "write": bool}
    file_events: dict[str, dict[str, bool]] = field(default_factory=dict)
    # 父子委派关系：parent_sid 为空表示主会话；role = main / child
    parent_sid: str = ""
    role: str = "main"
    label: str = ""
    # 委派链路：本会话当前挂在哪条委派任务上（子槽按任务换进程，这个 id 跟着换），
    # depth 是链路层级，用于挡递归派发。
    delegation_id: str = ""
    depth: int = 0
    # 常驻槽：委派子会话干完活不跟着进程一起回收，sid 与父子身份留着等下一个任务。
    # 由 delegation 层置位；父会话收尸时连带清理。
    pinned: bool = False
    # 单 agent 串行状态：idle 待命 / busy 忙。一个 agent 同一时间只做一件事，
    # 要么接用户派的活，要么接别的 agent 派的活，二者互斥。
    # busy_kind: 空 | user（用户任务）| delegate（agent 外包来的活）
    busy: bool = False
    busy_kind: str = ""
    # 外包模式：开启后才允许 agent 间一对一派发；由用户在前端开关。
    outsourcing: bool = False

    def is_busy(self) -> bool:
        return self.busy and not self.eof

    def mark_busy(self, kind: str) -> bool:
        """认领一个任务；已忙则拒绝。kind = user | delegate。"""
        if self.is_busy():
            return False
        self.busy = True
        self.busy_kind = kind
        return True

    def mark_idle(self) -> None:
        self.busy = False
        self.busy_kind = ""

    def push_output(self, chunk: bytes) -> None:
        if not chunk:
            return
        if self.buffer_size + len(chunk) > REPLAY_LIMIT:
            # 把最老的条目裁到够装新块为止
            while self.buffer and self.buffer_size + len(chunk) > REPLAY_LIMIT:
                old = self.buffer.popleft()
                self.buffer_size -= len(old)
        self.buffer.append(chunk)
        self.buffer_size += len(chunk)

    def replay(self) -> bytes:
        return b"".join(self.buffer)

    def touch(self) -> None:
        self.last_active = time.monotonic()

    def record_file(self, rel: str, action: str | None) -> None:
        """记录一次 agent 文件访问，供目录树标色。action: read / write / exec。"""
        if not rel or action not in ("read", "write", "exec"):
            return
        entry = self.file_events.setdefault(rel, {"read": False, "write": False})
        if action == "write":
            entry["write"] = True
        elif action == "read":
            entry["read"] = True


class SessionRegistry:
    """``session_id -> Session`` 的进程内注册表。"""

    def __init__(self) -> None:
        self._sessions: dict[str, "_Session"] = {}
        self._lock = asyncio.Lock()
        self._sweep_task: asyncio.Task | None = None

    # ---- 生命周期 ----

    def start_sweeper(self, loop: asyncio.AbstractEventLoop) -> None:
        if self._sweep_task is None or self._sweep_task.done():
            self._sweep_task = loop.create_task(self._sweep_loop())

    async def create(self, factory) -> "_Session":
        """新建会话并通过 ``factory(runtime)`` 拉起 PTY 进程。

        ``factory`` 是 terminal 层传入的闭包：它拿到 ``Runtime`` 后 fork 进程、
        回填 pid/fd，并注册好可读回调。注册表不直接碰 pty。
        """
        async with self._lock:
            sid = uuid.uuid4().hex[:16]
            runtime = Runtime(loop=asyncio.get_running_loop())
            session = _Session(sid=sid, runtime=runtime, registry=self)
            await factory(session)
            self._sessions[sid] = session
            logger.info("会话已创建：%s", sid)
            return session

    async def get(self, sid: str) -> "_Session | None":
        async with self._lock:
            return self._sessions.get(sid)

    async def attach(self, session: "_Session", watcher) -> None:
        """把一个连接/面板登记为会话观察者（可多个并存）。"""
        async with self._lock:
            if watcher not in session.runtime.watchers:
                session.runtime.watchers.append(watcher)
            session.runtime.touch()

    async def detach(self, session: "_Session", watcher) -> None:
        """连接断开：只摘对应观察者，不动进程。"""
        async with self._lock:
            if watcher in session.runtime.watchers:
                session.runtime.watchers.remove(watcher)
            session.runtime.touch()

    async def remove(self, sid: str) -> None:
        async with self._lock:
            self._sessions.pop(sid, None)

    def all(self) -> list["_Session"]:
        """快照表里所有会话（服务关闭时收尸用）。"""
        return list(self._sessions.values())

    def children(self, parent_sid: str) -> list["_Session"]:
        """返回某个父会话派生的全部子会话（含常驻槽）。"""
        return [
            s for s in self._sessions.values()
            if s.runtime.parent_sid == parent_sid
        ]

    def find_child(self, parent_sid: str, profile: str, label: str = "") -> "_Session | None":
        """按父会话 + profile + 目标名找一个现成的子槽，供委派复用。"""
        for s in self._sessions.values():
            rt = s.runtime
            if rt.parent_sid != parent_sid:
                continue
            if rt.profile == profile and (rt.label or "") == (label or ""):
                return s
        return None

    # ---- 兜底回收 ----

    async def _sweep_loop(self) -> None:
        while True:
            await asyncio.sleep(SWEEP_INTERVAL)
            now = time.monotonic()
            stale: list[_Session] = []
            async with self._lock:
                for session in self._sessions.values():
                    rt = session.runtime
                    if rt.pinned:
                        # 常驻委派槽：sid 与父子身份要留给下一个任务，不按空闲回收。
                        # 生命周期跟着父会话走（父会话收尸时级联清理）。
                        continue
                    if rt.eof:
                        # 带常驻子槽的父会话多留一会儿：子面板要靠它活着
                        ttl = (
                            DEAD_TTL_WITH_CHILDREN
                            if any(child.runtime.pinned for child in self.children(session.sid))
                            else DEAD_TTL
                        )
                        if now - rt.last_active > ttl:
                            stale.append(session)
                    elif not rt.watchers and not rt.is_busy() and now - rt.last_active > IDLE_TTL:
                        # 忙的会话不被空闲回收：agent 正在跑任务，断连只是观众离开。
                        stale.append(session)
            for session in stale:
                await session.shutdown()


class _Session:
    """注册表中的一个会话：对外暴露给连接层使用。"""

    def __init__(self, sid: str, runtime: Runtime, registry: SessionRegistry) -> None:
        self.sid = sid
        self.runtime = runtime
        self._registry = registry

    @property
    def eof(self) -> bool:
        return self.runtime.eof

    def output(self, chunk: bytes) -> None:
        """PTY 可读回调：进缓冲，并广播给全部观察者。"""
        rt = self.runtime
        rt.push_output(chunk)
        rt.touch()
        for watcher in list(rt.watchers):
            watcher.on_output(chunk)

    def mark_eof(self) -> None:
        rt = self.runtime
        rt.eof = True
        rt.touch()
        for watcher in list(rt.watchers):
            watcher.on_eof()

    async def shutdown(self) -> None:
        """收尸：先级联收掉子会话槽，再关闭本会话 PTY、从注册表摘除。

        子槽的生命周期挂在父会话上 —— 父会话没了，常驻槽也没有存在的意义，
        否则一屏子进程会一直挂着。
        """
        for child in self._registry.children(self.sid):
            await child.shutdown()
        rt = self.runtime
        if rt.fd >= 0:
            from . import terminal  # 延迟导入，避免模块级循环

            terminal.close_pty(rt)
        await self._registry.remove(self.sid)
        logger.info("会话已回收：%s", self.sid)


# 进程内单例。terminal 层和 ASGI lifespan 都从这里取。
registry = SessionRegistry()

# 控制台 sid -> (profile, CLI 自己的 session id)。会话被回收后仍保留一小段，
# 供「重开」按旧 sid 找回 CLI 会话续上下文；条数有上限，不无限增长。
_AGENT_IDS: dict[str, tuple[str, str]] = {}
_AGENT_IDS_LIMIT = 512


def remember_agent(sid: str, profile: str, agent_sid: str) -> None:
    if not sid or not agent_sid:
        return
    _AGENT_IDS.pop(sid, None)
    _AGENT_IDS[sid] = (profile, agent_sid)
    while len(_AGENT_IDS) > _AGENT_IDS_LIMIT:
        _AGENT_IDS.pop(next(iter(_AGENT_IDS)), None)


def recall_agent(sid: str) -> tuple[str, str] | None:
    return _AGENT_IDS.get(sid)


def pid_of(session: _Session) -> int:
    return session.runtime.pid


def fd_of(session: _Session) -> int:
    return session.runtime.fd


def keep_fd(session: _Session, fd: int) -> None:
    session.runtime.fd = fd


def keep_pid(session: _Session, pid: int) -> None:
    session.runtime.pid = pid


def keep_size(session: _Session, cols: int, rows: int) -> None:
    session.runtime.cols, session.runtime.rows = cols, rows


def current_size(session: _Session) -> tuple[int, int]:
    return session.runtime.cols, session.runtime.rows
