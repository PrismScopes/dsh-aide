/**
 * 最小可用的 LSP JSON-RPC 客户端。
 *
 * 职责边界：
 *   - 管 JSON-RPC 的 id/超时/取消/服务端主动请求，以及 initialize 握手；
 *   - 把 `textDocument/publishDiagnostics` 的 file URI 转成绝对路径、转成公共协议的诊断类型；
 *   - 不问「哪个文档该开」，也不做能力到 provider 方法的映射 —— 那是 external.ts。
 *
 * 未知/错误一律记日志不抛：语言服务器是外部进程，协议噪声不能把宿主带崩；只有真正等结果的
 * `request()` 会 reject，由调用方决定降级（external.ts 选择返回空结果）。
 */
import { basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { LanguageDiagnostic, LanguageDocument, LanguagePosition, LanguageRange, LanguageRelatedInformation, LanguageSeverity } from '../protocol.ts'
import type { LspTransport } from './transport.ts'

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000
const SHUTDOWN_TIMEOUT_MS = 2_000

/** LSP 里服务端可能回 string 或 number 的 id；本客户端只用数字。 */
type RequestId = number

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  signal: AbortSignal | undefined
  onAbort: () => void
}

export interface LspClientOptions {
  transport: LspTransport
  /** 工作区绝对路径（initialize 的 rootUri / workspaceFolders）。 */
  workspace: string
  /** 诊断推送；path 已转成绝对路径。 */
  onDiagnostics?: (path: string, diagnostics: readonly LanguageDiagnostic[]) => void
  /** 运行日志（window/showMessage、协议错误等）。 */
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
  /** 单次请求超时；默认 20s。 */
  requestTimeoutMs?: number
  /** clientInfo.name 用的名字。 */
  clientName?: string
}

/** 文件系统路径 → file URI。 */
export function pathToUri(path: string): string { return pathToFileURL(path).href }

/** file URI → 文件系统路径；非 file URI（untitled: 等）返回 undefined。 */
export function uriToPath(uri: string): string | undefined {
  try { return fileURLToPath(uri) } catch { return undefined }
}

/**
 * 客户端声明的能力。
 *
 * snippetSupport 明确为 false：Monaco 这边没有实现 snippet 占位符跳转，声明 true 只会让服务器
 * 发来 `$1` 这类文本插进编辑器；其余能力与 external.ts 实际实现的 provider 方法一一对应。
 */
const CLIENT_CAPABILITIES = {
  workspace: { configuration: true, workspaceFolders: true },
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
    publishDiagnostics: { relatedInformation: true, versionSupport: true, tagSupport: { valueSet: [1, 2] } },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    definition: { linkSupport: true },
    references: {},
    rename: { prepareSupport: false },
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    workspaceSymbol: {},
    completion: { completionItem: { snippetSupport: false, documentationFormat: ['markdown', 'plaintext'] } },
    signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'] } },
    codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports', 'source.fixAll'] } } },
  },
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

function wirePosition(value: unknown): LanguagePosition {
  const record = isRecord(value) ? value : {}
  return { line: numberValue(record.line), character: numberValue(record.character) }
}

function wireRange(value: unknown): LanguageRange {
  const record = isRecord(value) ? value : {}
  return { start: wirePosition(record.start), end: wirePosition(record.end) }
}

/** LSP DiagnosticSeverity 数字 → 公共协议字符串；缺省按 warning（服务器没给级别时不要假装是错误）。 */
function severityOf(value: unknown): LanguageSeverity {
  switch (value) {
    case 1: return 'error'
    case 2: return 'warning'
    case 3: return 'info'
    case 4: return 'hint'
    default: return 'warning'
  }
}

function tagsOf(value: unknown): readonly ('unnecessary' | 'deprecated')[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tags: Array<'unnecessary' | 'deprecated'> = []
  for (const item of value) {
    if (item === 1 && !tags.includes('unnecessary')) tags.push('unnecessary')
    else if (item === 2 && !tags.includes('deprecated')) tags.push('deprecated')
  }
  return tags.length === 0 ? undefined : tags
}

function relatedOf(value: unknown): readonly LanguageRelatedInformation[] | undefined {
  if (!Array.isArray(value)) return undefined
  const related: LanguageRelatedInformation[] = []
  for (const item of value) {
    if (!isRecord(item) || !isRecord(item.location) || typeof item.location.uri !== 'string') continue
    const path = uriToPath(item.location.uri)
    if (path === undefined) continue
    related.push({
      path,
      range: wireRange(item.location.range),
      message: typeof item.message === 'string' ? item.message : '',
    })
  }
  return related.length === 0 ? undefined : related
}

function diagnosticOf(value: unknown): LanguageDiagnostic | undefined {
  if (!isRecord(value) || !isRecord(value.range)) return undefined
  const diagnostic: LanguageDiagnostic = {
    range: wireRange(value.range),
    severity: severityOf(value.severity),
    message: typeof value.message === 'string' ? value.message : '',
  }
  // code 在 LSP 里既可能是数字（TS 的错误码）也可能是字符串（pyright 的规则名），统一成字符串。
  if (typeof value.code === 'number') diagnostic.code = String(value.code)
  else if (typeof value.code === 'string') diagnostic.code = value.code
  if (typeof value.source === 'string') diagnostic.source = value.source
  const tags = tagsOf(value.tags)
  if (tags !== undefined) diagnostic.tags = tags
  const related = relatedOf(value.relatedInformation)
  if (related !== undefined) diagnostic.related = related
  return diagnostic
}

export class LspClient {
  private readonly options: LspClientOptions
  private nextId: RequestId = 1
  private readonly pending = new Map<RequestId, PendingRequest>()
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>()
  private readonly requestHandlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>()
  private readonly subscriptions: Array<() => void> = []
  private startPromise: Promise<void> | undefined
  private stopPromise: Promise<void> | undefined
  private serverCapabilitiesValue: Record<string, unknown> = {}
  private started = false
  private closed = false
  private stopped = false

  constructor(options: LspClientOptions) {
    this.options = options
    this.subscriptions.push(options.transport.onMessage(message => this.dispatch(message)))
    this.subscriptions.push(options.transport.onClose(error => this.handleClose(error)))
    // 服务端 → 客户端的标准请求：不支持就回 null/[]，不能让服务器一直等（会把它的后续输出堵住）。
    this.requestHandlers.set('workspace/configuration', () => [])
    this.requestHandlers.set('client/registerCapability', () => null)
    this.requestHandlers.set('window/workDoneProgress/create', () => null)
    this.onNotification('window/showMessage', params => {
      if (!isRecord(params) || typeof params.message !== 'string') return
      const level = params.type === 1 ? 'error' : params.type === 2 ? 'warn' : 'info'
      this.log(level, params.message)
    })
    this.onNotification('window/logMessage', params => {
      if (isRecord(params) && typeof params.message === 'string') this.log(params.type === 1 ? 'error' : 'info', params.message)
    })
    this.onNotification('textDocument/publishDiagnostics', params => this.handleDiagnostics(params))
  }

  /** 服务器在 initialize 响应里声明的能力（未初始化时为空对象）。 */
  get capabilities(): Readonly<Record<string, unknown>> { return this.serverCapabilitiesValue }

  get isClosed(): boolean { return this.closed }

  /**
   * 发 initialize 并等响应，然后发 initialized。
   *
   * 幂等：重复调用共享同一次握手（external.ts 的懒启动可能被并发的 open/change 同时触发）。
   * 超时/错误会 reject，但不会自动重试 —— 重试 spawn 外部进程的代价与副作用都太大，交给上层决定。
   */
  start(options: { initializationOptions?: unknown } = {}): Promise<void> {
    if (this.startPromise === undefined) this.startPromise = this.initialize(options)
    return this.startPromise
  }

  private async initialize(options: { initializationOptions?: unknown }): Promise<void> {
    const workspace = this.options.workspace
    const rootUri = pathToFileURL(workspace).href
    const result = await this.request<unknown>('initialize', {
      processId: process.pid,
      clientInfo: { name: this.options.clientName ?? 'dsh-aide' },
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: basename(workspace) }],
      capabilities: CLIENT_CAPABILITIES,
      ...(options.initializationOptions === undefined ? {} : { initializationOptions: options.initializationOptions }),
      trace: 'off',
    })
    if (isRecord(result) && isRecord(result.capabilities)) this.serverCapabilitiesValue = result.capabilities
    this.notify('initialized', {})
    this.started = true
  }

  /**
   * 发一个请求并等响应。
   *
   * `signal` 触发时发 `$/cancelRequest`（让服务器别再算）并立刻 reject；超时同理。两者都只
   * reject 本地 Promise，不关闭连接。
   */
  request<T = unknown>(method: string, params?: unknown, signal?: AbortSignal, timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.stopped || this.closed) return Promise.reject(new Error('LSP connection is not available'))
    if (signal?.aborted === true) return Promise.reject(new Error(`LSP request cancelled: ${method}`))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(id)
        reject(new Error(`LSP request timed out after ${timeoutMs}ms: ${method}`))
      }, timeoutMs)
      ;(timer as { unref?: () => void }).unref?.()
      const onAbort = (): void => {
        if (!this.pending.has(id)) return
        this.settle(id)
        // 取消通知本身是 best-effort：连接已断时 send 会自己丢弃。
        this.notify('$/cancelRequest', { id })
        reject(new Error(`LSP request cancelled: ${method}`))
      }
      this.pending.set(id, { method, resolve: value => resolve(value as T), reject, timer, signal, onAbort })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.sendMessage({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** 发一条通知（无响应）。 */
  notify(method: string, params?: unknown): void {
    if (this.stopped || this.closed) return
    this.sendMessage({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  /** 注册服务端通知处理器；返回取消注册函数。 */
  onNotification(method: string, handler: (params: unknown) => void): () => void {
    const handlers = this.notificationHandlers.get(method) ?? new Set<(params: unknown) => void>()
    handlers.add(handler)
    this.notificationHandlers.set(method, handlers)
    return () => { handlers.delete(handler) }
  }

  /** 注册服务端请求处理器；返回取消注册函数。 */
  onRequest(method: string, handler: (params: unknown) => unknown | Promise<unknown>): () => void {
    this.requestHandlers.set(method, handler)
    return () => { if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method) }
  }

  didOpen(document: LanguageDocument): void {
    this.notify('textDocument/didOpen', {
      textDocument: { uri: pathToUri(document.path), languageId: document.languageId, version: document.version, text: document.content },
    })
  }

  /** 全量同步：只发整篇正文（CLIENT_CAPABILITIES 里没有声明增量同步）。 */
  didChange(document: LanguageDocument): void {
    this.notify('textDocument/didChange', {
      textDocument: { uri: pathToUri(document.path), version: document.version },
      contentChanges: [{ text: document.content }],
    })
  }

  didClose(path: string): void {
    this.notify('textDocument/didClose', { textDocument: { uri: pathToUri(path) } })
  }

  /**
   * 优雅退出：shutdown 请求（最多 2s）→ exit 通知 → 关传输层。
   *
   * 即使 shutdown 卡住/失败也继续发 exit 并关连接 —— 不能让一个不听话的服务器拖住宿主退出。
   */
  stop(): Promise<void> {
    if (this.stopPromise === undefined) this.stopPromise = this.shutdown()
    return this.stopPromise
  }

  private async shutdown(): Promise<void> {
    try {
      if (this.started && !this.closed) {
        await this.request('shutdown', undefined, undefined, SHUTDOWN_TIMEOUT_MS).catch(() => undefined)
        this.sendMessage({ jsonrpc: '2.0', method: 'exit' })
      }
    } finally {
      this.stopped = true
      this.rejectPending(new Error('LSP client stopped'))
      for (const dispose of this.subscriptions.splice(0)) dispose()
      this.options.transport.close()
    }
  }

  private dispatch(message: unknown): void {
    if (!isRecord(message)) { this.log('warn', 'language server sent a non-object message'); return }
    // 有 method 即请求/通知；id 存在（可能是 0）且非 null 的就是需要应答的请求。
    if (typeof message.method === 'string') {
      if (typeof message.id === 'number' || typeof message.id === 'string') void this.handleServerRequest(message.id, message.method, message.params)
      else this.handleServerNotification(message.method, message.params)
      return
    }
    if (message.id === undefined || message.id === null) return
    this.handleResponse(message)
  }

  private handleResponse(message: Record<string, unknown>): void {
    if (typeof message.id !== 'number') { this.log('warn', `language server sent a response with unexpected id: ${String(message.id)}`); return }
    const entry = this.settle(message.id)
    if (entry === undefined) { this.log('warn', `language server sent a response for unknown request ${message.id}`); return }
    if (isRecord(message.error)) {
      const code = typeof message.error.code === 'number' ? ` (${message.error.code})` : ''
      const text = typeof message.error.message === 'string' ? message.error.message : 'unknown error'
      entry.reject(new Error(`LSP ${entry.method} failed${code}: ${text}`))
      return
    }
    entry.resolve(message.result)
  }

  private async handleServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    const handler = this.requestHandlers.get(method)
    if (handler === undefined) {
      this.log('warn', `unsupported language server request: ${method}`)
      this.sendMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not supported: ${method}` } })
      return
    }
    try {
      const result = await handler(params)
      if (this.closed) return
      this.sendMessage({ jsonrpc: '2.0', id, result: result ?? null })
    } catch (error) {
      if (this.closed) return
      this.sendMessage({ jsonrpc: '2.0', id, error: { code: -32603, message: messageOf(error) } })
    }
  }

  private handleServerNotification(method: string, params: unknown): void {
    const handlers = this.notificationHandlers.get(method)
    if (handlers === undefined) return
    for (const handler of [...handlers]) {
      try { handler(params) } catch (error) { this.log('warn', `language server notification ${method} failed: ${messageOf(error)}`) }
    }
  }

  private handleDiagnostics(params: unknown): void {
    if (!isRecord(params) || typeof params.uri !== 'string' || !Array.isArray(params.diagnostics)) {
      this.log('warn', 'language server sent malformed publishDiagnostics')
      return
    }
    const path = uriToPath(params.uri)
    if (path === undefined) return // untitled: / git: 这类 URI 没有对应的磁盘路径，工作台不展示
    const diagnostics = params.diagnostics.map(diagnosticOf).filter((value): value is LanguageDiagnostic => value !== undefined)
    this.options.onDiagnostics?.(path, diagnostics)
  }

  private handleClose(error?: Error): void {
    if (this.closed) return
    this.closed = true
    this.rejectPending(error ?? new Error('LSP connection closed'))
    if (error !== undefined) this.log('warn', `language server connection closed: ${error.message}`)
  }

  private rejectPending(error: Error): void {
    const ids = [...this.pending.keys()]
    for (const id of ids) this.settle(id)?.reject(error)
  }

  private settle(id: RequestId): PendingRequest | undefined {
    const entry = this.pending.get(id)
    if (entry === undefined) return undefined
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.signal?.removeEventListener('abort', entry.onAbort)
    return entry
  }

  private sendMessage(message: unknown): void {
    try { this.options.transport.send(message) }
    catch (error) { this.log('warn', `failed to send LSP message: ${messageOf(error)}`) }
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    try { this.options.onLog?.(level, message) } catch { /* 日志回调不该影响协议处理 */ }
  }
}
