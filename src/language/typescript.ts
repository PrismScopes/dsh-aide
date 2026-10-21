/**
 * 内置 TypeScript 语言服务（宿主侧 provider）。
 *
 * 为什么是「内置」而不是起一个 tsserver 子进程：AIDE 的补全链路已经在宿主进程里跑，诊断与跳转只需要
 * 工作区的编译器视图，不需要另一份进程、协议与生命周期；代价是所有计算都占用宿主单线程，所以这里把
 * 重活（首次加载 lib、语义检查）做成「首次用到才做」，且工作区扫描有文件数与单文件大小上限。
 *
 * 三件事决定了这一层的形状：
 *   1. **TypeScript 是懒加载的**：模块顶层不 import `typescript`，首次异步操作时才动态 import。宿主
 *      bundle 里 typescript 是外部化依赖（node_modules 已有），这样只在真正打开补全/诊断时才付出加载
 *      成本；构造函数与文档同步（open/change/close）必须同步、轻量。
 *   2. **内存正文优先**：客户端推送的正文（可能还没落盘）是唯一真相；磁盘只在「没打开」时读，并用
 *      mtime+size 生成版本号，让 TypeScript 自己感知磁盘变化。
 *   3. **不给路由层抛异常**：TypeScript 的 API 会在半损坏的文件、被删的模块、不完整的配置上抛错。
 *      这一层吞掉异常、写一条 warn 日志、返回空结果 —— 语言服务失败不该让整个工作台请求 500。
 *
 * 坐标约定：本文件只在边界上与协议交互，内部一律使用 UTF-16 字符偏移（TypeScript 的 TextSpan），
 * 输出时转换成 0 基行列（见 protocol.ts）。行列都从 0 开始。
 */
import { readdir, stat } from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import type { LanguageProvider, LanguageProviderInfo, LanguageProviderOptions, LanguageScanResult } from './provider.ts'
import {
  BUILTIN_TYPESCRIPT_ID,
  diagnosticCounts,
  severityRank,
  type LanguageCodeAction,
  type LanguageCompletionItem,
  type LanguageCompletionList,
  type LanguageDiagnostic,
  type LanguageDocument,
  type LanguageDocumentSymbol,
  type LanguageFileEdit,
  type LanguageHover,
  type LanguageLocation,
  type LanguagePosition,
  type LanguageRange,
  type LanguageRelatedInformation,
  type LanguageRenameResult,
  type LanguageSignatureHelp,
  type LanguageSignatureInformation,
  type LanguageSymbolInformation,
  type LanguageSymbolKind,
  type LanguageTextEdit,
  type LanguageWorkspaceEdit,
} from './protocol.ts'

/* 只在类型位置引用 typescript：`typeof import(...)` 与内联 import 类型都会被编译期擦除，
 * 因此不会把 typescript 拉进运行时依赖 —— 真正的加载发生在 initialize() 里的动态 import。 */
type TsModule = typeof import('typescript')
type TsService = import('typescript').LanguageService
type TsProgram = import('typescript').Program
type TsDiagnostic = import('typescript').Diagnostic
type TsCompilerOptions = import('typescript').CompilerOptions
type TsFormatCodeSettings = import('typescript').FormatCodeSettings
type TsLanguageServiceHost = import('typescript').LanguageServiceHost
type TsTextSpan = import('typescript').TextSpan

/** 参与扫描（没有 tsconfig 时）的扩展名。d.ts 也以 `.ts` 结尾，一并算作工作区源文件。 */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

/**
 * 扫描时整目录跳过的名字。
 *
 * 除了依赖与产物目录，还跳过一切以 `.` 开头的目录（.git/.next/.turbo/.cache/.vscode/.dsh-workbench…）：
 * 它们要么不是源码，要么是工具缓存，扫进来只会让首次程序构建变慢。
 */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'lib', 'out', 'coverage', 'target', 'bin', 'obj'])

/** 扫描上限：超过之后补全/诊断只会更慢，不如明确放弃（并在日志里说明）。 */
const MAX_WORKSPACE_FILES = 6000
/** 单个源文件上限：日志、生成物这类大文件放进程序只会拖垮语义检查。 */
const MAX_SOURCE_FILE_BYTES = 1024 * 1024
/** readFile 对外可读内容上限（2 MiB），超过视为「不属于本服务该给客户端看的内容」。 */
const MAX_READ_FILE_CHARS = 2 * 1024 * 1024
/** lineStarts 缓存条目上限：切文件很频繁时避免无界增长。 */
const MAX_LINE_CACHE_ENTRIES = 256

/** 内部打开文档记录：正文是客户端推来的内存快照，version 由客户端保证单调。 */
interface OpenDocument {
  /** 绝对路径（本机分隔符）。 */
  path: string
  languageId: string
  version: number
  content: string
}

const EMPTY_SCAN: LanguageScanResult = { checked: 0, errors: 0, warnings: 0 }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 取消检查做成函数：避免控制流分析把同一作用域里后续的 `signal?.aborted === true` 判成不可能。 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** 计算每一行起始偏移；用于把 TS 的字符偏移映射成 0 基行列。 */
function computeLineStarts(text: string): number[] {
  const starts = [0]
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10 /* \n */) starts.push(index + 1)
  }
  return starts
}

/** 偏移 → 0 基行列（starts 必须来自同一份 text）。 */
function positionAt(starts: readonly number[], textLength: number, offset: number): LanguagePosition {
  const target = Math.max(0, Math.min(offset, textLength))
  let low = 0
  let high = Math.max(0, starts.length - 1)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if ((starts[middle] ?? 0) <= target) low = middle
    else high = middle - 1
  }
  return { line: low, character: target - (starts[low] ?? 0) }
}

/** TextSpan（可能缺 length）→ 协议范围。 */
function spanRange(starts: readonly number[], textLength: number, span: TsTextSpan): LanguageRange {
  const start = Math.max(0, span.start)
  return {
    start: positionAt(starts, textLength, start),
    end: positionAt(starts, textLength, start + Math.max(0, span.length)),
  }
}

/** 0 基行列 → 字符偏移：行内列号夹到该行末尾（不越过换行符，CRLF 时也不越过 \r）。 */
function offsetAtPosition(text: string, starts: readonly number[], position: LanguagePosition): number {
  const lineCount = starts.length
  const line = Math.max(0, Math.min(position.line, lineCount - 1))
  const start = starts[line] ?? 0
  const nextLineStart = starts[line + 1] ?? text.length
  const newlineStart = line + 1 < lineCount ? Math.max(start, nextLineStart - 1) : text.length
  // 行尾逻辑上在换行符之前：CRLF 时还要再退一个 \r，否则列号越界会夹到 \n 上，后续替换会把换行也吃掉。
  const lineEnd = newlineStart > start && text.charCodeAt(newlineStart - 1) === 13 /* \r */ ? newlineStart - 1 : newlineStart
  return Math.min(start + Math.max(0, position.character), lineEnd)
}

function displayPartsText(parts: readonly { text: string }[] | undefined): string {
  return (parts ?? []).map(part => part.text).join('')
}

/**
 * TypeScript 的 ScriptElementKind（字符串枚举）→ 协议里的 LSP 风格 SymbolKind。
 *
 * 两边的分类并不一一对应（TS 有 keyword/alias/primitive type 这些 LSP 没有「符号种类」的概念），
 * 取最接近的一项；未知值退化成 variable，宁可分类粗略，也不让客户端因为未知字符串而丢掉条目。
 */
function symbolKindOf(kind: string): LanguageSymbolKind {
  switch (kind) {
    case 'class':
    case 'local class':
      return 'class'
    case 'interface':
    case 'type':
    case 'primitive type':
      return 'interface'
    case 'enum':
      return 'enum'
    case 'enum member':
      return 'enumMember'
    case 'module':
    case 'script':
    case 'external module name':
    case 'alias':
      return 'module'
    case 'directory':
      return 'file'
    case 'function':
    case 'local function':
      return 'function'
    case 'method':
      return 'method'
    case 'getter':
    case 'setter':
    case 'property':
    case 'accessor':
      return 'property'
    case 'constructor':
      return 'constructor'
    case 'var':
    case 'local var':
    case 'let':
    case 'using':
    case 'local using':
    case 'parameter':
      return 'variable'
    case 'const':
      return 'constant'
    case 'type parameter':
      return 'typeParameter'
    case 'string':
      return 'string'
    case 'label':
    case 'keyword':
      return 'key'
    default:
      return 'variable'
  }
}

/** TS DiagnosticCategory → 协议严重级别（Suggestion/Message 都是弱提示，归 info）。 */
function severityOf(category: import('typescript').DiagnosticCategory): LanguageDiagnostic['severity'] {
  switch (category) {
    case 1: return 'error'
    case 0: return 'warning'
    default: return 'info'
  }
}

/** 未使用/已弃用标记：客户端据此把对应文字画淡。 */
function tagsOf(diagnostic: TsDiagnostic): LanguageDiagnostic['tags'] {
  const tags: Array<'unnecessary' | 'deprecated'> = []
  if (diagnostic.reportsUnnecessary !== undefined) tags.push('unnecessary')
  if (diagnostic.reportsDeprecated !== undefined) tags.push('deprecated')
  return tags.length === 0 ? undefined : tags
}

/** 默认（没有 tsconfig 时）的编译设置：宽松、只看语法与明显类型错误，不要求工程化配置。 */
function defaultCompilerOptions(ts: TsModule): TsCompilerOptions {
  return {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    // 没有 tsconfig 就说明用户没表态：不做 strict 检查，避免把 noImplicitAny 之类洪水式诊断推给用户。
    strict: false,
    noImplicitAny: false,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    forceConsistentCasingInFileNames: true,
  }
}

/**
 * 把 tsconfig 里的 options 收敛成「只读、不产出」的形态。
 *
 * 语言服务不需要 emit，而且 composite/declaration 与 noEmit 组合会被 TS 当成配置错误；这里强制关掉
 * 与产出相关的开关，避免一个本来用于 `tsc -b` 的工程配置让语言服务拒绝工作。其余选项（target、module、
 * paths、strict…）原样保留：诊断结果必须与用户的编译配置一致。
 */
function sanitizeCompilerOptions(options: TsCompilerOptions): TsCompilerOptions {
  return {
    ...options,
    noEmit: true,
    incremental: false,
    composite: false,
    declaration: false,
    declarationMap: false,
    emitDeclarationOnly: false,
    tsBuildInfoFile: undefined,
  }
}

/** 判断一个目录名是否应当跳过扫描。 */
function shouldSkipDirectory(name: string): boolean {
  return name.startsWith('.') || SKIPPED_DIRECTORIES.has(name)
}

/**
 * 内置 TypeScript 语言服务。
 *
 * 生命周期：构造（同步、不加载 TS）→ 首次异步操作时初始化（动态 import + 读 tsconfig/扫描 + 建 service）
 * → 客户端 open/change/close 同步更新内存正文 → dispose。任何公开方法在 dispose 之后都返回空结果而不是抛错。
 */
export class TypeScriptLanguageProvider implements LanguageProvider {
  readonly info: LanguageProviderInfo = {
    id: BUILTIN_TYPESCRIPT_ID,
    name: '内置 TypeScript',
    languages: ['typescript', 'javascript', 'javascriptreact', 'typescriptreact'],
    kind: 'builtin',
  }

  private readonly workspace: string
  private readonly options: LanguageProviderOptions
  private readonly caseSensitive: boolean
  /** 磁盘文件版本号的缓存时长：TS 每次同步都会对程序内每个文件调 getScriptVersion，逐次 stat 太贵。 */
  private readonly diskVersionCacheMs: number

  private ts: TsModule | undefined
  private service: TsService | undefined
  private initPromise: Promise<void> | undefined
  private disposed = false

  /** 程序根文件（tsconfig 的 fileNames，或扫描结果）。 */
  private rootFiles: string[] = []
  private settings: TsCompilerOptions = {}
  private formatOptions: TsFormatCodeSettings | undefined

  private readonly openDocuments = new Map<string, OpenDocument>()
  private readonly diskVersions = new Map<string, { version: string; at: number }>()
  private readonly diagnosticsCache = new Map<string, { program: TsProgram; version: string; diagnostics: readonly LanguageDiagnostic[] }>()
  private readonly lineCache = new Map<string, { text: string; starts: readonly number[] }>()

  /**
   * @param options provider 选项（工作区、诊断回调、日志）。
   * @param internals 只为测试/调优保留的内部开关；不改变 LanguageProvider 契约。
   */
  constructor(options: LanguageProviderOptions, internals: { diskVersionCacheMs?: number } = {}) {
    this.options = options
    this.workspace = resolve(options.workspace)
    // Windows / macOS 的文件系统默认大小写不敏感；TS 的 ts.sys 也这样判断，这里保持一致，
    // 否则同一个文件用不同大小写进来会在我们的 Map 里变成两份。
    this.caseSensitive = process.platform !== 'win32' && process.platform !== 'darwin'
    this.diskVersionCacheMs = internals.diskVersionCacheMs ?? 2000
  }

  /* ───────────────────────────── 文档同步（同步、轻量） ───────────────────────────── */

  openDocument(document: LanguageDocument): void {
    if (this.disposed) return
    this.storeDocument(document, false)
  }

  changeDocument(document: LanguageDocument): void {
    if (this.disposed) return
    this.storeDocument(document, true)
  }

  closeDocument(path: string): void {
    if (this.disposed) return
    this.openDocuments.delete(this.keyOf(path))
  }

  /**
   * 记录客户端正文。
   *
   * `changeDocument` 会丢弃版本号倒退的请求：网络乱序时旧正文覆盖新正文，会让诊断/跳转用到过期内容，
   * 这比「丢一次更新」严重得多。open 不做这个检查 —— 重新打开同一个文件是新一轮版本序列。
   */
  private storeDocument(document: LanguageDocument, isChange: boolean): void {
    const key = this.keyOf(document.path)
    const existing = this.openDocuments.get(key)
    if (isChange && existing !== undefined && document.version < existing.version) return
    this.openDocuments.set(key, {
      path: this.absolute(document.path),
      languageId: document.languageId,
      version: document.version,
      content: document.content,
    })
  }

  /* ───────────────────────────── 初始化 ───────────────────────────── */

  private async ensureService(): Promise<{ ts: TsModule; service: TsService } | undefined> {
    this.initPromise ??= this.initialize()
    await this.initPromise
    if (this.disposed) return undefined
    const ts = this.ts
    const service = this.service
    return ts === undefined || service === undefined ? undefined : { ts, service }
  }

  /** 首次异步操作时加载 typescript、准备程序根并创建语言服务；失败只留日志，之后每次调用都返回空结果。 */
  private async initialize(): Promise<void> {
    try {
      const ts = await import('typescript')
      if (this.disposed) return
      this.ts = ts
      await this.loadProject(ts)
      if (this.disposed) return
      this.formatOptions = ts.getDefaultFormatCodeSettings('\n')
      this.service = ts.createLanguageService(this.createHost(ts), ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames, this.workspace))
    } catch (error) {
      this.warn(`初始化失败：${messageOf(error)}`)
    }
  }

  /** 有 tsconfig 就按它来（include/exclude/files 全部生效）；没有就扫描工作区。 */
  private async loadProject(ts: TsModule): Promise<void> {
    const configPath = ts.findConfigFile(this.workspace, ts.sys.fileExists)
    if (configPath !== undefined) {
      try {
        const read = ts.readConfigFile(configPath, ts.sys.readFile)
        if (read.error !== undefined) {
          this.warn(`读取 ${configPath} 失败：${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`)
        } else {
          const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), undefined, configPath)
          if (parsed.errors.length > 0) {
            const first = parsed.errors[0]
            if (first !== undefined) this.warn(`${configPath} 有配置问题：${ts.flattenDiagnosticMessageText(first.messageText, ' ')}`)
          }
          this.rootFiles = parsed.fileNames.map(fileName => this.absolute(fileName))
          this.settings = sanitizeCompilerOptions(parsed.options)
          return
        }
      } catch (error) {
        this.warn(`解析 ${configPath} 失败，回退到目录扫描：${messageOf(error)}`)
      }
    }
    this.rootFiles = await this.scanWorkspace()
    this.settings = defaultCompilerOptions(ts)
  }

  /**
   * 没有 tsconfig 时的兜底文件发现。
   *
   * 广度优先遍历、按文件名排序，保证同一目录下的结果稳定（程序根顺序会影响符号顺序与测试可重复性）。
   * 上限与跳过目录见文件顶部常量：宁可少收文件，也不能让打开工作台时卡在扫描上。
   */
  private async scanWorkspace(): Promise<string[]> {
    const files: string[] = []
    const queue: string[] = [this.workspace]
    while (queue.length > 0) {
      const directory = queue.shift() as string
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch {
        continue
      }
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        if (files.length >= MAX_WORKSPACE_FILES) break
        const fullPath = join(directory, entry.name)
        // 跳过符号链接：工作区里的链接可能指向外部目录甚至形成环，跟随它会让扫描越界或死循环。
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          if (!shouldSkipDirectory(entry.name)) queue.push(fullPath)
          continue
        }
        if (!entry.isFile()) continue
        if (!SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
        try {
          const info = await stat(fullPath)
          if (info.size > MAX_SOURCE_FILE_BYTES) continue
        } catch {
          continue
        }
        files.push(fullPath)
      }
      if (files.length >= MAX_WORKSPACE_FILES) {
        this.warn(`工作区文件超过 ${MAX_WORKSPACE_FILES} 个，只把前 ${MAX_WORKSPACE_FILES} 个纳入程序；建议添加 tsconfig.json 明确范围`)
        break
      }
    }
    return files
  }

  /** 程序文件 ∪ 客户端已打开文档：打开的文件即使不在 include/扫描结果里也必须能被诊断与跳转。 */
  private scriptFileNames(): string[] {
    const names: string[] = []
    const seen = new Set<string>()
    for (const fileName of this.rootFiles) {
      const key = this.keyOf(fileName)
      if (seen.has(key)) continue
      seen.add(key)
      names.push(this.absolute(fileName))
    }
    for (const document of this.openDocuments.values()) {
      const key = this.keyOf(document.path)
      if (seen.has(key)) continue
      seen.add(key)
      names.push(document.path)
    }
    return names
  }

  /** 构造 LanguageServiceHost；只有 getScriptVersion/getScriptSnapshot 知道「内存正文优先」。 */
  private createHost(ts: TsModule): TsLanguageServiceHost {
    const host: TsLanguageServiceHost = {
      getScriptFileNames: () => this.scriptFileNames(),
      getScriptVersion: fileName => this.scriptVersion(fileName),
      getScriptSnapshot: fileName => {
        const open = this.openDocuments.get(this.keyOf(fileName))
        if (open !== undefined) return ts.ScriptSnapshot.fromString(open.content)
        const text = ts.sys.readFile(this.absolute(fileName))
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
      },
      getCompilationSettings: () => this.settings,
      getCurrentDirectory: () => this.workspace,
      getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
      getNewLine: () => ts.sys.newLine,
      getScriptKind: fileName => {
        const open = this.openDocuments.get(this.keyOf(fileName))
        switch (open?.languageId) {
          case 'typescriptreact': return ts.ScriptKind.TSX
          case 'javascriptreact': return ts.ScriptKind.JSX
          // Unknown 是 0（假值），TS 会回落到按扩展名判断；对没打开的磁盘文件正是我们要的行为。
          default: return ts.ScriptKind.Unknown
        }
      },
      // 工作区外的 node_modules 类型解析、lib.d.ts 读取都靠 ts.sys：语言服务自己保证只解析它需要的文件。
      fileExists: fileName => ts.sys.fileExists(this.absolute(fileName)),
      readFile: (fileName, encoding) => ts.sys.readFile(this.absolute(fileName), encoding),
      readDirectory: (path, extensions, exclude, include, depth) => ts.sys.readDirectory(this.absolute(path), extensions, exclude, include, depth),
      directoryExists: path => ts.sys.directoryExists(this.absolute(path)),
      getDirectories: path => ts.sys.getDirectories(this.absolute(path)),
      realpath: path => ts.sys.realpath?.(this.absolute(path)) ?? this.absolute(path),
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    }
    return host
  }

  /**
   * 文件版本：打开文档用客户端版本（内容在内存里）；磁盘文件用 mtime+size。
   *
   * 磁盘版本带短缓存：TypeScript 每次同步都会对程序内每个文件调一次 getScriptVersion，6000 个文件逐次
   * stat 会让每次请求都慢一截。缓存意味着磁盘改动最迟在缓存过期后可见（默认 2 秒）；客户端打开的文档
   * 不受影响，改正文后版本立刻变。
   */
  private scriptVersion(fileName: string): string {
    const key = this.keyOf(fileName)
    const open = this.openDocuments.get(key)
    if (open !== undefined) return String(open.version)
    const now = Date.now()
    const cached = this.diskVersions.get(key)
    if (cached !== undefined && now - cached.at < this.diskVersionCacheMs) return cached.version
    let version = '0'
    try {
      const info = statSync(this.absolute(fileName))
      version = `${Math.floor(info.mtimeMs)}:${info.size}`
    } catch {
      version = '0'
    }
    this.diskVersions.set(key, { version, at: now })
    return version
  }

  /* ───────────────────────────── 公开能力 ───────────────────────────── */

  async diagnostics(path: string): Promise<readonly LanguageDiagnostic[]> {
    return this.runWithService<readonly LanguageDiagnostic[]>([], (ts, service) => {
      const fileName = this.absolute(path)
      const computed = this.computeDiagnostics(ts, service, fileName)
      // provider.ts 的约定：内置服务在诊断计算完成后主动推送；命中缓存时不重复推。
      if (computed.fresh) {
        try {
          this.options.onDiagnostics(fileName, computed.diagnostics)
        } catch (error) {
          this.warn(`诊断推送回调失败：${messageOf(error)}`)
        }
      }
      return computed.diagnostics
    })
  }

  async hover(path: string, position: LanguagePosition, signal?: AbortSignal): Promise<LanguageHover | null> {
    return this.runWithService<LanguageHover | null>(null, (ts, service) => {
      if (isAborted(signal)) return null
      const fileName = this.absolute(path)
      const info = service.getQuickInfoAtPosition(fileName, this.offsetIn(fileName, position))
      if (info === undefined) return null
      const signature = displayPartsText(info.displayParts)
      const documentation = displayPartsText(info.documentation).trim()
      const tags = (info.tags ?? [])
        .map(tag => `@${tag.name}${tag.text === undefined ? '' : ` ${displayPartsText(tag.text)}`}`)
        .join('\n')
      if (signature === '' && documentation === '' && tags === '') return null
      const sections = [`\`\`\`typescript\n${signature}\n\`\`\``]
      if (documentation !== '') sections.push(documentation)
      if (tags !== '') sections.push(tags)
      const range = this.rangeOf(fileName, info.textSpan)
      return { contents: sections.join('\n\n'), ...(range === undefined ? {} : { range }) }
    })
  }

  async definition(path: string, position: LanguagePosition, signal?: AbortSignal): Promise<readonly LanguageLocation[]> {
    return this.runWithService<readonly LanguageLocation[]>([], (_ts, service) => {
      if (isAborted(signal)) return []
      const fileName = this.absolute(path)
      const definitions = service.getDefinitionAtPosition(fileName, this.offsetIn(fileName, position)) ?? []
      return definitions.map(definition => this.locationOf(definition.fileName, definition.textSpan)).filter((location): location is LanguageLocation => location !== undefined)
    })
  }

  async references(path: string, position: LanguagePosition, signal?: AbortSignal): Promise<readonly LanguageLocation[]> {
    return this.runWithService<readonly LanguageLocation[]>([], (_ts, service) => {
      if (isAborted(signal)) return []
      const fileName = this.absolute(path)
      const entries = service.getReferencesAtPosition(fileName, this.offsetIn(fileName, position)) ?? []
      // 同一文件内按偏移排序；跨文件按路径排序，保证客户端每次拿到稳定的顺序。
      const locations = entries
        .map(entry => this.locationOf(entry.fileName, entry.textSpan))
        .filter((location): location is LanguageLocation => location !== undefined)
        .sort((left, right) => left.path.localeCompare(right.path) || comparePosition(left.range.start, right.range.start))
      const seen = new Set<string>()
      return locations.filter(location => {
        const key = `${location.path}:${location.range.start.line}:${location.range.start.character}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    })
  }

  async rename(path: string, position: LanguagePosition, newName: string, signal?: AbortSignal): Promise<LanguageRenameResult> {
    return this.runWithService<LanguageRenameResult>({ canRename: false, message: '内置 TypeScript 语言服务不可用' }, (_ts, service) => {
      const unavailable: LanguageRenameResult = { canRename: false, message: '内置 TypeScript 语言服务不可用' }
      if (isAborted(signal)) return unavailable
      if (newName.trim() === '') return { canRename: false, message: '新名称不能为空' }
      const fileName = this.absolute(path)
      const offset = this.offsetIn(fileName, position)
      const info = service.getRenameInfo(fileName, offset, {})
      if (!info.canRename) {
        // TS 的 localizedErrorMessage 取决于宿主 locale，不保证中文；这里统一加中文前缀，保证用户看得懂。
        return { canRename: false, message: `无法重命名：${info.localizedErrorMessage}` }
      }
      const locations = service.findRenameLocations(fileName, offset, false, false, {}) ?? []
      if (locations.length === 0) return { canRename: false, message: '此处没有可重命名的引用' }
      const byFile = new Map<string, { path: string; edits: LanguageTextEdit[] }>()
      for (const location of locations) {
        const absolutePath = this.absolute(location.fileName)
        // 只保留真实存在的文件（或客户端打开的内存文档）：TS 偶尔会给出未解析的 .d.ts 映射位置。
        if (!this.fileIsKnown(absolutePath)) continue
        const range = this.rangeOf(location.fileName, location.textSpan)
        if (range === undefined) continue
        const key = this.keyOf(absolutePath)
        const group = byFile.get(key) ?? { path: absolutePath, edits: [] }
        group.edits.push({ range, newText: newName })
        byFile.set(key, group)
      }
      const changes: LanguageFileEdit[] = [...byFile.values()]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map(group => ({
          path: group.path,
          edits: [...group.edits].sort((left, right) => comparePosition(left.range.start, right.range.start)),
        }))
      if (changes.length === 0) return { canRename: false, message: '此处没有可重命名的引用' }
      return { canRename: true, edit: { changes } }
    })
  }

  async documentSymbols(path: string, signal?: AbortSignal): Promise<readonly LanguageDocumentSymbol[]> {
    return this.runWithService<readonly LanguageDocumentSymbol[]>([], (_ts, service) => {
      if (isAborted(signal)) return []
      const fileName = this.absolute(path)
      const tree = service.getNavigationTree(fileName)
      const text = this.textOf(fileName)
      if (text === undefined) return []
      const starts = this.lineStartsFor(fileName, text)
      // 根节点代表文件本身（text 是带引号的文件名），大纲只列它的子项；没有子项就是空文档。
      return (tree.childItems ?? [])
        .map(child => convertNavigationTree(child, starts, text.length))
        .filter((symbol): symbol is LanguageDocumentSymbol => symbol !== undefined)
    })
  }

  async workspaceSymbols(query: string, limit: number, signal?: AbortSignal): Promise<readonly LanguageSymbolInformation[]> {
    return this.runWithService<readonly LanguageSymbolInformation[]>([], (_ts, service) => {
      if (isAborted(signal)) return []
      // 空查询在 TS 里会退化成「子串匹配所有东西」（连 lib.d.ts 的 RegExp 成员都回来），没有检索意义。
      if (query.trim() === '') return []
      const max = Math.max(1, limit)
      // 第 3 个参数是 fileName（不是布尔）；要排除 .d.ts 得用第 4 个参数，这里传 undefined 占位。
      const items = service.getNavigateToItems(query, max, undefined, true)
      const results: LanguageSymbolInformation[] = []
      for (const item of items) {
        const range = this.rangeOf(item.fileName, item.textSpan)
        if (range === undefined) continue
        results.push({
          name: item.name,
          kind: symbolKindOf(item.kind),
          ...(item.containerName === '' ? {} : { containerName: item.containerName }),
          path: this.absolute(item.fileName),
          range,
        })
        if (results.length >= max) break
      }
      return results
    })
  }

  async completion(path: string, position: LanguagePosition, triggerCharacter?: string, signal?: AbortSignal): Promise<LanguageCompletionList | null> {
    return this.runWithService<LanguageCompletionList | null>(null, (ts, service) => {
      if (isAborted(signal)) return null
      const fileName = this.absolute(path)
      const offset = this.offsetIn(fileName, position)
      const info = service.getCompletionsAtPosition(fileName, offset, {
        // snippet 关：Monaco 的插入式补全不做 snippet 展开，带 `${1:}` 的文本会原样插进代码。
        includeCompletionsWithSnippetText: false,
        ...(triggerCharacter === undefined ? {} : { triggerCharacter: triggerCharacter as import('typescript').CompletionsTriggerCharacter }),
      }, this.formatOptions)
      if (info === undefined) return null
      // 不为每个条目调 getCompletionEntryDetails：那会把一次补全变成上千次符号解析，是 tsserver 里
      // 最典型的性能坑。details 让客户端在用户高亮某条时再取（当前协议没有这条往返，先不提供）。
      const items: LanguageCompletionItem[] = info.entries.map(entry => {
        const replacement = entry.replacementSpan === undefined ? undefined : this.rangeOf(fileName, entry.replacementSpan)
        return {
          label: entry.name,
          kind: symbolKindOf(entry.kind),
          sortText: entry.sortText,
          ...(entry.filterText === undefined ? {} : { filterText: entry.filterText }),
          ...(entry.insertText === undefined ? {} : { insertText: entry.insertText }),
          ...(replacement === undefined ? {} : { replaceRange: replacement }),
        }
      })
      return { items }
    })
  }

  async signatureHelp(path: string, position: LanguagePosition, signal?: AbortSignal): Promise<LanguageSignatureHelp | null> {
    return this.runWithService<LanguageSignatureHelp | null>(null, (_ts, service) => {
      if (isAborted(signal)) return null
      const fileName = this.absolute(path)
      const help = service.getSignatureHelpItems(fileName, this.offsetIn(fileName, position), {})
      if (help === undefined || help.items.length === 0) return null
      const signatures: LanguageSignatureInformation[] = help.items.map(item => {
        const parameters = item.parameters.map(parameter => {
          const label = displayPartsText(parameter.displayParts) || parameter.name
          const documentation = displayPartsText(parameter.documentation).trim()
          return { label, ...(documentation === '' ? {} : { documentation }) }
        })
        const prefix = displayPartsText(item.prefixDisplayParts)
        const suffix = displayPartsText(item.suffixDisplayParts)
        const separator = displayPartsText(item.separatorDisplayParts)
        // TS 把签名拆成 prefix/参数/suffix 三段显示片段；协议只要一整行 label，这里按顺序拼回去。
        const label = `${prefix}${parameters.map(parameter => parameter.label).join(separator)}${suffix}`
        const documentation = displayPartsText(item.documentation).trim()
        return {
          label,
          ...(documentation === '' ? {} : { documentation }),
          parameters,
          activeParameter: help.argumentIndex,
        }
      })
      return { signatures, activeSignature: help.selectedItemIndex, activeParameter: help.argumentIndex }
    })
  }

  async codeActions(path: string, range: LanguageRange, diagnostics: readonly LanguageDiagnostic[], signal?: AbortSignal): Promise<readonly LanguageCodeAction[]> {
    return this.runWithService<readonly LanguageCodeAction[]>([], (ts, service) => {
      if (isAborted(signal)) return []
      const fileName = this.absolute(path)
      const text = this.textOf(fileName)
      if (text === undefined) return []
      const starts = computeLineStarts(text)
      const start = offsetAtPosition(text, starts, range.start)
      const end = Math.max(start, offsetAtPosition(text, starts, range.end))
      // 诊断码 → TS 错误码：客户端缓存的是协议里的 `TS2345` 形式，快速修复 API 要的是数字。
      const errorCodes = [...new Set(diagnostics
        .map(diagnostic => diagnostic.code)
        .filter((code): code is string => code !== undefined && /^TS\d+$/.test(code))
        .map(code => Number(code.slice(2))))]
      const actions: LanguageCodeAction[] = []
      const formatOptions = this.formatOptions
      if (formatOptions === undefined) return actions
      if (errorCodes.length > 0) {
        try {
          for (const fix of service.getCodeFixesAtPosition(fileName, start, end, errorCodes, formatOptions, {})) {
            const edit = this.workspaceEditOf(fix.changes)
            actions.push({
              title: fix.description,
              kind: 'quickfix',
              ...(edit === undefined ? {} : { edit }),
            })
          }
        } catch (error) {
          this.warn(`计算快速修复失败：${messageOf(error)}`)
        }
      }
      // 整理导入是「文件级」动作，不依赖诊断码；单独试一次，做不了就不加（返回空数组）。
      try {
        const changes = service.organizeImports({ type: 'file', fileName }, formatOptions, {})
        const edit = this.workspaceEditOf(changes)
        if (edit !== undefined) actions.push({ title: '整理导入', kind: 'source.organizeImports', edit })
      } catch {
        // 文件有语法错误时 organizeImports 会抛；整理导入是附加能力，失败就安静跳过。
      }
      return actions
    })
  }

  /**
   * 工作区全量诊断扫描。
   *
   * 只扫程序内**非声明文件**：lib.*.d.ts 与 node_modules 里的 .d.ts 不是用户代码，把它们的错误报出来
   * 只会淹没真正的问题。每个文件之间让出事件循环（setImmediate），这样扫描期间路由仍能响应、也能被取消。
   */
  async workspaceDiagnostics(onFile: (path: string, diagnostics: readonly LanguageDiagnostic[]) => void, signal?: AbortSignal): Promise<LanguageScanResult> {
    if (this.disposed) return EMPTY_SCAN
    let ready
    try {
      ready = await this.ensureService()
    } catch (error) {
      this.warn(`工作区扫描初始化失败：${messageOf(error)}`)
      return EMPTY_SCAN
    }
    if (ready === undefined) return EMPTY_SCAN
    if (isAborted(signal)) return EMPTY_SCAN
    const { ts, service } = ready
    const program = service.getProgram()
    if (program === undefined) return EMPTY_SCAN
    const files = program.getSourceFiles().filter(sourceFile => !sourceFile.isDeclarationFile)
    let checked = 0
    let errors = 0
    let warnings = 0
    for (const [index, sourceFile] of files.entries()) {
      if (isAborted(signal)) break
      const fileName = this.absolute(sourceFile.fileName)
      const diagnostics = this.computeDiagnostics(ts, service, fileName).diagnostics
      checked++
      const counts = diagnosticCounts(diagnostics)
      errors += counts.errors
      warnings += counts.warnings
      try {
        onFile(fileName, diagnostics)
      } catch (error) {
        this.warn(`工作区扫描回调失败：${messageOf(error)}`)
      }
      // 每处理若干文件让出一次事件循环：单个大文件的语义检查本身无法中断，但文件之间可以。
      if (index % 8 === 7) await new Promise<void>(resolveYield => setImmediate(resolveYield))
    }
    return { checked, errors, warnings }
  }

  /**
   * 只读文件读取：仅限语言服务程序里的文件（含 lib.*.d.ts 与 node_modules 声明文件）。
   *
   * 客户端要显示「跳转目标」的源码，但工作台的文件 API 只能读工作区内的路径；由这里判断「这个路径确实
   * 是 TS 解析过的文件」再给内容，等于把访问面收敛到语言服务自己的程序，而不是任意路径都能读。
   */
  async readFile(path: string): Promise<string | undefined> {
    return this.runWithService<string | undefined>(undefined, (_ts, service) => {
      const program = service.getProgram()
      if (program === undefined) return undefined
      const key = this.keyOf(path)
      const absolutePath = this.absolute(path)
      const sourceFile = program.getSourceFile(absolutePath)
        ?? program.getSourceFiles().find(candidate => this.keyOf(candidate.fileName) === key)
      if (sourceFile === undefined) return undefined
      // 超大文件不返回：一份 10 MiB 的生成产物会把客户端编辑器拖死，而它本来也不是要读的源码。
      if (sourceFile.text.length > MAX_READ_FILE_CHARS) return undefined
      return sourceFile.text
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try {
      this.service?.dispose()
    } catch {
      // dispose 失败没有补救手段，也不该让调用方（管理器）受影响。
    }
    this.service = undefined
    this.ts = undefined
    this.initPromise = undefined
    this.formatOptions = undefined
    this.settings = {}
    this.openDocuments.clear()
    this.diskVersions.clear()
    this.diagnosticsCache.clear()
    this.lineCache.clear()
    this.rootFiles = []
  }

  /* ───────────────────────────── 内部实现 ───────────────────────────── */

  /** 统一的「初始化 + 异常兜底」外壳：任何失败都返回 fallback，绝不把 TS 异常抛给路由层。 */
  private async runWithService<T>(fallback: T, action: (ts: TsModule, service: TsService) => T): Promise<T> {
    if (this.disposed) return fallback
    try {
      const ready = await this.ensureService()
      if (ready === undefined || this.disposed) return fallback
      return action(ready.ts, ready.service)
    } catch (error) {
      this.warn(`请求失败：${messageOf(error)}`)
      return fallback
    }
  }

  /**
   * 计算一个文件的诊断（语法 + 语义 + 建议），并按「文件版本 + 程序实例」缓存。
   *
   * 只按文件版本缓存是不够的：A 文件的语义诊断会随 B 文件改动而变。程序实例在任一根文件版本变化时
   * 会被 TypeScript 重建，所以把 `program` 引用一起放进缓存键，跨文件失效也能覆盖。
   * `fresh` 表示这次是否真的计算过（诊断推送只在真计算时发一次）。
   */
  private computeDiagnostics(ts: TsModule, service: TsService, fileName: string): { diagnostics: readonly LanguageDiagnostic[]; fresh: boolean } {
    const program = service.getProgram()
    const key = this.keyOf(fileName)
    const version = this.scriptVersion(fileName)
    const cached = this.diagnosticsCache.get(key)
    if (program !== undefined && cached !== undefined && cached.program === program && cached.version === version) {
      return { diagnostics: cached.diagnostics, fresh: false }
    }
    const diagnostics = this.collectDiagnostics(ts, service, fileName)
    if (program !== undefined) this.diagnosticsCache.set(key, { program, version, diagnostics })
    return { diagnostics, fresh: true }
  }

  private collectDiagnostics(ts: TsModule, service: TsService, fileName: string): readonly LanguageDiagnostic[] {
    const raw: TsDiagnostic[] = []
    try {
      raw.push(...service.getSyntacticDiagnostics(fileName))
      raw.push(...service.getSemanticDiagnostics(fileName))
      raw.push(...service.getSuggestionDiagnostics(fileName))
    } catch (error) {
      this.warn(`计算 ${fileName} 的诊断失败：${messageOf(error)}`)
      return []
    }
    const result: LanguageDiagnostic[] = []
    for (const diagnostic of raw) {
      // 全局诊断（配置错误等）没有文件位置；它们不属于「这个文件的诊断」，由管理器/日志另外处理。
      const diagnosticFile = diagnostic.file
      if (diagnosticFile === undefined || diagnostic.start === undefined) continue
      const text = diagnosticFile.text
      const starts = computeLineStarts(text)
      const related = this.relatedInformationOf(ts, diagnostic)
      const tags = tagsOf(diagnostic)
      result.push({
        range: spanRange(starts, text.length, { start: diagnostic.start, length: diagnostic.length ?? 0 }),
        severity: severityOf(diagnostic.category),
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
        code: `TS${diagnostic.code}`,
        source: 'ts',
        ...(tags === undefined ? {} : { tags }),
        ...(related.length === 0 ? {} : { related }),
      })
    }
    // 稳定顺序：先按位置，再按严重级别 —— 问题面板和测试都依赖可重复的排列。
    return result.sort((left, right) => comparePosition(left.range.start, right.range.start) || severityRank(left.severity) - severityRank(right.severity))
  }

  private relatedInformationOf(ts: TsModule, diagnostic: TsDiagnostic): LanguageRelatedInformation[] {
    const related: LanguageRelatedInformation[] = []
    for (const information of diagnostic.relatedInformation ?? []) {
      const file = information.file
      if (file === undefined || information.start === undefined) continue
      const starts = computeLineStarts(file.text)
      related.push({
        path: this.absolute(file.fileName),
        range: spanRange(starts, file.text.length, { start: information.start, length: information.length ?? 0 }),
        message: ts.flattenDiagnosticMessageText(information.messageText, ' '),
      })
    }
    return related
  }

  /** 把 TS 的「文件名 + TextSpan」转成协议位置；文件内容取不到时返回 undefined（调用方过滤掉）。 */
  private locationOf(fileName: string, span: TsTextSpan): LanguageLocation | undefined {
    const range = this.rangeOf(fileName, span)
    return range === undefined ? undefined : { path: this.absolute(fileName), range }
  }

  /** TextSpan → 0 基范围；内容来自内存正文、程序快照或磁盘。 */
  private rangeOf(fileName: string, span: TsTextSpan): LanguageRange | undefined {
    const text = this.textOf(fileName)
    if (text === undefined) return undefined
    return spanRange(this.lineStartsFor(fileName, text), text.length, span)
  }

  private lineStartsFor(fileName: string, text: string): readonly number[] {
    const key = this.keyOf(fileName)
    const cached = this.lineCache.get(key)
    if (cached !== undefined && cached.text === text) return cached.starts
    const starts = computeLineStarts(text)
    if (this.lineCache.size >= MAX_LINE_CACHE_ENTRIES) this.lineCache.clear()
    this.lineCache.set(key, { text, starts })
    return starts
  }

  /** 取文件内容：内存正文优先，其次是程序里的 SourceFile 快照，最后才读磁盘。 */
  private textOf(fileName: string): string | undefined {
    const key = this.keyOf(fileName)
    const open = this.openDocuments.get(key)
    if (open !== undefined) return open.content
    const program = this.service?.getProgram()
    if (program !== undefined) {
      const sourceFile = program.getSourceFile(this.absolute(fileName))
        ?? program.getSourceFiles().find(candidate => this.keyOf(candidate.fileName) === key)
      if (sourceFile !== undefined) return sourceFile.text
    }
    try {
      return readFileSync(this.absolute(fileName), 'utf8')
    } catch {
      return undefined
    }
  }

  /** 行列 → 偏移；位置超出文件时夹到末尾，不让越界输入把 TS 的 API 弄崩。 */
  private offsetIn(fileName: string, position: LanguagePosition): number {
    const text = this.textOf(fileName) ?? ''
    return offsetAtPosition(text, this.lineStartsFor(fileName, text), position)
  }

  /** 文件是否存在于磁盘，或者是客户端打开的内存文档（rename/编辑只认这两类文件）。 */
  private fileIsKnown(fileName: string): boolean {
    if (this.openDocuments.has(this.keyOf(fileName))) return true
    try {
      return statSync(fileName).isFile()
    } catch {
      return false
    }
  }

  /** FileTextChanges[] → 协议工作区编辑；过滤掉没有任何文本替换的文件。 */
  private workspaceEditOf(changes: readonly import('typescript').FileTextChanges[]): LanguageWorkspaceEdit | undefined {
    const files: LanguageFileEdit[] = []
    for (const change of changes) {
      const edits: LanguageTextEdit[] = []
      for (const textChange of change.textChanges) {
        const range = this.rangeOf(change.fileName, textChange.span)
        if (range === undefined) continue
        edits.push({ range, newText: textChange.newText })
      }
      if (edits.length === 0) continue
      files.push({ path: this.absolute(change.fileName), edits })
    }
    return files.length === 0 ? undefined : { changes: files }
  }

  /** 规范化成绝对路径（本机分隔符）。 */
  private absolute(fileName: string): string {
    return isAbsolute(fileName) ? resolve(fileName) : resolve(this.workspace, fileName)
  }

  /** Map 键：绝对路径，大小写不敏感平台统一小写。 */
  private keyOf(fileName: string): string {
    const absolutePath = this.absolute(fileName)
    return this.caseSensitive ? absolutePath : absolutePath.toLowerCase()
  }

  private warn(message: string): void {
    try {
      this.options.onLog?.('warn', `[typescript] ${message}`)
    } catch {
      // 日志回调自身失败不应影响语言服务。
    }
  }
}

/** 用默认参数创建内置 TypeScript provider（管理器只依赖这个工厂与 LanguageProvider 接口）。 */
export function createTypeScriptProvider(options: LanguageProviderOptions): LanguageProvider {
  return new TypeScriptLanguageProvider(options)
}

/** NavigationTree → 文档符号（递归）。`starts`/`textLength` 是同一文件的行首表与长度。 */
function convertNavigationTree(node: import('typescript').NavigationTree, starts: readonly number[], textLength: number): LanguageDocumentSymbol | undefined {
  const fullSpan = node.spans[0]
  if (fullSpan === undefined) return undefined
  // 没有名字的节点（例如匿名块）在大纲里没有意义；有名字才能跳转。
  if (node.text === '') return undefined
  const nameSpan = node.nameSpan ?? fullSpan
  const range = spanRange(starts, textLength, fullSpan)
  const selectionRange = spanRange(starts, textLength, nameSpan)
  const children = (node.childItems ?? [])
    .map(child => convertNavigationTree(child, starts, textLength))
    .filter((child): child is LanguageDocumentSymbol => child !== undefined)
  return {
    name: node.text,
    ...(node.kindModifiers === '' ? {} : { detail: node.kindModifiers }),
    kind: symbolKindOf(node.kind),
    range,
    selectionRange,
    ...(children.length === 0 ? {} : { children }),
  }
}

/** 位置的字典序比较（行优先）。 */
function comparePosition(left: LanguagePosition, right: LanguagePosition): number {
  return left.line !== right.line ? left.line - right.line : left.character - right.character
}
