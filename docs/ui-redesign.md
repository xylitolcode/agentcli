# agentcli 前端重构方向：从「控制台」到「活体进程台」

> 状态：设计提案，未写代码。落地前需要拍板的三件事在最后一节。
> 范围：`frontend/`（React 19.3 + Vite 8 + Tailwind 4.3 + xterm 6）。后端与协议不动。

## 0. 一句话结论

现在这套 UI 的问题不是配色，是**骨架**：`header + 圆角卡片网格 + footer 状态栏` 就是后台管理系统的语法。
重构的核心动作是把「功能平铺的容器」换成「**一个正在运行的进程**」：单一焦点、时间为主轴、状态用光表达。

## 1. 诊断：管理后台味/SaaS 味到底从哪来

对照现有代码，四个结构性来源：

| 来源 | 代码证据 | 为什么读起来像后台 |
|---|---|---|
| 壳层布局 | `Header.tsx` 顶栏 + `StatusBar.tsx` 底栏 | 顶栏放品牌+搜索、底栏放只读状态 = 后台框架的固定配方 |
| 卡片容器 | `App.tsx` 的 `rounded-[10px] border bg-panel` | 一切都先装进一个盒子，盒子之间是等价的 → 功能清单感 |
| 密度均匀 | 每个面板都有标题栏、状态点、按钮 | 没有焦点，眼睛没有落点，所有信息都在抢注意力 |
| 无时间维度 | 只有 120ms 的 notice 入场动画 | 界面是「静态表格」，而 agent 产品本质是「一条流」 |

另一个隐性问题是身份：`#0d1117 / #58a6ff` 就是 GitHub Dark 原色。用户看到的不是「agentcli」，
而是「GitHub 的一个仿制品」—— 这是最贵的 SaaS 味：**没有自己的视觉指纹**。

## 2. 设计命题与三原则

命题：**Console of a Living Process（活体进程台）**。参照系不是管理后台，是终端、示波器、望远镜控制台、
Cursor/Warp 这类「工具本身有存在感」的界面。

1. **单一焦点**：任何时刻屏幕只有一个主演（当前会话），其余退成背景。像终端里只有当前进程占满输出。
2. **时间是主轴**：信息沿纵向流动；滚动的会话头会折叠成 HUD 条，而不是永远钉死的工具栏。
3. **状态是物理的**：连接/思考/调工具/等权限，用光、脉冲、扫描、呼吸表达，不用一排文字标签。

## 3. 布局重构：stage + rail

```
┌──────────────────────────────────────────────────┐
│  ░ HUD 条（细、半透明、可滚动折叠）                │
│  agentcli / 项目名 / 分支 · 会话状态 · telemetry   │
├───────────────┬──────────────────────────────────┤
│               │                                  │
│  agent rail   │        STAGE（主舞台）            │
│  竖窄条 56px   │   当前会话终端，全幅，无卡片边框    │
│  ├ claude ●   │                                  │
│  ├ codex  ○   │                                  │
│  ├ qwen   ◐   │                                  │
│  └ shell  +   │                                  │
│               │                                  │
├───────────────┴──────────────────────────────────┤
│  召唤层：Cmd+K 文件/搜索/Git/HUD 抽屉（按需滑入）   │
└──────────────────────────────────────────────────┘
```

关键改动：

- **删掉卡片**。主舞台直接贴底，只用 1px 发光细线分区，不用圆角、不用 box-shadow。
- **状态栏消失**。`StatusBar` 的内容（连接态、渲染后端、cols×rows、字体命中）并进 rail 底部和 HUD 条，
  它现在的职能是「让用户安心」，不是「展示字段」。
- **文件树 / Git / 搜索从常驻变成召唤**。它们现在是常驻卡片，占了 330px 宽还一直抢视觉；
  改成 `Cmd+K` 或快捷键唤起的 HUD 抽屉（带 2px backdrop blur），用完即走。
  终端里的路径注入能力保留（查看器底部的按钮）。
- **多会话不做卡片网格**。`panel-grid` 的 1/2/3 列卡片是后台味的最大来源。
  主形态改为 rail 上的「频道切换」（点谁谁上舞台），需要并看时再开 tmux 式分屏：
  纯细线分割、无间距、无圆角、每格左上角一个 10px 大写标签。
- **空状态 = 开机**。没有会话时不是「请点上面按钮」一行灰字，而是一块神经核心（见 §5 L2）。

## 4. 视觉语言：token 草案

不做「更暗的 GitHub」，做**磷光 CRT**：单色底 + 一个发光强调色 + 极细线。

```css
@theme {
  /* 底：比 GitHub 更冷、更黑，给光留出对比空间 */
  --color-ink-0: #04070b;   /* 页面底 */
  --color-ink-1: #070c12;   /* 舞台 */
  --color-ink-2: #0c141d;   /* 抬起层 */

  /* 线：不用灰色，用极低透明度的强调色 —— 看起来像发光体而不是边框 */
  --color-wire: rgba(110, 243, 200, 0.14);
  --color-wire-hot: rgba(110, 243, 200, 0.42);

  /* 强调：磷光青（主），琥珀（注意力/警告），红（错误） */
  --color-phos: #6ef3c8;
  --color-amber: #ffb454;
  --color-err: #ff5f57;

  /* 文本 */
  --color-fg: #dfe9f0;
  --color-dim: #8ba0b2;
  --color-faint: #4f6274;

  /* 形状：0 或 2px，切角用 clip-path，不要 10px 圆角 */
  --radius-hud: 2px;
}
```

- **字体**：等宽为主（JetBrains Mono / 现有 Sarasa Term SC Nerd 终端保留），
  HUD 标签用 10px 大写 + `letter-spacing: 0.12em`；中文标题再引一款 Noto Sans SC（不用等宽），
  形成「机器语言 vs 人语言」的对比。所有字体自托管。
- **动效曲线**：`cubic-bezier(0.2, 0.9, 0.1, 1)`，150–220ms；弹簧 `stiffness 260 / damping 30`。
- **对比度红线**：正文对底色 ≥ 7:1。磷光色只做强调和线，**不用来写正文**（低端屏会糊）。

## 5. 特效分级（按成本从 0 到高，可独立上线）

### L0 · 纯 CSS（零依赖，先做这层就能甩掉一半后台味）

- 分隔线：1px + 渐隐发光，两端淡出（`mask-image: linear-gradient`），不是实心灰线。
- 扫描线：`repeating-linear-gradient` 1px/3px，`opacity: .04`，只铺在 HUD 和空态上，不铺终端。
- 噪点：一张静态 SVG `feTurbulence` data-URI，`opacity: .03`，防「纯数字黑」的廉价感。
- 状态呼吸：在线点 2.4s `ease-in-out` 呼吸；思考态是三条不同相位的短脉冲。
- 进场：`clip-path: inset(...)` 擦除式出现，替代现在的淡入位移。
- 边光：hover 时 conic-gradient + mask 沿边框走一圈（「电镀」感），只在可交互区域用。

### L1 · Motion（声明式动效）

- 会话切换用 `layoutId` 从 rail 的小块 morph 到舞台 —— 观感上是「镜头推近」，不是「换了个页面」。
- 抽屉 spring 滑入 + backdrop 模糊；关闭用 collapse 不用 fade。
- 事件流进入 stagger 60ms，只动前 10 项（后面的交给虚拟滚动）。
- token 计数、上下文占用用 `animate()` 数字滚动。

### L2 · WebGL（严格限定，只做气氛）

- **空态神经核心**：instanced points + 连线 + 缓慢呼吸 + bloom。这是整个界面唯一允许「炫」的地方。
- **背景场**：极低频点阵/地平线，`opacity ≤ 0.15`，只在舞台空白区出现。
- 纪律：单独 canvas、限 30fps、`visibilitychange` / `IntersectionObserver` 暂停、
  `prefers-reduced-motion` 直接换成静态图；**3D 绝不进主工作区**（会和 xterm 的 WebGL 抢 GPU）。

### L3 · 声音（可选，默认静音）

WebAudio 合成的连接音/完成音，一次 80ms，默认关，开关放 HUD 设置里。没有就用 CSS 和 Motion 撑住。

## 6. 库选型（已核对 2026-11 生态状态）

原则：**不动地基，只换表达层**。React / Vite / Tailwind / xterm 全部保留，新依赖逐层加、可回滚。

| 层 | 选 | 版本/状态 | 为什么 | 备选与取舍 |
|---|---|---|---|---|
| 动效 | `motion` | 14.12.0，MIT，导入 `motion/react` | 原 Framer Motion，layout/spring/gesture 一体，React 19 原生支持；`AnimateView` 要求 React 19.3+，本项目正好 19.3.1 | `anime.js` v4 做时间轴开场；GSAP 能力最强但体量大 |
| 3D | `three` + `@react-three/fiber` 9 + `@react-three/drei` + `@react-three/postprocessing` | R3F v9 对应 React 19（v10 仍是 alpha） | 你已有 Three.js 底子；postprocessing 给 bloom，Retro-Futuristic 的灵魂 | `ogl` 更小，适合单个 shader 背景；不想引 3D 就用 L0/L1 |
| 无样式原语 | `@base-ui/react` | 1.8.0（2026-09） | Radix 团队后继，完全无样式，可 100% 自绘；不带来任何默认审美 | `radix-ui` 也行；**不要** shadcn 默认主题 |
| 抽屉 | Base UI `Drawer` | 1.3.0 起稳定 | 少一个依赖，手势/焦点/滚动锁都齐 | `vaul` 也可以，但功能重叠 |
| 命令面板 | `cmdk` | 成熟稳定 | ⌘K 是 AI 工具的标准入口：切 agent、跳文件、跑命令 | Base UI Combobox 自组，工作量大 |
| 虚拟滚动 | `@tanstack/react-virtual` | 成熟 | 长日志/长文件/事件流必须虚拟化，否则 3 秒就卡 | 自写 windowing 不值 |
| 状态 | `zustand`（**暂不引入**） | — | 现在 hooks + localStorage 够用；等面板状态真的爆炸再上 | 先保持现状 |
| 高亮 | 保留 `highlight.js` 11.12 | v11.11+（2026-06） | CodeViewer 的大文件运行时高亮，它最均衡 | `shiki` 4.4 保真度最高但冷启动 ~182ms、HTML 体积大 3 倍，只适合 Markdown 代码块 |
| 代码查看器 | 现有自绘 + 虚拟滚动 | — | 407 行已能用，不值得换 Monaco | CodeMirror 6 可做只读升级，成本中等 |
| 图标 | `lucide-react` + 少量自绘像素图标 | — | 1px 线性图标不抢戏；自绘像素图标做品牌点缀 | 彩色/填充图标集一律不用 |
| 字体 | `@fontsource/jetbrains-mono`、`@fontsource-variable/noto-sans-sc` | — | 自托管，Docker 离线可用；不依赖 Google Fonts CDN | Departure Mono 可做 HUD 装饰字，可选 |
| 遥测小图 | `uplot` | — | token/s、上下文占用这种高频时序图，uPlot 最省 | 手绘 SVG 也够，先不做 |
| 测试 | `vitest` + `@testing-library/react` | — | 现有 CI 只有 typecheck/build，加最小行为测试 | Playwright 视觉回归可选 |

## 7. 明确拒绝清单（SaaS 味/后台味的来源）

`antd`、`@mui/material`、`@chakra-ui/react`、shadcn 默认主题与 Tailwind UI 模板、`chart.js` 默认样式、
任何「圆角卡片 + 阴影 + 主色按钮」的组件库。不是它们不好，是它们的默认审美就是这套要甩掉的东西。

## 8. 落地阶段（每阶段可独立发布与回滚）

| 阶段 | 内容 | 新增依赖 | 验收 |
|---|---|---|---|
| P0 骨架 | token 重写、stage+rail、删卡片、状态栏并入 HUD | 0 | typecheck/build；所有现有交互路径手测一遍；截图前后对比 |
| P1 动效 | Motion 接管面板 morph、抽屉、事件 stagger、数字 | `motion` | 切换/开关无布局跳动；流式输出时不动画；`reduced-motion` 生效 |
| P2 气氛 | 空态神经核心 + 背景场 + bloom | `three` `@react-three/fiber` `drei` `postprocessing` | 空闲帧时间预算；切到后台自动暂停；低端 GPU 降级 |
| P3 入口 | ⌘K 命令面板、虚拟滚动、Markdown 代码块高亮升级 | `cmdk` `@tanstack/react-virtual`（`shiki` 可选） | 2000+ 条搜索结果不卡；键盘全链路可达 |
| P4 遥测 | token/s、上下文占用迷你图 | `uplot` | 数据缺省时不画空图 |

## 9. 风险与红线

1. **WebGL 上下文数量**：xterm 每个面板一个 WebGL 上下文（已限 6 个），叠加背景 canvas 后逼近浏览器上限。
   背景 canvas 必须单例，且在无会话/不可见时销毁重建。
2. **焦点与键盘**：HUD 抽屉绝不能吞掉终端的键盘输入。抽屉用 `inert` + 显式焦点陷阱，Esc 只关最上层。
3. **对比度**：0.5px 发光细线在低端屏会消失。线只做分区，不承载信息；信息一律有文字或形状兜底。
4. **流式输出时禁止 layout 动画**：token 逐字重排和 layout animation 会打架，只有会话切换才动布局。
5. **字体回退**：中文等宽缺失时字宽错位，现有 `fontOk` 检测要保留，并降级成 Noto Sans SC。
6. **双份 token**：Tailwind v4 `@theme` 是唯一来源，不要另写一套 SCSS 变量，否则改色要改两处。

## 10. 需要你拍板的三件事

1. **强调色**：磷光青 `#6ef3c8`（推荐，最像仪器）／ 琥珀 `#ffb454`（更暖、更复古）／ 保留 GitHub 蓝（最安全但最没身份）。
2. **3D 范围**：只做空态（推荐，成本可控）／ 空态 + 背景场 ／ 完全不引 3D（只用 CSS+Motion）。
3. **多会话形态**：rail 频道切换（推荐）／ 频道 + 可选 tmux 分屏 ／ 保留现在的卡片网格。

## 11. 实施记录（滚动更新）

| 阶段 | 提交 | 落地情况与偏差 |
|---|---|---|
| P0 | `2643bb7` | 按计划落地；`StatusBar` 并入 HUD 后删除 |
| P1 | `b7552f7` | 按计划落地；`motion` 带来约 160 kB |
| P2 | 本轮 | **只用 `three` + `@react-three/fiber`**，未引 `drei`，未引 `postprocessing` |
| P3 | 本轮 | ⌘K 命令面板 + 结果虚拟滚动 + 文件/Git 改召唤抽屉；`Splitter` 删除 |

P2 的三处主动偏差，原因如下：

1. **bloom 换成 sprite 径向渐变**。`postprocessing` 的 `EffectComposer` 在 `alpha: true` 的透明 canvas 上清屏会带出黑底，且要多一条后处理管线。改为：中心"源点"用 `CanvasTexture` 径向渐变 sprite + 加法混合，外圈柔光用 CSS `.core-halo`，视觉近似、成本几乎为零。`@react-three/postprocessing` 已从依赖里移除。
2. **three 走动态 import 独立成 chunk**（`StageCore3D-*.js`，约 923 kB / gzip 245 kB）。只在空态才下载，有会话的路径完全不受影响；开面板时组件卸载，WebGL 上下文随之释放（红线 1）。
3. **限帧与暂停**：`frameloop="demand"` + 33 ms 定时器 `invalidate()`（约 30fps），`document.hidden` 时跳过点名，`visibilitychange` 恢复后补一帧。不用满帧 rAF。

降级链路有三层：无 WebGL2 或 `hardwareConcurrency < 4` → CSS 同心圆；`prefers-reduced-motion: reduce` → 同一套 CSS 同心圆；两者都通过时才挂 3D。截图见 `docs/ui/p2-stage-3d.png`、`docs/ui/p2-stage-static.png`。

P3 的四点：

1. **不用 `Command.Dialog`**。`cmdk` 只负责过滤、分组与键盘导航，浮层自己用 `motion` 包（`fixed inset-0 z-50` + 2px backdrop），外壳和 SearchPane / CodeViewer 是同一套 HUD 语汇。这样面板看起来属于这台机器，而不是一个第三方组件。
2. **快捷键必须走捕获阶段**。焦点在终端时 xterm 先处理 `Ctrl+K`，把 `0x0B` 发给 bash，window 冒泡监听根本收不到（首轮实测就是这个现象：面板不弹，命令行还被清空）。改成 `addEventListener('keydown', onKey, true)` 并 `stopPropagation()`，Ctrl+K / Ctrl+B / Ctrl+Shift+F 才在任何焦点下都生效。
3. **右列变抽屉后舞台才真正全幅**。同一窗口下终端从 214×33 变成 262×34 列 —— 折展文件树不再推挤终端宽度，`--tree-w`、拖拽条和 `Splitter.tsx` 一并删除。
4. **虚拟滚动实测到 388 条**（搜 `e`，后端 `rg` 结果截断后返回 388 处 / 7 个文件），滚动与键盘 ↑↓ 跟手、group/hit 两种行高都正确。2000+ 条的验收点**未实测**：后端搜索上限暂时到不了那个量级，只验证了机制。`shiki` 高亮升级也没做 —— 体积加 wasm 依赖，`highlight.js` 的观感在这个字号下够用。

截图见 `docs/ui/p3-palette.png`（命令面板）、`docs/ui/p3-dock.png`（文件/Git 抽屉）。
