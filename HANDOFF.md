# agentcli 交接文档

> 交接时点：2026-11-17。本文档记录当前实现状态、已验证结论、未打通的缺口和
> 下一步优先级。代码事实以本地仓库为准；`CLAUDE.md` 是架构/踩坑备忘，本文档是
> 进度与待办快照。

## 1. 项目是什么

把命令行 agent（claude / codex / qwen）搬进浏览器的 Web 控制台：Django + ASGI
（uvicorn，必须用 uvicorn 才有 WebSocket），PTY 承载交互式 TUI 进程，WebSocket
原样搬运字节；适配器层把各 agent 的 JSONL 输出归一化成通用事件，驱动目录树标色、
委派联动。

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
  delegation.py  委派总线：派生子任务、台账、链式外包、回执回灌
  views.py       HTTP 视图：页面、项目/会话/委派快照、命令降级接口
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
  templates/console/index.html  前端（内联 JS）
scripts/
  check_session.py  会话保持回归（8 项）
  check_terminal.py  终端/目录回归（8 项）
  check_delegation.py 委派链路桩测（a→b→c/忙锁/槽复用，自起 8011）
  probe_delegation.py 人工验收（真实 claude 子槽，少量额度）
  stub_agent.py     测试桩 agent（stream-json 假输出）
  smoke.py          冒烟（越界 403 等）
  probe_agents.py   能力探针（basic / --suite broad）
.event-sample/     三 agent 真实事件样本（basic 与 probe2/ broad）
```

## 3. 已落地并验证的能力

### 3.1 会话保持（已完成）
- 会话挂在注册表 `sid -> Session` 上，不挂连接；断连只摘观察者，进程继续跑。
- 带 `sid` 重连回放环形缓冲（`REPLAY_LIMIT=256KB`）再接管实时流。
- 进程退出进 `dead`，留 `DEAD_TTL=30s` 回看；空闲 `IDLE_TTL=300s` 回收，
  扫描周期 `SWEEP_INTERVAL=30s`。
- profile/sid/project 写 URL query，localStorage 兜底；重连先清本地画面防重叠。

### 3.2 项目体系（已完成）
- `Project` 模型（name/path/agent/enabled/note）；总目录 `~/projects`，进来先选
  项目，选定后终端与目录树限定在项目内；两层路径守门在 `files.py`。

### 3.3 适配器与目录树联动（已完成）
- 非 TUI 非交互 argv：claude `claude -p --output-format stream-json --verbose
  --permission-mode acceptEdits`；codex `codex exec --json --skip-git-repo-check
  --sandbox workspace-write`；qwen `qwen -o stream-json --approval-mode auto-edit`。
- 一条 JSONL 挂多工具块时 `parse_events()` 批量出事件；工具归类 read/write/exec，
  PascalCase 与 snake_case 两套命名。
- 工具事件记入 `Runtime.file_events`（rel 路径 → {read, write}），WS 推
  `agent-event` / `file-events` 帧；前端标蓝（读过 visited）/标黄（改过 modified）。
  路径在服务端按 `runtime.cwd` 归一为项目内相对路径。
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
- **忙锁（P1 已落地）**：
  - 派发前查目标槽 `is_busy()`，忙则台账记 `failed`（原因「目标会话忙」）并回灌；
  - 用户往 agent 会话喂字节时，若 `busy_kind=delegate` 则拒收并回
    `input-rejected` 帧（Ctrl-C/D/Z/Esc 放行）；
  - 带初始任务的会话启动即 `busy=user`；`result` 事件 / EOF 释放。
- **初始任务入口**：`/ws/terminal/?profile=claude&prompt=...&outsourcing=1`。
  claude 在真 TTY 下没有 prompt 参数会直接报错（见 §8），所以 agent 会话必须带
  prompt 起；`outsourcing=1` 让开关赶在第一行输出之前就位。
- **回执晚到**：父进程 EOF 时若名下还有未收口的委派，`_Watcher.on_eof` 只推
  `session-eof` 帧并保留 socket，全部收口后再 close；否则晚到的 `delegate-result`
  会被切断。
- HTTP 接口：`GET /api/projects/`、`GET /api/sessions/`（含 role/parent/label/
  depth/pinned/delegation/busy/busy_kind/outsourcing）、
  `GET /api/delegations/?parent=<sid>`、`GET /api/files/`、`POST /api/command/`（需 CSRF）。

### 3.5 前端现状（部分完成）
- 单 socket / 单 sessionId / 单 term（多标签尚未动工）。
- 已有「外包模式」开关按钮（文案就叫这四个字），点亮后同步后端；房间成员状态条
  列出各会话 待命/干活中/外包中，子槽显示 `↳ 目标名` 虚线徽章，250ms 防抖拉
  `/api/sessions/`；回执帧写进当前终端（绿「外包回执」/红「外包失败」，带
  child_sid）；`session-eof` 会在等回执时提示；`input-rejected` 写黄字提示。

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

### P2 回执回灌父 agent 上下文（仍未做，且被形态卡住）
回执目前只是事件帧推给前端上墙，**不进父 agent 的 LLM 上下文**。根因是父会话
也是「任务进 argv、跑完即退」的一次性非交互进程（claude 在 TTY 下只认 argv/stdin
pipe，见 §8），进程退出后没有可写回的上下文通道。要真接上，得先定父会话形态：
1. 交互式 TUI（PTY 敲键）—— 但 TUI 输出不是 JSONL，事件流/目录树联动会一起丢；
2. 用 CLI 的 `--resume/--session-id` 续跑，把回执作为下一轮 prompt;
3. 底座自己持有会话上下文（自建 agent loop），CLI 只当工具执行器。
这三条都是产品形态选择，不是补丁能解决的。

### P2.5 `Task` 双跑（语义坑，必须先决策）
claude / qwen 的 `Task`/`agent` 工具在 CLI 进程内部**已经自己跑了一个子代理**，
底座又把同一个事件当外部派发，等于同一件活干两遍（父 agent 等的是内部结果，
底座回执只能上墙）。当前 a→b→c 能跑通是协议层的，不代表不重复劳动。可选解：
- 只用 `SendMessage`（跨会话消息）当委派信号，`Task` 仅观察不派发；
- 派发前判断目标是否等于本 CLI 内部子代理类型，命中就跳过；
- 给 CLI 关掉内部子代理（若支持），把委派完全交给底座。

### P3 前端多标签并行面板
现在单终端；需要一个会话一个面板，展示父子关系、可点开独立看屏；房间状态条目前
只是旁观（子槽显示 `↳ 目标名`）。另外**前端还没有「派任务」入口**：agent 会话
现在只能靠 URL `&prompt=` 起任务，界面上没有输入框把任务写进 argv。

### P4 产品待办（早先列出，未做）
- 鉴权与会话按用户隔离；审计日志；项目台账增删改接口/admin 录入；
- agent 独立配置管理页（反代地址/key/模型/权限档位/env 覆盖可视化，不再硬读本机文件）。

## 6. 安全债（未处理）
- RCE 端到端接浏览器，仅绑 127.0.0.1；`DEBUG=True`；`SECRET_KEY` 硬编码；无鉴权；
  sid 裸 id 未绑用户；注册表进程内单例，多 worker 需换共享存储；仓库未初始化 git。

## 7. 复现与回归命令

```bash
cd ~/projects/agentcli
.venv/bin/python manage.py check
.venv/bin/python scripts/check_session.py
.venv/bin/python scripts/check_terminal.py
.venv/bin/python scripts/check_delegation.py   # 桩测，不烧额度，自起 8011
.venv/bin/python scripts/probe_delegation.py   # 人工验收，真实 claude 子槽，少量额度
.venv/bin/python scripts/smoke.py
# 起服务（必须 uvicorn）
setsid .venv/bin/uvicorn agentcli.asgi:application --host 127.0.0.1 --port 8010 \
  > /tmp/agentcli-uvicorn.log 2>&1 < /dev/null & disown
```

- 改适配器后用 `.event-sample/` 与 `probe2/` 样本回测归类。
- 内联 JS 语法检查：剥 Django 模板行后 `node --check`（见 CLAUDE.md 踩坑记录）。
- 临时回测脚本用完即删；复杂回测落盘脚本文件，别用 `wsl bash -lc` 内联字典（引号
  嵌套会 `unmatched '}'`）。

## 8. 已知坑（节选，完整见 CLAUDE.md）
- ASGI 协程直接查 ORM 报 `SynchronousOnlyOperation`，须 `sync_to_async` 包。
  **本轮修的**：`agentcli/asgi.py` 的 lifespan startup 里 `seed_from_disk()` 没包，
  抛异常后 uvicorn 判定整个 lifespan 不受支持并静默降级 —— 回收扫描器从此没跑过。
  日志特征只有一行 `ASGI 'lifespan' protocol appears unsupported`。
- claude `-p` 无 prompt 且 stdin `/dev/null` 报错；**真 TTY 下无 prompt 参数也报错**
  （`Input must be provided either through stdin or as a prompt argument`），所以
  agent 会话靠 URL `&prompt=` 把任务写进 argv。codex 不回读 auth.json 必须 env 注入；
  qwen 非交互默认拒写工具，需 approval-mode 放行。
- WSL 起后台 uvicorn 用 `setsid ... < /dev/null & disown`；`pkill -f "uvicorn agentcli"`
  会连自己这条 bash 一起杀（整条命令 exit 15，后面的命令根本不执行），
  先 `ss -ltn | grep 8010` 确认端口的持有者，再分两步重启。
- 测试需 `asyncio.new_event_loop()`；主线程无 loop 时 `get_event_loop()` 报错。
- 关 PTY 前先 `remove_reader` 再 `close(fd)`，否则 selector 上留着已关闭的 fd。
- `scripts/check_delegation.py` 自起 8011 的 uvicorn；跑之前别占 8011，跑完自己收尸。

## 9. 本机环境锚点
- 已装 CLI（`~/.local/bin/`）：claude 2.1.325、codex-cli 0.169.0、qwen 0.27.4。
- 反代：cc-switch pid 13116 监听 15722（codex base_url）、pid 13106 监听 15721
  （claude ANTHROPIC_BASE_URL）；new-api pid 3901 监听 3000（qwen baseUrl）。
- 鉴权文件：codex `~/.codex/auth.json`（键 `OPENAI_API_KEY`）；claude
  `~/.claude/settings.json` env 段；qwen `~/.qwen/settings.json`。
- 同级总目录 `~/projects/`：agentcli(id 1)、myos(id 2)、new-api(id 3)。
