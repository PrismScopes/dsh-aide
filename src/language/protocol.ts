/**
 * AIDE 语言服务的公共协议。
 *
 * 宿主侧（内置 TypeScript 语言服务、外部 LSP 服务器）与客户端（Monaco 适配层、问题面板）共用这一份
 * 纯类型定义：它不 import 任何 Node 或 Monaco 模块，因此可以被宿主 bundle 与浏览器 bundle 同时引用，
 * 两边对「位置、范围、诊断、编辑」的理解不会漂移。
 *
 * 坐标约定与 LSP 一致：行、列都从 0 开始；列按 UTF-16 码元计。Monaco 的 1 基行列只在
 * `src/client/language/monaco.ts` 的适配函数里转换，其余地方一律用这里的位置类型。
 */

/** 文档位置（0 基）。 */
export interface LanguagePosition { line: number; character: number }
/** 半开区间 `[start, end)`。 */
export interface LanguageRange { start: LanguagePosition; end: LanguagePosition }

/** 诊断严重级别。顺序即展示优先级：error > warning > info > hint。 */
export type LanguageSeverity = 'error' | 'warning' | 'info' | 'hint'

/** 一条诊断。`related` 是「相关位置」（例如类型不匹配时的另一处声明）。 */
export interface LanguageDiagnostic {
  range: LanguageRange
  severity: LanguageSeverity
  message: string
  /** 错误码，例如 TS2345 或 pyright 的 reportArgumentType。 */
  code?: string
  /** 产生者：`ts`、外部服务器 id。 */
  source?: string
  /** 未使用/已弃用这类弱提示，客户端据此把对应文字画淡。 */
  tags?: readonly ('unnecessary' | 'deprecated')[]
  related?: readonly LanguageRelatedInformation[]
}

export interface LanguageRelatedInformation {
  /** 绝对路径。 */
  path: string
  range: LanguageRange
  message: string
}

/** 一个可跳转的位置（绝对路径 + 范围）。 */
export interface LanguageLocation { path: string; range: LanguageRange }
/** 悬停内容：markdown 文本 + 可选高亮范围。 */
export interface LanguageHover { contents: string; range?: LanguageRange }
/** 一次文本替换；范围是该文件内 0 基坐标。 */
export interface LanguageTextEdit { range: LanguageRange; newText: string }
/** 跨文件编辑：每个文件一组替换。 */
export interface LanguageWorkspaceEdit { changes: readonly LanguageFileEdit[] }
export interface LanguageFileEdit { path: string; edits: readonly LanguageTextEdit[] }

/** 符号种类。命名沿用 LSP SymbolKind，但用字符串而不是数字，避免两端各维护一张数字表。 */
export type LanguageSymbolKind =
  | 'file' | 'module' | 'namespace' | 'package' | 'class' | 'method' | 'property' | 'field'
  | 'constructor' | 'enum' | 'interface' | 'function' | 'variable' | 'constant' | 'string'
  | 'number' | 'boolean' | 'array' | 'object' | 'key' | 'null' | 'enumMember' | 'struct'
  | 'event' | 'operator' | 'typeParameter'

/** 文档大纲里的一项（层级结构）。 */
export interface LanguageDocumentSymbol {
  name: string
  detail?: string
  kind: LanguageSymbolKind
  /** 整个符号的范围（含函数体）。 */
  range: LanguageRange
  /** 名字本身的范围（跳转落点）。 */
  selectionRange: LanguageRange
  children?: readonly LanguageDocumentSymbol[]
}

/** 工作区符号搜索结果（扁平列表）。 */
export interface LanguageSymbolInformation {
  name: string
  kind: LanguageSymbolKind
  /** 所在容器（类名、模块名），没有则缺省。 */
  containerName?: string
  /** 绝对路径。 */
  path: string
  range: LanguageRange
}

export interface LanguageCompletionItem {
  label: string
  detail?: string
  documentation?: string
  kind?: LanguageSymbolKind
  insertText?: string
  /** 不为空时替换这个范围，而不是按 Monaco 自己的词边界替换。 */
  replaceRange?: LanguageRange
  sortText?: string
  filterText?: string
  /** 插入后需要一并应用的编辑（例如自动 import）。 */
  additionalEdits?: readonly LanguageTextEdit[]
}

export interface LanguageCompletionList { items: readonly LanguageCompletionItem[]; incomplete?: boolean }

export interface LanguageParameterInformation { label: string; documentation?: string }
export interface LanguageSignatureInformation {
  label: string
  documentation?: string
  parameters: readonly LanguageParameterInformation[]
  activeParameter?: number
}
export interface LanguageSignatureHelp {
  signatures: readonly LanguageSignatureInformation[]
  activeSignature?: number
  activeParameter?: number
}

/** 快速修复/重构动作。`edit` 缺省时表示当前不支持应用（例如只有命令的动作会被丢弃）。 */
export interface LanguageCodeAction {
  title: string
  kind?: string
  isPreferred?: boolean
  edit?: LanguageWorkspaceEdit
}

/** 重命名结果：不能重命名时 `message` 给出原因（原样展示给用户）。 */
export interface LanguageRenameResult {
  canRename: boolean
  message?: string
  edit?: LanguageWorkspaceEdit
}

/** 文档同步载荷：客户端把编辑中的正文推给宿主。 */
export interface LanguageDocument {
  /** 绝对路径。 */
  path: string
  /** Monaco 的语言 id（typescript / javascript / python …）。 */
  languageId: string
  /** 单调递增的版本号；宿主按它丢弃乱序请求。 */
  version: number
  content: string
}

export type LanguageSyncKind = 'open' | 'change' | 'close'

/**
 * 语言服务器运行状态。
 * builtin 表示语言服务跑在宿主进程内；idle 表示已发现可执行文件但还没启动（按需启动）；
 * missing 表示没找到可执行文件；failed 表示启动或握手失败。
 */
export type LanguageServerState = 'builtin' | 'idle' | 'starting' | 'running' | 'failed' | 'missing' | 'disabled'

export interface LanguageServerInfo {
  /** 稳定 id：内置是 `builtin-typescript`，外部是服务器定义 id。 */
  id: string
  name: string
  /** 该服务器负责的 Monaco 语言 id。 */
  languages: readonly string[]
  state: LanguageServerState
  /** 出错/未安装时的可读说明。 */
  detail?: string
  /** 实际启动命令（排查用）。 */
  command?: string
}

export interface LanguageBuiltinInfo {
  enabled: boolean
  /** 内置 TypeScript 版本（首次加载后才有）。 */
  version?: string
  state: 'ready' | 'loading' | 'disabled' | 'failed'
  detail?: string
}

/** 工作区诊断扫描的进度。 */
export interface LanguageScanState {
  running: boolean
  checked: number
  total: number
  errors: number
  warnings: number
  /** 扫描失败/被资源上限终止时的可读原因。 */
  error?: string
}

/** 客户端打开工作台/文件时向宿主拉取的总体信息。 */
export interface LanguageInfo {
  enabled: boolean
  builtin: LanguageBuiltinInfo
  servers: readonly LanguageServerInfo[]
  /** 应当注册语言特性的 Monaco 语言 id 并集。 */
  languages: readonly string[]
  scan?: LanguageScanState
}

/** 宿主动推送的消息（WebSocket）。 */
export type LanguagePushMessage =
  | { type: 'diagnostics'; path: string; version?: number; diagnostics: readonly LanguageDiagnostic[] }
  | { type: 'status'; servers: readonly LanguageServerInfo[]; builtin: LanguageBuiltinInfo; scan?: LanguageScanState }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }

/** 设置页可改的语言服务开关；落盘在 %DSH_HOME%/language.settings.json。 */
export interface LanguageSettingsView {
  enabled: boolean
  builtinTypescript: boolean
  /** 设置文件路径（数据目录未知时缺省）。 */
  file?: string
  /** 环境变量给出的覆盖（非空时优先级最高）。 */
  env?: { enabled?: string; builtinTypescript?: string; servers?: string }
  /** 已发现的服务器（不依赖工作区）。 */
  servers: readonly LanguageServerInfo[]
}

/* ────────────────────────────── 纯函数 ────────────────────────────── */

/** 扩展名 → Monaco 语言 id。只列 AIDE 需要区分的语言；没有映射的返回 undefined。 */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  json: 'json', jsonc: 'json',
  py: 'python', pyi: 'python', rs: 'rust', go: 'go',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  yaml: 'yaml', yml: 'yaml',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  lua: 'lua', php: 'php', rb: 'ruby', java: 'java', kt: 'kotlin',
  cs: 'csharp', swift: 'swift', sql: 'sql',
}

/** 文件名 → 语言 id（Makefile、Dockerfile 这类没有扩展名但有固定名字的文件）。 */
const LANGUAGE_BY_NAME: Readonly<Record<string, string>> = {
  dockerfile: 'dockerfile', makefile: 'makefile',
}

/** 取路径的语言 id；大小写不敏感，取最后一段扩展名。 */
export function languageIdForPath(path: string): string | undefined {
  const name = path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? ''
  const byName = LANGUAGE_BY_NAME[name]
  if (byName !== undefined) return byName
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1)]
}

/** 是否属于内置 TypeScript 服务负责的语言。 */
export function isTypeScriptLanguage(languageId: string): boolean {
  return languageId === 'typescript' || languageId === 'javascript' || languageId === 'javascriptreact' || languageId === 'typescriptreact'
}

/** 统计一组诊断的严重级别数量。 */
export function diagnosticCounts(diagnostics: readonly LanguageDiagnostic[]): { errors: number; warnings: number; infos: number; hints: number } {
  let errors = 0, warnings = 0, infos = 0, hints = 0
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'error') errors++
    else if (diagnostic.severity === 'warning') warnings++
    else if (diagnostic.severity === 'info') infos++
    else hints++
  }
  return { errors, warnings, infos, hints }
}

/** 诊断严重级别排序权重（越小越靠前）。 */
export function severityRank(severity: LanguageSeverity): number {
  switch (severity) {
    case 'error': return 0
    case 'warning': return 1
    case 'info': return 2
    case 'hint': return 3
  }
}

/** 位置/范围的比较与包含判断：问题面板排序、重命名范围校验都要用。 */
export function comparePositions(left: LanguagePosition, right: LanguagePosition): number {
  return left.line !== right.line ? left.line - right.line : left.character - right.character
}

export function positionInRange(position: LanguagePosition, range: LanguageRange): boolean {
  return comparePositions(range.start, position) <= 0 && comparePositions(position, range.end) < 0
}

export function rangeOverlaps(left: LanguageRange, right: LanguageRange): boolean {
  return comparePositions(left.start, right.end) < 0 && comparePositions(right.start, left.end) < 0
}

/** 位置转成「可读的行列」文案（1 基，给问题面板与工具提示用）。 */
export function displayPosition(position: LanguagePosition): string {
  return `${position.line + 1}:${position.character + 1}`
}

/** 清空语言服务状态时用的固定标识，避免客户端各处重复拼字符串。 */
export const BUILTIN_TYPESCRIPT_ID = 'builtin-typescript'
