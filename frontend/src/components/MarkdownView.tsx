import { useCallback, useMemo } from 'react'
import type { MouseEvent } from 'react'

import { renderMarkdown } from '../lib/markdown'

type Props = {
  content: string
}

/** Markdown 渲染态：marked 出 HTML -> DOMPurify 洗一遍 -> 挂到容器。
 *  这里只负责「显示」，切换按钮在 CodeViewer 的 header 上。 */
export function MarkdownView({ content }: Props) {
  const html = useMemo(() => renderMarkdown(content), [content])

  // 链接默认是要导航的，但预览层一导航就把查看器连根拔了：统一拦下，外链另开标签
  const handleClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest('a')
    if (!anchor) return
    event.preventDefault()
    const href = anchor.getAttribute('href') || ''
    if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener,noreferrer')
  }, [])

  return (
    <div
      className="md-body"
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
