import { useEffect, useState } from 'react'

import type { Profile, SessionInfo } from '../types'
import { RoomBar } from './RoomBar'

type Props = {
  profiles: Profile[]
  /** 初始选中项：项目偏好 agent 或全局默认 */
  defaultProfile: string
  outsourcing: boolean
  sessions: SessionInfo[]
  activeSid: string | null
  panelCount: number
  maxPanels: number
  onSpawn: (profile: string, prompt: string) => void
  onToggleOutsourcing: () => void
  onOpenSession: (session: SessionInfo) => void
  onCloseAll: () => void
}

/**
 * 工作区顶栏：派任务 / 新终端 + 房间快照。
 *
 * 「派任务」是 agent 的唯一入口：agent 是非交互进程，任务写进 argv，
 * 一个任务一个会话；CLI 进程跑完就退，槽还在。shell 则是「新终端」。
 */
export function WorkspaceBar({
  profiles,
  defaultProfile,
  outsourcing,
  sessions,
  activeSid,
  panelCount,
  maxPanels,
  onSpawn,
  onToggleOutsourcing,
  onOpenSession,
  onCloseAll,
}: Props) {
  const [profile, setProfile] = useState(() =>
    profiles.some((p) => p.name === defaultProfile) ? defaultProfile : (profiles[0]?.name ?? 'bash'),
  )
  const [prompt, setPrompt] = useState('')

  // 换项目时项目偏好 agent 会变，跟着切默认 profile（用户明确选的也算一次重置）
  useEffect(() => {
    if (profiles.some((p) => p.name === defaultProfile)) setProfile(defaultProfile)
  }, [defaultProfile, profiles])

  const current = profiles.find((p) => p.name === profile)
  const isAgent = current?.kind === 'agent'
  const trimmed = prompt.trim()
  const canSubmit = panelCount < maxPanels && (!isAgent || trimmed.length > 0)

  const submit = () => {
    if (!canSubmit) return
    onSpawn(profile, isAgent ? trimmed : '')
    setPrompt('')
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line bg-panel px-2.5 py-1.5">
      <select
        value={profile}
        onChange={(event) => setProfile(event.target.value)}
        title={current?.path ?? ''}
        className="rounded-[5px] border border-line bg-panel-2 px-1.5 py-[2px] text-[11px] text-fg outline-none focus:border-[#2a4a6b]"
      >
        {profiles.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
          </option>
        ))}
      </select>

      <input
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit()
        }}
        placeholder={isAgent ? `给 ${profile} 派任务（必填，Ctrl+Enter 提交）` : 'shell 不需要任务'}
        disabled={!isAgent}
        className="min-w-[180px] flex-1 rounded-[5px] border border-line bg-panel-2 px-2 py-[3px] text-[11px] text-fg outline-none placeholder:text-ghost focus:border-[#2a4a6b] disabled:opacity-50"
      />

      <button
        onClick={submit}
        disabled={!canSubmit}
        title={
          panelCount >= maxPanels
            ? `面板已满（上限 ${maxPanels}），先关掉几个`
            : isAgent && !trimmed
              ? 'agent 必须带任务才能起'
              : undefined
        }
        className="rounded-[5px] border border-[#1f3a5c] bg-[#0e1a26] px-2 py-[3px] text-[11px] text-accent hover:border-accent disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-faint"
      >
        {isAgent ? '派任务' : '新终端'}
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
