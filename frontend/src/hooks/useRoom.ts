import { useCallback, useEffect, useRef, useState } from 'react'

import type { SessionInfo } from '../types'

const POLL_DEBOUNCE = 250

/**
 * 房间快照：这一屋子有哪几个 agent、谁在干活。
 *
 * 不订阅推送，而是在收到控制消息时抖一下再拉一次快照 —— 会话状态变化都由
 * 控制帧驱动，跟着它们刷新就够，省得开第二条长连接。
 */
export function useRoom() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const timerRef = useRef<number | undefined>(undefined)

  const refresh = useCallback(() => {
    if (timerRef.current) return
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined
      fetch('/api/sessions/')
        .then((res) => res.json())
        .then((data: { sessions?: SessionInfo[] }) => setSessions(data.sessions ?? []))
        .catch(() => {
          /* 离线时保持旧快照，不要闪成空的 */
        })
    }, POLL_DEBOUNCE)
  }, [])

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  return { sessions, refresh }
}
