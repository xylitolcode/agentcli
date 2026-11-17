# agentcli

网页版 agent CLI —— 把本机的命令行 agent（`claude` / `codex` / `qwen`）搬进浏览器：
一个会话一块终端面板（可同时开几块、互不打扰），右侧是它正在干活的项目目录，
开一个标签页就能用。顶栏还能直接给 agent 派任务、给子会话开独立面板看屏。

左边不是"套壳终端"，跑的是**真的 agent 进程**。这些 CLI 都是交互式 TUI ——
全屏接管、按帧重绘、要 tty 才肯渲染 —— 所以只能用 PTY 承载（管道会把它们拍成
一段静态文本，交互全丢）。`bash` 也在 profile 列表里，方便调试时退回裸终端。

## 目录

```
agentcli/
├── agentcli/
│   ├── asgi.py            # ← WebSocket 分派：/ws/terminal/ 进 PTY，其余给 Django
│   └── urls.py            # DEBUG 下由 URLconf 提供静态资源（没有 runserver 了）
├── console/
│   ├── terminal.py        # ← PTY 会话层：拉 agent + 双向字节流 + profile 白名单
│   ├── sessions.py        # ← 会话注册表：进程脱离连接存活，断线重连附着 + 空闲回收
│   ├── files.py           # ← 目录树数据源：单层列举 + 越界防护
│   ├── agent.py           # 老的「命令 -> 结构化输出」执行层，现作降级通道
│   ├── views.py           # 页面入口（注入 bootstrap）+ 各 JSON 接口
│   ├── vite.py            # 读 Vite manifest，把带 hash 的资源名交给模板
│   └── templates/console/index.html   # 17 行，只有 #root 挂载点
├── frontend/              # ← 前端工程：React 19 + TS + Tailwind 4 + Vite
│   ├── src/
│   │   ├── App.tsx        # 状态编排：项目 / 多面板 / 文件标记 / 布局
│   │   ├── components/    # SessionPanel · WorkspaceBar · RoomBar · FileTreePane …
│   │   ├── hooks/         # usePty · useFileTree · useRoom
│   │   ├── lib/           # xterm 封装（WebGL/字体探测）、格式化
│   │   └── types.ts       # 前后端契约，改这里就得同步改 Django 的 JSON
│   └── vite.config.ts     # 构建到 ../static/dist，dev 时代理 API/WS
├── static/dist/           # 构建产物（gitignore，需 npm run build 生成）
├── scripts/
│   ├── smoke.py           # HTTP 全链路冒烟
│   └── probe_delegation.py
├── requirements.txt
└── manage.py
```

## 启动

必须用 uvicorn —— `runserver` 只跑 WSGI 那半边，WebSocket 连不上。

```bash
git clone https://github.com/xylitolcode/agentcli.git
cd agentcli

python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 前端产物不入库，克隆后必须构建一次
cd frontend && npm install && npm run build && cd ..

uvicorn agentcli.asgi:application --port 8010 --reload
```

打开 http://127.0.0.1:8010/

> 8000 端口在此机器上被 Windows 侧的端口转发代理占用（`::` PID 4），直接用会
> 报 `That port is already in use`，所以默认走 8010。

## 前端开发

```bash
cd frontend
npm run dev        # 5173，HMR；/api 和 /ws 自动代理到 8010
npm run build      # 产出 static/dist/，Django 页面直接读它
npm run typecheck  # tsc --noEmit
```

两条路面相不同：`npm run dev` 走 Vite 自己的服务（有热更新，改完立刻看到），
`http://127.0.0.1:8010` 走构建产物（**改完必须 build**）。排查样式时优先用 dev。

终端渲染默认 WebGL；canvas 内容截不到图、或者怀疑渲染层有问题时，加
`?render=dom` 退回 DOM 渲染器对照。

## 验证

```bash
python scripts/smoke.py            # 页面、CSRF、命令接口、目录树、越界拦截
python scripts/check_terminal.py   # 真终端：echo / tty / cd / Ctrl-C / ANSI / 宽字符
python scripts/check_session.py    # 会话保持：断开重连，同进程、同 tty、历史回放
python scripts/check_delegation.py # 委派链路：常驻子槽、a→b→c、忙锁、槽复用（桩测）
python scripts/probe_delegation.py # 人工验收：真实 claude 当子槽（消耗少量额度）
```

`check_terminal.py` 里最关键的一条是 `tty` 必须返回 `/dev/pts/N` —— 返回了才说明
走的是真伪终端，而不是一根普通管道。

## 项目体系（总目录 → 选项目 → 进入内部）

进系统先在**总项目目录**（`settings.CONSOLE_PROJECTS_ROOT`，默认 `~/projects/`）
选一个项目，选定后终端与会话、目录树都收窄到该项目根。项目清单由 Django
`Project` 模型维护：

- 首次启动从总目录扫描播种（命中 `.git` / `manage.py` / `package.json` 等标记），
  之后以台账为准，手工增删走 admin / 后续接口；
- `GET /api/projects/` 返回项目清单；`GET /api/files/?project=<id>` 在项目根内遍历；
- WS 入口带 `project`：`/ws/terminal/?project=3&profile=bash`；
- 项目登记的 `agent` 作为进入项目时的默认 profile，可在顶部切换。

## 会话 profile 与适配器

profile 分两类：`bash` 是系统壳（默认入口）；`claude` / `codex` / `qwen` 是产品
agent 能力。**主面板走原生交互**：进 CLI 自己的 TUI，多轮对话、上下文、权限弹窗、
slash 命令全归 agent，控制台只搬字节。适配器层（`console/agents/`）同时保留
headless 参数（`-p / exec`），只给**委派子槽**用，那里才把 JSONL 归一化成
`system/text/tool/result/error` 事件，供台账与目录树消费。

两种形态由 `mode` 决定（`interactive` / `headless`），默认按适配器的 `interactive`
标记取；`stub` 固定 headless，方便桩测。结构化事件是**尽力提供**，不为了事件去改
agent 的交互方式。

能拉什么由 `settings.CONSOLE_PROFILES` 决定，**只认表里的键**：

```python
CONSOLE_PROFILES = {
    "bash":   ["/bin/bash", "-i"],
    "claude": ["claude"],
    "codex":  ["codex"],
    "qwen":   ["qwen"],
}
CONSOLE_SHELL_PROFILE = "bash"
CONSOLE_DEFAULT_PROFILE = "bash"
```

`available_profiles()` 会探测 PATH（含 `~/.local/bin` 兜底 —— uvicorn 若是 nohup
起的，PATH 里经常没有它），探不到的不显示。加新 agent：往表里加一行 + 在
`console/agents/` 写一个适配器并注册。

WS 入口：`/ws/terminal/?profile=bash&project=3`。

## 两条执行通道

| 通道 | 入口 | 能力 | 用途 |
|---|---|---|---|
| 原生交互会话 | `ws://.../ws/terminal/?profile=claude&project=3`（`mode=interactive`） | 真 TUI、多轮、上下文、权限弹窗 | 页面左侧，人用的主通道 |
| headless 会话 | 同上 + `prompt=...`（`mode=headless`） | 一轮任务、JSONL 事件、忙锁 | 委派子槽、自动化 |
| 命令接口 | `POST /api/command/` | 一次性、结构化 `lines` | 自动化、脚本、降级 |

agent 会话的帧协议刻意做得很薄：

- **二进制帧** = 终端原始字节流，两个方向都不转码
- **文本帧** = JSON 控制消息：
  - `{"type":"resize","cols":N,"rows":M}` 调整窗口尺寸
  - `{"type":"session","sid":"...","mode":"interactive"|"headless",...}` 服务端下发会话 id 与形态（首连/重连后第一条）
  - `{"type":"session-missing","sid":"..."}` 本地 id 已被回收，需新开

输入一律走二进制，所以文本帧可以安全地只当控制通道用。交互态输入直通 TUI，
不设任务忙锁；headless 才把输入当「派活」并守忙锁。

## 外包模式（agent 主动调用）

交互态没有 JSONL 可解析，委派改由 agent 自己发起：服务端给三个 CLI 注入一个
**MCP server**（`scripts/mcp_delegate.py`），暴露 `delegate_task(target, prompt)`。
agent 判断该分工、或用户明确要求时调用它；服务端把任务落到 headless 子槽，
跑完把回执作为 **MCP tool result** 返回——直接进 agent 自己的上下文。

- 每条 WS 连接生成进程内 token 与真实端口，`console/bridge.py` 拼成各 CLI 的
  `--mcp-config` / `-c mcp_servers...` 参数，并附一段中文系统提示告诉 agent
  工具的存在与使用边界。
- 控制台有「外包模式」开关（`outsourcing`）：**原生交互主会话默认开，headless
  一次性任务默认关，子槽继承父会话**；用户在面板上关掉后，前端每次连接都显式传
  `0`，不会被默认值翻回来。未开启时调用返回明确失败原因，不会静默派活。
- claude / qwen 预放行 `mcp__agentcli__delegate_task`，避免卡在权限弹窗；其它工具
  仍走原生权限确认。codex 走它自己的 MCP 审批。

## 会话保持

进程挂在**会话**上，不挂在 WebSocket 连接上。浏览器硬刷新、断网、切标签导致
连接断开时，PTY 进程继续跑；带着同一个 `sid` 重连，先回放最近一段历史缓冲，
再接管后续实时流 —— 目录、环境变量、agent 进程上下文都不丢。

- 首连（不带 `sid`）：注册表新建会话，fork 进程，首条文本帧回传 `sid`；
  前端把它写进 URL 和 `localStorage`。
- 重连（`/ws/terminal/?profile=bash&sid=...`）：命中存活会话就接回；缓冲里的
  历史字节先回放给新连接，再走实时流。
- **URL 即状态（只记主面板）**：`profile` / `sid` / `project` 同步在页面 query 上
  （`replaceState`，不产生历史记录）。多面板时地址栏只跟**最近活动过的主会话**走 ——
  子会话面板是临时观察窗，不写地址栏；`localStorage` 只做 URL 缺省时的兜底。
- **布局持久化**：主面板布局另存 `localStorage` 的
  `agentcli.panels.${host}.${projectId}`（`{profile,sid,prompt}` 数组 + `activeSid`，
  只含有 sid 的主面板，200ms 防抖）。刷新时 URL 的 sid 命中布局就整体还原，没命中
  就按分享链接单开一个；「关闭全部」同时清布局。子会话面板不持久化。
- **「重开」**：离线面板回原会话（Shift+点击新开）；已 `ended` 的交互主面板走
  **续会话**，先擦画面，再带 `resume_from=<旧控制台 sid>` 新建连接（不重发旧任务），
  服务端查身份映射后用 `--resume` 回到 CLI 自己的上下文（claude 已通；qwen/codex
  暂不可续）。非 resumable 的 headless 主面板仍视为「再开一代」，必须还有任务。
  已 `ended` 的委派子会话则带 `rerun=1` 接回同一张子槽，用上一轮委派任务原地再跑
  （sid / 父子 / 台账身份不变）。
- 断连只摘观察者，不杀进程；空闲会话超过 `IDLE_TTL`（默认 300s）由后台扫描
  兜底回收；进程退出后会话进入 `dead`，留 `DEAD_TTL`（默认 30s）供重连回看
  最终输出，随后摘除。名下挂着常驻子槽的父会话留 5 分钟
  （`DEAD_TTL_WITH_CHILDREN`），否则子面板会跟着一起消失。
- `sid` 失效（过期回收）时服务端回 `session-missing`，前端清掉本地 id 走新建。
- 换 profile 等于新开会话：旧 id 丢弃，旧进程按空闲超时回收。

> 注册表是**进程内单例**，只适配 uvicorn 单进程。将来上多 worker，会话亲和要
> 换成共享存储，不能再假设跨进程可见。

## 目录树

`GET /api/files/?path=<相对路径>`，一次只返回**一层**，前端展开时才请求。响应里带
`link` / `blocked` 标记：指向项目目录之外的符号链接会被标成 `blocked`，点不开。

`console/files.py:resolve()` 是唯一的路径守门员，`..`、绝对路径、外部软链三种越界
都在那里统一挡掉。要加新接口（读文件、上传、下载）就必须过它。

## 字体与渲染

字体在**客户端**决定，服务端只发字节 —— 所以同一个会话在 Windows 和 Linux 上看
到的字形可能不同，这是正常的，不是 bug。

终端字体有一条硬约束：**汉字宽度必须正好是西文字符的 2 倍**。xterm 用 fontFamily
首位字体的字符宽度算 cell，汉字占 2 个 cell；如果中文字体是比例字体（雅黑、苹方），
字面比格子窄一圈，看着就是"瘦、散"。

推荐 **Sarasa Term SC Nerd**（更纱终端黑体），实测 14px 下 ASCII 6.5px / 汉字 13px，
比率精确 2.000。装到系统里即可，**不进仓库、不进网页**。

> 官方的 `SarasaTermSCNerd.ttc` 有 270MB——因为 TTC 打包了 10 个字重，每个都含完整
> CJK 字形。用 fontTools 把 Regular 和 Bold 拆出来，各约 28MB，够用：
>
> ```python
> from fontTools.ttLib import TTCollection
> for f in TTCollection("SarasaTermSCNerd.ttc").fonts:
>     if f["name"].getDebugName(6) in {"SarasaTermSCNerd-Regular", "SarasaTermSCNerd-Bold"}:
>         f.save(f["name"].getDebugName(6) + ".ttf")
> ```

字体没命中时，页面底部会显示黄色的「中文未等宽」提示（`stat-font`），不会静默退化。

渲染走 **WebGL**（`addon-webgl`），大段输出不掉帧、高 DPI 下笔画更锐利；监听
`onContextLoss` 后自动退回 DOM 渲染，切显卡或系统休眠不会白屏。当前模式显示在
底部状态栏（`webgl` / `dom`）。

## 安全

这是把 RCE 端到端接到了浏览器上 —— 谁拿到那个 WebSocket 地址，谁就有这台机器的 shell。

- 现在只绑 `127.0.0.1`，`DEBUG=True`，`ALLOWED_HOSTS` 只有本机
- **不要**在加鉴权之前暴露到公网
- 真要暴露，至少：Django auth 做会话校验 + `CONSOLE_ROOT` 收窄 + shell 套容器
- `SECRET_KEY` 从环境变量 `DJANGO_SECRET_KEY` 读，源码里的只是本地占位值 —
  对外部署必须设，否则会话签名是公开可伪造的

## 后续要做的

- [x] **会话保持**：刷新/断网后凭 `sid` 重连，进程不重启、历史回放（见上节）
- [x] **目录树变活的**：agent 读过的文件标蓝、改过的标黄，右侧不再是死的 `ls`
- [x] **委派底座**：主会话把 Task 事件外包给常驻子槽（sid 不变、按任务换进程），
  子槽自己还能再派下一级（a→b→c）；单 agent 串行，忙则拒绝；回执逐级回灌
- [x] **多面板**：一个会话一块终端，可同时盯几个 agent；房间条可点开子会话面板，
  父子关系用 `↳ label` 标出
- [x] **界面开会话/派任务**：顶栏选 profile；交互 agent 可空任务点「开会话」进原生
  TUI，headless agent 写任务点「派任务」，任务进 argv 启动
- [x] **主面板原生交互**：claude / codex / qwen 直接进各自 TUI，多轮、上下文、权限
  弹窗、slash 命令都归 CLI；控制台不解析 ANSI，只搬字节
- [x] **身份映射 / 续会话**：控制台 sid 为主，CLI session id 附属；claude 重开走
  `--resume` 续上下文，qwen/codex 待接
- [x] **外包 MCP 桥**：交互 agent 可主动调 `delegate_task` 把活派给另一个 agent，
  回执作为 tool result 回到它自己的上下文
- [ ] 回执进父会话上下文：已由 MCP 解决（旧的一次性路径不再需要）
- [ ] **`Task` 双跑**：headless 路径仍有「CLI 内部子代理 vs 底座外部子槽」重复风险；
  交互态已改走 MCP，不再自动解析 `Task`
- [ ] 交互态 hooks：claude 已接 `SessionStart`（校正 CLI 会话 id）与 `PostToolUse`
  （文件树标色，`/api/hook/`）；qwen hooks 未接，codex 无等价钩子
- [x] **外包实测**：claude / codex / qwen 都能在原生 TUI 里主动调 `delegate_task`，
  回执进入各自上下文；codex 首次有信任页与一次原生工具审批
- [ ] **只读代码 / Git 视图（P5）**：目录树点文件只看不写，带语法高亮；再加
  `git status` / 提交历史 / diff 面板。控制台不做编辑、不代做 add/commit/reset。
- [ ] 鉴权：Django auth 接上，会话按用户隔离（现在是单用户假设）
- [ ] 审计日志：谁在什么时候、用哪个 agent、动了什么
- [ ] **agent 独立配置管理页**：反代地址、鉴权/key、模型选择、权限放行档位、
  环境变量覆盖，都应在页面上可配。当前鉴权是适配器启动时读本机配置文件
  （codex 从 `~/.codex/auth.json` 取 `OPENAI_API_KEY` 注入子进程 env；
  claude/qwen 读各自 `settings.json` 的反代段），属临时接线，未做可视化管理。

## 两种模式与权限档位

### 交互态（主面板默认）

claude / codex / qwen 直接以原生 TUI 启动（claude/qwen 可带首条消息，qwen 用 `-i`），
权限弹窗、`/model`、`/resume` 等全部由 CLI 自己处理；每个会话额外注入 MCP 桥参数
（见「外包模式」）。这一态**不解析 JSONL**；文件树标色靠 claude 的 `PostToolUse`
hook 旁路上报（qwen/codex 暂无等价钩子，仍不标色），房间条 busy 也不显示，属已知
降级，不是 bug。

### headless 态（委派子槽、stub）

任务进 argv，权限档位在适配器 `build_argv(..., mode="headless")` 里固化：

| agent | 入口 | 权限参数 | 实测能力（低 token 探针） |
|---|---|---|---|
| claude | `claude -p --output-format stream-json --verbose` | `--permission-mode acceptEdits` | 读文件 `Read`、编辑 `Edit` 均自动放行；shell 命令按策略 |
| codex | `codex exec --json --skip-git-repo-check` | `--sandbox workspace-write` | 走 shell 命令读写工作区；鉴权从 `auth.json` 注入 env |
| qwen | `qwen -p -o stream-json` | `--approval-mode auto-edit` | `read_file` / `edit` 自动放行；其余工具按分类策略 |

> 探针脚本：`scripts/probe_agents.py`（短 prompt、三行测试文件、单轮，控制 token）；
> 原始样本在 `.event-sample/*.jsonl`（basic 单文件读改）与 `.event-sample/probe2/`
> （broad 一轮打全类型）。codex 没有独立的文件工具，读写都封装在
> `command_execution` 里，适配器从命令文本粗判读/写并提取路径。

### 能力上界实测（broad 一轮，读/写/编辑/命令/检索/联网/委派）

| 能力 | claude | codex | qwen |
|---|---|---|---|
| 读文件 | ✅ `Read` | ✅ shell `cat` | ✅ `read_file` |
| 整文件写 | ✅ `Write` | ✅ shell `printf>` | ✅ `write_file` |
| 编辑 | ✅ `Edit` | ✅ shell `sed/perl` | ✅ `edit` |
| 执行命令 | ✅ `Bash` | ✅ `command_execution` | 经 shell 工具 |
| 列目录/检索 | ✅ `Glob`/`Grep` | ✅ shell `ls`/`find` | ✅ `glob`/`grep_search` |
| 联网检索 | ⚠️ 工具可调，**权限未放行被拒** | ❌ 无联网工具，仅 shell | ✅ `web_fetch`（抓 DuckDuckGo 页面） |
| 子代理委派 | 有 `Task`/`SendMessage`，本轮未触发 | ❌ 无 | 有 `agent`/`send_message`，本轮未触发 |

**联网归属说明**：new-api 内置的 `web_lookup` 是它自己控制台 assistant 的工具，
不随标准 chat/completions 透传给外部 CLI；标准渠道的 `web_search` 是渠道原生能力，
是否可用取决于上游渠道。本轮 qwen 的 `web_fetch` 走的是 CLI 自带的页面抓取，
不是 new-api 的联网工具。
