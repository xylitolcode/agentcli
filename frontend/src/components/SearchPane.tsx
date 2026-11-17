import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import { fetchJson } from '../lib/api'
import { buildRows, dirOf, selectableRows, spanSegments } from '../lib/search'
import type { SearchRow } from '../lib/search'
import type { SearchResult } from '../types'
import { FileIcon } from './icons'

type Mode = 'content' | 'file'

type Props = {
  projectId: string
  projectName: string
  onClose: () => void
  /** 打开命中文件；内容模式下带行号，打开后由 CodeViewer 高亮并滚过去 */
  onOpen: (path: string, line?: number) => void
}

/** 输入停顿多久才发请求。240ms 是手感与请求数之间的老折中点 */
const DEBOUNCE = 240

/** 用后端给的 submatch 区间切段上色；切段逻辑在 lib/search.ts，这里只管画 */
function Highlighted({ text, spans }: { text: string; spans: [number, number][] }) {
  const segments = spanSegments(text, spans)
  if (segments.length === 1 && !segments[0].hit) return <>{text}</>
  return (
    <>
      {segments.map((segment, index) =>
        segment.hit ? (
          <mark key={index} className="rounded-[2px] bg-accent/25 px-0 text-accent">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  )
}

/**
 * 工作区搜索面板（内容 + 文件名）。
 *
 * 这里刻意不做客户端过滤、不做本地缓存：搜索**必须**由后端 rg 执行，
 * 否则 .gitignore 语义、二进制跳过、大小上限全都要在前端重写一遍，
 * 而且一定会和 rg 的行为跑偏。前端只负责把结果画得能点。
 */
export function SearchPane({ projectId, projectName, onClose, onOpen }: Props) {
  const [mode, setMode] = useState<Mode>('content')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<SearchResult | null>(null)
  const [active, setActive] = useState(0)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const trimmed = query.trim()
    // 内容模式空关键词没有意义（会把整个仓库打出来），文件名模式空关键词则等于「列全部文件」
    if (!trimmed && mode === 'content') {
      setResult(null)
      setError('')
      setLoading(false)
      return
    }

    let live = true
    setLoading(true)
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: query, mode })
      if (projectId) params.set('project', projectId)
      fetchJson<SearchResult>(`/api/search/?${params}`)
        .then((response) => {
          if (!live) return
          if (!response.ok || !response.data?.ok) {
            setError(response.error || response.data?.error || '搜索失败')
            setResult(null)
            return
          }
          setError('')
          setResult(response.data)
          setActive(0)
        })
        .catch((exc: unknown) => {
          if (live) setError(String(exc))
        })
        .finally(() => {
          if (live) setLoading(false)
        })
    }, DEBOUNCE)

    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [query, mode, projectId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const rows = useMemo<SearchRow[]>(() => buildRows(result), [result])
  const selectable = useMemo(() => selectableRows(rows), [rows])

  const openRow = (row: SearchRow | undefined) => {
    if (!row || row.kind === 'group') return
    if (row.kind === 'file') onOpen(row.path)
    else onOpen(row.path, row.line)
  }

  const move = (delta: number) => {
    if (selectable.length === 0) return
    const current = selectable.indexOf(active)
    const from = current < 0 ? 0 : current
    const next = Math.min(Math.max(from + delta, 0), selectable.length - 1)
    setActive(selectable[next] ?? 0)
  }

  useEffect(() => {
    const node = listRef.current?.querySelector('[data-active="1"]')
    node?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      openRow(rows[active])
    }
  }

  const total = result?.total ?? 0
  const groups = result?.groups?.length ?? 0
  const summary = error
    ? ''
    : loading
      ? '搜索中…'
      : !result
        ? '输入关键词开始搜索'
        : mode === 'content'
          ? total > 0
            ? `${total} 处匹配 · ${groups} 个文件${result.truncated ? ' · 已截断' : ''}`
            : '没有匹配'
          : total > 0
            ? `${total} 个文件${result.truncated ? ' · 已截断' : ''}`
            : '没有匹配'

  const tab = (value: Mode, label: string) => (
    <button
      key={value}
      onClick={() => setMode(value)}
      aria-pressed={mode === value}
      className={
        'px-2.5 py-[3px] text-[11px] ' +
        (mode === value ? 'bg-[rgba(110,243,200,0.09)] text-accent' : 'text-dim hover:bg-line-soft hover:text-fg')
      }
    >
      {label}
    </button>
  )

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/55 px-3 pt-[8vh] backdrop-blur-[2px]"
      onClick={onClose}
    >
      <section
        className="flex max-h-[76vh] w-full max-w-[820px] flex-col overflow-hidden rounded-[2px] border border-line bg-panel shadow-[0_0_90px_rgba(0,0,0,0.7)]"
        onClick={(event) => event.stopPropagation()}
        aria-label="工作区搜索"
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-line bg-[rgba(11,18,25,0.7)] px-3 py-2">
          <span className="flex items-center overflow-hidden rounded-[1px] border border-line">
            {tab('content', '内容')}
            {tab('file', '文件名')}
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={mode === 'content' ? '搜索代码内容（支持正则，走 ripgrep）' : '搜索文件名'}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-[2px] border border-line bg-surface px-2 py-[5px] text-xs text-fg outline-none placeholder:text-faint focus:border-accent"
          />
          <span className="shrink-0 max-w-[26%] truncate text-[10.5px] text-faint" title={projectName}>
            {projectName}
          </span>
        </header>

        <div ref={listRef} className="min-h-0 flex-1 overflow-auto py-1">
          {error && <div className="px-4 py-3 text-xs text-err">搜索失败：{error}</div>}
          {!error && rows.length === 0 && (
            <div className="px-4 py-3 text-xs text-faint">{summary}</div>
          )}
          {!error &&
            rows.map((row, index) => {
              if (row.kind === 'group') {
                return (
                  <div
                    key={`g:${row.path}`}
                    className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[11px] text-dim"
                  >
                    <FileIcon />
                    <span className="min-w-0 truncate" title={row.path}>
                      {row.path}
                    </span>
                    <span className="shrink-0 text-faint">{row.count}</span>
                  </div>
                )
              }
              const isActive = index === active
              return (
                <button
                  key={row.kind === 'hit' ? `h:${row.path}:${row.line}` : `f:${row.path}`}
                  data-active={isActive ? '1' : '0'}
                  onClick={() => openRow(row)}
                  onMouseEnter={() => setActive(index)}
                  className={
                    'flex w-full items-baseline gap-2 px-3 py-[3px] text-left ' +
                    (isActive ? 'bg-[rgba(110,243,200,0.09)]' : 'hover:bg-line-soft')
                  }
                  title={row.kind === 'hit' ? `${row.path}:${row.line}` : row.path}
                >
                  {row.kind === 'hit' ? (
                    <>
                      <span className="w-[42px] shrink-0 text-right text-[10.5px] text-faint">
                        {row.line}
                      </span>
                      <code className="min-w-0 flex-1 truncate whitespace-pre text-[11.5px] text-fg">
                        <Highlighted text={row.text} spans={row.spans} />
                      </code>
                    </>
                  ) : (
                    <>
                      <span className="shrink-0 text-dim">
                        <FileIcon />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg">
                        {row.name}
                      </span>
                      <span className="shrink-0 max-w-[45%] truncate text-[10.5px] text-faint">
                        {dirOf(row.path)}
                      </span>
                    </>
                  )}
                </button>
              )
            })}
        </div>

        <footer className="flex shrink-0 items-center gap-3 border-t border-line px-3 py-1.5 text-[10.5px] text-faint">
          <span className="truncate">{summary}</span>
          <span className="ml-auto shrink-0">↑↓ 选择 · Enter 打开 · Esc 关闭</span>
        </footer>
      </section>
    </div>
  )
}
