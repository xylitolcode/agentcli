/** 前后端共用契约。这里改了，Django 侧的 JSON 也得跟着改。 */

export type Profile = {
  name: string
  /** 可执行文件绝对路径，用来做 title 提示 */
  path: string
  /** agent 是否支持原生交互（可空着开、多轮对话）；false 时只能一次性任务 */
  interactive?: boolean
  /** agent 必须带初始任务才能起；shell 可以空着开 */
  kind: 'agent' | 'shell' | string
  /** 后台配置的展示名（admin 可改），没配时用 name */
  label?: string
}

export type Project = {
  id: string
  name: string
  path: string
  /** 该项目的偏好 agent（profile 名） */
  agent: string
  /** 目录还在不在 */
  exists: boolean
}

export type FileEntry = {
  name: string
  /** 相对项目根的路径；软链越界时为 null */
  path: string | null
  type: 'dir' | 'file'
  size: number | null
  mtime: number
  hidden: boolean
  link: boolean
  /** 软链指向项目目录之外，不可展开 */
  blocked: boolean
}

export type DirListing = {
  ok: boolean
  root: string
  path: string
  entries: FileEntry[]
  total: number
  truncated: boolean
}

/** 只读代码查看器的响应；binary 时 content 为空 */
export type FileContent = {
  ok: boolean
  path: string
  size: number
  mtime: number
  truncated: boolean
  binary: boolean
  encoding: string
  content: string
  lines: number
  error?: string
}

/** 搜索命中行；spans 是命中的列区间（相对 text），前端据此上色 */
export type SearchHit = {
  path: string
  line: number
  col: number
  text: string
  spans: [number, number][]
}

export type SearchGroup = {
  path: string
  count: number
  hits: SearchHit[]
}

export type SearchFile = {
  path: string
  name: string
}

/** /api/search/ 的响应体；mode 决定 groups 与 files 哪个有值 */
export type SearchResult = {
  ok: boolean
  query: string
  mode: 'content' | 'file' | string
  root: string
  groups?: SearchGroup[]
  files?: SearchFile[]
  total: number
  truncated: boolean
  error?: string
}

/** agent 动过的文件：读过标蓝，写过标黄；git 状态由 git 快照补充 */
export type FileMark = {
  read: boolean
  write: boolean
  git?: string
}

export type GitFile = {
  path: string
  code: string
  kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' | string
  staged: boolean
  unstaged: boolean
  from?: string
}

export type GitCommit = {
  hash: string
  author: string
  when: string
  subject: string
}

export type GitSnapshot = {
  ok: boolean
  repo: boolean
  root?: string
  branch?: string
  head?: string
  detached?: boolean
  upstream?: string
  ahead?: number
  behind?: number
  files: GitFile[]
  commits: GitCommit[]
  truncated?: boolean
  error?: string
}

/** diff 行：t=空格是上下文，- 是删除，+ 是新增；old/new 是各自侧的行号 */
export type DiffLine = {
  t: ' ' | '-' | '+'
  text: string
  old?: number
  new?: number
}

export type DiffHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** @@ 后面的函数上下文，可能为空 */
  header: string
  lines: DiffLine[]
}

/** 单文件 diff；hunks 为空且 empty=true 表示当前模式没有差异 */
export type FileDiff = {
  ok: boolean
  path: string
  mode: 'worktree' | 'staged' | 'unstaged' | string
  kind?: string
  repo: boolean
  binary: boolean
  truncated: boolean
  empty: boolean
  hunks: DiffHunk[]
  stats: { add: number; del: number }
  error?: string
}

export type SessionInfo = {
  sid: string
  profile: string
  role: 'root' | 'child' | string
  parent: string
  label: string
  depth: number
  /** interactive：原生 TUI；headless：一次性任务 */
  mode?: string
  delegation: string
  cwd: string
  eof: boolean
  pinned: boolean
  watchers: number
  busy: boolean
  busy_kind: string
  outsourcing: boolean
}

/* ---------------- WebSocket 文本帧（控制消息） ---------------- */

export type ControlMessage =
  | { type: 'session'; sid: string; mode?: string; resumable?: boolean; outsourcing?: boolean }
  | { type: 'session-eof'; pending?: number }
  | { type: 'session-missing' }
  | { type: 'file-events'; files: Record<string, FileMark> }
  | { type: 'agent-event'; event: { kind: string; file?: string; action?: string } }
  | { type: 'delegate-result'; delegation: Record<string, string> }
  | { type: 'input-rejected'; reason?: string }
  | { type: 'rerun-error'; sid?: string; reason?: string }

/** Django 模板注入的启动数据 */
export type Bootstrap = {
  rootPath: string
  rootName: string
  profiles: Profile[]
  projects: Project[]
  defaultProfile: string
}

export type ConnStatus = 'connecting' | 'online' | 'offline' | 'ended'

export type RenderMode = 'webgl' | 'dom'
