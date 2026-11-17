import { useEffect, useImperativeHandle, useRef } from 'react'
import type { Ref } from 'react'
import type { Terminal } from '@xterm/xterm'

import { usePty } from '../hooks/usePty'
import { createTerminal } from '../lib/terminal'
import type { ConnStatus, ControlMessage, RenderMode } from '../types'

export type SessionHandle = {
  /** 往 PTY 里塞一段文本（目录树点文件时用） */
  insert: (text: string) => void
  /** 同步外包模式开关到服务端 */
  setOutsourcing: (on: boolean) => void
  focus: () => void
  reconnect: (options?: { fresh?: boolean; rerun?: boolean; resume?: boolean }) => void
}

type Props = {
  /** 面板身份，和 sid 无关：新开会话时还没有 sid */
  panelKey: string
  profile: string
  /** shell 不显示形态标记；agent 才标「交互 / 无头」 */
  kind?: 'shell' | 'agent'
  projectId: string
  /** 接回已有会话；空则新开 */
  initialSid?: string
  /** 新会话的初始任务；agent 必填 */
  prompt?: string
  outsourcing: boolean
  active: boolean
  /** 结束后还能不能「重开」：agent 会话没任务就起不来，别给假按钮 */
  restartable: boolean
  /** ended 时走「原槽重跑上一轮委派任务」，而不是用面板里的 prompt 新开会话 */
  rerunOnEnded?: boolean
  /** 面板头左侧名字：主会话是 profile，子会话是「↳ label」 */
  title: string
  /** 名字后面那截灰字：父会话 / 任务预览 */
  subtitle?: string
  onActivate: () => void
  onClose: () => void
  onSidChange: (sid: string | null) => void
  onStatus: (status: ConnStatus) => void
  onRenderMode: (mode: RenderMode) => void
  onSize: (cols: number, rows: number) => void
  onControl: (message: ControlMessage) => void
  ref?: Ref<SessionHandle>
}

const encoder = new TextEncoder()

const STATUS_TEXT: Record<ConnStatus, string> = {
  connecting: '连接中',
  online: '已连接',
  offline: '断开',
  ended: '已结束',
}

const STATUS_STYLE: Record<ConnStatus, string> = {
  connecting: 'text-warn',
  online: 'text-ok',
  offline: 'text-err',
  ended: 'text-dim',
}

const DOT_STYLE: Record<ConnStatus, string> = {
  connecting: 'bg-warn',
  online: 'bg-ok shadow-[0_0_5px_var(--color-ok)]',
  offline: 'bg-err',
  ended: 'bg-faint',
}

const dim = (text: string) => `\r\n\x1b[38;5;244m${text}\x1b[0m\r\n`

/**
 * 一个面板 = 一条 WebSocket = 一个前台进程。
 *
 * 会话（sid）活在 Django 进程里，面板只是它的观察者：关掉面板不会杀进程，
 * 再点开同一个 sid 就能接着看。所以这里所有状态都以 sid 为锚，面板 key 只
 * 用来在 React 里区分还没拿到 sid 的空窗期。
 */
export function SessionPanel({
  panelKey,
  profile,
  kind = 'agent',
  projectId,
  initialSid = '',
  prompt = '',
  outsourcing,
  active,
  restartable,
  rerunOnEnded = false,
  title,
  subtitle,
  onActivate,
  onClose,
  onSidChange,
  onStatus,
  onRenderMode,
  onSize,
  onControl,
  ref,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  /**
   * 终端实例是在 effect 里建的，而 WS 可能在它之前就把首帧（回放/首屏输出）
   * 推到了。先攒着，term.open 之后一次性补写 —— 否则短命会话（桩、一问一答
   * 的 agent）会留下一个空面板。
   */
  const pendingWrites = useRef<(string | Uint8Array)[]>([])
  const write = (data: string | Uint8Array) => {
    const term = termRef.current
    if (term) term.write(data)
    else pendingWrites.current.push(data)
  }

  // 回调全走 ref：父组件内联函数每次渲染都是新引用，进依赖会把终端重建
  const cbRef = useRef({ onStatus, onRenderMode, onSize, onControl, onSidChange, onActivate })
  cbRef.current = { onStatus, onRenderMode, onSize, onControl, onSidChange, onActivate }

  const pty = usePty({
    profile,
    projectId,
    initialSid,
    prompt,
    outsourcing,
    handlers: {
      onOutput: (data) => write(data),
      onStatus: (next) => cbRef.current.onStatus(next),
      onControl: (message) => {
        // 有一部分消息要即时回显到终端里，就地处理；状态更新交给上层
        switch (message.type) {
          case 'session-eof':
            write(
              dim(`[会话进程已结束，仍有 ${message.pending ?? 0} 条外包任务在跑，回执回来后自动断开]`),
            )
            break
          case 'session-missing':
            write(dim('[原会话已过期，正在新开]'))
            break
          case 'delegate-result': {
            const d = message.delegation
            const ok = d.status === 'done'
            const who = d.profile ? ` → ${d.profile}` : ''
            const where = d.child_sid ? ` (${d.child_sid})` : ''
            const body = d.reply || d.error || ''
            write(
              `\r\n${ok ? '\x1b[32m[外包回执]\x1b[0m' : '\x1b[31m[外包失败]\x1b[0m'}${who}${where} ${body}\r\n`,
            )
            break
          }
          case 'input-rejected':
            write(`\r\n\x1b[33m[任务被拒]\x1b[0m ${message.reason ?? ''}\r\n`)
            break
          case 'rerun-error':
            write(dim(`[重跑失败] ${message.reason ?? ''}`))
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

  // agent 是「派一次任务跑一次」，正常退出也走 close(1000)。给句人话。
  useEffect(() => {
    if (status === 'ended') write(dim('[会话已结束 · 点「重开」再派一次]'))
  }, [status])

  // 切换到本面板时把焦点给终端，键盘输入才不会跑丢
  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active])

  useImperativeHandle(
    ref,
    () => ({
      insert: (text: string) => {
        send(encoder.encode(text))
        termRef.current?.focus()
      },
      setOutsourcing: (on: boolean) => sendControl({ type: 'outsourcing', on }),
      focus: () => termRef.current?.focus(),
      reconnect: (options) => {
        // 另起/重跑都先擦掉旧画面，不然新旧输出会叠在一起
        if (options?.fresh || options?.rerun) termRef.current?.reset()
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

    // 终端建好之前到达的字节（回放、首屏输出）在这里补写
    const buffered = pendingWrites.current.splice(0)
    for (const chunk of buffered) bundle.term.write(chunk)

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
    <section
      data-panel={panelKey}
      data-active={active ? '1' : '0'}
      onPointerDown={() => cbRef.current.onActivate()}
      className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-surface"
    >
      <div
        className={
          'flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-[4px] ' +
          (active
            ? 'bg-[rgba(110,243,200,0.05)] shadow-[inset_2px_0_0_var(--color-phos)]'
            : 'bg-transparent')
        }
      >
        <i className={`size-1.5 shrink-0 rounded-full ${DOT_STYLE[status]}`} />
        <span
          className={`shrink-0 text-[10.5px] uppercase tracking-[0.08em] ${active ? 'text-accent' : 'text-dim'}`}
          title={profile}
        >
          {title}
        </span>
        {subtitle && (
          <span className="min-w-0 truncate text-[10.5px] text-faint" title={subtitle}>
            {subtitle}
          </span>
        )}
        {kind === 'agent' && pty.mode && (
          <span
            className="shrink-0 rounded-[1px] border border-line px-1 text-[9px] leading-4 text-faint"
            title={pty.mode === 'interactive' ? '原生 TUI，多轮对话归 CLI' : '一次性任务，跑完即退'}
          >
            {pty.mode === 'interactive' ? '交互' : '无头'}
          </span>
        )}

        <span className="ml-auto flex shrink-0 items-center gap-1">
          {pty.sid && (
            <span className="text-[10.5px] text-ghost" title={pty.sid}>
              #{pty.sid.slice(-4)}
            </span>
          )}
          <span className={`text-[10.5px] ${STATUS_STYLE[status]}`}>{STATUS_TEXT[status]}</span>
          {(status === 'offline' || (status === 'ended' && restartable)) && (
            <button
              onClick={(event) => {
                const rerun = status === 'ended' && rerunOnEnded
                const fresh = event.shiftKey || (status === 'ended' && !rerun)
                // 交互态 agent 正常重开 = 续 CLI 自己的会话；Shift 强制新开
                const resume =
                  status === 'ended' && !event.shiftKey && !rerun && pty.mode === 'interactive'
                // 另起会话先把旧画面擦掉，不然新旧输出会叠在一起
                if (fresh) termRef.current?.reset()
                reconnect(rerun ? { rerun: true } : { fresh, resume })
              }}
              title={
                status === 'ended'
                  ? rerunOnEnded
                    ? '重开：在原来的子会话槽里重跑上一轮任务'
                    : pty.mode === 'interactive'
                      ? '重开：续上同一个 CLI 会话（Shift+点击：新开会话）'
                      : '重开：用同一任务再跑一次'
                  : '重连回原会话（Shift+点击：新开会话）'
              }
              className="rounded-[2px] border border-transparent px-1 py-px text-[10.5px] text-dim hover:border-line hover:bg-line-soft hover:text-fg"
            >
              重开
            </button>
          )}
          <button
            onClick={onClose}
            title="关闭面板（不影响后端会话，可再点开）"
            aria-label="关闭面板"
            className="inline-flex size-[18px] items-center justify-center rounded-[2px] text-[10.5px] text-faint hover:bg-line-soft hover:text-err"
          >
            ×
          </button>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-2 py-1.5">
        <div ref={hostRef} className="size-full" />
      </div>
    </section>
  )
}
