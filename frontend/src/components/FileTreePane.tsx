import type { DirState } from '../hooks/useFileTree'
import type { FileMark } from '../types'
import { FileNode } from './FileNode'
import { EyeIcon, RefreshIcon } from './icons'

type Props = {
  dirs: Record<string, DirState>
  marks: Record<string, FileMark>
  onLoadDir: (path: string) => void
  onRefresh: () => void
  onOpenFile: (path: string, size?: number | null) => void
  showHidden: boolean
  onToggleHidden: () => void
  selectedPath: string | null
  onSelect: (path: string) => void
  /** 收起 = 只留标题栏，面板本身仍占位，不做横向塌陷 */
  collapsed: boolean
  onCollapse: () => void
}

export function FileTreePane({
  dirs,
  marks,
  onLoadDir,
  onRefresh,
  onOpenFile,
  showHidden,
  onToggleHidden,
  selectedPath,
  onSelect,
  collapsed,
  onCollapse,
}: Props) {
  const root = dirs['']
  const entries = root?.status === 'ready' ? root.entries : []

  return (
    <aside
      className={
        'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[10px] border border-line bg-panel ' +
        (collapsed ? 'shrink-0' : 'flex-1')
      }
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel-2 px-2.5 py-[7px]">
        <span className="text-xs tracking-[0.3px] text-dim">项目目录</span>
        <span className="ml-auto flex items-center gap-1.5">
          <button
            onClick={onCollapse}
            title={collapsed ? '展开项目目录' : '收起项目目录'}
            className="flex items-center justify-center rounded-[5px] border border-transparent p-[3px] leading-none text-dim hover:border-line hover:bg-line-soft hover:text-fg"
          >
            <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor"
              strokeWidth="1.4" className={collapsed ? 'rotate-180' : ''} aria-hidden="true">
              <path d="M4.5 3L7.5 6L4.5 9" />
            </svg>
          </button>
          <button
            onClick={onToggleHidden}
            title="显示/隐藏隐藏文件"
            aria-pressed={showHidden}
            className={
              'flex items-center justify-center rounded-[5px] border border-transparent p-[3px] leading-none ' +
              (showHidden
                ? 'border-[#1f3a5c] bg-[#0d1a26] text-accent'
                : 'text-dim hover:border-line hover:bg-line-soft hover:text-fg')
            }
          >
            <EyeIcon />
          </button>
          <button
            onClick={onRefresh}
            title="刷新目录"
            className="flex items-center justify-center rounded-[5px] border border-transparent p-[3px] leading-none text-dim hover:border-line hover:bg-line-soft hover:text-fg"
          >
            <RefreshIcon />
          </button>
        </span>
      </div>

      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-auto pb-3.5 pt-1.5" role="tree">
          {!root && <div className="px-3.5 py-2.5 text-xs text-faint">读取目录…</div>}
          {root?.status === 'error' && (
            <div className="px-3.5 py-2.5 text-xs text-err">无法读取目录：{root.message}</div>
          )}
          {root?.status === 'ready' && entries.length === 0 && (
            <div className="px-3.5 py-2.5 text-xs text-faint">（空目录）</div>
          )}

          {entries
            .filter((entry) => showHidden || !entry.hidden)
            .map((entry) => (
              <FileNode
                key={entry.name}
                entry={entry}
                depth={0}
                dirs={dirs}
                marks={marks}
                onLoadDir={onLoadDir}
                onOpenFile={onOpenFile}
                selectedPath={selectedPath}
                onSelect={onSelect}
                showHidden={showHidden}
              />
            ))}

          {root?.status === 'ready' && root.truncated && (
            <div className="px-3.5 py-2 text-xs text-faint">目录过大，只显示了前面一部分</div>
          )}
        </div>
      )}
    </aside>
  )
}
