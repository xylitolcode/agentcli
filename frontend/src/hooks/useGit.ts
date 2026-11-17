import { useCallback, useEffect, useState } from 'react'

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
      const resp = await fetch(`/api/git/?${params}`)
      const payload = (await resp.json()) as GitSnapshot
      if (!resp.ok || !payload.ok) {
        setError(payload.error || `HTTP ${resp.status}`)
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
