# agentcli 交接文档

> 交接时点：2026-11-17。本文档记录当前实现状态、已验证结论、未打通的缺口和
> 下一步优先级。代码事实以本地仓库为准；`CLAUDE.md` 是架构/踩坑备忘，本文档是
> 进度与待办快照。

## 1. 项目是什么

把命令行 agent（claude / codex / qwen）搬进浏览器的 Web 控制台：Django + ASGI
（uvicorn，必须用 uvicorn 才有 WebSocket），PTY 承载进程，WebSocket 原样搬运字节。

**形态是双轨（B 路线，2026-11-17 拍板）**：
- **主面板**：知名 agent 保持**原生交互体验**（多轮、上下文、权限弹窗、slash 命令），
  控制台只做外壳，不解析它的 ANSI；
- **委派子槽**：headless（`-p / exec`）承载机器派活，JSONL 归一化成事件，驱动
  台账、回执、目录树标色；
- **外包模式**是主打功能：MCP 把 `delegate_task` 暴露给交互态 agent，由 agent 自己
  判断或被用户告知后**主动调用**；回执作为 tool result 回到它自己的上下文。

结构化事件只在 headless 路径保证，**不为拿事件牺牲 agent 的原生体验**。

- 项目根（WSL）：`/home/xylitol/projects/agentcli`
- 运行：`.venv/bin/uvicorn agentcli.asgi:application --host 127.0.0.1 --port 8010`
  （8000 被 Windows 代理占用，勿用；日志 `/tmp/agentcli-uvicorn.log`）
- 环境：Python 3.14.4，Django 6.1.3，uvicorn[standard] 0.54.0，websockets 17.4
- 执行环境：Windows 本机 PowerShell，WSL 命令经 `wsl -d Ubuntu -- bash -lc '...'`；
  Bash 工具在本机禁用。

## 2. 目录与模块

```
console/
  sessions.py    会话注册表（进程内单例）：Runtime 状态、观察者列表、回收扫描
  terminal.py    PTY 生命周期、WS 入口、事件流解析、控制帧处理
  delegation.py  委派总线：派生子任务、台账、链式外包、回执回灌、wait_task
  bridge.py      交互态编排桥：MCP 配置/token/BASE_URL/系统提示，注入三个 adapter
  views.py       HTTP 视图：页面、项目/会话/委派快照、命令降级接口、/api/delegate/
  urls.py        路由
  files.py       目录树读取与路径越界守门
  projects.py    Project 台账播种/查询（ORM，WS 里走 sync_to_async）
  models.py      Project 模型
  agent.py       旧的一问一答演示运行器（非 PTY，降级用）
  agents/
    base.py      Adapter 基类 + Event 结构 + 工具归类集合
    claude.py / codex.py / qwen.py  各 agent 适配器
    stub.py      测试桩适配器（不调模型，只解析桩输出）
    registry.py  profile -> Adapter 注册表
    shell.py     bash 直通适配器
  templates/console/index.html  Vite 挂载壳（#root + json_script 注入 bootstrap，17 行）
frontend/          React 19 + TS + Vite 8 + xterm 6 前端（构建到 static/dist/）
  src/App.tsx      唯一状态编排处：项目、多面板、文件标记、布局
  src/components/  SessionPanel（一会话一终端）/ WorkspaceBar（派任务+房间条）/
                   RoomBar / FileTreePane / Splitter / Header / StatusBar
  src/hooks/       usePty（一条 WS = 一个前台进程）/ useRoom / useFileTree
  src/lib/         terminal（xterm 构造）/ format
static/dist/       Vite 产物（manifest + 带 hash 的 js/css）
console/vite.py    读 .vite/manifest.json，给模板注入带 hash 的资源名
scripts/
  check_session.py  会话保持回归（8 项）
  check_terminal.py  终端/目录回归（8 项）
  check_delegation.py 委派链路桩测（a→b→c/忙锁/槽复用/交互态直通，自起 8011）
  probe_delegation.py 人工验收（真实 claude 子槽，少量额度）
  mcp_delegate.py   stdio MCP server：把 delegate_task 转接 /api/delegate/
  stub_agent.py     测试桩 agent（stream-json 假输出）
  smoke.py          冒烟（越界 403 等）
  probe_agents.py   能力探针（basic / --suite broad）
.event-sample/     三 agent 真实事件样本（basic 与 probe2/ broad）
```

## 3. 已落地并验证的能力

### 3.1 会话保持（已完成）
- 会话挂在注册表 `sid -> Session` 上，不挂连接；断连只摘观察者，进程继续跑。
- 带 `sid` 重连回放环形缓冲（`REPLAY_LIMIT=256KB`）再接管实时流。
- 进程退出进 `dead`，留 `DEAD_TTL=30s` 回看；**带常驻子槽的父会话放宽到
  `DEAD_TTL_WITH_CHILDREN=300s`**（否则级联清子槽，子面板没得看）；空闲
  `IDLE_TTL=300s` 回收，扫描周期 `SWEEP_INTERVAL=30s`。
- **URL 只记主面板，布局单独落 localStorage**：地址栏跟最近活动过的主会话
  （`prompt` 建会话后即从 query 删除）；子会话面板是临时观察窗，不写 URL、也不
  进布局。`localStorage` 的兜底 sid 连 profile 一起比对，防止跨 profile 接错。
- **多面板布局持久化（P3 收尾）**：key 为 `agentcli.panels.${host}.${projectId}`，
  只存主面板（必须已有 sid）的 `{profile,sid,prompt}` 数组 + `activeSid`，200ms
  防抖写入；刷新时若 URL 的 sid 在布局里就整体还原并把 active 定到它，不在就按
  「分享链接」单开一个。`关闭全部` 同时清布局。子会话面板不持久化。

### 3.2 项目体系（已完成）
- `Project` 模型（name/path/agent/enabled/note）；总目录 `~/projects`，进来先选
  项目，选定后终端与目录树限定在项目内；两层路径守门在 `files.py`。

### 3.3 适配器与目录树联动（headless 路径）
- 每个适配器有 `interactive` 标记：claude/codex/qwen 为 `True`，`stub` 为 `False`。
  `build_argv(base, prompt, mode, sid)` 两套 argv：
  - **interactive**（主面板默认）：claude `claude + MCP flags + [prompt]`；
    codex `codex + MCP flags + [prompt]`；qwen `qwen + MCP flags + ["-i", prompt]`
    （qwen 的位置参数是 one-shot，必须 `-i`）。不带 prompt 时就是原生 TUI。
  - **headless**（委派子槽、stub）：claude `-p --output-format stream-json --verbose
    --permission-mode acceptEdits`；codex `codex exec --json --skip-git-repo-check
    --sandbox workspace-write`；qwen `-o stream-json --approval-mode auto-edit -p`。
- **JSONL 解析只在 headless 生效**：`_parse_agent_stream` 见 `runtime.mode !=
  "headless"` 直接返回，交互 TUI 的 ANSI 不进事件流。
- 一条 JSONL 挂多工具块时 `parse_events()` 批量出事件；工具归类 read/write/exec，
  PascalCase 与 snake_case 两套命名。
- 工具事件记入 `Runtime.file_events`（rel 路径 → {read, write}），WS 推
  `agent-event` / `file-events` 帧；前端标蓝（读过 visited）/标黄（改过 modified）。
  路径在服务端按 `runtime.cwd` 归一为项目内相对路径。**交互面板没有 JSONL，但
  claude 用 `PostToolUse` hook 补了同一条 `agent-event` 通道（见 §3.6）；qwen/codex
  暂无等价钩子，这两者的面板不标色。**
- 鉴权注入：codex 启动期只查 `OPENAI_API_KEY` 环境变量、不回读 `~/.codex/auth.json`，
  由 `CodexAdapter.env()` 注入；claude/qwen 读各自 settings.json 的反代段。

### 3.4 多会话 / 委派（本轮完成 P0+P1）
- `Runtime` 字段：`profile/kind/cwd/parent_sid/role(main|child)/label/
  delegation_id/depth/pinned/watchers(list)/busy/busy_kind(user|delegate)/outsourcing`。
- 观察者从单字段改列表：`attach/detach` 按实例增删；输出、事件、EOF 广播全部观察者；
  回收判断 `not watchers`，`pinned` 的会话不参与空闲回收。
- 派生入口：WS query `parent=<sid>` 派生子会话，标 `role=child`；`registry.children()`
  查子会话。首帧 `session` 回传 sid/profile/role/parent/label/depth/busy/busy_kind/
  outsourcing。
- 委派事件：`Event.target`；`DELEGATE_TOOLS`（Task/agent/SendMessage/ListAgents/
  TaskStop 及 snake_case）归类 `action=delegate`；claude 取 `subagent_type/agent`，
  qwen 取 `agent/name/recipient`。
- **委派总线 `delegation.py`（P0 已落地）**：
  - `dispatch()` 不再拉一次性子进程，改为在订单注册表里**找/建常驻子槽**
    （`role=child`、`parent_sid`、`label`、`depth`、`pinned=True`），再在槽里拉起
    一代 PTY 子进程（复用适配器 `build_argv/env()`，任务描述进 argv）；
  - 子槽输出同样过 `terminal._parse_agent_stream`，它自己抛的 delegate 事件被再
    接住派给下一级 —— **a→b→c 是子进程自决的真实链路**，不再只是台账串联；
  - `_ChildWatcher` 挂在子槽上收 EOF：取 result、`_wait_child(child_id)` 等下级、
    合并回执、`delegate-result` 逐级回灌；
  - 槽复用：同一父会话 + 同 profile + 同目标的多个任务共用一个 `child_sid`
    （`spawn_into_session` 换一代进程，sid/父子/委派 id 不变）；父会话收尸时
    级联清理子槽；
  - 台账字段补 `child_sid/depth/child_id`；`DELEGATE_TIMEOUT=120s`、
    `OUTPUT_LIMIT=256KB`、`MAX_CHAIN=4` 级。
- **忙锁（P1 已落地，仅 headless）**：
  - 派发前查目标槽 `is_busy()`，忙则台账记 `failed`（原因「目标会话忙」）并回灌；
  - 用户往 **headless** agent 会话喂字节时，若 `busy_kind=delegate` 则拒收并回
    `input-rejected` 帧（Ctrl-C/D/Z/Esc 放行）；
  - **交互态不设这道锁**：`_accept_user_input` 见 `mode != "headless"` 直接放行，
    输入就是聊天，不认领 busy、也不产生 `input-rejected`。
  - 带初始任务的 headless 会话启动即 `busy=user`；`result` 事件 / EOF 释放。
- **初始任务入口**：`/ws/terminal/?profile=claude&prompt=...&outsourcing=1`。
  `mode` 可由 query 显式指定（仅 agent 且值合法），否则按 `adapter.interactive`
  取默认。**交互 agent 可以不带给首条消息直接开会话**（原生 TUI 等输入）；
  headless（stub）仍必须带任务。
- **回执晚到**：父进程 EOF 时若名下还有未收口的委派，`_Watcher.on_eof` 只推
  `session-eof` 帧并保留 socket，全部收口后再 close；否则晚到的 `delegate-result`
  会被切断。
- HTTP 接口：`GET /api/projects/`、`GET /api/sessions/`（含 role/parent/label/
  depth/pinned/delegation/busy/busy_kind/outsourcing）、
  `GET /api/delegations/?parent=<sid>`、`GET /api/files/`、`POST /api/command/`（需 CSRF）。

### 3.5 前端现状（P3 完成）

- 技术栈已从内联 JS 迁到 `frontend/`（React 19 + TS 7 + Vite 8 + Tailwind 4 +
  xterm 6），Django 模板退化成 17 行挂载壳；**改完必须 `npm run build`**，页面
  走 `static/dist/` 的 manifest。
- **多面板（一会话一终端）**：`App.tsx` 维护 `panels: Panel[]`（key/profile/
  initialSid/sid/prompt/meta），`SessionPanel` 每个面板一份 `usePty` + 一个 xterm；
  面板右上角 `#sid尾4位`、连接状态、重连/关闭；`panel-grid` 按面板数切 1/2/3 列
  （窄屏单列），上限 6 个（WebGL 上下文与终端实例都要省着用）。
- **父子关系与子会话看屏**：`RoomBar` 是按钮不是旁观条，点一下打开/切到该 sid 的
  面板；子槽显示 `↳ label` + `#sid`，title 带 `父 <sid短>`；已 `eof` 的会话也保留
  （置灰「已结束」），点开可看它最后一眼输出，直到父会话回收（5 分钟）。
- **派任务入口**：`WorkspaceBar` = profile 下拉 + 任务输入框 + 「开会话/派任务/新终端」。
  **交互 agent 可空任务直接「开会话」**（进原生 TUI，占位文案注明可空）；headless
  agent（含 stub）仍必填，按钮文案「派任务」并提示「只支持一次性任务」；shell 只给
  「新终端」。`usePty` 把 `prompt` 与 `outsourcing=1` 拼进 WS query（外包开关赶在
  第一行输出前就位）；`Ctrl+Enter` 提交。原来只能手拼 URL `&prompt=` 的入口现在有界面。
- **首帧缓冲**：终端实例在 effect 里建，WS 回放/首屏字节可能先到 —— 先攒
  `pendingWrites`，`term.open` 后补写，短命会话不会留下空面板。
- **文件联动 / 外包回执 / 忙锁拒绝**：仍是每个面板就地写终端（蓝/黄标色走全局
  `fileMarks`，回执与 `input-rejected` 写在发起面板里）。
- **形态标注**：`usePty` 从 `session` 帧取 `mode`，agent 面板头显示「交互 / 无头」
  小标签（shell 不显示），悬停有说明；接回旧会话时随首帧自动恢复。
- **布局持久化**：主面板的 profile/sid/prompt 与 activeSid 落 localStorage，刷新
  或重开项目按原样还原；URL 带一个布局里没有的 sid（分享链接）时只单开它。子会话
  面板是观察窗，不持久化。
- **「重开」语义**：离线时回原会话（Shift+点击新开）；主会话已 `ended` 则视为
  「再开一代」——先 `term.reset()` 擦画面再 `fresh` 重连，避免只回放旧缓冲。
  **交互 agent 正常重开 = 续 CLI 自己的会话**（带 `resume_from=<旧控制台 sid>`，
  服务端查身份表后用 `--resume`；Shift+点击才是全新会话）；headless agent 必须
  还有任务才能重开。续上下文时不再重发面板里的旧 prompt，否则同一句话会跑两遍。
  **委派子会话**已 `ended` 时改为带 `rerun=1` 接回同一张子槽：服务端
  `delegation.rerun()` 找该槽最近一条委派任务，用同一 prompt 再派一轮（sid / 父子
  / 槽身份不变，只换一代进程）。`usePty` 在 `close 1000` 时保留 sid，房间条才能
  认出已结束面板。
- 已知边界：没有委派台账的普通子会话（WS `parent=` 手动派生）没有「重开」；
  WebGL 在多面板下若上下文丢失会自退到 DOM 渲染。

### 3.6 交互态 + MCP 外包桥（M1 / M3a 已完成）

- **主面板默认原生交互**：session 首帧带 `mode`（`interactive` / `headless`），
  `/api/sessions/` 与 `/api/profiles/` 也暴露 `mode` / `interactive`。
- **输入语义拆分**：交互态字节直通 PTY，多轮对话、`/` 命令、权限弹窗全归 agent；
  headless 仍是「任务入口 + 忙锁」。
- **MCP 桥 `console/bridge.py`**：
  - 进程内 `TOKEN`（`secrets.token_urlsafe`）+ `BASE_URL`（每次 WS 连接按实际端口回填）；
  - `mcp_config(sid)` 生成 stdio server 配置（`scripts/mcp_delegate.py --parent-sid <sid>`）；
  - `claude_flags` / `qwen_flags` / `codex_flags` 注入配置，并附中文系统提示
    `DELEGATE_PROMPT`（告诉 agent 工具存在、何时用、开关关闭会失败）；
  - claude/qwen 额外预放行 `mcp__agentcli__delegate_task`（其它工具仍走原生确认），
    codex 用 `-c mcp_servers.agentcli.{command,args,env}` 覆盖。
- **MCP server `scripts/mcp_delegate.py`**：stdin/stdout 每行一条 JSON-RPC；
  `initialize` / `tools/list`（一个 `delegate_task`，target/prompt/timeout_seconds）/
  `tools/call` / `ping`，未知方法回 -32601。`tools/call` 走
  `POST /api/delegate/`，把 `ok/reply/error/delegation_id/child_sid/profile` 转成
  MCP content text。**参数先在本进程校验**（target/prompt 非空、timeout 夹到
  5..300s），控制面 403/502 统一转 `isError: true` 的明确文本；单条坏请求由
  `main()` 兜住，stdio 循环不崩。桩测 `scripts/check_mcp.py` 覆盖初始化、工具列表、
  正常回执、空参数、403、未知工具/方法、缺 method 与 ping，不烧真实额度。
- **`/api/delegate/`**：校验 POST + `X-Agentcli-Token`；父会话 `outsourcing=False`
  回 403「外包模式未开启」；调用 `delegation.dispatch(..., profile=父的 profile)`，
  `wait_task()` 等 done/failed 后回填。`wait_task` 轮询 pending/running，
  超时 clamp 5..300s。
- **实测（真实 claude，sid `7169712384b34d70`）**：
  - 首轮 `OK`、次轮 `OK2`，同一 TUI 进程上下文延续；
  - 让 claude 调 `delegate_task(target=stub, prompt=leaf:mcp-ok)`，屏幕显示
    `Thought for 10s, called agentcli` → 回执 `leaf-ok:mcp-ok`；
  - 台账：`status=done`、`child_sid=8810ec8e0e31470b`、子会话 `role=child`、
    `mode=headless`、`eof=True`；服务端日志 `POST /api/delegate/ 200 OK`。
  - 注意：自动化往 TUI 发消息时，首个 `\r` 可能只落字不提交，**补发一次 `\r`**；
    人工在浏览器里按回车不受影响。
- **hooks 补文件树（claude 已接）**：`bridge.hook_settings(sid)` 用
  `--settings` 内联 JSON 注册 `PostToolUse`（matcher Read/Write/Edit/MultiEdit/
  NotebookEdit），命令是 `scripts/hook_event.py --sid --token --url`。脚本读 stdin，
  把 `tool_name/tool_input` POST 到 `/api/hook/`；端点按 `file_path` 归一成相对路径、
  记 `file_events` 并向所有观察者推 `agent-event`，前端照旧标蓝/标黄。hook 失败一律
  吞掉，不阻塞 TUI。**qwen hooks 未接，codex 无等价钩子**，这两条交互态仍不标色。
- 实测：真实 claude 读 `README.md` → 收到 `Read / README.md / read`；写
  `tmp_hook_probe.txt` → 收到 `Write / tmp_hook_probe.txt / write`（探针文件已删）。
- **三 agent 外包实测**：claude / codex / qwen 均成功调用 `delegate_task` 到 stub 子槽，
  回执分别 `leaf-ok:mcp-ok` / `leaf-ok:codex-mcp` / `leaf-ok:qwen-mcp`；codex 首次
  需过原生信任页并对 MCP 工具做一次原生审批，qwen 因预放行直接执行。
- **MCP 硬化后复测**：直接跑 `scripts/mcp_delegate.py` 对 8013 调
  `delegate_task(target=stub, prompt=leaf:mcp-polish)`，回执
  `外包完成 [stub · 8462087856594d33 · 8c9880e2a253] leaf-ok:mcp-polish`，
  协议层桩测 `scripts/check_mcp.py` 全绿。

### 3.7 M2 身份映射 + 续会话 + 外包默认（claude 已接）

- **身份主从**：控制台 sid 仍是主身份；`Runtime.agent_sid` 存 CLI 自己的 session id，
  `Runtime.resumable` 标明该会话能否续。`sessions.remember_agent/recall_agent` 维护
  `控制台 sid -> (profile, CLI sid)`，会话被回收后仍保留（上限 512 条），供重开查。
- **claude 参数**：新交互会话预分配 UUID → `--session-id <uuid>`；重开时
  `--resume <uuid>`（两者互斥，续会话不再传 `--session-id`）。qwen/codex 的
  `resumable=False`，参数照旧，暂不承诺续上下文。
- **SessionStart hook 校正身份**：实测交互 TUI 的权威 session id 以 hook 输入里的
  `session_id` 为准（`--session-id` 之外仍保留作为首选）。`hook_settings` 同时注册
  `SessionStart` 与 `PostToolUse`；`hook_event.py` 把 `hook_event_name/session_id`
  一并 POST，`/api/hook/` 收到后更新 `runtime.agent_sid` 并重写身份表。hook 仍然只
  是旁路，失败不影响会话。
- **重开链路**：`SessionPanel` 在 `ended` 且非 Shift、非子槽 rerun 时传
  `resume: true`；`usePty` 先记下旧控制台 sid，再以 `resume_from=<旧 sid>` 新建连接；
  `_resolve_spec` 查身份表补 `PtySpec.resume`；`_spawn` 在 sid 确定后拼
  `--resume`。找不到映射就正常新开，不报错。
- **外包默认**：原生交互主会话默认开（`spec.mode == "interactive"`），headless
  一次性任务默认关；显式 `outsourcing=1/0` 优先，子槽强制继承父会话。前端
  `outsourcing` 初始 true，并且**每次都传 1/0**（只传真值时用户关掉后重连会被
  默认值翻回来）。
- **实测**：交互 claude 首轮回复 `7391` 后退出，用旧控制台 sid 重开，CLI 进程带
  `--resume <uuid>` 回到同一段上下文并答出 `7391`；首帧 `resumable=true`。
  默认值探针：claude 无参 `outsourcing=true`、stub 无参 `outsourcing=false`。

## 4. 已验证结论（探针实测，样本在 .event-sample/）

| 能力 | claude | codex | qwen |
|---|---|---|---|
| 读文件 | Read | shell cat | read_file |
| 整文件写 | Write | shell printf> | write_file |
| 编辑 | Edit | shell sed/perl | edit |
| 执行命令 | Bash | command_execution | 经 shell |
| 列目录/检索 | Glob/Grep | shell ls/find | glob/grep_search |
| 联网检索 | WebSearch 可调但需单独权限放行 | 无联网工具 | web_fetch（CLI 自带抓 DDG） |
| 委派工具 | Task/ListAgents/TaskStop | 无 | agent/list_agents/task_stop/send_message |

- new-api 内置 `web_lookup` 只服务它自己控制台 assistant，不透传给外部 CLI；标准
  渠道 `web_search` 是上游渠道原生能力，new-api 只计费透传。
- 低 token 原则：探针短 prompt、三行小文件、单轮，不重复长上下文（跑的是真实额度）。
- 非交互 agent 在 PTY 下的 JSONL 输出是干净的（`script -qec` 实测 claude/codex/qwen
  都是逐行 JSON，带 `\r`，`strip()` 即可），PTY 槽可以承载委派子进程。
- **委派链路（2026-11-17 实测）**：
  - 桩测 `scripts/check_delegation.py` 全绿（18 项）：a→b→c 三级子槽、链路
    `child_id` 闭环、槽复用 child_sid 不变、忙锁拒绝、任务入口忙锁；
  - 真实跨 agent 验收：桩父会话把 Task 派给**真实 claude 子槽**，回执
    `OK_CLAUDE_123`（`scripts/probe_delegation.py`）。

## 5. 未打通的缺口（按优先级）

### ✅ P0 常驻子代理会话槽（本轮完成）
子任务是**注册表里的常驻子槽**：PTY 承载、按任务换进程，sid/父子关系/委派 id
留在槽上；子槽输出照样过 `_parse_agent_stream`，它自己抛的 delegate 事件再接住
派给下一级。链式是子进程自决的真实链路，不是底座台账凑出来的。剩余细节：
`_finish()` 里给同轮 delegate 事件留了 0.3s 调度窗口（启发式，未做成同步登记）。

### ✅ P1 忙锁接到任务入口（本轮完成）
- 派发前查目标槽 `is_busy()`，忙则拒（failed + 原因回灌）；
- 用户喂字节时 `busy_kind=delegate` 拒收 + `input-rejected` 帧，中断键放行；
- 带任务的会话启动即 busy=user，result/EOF 释放。

### ✅ P2 回执回灌父 agent 上下文（已用 MCP 解）
旧路径：回执只作为事件帧推给前端上墙，不进父 agent 的 LLM 上下文；根因是父会话
也是一次性进程，退出后没有可写回的上下文通道。

2026-11-17 按 B 路线改写：**回执走 MCP tool result**。agent 在原生 TUI 里主动调用
`delegate_task`，`scripts/mcp_delegate.py` 把 `/api/delegate/` 的 `reply` 作为
tool result 返回给 agent，天然进入它自己的上下文——父 agent 不需要重启、也不需要
控制台替它记。实测 claude 收到 `leaf-ok:mcp-ok` 并在会话里原样复述。

### P2.5 `Task` 双跑（交互态已绕开，headless 仍需注意）
claude / qwen 的 `Task`/`agent` 工具在 CLI 进程内部**已经自己跑了一个子代理**，
底座又把同一个事件当外部派发，等于同一件活干两遍（父 agent 等的是内部结果，
底座回执只能上墙）。**交互态已改由 MCP 主动调用，不再解析 `Task` 自动派发**，
这条坑只对 headless 路径成立（headless 子槽仍按 `Event.target` 自动派发）。
可选解：
- 只用 `SendMessage`（跨会话消息）当委派信号，`Task` 仅观察不派发；
- 派发前判断目标是否等于本 CLI 内部子代理类型，命中就跳过；
- 给 CLI 关掉内部子代理（若支持），把委派完全交给底座。

### ✅ P3 前端多面板 + 派任务入口（本轮完成）
- 一个会话一个面板（`SessionPanel`），面板可并行、可切换活动面板；目录树点击
  写入当前活动面板；每面板独立显示 sid 尾号/状态/重连/关闭。
- 房间条可点击：主会话与子槽（`↳ label`）都能点开独立看屏；子会话面板标题带
  父 sid 短号。已退出的会话保留到父会话回收，点开可回看最后输出。
- 界面派任务：profile 下拉 + 任务输入 + 「派任务」；`prompt` 与 `outsourcing=1`
  在建会话时进 WS query；shell profile 只给「新终端」。
- 顺手补的两个缺陷：终端首帧字节先于 xterm 实例到达会丢（`pendingWrites` 缓冲）；
  带子槽父会话 30s 回收会级联清子槽（放宽到 300s）。
- 遗留边界：面板上限 6；没有委派台账的普通子会话（WS `parent=` 派生）没有「重开」。

### ✅ P3 收尾：布局持久化 + 「重开」语义（本轮完成）
- 主面板布局落 localStorage（`agentcli.panels.${host}.${projectId}`）：只存有 sid
  的主面板 `{profile,sid,prompt}` + `activeSid`，200ms 防抖；刷新时 URL 的 sid 命中
  布局就整体还原，命中不了按分享链接单开；`关闭全部` 清布局；子面板不持久化。
- URL「最近活动主面板」细化：新增 `lastMainKey`，开子面板不再抢地址栏；`prompt`
  建会话后从 query 删除，避免过期重建复跑旧任务。
- ended 面板「重开」= 同一任务再跑一次（`fresh = shiftKey || status==='ended'`，
  先 `term.reset()`）；`usePty` 的 `close 1000` 改为保留 sid，房间条可继续认出它。
- **子会话原地重跑**：子槽是常驻观察窗，进程结束后「重开」改为 `rerun=1` 接回同一
  sid。服务端 `delegation.rerun(child_sid)` 取该槽最近一条带 prompt 的委派，用
  `dispatch(..., force=True)` 绕过父 agent 外包开关再派一轮；失败回 `rerun-error`
  文本帧。前端 `rerunOnEnded = isChild && meta.delegation` 控制按钮显隐与文案，点击
  时 `reconnect({rerun:true})`（不改 sid、不落状态）。
- 回归：typecheck、build；`scripts/check_delegation.py` 新增「重跑接回同一 sid /
  台账多一条 / 新任务收口」三项，全 21 项通过；界面点「重开」实测子槽台账 1→2。


### P4 产品待办（早先列出，未做）
- 鉴权与会话按用户隔离；审计日志；项目台账增删改接口/admin 录入；
- agent 独立配置管理页（反代地址/key/模型/权限档位/env 覆盖可视化，不再硬读本机文件）。

## 6. 安全债（未处理）
- RCE 端到端接浏览器，仅绑 127.0.0.1；`DEBUG=True`；`SECRET_KEY` 硬编码；无鉴权；
  sid 裸 id 未绑用户；注册表进程内单例，多 worker 需换共享存储。MCP 的
  `TOKEN` / `BASE_URL` 也是进程内单例，且 `scripts/mcp_delegate.py` 用命令行
  `--parent-sid` 传递父会话，同机同用户下可伪造——只适合本机单用户场景。

## 7. 复现与回归命令

```bash
cd ~/projects/agentcli
.venv/bin/python manage.py check
.venv/bin/python scripts/check_session.py
.venv/bin/python scripts/check_terminal.py
.venv/bin/python scripts/check_delegation.py   # 桩测，不烧额度，自起 8011
.venv/bin/python scripts/probe_delegation.py   # 人工验收，真实 claude 子槽，少量额度
.venv/bin/python scripts/smoke.py
# 前端（改完必须重建，否则页面还是旧产物）
cd frontend && npm run typecheck && npm run build   # 产物进 ../static/dist
# 起服务（必须 uvicorn）
setsid .venv/bin/uvicorn agentcli.asgi:application --host 127.0.0.1 --port 8010 \
  > /tmp/agentcli-uvicorn.log 2>&1 < /dev/null & disown
# 带测试桩的演示实例（不调模型，能演示委派）
CONSOLE_ENABLE_STUB=1 setsid .venv/bin/uvicorn agentcli.asgi:application --host 127.0.0.1 --port 8013 \
  > /tmp/agentcli-8013.log 2>&1 < /dev/null & disown
```

- **交互态手动验收**：浏览器 `?project=1&profile=claude` → 空任务点「开会话」，
  面板里连问两轮看上下文；再让它「调用 delegate_task 派给 stub」，看回执是否
  显示在 claude 画面里，`GET /api/delegations/?parent=<sid>` 应出现 `done`。
- 自动化往 TUI 写消息时，首个 `\r` 可能只落字不提交，补发一次 `\r`。
- 改适配器后用 `.event-sample/` 与 `probe2/` 样本回测归类。
- 前端 dev 模式：`cd frontend && npm run dev`（5173，代理 `/api`、`/ws` 到 8010）。
- 临时回测脚本用完即删；复杂回测落盘脚本文件，别用 `wsl bash -lc` 内联字典（引号
  嵌套会 `unmatched '}'`）。

## 8. 已知坑（节选，完整见 CLAUDE.md）
- ASGI 协程直接查 ORM 报 `SynchronousOnlyOperation`，须 `sync_to_async` 包。
  **本轮修的**：`agentcli/asgi.py` 的 lifespan startup 里 `seed_from_disk()` 没包，
  抛异常后 uvicorn 判定整个 lifespan 不受支持并静默降级 —— 回收扫描器从此没跑过。
  日志特征只有一行 `ASGI 'lifespan' protocol appears unsupported`。
- claude `-p`（headless）无 prompt 且 stdin `/dev/null` 会报错；**交互 TUI 不带
  prompt 是正常的**（空着开会话就进原生输入）。旧结论「真 TTY 无 prompt 也报错」
  只对 `-p` 成立。codex 不回读 auth.json 必须 env 注入；qwen 非交互默认拒写工具，
  需 approval-mode 放行。
- 交互 TUI 的 `\r` 提交：自动化脚本首个回车可能只落字不提交，补一次；人工不受影响。
- codex 首次进新 cwd 停在 `1. Trust and continue` 信任页，属原生交互，不是进程卡死。
- WSL 起后台 uvicorn 用 `setsid ... < /dev/null & disown`；`pkill -f "uvicorn agentcli"`
  会连自己这条 bash 一起杀（整条命令 exit 15，后面的命令根本不执行），
  先 `ss -ltn | grep 8010` 确认端口的持有者，再分两步重启。
- 测试需 `asyncio.new_event_loop()`；主线程无 loop 时 `get_event_loop()` 报错。
- 关 PTY 前先 `remove_reader` 再 `close(fd)`，否则 selector 上留着已关闭的 fd。
- `scripts/check_delegation.py` 自起 8011 的 uvicorn；跑之前别占 8011，跑完自己收尸。
- **前端首帧会丢**：xterm 实例在 `useEffect` 里建，WS 的 `session` 帧/回放字节可能
  先到；`SessionPanel` 现在先攒 `pendingWrites`，`term.open` 后补写。新增面板逻辑
  别再假设「终端一定比 socket 先就绪」。
- **子槽寿命挂在父会话上**：`_Session.shutdown()` 级联清子槽；死父会话原 `DEAD_TTL=30s`
  一回收，子面板的 sid 立刻变 `session-missing`（前端会以为过期、另起一个空会话）。
  所以有 `pinned` 子槽的父会话用 `DEAD_TTL_WITH_CHILDREN=300s`。
- **多面板的 URL 语义**：地址栏跟着「最近活动过的主面板」，子会话面板不写 URL，
  否则点开子屏看两眼，刷新回来就是一个过期子槽的空壳。`prompt` 在建会话后立刻
  从地址栏删掉（留着会让过期重建把旧任务再跑一遍）；`localStorage` 连 profile
  一起记，避免同一个浏览器里 stub 的 sid 被接进 bash 面板。
- **验证工具会看到假乱码**：用文本抽取看 `?render=dom` 页面时，xterm 内部的
  `.xterm-char-measure-element`（一排重复的 `$`/`n`/`次`）会混进页面文本，它是
  量字宽用的隐藏探针，不是终端真的输出了乱码。判断终端内容请读
  `.xterm-rows` 的码点。
- **「面板空白」先查页面可见性**：`document.visibilityState === 'hidden'`（浏览器
  窗口被遮挡/最小化）时 rAF 被节流，xterm 的 DOM 渲染器不刷新，`.xterm-rows` 全空
  但 buffer 里其实有内容（`term.buffer.active.getLine(0)` 能读到提示符）。这是工具
  侧假象，不是丢字节；验证必须在前台可见标签页。Aha 多标签下 `bu` 会自己回到可见
  标签页，`BU_REF_STALE` 频繁，操作前重新 snapshot。

## 9. 本机环境锚点
- 已装 CLI（`~/.local/bin/`）：claude 2.1.325、codex-cli 0.169.0、qwen 0.27.4。
- 反代：cc-switch pid 13116 监听 15722（codex base_url）、pid 13106 监听 15721
  （claude ANTHROPIC_BASE_URL）；new-api pid 3901 监听 3000（qwen baseUrl）。
- 鉴权文件：codex `~/.codex/auth.json`（键 `OPENAI_API_KEY`）；claude
  `~/.claude/settings.json` env 段；qwen `~/.qwen/settings.json`。
- 同级总目录 `~/projects/`：agentcli(id 1)、myos(id 2)、new-api(id 3)。

## 10. Agent 侧收敛（后续方向）

agent 接入只保留：原生 TUI + MCP `delegate_task` + 续会话身份。**不再新增 hooks**：
qwen/codex 都不接，交互态也不追求文件事件结构化；文件改动以 `git status` / diff
为准，`file_events` 只作“刚动过”提示。claude 现有 hook 视为可拆卸旁路：身份主靠
`--session-id`，P5 的 git 视图落地后应整段移除。控制台不再为任何 CLI 私有事件格式
扩 schema，拿不到就降级。

## 11. 后续计划：代码与 Git 可视化（只读）

控制台不做文件编辑：改文件由 agent/CLI 与 git 负责，控制台只把结果可视化。

- **P5a 只读文本查看器（已落地）**：目录树点文件 → 弹层只读文本 + `highlight.js`
  语法高亮；后端 `GET /api/file/` 复用 `files.resolve`，超 512KB 截断、二进制/NUL
  提示、UTF-8→GB18030 回退；前端只给「插入终端」与关闭，没有保存/新建/删除。
- **P5b Git 状态（已落地）**：右侧目录区可整体折叠/展开（收起后留竖栏，宽度可拖）；
  下方 Git 只读区显示分支、ahead/behind、工作区状态与最近 15 条提交，点状态文件
  可直接预览。文件树标色以 git status 优先（M/A/D/?/R），hooks 只作补充。
  后端 `GET /api/git/` 只跑固定只读命令；非仓库返回 `repo:false`。
- **P5c Diff**：点 commit 看该提交 diff，点工作区文件看未提交 diff；增删行着色、
  行号、折叠上下文，可复制但不“应用”。
- **P5d 联动**：`file_events` 只作“刚动过”提示，最终事实以 git 为准。
- 边界：全部只读，不提供 add/commit/reset/checkout；版本控制决策仍归用户/agent。
