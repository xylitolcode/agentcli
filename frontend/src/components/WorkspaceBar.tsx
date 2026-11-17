import type { Profile, SessionInfo } from '../types'
import { RoomBar } from './RoomBar'

/**
 * 顶栏固定的三个 agent。顺序写死，不随项目偏好或探测结果浮动 —— 它们是
 * 这个控制台的能力位，缺哪个就灰掉哪个，而不是悄悄消失。
 */
const PINNED_AGENTS = ['claude', 'codex', 'qwen'] as const

type Props = {
  profiles: Profile[]
  /** 已有主面板的 profile（子会话不算）：用来把按钮标成「已开」，点一下是切过去 */
  openProfiles: string[]
  activeProfile: string
  outsourcing: boolean
  sessions: SessionInfo[]
  activeSid: string | null
  panelCount: number
  maxPanels: number
  onPickAgent: (profile: string) => void
  onNewShell: () => void
  onToggleOutsourcing: () => void
  onOpenSession: (session: SessionInfo) => void
  onCloseAll: () => void
}

/**
 * 工作区顶栏：三个固定 agent 入口 + 新终端 + 房间快照。
 *
 * 早期版本这里是一排 profile 标签，P3 多面板时换成了「下拉 + 首条消息 + 派任务」
 * 的表单，三个 agent 反而藏起来了。现在退回去：点 agent 按钮直接开一个交互会话，
 * 空着开，进它自己的 TUI 再聊 —— 首条消息输入框没有存在价值。
 */
export function WorkspaceBar({
  profiles,
  openProfiles,
  activeProfile,
  outsourcing,
  sessions,
  activeSid,
  panelCount,
  maxPanels,
  onPickAgent,
  onNewShell,
  onToggleOutsourcing,
  onOpenSession,
  onCloseAll,
}: Props) {
  const byName = new Map(profiles.map((p) => [p.name, p]))
  const shell = profiles.find((p) => p.kind === 'shell')
  const full = panelCount >= maxPanels

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line bg-panel px-2.5 py-1.5">
      <span className="mr-0.5 text-[10px] uppercase tracking-wide text-ghost">agent</span>

      {PINNED_AGENTS.map((name) => {
        const profile = byName.get(name)
        const open = openProfiles.includes(name)
        const active = activeProfile === name
        // 满了还能切到已开的面板；只有「新开」才被上限挡住
        const disabled = !profile || (full && !open)
        const title = !profile
          ? `${name} 未安装（PATH 里找不到）`
          : active
            ? `${name} · 当前面板`
            : open
              ? `${name} · 已开，点一下切过去`
              : full
                ? `面板已满（上限 ${maxPanels}），先关掉几个`
                : `${name} · 点一下开会话，进 TUI 再聊`

        return (
          <button
            key={name}
            disabled={disabled}
            onClick={() => onPickAgent(name)}
            title={title}
            className={
              'inline-flex items-center gap-1 rounded-[5px] border px-2 py-[3px] text-[11px] leading-4 transition-colors ' +
              (active
                ? 'border-accent bg-[#0e1a26] text-accent'
                : open
                  ? 'border-[#1f3a5c] text-fg hover:bg-line-soft'
                  : 'border-line text-faint hover:bg-line-soft hover:text-fg') +
              ' disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent'
            }
          >
            {open && <i className="size-1 rounded-full bg-current opacity-70" />}
            {name}
          </button>
        )
      })}

      <button
        onClick={onNewShell}
        disabled={!shell || full}
        title={!shell ? '没有可用的 shell' : full ? `面板已满（上限 ${maxPanels}）` : '开一个系统终端'}
        className="rounded-[5px] border border-line px-2 py-[3px] text-[11px] text-dim hover:bg-line-soft hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
      >
        + 终端
      </button>

      <span className="ml-auto flex flex-wrap items-center gap-1.5">
        <button
          onClick={onToggleOutsourcing}
          aria-pressed={outsourcing}
          title="开启后允许 agent 之间一对一外包派发"
          className={
            'inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10.5px] ' +
            (outsourcing
              ? 'border-[#1f3a5c] bg-[#0e1a26] text-accent'
              : 'border-line text-faint hover:text-dim')
          }
        >
          <i className={'size-1 rounded-full ' + (outsourcing ? 'bg-accent' : 'bg-faint')} />
          外包模式
        </button>

        <RoomBar sessions={sessions} activeSid={activeSid} onOpen={onOpenSession} />

        <span
          className="text-[10.5px] text-faint"
          title="一个面板 = 一条 WebSocket = 一个前台会话"
        >
          {panelCount}/{maxPanels} 面板
        </span>

        {panelCount > 1 && (
          <button
            onClick={onCloseAll}
            className="rounded-[5px] px-1 py-px text-[10.5px] text-faint hover:bg-line-soft hover:text-dim"
          >
            关闭全部
          </button>
        )}
      </span>
    </div>
  )
}
