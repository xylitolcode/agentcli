import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import cpp from 'highlight.js/lib/languages/cpp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import dos from 'highlight.js/lib/languages/dos'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import makefile from 'highlight.js/lib/languages/makefile'
import markdown from 'highlight.js/lib/languages/markdown'
import nginx from 'highlight.js/lib/languages/nginx'
import powershell from 'highlight.js/lib/languages/powershell'
import properties from 'highlight.js/lib/languages/properties'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import 'highlight.js/styles/github-dark.css'
import { fetchJson } from '../lib/api'

import { baseName, extOf, isMarkdownFile } from '../lib/fileKind'
import type { FileContent } from '../types'
import { FileIcon } from './icons'
import { MarkdownView } from './MarkdownView'

const LANGUAGES = {
  bash,
  cpp,
  css,
  diff,
  dockerfile,
  dos,
  go,
  ini,
  java,
  javascript,
  json,
  makefile,
  markdown,
  nginx,
  powershell,
  properties,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
}

for (const [name, definition] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, definition)
}
// 这一版 highlight.js 没有独立的 toml 模块；ini 的定义里已经带 toml 别名，
// 所以 TOML 走 ini 就够，不额外注册。

/** 扩展名 -> 语言。只放确认能对应上的；查不到就当纯文本，绝不猜。 */
const LANGUAGE_BY_EXT: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', pyi: 'python', pyw: 'python',
  sh: 'bash', bash: 'bash', zsh: 'bash', ksh: 'bash',
  json: 'json', jsonc: 'json', json5: 'json',
  css: 'css', scss: 'css', less: 'css',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml', xhtml: 'xml',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  yaml: 'yaml', yml: 'yaml',
  rs: 'rust',
  java: 'java',
  go: 'go',
  sql: 'sql',
  c: 'cpp', h: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  // 配置类：这些才是「没有编程语言扩展名」的重灾区
  toml: 'toml',
  ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'properties',
  editorconfig: 'ini', npmrc: 'ini', env: 'ini', service: 'ini',
  mk: 'makefile', mak: 'makefile',
  dockerfile: 'dockerfile',
  nginx: 'nginx',
  diff: 'diff', patch: 'diff',
  ps1: 'powershell', psd1: 'powershell', psm1: 'powershell',
  bat: 'dos', cmd: 'dos',
}

/** 无扩展名的文件名（或前缀）-> 语言。Dockerfile / Makefile 这类只能按名字认。 */
const LANGUAGE_BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'nginx.conf': 'nginx',
  '.env': 'ini',
  '.npmrc': 'ini',
  '.editorconfig': 'ini',
  '.gitconfig': 'ini',
  'pipfile': 'toml',
  'cmakelists.txt': 'makefile',
}

/** 没有扩展名时的内容线索：shebang 比文件名更诚实 */
const SHEBANGS: Array<[RegExp, string]> = [
  [/^#!.*\b(?:ba|z|k|da)?sh\b/, 'bash'],
  [/^#!.*\bpython[0-9.]*\b/, 'python'],
  [/^#!.*\bnode\b/, 'javascript'],
]

/** 认不出的就别染，宁可当纯文本 */
const PLAIN_TEXT = ''

/** 行高写死，搜索跳转只靠 `(行号-1) * LINE_HEIGHT` 算位置 —— 别改成 em/rem 再算 */
const LINE_HEIGHT = 18
const PRE_PADDING = 12

const HIGHLIGHT_LIMIT = 200_000
/** 渲染态比染色重得多（整篇 DOM + 净化），太大就只给源码，别把界面卡死 */
const RENDER_LIMIT = 300_000

function languageOf(path: string): string {
  const name = baseName(path)
  const exact = LANGUAGE_BY_NAME[name]
  if (exact) return exact
  // Dockerfile.dev / .env.local / Makefile.am 这类带后缀的变体
  if (name.startsWith('dockerfile') || name.endsWith('.dockerfile')) return 'dockerfile'
  if (name.startsWith('makefile')) return 'makefile'
  if (name.startsWith('.env')) return 'ini'
  return LANGUAGE_BY_EXT[extOf(name)] || PLAIN_TEXT
}

function shebangLanguage(content: string): string {
  if (!content.startsWith('#!')) return PLAIN_TEXT
  const newline = content.indexOf('\n')
  const first = newline >= 0 ? content.slice(0, newline) : content.slice(0, 120)
  for (const [pattern, language] of SHEBANGS) {
    if (pattern.test(first)) return language
  }
  return PLAIN_TEXT
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 语言判定结果，给 header 显示用，也保证和实际染色是同一份判断 */
function detectLanguage(content: string, path: string): string {
  const byName = languageOf(path)
  if (byName && hljs.getLanguage(byName)) return byName
  const byShebang = shebangLanguage(content)
  if (byShebang && hljs.getLanguage(byShebang)) return byShebang
  return PLAIN_TEXT
}

function highlighted(content: string, path: string): string {
  if (content.length > HIGHLIGHT_LIMIT) return escapeHtml(content)
  const language = detectLanguage(content, path)
  // 没有可信语言标识就原样转义。不再用 highlightAuto 去「猜」——
  // 它会把普通笔记按关键字打分判成 python/bash，纯文本被染成乱码一样的彩色。
  if (!language) return escapeHtml(content)
  try {
    return hljs.highlight(content, { language, ignoreIllegals: true }).value
  } catch {
    return escapeHtml(content)
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

type MdMode = 'render' | 'source'

const MD_MODE_KEY = 'agentcli.md.mode'

/** 只记「渲染 / 源码」这一个偏好，下次打开 md 还是上次的选择 */
function readMdMode(): MdMode {
  try {
    return window.localStorage.getItem(MD_MODE_KEY) === 'source' ? 'source' : 'render'
  } catch {
    return 'render'
  }
}

type Props = {
  path: string
  projectId: string
  onClose: () => void
  /** 把路径插进当前终端（保留原有“点文件送路径”的能力） */
  onInsert: (path: string) => void
  /** 从搜索/差异跳进来时要高亮并滚到的行号（1-based） */
  focusLine?: number
}

/** 只读代码查看器：只展示，不提供保存/新建/删除。 */
export function CodeViewer({ path, projectId, onClose, onInsert, focusLine }: Props) {
  const [data, setData] = useState<FileContent | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [mdMode, setMdMode] = useState<MdMode>(readMdMode)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError('')
    setData(null)
    const params = new URLSearchParams({ path })
    if (projectId) params.set('project', projectId)
    fetchJson<FileContent>(`/api/file/?${params}`)
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
  }, [path, projectId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const switchMdMode = useCallback((next: MdMode) => {
    setMdMode(next)
    try {
      window.localStorage.setItem(MD_MODE_KEY, next)
    } catch {
      // 存储被禁用时写不进去，本会话生效就够
    }
  }, [])

  const shownPath = data?.path || path
  const isMarkdown = isMarkdownFile(shownPath)
  const tooBigToRender = (data?.content.length ?? 0) > RENDER_LIMIT
  /** 只有 markdown、非二进制、没超过渲染上限，且选中「渲染」时才走渲染态 */
  const rendering = isMarkdown && !!data && !data.binary && !tooBigToRender && mdMode === 'render'

  // 只有源码态才有行号可言；markdown 渲染态没有行，别硬高亮
  const focusRow =
    typeof focusLine === 'number' && focusLine > 0 && !rendering ? focusLine : null

  useEffect(() => {
    const box = scrollRef.current
    if (!box || focusRow === null) return
    // 等一帧，让高亮后的 DOM 定型再滚，否则拿到的是旧高度
    const frame = window.requestAnimationFrame(() => {
      const top = PRE_PADDING + (focusRow - 1) * LINE_HEIGHT
      box.scrollTop = Math.max(0, top - box.clientHeight / 3)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focusRow, data])

  const html = useMemo(
    () => (data && !data.binary && !rendering ? highlighted(data.content, data.path) : ''),
    [data, rendering],
  )
  const language = useMemo(
    () => (data && !data.binary && !rendering ? detectLanguage(data.content, data.path) : ''),
    [data, rendering],
  )
  const meta = data
    ? `${data.lines} 行 · ${formatSize(data.size)}${data.truncated ? ' · 已截断' : ''}`
    : ''

  const modeButton = (mode: MdMode, label: string, disabled = false) => (
    <button
      key={mode}
      onClick={() => switchMdMode(mode)}
      disabled={disabled}
      aria-pressed={mdMode === mode}
      title={
        disabled
          ? '文件超过 300 KB，渲染会很卡，只保留源码'
          : mode === 'render'
            ? '按 Markdown 渲染显示'
            : '看原始 Markdown 源码'
      }
      className={
        'px-[7px] py-[2px] text-[10.5px] leading-[1.5] ' +
        (mdMode === mode
          ? 'bg-[#0d1a26] text-accent '
          : 'text-dim hover:bg-line-soft hover:text-fg ') +
        (disabled ? 'cursor-not-allowed opacity-40 ' : '') +
        (mode === 'source' ? 'border-l border-line' : '')
      }
    >
      {label}
    </button>
  )

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/55 p-3 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <section
        className="flex h-[88vh] w-full max-w-[1100px] flex-col overflow-hidden rounded-[10px] border border-line bg-[#0b1017] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        aria-label="只读代码查看器"
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-line bg-panel-2 px-3 py-2">
          <span className="shrink-0 text-[#8b98a8]"><FileIcon /></span>
          <span className="min-w-0 truncate text-xs text-fg" title={shownPath}>
            {shownPath}
          </span>
          {meta && <span className="shrink-0 text-[10.5px] text-faint">{meta}</span>}
          {data && !data.binary && !rendering && (
            <span
              className="shrink-0 rounded-[4px] border border-line px-1 text-[10px] text-dim"
              title={language ? `按 ${language} 语法染色` : '没有可信语言标识，按纯文本显示'}
            >
              {language || '纯文本'}
            </span>
          )}
          {isMarkdown && data && !data.binary && (
            <span className="flex shrink-0 items-center overflow-hidden rounded-[4px] border border-line">
              {modeButton('render', '渲染', tooBigToRender)}
              {modeButton('source', '源码')}
            </span>
          )}
          {data?.encoding && data.encoding !== 'utf-8' && (
            <span className="shrink-0 text-[10.5px] text-warn">{data.encoding}</span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <button
              onClick={() => onInsert(shownPath)}
              className="rounded-[5px] border border-line px-2 py-1 text-[10.5px] text-dim hover:bg-line-soft hover:text-fg"
              title="把文件路径插入当前终端（不是编辑内容）"
            >
              插入终端
            </button>
            <button
              onClick={onClose}
              className="rounded-[5px] border border-transparent px-2 py-1 text-sm leading-none text-dim hover:border-line hover:bg-line-soft hover:text-fg"
              title="关闭（Esc）"
            >
              ×
            </button>
          </span>
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-[#0b1017]">
          {loading && <div className="px-4 py-3 text-xs text-faint">读取文件…</div>}
          {error && <div className="px-4 py-3 text-xs text-err">读取失败：{error}</div>}
          {/* 前端已经按后缀拦过一道，这里是后端 binary 判定的兜底 */}
          {data?.binary && (
            <div className="px-4 py-3 text-xs text-faint">
              二进制文件，不支持文本预览（{formatSize(data.size)}）。
            </div>
          )}
          {rendering && data && <MarkdownView content={data.content} />}
          {data && !data.binary && !rendering && (
            <pre
              className="relative m-0 min-w-max p-3 text-[12px]"
              style={{ lineHeight: `${LINE_HEIGHT}px` }}
            >
              {/* 命中行高亮层：靠固定行高算出上边距，比拆行重排稳定得多 */}
              {focusRow !== null && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-0 right-0 bg-accent/15"
                  style={{
                    top: PRE_PADDING + (focusRow - 1) * LINE_HEIGHT,
                    height: LINE_HEIGHT,
                  }}
                />
              )}
              <code
                className="hljs bg-transparent"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </pre>
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-3 border-t border-line bg-panel-2 px-3 py-1.5 text-[10.5px] text-faint">
          <span>{rendering ? 'Markdown 渲染 · 只读' : '只读预览 · 不保存、不编辑'}</span>
          {isMarkdown && tooBigToRender && <span className="text-warn">文件过大，只给源码</span>}
          {data?.truncated && <span className="text-warn">文件过大，只显示前 512 KB</span>}
          <span className="ml-auto">Esc 关闭</span>
        </footer>
      </section>
    </div>
  )
}
