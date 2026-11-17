import { useCallback, useEffect, useRef, useState } from 'react'

import type { ConnStatus, ControlMessage } from '../types'

export type PtyHandlers = {
  /** 终端字节流，直接喂 term.write */
  onOutput: (data: Uint8Array) => void
  /** 文本帧里的 JSON 控制消息 */
  onControl: (message: ControlMessage) => void
  onStatus?: (status: ConnStatus) => void
}

export type PtyOptions = {
  profile: string
  projectId: string
  /** 恢复会话用；空则新开 */
  initialSid?: string
  /** 新会话的初始任务：写进 argv。agent 没有它起不来；shell 会忽略 */
  prompt?: string
  /** 新会话建起来时就把外包开关带上，免得第一帧 delegate 事件被丢 */
  outsourcing?: boolean
  handlers: PtyHandlers
}

export type PtyApi = {
  status: ConnStatus
  /** 当前会话 id（服务端下发，可能为 null） */
  sid: string | null
  /** 会话形态：interactive 原生 TUI / headless 一次性任务；未知时为空串 */
  mode: string
  send: (data: Uint8Array<ArrayBuffer>) => void
  sendControl: (payload: Record<string, unknown>) => void
  resize: (cols: number, rows: number) => void
  /** fresh=true 丢弃旧会话另起一个；rerun=true 让服务端在原槽里重跑上一轮任务 */
  reconnect: (options?: { fresh?: boolean; rerun?: boolean }) => void
}

const RETRY_DELAY = 2500

/**
 * 一条 WebSocket = 一个前台进程。
 *
 * 帧协议很薄：二进制帧是终端字节流，文本帧是 JSON 控制消息（resize / outsourcing）。
 *
 * 会话 id 的生命周期值得注意：服务端在连接建立时下发 `session` 帧，此后断线重连
 * 带上 `sid` 就能接回**同一个进程**（服务端会回放输出缓冲）。只有 profile 或
 * project 变了，或者用户显式要新会话，才会把 sid 丢掉。
 */
export function usePty({
  profile,
  projectId,
  initialSid = '',
  prompt = '',
  outsourcing = false,
  handlers,
}: PtyOptions): PtyApi {
  const [status, setStatus] = useState<ConnStatus>('connecting')
  const [sid, setSid] = useState<string | null>(initialSid || null)
  const [mode, setMode] = useState('')

  const socketRef = useRef<WebSocket | null>(null)
  const retryRef = useRef<number | undefined>(undefined)
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const sidRef = useRef(initialSid)
  const sessionKeyRef = useRef(`${profile}|${projectId}`)

  // 这两个只在开连接时拼进 query：走 ref 而不是依赖，否则用户点一下外包开关
  // 就会把整条 WS 重建一次（终端画面、进程观察者全断）。
  const promptRef = useRef(prompt)
  promptRef.current = prompt
  const outsourcingRef = useRef(outsourcing)
  outsourcingRef.current = outsourcing

  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  const reportStatus = (next: ConnStatus) => {
    setStatus(next)
    handlersRef.current.onStatus?.(next)
  }

  const openSocket = useCallback((options?: { fresh?: boolean; rerun?: boolean }) => {
    const fresh = options?.fresh ?? false
    const rerun = options?.rerun ?? false
    const previous = socketRef.current
    if (previous) {
      // 摘掉 onclose，否则旧连接的关闭会触发一次自动重连，和新会话打架
      previous.onclose = null
      previous.onmessage = null
      previous.close()
    }
    window.clearTimeout(retryRef.current)

    if (fresh) {
      sidRef.current = ''
      setSid(null)
    }

    reportStatus('connecting')

    const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://'
    const params = new URLSearchParams({ profile: profile })
    if (projectId) params.set('project', projectId)
    if (sidRef.current) params.set('sid', sidRef.current)
    // 带 sid 时服务端走「接回旧会话」，prompt 不会被用到；但若那个会话已过期，
    // 服务端会用它重建一个新会话 —— 所以这里始终带上，刷新后不至于空会话报错。
    if (promptRef.current) params.set('prompt', promptRef.current)
    // 外包开关赶在进程第一行输出前就位；重连时也再带一次，保持幂等
    if (outsourcingRef.current) params.set('outsourcing', '1')
    // 只在这一条连接上请求重跑（与会话 sid 一起用），不改变本地状态
    if (rerun) params.set('rerun', '1')

    const socket = new WebSocket(`${scheme}${location.host}/ws/terminal/?${params}`)
    socket.binaryType = 'arraybuffer'
    socketRef.current = socket

    socket.onopen = () => {
      reportStatus('online')
      const size = sizeRef.current
      if (size) socket.send(JSON.stringify({ type: 'resize', ...size }))
    }

    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        handlersRef.current.onOutput(new Uint8Array(event.data))
        return
      }
      if (typeof event.data !== 'string') return

      let message: ControlMessage
      try {
        message = JSON.parse(event.data) as ControlMessage
      } catch {
        return
      }
      if (message.type === 'session' && message.sid) {
        sidRef.current = message.sid
        setSid(message.sid)
        if (message.mode) setMode(message.mode)
      }
      handlersRef.current.onControl(message)
    }

    socket.onclose = (event) => {
      socketRef.current = null
      if (event.code === 1000) {
        // 进程自己退了。agent 是「派一次任务跑一次」的模式，跑完就退出很正常，
        // 这跟断线不是一回事，不该触发自动重连。sid 要留着：面板还挂着这个会话
        // 的历史画面，房间条点回来要认得出它（重开时才由 fresh 显式清掉）。
        reportStatus('ended')
        return
      }
      reportStatus('offline')
      retryRef.current = window.setTimeout(() => openSocket(), RETRY_DELAY)
    }

    socket.onerror = () => {
      /* onclose 会接手 */
    }
  }, [profile, projectId])

  const send = useCallback((data: Uint8Array<ArrayBuffer>) => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) socket.send(data)
  }, [])

  const sendControl = useCallback((payload: Record<string, unknown>) => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
  }, [])

  const resize = useCallback((cols: number, rows: number) => {
    sizeRef.current = { cols, rows }
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'resize', cols, rows }))
    }
  }, [])

  useEffect(() => {
    // 换 profile 或换项目 = 换一个前台进程，旧 sid 不能带过去
    const key = `${profile}|${projectId}`
    if (sessionKeyRef.current !== key) {
      sessionKeyRef.current = key
      sidRef.current = ''
      setSid(null)
    }

    openSocket()
    return () => {
      window.clearTimeout(retryRef.current)
      const socket = socketRef.current
      if (socket) {
        socket.onclose = null
        socket.close()
        socketRef.current = null
      }
    }
  }, [openSocket, profile, projectId])

  return { status, sid, mode, send, sendControl, resize, reconnect: openSocket }
}
