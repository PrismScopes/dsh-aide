import type { TerminalInfo, TerminalProfile } from '../terminal.ts'
import { ApiError, currentHostBase, normalizeHostBase, withSessionRetry } from './api.ts'

export interface TerminalConnection {
  write(data: string): void
  resize(cols: number, rows: number): void
  close(): void
  subscribe(listener: (output: { sequence: number; data: string; replay?: boolean }) => void): () => void
}

export interface TerminalWorkspaceSnapshot { terminals: readonly TerminalInfo[]; loading: boolean; error?: string }

/** 一次「新建终端」的请求：可带工作区相对目录（在终端中打开）与 shell 档位。 */
export interface TerminalRequest { directory?: string; profile?: string; title?: string }

/**
 * 待处理的新建请求。
 *
 * 为什么需要排队：菜单里点「在终端中打开」时底部面板可能还没挂载（React 的状态更新是异步的），
 * 同步派发的事件会落在空处，表现为「点了没反应」。队列让「请求」与「谁来执行」解耦：
 * 面板挂载后先 drain 一次，之后的请求由事件唤醒。
 */
const pendingTerminalRequests: TerminalRequest[] = []

/**
 * 请求新建一个终端；面板不在时先排队，挂载后自动补建。
 *
 * 同时派发两个事件：
 *   - `dvw-terminal-show`：让工作台把底部面板切到终端（这一层由 Workbench 负责，它持有 overlay 状态）；
 *   - `dvw-terminal-new`：通知已挂载的终端面板去取队列。
 * 分开是因为「把面板打开」与「建终端」在被调用方眼里是两件事：面板没挂载时，后一个事件没人听。
 */
export function requestTerminal(request: TerminalRequest = {}): void {
  pendingTerminalRequests.push(request)
  window.dispatchEvent(new Event('dvw-terminal-show'))
  window.dispatchEvent(new Event('dvw-terminal-new'))
}

/** 取走当前排队的请求（由终端面板在挂载后与每次事件时调用）。 */
export function takeTerminalRequests(): TerminalRequest[] { return pendingTerminalRequests.splice(0) }

/** Browser client for the workbench's local terminal transport. */
export interface TerminalWorkspace {
  refresh(): Promise<void>
  /** `directory` 是工作区相对路径：新的 shell 直接在该目录里启动（「在终端中打开」）。 */
  create(options?: { title?: string; profile?: string; directory?: string }): Promise<TerminalInfo>
  close(id: string): Promise<void>
  rename(id: string, title: string): Promise<void>
  connect(id: string): TerminalConnection
  getSnapshot(): TerminalWorkspaceSnapshot
  subscribe(listener: () => void): () => void
}

/**
 * 拼出终端 WebSocket 的地址（地址来源与回退规则见 api.ts 的 hostWebSocketUrl）。
 *
 * 保留 `wsBase` 入参：终端 API 自己也会带回一次地址，优先用它，免得依赖"之前有没有别的
 * API 调用过"。两条来源最终都进同一个归一化逻辑。
 */
export function webSocketUrl(sessionId: string, id: string, wsBase?: string): string {
  const base = normalizeHostBase(wsBase) ?? normalizeHostBase(currentHostBase())
  const search = `sessionId=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(id)}`
  if (base !== undefined) return `${base}/dsh-vscode-terminal/ws?${search}`
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${location.host}/dsh-vscode-terminal/ws?${search}`
}

interface HostAnswer<T> { ok?: boolean; value?: T; wsBase?: string; error?: { code?: string; message?: string } }

/**
 * 终端请求。会话刚创建时宿主可能还没登记（启动期竞态），与文件树同一策略重试；
 * 因此这里必须保留错误码，否则那条竞态会被当成普通错误直接显示给用户。
 */
async function request<T>(method: string, body: Record<string, unknown>): Promise<{ value: T; wsBase?: string }> {
  return withSessionRetry(async () => {
    const response = await fetch(`/dsh-vscode-terminal/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const text = await response.text()
    let answer: HostAnswer<T>
    try { answer = JSON.parse(text) as HostAnswer<T> } catch { throw new Error(`terminal request returned invalid JSON (${response.status})`) }
    if (!response.ok || answer.ok !== true) throw new ApiError(answer.error?.code ?? 'request-failed', answer.error?.message ?? 'terminal request failed')
    return { value: answer.value as T, wsBase: typeof answer.wsBase === 'string' ? answer.wsBase : undefined }
  })
}

/**
 * 取宿主探测到的可选 shell 列表。
 *
 * 独立于控制器导出，因为「新建终端」菜单在面板头部，那里没有控制器的实例；
 * 而这份列表只取决于机器上装了什么，与当前终端集合无关。
 */
export async function terminalProfiles(sessionId: string): Promise<TerminalProfile[]> {
  const answer = await request<TerminalProfile[]>('profiles', { sessionId })
  return answer.value
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

  async create(options: { title?: string; profile?: string; directory?: string } = {}): Promise<TerminalInfo> { const answer = await request<TerminalInfo>('create', { sessionId: this.sessionId, ...(options.title === undefined ? {} : { title: options.title }), ...(options.profile === undefined ? {} : { profile: options.profile }), ...(options.directory === undefined || options.directory === '' ? {} : { directory: options.directory }) }); this.wsBase = answer.wsBase ?? this.wsBase; await this.refresh(); return answer.value }
  async close(id: string): Promise<void> { await request('close', { sessionId: this.sessionId, id }); await this.refresh() }
  async rename(id: string, title: string): Promise<void> { await request('rename', { sessionId: this.sessionId, id, title }); await this.refresh() }
  connect(id: string): TerminalConnection { return new SocketConnection(this.sessionId, id, this.wsBase) }
  getSnapshot(): TerminalWorkspaceSnapshot { return this.snapshot }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private set(snapshot: TerminalWorkspaceSnapshot): void { this.snapshot = snapshot; for (const listener of this.listeners) listener() }
}
