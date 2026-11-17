import type { SessionInfo } from '../types'

type Props = {
  sessions: SessionInfo[]
  currentSid: string | null
}

/**
 * 房间里的所有会话。子会话显示成 `↳ 名字` —— 常驻槽的 sid 不随任务变，
 * 这样父子关系一眼看得出来。
 */
export function RoomBar({ sessions, currentSid }: Props) {
  // 进程已退出的槽不占版面，它们只是等着被回收
  const live = sessions.filter((session) => !session.eof)
  if (live.length === 0) return null

  return (
    <span className="flex items-center gap-1.5">
      {live.map((session) => {
        const isSelf = session.sid === currentSid
        const isChild = session.role === 'child'
        const label = isChild ? `↳ ${session.label || session.profile}` : session.profile
        const activity = session.busy
          ? session.busy_kind === 'delegate'
            ? '外包中'
            : '干活中'
          : '待命'

        return (
          <span
            key={session.sid}
            title={`${session.sid}${session.cwd ? ' · ' + session.cwd : ''}`}
            className={
              'inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10.5px] ' +
              (isSelf ? 'border-[#1f3a5c] text-accent' : 'border-line text-dim') +
              (isChild ? ' opacity-80' : '')
            }
          >
            <i
              className={
                'size-1 rounded-full ' +
                (session.busy ? 'bg-ok shadow-[0_0_5px_var(--color-ok)]' : 'bg-faint')
              }
            />
            <span>{label}</span>
            <span className="text-faint">{activity}</span>
          </span>
        )
      })}
    </span>
  )
}
