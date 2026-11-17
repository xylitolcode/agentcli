"""PTY 会话层 —— 把真实伪终端挂到 WebSocket 上。

这个项目要搬进浏览器的是**命令行 agent**（claude / codex / qwen 之类），不是登录
shell。它们都是交互式 TUI 进程：全屏接管、按帧重绘、要 tty 才肯渲染、Ctrl-C 表示
"取消当前任务"而不是退出。所以唯一的承载方式是 PTY —— 用管道接 stdout 会把它们
拍成一段静态文本，交互全丢。

浏览器不执行任何东西，它只是一台显示器。WebSocket 负责原样搬运字节。

帧协议（刻意做得很薄，不做任何转码）：

    二进制帧   终端原始字节流，两个方向都是。浏览器发什么按键就写什么字节。
    文本帧     JSON 控制消息::

        {"type": "resize", "cols": 100, "rows": 30}
        {"type": "session", "sid": "..."}     首连/重连后服务端回传会话 id

    输入一律走二进制，所以文本帧可以安全地当控制通道用，不必担心
    用户敲了个 ``{`` 开头的东西被误判。

会话保持见 ``console.sessions``：进程挂在会话上而不是连接上，断连不杀进程，
带同一个 ``sid`` 重连会回放历史缓冲再接管实时流。
"""

from __future__ import annotations

import asyncio
import fcntl
import json
import logging
import os
import pty
import shutil
import signal
import struct
import termios
import time
import uuid
from dataclasses import dataclass
from urllib.parse import parse_qs

from django.conf import settings

from . import agents, bridge, config, delegation, files, projects, sessions

logger = logging.getLogger(__name__)

READ_SIZE = 65536
MAX_COLS, MAX_ROWS = 500, 300
MIN_COLS, MIN_ROWS = 20, 5
# 初始任务（URL query prompt）长度上限：任务描述不是数据通道，别拿它塞文件
PROMPT_LIMIT = 4096


def _which(program: str) -> str | None:
    """找可执行文件。比 shutil.which 多点兜底 —— uvicorn 若是 nohup 起的，
    PATH 里经常没有 ~/.local/bin，agent CLI 就"凭空消失"了。"""
    if os.sep in program:
        return program if os.access(program, os.X_OK) else None

    found = shutil.which(program)
    if found:
        return found

    for folder in (
        os.path.expanduser("~/.local/bin"),
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
    ):
        candidate = os.path.join(folder, program)
        if os.access(candidate, os.X_OK):
            return candidate
    return None


def resolve_profile(name: str) -> tuple[str, list[str]] | None:
    """profile 名 -> (名字, 绝对 argv)。程序不存在就返回 None。"""
    argv = settings.CONSOLE_PROFILES.get(name)
    if not argv:
        return None
    exe = _which(argv[0])
    if not exe:
        return None
    return name, [exe, *argv[1:]]


def available_profiles() -> list[dict]:
    """当前机器上真正能拉起来的那几个，前端只显示这些。

    白名单（能不能拉起进程）仍由 settings 定；数据库里的 Profile 行决定启用状态、
    展示名和排序。表里没记录的 profile 按「启用」处理，保证刚迁移/未播种时界面不变。
    """
    rows = {p.name: p for p in config.profile_rows()}
    items = []
    # 先按数据库里配置的顺序排，表里没有的按原白名单顺序跟在后面
    names = sorted(
        settings.CONSOLE_PROFILES,
        key=lambda n: (rows[n].sort_order if n in rows else 10_000, n),
    )
    for name in names:
        row = rows.get(name)
        if row and not row.enabled:
            continue
        resolved = resolve_profile(name)
        if resolved:
            # kind / interactive 给前端用：交互态 agent 可以空着开（原生 TUI），
            # headless 才必须带初始任务（`-p` 没有任务直接报错）。
            adapter = agents.get_adapter(name)
            items.append({
                "name": name,
                "path": resolved[1][0],
                "kind": adapter.kind,
                "interactive": adapter.interactive,
                "label": (row.label if row and row.label else adapter.label),
            })
    return items


def _build_env() -> dict[str, str]:
    env = dict(os.environ)
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    env.setdefault("HOME", os.path.expanduser("~"))

    local_bin = os.path.expanduser("~/.local/bin")
    path = env.get("PATH", "")
    if local_bin not in path.split(os.pathsep):
        env["PATH"] = f"{local_bin}{os.pathsep}{path}" if path else local_bin
    return env


@dataclass
class PtySpec:
    """拉起一个 PTY 所需的静态参数。会话创建时带在闭包里。"""

    cwd: str
    argv: list[str]
    profile: str
    project_id: int | None = None
    kind: str = "shell"
    prompt: str = ""
    # interactive：原生 TUI（多轮、上下文归 CLI）；headless：-p/exec 一次性任务
    mode: str = "interactive"
    # 新会话给 CLI 预分配的 session id（resumable 适配器才用）
    agent_sid: str = ""
    # 重开时要求 CLI 续上的旧 session id
    resume: str = ""
    # 外包提示词：会话启动时从配置取一次，经此传给 bridge 注入 TUI
    delegate_prompt: str = ""


def _spawn(spec: PtySpec, runtime: sessions.Runtime, sid: str = "") -> None:
    """fork 出前台进程，把 pid/fd 回填到会话运行时状态上。

    agent 的最终 argv 必须等 sid 确定后再生成：交互态要把 sid 交给 MCP server
    （「替哪张会话说话」），而 sid 是注册表 create 时才分配的。
    """
    env = _build_env()
    # 适配器按需注入鉴权/反代覆盖环境变量（如 codex 的 OPENAI_API_KEY）
    adapter = agents.get_adapter(spec.profile)
    env.update(adapter.env())

    argv = list(spec.argv)
    agent_sid = ""
    if adapter.kind == "agent":
        resumable = adapter.resumable and spec.mode == "interactive"
        if resumable:
            # 续会话就用旧 id；新会话预分配一个，让 CLI 从一开始就落在我们
            # 记录的 session id 上，重开时才能 --resume 回来。
            agent_sid = spec.resume or spec.agent_sid or str(uuid.uuid4())
        argv = adapter.build_argv(
            spec.argv, prompt=spec.prompt or None, mode=spec.mode, sid=sid,
            agent_sid=agent_sid, resume=spec.resume if resumable else "",
            delegate_prompt=spec.delegate_prompt,
        )

    pid, fd = pty.fork()
    if pid == 0:  # 子进程：绝不能回到 asyncio 的地盘，出错直接 _exit
        try:
            os.chdir(spec.cwd)
            os.execvpe(argv[0], argv, env)
        except BaseException:
            os._exit(127)

    runtime.pid, runtime.fd = pid, fd
    runtime.mode = spec.mode
    runtime.agent_sid = agent_sid
    runtime.resumable = bool(adapter.resumable and spec.mode == "interactive")
    if agent_sid and sid:
        sessions.remember_agent(sid, spec.profile, agent_sid)
        logger.info("CLI 会话身份：%s -> %s（%s）",
                    sid, agent_sid, "resume" if spec.resume else "new")
    os.set_blocking(fd, False)
    _resize_fd(fd, runtime.cols, runtime.rows)


def _detach_reader(runtime: sessions.Runtime) -> None:
    """把 PTY 可读回调从事件循环上摘掉（换进程/收尸前都要先摘）。"""
    if not runtime.reader_attached:
        return
    fd = runtime.fd
    runtime.reader_attached = False
    if fd < 0:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    try:
        loop.remove_reader(fd)
    except (OSError, ValueError):
        pass


def spawn_into_session(spec: PtySpec, session: sessions._Session) -> None:
    """在**已有会话槽**里拉起一代新进程：sid 不变，进程与缓冲换新。

    委派子槽的复用入口。非交互 agent 的任务描述在 argv 里，所以每个任务都是
    「同一张工位换一个人」——身份（sid / 父子关系 / 委派 id）留在注册表上，
    进程跑完即退，槽不消失。
    """
    runtime = session.runtime
    _detach_reader(runtime)
    if runtime.fd >= 0 or runtime.pid > 0:
        close_pty(runtime)

    runtime.eof = False
    runtime.buffer.clear()
    runtime.buffer_size = 0
    runtime.file_events.clear()
    runtime.__dict__.pop("_event_buf", None)
    runtime.profile = spec.profile
    runtime.kind = spec.kind
    runtime.cwd = spec.cwd

    _spawn(spec, runtime, session.sid)
    if runtime.fd >= 0:
        _attach_reader(session, asyncio.get_running_loop())


def _resize_fd(fd: int, cols: int, rows: int) -> None:
    if fd < 0:
        return
    cols = max(MIN_COLS, min(int(cols), MAX_COLS))
    rows = max(MIN_ROWS, min(int(rows), MAX_ROWS))
    try:
        # TIOCSWINSZ 会顺带把 SIGWINCH 发给前台进程组，不用手动 kill
        fcntl.ioctl(
            fd,
            termios.TIOCSWINSZ,
            struct.pack("HHHH", rows, cols, 0, 0),
        )
    except OSError:
        pass


def close_pty(runtime: sessions.Runtime) -> None:
    """收尸。agent 进程不一定吃 SIGHUP（node 程序常自己接管），必须确认它
    真的死了并 waitpid 回收 —— 只发信号不回收，会话一多就是一屏僵尸进程。"""
    # 先摘可读回调再关 fd：selector 上留着已关闭的 fd 会一直报错
    _detach_reader(runtime)
    if runtime.fd >= 0:
        try:
            os.close(runtime.fd)
        except OSError:
            pass
        runtime.fd = -1

    pid, runtime.pid = runtime.pid, 0
    runtime.mark_idle()
    if pid <= 0:
        return

    _signal(pid, signal.SIGHUP)
    for _ in range(25):  # 给 250ms 体面退出，让 agent 自己保存会话状态
        if _reaped(pid):
            return
        time.sleep(0.01)

    _signal(pid, signal.SIGKILL)
    try:
        os.waitpid(pid, 0)
    except (ChildProcessError, OSError):
        pass


def _signal(pid: int, sig: int) -> None:
    try:
        os.killpg(pid, sig)  # pty.fork 的子进程是会话首进程，pid 即 pgid
    except OSError:
        pass


def _reaped(pid: int) -> bool:
    try:
        return os.waitpid(pid, os.WNOHANG)[0] == pid
    except ChildProcessError:
        return True
    except OSError:
        return False


async def _write_all(fd: int, data: bytes) -> None:
    """PTY 写端可能是非阻塞的，一次写不完就等一会儿再续。"""
    view = memoryview(data)
    while view:
        try:
            written = os.write(fd, view)
        except BlockingIOError:
            await asyncio.sleep(0.004)
            continue
        except OSError:
            return
        view = view[written:]


class _Watcher:
    """连接 -> 会话的观察者桥。会话层通过它把字节流/EOF 推给当前连接。

    PTY 可读回调跑在事件循环线程上，``send`` 是 ASGI 协程，不能直接 await；
    所以这里把消息丢进连接自己的发送队列，由 ``drain`` 协程串行发出去。
    """

    def __init__(self, session: sessions._Session, send, queue: asyncio.Queue) -> None:
        self._session = session
        self._send = send
        self._queue = queue
        self._closed = False

    def on_output(self, chunk: bytes) -> None:
        if not self._closed:
            self._queue.put_nowait({"type": "websocket.send", "bytes": chunk})

    def on_eof(self) -> None:
        if self._closed:
            return
        # 进程退了，但本会话名下还有没交回执的外包任务：先把连接留着。
        # 直接 close 会把晚到的 delegate-result 帧一起切断 —— 而外包回执
        # 本来就常在本轮结束之后才回来。
        pending = delegation.pending_for(self._session.sid)
        if pending:
            self._queue.put_nowait({
                "type": "websocket.send",
                "text": json.dumps({"type": "session-eof", "pending": len(pending)}),
            })
            asyncio.create_task(self._close_after_pending())
            return
        self._close()

    async def _close_after_pending(self) -> None:
        """等名下委派全部收口再关连接；超时上限跟着子任务超时走。"""
        timeout = (await config.delegate_config_async()).timeout
        deadline = time.monotonic() + timeout * 2
        while time.monotonic() < deadline:
            if not delegation.pending_for(self._session.sid):
                break
            await asyncio.sleep(0.2)
        self._close()

    def _close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._queue.put_nowait({"type": "websocket.close", "code": 1000})

    def on_event(self, event: dict) -> None:
        """适配器归一化事件：作为文本帧推给前端（目录树标色用）。"""
        if not self._closed:
            self._queue.put_nowait({
                "type": "websocket.send",
                "text": json.dumps({"type": "agent-event", "event": event}),
            })

    def on_delegation(self, payload: dict) -> None:
        """委派回执：子任务跑完，把结果帧推给前端。"""
        if not self._closed:
            self._queue.put_nowait({
                "type": "websocket.send",
                "text": json.dumps(payload),
            })

    def detach(self) -> None:
        self._closed = True


def _resolve_spec(
    query: dict[str, list[str]], project: dict | None, delegate_prompt: str = ""
) -> tuple[PtySpec | None, str | None]:
    """按 query 解析 profile 与项目；返回 (spec, 错误提示)。

    ``project`` 是协程里先经 ``projects.get_project_async`` 取好的纯内存快照，
    本函数不再碰 ORM。
    """
    wanted = (query.get("profile") or [settings.CONSOLE_DEFAULT_PROFILE])[0]

    # 未显式指定 profile 时，沿用项目登记的默认 agent；再退回全局默认。
    if not query.get("profile") and project is not None:
        wanted = project["agent"]

    resolved = resolve_profile(wanted) or resolve_profile(settings.CONSOLE_DEFAULT_PROFILE)

    # 默认的和请求的都不在，就退到这台机器上第一个能用的
    # 直接遍历 settings 白名单（内存数据，async 安全），不经 available_profiles 的 ORM 查询
    if resolved is None:
        for name in settings.CONSOLE_PROFILES:
            resolved = resolve_profile(name)
            if resolved:
                break

    if resolved is None:
        hint = (
            f"找不到可用的程序（profile={wanted!r}）。\n"
            f"检查 {settings.CONSOLE_PROFILES} 里的命令是否在 PATH 上。\r\n"
        )
        return None, hint

    profile, argv = resolved
    adapter = agents.get_adapter(profile)
    # 初始任务：交互会话作为首条消息，headless 会话写进 argv。shell 忽略。
    prompt = (query.get("prompt") or [""])[0][:PROMPT_LIMIT]
    # 默认形态：真实 agent 进原生 TUI；只有不支持交互的适配器（测试桩）退回
    # headless。显式 mode 优先，供委派子槽与自动化调用。
    requested_mode = (query.get("mode") or [""])[0].strip()
    if requested_mode in ("interactive", "headless") and adapter.kind == "agent":
        mode = requested_mode
    else:
        mode = "interactive" if adapter.interactive else "headless"
    cwd = str(projects.project_path_dict(project)) if project else str(files.root())
    # 重开续上下文：前端把旧控制台 sid 作为 resume_from 带上来，这里从身份表
    # 找回同一个 profile 的 CLI session id。找不到就照常新开，不报错。
    resume = ""
    resume_from = (query.get("resume_from") or [""])[0].strip()
    if resume_from and adapter.resumable:
        known = sessions.recall_agent(resume_from)
        if known and known[0] == profile:
            resume = known[1]
    return PtySpec(
        cwd=cwd, argv=argv, profile=profile,
        project_id=project["id"] if project else None,
        kind=adapter.kind, prompt=prompt, mode=mode, resume=resume,
        delegate_prompt=delegate_prompt,
    ), None


async def terminal_ws(scope, receive, send) -> None:
    """ASGI WebSocket 入口。

    连接模型：

    * 不带 ``sid``：新建会话，拉起 PTY，首条控制帧回传 ``session`` id；
    * 带已有 ``sid``：接回那个会话，先回放历史缓冲，再接管实时流；
    * 连接断开：只摘观察者，进程留在会话里继续跑，等重连或超时回收。
    """
    # ASGI 规范：accept 之前必须先收掉 websocket.connect 这一帧。漏掉它的后果
    # 很隐蔽 —— 它会一直排在接收队列里，accept 之后被第一条 receive() 取出来，
    # 看着就像客户端一上来就断开，会话还没换热就关了。
    first = await receive()
    if first.get("type") != "websocket.connect":
        return
    await send({"type": "websocket.accept"})

    query = parse_qs(scope.get("query_string", b"").decode(errors="replace"))
    sid_param = (query.get("sid") or [""])[0].strip()

    # MCP server 要回调本进程：用当前 WS 的 server 端口填真实地址（8010/8013
    # 都是按启动参数变的，不能写死）。
    server = scope.get("server") or ("127.0.0.1", 8010)
    bridge.BASE_URL = f"http://127.0.0.1:{server[1]}"

    session: sessions._Session | None = None

    if sid_param:
        existing = await sessions.registry.get(sid_param)
        rerun = (query.get("rerun") or [""])[0] == "1"
        if existing is not None and not existing.eof:
            session = existing
            logger.info("接回已有会话：%s", session.sid)
        elif existing is not None:
            # 死会话：不复活进程，回一眼最终输出后正常关闭。
            # 例外：子会话带 rerun=1 时，在常驻子槽里换一代进程再跑一次。
            if rerun and existing.runtime.role == "child":
                ok, note = await delegation.rerun(existing.sid)
                if ok:
                    session = existing
                    logger.info("子会话重跑：%s（%s）", session.sid, note)
                else:
                    await send({"type": "websocket.send", "text": json.dumps(
                        {"type": "rerun-error", "sid": existing.sid, "reason": note}
                    )})
                    await send({"type": "websocket.send", "bytes": existing.runtime.replay()})
                    await send({"type": "websocket.close", "code": 1000})
                    return
            else:
                await send({"type": "websocket.send", "bytes": existing.runtime.replay()})
                await send({"type": "websocket.close", "code": 1000})
                return
        else:
            # id 失效（过期被回收等）：前端应当丢掉本地 id，走新建
            await send({"type": "websocket.send", "text": json.dumps(
                {"type": "session-missing", "sid": sid_param}
            )})

    if session is None:
        pid_param = (query.get("project") or [""])[0].strip()
        project = await projects.get_project_async(pid_param) if pid_param else None
        # 外包提示词在 async 上下文里取一次，后续同步的 _resolve_spec/_spawn 只透传
        cfg = await config.delegate_config_async()
        spec, hint = _resolve_spec(query, project, delegate_prompt=cfg.prompt)
        if spec is None:
            await send({"type": "websocket.send", "bytes": hint.encode()})
            await send({"type": "websocket.close", "code": 1011})
            return

        # 派生会话：parent 指向已有主会话，role=child，便于多标签/委派归类
        parent_sid = (query.get("parent") or [""])[0].strip()
        parent = await sessions.registry.get(parent_sid) if parent_sid else None

        async def factory(s: sessions._Session) -> None:
            try:
                rt = s.runtime
                rt.profile = spec.profile
                rt.kind = spec.kind
                rt.cwd = spec.cwd
                if parent is not None:
                    rt.parent_sid = parent.sid
                    rt.role = "child"
                    rt.depth = parent.runtime.depth + 1
                    # 子槽继承父会话的外包开关：链式外包不该被开关卡在半路
                    rt.outsourcing = parent.runtime.outsourcing
                else:
                    # 外包是主打功能：原生交互主会话默认开；headless 一次性任务
                    # （委派子槽/自动化）默认关。前端显式带 0/1 时以它为准，
                    # 这样用户关掉开关后重连不会被默认值翻回来。
                    raw = (query.get("outsourcing") or [""])[0]
                    if raw == "1":
                        rt.outsourcing = True
                    elif raw == "0":
                        rt.outsourcing = False
                    else:
                        rt.outsourcing = spec.mode == "interactive"
                _spawn(spec, rt, s.sid)
                if spec.prompt and spec.mode == "headless":
                    # 带初始任务的 headless 会话从第一秒起就在干活，状态条要如实
                    rt.mark_busy("user")
            except OSError as exc:
                logger.warning("启动 %s 失败：%s", spec.profile, exc)
                raise

        try:
            session = await sessions.registry.create(factory)
        except OSError as exc:
            note = f"无法启动 {spec.profile}（{spec.argv[0]}）：{exc}\r\n".encode()
            await send({"type": "websocket.send", "bytes": note})
            await send({"type": "websocket.close", "code": 1011})
            return
        logger.info("会话已启动：profile=%s pid=%s parent=%s",
                    spec.profile, session.runtime.pid, session.runtime.parent_sid or "-")

    assert session is not None
    runtime = session.runtime

    # 首帧：把会话 id 交给前端存进 localStorage，刷新后凭它重连
    await send({"type": "websocket.send", "text": json.dumps(
        {"type": "session", "sid": session.sid,
         "profile": runtime.profile, "role": runtime.role,
         "parent": runtime.parent_sid or "",
         "label": runtime.label, "depth": runtime.depth,
         "mode": runtime.mode,
         "resumable": runtime.resumable,
         "busy": runtime.is_busy(), "busy_kind": runtime.busy_kind,
         "outsourcing": runtime.outsourcing}
    )})

    outbox: asyncio.Queue[dict] = asyncio.Queue()
    watcher = _Watcher(session, send, outbox)
    await sessions.registry.attach(session, watcher)

    # 重连回放：先把缓冲里的历史字节推回去，再进实时循环
    replay = runtime.replay()
    if replay:
        await send({"type": "websocket.send", "bytes": replay})

    # 回放本会话已记录的文件访问标记，前端据此给目录节点标色
    if runtime.file_events:
        await send({"type": "websocket.send", "text": json.dumps(
            {"type": "file-events", "files": runtime.file_events}
        )})

    # 会话已有可读回调挂在 fd 上；新连接只换观察者，不重复 add_reader
    if runtime.fd >= 0 and not runtime.reader_attached:
        loop = asyncio.get_running_loop()
        _attach_reader(session, loop)

    async def ws_to_pty() -> None:
        while True:
            message = await receive()
            if message["type"] == "websocket.disconnect":
                return
            if message["type"] != "websocket.receive":
                continue
            data = message.get("bytes")
            if data is not None:
                if _accept_user_input(session, data, outbox):
                    await _write_all(runtime.fd, data)
                continue
            _handle_control(session, message.get("text") or "")

    async def drain_outbox() -> None:
        while True:
            msg = await outbox.get()
            await send(msg)

    reader_task = asyncio.create_task(ws_to_pty())
    sender_task = asyncio.create_task(drain_outbox())
    try:
        await asyncio.wait({reader_task, sender_task}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in (reader_task, sender_task):
            task.cancel()
        watcher.detach()
        await sessions.registry.detach(session, watcher)


def _attach_reader(session: sessions._Session, loop: asyncio.AbstractEventLoop) -> None:
    runtime = session.runtime
    runtime.reader_attached = True
    fd = runtime.fd
    adapter = agents.get_adapter(runtime.profile) if hasattr(runtime, "profile") else None

    def on_readable() -> None:
        try:
            chunk = os.read(fd, READ_SIZE)
        except BlockingIOError:
            return
        except OSError:
            chunk = b""
        if chunk:
            session.output(chunk)
            _parse_agent_stream(session, chunk)
        else:  # EOF：前台进程退出了
            try:
                loop.remove_reader(fd)
            except (OSError, ValueError):
                pass
            runtime.reader_attached = False
            session.mark_eof()

    loop.add_reader(fd, on_readable)


# 事件流按行切分：缓冲挂在会话上，避免一行 JSONL 被两次 read 拆开。
def _parse_agent_stream(session: sessions._Session, chunk: bytes) -> None:
    """把 agent 输出按 JSONL 喂给适配器，归一化事件记入会话并推给观察者。"""
    runtime = session.runtime
    # 结构化事件只在 headless 有保证：交互态 stdout 是 ANSI 画面，硬按 JSONL
    # 解析只会把 TUI 残片当噪音。交互态的编排走 MCP（bridge）。
    if runtime.kind != "agent" or runtime.mode != "headless":
        return
    adapter = agents.get_adapter(runtime.profile)

    buf = runtime.__dict__.setdefault("_event_buf", b"")
    buf += chunk
    lines = buf.split(b"\n")
    runtime.__dict__["_event_buf"] = lines.pop()  # 最后一段未成行，留下次

    for raw_line in lines:
        line = raw_line.decode("utf-8", "replace").strip()
        if not line:
            continue
        # agent 的输出里混着非 JSONL 的噪音（TUI 残片、进度条），_as_dict 会
        # 返回 None —— 必须跳过，直接丢给 parse_events 会 AttributeError，
        # 而这里跑在 add_reader 回调里，一抛就把整条连接带下来。
        payload = _as_dict(line)
        if payload is None:
            continue
        # 一条 JSONL 可能挂多个工具块（如 qwen 的 assistant 消息），批量出事件
        events = adapter.parse_events(payload)
        for event in events:
            if event.kind == "tool" and event.file:
                # 归一到项目目录之下的相对路径，便于前端目录树节点匹配
                rel = _rel_to_cwd(event.file, runtime.cwd)
                event.file = rel
                runtime.record_file(rel, event.action)
            ev_dict = event.to_dict()
            if event.kind == "result":
                # 一轮任务收口：释放串行锁，状态条回到待命
                runtime.mark_idle()
            # 委派事件：后端派生独立子 agent 跑任务，回执回灌本会话
            if event.action == "delegate":
                asyncio.ensure_future(
                    delegation.dispatch(session, ev_dict, profile=runtime.profile, cwd=runtime.cwd)
                )
            for watcher in list(runtime.watchers):
                if hasattr(watcher, "on_event"):
                    watcher.on_event(ev_dict)


def _rel_to_cwd(path: str, cwd: str) -> str:
    cwd = (cwd or "").rstrip("/")
    if cwd and path.startswith(cwd + "/"):
        return path[len(cwd) + 1:]
    return path


# 中断类按键：Ctrl-C / Ctrl-D / Ctrl-Z / Esc。单 agent 串行下，这些键是
# 「停下」，不是「再加一件活」，所以不拦。
INTERRUPT_BYTES = {b"\x03", b"\x04", b"\x1a", b"\x1b"}


def _accept_user_input(session: sessions._Session, data: bytes, outbox: asyncio.Queue) -> bool:
    """任务入口的忙锁：正在做外包活的会话不再接用户派的新任务。

    agent 会话按「一问一答」用，用户在终端里敲回车就是派活，所以这里把
    用户的输入流当任务入口守。被拒时只回给当前连接一帧 input-rejected，
    不写进 PTY —— 别把垃圾字节喂给正在干活的进程。
    """
    rt = session.runtime
    if not data or rt.kind != "agent":
        return True
    # 交互态：输入就是跟 agent 对话，不是「再派一件活」，不设忙锁、不记 busy。
    # 忙锁只守 headless 的任务入口（一次性进程一次只接一件活）。
    if rt.mode != "headless":
        rt.touch()
        return True
    if rt.is_busy() and rt.busy_kind == "delegate" and data not in INTERRUPT_BYTES:
        outbox.put_nowait({"type": "websocket.send", "text": json.dumps({
            "type": "input-rejected",
            "reason": "会话正在跑外包任务；单 agent 串行，等回执或按 Ctrl-C 中断",
        })})
        return False
    if not rt.is_busy():
        rt.mark_busy("user")
    rt.touch()
    return True


def _as_dict(line: str) -> dict | None:
    try:
        data = json.loads(line)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _handle_control(session: sessions._Session, raw: str) -> None:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return
    if not isinstance(payload, dict):
        return
    if payload.get("type") == "resize":
        cols, rows = payload.get("cols", session.runtime.cols), payload.get("rows", session.runtime.rows)
        session.runtime.cols, session.runtime.rows = cols, rows
        _resize_fd(session.runtime.fd, cols, rows)
        return

    if payload.get("type") == "outsourcing":
        # 外包模式开关：用户在前端手动开启/关闭。开启后才允许 agent 间一对一派发。
        on = bool(payload.get("on", False))
        session.runtime.outsourcing = on
        # 已经派生出来的常驻子槽跟着父会话一起切，否则链式派发会被半路卡住
        for child in sessions.registry.children(session.sid):
            child.runtime.outsourcing = on
