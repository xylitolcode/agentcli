import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchJson } from '../lib/api'

import type { DiffLine, FileDiff } from '../types'
import { FileIcon } from './icons'

export type DiffMode = 'worktree' | 'staged' | 'unstaged'

const MODE_LABEL: Record<DiffMode, string> = {
  worktree: '工作区',
  staged: '已暂存',
  unstaged: '未暂存',
}

const KIND_LABEL: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '新',
  conflicted: '!',
}

const KIND_TONE: Record<string, string> = {
  modified: 'text-warn',
  added: 'text-accent',
  deleted: 'text-err',
  renamed: 'text-accent',
  untracked: 'text-accent',
  conflicted: 'text-err',
}

type Row =
  | { kind: 'hunk'; header: string; hunkStart: number; key: string }
  | { kind: 'line'; line: DiffLine; block: number; key: string }

type Props = {
  path: string
  projectId: string
  /** 打开时默认看的范围：工作区合并 / 已暂存 / 未暂存 */
  mode: DiffMode
  onClose: () => void
  /** 切到全文预览：diff 只是切片，想看整段还得有路回去 */
  onOpenFile: (path: string) => void
  /** 把路径插进当前终端（与代码查看器一致的能力） */
  onInsert: (path: string) => void
}

/**
 * 只读 diff 视图。改动按「块」聚合，n / p 在块之间跳，工具栏显示 第几处 / 共几处。
 * 不做逐行语法高亮 —— diff 行是被切断的片段，逐行喂给 highlight.js 会把多行
 * 字符串和注释的边界切坏，反而更花。
 */
export function DiffViewer({
  path,
  projectId,
  mode: initialMode,
  onClose,
  onOpenFile,
  onInsert,
}: Props) {
  const [mode, setMode] = useState<DiffMode>(initialMode)
  const [data, setData] = useState<FileDiff | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [cursor, setCursor] = useState(0)

  const blockRefs = useRef<(HTMLDivElement | null)[]>([])

  useEffect(() => {
    setMode(initialMode)
  }, [initialMode, path])

  useEffect(() => {
    let live = true
    setLoading(true)
    setError('')
    setData(null)
    setCursor(0)
    blockRefs.current = []
    const params = new URLSearchParams({ path, mode })
    if (projectId) params.set('project', projectId)
    fetchJson<FileDiff>(`/api/diff/?${params}`)
      .then((result) => {
        if (!live) return
        const payload = result.data
        if (!result.ok || !payload) {
          setError(result.error || `HTTP ${result.status}`)
          return
        }
        if (!payload.ok) {
          setError(payload.error || '读取失败')
          return
        }
        setData(payload)
      })
      .catch((exc) => live && setError(String(exc)))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [path, projectId, mode])

  /** 拍平成渲染行，同时记下每个改动块的起始行下标，导航全靠这个数组 */
  const { rows, blocks } = useMemo(() => {
    const out: Row[] = []
    const starts: number[] = []
    let blockNo = -1
    let open = false
    data?.hunks.forEach((hunk, hunkNo) => {
      out.push({
        kind: 'hunk',
        header: hunk.header,
        hunkStart: hunk.oldStart,
        key: `h-${hunkNo}`,
      })
      open = false
      hunk.lines.forEach((line, lineNo) => {
        if (line.t === ' ') {
          open = false
          out.push({ kind: 'line', line, block: -1, key: `l-${hunkNo}-${lineNo}` })
          return
        }
        if (!open) {
          blockNo += 1
          starts.push(out.length)
          open = true
        }
        out.push({ kind: 'line', line, block: blockNo, key: `l-${hunkNo}-${lineNo}` })
      })
    })
    return { rows: out, blocks: starts }
  }, [data])

  const gotoBlock = useCallback(
    (index: number) => {
      const total = blocks.length
      if (!total) return
      const next = ((index % total) + total) % total
      setCursor(next)
      blockRefs.current[next]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    },
    [blocks.length],
  )

  // 打开就先落到第一处改动，省得自己往回滚
  useEffect(() => {
    if (loading || !blocks.length) return
    setCursor(0)
    blockRefs.current[0]?.scrollIntoView({ block: 'center' })
  }, [loading, blocks.length])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key === 'n' || event.key === 'ArrowRight') {
        event.preventDefault()
        gotoBlock(cursor + 1)
      } else if (event.key === 'p' || event.key === 'ArrowLeft') {
        event.preventDefault()
        gotoBlock(cursor - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, gotoBlock, cursor])

  const stats = data?.stats ?? { add: 0, del: 0 }
  const total = blocks.length
  const kindLabel = data?.kind ? KIND_LABEL[data.kind] || '?' : ''
  const kindTone = data?.kind ? KIND_TONE[data.kind] || 'text-dim' : 'text-dim'

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/55 p-3 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <section
        className="flex h-[88vh] w-full max-w-[1180px] flex-col overflow-hidden rounded-[2px] border border-line bg-panel shadow-[0_0_90px_rgba(0,0,0,0.7)]"
        onClick={(event) => event.stopPropagation()}
        aria-label="只读差异查看器"
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-line bg-[rgba(11,18,25,0.7)] px-3 py-2">
          <span className="shrink-0 text-dim"><FileIcon /></span>
          <span className="min-w-0 truncate text-xs text-fg" title={data?.path || path}>
            {data?.path || path}
          </span>
          {kindLabel && (
            <span className={'shrink-0 rounded-[1px] border border-line px-1 text-[10px] ' + kindTone}>
              {kindLabel}
            </span>
          )}
          <span className="shrink-0 text-[10.5px] text-accent">+{stats.add}</span>
          <span className="shrink-0 text-[10.5px] text-err">-{stats.del}</span>

          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <span className="flex items-center gap-0.5 rounded-[2px] border border-line p-[1px]">
              {(Object.keys(MODE_LABEL) as DiffMode[]).map((item) => (
                <button
                  key={item}
                  onClick={() => setMode(item)}
                  title={`看${MODE_LABEL[item]}的改动`}
                  className={
                    'rounded-[1px] px-1.5 py-[2px] text-[10.5px] ' +
                    (mode === item
                      ? 'bg-[rgba(110,243,200,0.09)] text-accent'
                      : 'text-dim hover:bg-line-soft hover:text-fg')
                  }
                >
                  {MODE_LABEL[item]}
                </button>
              ))}
            </span>

            <span className="flex items-center gap-0.5 rounded-[2px] border border-line p-[1px]">
              <button
                onClick={() => gotoBlock(cursor - 1)}
                disabled={!total}
                title="上一处改动（p / ←）"
                className="rounded-[1px] px-1.5 py-[2px] text-[11px] leading-none text-dim hover:bg-line-soft hover:text-fg disabled:opacity-35"
              >
                ←
              </button>
              <span className="min-w-[42px] text-center text-[10.5px] tabular-nums text-faint">
                {total ? `${cursor + 1}/${total}` : '0/0'}
              </span>
              <button
                onClick={() => gotoBlock(cursor + 1)}
                disabled={!total}
                title="下一处改动（n / →）"
                className="rounded-[1px] px-1.5 py-[2px] text-[11px] leading-none text-dim hover:bg-line-soft hover:text-fg disabled:opacity-35"
              >
                →
              </button>
            </span>

            <button
              onClick={() => onOpenFile(data?.path || path)}
              className="rounded-[2px] border border-line px-2 py-1 text-[10.5px] text-dim hover:bg-line-soft hover:text-fg"
              title="看整个文件的当前内容"
            >
              全文
            </button>
            <button
              onClick={() => onInsert(data?.path || path)}
              className="rounded-[2px] border border-line px-2 py-1 text-[10.5px] text-dim hover:bg-line-soft hover:text-fg"
              title="把文件路径插入当前终端（不是编辑内容）"
            >
              插入终端
            </button>
            <button
              onClick={onClose}
              className="rounded-[2px] border border-transparent px-2 py-1 text-sm leading-none text-dim hover:border-line hover:bg-line-soft hover:text-fg"
              title="关闭（Esc）"
            >
              ×
            </button>
          </span>
        </header>

        <div className="min-h-0 flex-1 overflow-auto bg-panel">
          {loading && <div className="px-4 py-3 text-xs text-faint">计算差异…</div>}
          {error && <div className="px-4 py-3 text-xs text-err">读取失败：{error}</div>}
          {!loading && !error && data && !data.repo && (
            <div className="px-4 py-3 text-xs text-faint">当前项目不是 git 仓库，没有差异可看。</div>
          )}
          {!loading && !error && data?.repo && data.binary && (
            <div className="px-4 py-3 text-xs text-faint">二进制文件，不展开差异。</div>
          )}
          {!loading && !error && data?.repo && !data.binary && data.empty && (
            <div className="px-4 py-3 text-xs text-faint">
              {mode === 'staged'
                ? '暂存区里没有这个文件的改动。'
                : mode === 'unstaged'
                  ? '工作区里没有这个文件的改动。'
                  : '当前没有可展示的差异。'}
            </div>
          )}

          {data?.repo && !data.binary && rows.length > 0 && (
            <div className="min-w-max py-1">
              {rows.map((row, index) =>
                row.kind === 'hunk' ? (
                  <div
                    key={row.key}
                    className="mt-1 flex items-center gap-2 border-y border-line bg-[rgba(110,243,200,0.05)] px-3 py-[3px] text-[10.5px] text-accent"
                  >
                    <span className="text-faint">@@</span>
                    <span className="shrink-0">第 {row.hunkStart} 行起</span>
                    {row.header && (
                      <span className="min-w-0 truncate text-dim">{row.header}</span>
                    )}
                  </div>
                ) : (
                  <div
                    key={row.key}
                    ref={
                      row.block >= 0 && blocks[row.block] === index
                        ? (node) => {
                            blockRefs.current[row.block] = node
                          }
                        : undefined
                    }
                    className={
                      'flex items-start ' +
                      (row.line.t === '+'
                        ? 'bg-[#0c2418] text-[#a8ecc8]'
                        : row.line.t === '-'
                          ? 'bg-[#2a1416] text-[#ffb3b8]'
                          : 'text-dim')
                    }
                    style={
                      row.block >= 0 && row.block === cursor
                        ? { boxShadow: 'inset 2px 0 0 var(--color-accent)' }
                        : undefined
                    }
                  >
                    <span className="w-[52px] shrink-0 select-none pr-2 text-right text-[10.5px] text-faint">
                      {row.line.old ?? ''}
                    </span>
                    <span className="w-[52px] shrink-0 select-none pr-2 text-right text-[10.5px] text-faint">
                      {row.line.new ?? ''}
                    </span>
                    <span className="w-3 shrink-0 select-none text-center text-[10.5px] opacity-70">
                      {row.line.t === ' ' ? '' : row.line.t}
                    </span>
                    <span className="whitespace-pre pr-4 text-[12px] leading-[1.55]">
                      {row.line.text}
                    </span>
                  </div>
                ),
              )}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-3 border-t border-line px-3 py-1.5 text-[10.5px] text-faint">
          <span>只读对比 · 不落盘、不 stage</span>
          <span>n / p 跳改动</span>
          {data?.truncated && <span className="text-warn">差异过大，只解析了前 4000 行</span>}
          <span className="ml-auto">Esc 关闭</span>
        </footer>
      </section>
    </div>
  )
}
