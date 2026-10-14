export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

/**
 * 宿主记录下来的本机地址，随每次 API 响应更新。
 *
 * 为什么需要：桌面端(Electron)的页面跑在 `dsh-app://app/` 下，`location.host` 是 `app`，
 * 按它拼出来的 `ws://app/…` 连不上（实测 close code 1006）—— 桌面端把 HTTP 请求经自定义协议
 * 转发给宿主，但 **WebSocket 的 upgrade 不经过那条转发**。所以 WebSocket 必须用宿主给的绝对地址，
 * 而宿主在 API 响应里带了一个（见 host 侧 localBase：用 req.socket.localPort 得出）。
 */
let hostBase: string | undefined

/** 宿主本机地址（形如 http://127.0.0.1:19387）；还没拿到任何 API 响应时为 undefined。 */
export function currentHostBase(): string | undefined { return hostBase }

/** 把宿主给的本机地址归一成可直接使用的 ws/wss 前缀；解析不出返回 undefined。 */
export function normalizeHostBase(base: string | undefined): string | undefined {
  if (base === undefined || base.trim() === '') return undefined
  const withScheme = /^https?:\/\//i.test(base.trim()) ? base.trim() : `http://${base.trim()}`
  try {
    const url = new URL(withScheme)
    if (url.hostname === '') return undefined
    // localhost 在本机可能解析到 ::1，而 DSH 只监听 127.0.0.1（实测 ws://localhost:… 连不上）。
    const host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname
    return `${url.protocol === 'https:' ? 'wss' : 'ws'}://${host}${url.port === '' ? '' : `:${url.port}`}`
  } catch { return undefined }
}

/**
 * 拼一个指向宿主的 WebSocket 地址。
 *
 * 拿到宿主地址就用绝对地址；拿不到时退回按 location 拼 —— 那在 Web 端与旧宿主下仍然正确，
 * 只在桌面端会失败，所以调用方应当避免在拿到地址之前连接。
 */
export function hostWebSocketUrl(path: string, query: Record<string, string> = {}): string {
  const base = normalizeHostBase(hostBase)
  const search = new URLSearchParams(query).toString()
  const suffix = search === '' ? '' : `?${search}`
  if (base !== undefined) return `${base}${path}${suffix}`
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${location.host}${path}${suffix}`
}

/**
 * 启动期的会话竞态：宿主还没登记会话时工作台就可能发请求，此时宿主返回 session-unknown。
 * 这是瞬时状态，等一会儿即可 —— 自动重试，不把错误暴露给用户。
 */
const SESSION_RETRY_MS = 400
const SESSION_RETRY_LIMIT = 12

/** 宿主明确表示「会话还没就绪」——这是启动期的瞬时状态，可重试。 */
export function sessionPending(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'session-unknown'
}

/**
 * 按同一策略重试：只重试「会话未就绪」，次数与间隔有上限，取消后立即停止。
 * 终端的请求函数也走这里 —— 它此前只保留错误消息、丢掉错误码，于是这条竞态会直接显示给用户。
 */
export async function withSessionRetry<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (!sessionPending(error) || attempt >= SESSION_RETRY_LIMIT || signal?.aborted === true) throw error
      await new Promise(resolve => setTimeout(resolve, SESSION_RETRY_MS))
    }
  }
}

export async function api<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  return withSessionRetry(() => callOnce<T>(method, body, signal), signal)
}

async function callOnce<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/dsh-vscode/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  })
  const answer = await response.json() as { ok: boolean; value?: T; wsBase?: string; error?: { code?: string; message?: string } }
  if (!response.ok || !answer.ok) throw new ApiError(answer.error?.code ?? 'request-failed', answer.error?.message ?? `request failed (${response.status})`)
  if (typeof answer.wsBase === 'string') hostBase = answer.wsBase
  return answer.value as T
}
