import { useCallback, useEffect, useState } from 'react'
import { fetchJson } from '../lib/api'

import type { GitSnapshot } from '../types'

/** Git 只读快照：项目切换和手动刷新时重取，不做轮询。 */
export function useGit(projectId: string) {
  const [git, setGit] = useState<GitSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    if (!projectId) {
      setGit(null)
      return
    }
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ project: projectId })
      const result = await fetchJson<GitSnapshot>(`/api/git/?${params}`)
      const payload = result.data
      if (!result.ok || !payload) {
        setError(result.error || `HTTP ${result.status}`)
        return
      }
      if (!payload.ok) {
        setError(payload.error || '读取失败')
        return
      }
      setGit(payload)
    } catch (exc) {
      setError(String(exc))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { git, loading, error, refresh }
}
