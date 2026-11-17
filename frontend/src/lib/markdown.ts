import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import { Marked } from 'marked'

/** Markdown -> 安全 HTML。渲染器是局部的，不动全局 marked 配置。 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const md = new Marked({ gfm: true, breaks: false, pedantic: false })

md.use({
  renderer: {
    // 代码块：语言已注册就交给 highlight.js（复用 CodeViewer 注册的那 22 个），否则原样转义
    code({ text, lang }) {
      const tag = (lang || '').trim().split(/\s+/)[0].toLowerCase()
      const language = tag && hljs.getLanguage(tag) ? tag : ''
      let body: string
      try {
        body = language
          ? hljs.highlight(text, { language, ignoreIllegals: true }).value
          : escapeHtml(text)
      } catch {
        body = escapeHtml(text)
      }
      const cls = language ? `hljs language-${language}` : 'hljs'
      return `<pre class="md-pre"><code class="${cls}">${body}</code></pre>`
    },

    // 相对路径的图片指向项目内文件，前端渲染没有静态服务去取它——直接标出来，别摆一个破图标
    image({ href, text }) {
      const src = (href || '').trim()
      const alt = text || ''
      if (/^(?:https?:|data:image\/)/i.test(src)) {
        return `<img class="md-img" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" />`
      }
      const label = alt ? `${escapeHtml(src)} · ${escapeHtml(alt)}` : escapeHtml(src)
      return `<span class="md-img-missing">[图片未加载] ${label}</span>`
    },
  },
})

// 外链一律新标签打开，别把只读预览页导航走
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  const el = node as Element
  if (el.tagName === 'A') {
    el.setAttribute('target', '_blank')
    el.setAttribute('rel', 'noopener noreferrer')
  }
})

const SANITIZE = {
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'textarea', 'select', 'button', 'link', 'meta', 'base'],
  FORBID_ATTR: ['style'],
}

export function renderMarkdown(content: string): string {
  try {
    const html = md.parse(content, { async: false }) as string
    // 本地文件也可能被 agent 写进 <img onerror>，转 HTML 之后必须过一遍白名单
    return DOMPurify.sanitize(html, SANITIZE)
  } catch {
    return `<pre class="md-pre"><code class="hljs">${escapeHtml(content)}</code></pre>`
  }
}
