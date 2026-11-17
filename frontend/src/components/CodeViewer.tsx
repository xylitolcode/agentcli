import { useEffect, useMemo, useState } from 'react'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import cpp from 'highlight.js/lib/languages/cpp'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import 'highlight.js/styles/github-dark.css'

import type { FileContent } from '../types'
import { FileIcon } from './icons'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('css', css)
hljs.registerLanguage('go', go)
hljs.registerLanguage('java', java)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('python', python)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('yaml', yaml)

const LANGUAGE_BY_EXT: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', pyi: 'python',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  json: 'json', jsonc: 'json',
  css: 'css', scss: 'css', less: 'css',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  md: 'markdown', mdx: 'markdown',
  yaml: 'yaml', yml: 'yaml',
  rs: 'rust',
  java: 'java',
  go: 'go',
  sql: 'sql',
  c: 'cpp', h: 'cpp', cc: 'cpp', cpp: 'cpp', hpp: 'cpp',
}

const HIGHLIGHT_LIMIT = 200_000
const AUTO_LIMIT = 80_000

function extOf(path: string): string {
  const name = path.split('/').pop() || ''
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function highlighted(content: string, path: string): string {
  if (content.length > HIGHLIGHT_LIMIT) return escapeHtml(content)
  const language = LANGUAGE_BY_EXT[extOf(path)]
  if (language && hljs.getLanguage(language)) {
    return hljs.highlight(content, { language }).value
  }
  if (content.length <= AUTO_LIMIT) return hljs.highlightAuto(content).value
  return escapeHtml(content)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

type Props = {
  path: string
  projectId: string
  onClose: () => void
  /** 把路径插进当前终端（保留原有“点文件送路径”的能力） */
  onInsert: (path: string) => void
}

/** 只读代码查看器：只展示，不提供保存/新建/删除。 */
export function CodeViewer({ path, projectId, onClose, onInsert }: Props) {
  const [data, setData] = useState<FileContent | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError('')
    setData(null)
    const params = new URLSearchParams({ path })
    if (projectId) params.set('project', projectId)
    fetch(`/api/file/?${params}`)
      .then(async (resp) => {
        const payload = (await resp.json()) as FileContent
        if (!live) return
        if (!resp.ok || !payload.ok) {
          setError(payload.error || `HTTP ${resp.status}`)
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

  const html = useMemo(
    () => (data && !data.binary ? highlighted(data.content, data.path) : ''),
    [data],
  )
  const meta = data
    ? `${data.lines} 行 · ${formatSize(data.size)}${data.truncated ? ' · 已截断' : ''}`
    : ''

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
          <span className="min-w-0 truncate text-xs text-fg" title={data?.path || path}>
            {data?.path || path}
          </span>
          {meta && <span className="shrink-0 text-[10.5px] text-faint">{meta}</span>}
          {data?.encoding && data.encoding !== 'utf-8' && (
            <span className="shrink-0 text-[10.5px] text-warn">{data.encoding}</span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <button
              onClick={() => onInsert(data?.path || path)}
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

        <div className="min-h-0 flex-1 overflow-auto bg-[#0b1017]">
          {loading && <div className="px-4 py-3 text-xs text-faint">读取文件…</div>}
          {error && <div className="px-4 py-3 text-xs text-err">读取失败：{error}</div>}
          {data?.binary && (
            <div className="px-4 py-3 text-xs text-faint">
              二进制文件，不预览（{formatSize(data.size)}）。
            </div>
          )}
          {data && !data.binary && (
            <pre className="m-0 min-w-max p-3 text-[12px] leading-[1.55]">
              <code
                className="hljs bg-transparent"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </pre>
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-3 border-t border-line bg-panel-2 px-3 py-1.5 text-[10.5px] text-faint">
          <span>只读预览 · 不保存、不编辑</span>
          {data?.truncated && <span className="text-warn">文件过大，只显示前 512 KB</span>}
          <span className="ml-auto">Esc 关闭</span>
        </footer>
      </section>
    </div>
  )
}
