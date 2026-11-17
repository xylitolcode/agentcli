import { useCallback, useRef, useState } from 'react'

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
      const res = await fetch(`/api/files/?${params}`, { headers: { Accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const data = (await res.json()) as DirListing
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
