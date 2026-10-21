/**
 * 外部 LSP 服务器实现的 LanguageProvider。
 *
 * 它把 `provider.ts` 的抽象（打开/修改文档、悬停、跳转……）翻译成 LSP 请求，并把 LSP 的宽松
 * JSON 结果收敛成公共协议类型。三个关键取舍：
 *   - 懒启动：第一次打开文档才 spawn 服务器，工作区里没有对应语言的文件就永远不起进程；
 *   - 降级不抛：服务器没装/启动失败/请求失败只记日志并返回空结果，语言服务不能拖垮编辑；
 *   - 文档同步串行：didOpen/didChange 按调用顺序串成一条链，避免异步启动完成后「didChange 先到」。
 */
import type {
  LanguageCodeAction,
  LanguageCompletionItem,
  LanguageCompletionList,
  LanguageDiagnostic,
  LanguageDocument,
  LanguageDocumentSymbol,
  LanguageHover,
  LanguageLocation,
  LanguageParameterInformation,
  LanguagePosition,
  LanguageRange,
  LanguageRenameResult,
  LanguageServerState,
  LanguageSeverity,
  LanguageSignatureHelp,
  LanguageSignatureInformation,
  LanguageSymbolInformation,
  LanguageSymbolKind,
  LanguageTextEdit,
  LanguageWorkspaceEdit,
} from '../protocol.ts'
import type { LanguageProvider, LanguageProviderInfo, LanguageProviderOptions } from '../provider.ts'
import type { DetectedServer } from '../servers.ts'
import { LspClient, pathToUri, uriToPath } from './client.ts'
import { spawnLspTransport } from './transport.ts'

export interface ExternalProviderOptions extends LanguageProviderOptions {
  server: DetectedServer
  /** 追加/覆盖给服务器进程的环境变量。 */
  env?: NodeJS.ProcessEnv
  /** 单次 LSP 请求超时；默认交给 client（20s），测试可调小。 */
  requestTimeoutMs?: number
}

/* ────────────────────────────── wire 形状 ────────────────────────────── */

interface WirePosition { line: number; character: number }
interface WireRange { start: WirePosition; end: WirePosition }

type LogLevel = 'info' | 'warn' | 'error'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isDefined<T>(value: T | undefined): value is T { return value !== undefined }

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function toWirePosition(position: LanguagePosition): WirePosition {
  return { line: position.line, character: position.character }
}

function toWireRange(range: LanguageRange): WireRange {
  return { start: toWirePosition(range.start), end: toWirePosition(range.end) }
}

function fromWirePosition(value: unknown): LanguagePosition {
  const record = isRecord(value) ? value : {}
  return { line: numberValue(record.line), character: numberValue(record.character) }
}

function fromWireRange(value: unknown): LanguageRange {
  const record = isRecord(value) ? value : {}
  return { start: fromWirePosition(record.start), end: fromWirePosition(record.end) }
}

/** MarkupContent / MarkedString / string 统一成展示文本。 */
function markupText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (isRecord(value) && typeof value.value === 'string') return value.value
  return undefined
}

function fencedCode(language: unknown, value: string): string {
  return `\`\`\`${typeof language === 'string' ? language : ''}\n${value}\n\`\`\``
}

/** Hover.contents 允许四种形态：string、MarkupContent、MarkedString、MarkedString[]。 */
function hoverText(contents: unknown): string | undefined {
  if (typeof contents === 'string') return contents
  if (isRecord(contents) && typeof contents.value === 'string') return contents.value
  if (!Array.isArray(contents)) return undefined
  const parts: string[] = []
  for (const part of contents) {
    if (typeof part === 'string') parts.push(part)
    else if (isRecord(part) && typeof part.value === 'string') parts.push(part.language === undefined ? part.value : fencedCode(part.language, part.value))
  }
  return parts.length === 0 ? undefined : parts.join('\n\n')
}

const SYMBOL_KIND_BY_NUMBER: Readonly<Record<number, LanguageSymbolKind>> = {
  1: 'file', 2: 'module', 3: 'namespace', 4: 'package', 5: 'class', 6: 'method', 7: 'property', 8: 'field',
  9: 'constructor', 10: 'enum', 11: 'interface', 12: 'function', 13: 'variable', 14: 'constant', 15: 'string',
  16: 'number', 17: 'boolean', 18: 'array', 19: 'object', 20: 'key', 21: 'null', 22: 'enumMember', 23: 'struct',
  24: 'event', 25: 'operator', 26: 'typeParameter',
}

const COMPLETION_KIND_BY_NUMBER: Readonly<Record<number, LanguageSymbolKind>> = {
  1: 'string', 2: 'method', 3: 'function', 4: 'constructor', 5: 'field', 6: 'variable', 7: 'class', 8: 'interface',
  9: 'module', 10: 'property', 11: 'object', 12: 'variable', 13: 'enum', 14: 'key', 15: 'string', 16: 'string',
  17: 'file', 18: 'string', 19: 'file', 20: 'enumMember', 21: 'constant', 22: 'struct', 23: 'event', 24: 'operator',
  25: 'typeParameter',
}

function symbolKind(value: unknown): LanguageSymbolKind {
  return typeof value === 'number' ? SYMBOL_KIND_BY_NUMBER[value] ?? 'variable' : 'variable'
}

function completionKind(value: unknown): LanguageSymbolKind | undefined {
  return typeof value === 'number' ? COMPLETION_KIND_BY_NUMBER[value] : undefined
}

function textEditFrom(value: unknown): LanguageTextEdit | undefined {
  if (!isRecord(value) || !isRecord(value.range) || typeof value.newText !== 'string') return undefined
  return { range: fromWireRange(value.range), newText: value.newText }
}

/**
 * WorkspaceEdit → 公共协议。
 *
 * 只处理文本编辑：`changes` 与 `documentChanges` 里的 TextDocumentEdit。CreateFile/RenameFile 这类
 * 资源操作没有对应的公共类型，跳过（重命名/快速修复实际几乎不会返回它们）。
 */
function workspaceEditFrom(value: unknown): LanguageWorkspaceEdit | undefined {
  if (!isRecord(value)) return undefined
  const files = new Map<string, LanguageTextEdit[]>()
  const add = (uri: unknown, edits: unknown): void => {
    if (typeof uri !== 'string' || !Array.isArray(edits)) return
    const path = uriToPath(uri)
    if (path === undefined) return
    const converted = edits.map(textEditFrom).filter(isDefined)
    if (converted.length === 0) return
    const existing = files.get(path)
    if (existing === undefined) files.set(path, converted)
    else existing.push(...converted)
  }
  if (isRecord(value.changes)) for (const [uri, edits] of Object.entries(value.changes)) add(uri, edits)
  if (Array.isArray(value.documentChanges)) {
    for (const change of value.documentChanges) {
      if (!isRecord(change) || !isRecord(change.textDocument)) continue
      add(change.textDocument.uri, change.edits)
    }
  }
  if (files.size === 0) return undefined
  return { changes: [...files.entries()].map(([path, edits]) => ({ path, edits })) }
}

/** Definition 允许 Location 或 LocationLink（linkSupport=true 时服务器可能回后者）。 */
function locationsFrom(value: unknown): LanguageLocation[] {
  const items = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]
  const locations: LanguageLocation[] = []
  for (const item of items) {
    if (!isRecord(item)) continue
    if (typeof item.uri === 'string') {
      const path = uriToPath(item.uri)
      if (path !== undefined && isRecord(item.range)) locations.push({ path, range: fromWireRange(item.range) })
      continue
    }
    if (typeof item.targetUri !== 'string') continue
    const path = uriToPath(item.targetUri)
    const range = isRecord(item.targetSelectionRange) ? item.targetSelectionRange : item.targetRange
    if (path !== undefined && isRecord(range)) locations.push({ path, range: fromWireRange(range) })
  }
  return locations
}

function documentSymbolFrom(value: unknown): LanguageDocumentSymbol | undefined {
  if (!isRecord(value) || typeof value.name !== 'string') return undefined
  // DocumentSymbol 用 range/selectionRange；SymbolInformation 用 location.range（扁平列表）。
  const rangeValue = isRecord(value.range) ? value.range : isRecord(value.location) && isRecord(value.location.range) ? value.location.range : undefined
  if (rangeValue === undefined) return undefined
  const range = fromWireRange(rangeValue)
  const selectionRange = isRecord(value.selectionRange) ? fromWireRange(value.selectionRange) : range
  const children = Array.isArray(value.children) ? value.children.map(documentSymbolFrom).filter(isDefined) : []
  const symbol: LanguageDocumentSymbol = {
    name: value.name,
    kind: symbolKind(value.kind),
    range,
    selectionRange,
    ...(children.length === 0 ? {} : { children }),
  }
  const detail = optionalString(value.detail) ?? optionalString(value.containerName)
  if (detail !== undefined) symbol.detail = detail
  return symbol
}

function symbolInformationFrom(value: unknown): LanguageSymbolInformation | undefined {
  if (!isRecord(value) || typeof value.name !== 'string' || !isRecord(value.location)) return undefined
  if (typeof value.location.uri !== 'string' || !isRecord(value.location.range)) return undefined
  const path = uriToPath(value.location.uri)
  if (path === undefined) return undefined
  const information: LanguageSymbolInformation = { name: value.name, kind: symbolKind(value.kind), path, range: fromWireRange(value.location.range) }
  const containerName = optionalString(value.containerName)
  if (containerName !== undefined) information.containerName = containerName
  return information
}

function completionItemFrom(value: unknown): LanguageCompletionItem | undefined {
  if (!isRecord(value) || typeof value.label !== 'string') return undefined
  const item: LanguageCompletionItem = { label: value.label }
  const detail = optionalString(value.detail)
  if (detail !== undefined) item.detail = detail
  const documentation = markupText(value.documentation)
  if (documentation !== undefined) item.documentation = documentation
  const kind = completionKind(value.kind)
  if (kind !== undefined) item.kind = kind
  if (isRecord(value.textEdit)) {
    // textEdit 比 insertText 精确：优先用它的 newText 与范围（InsertReplaceEdit 取 replace 范围）。
    if (typeof value.textEdit.newText === 'string') item.insertText = value.textEdit.newText
    const rangeValue = isRecord(value.textEdit.range) ? value.textEdit.range : isRecord(value.textEdit.replace) ? value.textEdit.replace : undefined
    if (rangeValue !== undefined) item.replaceRange = fromWireRange(rangeValue)
  } else if (typeof value.insertText === 'string') item.insertText = value.insertText
  const sortText = optionalString(value.sortText)
  if (sortText !== undefined) item.sortText = sortText
  const filterText = optionalString(value.filterText)
  if (filterText !== undefined) item.filterText = filterText
  if (Array.isArray(value.additionalTextEdits)) {
    const additionalEdits = value.additionalTextEdits.map(textEditFrom).filter(isDefined)
    if (additionalEdits.length > 0) item.additionalEdits = additionalEdits
  }
  return item
}

function completionListFrom(value: unknown): LanguageCompletionList | null {
  const rawItems = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.items) ? value.items : undefined
  if (rawItems === undefined) return null
  const list: LanguageCompletionList = { items: rawItems.map(completionItemFrom).filter(isDefined) }
  if (isRecord(value) && typeof value.isIncomplete === 'boolean') list.incomplete = value.isIncomplete
  return list
}

function parameterLabel(label: unknown, signatureLabel: string): string {
  if (typeof label === 'string') return label
  // LSP 允许 [start, end] 偏移对；偏移按 UTF-16 码元计，正好和 JS 字符串下标一致。
  if (Array.isArray(label) && label.length === 2 && typeof label[0] === 'number' && typeof label[1] === 'number') return signatureLabel.slice(label[0], label[1])
  return ''
}

function signatureHelpFrom(value: unknown): LanguageSignatureHelp | null {
  if (!isRecord(value) || !Array.isArray(value.signatures)) return null
  const signatures: LanguageSignatureInformation[] = []
  for (const rawSignature of value.signatures) {
    if (!isRecord(rawSignature) || typeof rawSignature.label !== 'string') continue
    const signature: LanguageSignatureInformation = { label: rawSignature.label, parameters: [] }
    const documentation = markupText(rawSignature.documentation)
    if (documentation !== undefined) signature.documentation = documentation
    if (Array.isArray(rawSignature.parameters)) {
      const parameters: LanguageParameterInformation[] = []
      for (const rawParameter of rawSignature.parameters) {
        if (!isRecord(rawParameter)) continue
        const parameter: LanguageParameterInformation = { label: parameterLabel(rawParameter.label, rawSignature.label) }
        const parameterDocumentation = markupText(rawParameter.documentation)
        if (parameterDocumentation !== undefined) parameter.documentation = parameterDocumentation
        parameters.push(parameter)
      }
      signature.parameters = parameters
    }
    if (typeof rawSignature.activeParameter === 'number') signature.activeParameter = rawSignature.activeParameter
    signatures.push(signature)
  }
  if (signatures.length === 0) return null
  const help: LanguageSignatureHelp = { signatures }
  if (typeof value.activeSignature === 'number') help.activeSignature = value.activeSignature
  if (typeof value.activeParameter === 'number') help.activeParameter = value.activeParameter
  return help
}

/** 只有带 edit 的动作能应用；Command 类（没有编辑）按设计丢弃。 */
function codeActionFrom(value: unknown): LanguageCodeAction | undefined {
  if (!isRecord(value) || typeof value.title !== 'string') return undefined
  const edit = workspaceEditFrom(value.edit)
  if (edit === undefined) return undefined
  const action: LanguageCodeAction = { title: value.title, edit }
  const kind = optionalString(value.kind)
  if (kind !== undefined) action.kind = kind
  if (typeof value.isPreferred === 'boolean') action.isPreferred = value.isPreferred
  return action
}

function wireSeverity(severity: LanguageSeverity): number {
  switch (severity) {
    case 'error': return 1
    case 'warning': return 2
    case 'info': return 3
    case 'hint': return 4
  }
}

function wireDiagnostic(diagnostic: LanguageDiagnostic): Record<string, unknown> {
  return {
    range: toWireRange(diagnostic.range),
    severity: wireSeverity(diagnostic.severity),
    message: diagnostic.message,
    ...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
    ...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
  }
}

/* ────────────────────────────── provider ────────────────────────────── */

export function createExternalProvider(options: ExternalProviderOptions): LanguageProvider {
  return new ExternalLanguageProvider(options)
}

class ExternalLanguageProvider implements LanguageProvider {
  readonly info: LanguageProviderInfo
  readonly server: DetectedServer
  private readonly options: ExternalProviderOptions
  private readonly documents = new Map<string, LanguageDocument>()
  private readonly opened = new Set<string>()
  private syncChain: Promise<void> = Promise.resolve()
  private client: LspClient | undefined
  private startPromise: Promise<LspClient> | undefined
  private startFailure: Error | undefined
  private stateValue: LanguageServerState = 'idle'
  private detailValue: string | undefined
  private disposed = false

  constructor(options: ExternalProviderOptions) {
    this.options = options
    this.server = options.server
    this.info = {
      id: options.server.id,
      name: options.server.name,
      languages: [...options.server.languages],
      kind: 'external',
    }
  }

  /** 运行状态（初始化中/运行中/失败/已停用）；管理器据此画状态栏。 */
  get state(): LanguageServerState { return this.stateValue }
  get detail(): string | undefined { return this.detailValue }

  openDocument(document: LanguageDocument): void {
    if (this.disposed) return
    this.documents.set(document.path, document)
    this.enqueue(async () => {
      const client = await this.ensureClient()
      if (client === undefined) return
      const current = this.documents.get(document.path)
      if (current === undefined || this.opened.has(document.path)) return
      this.opened.add(document.path)
      client.didOpen(current)
    })
  }

  changeDocument(document: LanguageDocument): void {
    if (this.disposed) return
    this.documents.set(document.path, document)
    this.enqueue(async () => {
      const client = await this.ensureClient()
      if (client === undefined) return
      const current = this.documents.get(document.path)
      if (current === undefined) return
      // 启动期间就发生的修改：服务器还没收到过 didOpen，直接以最新正文 open 一次即可。
      if (!this.opened.has(document.path)) {
        this.opened.add(document.path)
        client.didOpen(current)
        return
      }
      client.didChange(current)
    })
  }

  closeDocument(path: string): void {
    if (this.disposed) return
    this.documents.delete(path)
    // 服务器没收到过 didOpen 就不用 didClose；从 opened 里移除即可。
    if (!this.opened.delete(path)) return
    this.enqueue(() => { this.client?.didClose(path) })
  }

  hover(path: string, position: LanguagePosition, signal?: AbortSignal): Promise<LanguageHover | null> {
    return this.requestWith(null, 'textDocument/hover', this.textDocumentPositionParams(path, position), signal, result => {
      if (!isRecord(result)) return null
      const contents = hoverText(result.contents)
      if (contents === undefined || contents === '') return null
      const hover: LanguageHover = { contents }
      if (isRecord(result.range)) hover.range = fromWireRange(result.range)
      return hover
    })
  }

  definition(path: string, position: LanguagePosition, signal?: AbortSignal): Promise<readonly LanguageLocation[]> {
    return this.requestWith([], 'textDocument/definition', this.textDocumentPositionParams(path, position), signal, locationsFrom)
  }

  references(path: string, position: LanguagePosition, signal?: AbortSignal): Promise<readonly LanguageLocation[]> {
    return this.requestWith([], 'textDocument/references', { ...this.textDocumentPositionParams(path, position), context: { includeDeclaration: true } }, signal, locationsFrom)
  }

  async rename(path: string, position: LanguagePosition, newName: string, signal?: AbortSignal): Promise<LanguageRenameResult> {
    const client = await this.ensureClient()
    if (client === undefined) return { canRename: false, message: '语言服务器未启动' }
    try {
      const result = await client.request<unknown>('textDocument/rename', {
        textDocument: { uri: pathToUri(path) },
        position: toWirePosition(position),
        newName,
      }, signal)
      if (result === null || result === undefined) return { canRename: false, message: '语言服务器不支持重命名此符号' }
      const edit = workspaceEditFrom(result)
      if (edit === undefined) return { canRename: false, message: '语言服务器没有返回可应用的重命名编辑' }
      return { canRename: true, edit }
    } catch (error) {
      const message = messageOf(error)
      this.writeLog('warn', `textDocument/rename failed: ${message}`)
      return { canRename: false, message }
    }
  }

  async documentSymbols(path: string, signal?: AbortSignal): Promise<readonly LanguageDocumentSymbol[]> {
    return this.requestWith([], 'textDocument/documentSymbol', { textDocument: { uri: pathToUri(path) } }, signal, result => {
      const items = Array.isArray(result) ? result : []
      return items.map(documentSymbolFrom).filter(isDefined)
    })
  }

  async workspaceSymbols(query: string, limit: number, signal?: AbortSignal): Promise<readonly LanguageSymbolInformation[]> {
    const maximum = Math.max(0, Math.min(1000, Math.floor(limit)))
    return this.requestWith([], 'workspace/symbol', { query }, signal, result => {
      const items = Array.isArray(result) ? result : []
      return items.map(symbolInformationFrom).filter(isDefined).slice(0, maximum)
    })
  }

  async completion(path: string, position: LanguagePosition, triggerCharacter?: string, signal?: AbortSignal): Promise<LanguageCompletionList | null> {
    const params = {
      ...this.textDocumentPositionParams(path, position),
      context: triggerCharacter === undefined ? { triggerKind: 1 } : { triggerKind: 2, triggerCharacter },
    }
    return this.requestWith(null, 'textDocument/completion', params, signal, completionListFrom)
  }

  async signatureHelp(path: string, position: LanguagePosition, signal?: AbortSignal): Promise<LanguageSignatureHelp | null> {
    return this.requestWith(null, 'textDocument/signatureHelp', this.textDocumentPositionParams(path, position), signal, signatureHelpFrom)
  }

  async codeActions(path: string, range: LanguageRange, diagnostics: readonly LanguageDiagnostic[], signal?: AbortSignal): Promise<readonly LanguageCodeAction[]> {
    const params = {
      textDocument: { uri: pathToUri(path) },
      range: toWireRange(range),
      context: { diagnostics: diagnostics.map(wireDiagnostic) },
    }
    return this.requestWith([], 'textDocument/codeAction', params, signal, result => {
      const items = Array.isArray(result) ? result : []
      return items.map(codeActionFrom).filter(isDefined)
    })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.documents.clear()
    this.opened.clear()
    // 启动中的服务器也要等它起来再停，否则子进程会残留。
    const pendingStart = this.startPromise
    if (pendingStart !== undefined) { try { await pendingStart } catch { /* 启动失败已经记录过 */ } }
    const client = this.client
    this.client = undefined
    if (client !== undefined) {
      try { await client.stop() } catch (error) { this.writeLog('warn', `停止语言服务器失败：${messageOf(error)}`) }
    }
    this.setState('disabled')
  }

  /* ────────────────────────────── 内部 ────────────────────────────── */

  private textDocumentPositionParams(path: string, position: LanguagePosition): { textDocument: { uri: string }; position: WirePosition } {
    return { textDocument: { uri: pathToUri(path) }, position: toWirePosition(position) }
  }

  /** 统一的请求包装：启动失败/请求失败都降级成 fallback，不把异常抛给语言服务管理器。 */
  private async requestWith<T>(fallback: T, method: string, params: unknown, signal: AbortSignal | undefined, convert: (result: unknown) => T): Promise<T> {
    const client = await this.ensureClient()
    if (client === undefined) return fallback
    try { return convert(await client.request<unknown>(method, params, signal)) }
    catch (error) {
      // 用户主动取消不是错误，记 info 免得日志面板刷满取消记录。
      const cancelled = signal?.aborted === true
      this.writeLog(cancelled ? 'info' : 'warn', `${method} failed: ${messageOf(error)}`)
      return fallback
    }
  }

  /** 把文档同步任务串成链；单次失败只记日志，后续同步继续。 */
  private enqueue(task: () => Promise<void> | void): void {
    this.syncChain = this.syncChain.then(task).catch(error => this.writeLog('warn', `document sync failed: ${messageOf(error)}`))
  }

  private async ensureClient(): Promise<LspClient | undefined> {
    try { return await this.startClient() }
    catch { return undefined } // 启动失败已经在 launch 里记录并更新状态
  }

  private startClient(): Promise<LspClient> {
    if (this.disposed) return Promise.reject(new Error('language provider is disposed'))
    if (this.client !== undefined) return Promise.resolve(this.client)
    if (this.startFailure !== undefined) return Promise.reject(this.startFailure)
    if (this.startPromise !== undefined) return this.startPromise
    this.setState('starting')
    const pending = this.launch().finally(() => { if (this.startPromise === pending) this.startPromise = undefined })
    this.startPromise = pending
    return pending
  }

  private async launch(): Promise<LspClient> {
    const definition = this.server.definition
    try {
      const transport = spawnLspTransport({
        command: this.server.executable,
        args: this.server.args,
        cwd: this.options.workspace,
        // 服务器定义里的 env 作为默认值，调用方（管理器）的 env 覆盖它。
        env: { ...(definition.env ?? {}), ...(this.options.env ?? {}) },
        onStderr: line => this.writeLog('info', `[${definition.id}] ${line}`),
      })
      const client = new LspClient({
        transport,
        workspace: this.options.workspace,
        requestTimeoutMs: this.options.requestTimeoutMs,
        onDiagnostics: (path, diagnostics) => { if (!this.disposed) this.options.onDiagnostics(path, diagnostics) },
        onLog: (level, message) => this.writeLog(level, `[${definition.id}] ${message}`),
        clientName: 'dsh-aide',
      })
      transport.onClose(error => this.handleExit(client, error))
      await client.start({ initializationOptions: definition.initializationOptions })
      if (this.disposed) { await client.stop(); throw new Error('language provider is disposed') }
      this.client = client
      this.setState('running')
      this.writeLog('info', `语言服务器 ${this.server.name} 已启动：${this.server.executable}`)
      return client
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      // 只记录第一次失败：后续请求直接返回空结果，不再反复 spawn 一个装不上的服务器。
      if (this.startFailure === undefined) {
        this.startFailure = failure
        if (!this.disposed) {
          this.setState('failed', failure.message)
          this.writeLog('error', `语言服务器 ${this.server.name} 启动失败：${failure.message}`)
        }
      }
      throw failure
    }
  }

  /** 进程退出：已经 dispose 的属于正常收尾；运行中退出则标失败并禁止自动重启（避免崩溃循环）。 */
  private handleExit(client: LspClient, error?: Error): void {
    if (this.client !== client) return
    this.client = undefined
    if (this.disposed) return
    const failure = error ?? new Error('语言服务器进程已退出')
    this.startFailure = failure
    this.setState('failed', failure.message)
    this.writeLog(error === undefined ? 'info' : 'warn', `语言服务器 ${this.server.name} 已退出：${failure.message}`)
  }

  private setState(state: LanguageServerState, detail?: string): void {
    if (this.stateValue === state && this.detailValue === detail) return
    this.stateValue = state
    this.detailValue = detail
    this.options.onStateChange?.()
  }

  private writeLog(level: LogLevel, message: string): void {
    try { this.options.onLog?.(level, message) } catch { /* 日志回调不该影响语言服务 */ }
  }
}
