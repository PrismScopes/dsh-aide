/**
 * 一个工作区的语言服务客户端。
 *
 * 请求走 HTTP（/dsh-vscode/api/language.*），诊断与服务器状态走专用 WebSocket 推送。
 * 文档同步（didOpen/didChange/didClose）由编辑器直接调用；输入过程中按固定节奏合并，
 * 避免每个按键都发一次请求 —— 语言服务要的是「停手之后的正文」，不是每次击键的中间态。
 *
 * 与宿主的分工：客户端负责「哪些文件开着、当前正文是什么、版本号多少」；宿主负责项目程序、
 * 服务器进程与诊断计算。任何一侧都不缓存另一侧的职责。
 */
import { api, currentHostBase, hostWebSocketUrl } from '../api.ts'
import type {
  LanguageCodeAction,
  LanguageCompletionList,
  LanguageDiagnostic,
  LanguageDocumentSymbol,
  LanguageHover,
  LanguageInfo,
  LanguageLocation,
  LanguagePosition,
  LanguagePushMessage,
  LanguageRange,
  LanguageRenameResult,
  LanguageScanState,
  LanguageServerInfo,
  LanguageServerState,
  LanguageSignatureHelp,
  LanguageSymbolInformation,
  LanguageWorkspaceEdit,
} from '../../language/protocol.ts'
import { diagnosticsStoreFor, type DiagnosticsStore } from './diagnostics.ts'
import { modelForPath, monacoRange } from './models.ts'
import { pathKey } from './paths.ts'
import { appendOutput } from '../output.ts'

/** 输入合并窗口：停止输入这么久之后再把正文推给宿主。 */
export const SYNC_DEBOUNCE_MS = 260
/**
 * 单篇文档同步上限（字符数）。
 *
 * 宿主请求体上限 2 MiB，而 `JSON.stringify` 不转义 CJK —— 一个汉字按 UTF-8 是 3 字节，
 * 取 60 万字符可保证最坏情况（全中文）也在 2 MiB 以内，不会让大文件在同步时撞 413。
 * 超过上限的文件不参与语言服务（语法高亮与编辑不受影响）。
 */
const MAX_SYNC_CHARS = 600_000
/** WebSocket 断线重连间隔。 */
const RECONNECT_MS = 2000

/** 服务器状态的中文说明，写进「输出」面板的摘要行。 */
const SERVER_STATE_TEXT: Record<LanguageServerState, string> = {
  builtin: '内置', idle: '待启动', starting: '启动中', running: '运行中',
  failed: '失败', missing: '未安装', disabled: '已关闭',
}

/** 把当前语言能力汇总成一行，写给「输出」面板；只在内容变化时输出，重连不会刷屏。 */
function describeLanguage(info: LanguageInfo): string {
  const version = info.builtin.version === undefined || info.builtin.version === '' ? '' : ` ${info.builtin.version}`
  const builtin = info.builtin.enabled
    ? `内置 TypeScript${version}（${info.builtin.state === 'ready' ? '已就绪' : info.builtin.state === 'loading' ? '加载中' : '失败'}）`
    : '内置 TypeScript 已关闭'
  const servers = info.servers.length === 0
    ? '未发现外部语言服务器'
    : `外部服务器：${info.servers.map(server => `${server.name}（${SERVER_STATE_TEXT[server.state]}）`).join('、')}`
  return `语言服务${info.enabled ? '已启用' : '已关闭'}：${builtin}；${servers}`
}

interface SyncMessage { kind: 'open' | 'change' | 'close'; path: string; languageId: string; version: number; content: string }

export class LanguageWorkspace {
  readonly sessionId: string
  readonly cwd: string
  readonly store: DiagnosticsStore
  private info: LanguageInfo | undefined
  private ready: Promise<void> | undefined
  private started = false
  private disposed = false
  private socket: WebSocket | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private hostTimer: ReturnType<typeof setTimeout> | undefined
  private readonly versions = new Map<string, number>()
  private readonly pending = new Map<string, { timer: ReturnType<typeof setTimeout>; message: SyncMessage }>()
  /** info 还没到（或当时该语言不受支持）时先记下打开的文档，拿到能力集合后补发。 */
  private readonly pendingOpens = new Map<string, { path: string; languageId: string; content: string }>()
  private queue: Promise<unknown> = Promise.resolve()
  /** 上一次写进「输出」面板的能力摘要；内容没变就不重复刷（WebSocket 重连会重拉 info）。 */
  private infoLog: string | undefined
  /** 上次看到的服务器状态，用于只在状态变化时写「输出」面板。 */
  private readonly serverStates = new Map<string, LanguageServerState>()

  constructor(sessionId: string, cwd: string) {
    this.sessionId = sessionId
    this.cwd = cwd
    this.store = diagnosticsStoreFor(cwd)
  }

  /** 当前能力集合（语言 id）；info 还没到时只乐观允许 TS/JS。 */
  supportsLanguage(languageId: string): boolean {
    if (this.info !== undefined) return this.info.enabled && this.info.languages.includes(languageId)
    return languageId === 'typescript' || languageId === 'javascript'
  }

  /** 是否启用（info 未到时按启用处理，避免首屏注册被延迟）。 */
  enabled(): boolean { return this.info?.enabled ?? true }

  serverInfo(): LanguageInfo | undefined { return this.info }

  start(): Promise<void> {
    if (this.started) return this.ready ?? Promise.resolve()
    this.started = true
    this.ready = (async () => {
      await this.refreshInfo()
      this.connect()
    })()
    return this.ready
  }

  /** 重新拉一次总体信息（设置改变、WebSocket 重连后调用）。 */
  async refreshInfo(): Promise<LanguageInfo | undefined> {
    if (this.disposed) return undefined
    try {
      const info = await api<LanguageInfo>('language.info', { sessionId: this.sessionId })
      if (this.disposed) return undefined
      this.info = info
      this.store.applyInfo(info)
      // 设置页关掉语言服务后：旧诊断不能继续挂在编辑器和问题面板上（状态保留，便于显示「已关闭」）。
      if (!info.enabled) this.store.clearDiagnostics()
      this.flushPendingOpens()
      window.dispatchEvent(new CustomEvent('dvw-language-info', { detail: info }))
      const summary = describeLanguage(info)
      if (summary !== this.infoLog) {
        this.infoLog = summary
        appendOutput('language', summary)
      }
      return info
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[dvw] 语言服务信息读取失败：', error)
      appendOutput('language', `读取语言服务信息失败：${message}`, 'error')
      return undefined
    }
  }

  definition(path: string, position: LanguagePosition, signal?: AbortSignal): Promise<readonly LanguageLocation[]> {
    return this.request<readonly LanguageLocation[]>('language.definition', { path, position }, signal, [])
  }

  hover(path: string, position: LanguagePosition, signal?: AbortSignal): Promise<LanguageHover | null> {
    return this.request<LanguageHover | null>('language.hover', { path, position }, signal, null)
  }

  references(path: string, position: LanguagePosition, signal?: AbortSignal): Promise<readonly LanguageLocation[]> {
    return this.request<readonly LanguageLocation[]>('language.references', { path, position }, signal, [])
  }

  rename(path: string, position: LanguagePosition, newName: string, signal?: AbortSignal): Promise<LanguageRenameResult> {
    return this.request<LanguageRenameResult>('language.rename', { path, position, newName }, signal, { canRename: false, message: '重命名请求失败' })
  }

  documentSymbols(path: string, signal?: AbortSignal): Promise<readonly LanguageDocumentSymbol[]> {
    return this.request<readonly LanguageDocumentSymbol[]>('language.documentSymbols', { path }, signal, [])
  }

  workspaceSymbols(query: string, signal?: AbortSignal, limit = 200): Promise<readonly LanguageSymbolInformation[]> {
    return this.request<readonly LanguageSymbolInformation[]>('language.workspaceSymbols', { query, limit }, signal, [])
  }

  completion(path: string, position: LanguagePosition, triggerCharacter?: string, signal?: AbortSignal): Promise<LanguageCompletionList | null> {
    return this.request<LanguageCompletionList | null>('language.completion', { path, position, ...(triggerCharacter === undefined ? {} : { triggerCharacter }) }, signal, null)
  }

  signatureHelp(path: string, position: LanguagePosition, signal?: AbortSignal): Promise<LanguageSignatureHelp | null> {
    return this.request<LanguageSignatureHelp | null>('language.signatureHelp', { path, position }, signal, null)
  }

  codeActions(path: string, range: LanguageRange, signal?: AbortSignal): Promise<readonly LanguageCodeAction[]> {
    return this.request<readonly LanguageCodeAction[]>('language.codeActions', { path, range }, signal, [])
  }

  scan(signal?: AbortSignal): Promise<{ supported: boolean; state?: LanguageScanState }> {
    appendOutput('language', '开始扫描工作区')
    return this.request<{ supported: boolean; state?: LanguageScanState }>('language.scan', {}, signal, { supported: false }).then(result => {
      const state = result.state
      if (state === undefined) appendOutput('language', '扫描没有返回结果', 'warn')
      else appendOutput('language', `扫描完成：检查 ${state.checked} 个文件，${state.errors} 个错误，${state.warnings} 个警告`)
      return result
    })
  }

  /** 读取宿主语言服务知道、但工作台文件 API 不一定能读的只读文件（跳转目标）。 */
  readFile(path: string, languageId?: string): Promise<{ path: string; content: string; languageId: string } | undefined> {
    return this.request<{ path: string; content: string; languageId: string } | undefined>('language.read', { path, ...(languageId === undefined ? {} : { languageId }) }, undefined, undefined)
  }

  /** 打开/切换语言服务文档（编辑器挂载时调用）。 */
  openDocument(path: string, languageId: string, content: string): void {
    const key = pathKey(path)
    this.pendingOpens.set(key, { path, languageId, content })
    // info 未到时只对 TS/JS 乐观发送；其它语言等 capability 到达后统一补发，避免白起一个不存在的服务器。
    if (this.info === undefined && languageId !== 'typescript' && languageId !== 'javascript') return
    if (!this.supportsLanguage(languageId)) return
    this.pendingOpens.delete(key)
    this.flushPending(path)
    this.sendDocument('open', path, languageId, content)
  }

  /** 正文变化：合并窗口后再发，避免每次击键一个请求。 */
  changeDocument(path: string, languageId: string, content: string): void {
    const key = pathKey(path)
    const pendingOpen = this.pendingOpens.get(key)
    if (pendingOpen !== undefined) this.pendingOpens.set(key, { ...pendingOpen, content })
    if (!this.supportsLanguage(languageId)) return
    if (content.length > MAX_SYNC_CHARS) {
      // 大文件同步会把请求体撑爆，也会让宿主程序变慢；直接不参与语言服务，问题面板不会显示它。
      this.closeDocument(path)
      return
    }
    const version = (this.versions.get(key) ?? 0) + 1
    this.versions.set(key, version)
    const previous = this.pending.get(key)
    if (previous !== undefined) clearTimeout(previous.timer)
    const message: SyncMessage = { kind: 'change', path, languageId, version, content }
    const timer = setTimeout(() => { this.pending.delete(key); this.enqueue(message) }, SYNC_DEBOUNCE_MS)
    this.pending.set(key, { timer, message })
  }

  /** 文档关闭：立刻发 didClose（不等合并窗口，避免关闭后还收到旧诊断）。 */
  closeDocument(path: string): void {
    const key = pathKey(path)
    this.flushPending(path)
    const version = (this.versions.get(key) ?? 0) + 1
    this.versions.set(key, version)
    this.enqueue({ kind: 'close', path, languageId: '', version, content: '' })
  }

  /**
   * 应用跨文件编辑：已打开的文件直接改模型（保留撤销栈、把标签标脏），没打开的干净文件交给宿主写盘。
   * 返回写入磁盘的路径，调用方据此刷新标签。
   */
  async applyEdit(edit: LanguageWorkspaceEdit): Promise<{ appliedModels: string[]; written: string[] }> {
    const appliedModels: string[] = []
    const remaining: { path: string; edits: LanguageWorkspaceEdit['changes'][number]['edits'] }[] = []
    for (const change of edit.changes) {
      const model = modelForPath(change.path)
      if (model !== undefined) {
        try {
          const edits = [...change.edits].sort((left, right) => {
            const a = left.range.start
            const b = right.range.start
            return b.line - a.line || b.character - a.character
          })
          model.pushEditOperations([], edits.map(item => ({ range: monacoRange(item.range), text: item.newText })), () => null)
          appliedModels.push(change.path)
          continue
        } catch (error) {
          console.warn(`[dvw] 在编辑器内应用语言编辑失败，改为写盘：${change.path}`, error)
        }
      }
      remaining.push({ path: change.path, edits: change.edits })
    }
    if (remaining.length === 0) return { appliedModels, written: [] }
    const response = await this.request<{ written?: string[] }>('language.applyEdit', {
      edit: { changes: remaining.map(change => ({ path: change.path, edits: [...change.edits] })) },
    }, undefined, { written: [] })
    const written = response.written ?? []
    if (written.length > 0) window.dispatchEvent(new CustomEvent('dvw-reload-files', { detail: written }))
    return { appliedModels, written }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.started = false
    for (const entry of this.pending.values()) clearTimeout(entry.timer)
    this.pending.clear()
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.hostTimer)
    this.socket?.close()
    this.socket = undefined
    this.store.clear()
    if (activeWorkspace === this) activeWorkspace = undefined
  }

  /* ────────────────────────────── 内部实现 ────────────────────────────── */

  private request<T>(method: string, params: Record<string, unknown>, signal: AbortSignal | undefined, fallback: T): Promise<T> {
    return api<T>(method, { sessionId: this.sessionId, ...params }, signal).catch(error => {
      // 路径不存在、能力不支持这类错误对用户没有意义（例如跳转目标刚被删），记一条日志即可。
      const message = error instanceof Error ? error.message : String(error)
      if (!/aborted/i.test(message)) {
        console.warn(`[dvw] ${method} 失败：`, message)
        appendOutput('language', `${method.replace(/^language\./, '')} 请求失败：${message}`, 'warn')
      }
      return fallback
    })
  }

  private flushPending(path: string): void {
    const key = pathKey(path)
    const entry = this.pending.get(key)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    this.pending.delete(key)
    this.enqueue(entry.message)
  }

  /** 拿到 capability 之后补发此前被跳过的文档（外部语言服务器还没被发现的场景）。 */
  private flushPendingOpens(): void {
    for (const [key, document] of [...this.pendingOpens]) {
      if (!this.supportsLanguage(document.languageId)) continue
      this.pendingOpens.delete(key)
      this.sendDocument('open', document.path, document.languageId, document.content)
    }
  }

  private sendDocument(kind: SyncMessage['kind'], path: string, languageId: string, content: string): void {
    if (!this.supportsLanguage(languageId)) return
    if (content.length > MAX_SYNC_CHARS) return
    const key = pathKey(path)
    const version = (this.versions.get(key) ?? 0) + 1
    this.versions.set(key, version)
    this.enqueue({ kind, path, languageId, version, content })
  }

  /** 串行发送，保证同一文档的 open → change → close 顺序与调用顺序一致。 */
  private enqueue(message: SyncMessage): void {
    this.queue = this.queue.then(() => this.sendSync(message)).catch(error => {
      const text = error instanceof Error ? error.message : String(error)
      console.warn('[dvw] 语言服务文档同步失败：', error)
      appendOutput('language', `文档同步失败（${message.kind} ${message.path}）：${text}`, 'warn')
    })
  }

  private async sendSync(message: SyncMessage): Promise<void> {
    if (this.disposed) return
    await this.ready?.catch(() => {})
    // close 的 languageId 是空的（客户端已经不再关心它），不能用能力集合去判断要不要发。
    if (message.kind !== 'close' && !this.supportsLanguage(message.languageId)) return
    await api('language.sync', {
      sessionId: this.sessionId,
      kind: message.kind,
      path: message.path,
      languageId: message.languageId === '' ? 'plaintext' : message.languageId,
      version: message.version,
      content: message.content,
    })
  }

  private connect(): void {
    if (this.disposed || this.socket !== undefined) return
    if (currentHostBase() === undefined) {
      // 桌面端要等第一次 API 响应带出宿主本机地址；稍后重试一次。
      this.hostTimer = setTimeout(() => this.connect(), 1500)
      return
    }
    try {
      const socket = new WebSocket(hostWebSocketUrl('/dsh-vscode/ws/language', { sessionId: this.sessionId }))
      this.socket = socket
      // 设置变更后宿主会重置语言服务并断开这条连接；重连成功后必须重拉能力集合，
      // 否则客户端还按旧的「哪些语言有服务器」注册特性。
      socket.onopen = () => {
        if (this.disposed) return
        appendOutput('language', '语言服务连接已建立')
        void this.refreshInfo()
      }
      socket.onmessage = event => this.receive(event.data)
      socket.onclose = () => {
        this.socket = undefined
        if (this.disposed) return
        appendOutput('language', `语言服务连接已断开，${RECONNECT_MS / 1000} 秒后重连`, 'warn')
        this.reconnectTimer = setTimeout(() => {
          if (!this.disposed && typeof document !== 'undefined' && document.visibilityState !== 'hidden') this.connect()
        }, RECONNECT_MS)
      }
      socket.onerror = () => { /* onclose 会接着触发，统一在那里重连 */ }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[dvw] 语言服务 WebSocket 连接失败：', error)
      appendOutput('language', `语言服务 WebSocket 连接失败：${message}`, 'error')
      this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_MS)
    }
  }

  private receive(raw: unknown): void {
    let message: LanguagePushMessage
    try {
      message = JSON.parse(String(raw)) as LanguagePushMessage
    } catch { return }
    if (message.type === 'diagnostics') {
      this.store.setDiagnostics(message.path, message.diagnostics, message.version)
      return
    }
    if (message.type === 'status') {
      this.store.applyStatus(message)
      this.logServerStates(message.servers)
      return
    }
    if (message.type === 'log') {
      appendOutput('language', message.message, message.level)
      const method = message.level === 'error' ? 'error' : message.level === 'warn' ? 'warn' : 'info'
      console[method]('[dvw] 语言服务：', message.message)
    }
  }

  /** 服务器状态变化写进「输出」面板；同一状态重复推送不刷屏。 */
  private logServerStates(servers: readonly LanguageServerInfo[]): void {
    for (const server of servers) {
      if (this.serverStates.get(server.id) === server.state) continue
      this.serverStates.set(server.id, server.state)
      appendOutput('language', `语言服务器 ${server.name}：${SERVER_STATE_TEXT[server.state]}`, server.state === 'failed' ? 'error' : 'info')
    }
  }
}

let activeWorkspace: LanguageWorkspace | undefined

/** 当前工作台使用的语言服务；Monaco 语言特性与快捷键都读它。 */
export function activeLanguageWorkspace(): LanguageWorkspace | undefined { return activeWorkspace }

/** Workbench 挂载/卸载时登记；同一时刻只有一个工作区在工作。 */
export function setActiveLanguageWorkspace(workspace: LanguageWorkspace | undefined): void {
  activeWorkspace = workspace
}

/** 测试用：清掉当前登记。 */
export function resetActiveLanguageWorkspace(): void {
  activeWorkspace?.dispose()
  activeWorkspace = undefined
}

export type { LanguageDiagnostic }
