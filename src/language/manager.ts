/**
 * 一个工作区的语言服务管理器。
 *
 * 职责只有四件：
 *   1. 按语言挑 provider（内置 TypeScript，或按扩展名匹配到的外部 LSP 服务器）；
 *   2. 维护客户端打开的文档版本，把 open/change/close 转发给 provider；
 *   3. 把诊断收上来，聚合成推送消息（外部服务器主动推、内置服务按防抖调度算）；
 *   4. 给路由层提供一跳转/补全/重命名这类请求的统一入口。
 *
 * provider 一律懒加载：没打开对应语言的文件之前，不加载 TypeScript、也不启动外部服务器。
 * 这保证「装了 AIDE 但不用语言服务」的场景没有额外开销。
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { WorkbenchError } from '../wire.ts'
import { inside } from '../paths.ts'
import type { DetectedServer, ExternalServerDefinition } from './servers.ts'
import { discoverServers, serverForLanguage } from './servers.ts'
import { createExternalProvider } from './lsp/external.ts'
import { createTypeScriptProvider } from './typescript.ts'
import { configuredLanguageServers, languageSettings } from './settings.ts'
import type { LanguageProvider } from './provider.ts'
import {
  BUILTIN_TYPESCRIPT_ID,
  diagnosticCounts,
  isTypeScriptLanguage,
  languageIdForPath,
  type LanguageBuiltinInfo,
  type LanguageCodeAction,
  type LanguageCompletionList,
  type LanguageDiagnostic,
  type LanguageDocument,
  type LanguageDocumentSymbol,
  type LanguageHover,
  type LanguageInfo,
  type LanguageLocation,
  type LanguagePosition,
  type LanguagePushMessage,
  type LanguageRange,
  type LanguageRenameResult,
  type LanguageScanState,
  type LanguageServerInfo,
  type LanguageSignatureHelp,
  type LanguageSymbolInformation,
  type LanguageSyncKind,
  type LanguageWorkspaceEdit,
} from './protocol.ts'

/** 关闭文档后保留最近一次诊断，问题面板仍然能看到「已关闭文件里曾有错」。 */
const MAX_DIAGNOSTIC_FILES = 500
/** 单个只读文件（lib.d.ts 之类）的读取上限。 */
const MAX_READ_BYTES = 4 * 1024 * 1024
/** 工作区扫描时每算完几个文件推一次进度。 */
const SCAN_STATUS_EVERY = 8

export interface LanguageManagerOptions {
  /** 工作区根目录（绝对路径）。 */
  workspace: string
  /** 推送出口；没有客户端连接时可以为空。 */
  emit?: (message: LanguagePushMessage) => void
  /** 使用哪个环境变量集合（测试与排查用）。 */
  env?: Record<string, string | undefined>
  /** 内置服务的诊断防抖（ms）。 */
  diagnosticsDelayMs?: number
  /** 让测试能把定时器推进得更快。 */
  clock?: () => number
}

/** 语言请求失败时给路由层的错误（客户端会显示 message）。 */
export class LanguageRequestError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message) }
}

function keyOf(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class LanguageManager {
  private readonly workspace: string
  private readonly emit: (message: LanguagePushMessage) => void
  private readonly env: Record<string, string | undefined>
  private readonly diagnosticsDelayMs: number
  private readonly documents = new Map<string, LanguageDocument>()
  private readonly diagnostics = new Map<string, { path: string; items: readonly LanguageDiagnostic[] }>()
  private readonly providers = new Set<LanguageProvider>()
  private readonly providerByLanguage = new Map<string, LanguageProvider | null>()
  private readonly startedServers = new Map<string, LanguageProvider>()
  /**
   * 正在创建中的 provider。
   *
   * 打开文件与「跳转/悬停」可能同时到达：没有这层锁时两条并发路径会各建一个 TypeScript 语言服务
   * （两份项目程序、双倍内存），外部服务器的 `initialize` 也会被并发触发。按 provider 归类去重。
   */
  private readonly creating = new Map<string, Promise<LanguageProvider | undefined>>()
  private readonly diagnosticsTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private discovered: { available: DetectedServer[]; missing: ExternalServerDefinition[] } | undefined
  private scanState: LanguageScanState | undefined
  private scanRunning = false
  private lastStatusAt = 0
  private disposed = false

  constructor(options: LanguageManagerOptions) {
    this.workspace = resolve(options.workspace)
    this.emit = options.emit ?? (() => {})
    this.env = options.env ?? (globalThis.process?.env ?? {})
    this.diagnosticsDelayMs = options.diagnosticsDelayMs ?? 320
  }

  /** 当前工作区根（绝对路径）。 */
  root(): string { return this.workspace }

  /** 客户端拉取总体信息：哪些语言可服务、服务器状态、扫描进度。 */
  async info(): Promise<LanguageInfo> {
    const settings = languageSettings(undefined, this.env)
    if (!settings.enabled) {
      return {
        enabled: false,
        builtin: { enabled: false, state: 'disabled' },
        servers: [],
        languages: [],
        ...(this.scanState === undefined ? {} : { scan: this.scanState }),
      }
    }
    const discovered = await this.discover()
    const servers: LanguageServerInfo[] = []
    for (const server of discovered.available) {
      const provider = this.startedServers.get(server.id)
      servers.push({
        id: server.id, name: server.name, languages: server.languages,
        state: provider === undefined ? 'idle' : 'running',
        command: [server.executable, ...server.args].join(' '),
      })
    }
    for (const server of discovered.missing) {
      servers.push({
        id: server.id, name: server.name, languages: server.languages,
        state: 'missing', detail: '未找到可执行文件', command: server.command,
      })
    }
    const builtinProvider = settings.builtinTypescript ? this.lookupProvider('typescript') : undefined
    const builtin: LanguageBuiltinInfo = settings.builtinTypescript
      ? { enabled: true, state: 'ready', ...(builtinProvider?.info.version === undefined ? {} : { version: builtinProvider.info.version }) }
      : { enabled: false, state: 'disabled' }
    const languages = new Set<string>()
    if (settings.builtinTypescript) { languages.add('typescript'); languages.add('javascript') }
    for (const server of discovered.available) for (const language of server.languages) languages.add(language)
    return {
      enabled: true,
      builtin,
      servers,
      languages: [...languages],
      ...(this.scanState === undefined ? {} : { scan: this.scanState }),
    }
  }

  /** 客户端文档同步（open/change/close）。 */
  async sync(message: { kind: LanguageSyncKind; path: string; languageId: string; version: number; content: string }): Promise<void> {
    if (this.disposed) return
    const absolute = resolve(message.path)
    if (!inside(this.workspace, absolute)) throw new LanguageRequestError('path-outside', 'language document is outside the workspace', 403)
    const key = keyOf(absolute)
    if (message.kind === 'close') {
      const document = this.documents.get(key)
      this.documents.delete(key)
      this.clearDiagnosticsTimer(key)
      if (document !== undefined) {
        const provider = this.lookupProvider(document.languageId)
        provider?.closeDocument(document.path)
      }
      return
    }
    const existing = this.documents.get(key)
    if (existing !== undefined && existing.version > message.version) return
    const document: LanguageDocument = {
      path: absolute, languageId: message.languageId, version: message.version, content: message.content,
    }
    this.documents.set(key, document)
    const provider = await this.providerForLanguage(document.languageId)
    if (provider === undefined) return
    if (message.kind === 'open') provider.openDocument(document)
    else provider.changeDocument(document)
    this.scheduleBuiltinDiagnostics(document, provider)
  }

  async definition(path: string, position: LanguagePosition, signal?: AbortSignal): Promise<readonly LanguageLocation[]> {
    return this.withProvider(path, (provider, document) => provider.definition?.(document.path, position, signal) ?? Promise.resolve([]), [])
  }

  async hover(path: string, position: LanguagePosition, signal?: AbortSignal): Promise<LanguageHover | null> {
    return this.withProvider(path, async (provider, document) => provider.hover === undefined ? null : await provider.hover(document.path, position, signal), null)
  }

  async references(path: string, position: LanguagePosition, signal?: AbortSignal): Promise<readonly LanguageLocation[]> {
    return this.withProvider(path, (provider, document) => provider.references?.(document.path, position, signal) ?? Promise.resolve([]), [])
  }

  async rename(path: string, position: LanguagePosition, newName: string, signal?: AbortSignal): Promise<LanguageRenameResult> {
    if (newName.trim() === '') return { canRename: false, message: '新名称不能为空' }
    return this.withProvider(path, async (provider, document) => {
      if (provider.rename === undefined) return { canRename: false, message: '当前语言服务不支持重命名' }
      return await provider.rename(document.path, position, newName, signal)
    }, { canRename: false, message: '当前语言服务不支持重命名' })
  }

  async documentSymbols(path: string, signal?: AbortSignal): Promise<readonly LanguageDocumentSymbol[]> {
    return this.withProvider(path, (provider, document) => provider.documentSymbols?.(document.path, signal) ?? Promise.resolve([]), [])
  }

  async workspaceSymbols(query: string, limit = 200, signal?: AbortSignal): Promise<readonly LanguageSymbolInformation[]> {
    const trimmed = query.trim()
    if (trimmed === '') return []
    const providers: LanguageProvider[] = []
    const builtin = this.lookupProvider('typescript')
    if (builtin !== undefined) providers.push(builtin)
    for (const provider of this.startedServers.values()) if (provider.workspaceSymbols !== undefined && !providers.includes(provider)) providers.push(provider)
    if (providers.length === 0) return []
    const results = await Promise.all(providers.map(provider =>
      provider.workspaceSymbols?.(trimmed, limit, signal).catch(error => {
        this.log('warn', `工作区符号查询失败：${errorMessage(error)}`)
        return [] as readonly LanguageSymbolInformation[]
      }) ?? Promise.resolve([] as readonly LanguageSymbolInformation[]),
    ))
    const seen = new Set<string>()
    const merged: LanguageSymbolInformation[] = []
    for (const list of results) {
      for (const symbol of list) {
        const key = `${symbol.path}\0${symbol.range.start.line}:${symbol.range.start.character}\0${symbol.name}`
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(symbol)
        if (merged.length >= limit) return merged
      }
    }
    return merged
  }

  async completion(path: string, position: LanguagePosition, triggerCharacter?: string, signal?: AbortSignal): Promise<LanguageCompletionList | null> {
    return this.withProvider(path, async (provider, document) => {
      if (provider.completion === undefined) return null
      return await provider.completion(document.path, position, triggerCharacter, signal)
    }, null)
  }

  async signatureHelp(path: string, position: LanguagePosition, signal?: AbortSignal): Promise<LanguageSignatureHelp | null> {
    return this.withProvider(path, async (provider, document) => {
      if (provider.signatureHelp === undefined) return null
      return await provider.signatureHelp(document.path, position, signal)
    }, null)
  }

  async codeActions(path: string, range: LanguageRange, diagnostics: readonly LanguageDiagnostic[], signal?: AbortSignal): Promise<readonly LanguageCodeAction[]> {
    return this.withProvider(path, (provider, document) => provider.codeActions?.(document.path, range, diagnostics, signal) ?? Promise.resolve([]), [])
  }

  /** 取某文件当前已知诊断（快速修复的 codeAction 请求会用到）。 */
  diagnosticsOf(path: string): readonly LanguageDiagnostic[] {
    return this.diagnostics.get(keyOf(path))?.items ?? []
  }

  /**
   * 启动一次工作区级诊断扫描（目前只有内置 TypeScript 支持）。
   * 返回 undefined 表示当前没有可扫描的 provider。
   */
  async scan(signal?: AbortSignal): Promise<LanguageScanState | undefined> {
    if (this.scanRunning) return this.scanState
    const provider = await this.providerForLanguage('typescript')
    if (provider?.workspaceDiagnostics === undefined) return undefined
    this.scanRunning = true
    this.scanState = { running: true, checked: 0, total: 0, errors: 0, warnings: 0 }
    this.emitStatus(true)
    let errors = 0, warnings = 0, checked = 0
    try {
      const result = await provider.workspaceDiagnostics((path, diagnostics) => {
        this.recordDiagnostics(path, diagnostics)
        const counts = diagnosticCounts(diagnostics)
        errors += counts.errors
        warnings += counts.warnings
        checked++
        this.scanState = { running: true, checked, total: 0, errors, warnings }
        if (checked % SCAN_STATUS_EVERY === 0) this.emitStatus(true)
      }, signal)
      this.scanState = { running: false, checked: result.checked, total: result.checked, errors: result.errors, warnings: result.warnings }
    } catch (error) {
      this.log('warn', `工作区诊断扫描失败：${errorMessage(error)}`)
      this.scanState = { running: false, checked, total: checked, errors, warnings }
    } finally {
      this.scanRunning = false
      this.emitStatus(true)
    }
    return this.scanState
  }

  /** 读取只读文件（跳转目标可能在 node_modules / TypeScript lib 里）。 */
  async readFile(path: string, languageId?: string): Promise<{ path: string; content: string; languageId: string } | undefined> {
    const absolute = resolve(path)
    const resolvedLanguage = languageId ?? languageIdForPath(absolute) ?? ''
    if (inside(this.workspace, absolute)) {
      try {
        const stat = statSync(absolute)
        if (!stat.isFile() || stat.size > MAX_READ_BYTES) return undefined
        return { path: absolute, content: readFileSync(absolute, 'utf8'), languageId: resolvedLanguage }
      } catch { return undefined }
    }
    // 工作区之外只允许 provider 自己确认过的文件（TypeScript 程序里的声明文件等）。
    const provider = resolvedLanguage === '' ? undefined : this.lookupProvider(resolvedLanguage)
    if (provider?.readFile === undefined) return undefined
    try {
      const content = await provider.readFile(absolute)
      if (content === undefined || content.length > MAX_READ_BYTES) return undefined
      return { path: absolute, content, languageId: resolvedLanguage }
    } catch (error) {
      this.log('warn', `读取语言服务文件失败：${errorMessage(error)}`)
      return undefined
    }
  }

  /**
   * 把一组编辑写到磁盘（只用于没有打开模型的干净文件；打开中的文件由编辑器自己应用）。
   * 返回实际写入的文件，客户端据此刷新标签。
   */
  async applyEdits(edit: LanguageWorkspaceEdit): Promise<readonly string[]> {
    const written: string[] = []
    for (const change of edit.changes) {
      const absolute = resolve(change.path)
      if (!inside(this.workspace, absolute)) continue
      try {
        const original = readFileSync(absolute, 'utf8')
        const next = applyTextEdits(original, change.edits)
        const temporary = `${absolute}.dvw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        mkdirSync(dirname(absolute), { recursive: true })
        writeFileSync(temporary, next, 'utf8')
        renameSync(temporary, absolute)
        written.push(absolute)
      } catch (error) {
        this.log('warn', `写入语言服务编辑失败 ${absolute}：${errorMessage(error)}`)
      }
    }
    return written
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.diagnosticsTimers.values()) clearTimeout(timer)
    this.diagnosticsTimers.clear()
    for (const provider of this.providers) {
      try { void Promise.resolve(provider.dispose()).catch(() => {}) } catch { /* 卸载阶段尽力而为 */ }
    }
    this.providers.clear()
    this.providerByLanguage.clear()
    this.startedServers.clear()
    this.documents.clear()
  }

  /* ────────────────────────────── 内部实现 ────────────────────────────── */

  private async discover(): Promise<{ available: DetectedServer[]; missing: ExternalServerDefinition[] }> {
    if (this.discovered === undefined) {
      this.discovered = discoverServers(this.env, { language: { servers: configuredLanguageServers() } })
    }
    return this.discovered
  }

  /** 不触发加载：只查已经建好的 provider。 */
  private lookupProvider(languageId: string): LanguageProvider | undefined {
    const cached = this.providerByLanguage.get(languageId)
    return cached ?? undefined
  }

  private async providerForLanguage(languageId: string): Promise<LanguageProvider | undefined> {
    if (this.disposed) return undefined
    const cached = this.providerByLanguage.get(languageId)
    if (cached !== undefined) return cached ?? undefined
    const settings = languageSettings(undefined, this.env)
    if (!settings.enabled) return undefined
    // 内置 TS 的所有语言共用一份 provider；外部服务器按语言去重（同一服务器负责多语言时，
    // createProvider 里还会再按 server.id 复用一次）。
    const key = isTypeScriptLanguage(languageId) ? 'builtin-typescript' : `external:${languageId}`
    const pending = this.creating.get(key)
    if (pending !== undefined) return pending
    const promise = this.createProvider(languageId, settings)
    this.creating.set(key, promise)
    try { return await promise } finally { this.creating.delete(key) }
  }

  private async createProvider(languageId: string, settings: ReturnType<typeof languageSettings>): Promise<LanguageProvider | undefined> {
    // 等锁期间可能已被另一条路径建好，重新查一次缓存。
    const cached = this.providerByLanguage.get(languageId)
    if (cached !== undefined) return cached ?? undefined
    if (this.disposed) return undefined
    if (isTypeScriptLanguage(languageId)) {
      if (!settings.builtinTypescript) { this.providerByLanguage.set(languageId, null); return undefined }
      const provider = this.registerProvider(createTypeScriptProvider({
        workspace: this.workspace,
        onDiagnostics: (path, diagnostics) => this.recordDiagnostics(path, diagnostics),
        onLog: (level, message) => this.log(level, message),
        onStateChange: () => this.emitStatus(false),
      }))
      for (const language of provider.info.languages) this.providerByLanguage.set(language, provider)
      this.emitStatus(true)
      return provider
    }
    const discovered = await this.discover()
    const server = serverForLanguage(languageId, discovered.available)
    if (server === undefined) { this.providerByLanguage.set(languageId, null); return undefined }
    // 同一个服务器定义可能负责多个语言：已经在跑就直接复用，别起第二个进程。
    const running = this.startedServers.get(server.id)
    if (running !== undefined) {
      for (const language of running.info.languages) this.providerByLanguage.set(language, running)
      return running
    }
    try {
      const provider = this.registerProvider(createExternalProvider({
        workspace: this.workspace,
        server,
        env: this.env,
        onDiagnostics: (path, diagnostics) => this.recordDiagnostics(path, diagnostics),
        onLog: (level, message) => this.log(level, message),
        onStateChange: () => this.emitStatus(false),
      }))
      this.startedServers.set(server.id, provider)
      for (const language of provider.info.languages) this.providerByLanguage.set(language, provider)
      this.emitStatus(true)
      return provider
    } catch (error) {
      this.log('error', `启动语言服务器 ${server.name} 失败：${errorMessage(error)}`)
      this.providerByLanguage.set(languageId, null)
      return undefined
    }
  }

  private registerProvider(provider: LanguageProvider): LanguageProvider {
    this.providers.add(provider)
    // 新 provider 要把此前已经打开的文档补一遍，否则先于 provider 创建而打开的文档永远收不到诊断。
    for (const document of this.documents.values()) {
      if (provider.info.languages.includes(document.languageId)) {
        try { provider.openDocument(document) } catch (error) { this.log('warn', `同步已打开文档失败：${errorMessage(error)}`) }
      }
    }
    return provider
  }

  private scheduleBuiltinDiagnostics(document: LanguageDocument, provider: LanguageProvider): void {
    if (provider.diagnostics === undefined) return
    const key = keyOf(document.path)
    this.clearDiagnosticsTimer(key)
    const timer = setTimeout(() => {
      this.diagnosticsTimers.delete(key)
      const latest = this.documents.get(key)
      if (latest === undefined || latest.version !== document.version) return
      void provider.diagnostics?.(latest.path).then(diagnostics => {
        if (this.disposed) return
        this.recordDiagnostics(latest.path, diagnostics)
      }).catch(error => this.log('warn', `诊断计算失败：${errorMessage(error)}`))
    }, this.diagnosticsDelayMs)
    this.diagnosticsTimers.set(key, timer)
  }

  private clearDiagnosticsTimer(key: string): void {
    const timer = this.diagnosticsTimers.get(key)
    if (timer !== undefined) { clearTimeout(timer); this.diagnosticsTimers.delete(key) }
  }

  private recordDiagnostics(path: string, diagnostics: readonly LanguageDiagnostic[]): void {
    if (this.disposed) return
    const absolute = resolve(path)
    const key = keyOf(absolute)
    this.diagnostics.set(key, { path: absolute, items: diagnostics })
    if (this.diagnostics.size > MAX_DIAGNOSTIC_FILES) {
      // 只清掉已经关闭且没有诊断的文件，避免把当前打开文件的诊断误删。
      for (const [candidate, value] of this.diagnostics) {
        if (this.documents.has(candidate)) continue
        if (value.items.length > 0) continue
        this.diagnostics.delete(candidate)
        if (this.diagnostics.size <= MAX_DIAGNOSTIC_FILES) break
      }
    }
    this.emit({ type: 'diagnostics', path: absolute, diagnostics })
  }

  private async withProvider<T>(path: string, run: (provider: LanguageProvider, document: LanguageDocument) => Promise<T>, fallback: T): Promise<T> {
    if (this.disposed) return fallback
    const absolute = resolve(path)
    // 请求允许落在工作区外的只读文件上：跳转目标可能在 node_modules 或 TypeScript 的 lib.*.d.ts 里，
    // 用户在那个只读标签里仍应能继续悬停/跳转。真正的读盘权限由 provider 提供：内置 TS 只认
    // 自己程序里的 SourceFile，外部 LSP 服务器只认自己打开过的文档。
    const document = await this.ensureDocument(absolute)
    if (document === undefined) return fallback
    const provider = await this.providerForLanguage(document.languageId)
    if (provider === undefined) return fallback
    try { return await run(provider, document) } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return fallback
      this.log('warn', `语言请求失败：${errorMessage(error)}`)
      return fallback
    }
  }

  /** 请求可能落在没打开的跳转目标上：按需读盘并补一次 open。 */
  private async ensureDocument(absolute: string): Promise<LanguageDocument | undefined> {
    const key = keyOf(absolute)
    const existing = this.documents.get(key)
    if (existing !== undefined) return existing
    let content: string
    try {
      const stat = statSync(absolute)
      if (!stat.isFile() || stat.size > MAX_READ_BYTES) return undefined
      content = readFileSync(absolute, 'utf8')
    } catch { return undefined }
    const languageId = languageIdForPath(absolute)
    if (languageId === undefined) return undefined
    const document: LanguageDocument = { path: absolute, languageId, version: 1, content }
    this.documents.set(key, document)
    const provider = await this.providerForLanguage(languageId)
    // provider 刚创建时会把已打开文档补一遍；重复 open 是幂等的，这里无条件再同步一次，
    // 保证「provider 早已存在、只是这份文档刚被请求」时也能进入程序。
    if (provider !== undefined) {
      try { provider.openDocument(document) } catch (error) { this.log('warn', `同步按需文档失败：${errorMessage(error)}`) }
    }
    return document
  }

  private emitStatus(force: boolean): void {
    const now = Date.now()
    if (!force && now - this.lastStatusAt < 200) return
    this.lastStatusAt = now
    void this.info().then(info => {
      if (this.disposed) return
      this.emit({ type: 'status', servers: info.servers, builtin: info.builtin, ...(info.scan === undefined ? {} : { scan: info.scan }) })
    }).catch(() => {})
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    if (this.disposed) return
    this.emit({ type: 'log', level, message })
  }
}

/** 按范围从后往前应用替换，保证前面的编辑不会移动后面编辑的坐标。 */
export function applyTextEdits(text: string, edits: readonly { range: LanguageRange; newText: string }[]): string {
  const lineStarts = lineOffsets(text)
  const offsetOf = (position: LanguagePosition): number => {
    const line = Math.max(0, Math.min(position.line, lineStarts.length - 1))
    const start = lineStarts[line] ?? 0
    return Math.min(text.length, start + Math.max(0, position.character))
  }
  const ordered = [...edits].sort((left, right) => {
    const a = offsetOf(left.range.start)
    const b = offsetOf(right.range.start)
    return b - a
  })
  let next = text
  for (const edit of ordered) {
    const start = offsetOf(edit.range.start)
    const end = offsetOf(edit.range.end)
    if (start > end) throw new LanguageRequestError('invalid-edit', 'edit range is reversed')
    next = `${next.slice(0, start)}${edit.newText}${next.slice(end)}`
  }
  return next
}

/** 每行起始偏移；空文本也返回 [0]，让位置 0:0 可用。 */
function lineOffsets(text: string): number[] {
  const starts = [0]
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1)
  }
  return starts
}

export { BUILTIN_TYPESCRIPT_ID }
