import type { SessionInfo } from '../types'

type Props = {
  sessions: SessionInfo[]
  activeSid: string | null
  onOpen: (session: SessionInfo) => void
}

const shortSid = (sid: string) => (sid ? sid.slice(0, 8) : '?')

/**
 * 房间里的所有会话。子会话显示成 `↳ 名字` —— 常驻槽的 sid 不随任务变，
 * 这样父子关系一眼看得出来。点一下就在工作区里打开（或切到）那个会话的面板，
 * 等于给每个会话开一块独立屏幕。
 *
 * 已退出的会话也保留到后端回收（DEAD_TTL 30s）：点开还能看到它最后一眼输出，
 * 排查「子代理到底干了什么」全靠这个。
 */
export function RoomBar({ sessions, activeSid, onOpen }: Props) {
  if (sessions.length === 0) return null

  return (
    <span className="flex items-center gap-1.5">
      {sessions.map((session) => {
        const isSelf = session.sid === activeSid
        const isChild = session.role === 'child'
        const ended = session.eof
        const label = isChild ? `↳ ${session.label || session.profile}` : session.profile
        const activity = ended
          ? '已结束'
          : session.busy
            ? session.busy_kind === 'delegate'
              ? '外包中'
              : '干活中'
            : '待命'
        const parentHint = isChild && session.parent ? ` · 父 ${shortSid(session.parent)}` : ''
        const tail = session.sid.slice(-4)

        return (
          <button
            key={session.sid}
            onClick={() => onOpen(session)}
            title={`${session.sid}${session.cwd ? ' · ' + session.cwd : ''}${parentHint}（点击打开面板）`}
            className={
              'inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10.5px] transition-colors ' +
              (isSelf
                ? 'border-[#1f3a5c] text-accent'
                : 'border-line text-dim hover:border-[#2a4a6b] hover:text-fg') +
              (isChild ? ' opacity-80' : '') +
              (ended ? ' opacity-50' : '')
            }
          >
            <i
              className={
                'size-1 rounded-full ' +
                (ended
                  ? 'bg-faint'
                  : session.busy
                    ? 'bg-ok shadow-[0_0_5px_var(--color-ok)]'
                    : 'bg-faint')
              }
            />
            <span>{label}</span>
            <span className="text-ghost">#{tail}</span>
            <span className="text-faint">{activity}</span>
          </button>
        )
      })}
    </span>
  )
}
