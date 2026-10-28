/**
 * 工作区诊断的「一次程序、一次检查」实现。
 *
 * 旧实现逐文件调用 `languageService.getSemanticDiagnostics(file)`：每一文件都会让 TypeScript 重新
 * 走一遍程序级检查，187 个文件的仓库实测 **69 秒**，而且宿主单线程被逐个文件占满。改为
 * `program.getSemanticDiagnostics()` 一次性检查整个程序，同一仓库约 **3 秒**；再在 worker 里跑，
 * 宿主事件循环完全不被占用。
 *
 * 这里只依赖传入的 `typescript` 模块，不 import 运行时 typescript；worker 和宿主回退路径共用。
 */
import type { LanguageDiagnostic, LanguagePosition, LanguageRange, LanguageRelatedInformation } from './protocol.ts'
import type { LanguageScanResult } from './provider.ts'
import { resolve } from 'node:path'

type TsModule = typeof import('typescript')
type TsProgram = import('typescript').Program
type TsSourceFile = import('typescript').SourceFile
type TsDiagnostic = import('typescript').Diagnostic
type TsCompilerOptions = import('typescript').CompilerOptions

export interface ScanOpenDocument { path: string; languageId: string; version: number; content: string }

export interface ScanOptions {
  workspace: string
  rootFiles: readonly string[]
  compilerOptions: TsCompilerOptions
  openDocuments: readonly ScanOpenDocument[]
}

export interface ScanFileResult { path: string; diagnostics: readonly LanguageDiagnostic[] }

export type ScanFileCallback = (path: string, diagnostics: readonly LanguageDiagnostic[]) => void

const EMPTY_SCAN: LanguageScanResult = { checked: 0, errors: 0, warnings: 0 }

/** Windows / macOS 文件系统大小写不敏感；同时把 TS 的 `/` 路径与 Node 的 `\` 路径归一。 */
function keyOf(ts: TsModule, path: string): string {
  const normalized = resolve(path)
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase()
}

/**
 * 扫描整个程序。诊断一次性算完后按文件分组回调；单个文件回调之间让出事件循环，方便回退路径
 * （非 worker）仍能响应取消，并让进度消息有机会被发出。
 */
export async function scanProject(
  ts: TsModule,
  options: ScanOptions,
  onFile: ScanFileCallback,
  signal?: AbortSignal,
  onTotal?: (total: number) => void,
): Promise<LanguageScanResult> {
  if (isAborted(signal)) return EMPTY_SCAN
  const openDocuments = new Map(options.openDocuments.map(document => [keyOf(ts, document.path), document]))
  const fileNames = [...new Set([...options.rootFiles, ...options.openDocuments.map(document => document.path)])]
  if (fileNames.length === 0) return EMPTY_SCAN

  const host: import('typescript').CompilerHost = {
    getSourceFile: (fileName, languageVersion) => {
      const open = openDocuments.get(keyOf(ts, fileName))
      const text = open?.content ?? ts.sys.readFile(fileName)
      return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion, true)
    },
    getDefaultLibFileName: compilerOptions => ts.getDefaultLibFilePath(compilerOptions),
    writeFile: () => {},
    getCurrentDirectory: () => options.workspace,
    getCanonicalFileName: fileName => ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase(),
    getDirectories: path => ts.sys.getDirectories(path),
    fileExists: fileName => ts.sys.fileExists(fileName),
    readFile: fileName => ts.sys.readFile(fileName),
    readDirectory: (path, extensions, exclude, include, depth) => ts.sys.readDirectory(path, extensions, exclude, include, depth),
    ...(ts.sys.realpath === undefined ? {} : { realpath: (path: string) => ts.sys.realpath?.(path) ?? path }),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts.sys.newLine,
  }

  let program: TsProgram
  try {
    program = ts.createProgram({ rootNames: fileNames, options: options.compilerOptions, host })
  } catch {
    return EMPTY_SCAN
  }
  if (isAborted(signal)) return EMPTY_SCAN

  const sourceFiles = program.getSourceFiles().filter(sourceFile => !sourceFile.isDeclarationFile)
  onTotal?.(sourceFiles.length)
  if (sourceFiles.length === 0) return EMPTY_SCAN

  let raw: readonly TsDiagnostic[]
  try {
    raw = [
      ...program.getSyntacticDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ]
  } catch {
    return EMPTY_SCAN
  }
  if (isAborted(signal)) return EMPTY_SCAN

  const byFile = new Map<string, TsDiagnostic[]>()
  for (const diagnostic of raw) {
    const file = diagnostic.file
    if (file === undefined || diagnostic.start === undefined) continue
    const key = keyOf(ts, file.fileName)
    const bucket = byFile.get(key)
    if (bucket === undefined) byFile.set(key, [diagnostic])
    else bucket.push(diagnostic)
  }

  let checked = 0
  let errors = 0
  let warnings = 0
  for (const [index, sourceFile] of sourceFiles.entries()) {
    if (isAborted(signal)) break
    const path = sourceFile.fileName
    const diagnostics = convertFileDiagnostics(ts, sourceFile, byFile.get(keyOf(ts, path)) ?? [])
    checked++
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity === 'error') errors++
      else if (diagnostic.severity === 'warning') warnings++
    }
    try {
      onFile(path, diagnostics)
    } catch { /* 回调失败不应中断扫描 */ }
    // 回退路径里这里已经不需要跑 TS，只做轻量转换；每 64 个文件让出一次。
    if (index % 64 === 63) await new Promise<void>(resolveYield => setImmediate(resolveYield))
  }
  return { checked, errors, warnings }
}

/** TS diagnostic（带绝对偏移）→ 协议诊断（0 基行列）。 */
function convertFileDiagnostics(ts: TsModule, sourceFile: TsSourceFile, diagnostics: readonly TsDiagnostic[]): LanguageDiagnostic[] {
  const result: LanguageDiagnostic[] = []
  for (const diagnostic of diagnostics) {
    const file = diagnostic.file
    if (file === undefined || diagnostic.start === undefined) continue
    const text = file.text
    const related = relatedInformationOf(ts, diagnostic)
    const tags = tagsOf(diagnostic)
    result.push({
      range: spanRange(ts, file, diagnostic.start, diagnostic.length ?? 0, text.length),
      severity: severityOf(diagnostic.category),
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
      code: `TS${diagnostic.code}`,
      source: 'ts',
      ...(tags === undefined ? {} : { tags }),
      ...(related.length === 0 ? {} : { related }),
    })
  }
  return result.sort((left, right) => comparePosition(left.range.start, right.range.start) || severityRank(left.severity) - severityRank(right.severity))
}

function relatedInformationOf(ts: TsModule, diagnostic: TsDiagnostic): LanguageRelatedInformation[] {
  const related: LanguageRelatedInformation[] = []
  for (const information of diagnostic.relatedInformation ?? []) {
    const file = information.file
    if (file === undefined || information.start === undefined) continue
    related.push({
      path: file.fileName,
      range: spanRange(ts, file, information.start, information.length ?? 0, file.text.length),
      message: ts.flattenDiagnosticMessageText(information.messageText, ' '),
    })
  }
  return related
}

function spanRange(ts: TsModule, file: TsSourceFile, start: number, length: number, textLength: number): LanguageRange {
  const safeStart = Math.max(0, Math.min(start, textLength))
  const safeEnd = Math.max(safeStart, Math.min(start + length, textLength))
  return { start: positionAt(ts, file, safeStart), end: positionAt(ts, file, safeEnd) }
}

function positionAt(ts: TsModule, file: TsSourceFile, offset: number): LanguagePosition {
  const position = ts.getLineAndCharacterOfPosition(file, offset)
  return { line: position.line, character: position.character }
}

function severityOf(category: import('typescript').DiagnosticCategory): LanguageDiagnostic['severity'] {
  switch (category) {
    case 1: return 'error'
    case 0: return 'warning'
    default: return 'info'
  }
}

function tagsOf(diagnostic: TsDiagnostic): LanguageDiagnostic['tags'] {
  const tags: Array<'unnecessary' | 'deprecated'> = []
  if (diagnostic.reportsUnnecessary !== undefined) tags.push('unnecessary')
  if (diagnostic.reportsDeprecated !== undefined) tags.push('deprecated')
  return tags.length === 0 ? undefined : tags
}

function severityRank(severity: LanguageDiagnostic['severity']): number {
  switch (severity) { case 'error': return 0; case 'warning': return 1; case 'info': return 2; default: return 3 }
}

function comparePosition(left: LanguagePosition, right: LanguagePosition): number {
  return left.line !== right.line ? left.line - right.line : left.character - right.character
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}
