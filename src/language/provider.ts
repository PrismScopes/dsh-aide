/**
 * 宿主侧语言提供方（provider）的统一接口。
 *
 * 两种实现：
 *   - 内置 TypeScript 语言服务（`typescript.ts`）：进程内，直接调 TypeScript 编译器 API；
 *   - 外部 LSP 服务器（`external.ts`）：按 LSP 协议通过 stdio 通信。
 *
 * LanguageManager 只面向这个接口，因此「诊断怎么来、跳转怎么算」不会泄漏到路由层。
 * 每个方法收 `LanguageDocument`（绝对路径 + 客户端正文 + 版本），宿主对同一文档的调用顺序与
 * 客户端推送顺序一致；可选方法缺失表示该服务不支持这项能力。
 */
import type {
  LanguageCodeAction,
  LanguageCompletionList,
  LanguageDiagnostic,
  LanguageDocument,
  LanguageDocumentSymbol,
  LanguageHover,
  LanguageLocation,
  LanguagePosition,
  LanguageRange,
  LanguageRenameResult,
  LanguageSignatureHelp,
  LanguageSymbolInformation,
  LanguageWorkspaceEdit,
} from './protocol.ts'

/** provider 的静态描述（状态栏、设置页、语言注册都用它）。 */
export interface LanguageProviderInfo {
  id: string
  name: string
  /** 负责的 Monaco 语言 id。 */
  languages: readonly string[]
  /** 内置服务用 `builtin`，外部 LSP 服务器用 `external`。 */
  kind: 'builtin' | 'external'
  /** 内置语言服务可给出实现版本（TypeScript 版本），外部服务器可给出 serverInfo.version。 */
  version?: string
}

/** 工作区诊断扫描的结果。 */
export interface LanguageScanResult {
  checked: number
  errors: number
  warnings: number
  /** 扫描无法完成时的可读原因（例如 worker 内存上限）；正常完成时没有。 */
  error?: string
}

/** provider 把诊断推给管理器的回调；path 为绝对路径。 */
export type LanguageDiagnosticsSink = (path: string, diagnostics: readonly LanguageDiagnostic[]) => void

export interface LanguageProviderOptions {
  /** 工作区根目录（绝对路径）。 */
  workspace: string
  /** 诊断推送；外部 LSP 服务器收到 publishDiagnostics 时调用，内置服务在诊断计算完成后调用。 */
  onDiagnostics: LanguageDiagnosticsSink
  /** 需要让用户看到的运行日志（服务器启动失败、协议错误等）。 */
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
  /** provider 自身状态变化（启动/失败）；管理器据此刷新状态栏。 */
  onStateChange?: () => void
}

export interface LanguageProvider {
  readonly info: LanguageProviderInfo

  /** 打开文档（客户端第一次推送）。实现方应保证重复调用是幂等的。 */
  openDocument(document: LanguageDocument): void
  /** 修改文档。 */
  changeDocument(document: LanguageDocument): void
  /** 关闭文档：停止为该文件推送诊断，但已发布的诊断由管理器决定是否保留。 */
  closeDocument(path: string): void

  /** 主动计算一份文档的诊断（内置 TS 服务用）；外部服务器走推送，不实现这个方法。 */
  diagnostics?(path: string): Promise<readonly LanguageDiagnostic[]>

  hover?(path: string, position: LanguagePosition, signal?: AbortSignal): Promise<LanguageHover | null>
  definition?(path: string, position: LanguagePosition, signal?: AbortSignal): Promise<readonly LanguageLocation[]>
  references?(path: string, position: LanguagePosition, signal?: AbortSignal): Promise<readonly LanguageLocation[]>
  rename?(path: string, position: LanguagePosition, newName: string, signal?: AbortSignal): Promise<LanguageRenameResult>
  documentSymbols?(path: string, signal?: AbortSignal): Promise<readonly LanguageDocumentSymbol[]>
  workspaceSymbols?(query: string, limit: number, signal?: AbortSignal): Promise<readonly LanguageSymbolInformation[]>
  completion?(path: string, position: LanguagePosition, triggerCharacter?: string, signal?: AbortSignal): Promise<LanguageCompletionList | null>
  signatureHelp?(path: string, position: LanguagePosition, signal?: AbortSignal): Promise<LanguageSignatureHelp | null>
  /** 范围参数是 0 基坐标；诊断由管理器按该范围筛好后传入（快速修复要靠错误码）。 */
  codeActions?(path: string, range: LanguageRange, diagnostics: readonly LanguageDiagnostic[], signal?: AbortSignal): Promise<readonly LanguageCodeAction[]>

  /** 工作区级诊断扫描：只为内置服务提供。`onFile` 每算完一个文件回调一次；`onTotal` 给出总数。 */
  workspaceDiagnostics?(onFile: (path: string, diagnostics: readonly LanguageDiagnostic[]) => void, signal?: AbortSignal, onTotal?: (total: number) => void): Promise<LanguageScanResult>

  /**
   * 读取语言服务「知道」的只读文件内容。
   *
   * 跳转会落到工作区之外的文件（TypeScript 的 lib.*.d.ts、node_modules 里的声明文件），
   * 工作台的文件 API 按工作区根校验路径，读不了这些文件；由 provider 判定「这个文件确实属于
   * 我的程序」之后再读，安全性由语言服务自身保证。
   */
  readFile?(path: string): Promise<string | undefined>

  /** 由客户端编辑器应用还是宿主写盘，取决于文件是否已打开；宿主的写盘入口是 `applyEdits`。 */
  applyEdits?(edit: LanguageWorkspaceEdit): Promise<readonly string[]>

  dispose(): void | Promise<void>
}
