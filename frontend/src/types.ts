/** 前后端共用契约。这里改了，Django 侧的 JSON 也得跟着改。 */

export type Profile = {
  name: string
  /** 可执行文件绝对路径，用来做 title 提示 */
  path: string
  /** agent 是否支持原生交互（可空着开、多轮对话）；false 时只能一次性任务 */
  interactive?: boolean
  /** agent 必须带初始任务才能起；shell 可以空着开 */
  kind: 'agent' | 'shell' | string
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

/** agent 动过的文件：读过标蓝，写过标黄 */
export type FileMark = {
  read: boolean
  write: boolean
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
  | { type: 'session'; sid: string; mode?: string; outsourcing?: boolean }
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
