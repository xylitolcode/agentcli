import { motion } from 'motion/react'

import { SPRING } from '../motion'
import type { ConnStatus, Profile } from '../types'
import { BrandIcon } from './BrandIcon'

/** 顶栏固定的三个 agent。顺序写死：它们是能力位，缺哪个就灰掉哪个，不悄悄消失。 */
const PINNED_AGENTS = ['claude', 'codex', 'qwen'] as const

const STATUS_TEXT: Record<ConnStatus, string> = {
  connecting: '连接中',
  online: '在线',
  offline: '断开',
  ended: '已结束',
}

type Props = {
  profiles: Profile[]
  /** 已有主面板的 profile（子会话不算）：用来把按钮标成「已开」 */
  openProfiles: string[]
  activeProfile: string
  panelCount: number
  maxPanels: number
  /** 当前活动面板的连接状态，只在底部点一下灯 */
  status: ConnStatus
  onPickAgent: (profile: string) => void
  onNewShell: () => void
}

/**
 * 左侧 agent rail：一条竖着的「能力位」，不是工具栏。
 *
 * 点一下就占一个前台会话进 TUI，已有就切过去。上限只挡「新开」，
 * 切到已开的面板永远允许 —— 否则满 6 个之后连看都看不了。
 */
export function AgentRail({
  profiles,
  openProfiles,
  activeProfile,
  panelCount,
  maxPanels,
  status,
  onPickAgent,
  onNewShell,
}: Props) {
  const byName = new Map(profiles.map((profile) => [profile.name, profile]))
  const shell = profiles.find((profile) => profile.kind === 'shell')
  const full = panelCount >= maxPanels
  const shellOpen = !!shell && activeProfile === shell.name

  return (
    <nav className="agent-rail" aria-label="agent 能力位">
      {PINNED_AGENTS.map((name) => {
        const profile = byName.get(name)
        const open = openProfiles.includes(name)
        const active = activeProfile === name
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
            type="button"
            disabled={disabled}
            onClick={() => onPickAgent(name)}
            title={title}
            aria-label={title}
            aria-pressed={active}
            data-state={active ? 'active' : open ? 'open' : 'idle'}
            className="rail-slot"
          >
            {/*
             * 当前频道的发光竖条只有一条，靠 layoutId 在槽位之间滑动 ——
             * 「焦点搬家」而不是「两个槽位各自亮一下」。
             */}
            {active && (
              <motion.i aria-hidden layoutId="rail-cursor" transition={SPRING} className="rail-cursor" />
            )}
            <BrandIcon name={name} className="size-[21px]" />
            {open && (
              <i
                aria-hidden
                className={
                  'absolute bottom-1 right-1 size-1 ' +
                  (active ? 'bg-phos pulse-dot shadow-[0_0_6px_var(--color-phos)]' : 'bg-faint')
                }
              />
            )}
          </button>
        )
      })}

      <button
        type="button"
        onClick={onNewShell}
        disabled={!shell || full}
        title={
          !shell
            ? '没有可用的 shell'
            : full
              ? `面板已满（上限 ${maxPanels}）`
              : '开一个系统终端'
        }
        aria-label="开一个系统终端"
        data-state={shellOpen ? 'active' : 'idle'}
        className="rail-slot"
      >
        {shellOpen && (
          <motion.i aria-hidden layoutId="rail-cursor" transition={SPRING} className="rail-cursor" />
        )}
        <BrandIcon name="bash" className="size-[19px]" />
      </button>

      <span className="flex-1" />

      <div className="rail-meta" title={`一个面板 = 一条 WebSocket = 一个前台会话`}>
        <i
          aria-hidden
          className={
            'size-1 ' +
            (status === 'online'
              ? 'bg-phos pulse-dot shadow-[0_0_6px_var(--color-phos)]'
              : status === 'connecting'
                ? 'bg-warn'
                : status === 'offline'
                  ? 'bg-err'
                  : 'bg-faint')
          }
        />
        <span>{panelCount}/{maxPanels}</span>
        <span className="text-ghost">{STATUS_TEXT[status]}</span>
      </div>
    </nav>
  )
}
