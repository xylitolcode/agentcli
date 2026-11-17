# 方向对齐：会话形态（2026-11-17）

> 触发：用户指出「agent 是交互模式，天然有多轮对话；现在做成一次性，是我们自己把它丢了」。

## 1. 结论先行

现在的「一次性」不是漏做，而是适配层选型的必然结果：

- 三个适配器都把入口固化成无头模式：`claude -p`、`codex exec`、`qwen -p`；
- 进程跑完一轮就退出，会话进入 `eof`，面板只能「重开」；
- 终端输入被当成「再派一个任务」，还要过忙锁（`_accept_user_input`）；
- 委派、文件树标色、房间条 busy 全部依赖 stdout 的 JSONL 事件。

所以「原生多轮、上下文延续、权限确认、slash 命令」不是我们没开发，是被 `-p` 这一层设计整体切掉了。

目标形态要改成：**agent 的会话归 agent，控制台只做外壳**——进程与会话保活、多面板观察、编排（委派/台账/文件痕迹）。不再由控制台决定 agent「怎么跑」。

## 2. 事实基线

### 2.1 CLI 原生能力（本机 `--help` 实测）

| 能力 | claude | codex | qwen |
|---|---|---|---|
| 默认形态 | 交互 TUI | 无子命令即交互 TUI | 交互 TUI |
| 一次性入口 | `-p / --print` | `codex exec` | 位置参数（默认 one-shot） |
| 带初始任务进交互 | 位置参数 | `codex [PROMPT]` | `-i/--prompt-interactive` |
| 结构化输出 | `--output-format stream-json`（仅 print） | `exec --json`（JSONL） | `-o stream-json` |
| 常驻流式输入 | `-p --input-format stream-json`（实时多轮） | 无（exec 一次一轮） | `--input-format stream-json` |
| 跨进程续会话 | `--resume <id>` / `-c` | `codex exec resume <id>` / `--last` | `-r <id>` / `-c` |
| 原生权限交互 | TUI 弹窗 | TUI 弹窗 | TUI 弹窗 |

结论：多轮能力三个 CLI 本来都有，而且有两条路可走——原生 TUI，或「常驻 stream-json 输入」（claude/qwen 有，codex 只能 resume）。

### 2.2 现有代码为什么把多轮丢了

| 位置 | 现状 | 后果 |
|---|---|---|
| `console/agents/claude.py:29` | `-p --output-format stream-json` | 一轮一轮进程，结束即 EOF |
| `console/agents/codex.py:39` | 强制 `codex exec` | 同上 |
| `console/agents/qwen.py:21` | `-o stream-json` + `-p` | 同上 |
| `console/terminal.py:371` | agent 一律走 `build_argv` | 没有「原生模式」分支 |
| `console/terminal.py:572` | 只按 JSONL 解析 | TUI 的 ANSI 输出不产生事件 |
| `console/terminal.py:628` | 输入 = 派活 + 忙锁 | 交互态的多轮输入被当成第二个任务 |
| `console/delegation.py` | 解析 `tool_use Task` 触发委派 | TUI 下看不到，委派链断 |

这不是「P2 回执进上下文」能补的——那是给一次性进程续上下文；方向应该是别把它做成一次性。

## 3. 三种可选架构

### A. 原生交互为默认，编排能力旁路重建（终局）
- 面板默认 `claude` / `codex` / `qwen` 原生 TUI；多轮、权限、slash 全归 agent。
- 结构化能力换通道：
  - 工具事件：agent hooks（claude PostToolUse / qwen hooks）回调控制台；
  - 委派：控制台跑一个 MCP server，暴露 `delegate_task`，agent 主动调用；回执作为 tool result 回到 agent 上下文（顺带解决 P2）。
- 代价：MCP + hooks + 权限策略都要新做；交互态下控制台看不到「当前在干什么」，直到 hooks 接上。

### B. 双轨：主面板交互，委派子槽 headless（推荐先做）
- 主面板（人用）恢复原生交互；「派任务」按钮改为「新建一个 headless 会话」或「切到该面板输入」。
- 委派子槽继续 `-p/exec` 结构化：它本来就是机器派活，台账/回执/忙锁/看屏都还成立。
- 文件树标色、房间条 busy 在主面板交互态暂时降级；子槽仍准确。
- 代价：同一界面两种形态，模式要显式标注；交互态与结构化态不能混在同一个进程里。

### C. 常驻 stream-json 多轮（保住现有解析）
- claude：`-p --input-format stream-json --output-format stream-json` 常驻，stdin 写 user 消息帧，多轮不退出；
- qwen：同源能力（`--input-format stream-json`）；
- codex：`exec resume <id> --json` 每次新进程，靠磁盘会话续上下文。
- 保住：事件解析、文件树、委派台账、忙锁。
- 丢掉：仍是 TUI 的替代品——权限弹窗、slash 命令、`/model`、`/resume` 选择器都没有。
- 适合作为「结构化聊天」模式，而不是「原生交互」的答案。

### 对比

| 维度 | A 原生+hooks/MCP | B 双轨 | C 常驻 JSONL |
|---|---|---|---|
| 多轮/上下文 | ✅ 原生 | ✅ 主面板原生 | ✅ 进程内 |
| 权限弹窗/slash | ✅ | ✅ 主面板 | ❌ |
| 工具事件可解析 | 需 hooks | 子槽 ✅ / 主面板 ❌ | ✅ |
| 文件树标色 | hooks 后恢复 | 子槽 ✅ / 主面板降级 | ✅ |
| 委派台账 | MCP 后重建 | 子槽 ✅ | ✅ |
| 改造量 | 大 | 中 | 小 |
| 主要风险 | hooks/MCP 生态差异 | 两形态并存的心智负担 | 仍不是真交互 |

## 4. 推荐路线（已采纳：B）

**按 B 落地**：主面板原生交互，委派子槽 headless；MCP 负责「agent 主动外包」；hooks 属于后续补强（用 A 的手段补 B 的观测缺口），不是另起一条全原生单轨。C 只作为需要结构化多轮时的可选模式，不做主形态。

理由：
1. 用户要的「原生交互」用最小改动恢复——适配器加 `mode`，主面板直接跑原生 argv；
2. 委派子槽本来就是机器任务，headless 是对的形状，现有台账/回执不用推倒；
3. 文件树/委派在交互态的缺口，用 hooks + MCP 补，而不是假装还有；
4. C 能救「结构化多轮」，但救不了「原生体验」，不该当主形态。

### 里程碑

**M1 恢复交互态（不改委派）**
- `Adapter.build_argv(..., mode)`：`interactive` / `headless`；`interactive` 用原生 argv（qwen 用 `-i` 带初始任务，claude 位置参数，codex 直接 `codex`）。
- 前端：面板内输入直通 PTY；「派任务」入口明确是「新建 headless」；交互态不再出现「已结束 → 重开」的一次性语义。
- 忙锁拆分：headless 任务锁保留；交互态输入不拦、不记 busy。
- 验收：同一面板连续两轮提问，上下文延续；刷新/断连重连画面不丢；Ctrl-C 中断正常。

**M2 双轨与身份**
- 会话记录 agent 自己的 session id（claude/qwen `--resume`、codex `exec resume`），与 sid 显式映射。
- 面板头标注 `交互 / 无头`；切模式时明确「续会话」还是「新开」。
- `ended` 语义按模式区分：交互态进程退出=会话结束；无头=一轮任务完成。

**M3 把编排接到原生 agent**
- MCP server：`delegate_task(target, prompt)`、`list_sessions()`、`file_marks()`。
- hooks：claude PostToolUse/PreToolUse、qwen hooks 回调控制台，恢复文件树标色与 busy 提示。
- 委派回执走 MCP tool result，进 agent 上下文，P2 自解。

## 5. 取舍与风险（必须承认的）

- 交互 TUI 常用 alternate screen，xterm 回放/搜索要按 buffer 处理，`fit`/resize 必须准。
- 权限弹窗在面板里，用户不看时会卡住任务；多面板要处理焦点。
- 交互态没有 JSONL → 文件树不标色、房间条不显示 busy，这是能力缺口，不是 bug。
- 不要把两种形态塞进同一个进程：`-p` 进程不读 stdin（prompt 在 argv），硬写只会丢字节。
- 控制台 sid 与 agent session id 是两套身份，不能混用；迁移/续会话必须显式转换。

## 6. 决策（2026-11-17，用户拍板）

**走 B：双轨。**

1. 默认形态 = B。知名 CLI agent（claude / codex / qwen）在主面板保持**原生交互体验**（多轮、上下文、权限弹窗、slash 命令），控制台只做外壳；委派子槽保持 headless（`-p / exec`）承担结构化台账。
2. 「外包模式」是系统主打功能：**由 agent 自己判断、或被用户告知要分工时主动调用**。实现通道不限，MCP 或技能均可，能实现即可。
3. 结构化事件属于「尽量提供」的能力，**不得为了好拿事件而改变 agent 的体验方式**。
4. 交互态第一阶段接受降级：文件树标色、房间条 busy、委派台账自动解析暂缺（hooks 未接），不视为 bug。
5. 身份主从（控制台 sid vs agent session id）仍未定，留到 M2。
6. C（常驻 stream-json）不作为主形态保留；若未来需要「结构化多轮」，作为可选模式再加。

### 已落地（M1 + M3a）

- 适配器：`interactive` 标记 + `build_argv(mode, sid)`；claude/codex/qwen 交互态走原生 argv，`stub` 固定 headless 守门。
- 终端：`PtySpec.mode` 贯通；session 首帧带 `mode`；交互态不解析 JSONL、不设任务忙锁；`/api/sessions`、`available_profiles` 暴露 `interactive`/`mode`。
- MCP 桥：`console/bridge.py` + `scripts/mcp_delegate.py`，向 claude/codex/qwen 注入 `agentcli.delegate_task`，经 `/api/delegate/`（进程内 token 校验）落到 `delegation.dispatch`，回执作为 tool result 回到 agent 自己的上下文。
- 前端：交互 agent 可空任务「开会话」，headless 仍必填；重开逻辑按 `interactive` 放行。

### 验收记录

- 真实 claude 原生 TUI：同一 sid 连续两轮（`OK` → `OK2`），上下文延续。
- MCP 外包全链路：claude 在 TUI 里调用 `delegate_task`（target=stub，prompt=`leaf:mcp-ok`），子槽 headless 跑完返回 `leaf-ok:mcp-ok`，回执显示在 claude 会话里，台账 `status=done`。
- 桩回归 `scripts/check_delegation.py` 全绿；`manage.py check`、typecheck、build 通过。
- codex / qwen 仅验证了交互 TUI 能起、codex 的 MCP 配置可被 `codex mcp list` 解析；两者 TUI 内的工具调用尚未实测。

## 7. 尚未做（按 B 路线继续）

1. hooks：claude PostToolUse / qwen hooks 回调控制台，恢复交互态文件树标色与 busy 提示。
2. codex / qwen 原生 TUI 内的 `delegate_task` 实测（codex 首次进入有 trust 弹窗，属原生行为）。
3. M2 身份映射：`--resume` / `exec resume` 与控制台 sid 的显式绑定。
4. 外包开关的 UX：交互态系统提示已告知工具存在，开关关闭时调用会拿到明确失败原因；是否改为「按会话默认开」待定。
5. token / BASE_URL 仍是进程内单例，多 worker 失效；P4 鉴权与多用户隔离未做。
