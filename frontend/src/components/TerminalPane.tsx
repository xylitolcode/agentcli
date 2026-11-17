import { useEffect, useImperativeHandle, useRef } from 'react'
import type { Ref } from 'react'
import type { Terminal } from '@xterm/xterm'

import { usePty } from '../hooks/usePty'
import { createTerminal } from '../lib/terminal'
import type { ConnStatus, ControlMessage, Profile, RenderMode, SessionInfo } from '../types'
import { ProfileTabs } from './ProfileTabs'
import { RoomBar } from './RoomBar'

export type TerminalHandle = {
  /** 往 PTY 里塞一段文本（目录树点文件时用） */
  insert: (text: string) => void
  /** 同步外包模式开关到服务端 */
  setOutsourcing: (on: boolean) => void
  reconnect: (options?: { fresh?: boolean }) => void
}

type Props = {
  profile: string
  profiles: Profile[]
  projectId: string
  initialSid: string
  rootName: string
  outsourcing: boolean
  sessions: SessionInfo[]
  sid: string | null
  onProfileChange: (name: string) => void
  onStatus: (status: ConnStatus) => void
  onRenderMode: (mode: RenderMode) => void
  onSize: (cols: number, rows: number) => void
  onControl: (message: ControlMessage) => void
  onSidChange: (sid: string | null) => void
  onToggleOutsourcing: () => void
  onReconnect: (fresh: boolean) => void
  ref?: Ref<TerminalHandle>
}

const encoder = new TextEncoder()

const STATUS_TEXT: Record<ConnStatus, string> = {
  connecting: '连接中',
  online: '已连接',
  offline: '连接断开',
  ended: '会话已结束',
}

const STATUS_STYLE: Record<ConnStatus, string> = {
  connecting: 'text-warn border-[#3d3117]',
  online: 'text-ok border-[#1d3a24]',
  offline: 'text-err border-[#3d1d1d]',
  ended: 'text-dim border-line',
}

const DOT_STYLE: Record<ConnStatus, string> = {
  connecting: 'bg-warn',
  online: 'bg-ok shadow-[0_0_6px_var(--color-ok)]',
  offline: 'bg-err',
  ended: 'bg-faint',
}

const dim = (text: string) => `\r\n\x1b[38;5;244m${text}\x1b[0m\r\n`

export function TerminalPane({
  profile,
  profiles,
  projectId,
  initialSid,
  rootName,
  outsourcing,
  sessions,
  sid,
  onProfileChange,
  onStatus,
  onRenderMode,
  onSize,
  onControl,
  onSidChange,
  onToggleOutsourcing,
  onReconnect,
  ref,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)

  // 回调全走 ref：父组件若传内联函数，每次渲染都是新引用，
  // 直接进 effect 依赖会导致终端被反复销毁重建。
  const cbRef = useRef({ onStatus, onRenderMode, onSize, onControl, onSidChange })
  cbRef.current = { onStatus, onRenderMode, onSize, onControl, onSidChange }

  const pty = usePty({
    profile,
    projectId,
    initialSid,
    handlers: {
      onOutput: (data) => termRef.current?.write(data),
      onStatus: (next) => cbRef.current.onStatus(next),
      onControl: (message) => {
        const term = termRef.current
        // 有一部分消息要即时回显到终端里，就地处理；状态更新交给上层
        switch (message.type) {
          case 'session-eof':
            term?.write(
              dim(`[会话进程已结束，仍有 ${message.pending ?? 0} 条外包任务在跑，回执回来后自动断开]`),
            )
            break
          case 'session-missing':
            term?.write(dim('[原会话已过期，正在新开]'))
            break
          case 'delegate-result': {
            const d = message.delegation
            const ok = d.status === 'done'
            const who = d.profile ? ` → ${d.profile}` : ''
            const where = d.child_sid ? ` (${d.child_sid})` : ''
            const body = d.reply || d.error || ''
            term?.write(
              `\r\n${ok ? '\x1b[32m[外包回执]\x1b[0m' : '\x1b[31m[外包失败]\x1b[0m'}${who}${where} ${body}\r\n`,
            )
            break
          }
          case 'input-rejected':
            term?.write(`\r\n\x1b[33m[任务被拒]\x1b[0m ${message.reason ?? ''}\r\n`)
            break
          default:
            break
        }
        cbRef.current.onControl(message)
      },
    },
  })

  const { send, resize, sendControl, reconnect, status } = pty

  useEffect(() => {
    cbRef.current.onSidChange(pty.sid)
  }, [pty.sid])

  // agent 是「派一次任务跑一次」，正常退出也走 close(1000)。给句人话，
  // 免得以为是网络挂了。
  useEffect(() => {
    if (status === 'ended') termRef.current?.write(dim('[会话已结束 · 点「重连」重开]'))
  }, [status])

  useImperativeHandle(
    ref,
    () => ({
      insert: (text: string) => {
        send(encoder.encode(text))
        termRef.current?.focus()
      },
      setOutsourcing: (on: boolean) => sendControl({ type: 'outsourcing', on }),
      reconnect: (options) => {
        // 另起会话时先擦掉旧画面，不然新旧输出会叠在一起
        if (options?.fresh) termRef.current?.reset()
        reconnect(options)
      },
    }),
    [send, sendControl, reconnect],
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const bundle = createTerminal(host, {
      forceDom: new URLSearchParams(location.search).get('render') === 'dom',
    })
    termRef.current = bundle.term
    cbRef.current.onRenderMode(bundle.renderMode)

    const dataSub = bundle.term.onData((data) => send(encoder.encode(data)))
    const binarySub = bundle.term.onBinary((data) => {
      const bytes = new Uint8Array(data.length)
      for (let i = 0; i < data.length; i += 1) bytes[i] = data.charCodeAt(i) & 0xff
      send(bytes)
    })
    const resizeSub = bundle.term.onResize(({ cols, rows }) => {
      resize(cols, rows)
      cbRef.current.onSize(cols, rows)
    })

    bundle.fit()
    bundle.term.focus()

    const observer = new ResizeObserver(() => bundle.fit())
    observer.observe(host.parentElement ?? host)

    return () => {
      observer.disconnect()
      dataSub.dispose()
      binarySub.dispose()
      resizeSub.dispose()
      bundle.dispose()
      termRef.current = null
    }
  }, [send, resize])

  // 换 profile = 换前台进程，旧画面不该留在新会话里
  const previousProfile = useRef(profile)
  useEffect(() => {
    if (previousProfile.current === profile) return
    previousProfile.current = profile
    termRef.current?.reset()
  }, [profile])

  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[10px] border border-line bg-panel">
      <div className="flex shrink-0 items-center gap-2 overflow-hidden border-b border-line bg-panel-2 px-2.5 py-[7px]">
        <span className="mr-0.5 flex shrink-0 gap-[5px]" aria-hidden="true">
          <i className="block size-[9px] rounded-full bg-[#f85149]" />
          <i className="block size-[9px] rounded-full bg-[#d29922]" />
          <i className="block size-[9px] rounded-full bg-[#3fb950]" />
        </span>
        <span className="shrink-0 text-xs tracking-[0.3px] text-dim">{rootName}</span>
        <ProfileTabs profiles={profiles} current={profile} onSelect={onProfileChange} />

        <span className="ml-auto flex shrink-0 items-center gap-1.5">
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

          <RoomBar sessions={sessions} currentSid={sid} />

          <span
            className={`inline-flex items-center gap-1.5 rounded-full border bg-[#0a0e13] px-2 py-px text-[11px] ${STATUS_STYLE[status]}`}
          >
            <i className={`size-1.5 rounded-full ${DOT_STYLE[status]}`} />
            {STATUS_TEXT[status]}
          </span>

          {(status === 'offline' || status === 'ended') && (
            <button
              onClick={(event) => onReconnect(event.shiftKey)}
              title="重连回原会话（Shift+点击：新开会话）"
              className="rounded-[5px] border border-transparent px-1.5 py-0.5 text-xs text-dim hover:border-line hover:bg-line-soft hover:text-fg"
            >
              重连
            </button>
          )}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden py-[9px] pl-3 pr-0.5">
        <div ref={hostRef} className="size-full" />
      </div>
    </section>
  )
}
