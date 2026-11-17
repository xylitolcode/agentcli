import { useState } from 'react'

import type { DirState } from '../hooks/useFileTree'
import { formatSize } from '../lib/format'
import type { FileEntry, FileMark } from '../types'
import { FileIcon, FolderIcon } from './icons'

type Props = {
  entry: FileEntry
  depth: number
  dirs: Record<string, DirState>
  marks: Record<string, FileMark>
  onLoadDir: (path: string) => void
  onOpenFile: (path: string) => void
  selectedPath: string | null
  onSelect: (path: string) => void
  showHidden: boolean
}

/** agent 动过的文件要看得出来：写过标黄，只读过标蓝。 */
function markClass(mark: FileMark | undefined): string {
  if (!mark) return ''
  if (mark.write) return 'text-warn'
  if (mark.read) return 'text-accent'
  return ''
}

export function FileNode({
  entry,
  depth,
  dirs,
  marks,
  onLoadDir,
  onOpenFile,
  selectedPath,
  onSelect,
  showHidden,
}: Props) {
  // 展开状态是纯 UI 的，留在本地；children 数据由上层缓存
  const [open, setOpen] = useState(false)

  const isDir = entry.type === 'dir'
  const path = entry.path
  const state = path ? dirs[path] : undefined
  const mark = path ? marks[path] : undefined
  const selected = path !== null && path === selectedPath

  function handleClick() {
    if (path) onSelect(path)
    if (!isDir) {
      if (path) onOpenFile(path)
      return
    }
    if (entry.blocked || !path) return

    const next = !open
    setOpen(next)
    if (next && !state) onLoadDir(path)
  }

  const nameTone = markClass(mark) || (isDir ? 'text-[#9ecbff]' : 'text-fg')

  return (
    <div>
      <div
        role="treeitem"
        aria-expanded={isDir ? open : undefined}
        onClick={handleClick}
        title={
          entry.blocked
            ? '软链指向项目目录之外，不展开'
            : mark?.write
              ? `${entry.name}（agent 修改过）`
              : mark?.read
                ? `${entry.name}（agent 读过）`
                : entry.name
        }
        style={{ paddingLeft: 8 + depth * 13 }}
        className={
          'flex cursor-pointer items-center gap-1.5 py-[3px] pr-2.5 leading-[1.55] whitespace-nowrap ' +
          (entry.blocked ? 'cursor-not-allowed opacity-40 ' : 'hover:bg-[#151b23] ') +
          (entry.hidden ? 'opacity-45 ' : '') +
          (selected ? 'bg-[#14212e] shadow-[inset_2px_0_0_var(--color-accent)]' : '')
        }
      >
        <span
          className={
            'flex size-[9px] shrink-0 items-center justify-center text-faint transition-transform ' +
            (open ? 'rotate-90' : '')
          }
        >
          {isDir && (
            <svg viewBox="0 0 9 9" width="9" height="9" aria-hidden="true">
              <path d="M3 1.5L6.5 4.5L3 7.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          )}
        </span>

        <span className={isDir ? 'shrink-0 text-[#6ea8fe]' : 'shrink-0 text-[#8b98a8]'}>
          {isDir ? <FolderIcon /> : <FileIcon />}
        </span>

        <span className={'flex-1 overflow-hidden text-ellipsis ' + nameTone}>{entry.name}</span>

        {mark?.write && <span className="shrink-0 text-[10px] text-warn">M</span>}
        {!isDir && <span className="shrink-0 pl-2 text-[11px] text-faint">{formatSize(entry.size)}</span>}
      </div>

      {isDir && open && path && (
        <div>
          {!state && <div className="px-3.5 py-2 text-xs text-faint">读取中…</div>}
          {state?.status === 'error' && (
            <div className="px-3.5 py-2 text-xs text-err">读取失败：{state.message}</div>
          )}
          {state?.status === 'ready' && state.entries.length === 0 && (
            <div className="px-3.5 py-2 text-xs text-faint">（空目录）</div>
          )}
          {state?.status === 'ready' &&
            state.entries
              .filter((child) => showHidden || !child.hidden)
              .map((child) => (
                <FileNode
                  key={child.name}
                  entry={child}
                  depth={depth + 1}
                  dirs={dirs}
                  marks={marks}
                  onLoadDir={onLoadDir}
                  onOpenFile={onOpenFile}
                  selectedPath={selectedPath}
                  onSelect={onSelect}
                  showHidden={showHidden}
                />
              ))}
        </div>
      )}
    </div>
  )
}
