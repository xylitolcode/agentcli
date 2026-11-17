/** 搜索结果的纯逻辑：把后端响应摊平成可键盘导航的行，并把命中区间切成可上色的段。
 *
 * 单独抽一路的理由很实际 —— 这两件事最好用断言盯住（区间越界、重叠命中、
 * 空结果、文件名模式），但它们又不需要 React。放在组件里就只能靠肉眼点。
 */

import type { SearchResult } from '../types'

export type SearchRow =
  | { kind: 'group'; path: string; count: number }
  | {
      kind: 'hit'
      path: string
      line: number
      col: number
      text: string
      spans: [number, number][]
    }
  | { kind: 'file'; path: string; name: string }

export type SpanSegment = { text: string; hit: boolean }

/** 后端响应 -> 扁平行。分组头也占一行，因为渲染时要靠它当文件分隔条。 */
export function buildRows(result: SearchResult | null): SearchRow[] {
  if (!result) return []
  if (result.mode === 'file') {
    return (result.files ?? []).map((file) => ({
      kind: 'file' as const,
      path: file.path,
      name: file.name,
    }))
  }
  const rows: SearchRow[] = []
  for (const group of result.groups ?? []) {
    rows.push({ kind: 'group', path: group.path, count: group.count })
    for (const hit of group.hits) {
      rows.push({
        kind: 'hit',
        path: hit.path,
        line: hit.line,
        col: hit.col,
        text: hit.text,
        spans: hit.spans,
      })
    }
  }
  return rows
}

/** 能按 Enter 打开的行下标；分组头不可选，键盘导航要跳过它。 */
export function selectableRows(rows: SearchRow[]): number[] {
  const out: number[] = []
  rows.forEach((row, index) => {
    if (row.kind !== 'group') out.push(index)
  })
  return out
}

/**
 * 命中区间 -> 文本段。
 *
 * 后端给的 start/end 可能因为文本被截断而越界，也可能多个 submatch 挨在一起；
 * 这里统一 clamp 并合并重叠，保证输出段严格首尾相接、拼回去等于原文。
 */
export function spanSegments(text: string, spans: [number, number][]): SpanSegment[] {
  if (!text) return []
  if (!spans || spans.length === 0) return [{ text, hit: false }]

  const clamped = spans
    .map(([start, end]) => {
      const from = Math.max(0, Math.min(start, text.length))
      const to = Math.max(0, Math.min(end, text.length))
      return [from, to] as [number, number]
    })
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0])

  if (clamped.length === 0) return [{ text, hit: false }]

  const merged: Array<[number, number]> = []
  for (const [start, end] of clamped) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }

  const segments: SpanSegment[] = []
  let cursor = 0
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), hit: false })
    segments.push({ text: text.slice(start, end), hit: true })
    cursor = end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false })
  return segments
}

/** 结果行的目录部分，用来在文件名模式右侧做弱化提示 */
export function dirOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index > 0 ? path.slice(0, index) : ''
}
