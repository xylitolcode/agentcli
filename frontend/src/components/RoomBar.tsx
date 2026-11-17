import { AnimatePresence, motion } from 'motion/react'

import { EASE } from '../motion'
import type { SessionInfo } from '../types'

type Props = {
  sessions: SessionInfo[]
  activeSid: string | null
  onOpen: (session: SessionInfo) => void
}

const shortSid = (sid: string) => (sid ? sid.slice(0, 8) : '?')

/**
 * 房间里的所有会话。子会话显示成 `↳ 名字` —— 常驻槽的 sid 不随任务变，
 * 这样父子关系一眼看得出来。点一下就在工作区里打开（或切到）那个会话的面板。
 *
 * 已退出的会话也保留到后端回收（DEAD_TTL 30s）：点开还能看到它最后一眼输出，
 * 排查「子代理到底干了什么」全靠这个。
 */
export function RoomBar({ sessions, activeSid, onOpen }: Props) {
  if (sessions.length === 0) return null

  return (
    <motion.span layout className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {/* 新会话是事件流：前 10 个错开 30ms 依次亮起，后面的直接到位（不排队） */}
      <AnimatePresence initial={false}>
        {sessions.map((session, index) => {
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
          <motion.button
            key={session.sid}
            layout
            type="button"
            onClick={() => onOpen(session)}
            title={`${session.sid}${session.cwd ? ' · ' + session.cwd : ''}${parentHint}（点击打开面板）`}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: ended ? 0.55 : isChild ? 0.85 : 1, x: 0 }}
            exit={{ opacity: 0, x: -6, transition: { duration: 0.12, ease: EASE } }}
            transition={{ duration: 0.16, ease: EASE, delay: Math.min(index, 9) * 0.03 }}
            className={
              'inline-flex shrink-0 items-center gap-1 rounded-[1px] border px-1.5 py-[1px] text-[10.5px] transition-colors ' +
              (isSelf
                ? 'border-accent text-accent'
                : 'border-line text-dim hover:border-accent hover:text-fg')
            }
          >
            <i
              aria-hidden
              className={
                'size-1 ' +
                (ended
                  ? 'bg-faint'
                  : session.busy
                    ? 'bg-phos pulse-dot shadow-[0_0_5px_var(--color-phos)]'
                    : 'bg-faint')
              }
            />
            <span>{label}</span>
            <span className="text-ghost">#{tail}</span>
            <span className="text-faint">{activity}</span>
          </motion.button>
        )
        })}
      </AnimatePresence>
    </motion.span>
  )
}
