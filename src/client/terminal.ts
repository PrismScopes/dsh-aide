import type { TerminalInfo } from '../terminal.ts'

export interface TerminalConnection {
  write(data: string): void
  resize(cols: number, rows: number): void
  close(): void
  subscribe(listener: (output: { sequence: number; data: string; replay?: boolean }) => void): () => void
}

export interface TerminalWorkspaceSnapshot { terminals: readonly TerminalInfo[]; loading: boolean; error?: string }

/** Browser client for the workbench's local terminal transport. */
export interface TerminalWorkspace {
  refresh(): Promise<void>
  create(title?: string): Promise<TerminalInfo>
  close(id: string): Promise<void>
  rename(id: string, title: string): Promise<void>
  connect(id: string): TerminalConnection
  getSnapshot(): TerminalWorkspaceSnapshot
  subscribe(listener: () => void): () => void
}

/**
 * 把宿主给的本机地址归一成可直接使用的 WebSocket 前缀。
 *
 * 有两件事必须在这里处理，都是实测出来的：
 *   1. 宿主可能只给「主机:端口」而不带协议 —— 补上 http://；
 *   2. **`localhost` 在本机可能解析到 `::1`，而 DSH 只监听 `127.0.0.1`。**
 *      实测 `ws://localhost:19387/…` 连不上、`ws://127.0.0.1:19387/…` 可以，
 *      所以这里统一把 localhost 换成 127.0.0.1。
 *
 * 解析不出来就返回 undefined，由调用方退回按 location 拼的老行为。
 */
function normalizeBase(base: string | undefined): string | undefined {
  if (base === undefined || base.trim() === '') return undefined
  const raw = base.trim()
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  try {
    const url = new URL(withScheme)
    if (url.hostname === '') return undefined
    const host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname
    const port = url.port === '' ? '' : `:${url.port}`
    return `${url.protocol === 'https:' ? 'wss' : 'ws'}://${host}${port}`
  } catch { return undefined }
}

/**
 * 拼出终端 WebSocket 的地址。
 *
 * 优先用宿主给的规范地址（`wsBase`）。原因是桌面端(Electron)的页面跑在 `dsh-app://app/` 下、
 * `location.host` 是 `app`，按它拼出来的 `ws://app/…` 连不上（实测 close code 1006）—— 桌面端
 * 把 HTTP 请求经自定义协议转发给宿主，但 **WebSocket 的 upgrade 不走那条转发**，所以桌面端
 * 必须用绝对地址。
 *
 * 拿不到（或解析不出）wsBase 时退回按 location 拼的方式，Web 端与旧宿主下仍然正确。
 */
export function webSocketUrl(sessionId: string, id: string, wsBase?: string): string {
  const query = `sessionId=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(id)}`
  const base = normalizeBase(wsBase)
  if (base !== undefined) return `${base}/dsh-vscode-terminal/ws?${query}`
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${location.host}/dsh-vscode-terminal/ws?${query}`
}

interface HostAnswer<T> { ok?: boolean; value?: T; wsBase?: string; error?: { message?: string } }

async function request<T>(method: string, body: Record<string, unknown>): Promise<{ value: T; wsBase?: string }> {
  const response = await fetch(`/dsh-vscode-terminal/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await response.text()
  let answer: HostAnswer<T>
  try { answer = JSON.parse(text) as HostAnswer<T> } catch { throw new Error(`terminal request returned invalid JSON (${response.status})`) }
  if (!response.ok || answer.ok !== true) throw new Error(answer.error?.message ?? 'terminal request failed')
  return { value: answer.value as T, wsBase: typeof answer.wsBase === 'string' ? answer.wsBase : undefined }
}

class SocketConnection implements TerminalConnection {
  private readonly socket: WebSocket
  private readonly listeners = new Set<(output: { sequence: number; data: string; replay?: boolean }) => void>()
  private queue: string[] = []

  constructor(sessionId: string, id: string, wsBase?: string) {
    this.socket = new WebSocket(webSocketUrl(sessionId, id, wsBase))
    this.socket.onopen = () => { for (const value of this.queue) this.socket.send(value); this.queue = [] }
    this.socket.onmessage = event => {
      try {
        const value = JSON.parse(String(event.data)) as { type?: unknown; sequence?: unknown; data?: unknown }
        if (typeof value.sequence !== 'number' || typeof value.data !== 'string') return
        for (const listener of this.listeners) listener({ sequence: value.sequence, data: value.data, replay: value.type === 'replay' })
      } catch { /* Ignore malformed WebSocket messages from a disconnected server. */ }
    }
  }

  private send(value: unknown): void { const text = JSON.stringify(value); if (this.socket.readyState === WebSocket.OPEN) this.socket.send(text); else this.queue.push(text) }
  write(data: string): void { this.send({ type: 'input', data }) }
  resize(cols: number, rows: number): void { this.send({ type: 'resize', cols, rows }) }
  close(): void { this.socket.close() }
  subscribe(listener: (output: { sequence: number; data: string; replay?: boolean }) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
}

/** Identify automatic terminal-emulator replies that must not be echoed during replay. */
export function isTerminalProtocolReply(data: string): boolean {
  return /^\x1b\](?:10|11|12);(?:rgb:[\da-f]{4}\/[\da-f]{4}\/[\da-f]{4}|#[\da-f]{6})(?:\x07|\x1b\\)$/i.test(data)
    || /^\x1b\[\??[\d;]*[cR]$/.test(data)
}

/** Maintain one terminal collection for a DSH session. */
export class TerminalWorkspaceController implements TerminalWorkspace {
  private snapshot: TerminalWorkspaceSnapshot = { terminals: [], loading: false }
  private readonly listeners = new Set<() => void>()

  constructor(private readonly sessionId: string) {}

  /** 宿主给的规范地址；每次 API 响应都会带回，用于拼 WebSocket 的绝对地址。 */
  private wsBase: string | undefined

  async refresh(): Promise<void> {
    this.set({ ...this.snapshot, loading: true, error: undefined })
    try {
      const answer = await request<TerminalInfo[]>('list', { sessionId: this.sessionId })
      this.wsBase = answer.wsBase ?? this.wsBase
      this.set({ terminals: answer.value, loading: false })
    } catch (error) { this.set({ ...this.snapshot, loading: false, error: error instanceof Error ? error.message : String(error) }) }
  }

  async create(title?: string): Promise<TerminalInfo> { const answer = await request<TerminalInfo>('create', { sessionId: this.sessionId, ...(title === undefined ? {} : { title }) }); this.wsBase = answer.wsBase ?? this.wsBase; await this.refresh(); return answer.value }
  async close(id: string): Promise<void> { await request('close', { sessionId: this.sessionId, id }); await this.refresh() }
  async rename(id: string, title: string): Promise<void> { await request('rename', { sessionId: this.sessionId, id, title }); await this.refresh() }
  connect(id: string): TerminalConnection { return new SocketConnection(this.sessionId, id, this.wsBase) }
  getSnapshot(): TerminalWorkspaceSnapshot { return this.snapshot }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private set(snapshot: TerminalWorkspaceSnapshot): void { this.snapshot = snapshot; for (const listener of this.listeners) listener() }
}
