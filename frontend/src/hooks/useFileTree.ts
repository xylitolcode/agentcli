import { useCallback, useRef, useState } from 'react'
import { fetchJson } from '../lib/api'

import type { DirListing, FileEntry } from '../types'

export type DirState =
  | { status: 'loading' }
  | { status: 'ready'; entries: FileEntry[]; truncated: boolean }
  | { status: 'error'; message: string }

/**
 * 目录树按需拉：展开哪个文件夹才请求哪个，一次只取一层。
 *
 * 用 `Record<path, DirState>` 而不是嵌套树 —— 刷新任何一层都不影响别处，
 * 组件也能直接按 path 取数据，不用层层传 props。
 */
export function useFileTree(projectId: string) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const projectRef = useRef(projectId)
  projectRef.current = projectId

  const load = useCallback(async (path: string) => {
    setDirs((prev) => ({ ...prev, [path]: { status: 'loading' } }))

    const params = new URLSearchParams({ path })
    if (projectRef.current) params.set('project', projectRef.current)

    try {
      const result = await fetchJson<DirListing>(`/api/files/?${params}`)
      if (!result.ok || !result.data) throw new Error(result.error || `HTTP ${result.status}`)

      const data = result.data
      if (!data.ok) throw new Error('目录列表读取失败')
      setDirs((prev) => ({
        ...prev,
        [path]: { status: 'ready', entries: data.entries, truncated: data.truncated },
      }))
    } catch (err) {
      setDirs((prev) => ({ ...prev, [path]: { status: 'error', message: (err as Error).message } }))
    }
  }, [])

  const refresh = useCallback(() => {
    setDirs({})
    void load('')
  }, [load])

  return { dirs, load, refresh }
}
