# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

Django 网页版 agent CLI：进系统先在总项目目录选项目，进入后工作区是**多会话面板**
（一个会话一块 xterm + PTY），右侧懒加载项目目录树。`bash` 是系统壳（默认入口）；
`claude` / `codex` / `qwen` 是产品 agent 能力，默认走**原生交互 TUI**（多轮、上下文、
权限弹窗、slash 命令都归 CLI）。适配器层只在 headless 模式下解析 JSONL，驱动目录树与
委派台账。外包（agent 主动调用 `delegate_task`）走 MCP 桥，见 `console/bridge.py`。
仓库已初始化 git（本机提交）。

## 常用命令

```bash
source .venv/bin/activate                  # Python 3.14，依赖 Django + uvicorn[standard]
pip install -r requirements.txt
uvicorn agentcli.asgi:application --port 8010 --reload   # 必须用 uvicorn，runserver 没有 WebSocket
python scripts/smoke.py                     # HTTP 冒烟（页面/命令接口/目录树/越界拦截）
python scripts/check_terminal.py            # WS->PTY 端到端（echo/tty/cd/Ctrl-C/ANSI/宽字符）
python scripts/check_session.py             # 会话保持：断线重连同进程、同 tty、历史回放
python scripts/check_delegation.py          # 委派链路：常驻子槽/a→b→c/忙锁（headless）/交互态直通（桩测）
python scripts/probe_delegation.py          # 人工验收：真实 claude 当子槽（消耗少量真实额度）
python manage.py check
python manage.py test console.tests.<类>.<方法>
```

8000 端口被 Windows 侧代理占用，勿用。无 lint / 格式化工具配置。

## 架构

- **ASGI 分派**：`agentcli/asgi.py` 是唯一入口。`/ws/*` 进 `console/terminal.py`，
  lifespan 自己应答（Django 的 ASGI app 不接），其余全部转发给 Django。
  没用 Channels —— 一个终端不值得引入 channel layer。
- **PTY 会话**：`console/terminal.py:terminal_ws`。`pty.fork` 起前台进程（默认 claude），
  `loop.add_reader` 读 master fd，`asyncio.Queue` 汇合到 WebSocket。
  帧协议：**二进制=原始字节流，文本=JSON 控制消息**（resize / session / session-missing）。
  输入走二进制，所以文本帧可安全当控制通道。
- **会话保持**：进程挂在 `console/sessions.py` 的注册表上，不挂在连接上。
  注册表是进程内单例：`Runtime` 持有 pid/fd/环形缓冲/当前观察者；连接断开只
  `detach` 观察者，不杀进程；带同一 `sid` 重连先回放缓冲再接实时流。空闲
  `IDLE_TTL`（300s）后台扫描回收，进程 EOF 后留 `DEAD_TTL`（30s）再摘除。
  PTY 可读回调在事件循环线程上，不能直接 `await send` —— 输出经连接自己的
  `outbox` 队列由 `drain_outbox` 协程串行发出；两个任务谁先结束都要取消另一个，
  只 `await` 读任务会让发送任务跟着断连一起挂住。
- **URL 状态与布局持久化**：`profile` / `sid` / `project` 以页面 query 为准，启动时
  读 URL，切换/收到 sid 后 `history.replaceState` 写回；`localStorage` 的兜底 sid
  连 profile 一起存，避免跨 profile 接错 sid。多面板下地址栏跟**最近活动过的主面板**
  （`lastMainKey`），子会话面板是临时观察窗，不写地址栏 —— 否则刷新回来只剩一个
  已过期的子槽空壳。`prompt` 建会话后立刻从 query 删除，否则过期重建会把旧任务再跑
  一遍。主面板布局另存 `agentcli.panels.${host}.${projectId}`：只存有 sid 的主面板
  `{profile,sid,prompt}` + `activeSid`（200ms 防抖），刷新时 URL 的 sid 命中布局就
  整体还原、没命中按分享链接单开；`关闭全部` 清布局；子面板不持久化。
- **「重开」按钮语义**：`status==='offline'` 回原会话（Shift+点击新开）；主会话 `ended`
  若为交互 agent 且 `resumable`，走**续会话**：`SessionPanel` 传 `resume: true`，
  `usePty` 先记旧控制台 sid、清本地 sid，再以 `resume_from=<旧 sid>` 新连接
  （不再重发旧 prompt，否则同一句话跑两遍）；服务端查
  `sessions.recall_agent()` 后用 `--resume` 起同一段上下文。Shift+点击仍强制新开。
  非 resumable 的 headless 主会话 `ended` 仍视为「用同一任务再跑一次」。
  委派子会话 `ended` 时改走 `rerun`：`usePty` 在 query 里带 `rerun=1`（sid 不变、
  不落状态），服务端 `delegation.rerun(child_sid)` 取该槽最近一条委派任务原样再派
  一轮（`dispatch(..., force=True)`，失败回 `rerun-error`）。
  `usePty` 在 `close 1000` 时**保留 sid**，房间条才能认出已结束面板；重连前先
  `term.reset()`，避免旧内容和回放重叠。
- **项目体系**：`console/models.py:Project` 维护台账（name/path/agent/enabled），
  `console/projects.py` 负责播种、查询、路径拼接。`CONSOLE_PROJECTS_ROOT` 是总目录，
  未选项目时守门根 = 总目录；进入项目后 `files.resolve(rel, project_id)` 收窄到项目根。
  WS 协程里不能直接碰 ORM —— 用 `projects.get_project_async()`（`sync_to_async`
  包一层）取纯内存快照，再传给纯函数 `_resolve_spec`。
- **agent 适配器层**：`console/agents/`。`base.Adapter` 声明 `kind`（shell/agent）、
  `interactive`（是否原生 TUI）、`build_argv(base, prompt, mode, sid)`、
  `env()`（子进程额外注入的鉴权/覆盖变量）、`parse_line()`（JSONL → 归一化事件）；
  `registry` 按 profile 取适配器。`mode="interactive"` 走原生 argv（claude 位置参数、
  codex 裸 `codex`、qwen `-i`，均带 `bridge.*_flags(sid)` 注入 MCP），
  `mode="headless"` 走 `-p/exec` + JSONL。`stub` 的 `interactive=False`。
  统一事件：`system/text/tool/result/error`，`tool` 带
  `tool/file/action(read/write/exec)`。shell 适配器直通不解析；交互态不解析。
- **鉴权现状（临时接线）**：本机走 cc-switch / new-api 本地反代。claude、qwen
  读各自 `settings.json` 的反代段；codex 启动期只查 `OPENAI_API_KEY` 环境变量、
  不回读 `auth.json`，由 `CodexAdapter.env()` 从 `~/.codex/auth.json` 取出注入
  子进程。**未来债**：反代地址、key、模型、权限档位、env 覆盖都要做成各 agent
  独立配置页，不再硬读本机文件。
- **权限档位（固化在 headless argv）**：claude `--permission-mode acceptEdits`；
  codex `--sandbox workspace-write`；qwen `--approval-mode auto-edit`。headless
  下要自动放行文件编辑，否则工具被拒、样本采不到写事件。**交互态不设这些档位**，
  权限弹窗由 CLI 自己出（claude 用 `--allowedTools` 只预放行外包工具）。
  探针 `scripts/probe_agents.py`（`--suite broad` 一轮打全类型），样本
  `.event-sample/*.jsonl` 与 `probe2/`。
- **多工具块解析**：一条 assistant JSONL 可能挂多个工具块，基类 `parse_events()`
  返回列表，`terminal._parse_agent_stream` 批量出事件；`parse_line()` 只回首条
  兼容旧调用。工具归类集合在基类 `READ/WRITE/EXEC_TOOLS`，含 PascalCase 与
  snake_case 两套命名。
- **联网边界**：new-api 内置 `web_lookup` 只服务它自己的控制台 assistant，
  不透传给外部 CLI；CLI 联网要么靠渠道原生 `web_search`，要么靠 CLI 自带
  fetch（如 qwen `web_fetch`）。实测 claude 的 `WebSearch` 在 acceptEdits 档位下
  仍需单独权限放行。
- **目录树联动**：`terminal._parse_agent_stream` 按行喂适配器，工具事件记入
  `Runtime.file_events`（rel 路径 → {read, write}），经 `_Watcher.on_event` 推
  `agent-event` 文本帧；重连时回放 `file-events` 帧。前端 `fileMarks` 合并标记，
  目录节点按 visited（蓝，读过）/ modified（黄，改过）上色。路径在服务端按
  `runtime.cwd` 归一为项目内相对路径。样本在 `.event-sample/`（三 agent 真实
  JSONL），改解析器后用它回测。
- **多会话 / 委派底座（进行中）**：注册表是 `sid -> Session` 字典，进程内可多开；
  `Runtime` 带 `parent_sid/role(main|child)/label`，WS query `parent=<sid>` 派生
  子会话；`watchers` 是观察者列表（多标签/回灌共用），输出、事件、EOF 广播给
  全部观察者；`registry.children(parent_sid)` 查子会话；`GET /api/sessions/` 出
  会话快照。委派工具（Task/agent/send_message 等）归类为 `delegate`，事件带
  `target`（目标代理名）。
- **委派总线（`console/delegation.py`）**：父会话解析出 `action=delegate` 事件后，
  `dispatch()` 在**注册表里找/建一张子槽**（`role=child`、`parent_sid` 指向父会话、
  `pinned=True`），再在槽里拉起一代 PTY 子进程（任务描述走 argv，非交互模式）。
  子槽输出同样过 `terminal._parse_agent_stream`，它自己抛的 delegate 事件会再接住
  派给下一级 —— a→b→c 是真实链路，不再是台账串联。子进程 EOF 由挂在槽上的
  `_ChildWatcher` 收口：取 result、等 `child_id` 收口、合并回执、`delegate-result`
  帧逐级回灌；台账 `Delegation`（pending/running/done/failed，带 `child_sid`/
  `depth`/`child_id`），`GET /api/delegations/` 可查。120s 超时、输出 256KB 截断、
  链路最多 4 级。
- **子槽生命周期**：进程跑完即退，但**槽常驻** —— sid、父子关系、委派 id 留在
  注册表里，下一个任务复用同一张槽（`spawn_into_session` 换一代进程）。这样同一
  父会话、同一 profile/目标的多个任务 child_sid 不变，链路身份才不会断。槽被
  `pinned`，不参与空闲回收；父会话收尸时 `_Session.shutdown()` 级联清理。
  **父会话回收时限**：死父会话默认 `DEAD_TTL=30s`，但名下还有 `pinned` 子槽时用
  `DEAD_TTL_WITH_CHILDREN=300s` —— 否则一回收就把子槽连同前端可点开的子面板
  一起带走（前端拿到 `session-missing` 会误当过期、另起空会话）。
- **回执晚到**：父进程一轮跑完往往先于外包回执退出。`_Watcher.on_eof` 会先查
  `delegation.pending_for(sid)`：还有没交回执的任务就只推 `session-eof` 帧、把
  socket 留着，全部收口后再 close —— 否则晚到的 `delegate-result` 会被一起切断。
- **单 agent 串行 + 常驻**：`Runtime` 带 `busy/busy_kind(user|delegate)` 与
  `outsourcing` 开关；`mark_busy()` 已忙则拒绝，一个 agent 同一时间只做一件事，
  用户任务与外包活互斥；忙会话不被空闲回收。外包模式未开启时 `dispatch()` 直接
  拒绝。WS 控制帧 `outsourcing {on}` 切开关；首帧与 `/api/sessions/` 都带
  busy/busy_kind/outsourcing。前端有「外包模式」开关与房间成员状态条（待命/干活中/
  外包中），回执以 `delegate-result` 帧写进当前终端。
  **链式外包**：子槽自己抛的 delegate 事件被 `_parse_agent_stream` 接住后派给
  下一级；`Runtime.delegation_id` 记录本槽当前挂的任务，`_link_parent` 据此把下级
  任务登记为上一级的 `child_id`，收口时等下级并合并回执，逐级上墙（a→b→c 已桩测
  通过，且用真实 claude 子槽验收过一次）。
  **忙锁只守 headless**：`Runtime.busy/busy_kind`，`dispatch()` 派发前查目标槽忙否
  （忙则台账记 failed 并回灌原因）；用户往 **headless** 会话喂字节时，若该会话正在
  跑外包活（`busy_kind=delegate`）则拒收并回 `input-rejected` 帧，中断键
  （Ctrl-C/D/Z/Esc）放行；带初始任务的 headless 会话从启动即 `busy=user`，
  result/EOF 释放。**交互态 `_accept_user_input` 直接放行**：输入就是聊天，不认领
  busy、也不产生 `input-rejected`。
  **回执进上下文**：已由 MCP 解决 —— 交互 agent 主动调 `delegate_task`，回执作为
  tool result 回到它自己的上下文（`console/bridge.py` + `scripts/mcp_delegate.py`）。
  前端多面板/派任务入口已在 P3 落地（见「前端工程」与「前端规范」）。CLI 内部
  子代理与底座独立子进程是两回事。
- **MCP 外包桥（`console/bridge.py` + `scripts/mcp_delegate.py`）**：交互态没有
  JSONL/`Task` 事件可解析，委派改由 agent 主动调用。`bridge` 持有进程内 `TOKEN`、
  每次 WS 连接按实际端口回填 `BASE_URL`，`mcp_config(sid)` 生成 stdio server 配置；
  `claude_flags` / `qwen_flags` / `codex_flags` 把配置和中文 `DELEGATE_PROMPT`
  注入原生 argv。`mcp_delegate.py` 用 stdin/stdout 逐行 JSON-RPC（`initialize` /
  `tools/list` / `tools/call` / `ping`），`delegate_task(target, prompt,
  timeout_seconds)` 转 `POST /api/delegate/`（校验 `X-Agentcli-Token`）；视图要求
  父会话 `outsourcing=True`，调 `delegation.dispatch(..., profile=父的 profile)` 后
  `wait_task()` 等 done/failed，把 `reply` 作为 tool result 返回。claude/qwen 用
  `--allowedTools` 预放行 `mcp__agentcli__delegate_task`，避免卡在外包工具的权限弹窗
  （其它工具仍原生确认）。codex 无 allowedTools 等价开关，走原生 MCP 审批。
  `TOKEN`/`BASE_URL` 是进程内单例，多 worker 会失效；只适合本机单用户。
- **身份映射与续会话（M2）**：控制台 sid 是主身份，`Runtime.agent_sid` 存 CLI 自己
  的 session id，`Runtime.resumable` 标记能否续。新交互会话由 `_spawn` 生成 UUID →
  claude `--session-id`；重开查 `sessions.recall_agent(旧控制台 sid)` 后 `--resume`，
  两个参数互斥。身份表在会话回收后仍保留（上限 512 条）。qwen/codex 当前
  `resumable=False`。**SessionStart hook 会回报 CLI 权威 session_id**，`/api/hook/`
  收到后校正 `runtime.agent_sid` 与身份表，避免交互 TUI 不采纳 `--session-id` 时
  续错会话。外包默认：交互主会话开、headless 关、子槽继承父；前端始终传 `1/0`。
- **hooks（claude 交互态）**：`bridge.hook_settings(sid)` 用 `--settings` 内联 JSON
  注册 `SessionStart`（回报 session_id）与 `PostToolUse`，命令跑
  `scripts/hook_event.py`，把 `hook_event_name/session_id/tool_name/tool_input`
  POST 到 `/api/hook/`（同样校验进程内 token）。端点只校正身份、记文件访问并向
  观察者推 `agent-event`，不动权限、不阻塞会话；hook 脚本任何失败都静默退出。
  qwen 尚未接 hooks，codex 无等价钩子——这两者在交互态仍没有目录树标色。
- **profile 白名单**：`CONSOLE_PROFILES` 表决定能拉什么，URL 上是
  `/ws/terminal/?profile=bash&project=3`。只认表里的键，query 不会变成任意命令。
  `available_profiles()` 会探测 PATH（含 `~/.local/bin` 兜底）并回 `interactive`，
  前端只显示存在的项。
  会话结束时必须确认进程真的死了 —— agent 是 node 程序，常自己接管 SIGHUP，
  只发信号不 `waitpid` 会攒一屏僵尸。
- **踩过的坑（改这块务必注意）**：
  - ASGI 规范要求 `accept` 之前先 `receive()` 掉 `websocket.connect` 那一帧。漏掉它，
    它会排在接收队列里被第一条 `receive()` 取出来，表现为"客户端一连上就断开"。
  - TIOCSWINSZ 会顺带发 SIGWINCH，不用手动 kill。
  - `pty.fork` 的子进程分支必须 `os._exit`，不能 return 回 asyncio。
  - ASGI lifespan 的 startup 里直接查 ORM（`projects.seed_from_disk()`）会抛
    `SynchronousOnlyOperation`；uvicorn 判定整个 lifespan 不受支持后静默降级，
    回收扫描器跟着永远起不来（日志只有一行 `lifespan protocol appears unsupported`）。
    必须 `sync_to_async(...)()` 包一层。
  - `claude -p`（headless）没有 prompt 且 stdin 为空会报
    `Error: Input must be provided either through stdin or as a prompt argument` ——
    它只认管道 stdin 或 argv 里的 prompt。**交互 TUI 不带 prompt 是正常的**，空着
    开会话就进原生输入；headless 才必须把任务写进 argv。别再一刀切假设「agent
    会话必须带任务才能起」。
  - 关 PTY 前必须先 `remove_reader` 再 `close(fd)`（`close_pty` 里已经做了），
    selector 上留着已关闭的 fd 会一直报错。
- **目录树**：`console/files.py:resolve(rel, project_id)` 是唯一路径守门员（`..` /
  绝对路径 / 外部软链三种越界都在这挡），边界随是否进入项目切换。`/api/files/`
  一次只返一层，前端展开时才请求。
- **前端工程**：`frontend/`（React 19 + TS + Tailwind 4 + Vite 8 + xterm 6），构建到
  `static/dist/`。Django 模板只有 17 行 —— 一个 `#root` 挂载点 + `json_script` 注入
  的 bootstrap，界面全在 React 里。`console/vite.py` 读 manifest 拿到带 hash 的资源名。
- **多面板架构**：`App.tsx` 维护 `panels: Panel[]`（key / profile / initialSid / sid /
  prompt / meta），`WorkspaceBar` 是会话入口（profile 下拉 + 任务输入）；
  **交互 agent 可空任务「开会话」**，headless agent 仍必填「派任务」。`SessionPanel`
  一个面板一份 `usePty` + 一个 xterm，`RoomBar` 列出房间会话并**可点击开面板**
  （子槽 `↳ label`，带 `#sid尾号`）。一个面板 = 一条 WS = 一个前台进程；关面板只关
  观察者，后端会话继续跑（可再点开）。面板上限 6，`panel-grid` 按数量切 1/2/3 列。
- **首帧缓冲**：终端实例在 `useEffect` 里建，WS 的 `session` 帧/回放字节可能先到。
  `SessionPanel` 用 `pendingWrites` 先攒、`term.open` 后补写 —— 短命 agent 会话
  （桩、一问一答）不会再留下空面板。
- **静态资源**：没有 runserver 了，`agentcli/urls.py` 在 DEBUG 下用 `static()` 提供。
  xterm 走 npm 包（`@xterm/xterm` + addon-fit + addon-webgl），不再手工 vendor。
- **字体**：客户端字体，服务端管不着。字体栈首位必须是汉字宽度 = 2 倍西文的等宽字体
  （Sarasa Term SC Nerd），否则中文会 fallback 到比例字体显瘦。换字体时注意
  `fontSize` 要跟着调 —— Sarasa 的西文比 JetBrains Mono 窄，13px 会显得过密，14px 合适。
- **旧执行层**：`console/agent.py` 的 `execute(raw) -> {"ok", "lines"}` 仍在，服务
  `POST /api/command/`，作降级/自动化通道，与 PTY 通道并存。
- **配置**：`CONSOLE_PROFILES`（能拉起来的程序白名单，键是 URL 里的 `profile`）、
  `CONSOLE_SHELL_PROFILE` / `CONSOLE_DEFAULT_PROFILE`（默认 `bash`）、
  `CONSOLE_PROJECTS_ROOT`（总项目目录）、`CONSOLE_ROOT`（单项目兜底根）、
  `CONSOLE_TREE_LIMIT`（单层上限 400）。会话回收时长在 `console/sessions.py`
  顶部常量（`IDLE_TTL` / `DEAD_TTL` / `DEAD_TTL_WITH_CHILDREN` / `REPLAY_LIMIT`）。
- **初始任务、模式与外包开关的 URL 参数**：`/ws/terminal/?profile=claude&prompt=...&mode=interactive&outsourcing=1`。
  `mode` 仅对 agent 且值合法时生效，否则按 `adapter.interactive` 取默认（stub 为
  headless）。`prompt` 交互态可省（原生 TUI 等输入），headless 必填。建会话时就把
  外包开关打开，因为带任务启动可能立刻触发委派，前端那帧 `outsourcing` 控制消息
  来不及。前端入口把这几项拼进 query；`prompt` 即使带了 `sid` 也一直拼着，会话过期
  重建时能复用同一任务（交互态重开则是空任务进 TUI）。
- **子会话重跑参数 `rerun=1`**：只与 `sid` 一起出现，表示「这个槽已 eof，用上一轮
  委派任务原地再跑一次」。服务端在 `sid` 分支里看到 `eof && role=='child'` 才进
  `delegation.rerun()`；成功就把 `session` 帧/回放照常走，失败回 `rerun-error` 后
  `close 1000`。活会话带 `rerun` 不特殊处理，前端也只在本次连接拼这一位，不落状态。
- **测试桩**：`CONSOLE_ENABLE_STUB=1` 时 settings 才登记 `stub` profile（跑
  `scripts/stub_agent.py`，不调模型、不联网，按 prompt 吐 stream-json）。
  `scripts/check_delegation.py` 自己起 8011 端口的 uvicorn 跑全套桩测；测试桩的
  `Task` 目标名写 `stub` 或真实 profile（`claude:` 分支可验收真 claude 子槽）。

## 前端规范

先读这一节再改 `frontend/` 下任何东西。目标只有一个：**任何一个文件都能被单独读懂**，
不需要先浏览一遍别的文件。

- **分层别越界**
  - `components/` 只拿 props 画界面，不 fetch、不读 localStorage、不碰全局状态
  - `hooks/` 管副作用与数据（`usePty` 连接、`useFileTree` 目录、`useRoom` 快照）
  - `lib/` 是无副作用的纯函数和第三方封装（格式化、xterm 构造）
  - `App.tsx` 是唯一的状态编排处：项目、会话、文件标记、布局尺寸都在这里
- **状态归属**：跨组件共享的放 App；只影响自己的（比如某个目录展开没展开）留在组件内。
  不要为了少写两个 props 就上 Context —— 现在层级只有两层。
- **契约在 `types.ts`**：改字段就同步改 Django 那侧的 JSON，两边一起提交。
- **一个面板一条 WS**：`SessionPanel` 是唯一持有 `usePty` 的地方，一个面板对应一条
  连接、一个 xterm、一个前台进程。跨面板共享的东西（stub 统计、handle 表、活动
  key）留在 `App.tsx`，不要塞进 hook 或 Context —— 面板之间不互相读。
- **回调传 props 时注意**：`SessionPanel` 用 ref 存回调再进 effect。父组件传内联函数
  会让引用每次都变，直接进依赖数组会把终端反复销毁重建。
- **面板关闭 ≠ 杀会话**：`closePanel` 只是摘掉前端观察者，后端进程继续跑；再次点开
  同一 sid 会先回放缓冲。要终止进程请走重连后的终端输入。
- **布局持久化只在 App 里做**：`readLayout`/`saveLayout`（`layoutKey(projectId)`）
  读写 `agentcli.panels.${host}.${projectId}`，只存主面板，子面板是观察窗不落盘；
  不要把这个逻辑挪进组件或 hook。
- **验证终端内容先看页面可见性**：`document.visibilityState === 'hidden'` 时 rAF
  被节流，xterm 的 DOM 渲染器不刷新，`.xterm-rows` 会全空但 buffer 有内容；这是
  工具侧假象。验证必须在前台可见标签页，并读 `.xterm-rows` 而不是整页文本（后者
  混入 `.xterm-char-measure-element` 的假重复字符）。
- **样式只写 Tailwind 类**，颜色走 `@theme` 里的 token（`bg-panel`、`text-dim`、`border-line`），
  不要在组件里散落 `#0d1117` 这种字面量。伪元素、媒体查询这类写不进 class 的，
  放 `styles.css` 的 `@layer components`。
- **命名**：组件 PascalCase、hook 用 `use` 前缀、布尔量用 `is/has/show` 开头。
- **注释解释为什么**，不解释做了什么。`// 摘掉 onclose，否则旧连接会触发重连` 有用；
  `// 设置 socket` 没用。

提交前跑 `cd frontend && npm run typecheck && npm run build`：Django 模板只引
`static/dist/` 的 manifest 产物，只 typecheck 不 build，页面跑的还是上一版。

## 注意

这是把 RCE 接到了浏览器上：谁拿到 `/ws/terminal/` 谁就有本机 shell。目前只绑 127.0.0.1、
`DEBUG=True`、`SECRET_KEY` 硬编码。加鉴权之前不要暴露到公网。
