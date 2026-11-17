import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

import { FileTreePane } from './components/FileTreePane'
import { Header } from './components/Header'
import { ProjectPicker } from './components/ProjectPicker'
import { SessionPanel } from './components/SessionPanel'
import type { SessionHandle } from './components/SessionPanel'
import { Splitter } from './components/Splitter'
import { StatusBar } from './components/StatusBar'
import { WorkspaceBar } from './components/WorkspaceBar'
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
  SessionInfo,
} from './types'

const MIN_TREE = 230
const MAX_TREE = 720
const DEFAULT_TREE = 330

/** 一条 WebSocket 一个面板；WebGL 上下文和终端实例都得省着点用 */
const MAX_PANELS = 6

const SESSION_KEY = `agentcli.session.${location.host}`
const SESSION_PROFILE_KEY = `agentcli.profile.${location.host}`
const layoutKey = (projectId: string) => `agentcli.panels.${location.host}.${projectId}`

/** 一个面板 = 一个前台会话的观察者。key 在拿到 sid 之前也稳定 */
type Panel = {
  key: string
  profile: string
  /** 挂载时用来接回旧会话；之后变的是 sid */
  initialSid: string
  sid: string | null
  /** 新会话的初始任务 */
  prompt: string
  /** 从房间点开的子会话，带上父子关系用于展示 */
  meta: SessionInfo | null
}

type PanelStat = {
  status: ConnStatus
  cols: number
  rows: number
  renderMode: RenderMode
}

let panelSeq = 0
const nextPanelKey = () => `panel-${(panelSeq += 1)}`

function readQuery() {
  const params = new URLSearchParams(location.search)
  return {
    profile: params.get('profile') ?? '',
    sid: params.get('sid') ?? '',
    project: params.get('project') ?? '',
    prompt: params.get('prompt') ?? '',
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
  // prompt 只在建会话那一次有用；留在地址栏会让「过期重建」把旧任务再跑一遍
  params.delete('prompt')

  const query = params.toString()
  history.replaceState(null, '', location.pathname + (query ? `?${query}` : ''))
}

const shortSid = (sid: string) => (sid ? sid.slice(0, 8) : '?')

function promptPreview(prompt: string, max = 28): string {
  const line = prompt.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/** 持久化的只有主面板：子会话面板是临时观察窗，刷新后从房间条重新点开。 */
type SavedPanel = { profile: string; sid: string; prompt: string }
type SavedLayout = { panels: SavedPanel[]; activeSid: string }

function readLayout(projectId: string): SavedLayout | null {
  try {
    const raw = localStorage.getItem(layoutKey(projectId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as SavedLayout
    if (!Array.isArray(parsed.panels)) return null
    const panels = parsed.panels.filter(
      (item): item is SavedPanel =>
        !!item && typeof item.sid === 'string' && item.sid.length > 0 && typeof item.profile === 'string',
    )
    return panels.length > 0
      ? { panels, activeSid: typeof parsed.activeSid === 'string' ? parsed.activeSid : '' }
      : null
  } catch {
    return null
  }
}

function saveLayout(projectId: string, panels: Panel[], activeKey: string) {
  const mains = panels.filter((panel) => !panel.meta && panel.sid)
  if (mains.length === 0) {
    localStorage.removeItem(layoutKey(projectId))
    return
  }
  const active = mains.find((panel) => panel.key === activeKey)
  const payload: SavedLayout = {
    panels: mains
      .slice(0, MAX_PANELS)
      .map((panel) => ({ profile: panel.profile, sid: panel.sid ?? '', prompt: panel.prompt })),
    activeSid: active?.sid ?? '',
  }
  localStorage.setItem(layoutKey(projectId), JSON.stringify(payload))
}

export default function App({ bootstrap }: { bootstrap: Bootstrap }) {
  const query = useMemo(readQuery, [])

  const [projectId, setProjectId] = useState(query.project)
  const [outsourcing, setOutsourcing] = useState(false)
  const [fileMarks, setFileMarks] = useState<Record<string, FileMark>>({})

  const [treeWidth, setTreeWidth] = useState(DEFAULT_TREE)
  const [showHidden, setShowHidden] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  /**
   * 多面板：初始还原「上一个布局」（只含主面板）。
   * 显式带 sid 的链接（分享/收藏）只在保存的布局里没有这个 sid 时单独开一个；
   * 子会话面板是临时观察窗，不持久化，刷新后从房间条重新点开。
   */
  const initialLayout = useMemo(() => {
    const makePanel = (profile: string, sid: string, prompt: string): Panel => ({
      key: nextPanelKey(),
      profile,
      initialSid: sid,
      sid: sid || null,
      prompt,
      meta: null,
    })
    const validProfile = (name: string) => bootstrap.profiles.some((p) => p.name === name)

    const saved = projectId ? readLayout(projectId) : null
    if (saved && (!query.sid || saved.panels.some((p) => p.sid === query.sid))) {
      const restored = saved.panels
        .filter((p) => validProfile(p.profile))
        .slice(0, MAX_PANELS)
        .map((p) => makePanel(p.profile, p.sid, p.prompt))
      if (restored.length > 0) {
        const wanted = query.sid || saved.activeSid
        const active = restored.find((p) => p.sid === wanted) ?? restored[0]
        return { panels: restored, activeKey: active.key }
      }
    }

    // localStorage 只在 URL 没给足信息时兜底：显式带了 prompt 就是「开新会话」，
    // 记着 profile 是为了别把 bash 的 sid 接到 claude 面板上（同一个浏览器里
    // 所有标签页共享 localStorage）。
    const storedSid = query.prompt ? '' : (localStorage.getItem(SESSION_KEY) ?? '')
    const storedProfile = localStorage.getItem(SESSION_PROFILE_KEY)
    const savedSid =
      query.sid ||
      (!query.profile || !storedProfile || query.profile === storedProfile ? storedSid : '')
    const profile = validProfile(query.profile) ? query.profile : bootstrap.defaultProfile
    const panel = makePanel(profile, savedSid, query.prompt)
    return { panels: [panel], activeKey: panel.key }
    // 只在首次渲染算一次；之后由 URL/面板操作驱动
  }, [])

  const [panels, setPanels] = useState<Panel[]>(() => initialLayout.panels)
  const [activeKey, setActiveKey] = useState(() => initialLayout.activeKey)
  const [stats, setStats] = useState<Record<string, PanelStat>>({})

  const handles = useRef(new Map<string, SessionHandle>())
  const pendingInsert = useRef<string | null>(null)

  const { sessions, refresh: refreshRoom } = useRoom()
  const { dirs, load, refresh } = useFileTree(projectId)

  const fontOk = useMemo(() => isFontInstalled('Sarasa Term SC Nerd'), [])

  const project = useMemo(
    () => bootstrap.projects.find((p) => p.id === projectId),
    [bootstrap.projects, projectId],
  )

  // 新面板默认用项目偏好 agent；它必须带任务，所以「新终端」另选 shell
  const shellProfile = useMemo(
    () => bootstrap.profiles.find((p) => p.kind === 'shell') ?? bootstrap.profiles[0],
    [bootstrap.profiles],
  )
  const spawnDefault = useMemo(() => {
    if (project?.agent && bootstrap.profiles.some((p) => p.name === project.agent)) {
      return project.agent
    }
    return bootstrap.defaultProfile
  }, [bootstrap.defaultProfile, bootstrap.profiles, project])

  useEffect(() => {
    if (projectId) void load('')
  }, [projectId, load])

  /* ---------------- 会话状态 ---------------- */

  const patchStat = useCallback((key: string, patch: Partial<PanelStat>) => {
    setStats((prev) => {
      const current = prev[key] ?? { status: 'connecting', cols: 0, rows: 0, renderMode: 'dom' }
      const next = { ...current, ...patch }
      if (
        next.status === current.status &&
        next.cols === current.cols &&
        next.rows === current.rows &&
        next.renderMode === current.renderMode
      ) {
        return prev
      }
      return { ...prev, [key]: next }
    })
  }, [])

  const handleSidChange = useCallback((key: string, sid: string | null) => {
    setPanels((prev) => prev.map((panel) => (panel.key === key ? { ...panel, sid } : panel)))
  }, [])

  const handleControl = useCallback(
    (key: string, message: ControlMessage) => {
      switch (message.type) {
        case 'session':
          // 外包开关是全局的，只认活动面板的首帧，避免子面板把用户刚切的状态顶回去
          if (typeof message.outsourcing === 'boolean' && key === activeKey) {
            setOutsourcing(message.outsourcing)
          }
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
    [activeKey, refreshRoom],
  )

  // URL / localStorage 跟着「主面板」走：子会话面板是临时观察窗，把它的 sid
  // 写进地址栏，刷新回来只会看到一个已过期的空壳。收藏/刷新始终落到主会话。
  // 「主面板」取最近一个活动过的主会话面板（不是第一个），否则点开子面板看屏
  // 回来，地址栏会莫名其妙跳回别的会话。
  const lastMainKey = useRef(initialLayout.activeKey)
  useEffect(() => {
    const panel = panels.find((item) => item.key === activeKey)
    if (panel && !panel.meta) lastMainKey.current = panel.key
  }, [activeKey, panels])

  useEffect(() => {
    const urlPanel =
      panels.find((panel) => panel.key === lastMainKey.current) ??
      panels.find((panel) => !panel.meta) ??
      panels[0]
    const sid = urlPanel?.sid ?? null
    const profile = urlPanel?.profile ?? bootstrap.defaultProfile
    if (sid) {
      localStorage.setItem(SESSION_KEY, sid)
      localStorage.setItem(SESSION_PROFILE_KEY, profile)
    } else {
      localStorage.removeItem(SESSION_KEY)
      localStorage.removeItem(SESSION_PROFILE_KEY)
    }
    syncUrl(profile, sid, projectId)
  }, [activeKey, bootstrap.defaultProfile, panels, projectId])

  // 布局落盘防抖 200ms：连开面板/关面板时别每次都写 localStorage
  useEffect(() => {
    if (!projectId) return
    const timer = window.setTimeout(() => saveLayout(projectId, panels, activeKey), 200)
    return () => window.clearTimeout(timer)
  }, [activeKey, panels, projectId])

  /* ---------------- 面板管理 ---------------- */

  const addPanel = useCallback(
    (profile: string, prompt: string, sid = '', meta: SessionInfo | null = null) => {
      if (panels.length >= MAX_PANELS) return
      const key = nextPanelKey()
      setPanels((prev) => [
        ...prev,
        { key, profile, initialSid: sid, sid: sid || null, prompt, meta },
      ])
      setActiveKey(key)
    },
    [panels.length],
  )

  const closePanel = useCallback(
    (key: string) => {
      const index = panels.findIndex((panel) => panel.key === key)
      const next = panels.filter((panel) => panel.key !== key)
      if (activeKey === key) setActiveKey(next[Math.min(index, next.length - 1)]?.key ?? '')
      setPanels(next)
    },
    [activeKey, panels],
  )

  const closeAll = useCallback(() => {
    setPanels([])
    setActiveKey('')
    localStorage.removeItem(SESSION_KEY)
    localStorage.removeItem(SESSION_PROFILE_KEY)
    if (projectId) localStorage.removeItem(layoutKey(projectId))
  }, [projectId])

  const openSession = useCallback(
    (info: SessionInfo) => {
      const existing = panels.find((panel) => panel.sid === info.sid)
      if (existing) {
        setActiveKey(existing.key)
        return
      }
      addPanel(info.profile, '', info.sid, info)
    },
    [addPanel, panels],
  )

  /* ---------------- 交互 ---------------- */

  const enterProject = useCallback(
    (picked: Project) => {
      setProjectId(picked.id)
      setFileMarks({})
      setSelectedPath(null)

      // 换项目 = 换工作目录，旧面板的进程还指着老 cwd，直接丢掉
      const key = nextPanelKey()
      const shell = shellProfile?.name ?? bootstrap.defaultProfile
      setPanels([
        { key, profile: shell, initialSid: '', sid: null, prompt: '', meta: null },
      ])
      setActiveKey(key)
      syncUrl(shell, '', picked.id)
    },
    [bootstrap.defaultProfile, shellProfile],
  )

  const toggleOutsourcing = useCallback(() => {
    setOutsourcing((prev) => {
      const next = !prev
      // 已经连上的面板立刻切；还没连上的会把 outsourcing 拼进 query
      for (const handle of handles.current.values()) handle.setOutsourcing(next)
      return next
    })
  }, [])

  const handleOpenFile = useCallback(
    (path: string) => {
      const text = `${shellQuote(path)} `
      const handle = handles.current.get(activeKey)
      if (handle) {
        handle.insert(text)
        return
      }
      // 面板都关了：先开一个 shell 面板，等它挂载后把路径补进去
      pendingInsert.current = text
      addPanel(shellProfile?.name ?? bootstrap.defaultProfile, '')
    },
    [activeKey, addPanel, bootstrap.defaultProfile, shellProfile],
  )

  useEffect(() => {
    if (!pendingInsert.current) return
    const handle = handles.current.get(activeKey)
    if (!handle) return
    handle.insert(pendingInsert.current)
    pendingInsert.current = null
  }, [activeKey, panels.length])

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
          status="connecting"
          renderMode="dom"
          cols={0}
          rows={0}
          fontOk={fontOk}
        />
      </div>
    )
  }

  const activePanel = panels.find((panel) => panel.key === activeKey) ?? panels[0] ?? null
  const activeStat = activePanel ? stats[activePanel.key] : undefined
  const columns = panels.length <= 1 ? 1 : panels.length <= 4 ? 2 : 3

  return (
    <div className="flex h-full flex-col">
      <Header label={project ? `${project.name} · ${project.path}` : bootstrap.rootPath} />

      <main className="workspace min-h-0 flex-1 px-3.5 pb-2.5 pt-3" style={workspaceStyle}>
        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[10px] border border-line bg-panel">
          <WorkspaceBar
            profiles={bootstrap.profiles}
            defaultProfile={activePanel?.profile ?? spawnDefault}
            outsourcing={outsourcing}
            sessions={sessions}
            activeSid={activePanel?.sid ?? null}
            panelCount={panels.length}
            maxPanels={MAX_PANELS}
            onSpawn={addPanel}
            onToggleOutsourcing={toggleOutsourcing}
            onOpenSession={openSession}
            onCloseAll={closeAll}
          />

          {panels.length === 0 ? (
            <div className="flex flex-1 items-center justify-center px-4 text-xs text-faint">
              没有打开的会话 · 上面选个 profile，点「派任务 / 新终端」
            </div>
          ) : (
            <div className="panel-grid min-h-0 flex-1 p-2" data-cols={columns}>
              {panels.map((panel) => {
                const isChild = panel.meta?.role === 'child'
                // 委派子槽能「原槽重跑」上一轮任务；普通子会话没有台账可依
                const rerunOnEnded = isChild && !!panel.meta?.delegation
                const kind = bootstrap.profiles.find((p) => p.name === panel.profile)?.kind
                // shell 空着也能重开；agent 必须还有任务，否则会话起不来
                const restartable =
                  kind === 'shell' || panel.prompt.trim().length > 0 || rerunOnEnded
                const title = isChild
                  ? `↳ ${panel.meta?.label || panel.profile}`
                  : panel.profile
                const subtitle = isChild
                  ? `父 ${shortSid(panel.meta?.parent ?? '')}${
                      panel.meta?.delegation ? ` · ${panel.meta.delegation}` : ''
                    }`
                  : panel.prompt
                    ? `「${promptPreview(panel.prompt)}」`
                    : undefined

                return (
                  <SessionPanel
                    key={panel.key}
                    panelKey={panel.key}
                    profile={panel.profile}
                    projectId={projectId}
                    initialSid={panel.initialSid}
                    prompt={panel.prompt}
                    outsourcing={outsourcing}
                    active={panel.key === activeKey}
                    restartable={restartable}
                    rerunOnEnded={rerunOnEnded}
                    title={title}
                    subtitle={subtitle}
                    ref={(handle) => {
                      if (handle) handles.current.set(panel.key, handle)
                      else handles.current.delete(panel.key)
                    }}
                    onActivate={() => setActiveKey(panel.key)}
                    onClose={() => closePanel(panel.key)}
                    onSidChange={(sid) => handleSidChange(panel.key, sid)}
                    onStatus={(status) => patchStat(panel.key, { status })}
                    onRenderMode={(renderMode) => patchStat(panel.key, { renderMode })}
                    onSize={(cols, rows) => patchStat(panel.key, { cols, rows })}
                    onControl={(message) => handleControl(panel.key, message)}
                  />
                )
              })}
            </div>
          )}
        </section>

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
        status={activeStat?.status ?? 'ended'}
        renderMode={activeStat?.renderMode ?? 'dom'}
        cols={activeStat?.cols ?? 0}
        rows={activeStat?.rows ?? 0}
        fontOk={fontOk}
      />
    </div>
  )
}
