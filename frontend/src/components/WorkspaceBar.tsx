import { AnimatePresence, motion } from 'motion/react'

import { EASE } from '../motion'
import type { SessionInfo } from '../types'
import { RoomBar } from './RoomBar'

type Props = {
  /** 当前活动面板的 profile 名与 sid 短号：舞台头只回答「现在看的是谁」 */
  activeProfile: string
  activeSid: string | null
  outsourcing: boolean
  sessions: SessionInfo[]
  panelCount: number
  maxPanels: number
  onToggleOutsourcing: () => void
  onOpenSession: (session: SessionInfo) => void
  onCloseAll: () => void
}

/**
 * 舞台顶条：一行状态，不是工具栏。
 *
 * agent 入口搬去了左侧 rail（能力位和操作位分离），这里只留「现在在跑什么」
 * 和全局开关：外包模式、房间里的会话、面板计数。没有按钮排成一行。
 */
export function WorkspaceBar({
  activeProfile,
  activeSid,
  outsourcing,
  sessions,
  panelCount,
  maxPanels,
  onToggleOutsourcing,
  onOpenSession,
  onCloseAll,
}: Props) {
  return (
    <div className="stage-bar">
      <span className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-ghost">stage</span>
      <span className="shrink-0 text-[11.5px] text-fg">
        {activeProfile || '—'}
        {activeSid && <span className="text-ghost"> #{activeSid.slice(-4)}</span>}
      </span>

      <RoomBar sessions={sessions} activeSid={activeSid} onOpen={onOpenSession} />

      <span className="ml-auto flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onToggleOutsourcing}
          aria-pressed={outsourcing}
          title="开启后允许 agent 之间一对一外包派发"
          className={
            'inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-px text-[10px] transition-colors ' +
            (outsourcing
              ? 'border-accent text-accent'
              : 'border-line text-faint hover:text-dim')
          }
        >
          <i
            aria-hidden
            className={'size-1 ' + (outsourcing ? 'bg-accent pulse-dot' : 'bg-faint')}
          />
          外包
        </button>

        <span
          className="flex items-center text-[10px] text-faint"
          title="一个面板 = 一条 WebSocket = 一个前台会话"
        >
          {/* 计数是个位表：数字向上滚一位，宽度写死 1ch，不推挤右边的按钮 */}
          <span className="relative inline-block w-[1ch] text-right">
            <AnimatePresence initial={false}>
              <motion.span
                key={panelCount}
                className="absolute inset-0 text-right"
                initial={{ y: 6, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -6, opacity: 0 }}
                transition={{ duration: 0.16, ease: EASE }}
              >
                {panelCount}
              </motion.span>
            </AnimatePresence>
          </span>
          /{maxPanels}
        </span>

        {panelCount > 1 && (
          <button
            type="button"
            onClick={onCloseAll}
            className="rounded-[2px] px-2 py-0.5 text-[10px] text-faint hover:bg-line-soft hover:text-dim"
          >
            关闭全部
          </button>
        )}
      </span>
    </div>
  )
}
