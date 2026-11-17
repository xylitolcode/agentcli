/** /api/ 响应的统一 JSON 守卫。
 *
 * 为什么不用裸 `resp.json()`：后端出错时 Django 回的是 HTML 错误页，
 * 直接解析会抛 `SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`。
 * 这句话既不告诉用户发生了什么，也不告诉排查者该看哪里 —— 先在这里翻译成人话。
 */

export type ApiResult<T> = {
  /** 传输层是否成功（HTTP 2xx 且响应是合法 JSON） */
  ok: boolean
  status: number
  data?: T
  error?: string
}

function pageTitle(html: string): string {
  return html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() ?? ''
}

/** 把 HTML 错误页 / 状态码翻译成一句能直接照着办的话 */
export function describeFailure(status: number, body: string): string {
  const title = pageTitle(body)
  const suffix = title ? `：${title}` : ''
  if (status === 404) {
    // 最常见的坑：改了 urls.py / views.py 但 uvicorn 没重启，
    // 进程内存里还是旧 URLconf，于是前端打到一个"不存在"的地址。
    return `接口不存在（404${suffix}）。后端改过路由或视图却没重启时，Django 仍在用旧的 URLconf —— 重启服务即可`
  }
  if (status === 403) return `后端拒绝访问（403${suffix}）：路径越界或权限不足`
  if (status >= 500) return `后端异常（HTTP ${status}${suffix}），请查 uvicorn 日志里的 traceback`
  return `HTTP ${status}${suffix}`
}

/** fetch + 解析 JSON，任何"不是 JSON"的情况都收敛成可读的 error 文本，绝不抛 SyntaxError */
export async function fetchJson<T>(url: string): Promise<ApiResult<T>> {
  let resp: Response
  try {
    resp = await fetch(url, { headers: { Accept: 'application/json' } })
  } catch (exc) {
    return { ok: false, status: 0, error: `请求发不出去：${(exc as Error).message}` }
  }

  const body = await resp.text().catch(() => '')
  const type = resp.headers.get('content-type') ?? ''

  if (!type.includes('json')) {
    return { ok: false, status: resp.status, error: describeFailure(resp.status, body) }
  }

  let data: T
  try {
    data = JSON.parse(body) as T
  } catch {
    return { ok: false, status: resp.status, error: `接口返回的不是合法 JSON（HTTP ${resp.status}）` }
  }

  if (!resp.ok) {
    const detail = (data as { error?: string } | null)?.error
    return { ok: false, status: resp.status, data, error: detail || describeFailure(resp.status, '') }
  }

  return { ok: true, status: resp.status, data }
}
