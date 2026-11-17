import { Command } from 'cmdk'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { fetchJson } from '../lib/api'
import { dirOf } from '../lib/search'
import { EASE, SPRING } from '../motion'
import type { GitFile, Project, SearchResult, SessionInfo } from '../types'

type Props = {
  open: boolean
  onClose: () => void
  projectId: string
  projectName: string
  projects: Project[]
  sessions: SessionInfo[]
  gitFiles: GitFile[]
  onOpenFile: (path: string) => void
  onOpenDiff: (file: GitFile) => void
  onOpenSession: (info: SessionInfo) => void
  onNewShell: () => void
  onSearch: () => void
  onOpenFiles: () => void
  onRefreshGit: () => void
  onPickProject: (project: Project) => void
}

/** 文件名请求的停顿：比内容搜索短一点，命令面板是「边打边看」的场景 */
const DEBOUNCE = 180
/** 命中再多也只画前这些条：再往下要的是缩小关键词，不是翻页 */
const FILE_LIMIT = 40

/**
 * 文件名候选。走的是同一个 /api/search 后端（rg --files 语义），
 * 不在前端自己爬目录树 —— .gitignore、二进制跳过这些规则只该有一份实现。
 */
function useFileMatches(projectId: string, query: string) {
  const [files, setFiles] = useState<{ path: string; name: string }[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setFiles([])
      setLoading(false)
      return
    }

    let live = true
    setLoading(true)
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: trimmed, mode: 'file' })
      if (projectId) params.set('project', projectId)
      fetchJson<SearchResult>(`/api/search/?${params}`)
        .then((response) => {
          if (!live) return
          if (!response.ok || !response.data?.ok) {
            setFiles([])
            return
          }
          setFiles((response.data.files ?? []).slice(0, FILE_LIMIT))
        })
        .catch(() => {
          if (live) setFiles([])
        })
        .finally(() => {
          if (live) setLoading(false)
        })
    }, DEBOUNCE)

    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [projectId, query])

  return { files, loading }
}

/**
 * 召唤层：一个输入框同时管「跑个动作」和「跳到某个文件」。
 *
 * 刻意不常驻：它不该和终端抢眼睛。动作排在文件前面 —— 想找文件的人会打字，
 * 想干活的人打开就该看见入口。键盘是唯一的操作路径（↑↓ Enter Esc），
 * 鼠标只是备胎。
 */
export function CommandPalette({
  open,
  onClose,
  projectId,
  projectName,
  projects,
  sessions,
  gitFiles,
  onOpenFile,
  onOpenDiff,
  onOpenSession,
  onNewShell,
  onSearch,
  onOpenFiles,
  onRefreshGit,
  onPickProject,
}: Props) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const { files, loading } = useFileMatches(projectId, query)

  // 每次打开都从空查询开始：上次的残留关键词只会让人困惑
  useEffect(() => {
    if (!open) return
    setQuery('')
    const timer = window.setTimeout(() => inputRef.current?.focus(), 40)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  /** 动作统一走这个壳：先关面板再执行，免得动作里又开一层浮层把它盖住 */
  const run = (action: () => void) => () => {
    onClose()
    action()
  }

  const gitPreview = useMemo(() => gitFiles.slice(0, 8), [gitFiles])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-3 pt-[10vh] backdrop-blur-[2px]"
          onClick={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14, ease: EASE }}
        >
          <motion.div
            className="cmdk-shell w-full max-w-[620px] overflow-hidden border border-line bg-panel shadow-[0_0_90px_rgba(0,0,0,0.7)]"
            onClick={(event) => event.stopPropagation()}
            initial={{ opacity: 0, scale: 0.985, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.99, y: -4 }}
            transition={SPRING}
          >
            <Command label="命令面板" shouldFilter loop>
              <div className="cmdk-input-row">
                <span className="shrink-0 text-[11px] text-accent">›</span>
                <Command.Input
                  ref={inputRef}
                  value={query}
                  onValueChange={setQuery}
                  placeholder="输入动作或文件名…"
                  spellCheck={false}
                  className="cmdk-input"
                />
                <span className="shrink-0 text-[10px] text-ghost">{projectName}</span>
                {loading && <span className="shrink-0 text-[10px] text-faint">…</span>}
              </div>

              <Command.List className="cmdk-list">
                <Command.Empty className="px-4 py-3 text-xs text-faint">没有匹配</Command.Empty>

                <Command.Group heading="动作" className="cmdk-group">
                  <Command.Item
                    value="新 shell 终端 bash"
                    onSelect={run(onNewShell)}
                    className="cmdk-item"
                  >
                    <span className="cmdk-key">+</span>
                    <span className="flex-1 truncate">新开 shell 面板</span>
                  </Command.Item>
                  <Command.Item
                    value="搜索 内容 代码 grep 全文"
                    onSelect={run(onSearch)}
                    className="cmdk-item"
                  >
                    <span className="cmdk-key">/</span>
                    <span className="flex-1 truncate">在代码内容里搜索</span>
                    <span className="shrink-0 text-[10px] text-ghost">Ctrl+Shift+F</span>
                  </Command.Item>
                  <Command.Item
                    value="文件 目录 git 抽屉 files"
                    onSelect={run(onOpenFiles)}
                    className="cmdk-item"
                  >
                    <span className="cmdk-key">▤</span>
                    <span className="flex-1 truncate">打开文件与 Git 抽屉</span>
                    <span className="shrink-0 text-[10px] text-ghost">Ctrl+B</span>
                  </Command.Item>
                  <Command.Item
                    value="刷新 git 状态"
                    onSelect={run(onRefreshGit)}
                    className="cmdk-item"
                  >
                    <span className="cmdk-key">↻</span>
                    <span className="flex-1 truncate">刷新 git 状态</span>
                  </Command.Item>
                </Command.Group>

                {gitPreview.length > 0 && (
                  <Command.Group heading={`git 改动 · ${gitFiles.length}`} className="cmdk-group">
                    {gitPreview.map((file) => (
                      <Command.Item
                        key={file.path}
                        value={`git ${file.path}`}
                        onSelect={run(() => onOpenDiff(file))}
                        className="cmdk-item"
                      >
                        <span className="cmdk-key text-warn">●</span>
                        <span className="flex-1 truncate">{file.path}</span>
                        <span className="shrink-0 text-[10px] text-faint">diff</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}

                {sessions.length > 0 && (
                  <Command.Group heading={`会话 · ${sessions.length}`} className="cmdk-group">
                    {sessions.slice(0, 8).map((session) => (
                      <Command.Item
                        key={session.sid}
                        value={`会话 ${session.sid} ${session.profile} ${session.label ?? ''}`}
                        onSelect={run(() => onOpenSession(session))}
                        className="cmdk-item"
                      >
                        <span className="cmdk-key">◍</span>
                        <span className="flex-1 truncate">
                          {session.label || session.profile}
                        </span>
                        <span className="shrink-0 text-[10px] text-faint">
                          {session.sid.slice(0, 8)}
                        </span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}

                {files.length > 0 && (
                  <Command.Group heading={`文件 · ${files.length}`} className="cmdk-group">
                    {files.map((file) => (
                      <Command.Item
                        key={file.path}
                        value={`文件 ${file.path}`}
                        onSelect={run(() => onOpenFile(file.path))}
                        className="cmdk-item"
                      >
                        <span className="cmdk-key">·</span>
                        <span className="min-w-0 flex-1 truncate">{file.name}</span>
                        <span className="shrink-0 max-w-[46%] truncate text-[10px] text-faint">
                          {dirOf(file.path)}
                        </span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}

                {projects.length > 1 && (
                  <Command.Group heading="切换项目" className="cmdk-group">
                    {projects
                      .filter((item) => item.id !== projectId)
                      .map((item) => (
                        <Command.Item
                          key={item.id}
                          value={`项目 ${item.name} ${item.path}`}
                          onSelect={run(() => onPickProject(item))}
                          className="cmdk-item"
                        >
                          <span className="cmdk-key">⌂</span>
                          <span className="flex-1 truncate">{item.name}</span>
                          <span className="shrink-0 max-w-[46%] truncate text-[10px] text-faint">
                            {item.path}
                          </span>
                        </Command.Item>
                      ))}
                  </Command.Group>
                )}
              </Command.List>

              <footer className="cmdk-foot">
                <span>↑↓ 选择 · Enter 执行 · Esc 关闭</span>
                <span className="ml-auto">Ctrl+K</span>
              </footer>
            </Command>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
