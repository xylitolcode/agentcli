import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

import { FileTreePane } from './components/FileTreePane'
import { Header } from './components/Header'
import { ProjectPicker } from './components/ProjectPicker'
import { Splitter } from './components/Splitter'
import { StatusBar } from './components/StatusBar'
import { TerminalPane } from './components/TerminalPane'
import type { TerminalHandle } from './components/TerminalPane'
import { useFileTree } from './hooks/useFileTree'
import { useRoom } from './hooks/useRoom'
import { shellQuote } from './lib/format'
import { isFontInstalled } from './lib/terminal'
import type {
  Bootstrap,
  ConnStatus,
  ControlMessage,
  FileMark,
  Project,
  RenderMode,
} from './types'

const MIN_TREE = 230
const MAX_TREE = 720
const DEFAULT_TREE = 330

const SESSION_KEY = `agentcli.session.${location.host}`

function readQuery() {
  const params = new URLSearchParams(location.search)
  return {
    profile: params.get('profile') ?? '',
    sid: params.get('sid') ?? '',
    project: params.get('project') ?? '',
  }
}

/** URL 是唯一真相：刷新、前进后退、分享链接都能还原到同一个会话。 */
function syncUrl(profile: string, sid: string | null, project: string) {
  const params = new URLSearchParams(location.search)
  const write = (key: string, value: string) => {
    if (value) params.set(key, value)
    else params.delete(key)
  }
  write('profile', profile)
  write('sid', sid ?? '')
  write('project', project)

  const query = params.toString()
  history.replaceState(null, '', location.pathname + (query ? `?${query}` : ''))
}

export default function App({ bootstrap }: { bootstrap: Bootstrap }) {
  const query = useMemo(readQuery, [])

  const [projectId, setProjectId] = useState(query.project)
  const [profile, setProfile] = useState(() =>
    bootstrap.profiles.some((p) => p.name === query.profile) ? query.profile : bootstrap.defaultProfile,
  )
  const [sid, setSid] = useState<string | null>(
    query.sid || localStorage.getItem(SESSION_KEY) || null,
  )
  const [outsourcing, setOutsourcing] = useState(false)
  const [fileMarks, setFileMarks] = useState<Record<string, FileMark>>({})

  const [status, setStatus] = useState<ConnStatus>('connecting')
  const [renderMode, setRenderMode] = useState<RenderMode>('dom')
  const [size, setSize] = useState({ cols: 0, rows: 0 })
  const [treeWidth, setTreeWidth] = useState(DEFAULT_TREE)
  const [showHidden, setShowHidden] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  const terminal = useRef<TerminalHandle>(null)
  // 只在挂载时读一次：之后的 sid 由服务端下发，不再回灌给 usePty
  const initialSidRef = useRef(query.sid || localStorage.getItem(SESSION_KEY) || '')

  const { sessions, refresh: refreshRoom } = useRoom()
  const { dirs, load, refresh } = useFileTree(projectId)

  const fontOk = useMemo(() => isFontInstalled('Sarasa Term SC Nerd'), [])

  const project = useMemo(
    () => bootstrap.projects.find((p) => p.id === projectId),
    [bootstrap.projects, projectId],
  )

  useEffect(() => {
    if (projectId) void load('')
  }, [projectId, load])

  /* ---------------- 会话状态 ---------------- */

  const handleSidChange = useCallback(
    (next: string | null) => {
      setSid(next)
      if (next) localStorage.setItem(SESSION_KEY, next)
      else localStorage.removeItem(SESSION_KEY)
      syncUrl(profile, next, projectId)
    },
    [profile, projectId],
  )

  const handleControl = useCallback(
    (message: ControlMessage) => {
      switch (message.type) {
        case 'session':
          if (typeof message.outsourcing === 'boolean') setOutsourcing(message.outsourcing)
          refreshRoom()
          break
        case 'file-events':
          setFileMarks((prev) => {
            const next = { ...prev }
            for (const [path, mark] of Object.entries(message.files ?? {})) {
              const current = next[path] ?? { read: false, write: false }
              next[path] = { read: current.read || mark.read, write: current.write || mark.write }
            }
            return next
          })
          break
        case 'agent-event':
          if (message.event?.kind === 'tool' && message.event.file) {
            const { file, action } = message.event
            setFileMarks((prev) => {
              const current = prev[file] ?? { read: false, write: false }
              return {
                ...prev,
                [file]: {
                  read: current.read || action === 'read',
                  write: current.write || action === 'write',
                },
              }
            })
          }
          refreshRoom()
          break
        case 'delegate-result':
        case 'session-eof':
        case 'session-missing':
          refreshRoom()
          break
        default:
          break
      }
    },
    [refreshRoom],
  )

  // 重连成功后再同步一次外包开关，避免服务端重启后状态漂移
  useEffect(() => {
    if (status === 'online') terminal.current?.setOutsourcing(outsourcing)
    // outsourcing 故意不进依赖：切换时已经即时发过一次帧了
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  /* ---------------- 交互 ---------------- */

  const enterProject = useCallback(
    (picked: Project) => {
      setProjectId(picked.id)
      setSid(null)
      setFileMarks({})
      initialSidRef.current = ''
      localStorage.removeItem(SESSION_KEY)
      if (picked.agent && bootstrap.profiles.some((p) => p.name === picked.agent)) {
        setProfile(picked.agent)
      }
      syncUrl(picked.agent || profile, '', picked.id)
    },
    [bootstrap.profiles, profile],
  )

  const changeProfile = useCallback(
    (name: string) => {
      if (name === profile) return
      setProfile(name)
      setSid(null)
      initialSidRef.current = ''
      localStorage.removeItem(SESSION_KEY)
      syncUrl(name, '', projectId)
    },
    [profile, projectId],
  )

  const toggleOutsourcing = useCallback(() => {
    setOutsourcing((prev) => {
      const next = !prev
      terminal.current?.setOutsourcing(next)
      return next
    })
  }, [])

  const handleReconnect = useCallback(
    (fresh: boolean) => {
      if (fresh) {
        setSid(null)
        localStorage.removeItem(SESSION_KEY)
        initialSidRef.current = ''
      }
      terminal.current?.reconnect({ fresh })
    },
    [],
  )

  const handleOpenFile = useCallback((path: string) => {
    terminal.current?.insert(`${shellQuote(path)} `)
  }, [])

  const handleDrag = useCallback((clientX: number) => {
    const max = Math.min(MAX_TREE, window.innerWidth * 0.62)
    setTreeWidth(Math.min(Math.max(window.innerWidth - clientX - 8, MIN_TREE), max))
  }, [])

  const workspaceStyle = { '--tree-w': `${treeWidth}px` } as CSSProperties

  if (!projectId) {
    return (
      <div className="flex h-full flex-col">
        <Header label={bootstrap.rootPath} />
        <ProjectPicker projects={bootstrap.projects} onPick={enterProject} />
        <StatusBar
          status={status}
          renderMode={renderMode}
          cols={0}
          rows={0}
          fontOk={fontOk}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <Header label={project ? `${project.name} · ${project.path}` : bootstrap.rootPath} />

      <main className="workspace min-h-0 flex-1 px-3.5 pb-2.5 pt-3" style={workspaceStyle}>
        <TerminalPane
          ref={terminal}
          profile={profile}
          profiles={bootstrap.profiles}
          projectId={projectId}
          initialSid={initialSidRef.current}
          rootName={project?.name ?? bootstrap.rootName}
          outsourcing={outsourcing}
          sessions={sessions}
          sid={sid}
          onProfileChange={changeProfile}
          onStatus={setStatus}
          onRenderMode={setRenderMode}
          onSize={(cols, rows) => setSize({ cols, rows })}
          onControl={handleControl}
          onSidChange={handleSidChange}
          onToggleOutsourcing={toggleOutsourcing}
          onReconnect={handleReconnect}
        />
        <Splitter onDrag={handleDrag} onDragEnd={() => undefined} />
        <FileTreePane
          dirs={dirs}
          marks={fileMarks}
          onLoadDir={load}
          onRefresh={refresh}
          onOpenFile={handleOpenFile}
          showHidden={showHidden}
          onToggleHidden={() => setShowHidden((v) => !v)}
          selectedPath={selectedPath}
          onSelect={setSelectedPath}
        />
      </main>

      <StatusBar
        status={status}
        renderMode={renderMode}
        cols={size.cols}
        rows={size.rows}
        fontOk={fontOk}
      />
    </div>
  )
}
