import { useState } from 'react'

import type { GitFile, GitSnapshot } from '../types'
import { GitBranchIcon, RefreshIcon } from './icons'

const KIND_LABEL: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
  conflicted: '!',
}

const KIND_CLASS: Record<string, string> = {
  modified: 'text-warn',
  added: 'text-[#7ee787]',
  deleted: 'text-err',
  renamed: 'text-[#79c0ff]',
  untracked: 'text-[#79c0ff]',
  conflicted: 'text-err',
}

function statusTone(file: GitFile): string {
  return KIND_CLASS[file.kind] || 'text-dim'
}

type Props = {
  git: GitSnapshot | null
  loading: boolean
  error: string
  onRefresh: () => void
  /** 点工作区文件 = 打开只读 diff，不直接看全文 */
  onOpenDiff: (file: GitFile) => void
  /** 目录树收起时由 Git 区顶满右列，避免右列只剩一条之后下方留白 */
  fill?: boolean
}

/** Git 只读区：分支、工作区状态、最近提交。没有任何 add/commit 操作。 */
export function GitPane({ git, loading, error, onRefresh, onOpenDiff, fill = false }: Props) {
  const [open, setOpen] = useState(true)
  const files = git?.repo ? git.files : []
  const commits = git?.repo ? git.commits : []
  const dirty = files.length
  const ahead = git?.ahead ?? 0
  const behind = git?.behind ?? 0

  return (
    <aside
      className={
        'flex min-h-0 flex-col overflow-hidden rounded-[10px] border border-line bg-panel ' +
        (fill
          ? open
            ? 'min-h-[120px] flex-1'
            : 'shrink-0'
          : open
            ? 'h-[38%] min-h-[120px] max-h-[320px] shrink-0'
            : 'shrink-0')
      }
      aria-label="Git 只读区"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel-2 px-2.5 py-[7px]">
        <span className="text-dim"><GitBranchIcon /></span>
        <span className="min-w-0 truncate text-xs text-fg">
          {git?.repo ? git.branch : 'Git'}
        </span>
        {git?.repo && dirty > 0 && (
          <span className="shrink-0 rounded-[4px] border border-[#4b3a1c] bg-[#241b0d] px-[5px] text-[10px] text-warn">
            {dirty} 改动
          </span>
        )}
        {git?.repo && (ahead > 0 || behind > 0) && (
          <span className="shrink-0 text-[10px] text-faint">
            {ahead > 0 ? `↑${ahead}` : ''}
            {ahead > 0 && behind > 0 ? ' ' : ''}
            {behind > 0 ? `↓${behind}` : ''}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            onClick={onRefresh}
            title="刷新 git 状态"
            className="flex items-center justify-center rounded-[5px] border border-transparent p-[3px] leading-none text-dim hover:border-line hover:bg-line-soft hover:text-fg"
          >
            <RefreshIcon />
          </button>
          <button
            onClick={() => setOpen((value) => !value)}
            title={open ? '折叠 Git 区' : '展开 Git 区'}
            className="flex items-center justify-center rounded-[5px] border border-transparent p-[3px] leading-none text-dim hover:border-line hover:bg-line-soft hover:text-fg"
          >
            <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor"
              strokeWidth="1.4" className={open ? 'rotate-180' : ''} aria-hidden="true">
              <path d="M3 4.5L6 7.5L9 4.5" />
            </svg>
          </button>
        </span>
      </div>

      {open && (
        <div className="flex min-h-0 flex-1 flex-col">
          {loading && <div className="px-3 py-2 text-xs text-faint">读取 git…</div>}
          {error && <div className="px-3 py-2 text-xs text-err">git 读取失败：{error}</div>}
          {!loading && !error && git && !git.repo && (
            <div className="px-3 py-2 text-xs text-faint">当前项目不是 git 仓库。</div>
          )}

          {git?.repo && (
            <>
              <div className="min-h-0 flex-[3] overflow-auto py-1">
                {files.length === 0 && (
                  <div className="px-3 py-1.5 text-xs text-faint">工作区干净，没有未提交改动。</div>
                )}
                {files.map((file) => (
                  <button
                    key={(file.from ? `${file.from}→` : '') + file.path}
                    onClick={() => onOpenDiff(file)}
                    title={
                      file.kind === 'deleted'
                        ? `${file.path}（已删除，可查看被删内容）`
                        : file.from
                          ? `${file.from} → ${file.path}`
                          : file.path
                    }
                    className="flex w-full items-center gap-1.5 px-2.5 py-[3px] text-left leading-[1.5] hover:bg-[#151b23]"
                  >
                    <span className={'w-3 shrink-0 text-[10px] ' + statusTone(file)}>
                      {KIND_LABEL[file.kind] || '?'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg" dir="ltr">
                      {file.path}
                    </span>
                    {(file.staged || file.unstaged) && (
                      <span className="shrink-0 text-[9.5px] text-faint">
                        {file.staged ? '暂存' : '未暂存'}
                      </span>
                    )}
                  </button>
                ))}
                {git.truncated && (
                  <div className="px-3 py-1.5 text-[10.5px] text-faint">改动过多，只显示前 300 条</div>
                )}
              </div>

              <div className="shrink-0 border-t border-line">
                <div className="flex items-center gap-2 px-2.5 py-[5px] text-[10.5px] text-dim">
                  <span>最近提交</span>
                  <span className="text-faint">{commits.length}</span>
                </div>
                <div className="max-h-[112px] overflow-auto pb-1">
                  {commits.map((commit) => (
                    <div
                      key={commit.hash}
                      className="flex items-baseline gap-2 px-2.5 py-[3px]"
                      title={`${commit.author} · ${commit.when}\n${commit.subject}`}
                    >
                      <span className="shrink-0 font-mono text-[10.5px] text-[#79c0ff]">
                        {commit.hash}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-fg">
                        {commit.subject}
                      </span>
                      <span className="shrink-0 text-[9.5px] text-faint">{commit.when}</span>
                    </div>
                  ))}
                  {commits.length === 0 && (
                    <div className="px-2.5 py-1.5 text-[10.5px] text-faint">还没有提交。</div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </aside>
  )
}
