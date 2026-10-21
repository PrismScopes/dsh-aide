/**
 * 语言服务的 HTTP 分发。
 *
 * 从 api.ts 拆出来：那边只留一行 `if (method.startsWith('language.'))` 的分流，
 * 参数校验与各方法调用放在这里，避免把文件 API 的 switch 撑成一锅。
 *
 * 所有路径参数都必须是工作区相对语义之外的绝对路径？不是 —— 客户端发**绝对路径**（它知道工作区根，
 * 供应商返回的也是绝对路径），这里只做类型校验，工作区包含判断由 LanguageManager 统一完成。
 */
import type { HostContext } from '../context.ts'
import { WorkbenchError } from '../wire.ts'
import { languageHostFor } from './host.ts'
import { LanguageRequestError } from './manager.ts'
import type {
  LanguageDiagnostic,
  LanguagePosition,
  LanguageRange,
  LanguageWorkspaceEdit,
} from './protocol.ts'

/** 同步正文的上限：body 本身限 2 MiB，这里留出 JSON 转义余量后给一个更明确的错误。 */
const MAX_SYNC_CONTENT = 1.5 * 1024 * 1024

function objectField(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WorkbenchError('invalid-argument', `${what} must be an object`)
  return value as Record<string, unknown>
}

function numberValue(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new WorkbenchError('invalid-argument', `${what} must be a finite number`)
  return value
}

function nonNegativeInteger(value: unknown, what: string): number {
  const number = numberValue(value, what)
  if (!Number.isInteger(number) || number < 0) throw new WorkbenchError('invalid-argument', `${what} must be a non-negative integer`)
  return number
}

function positionValue(value: unknown, what: string): LanguagePosition {
  const record = objectField(value, what)
  return { line: nonNegativeInteger(record['line'], `${what}.line`), character: nonNegativeInteger(record['character'], `${what}.character`) }
}

function rangeValue(value: unknown, what: string): LanguageRange {
  const record = objectField(value, what)
  return { start: positionValue(record['start'], `${what}.start`), end: positionValue(record['end'], `${what}.end`) }
}

function workspaceEditValue(value: unknown): LanguageWorkspaceEdit {
  const record = objectField(value, 'edit')
  if (!Array.isArray(record['changes'])) throw new WorkbenchError('invalid-argument', 'edit.changes must be an array')
  if (record['changes'].length > 200) throw new WorkbenchError('invalid-argument', 'too many files in edit')
  return {
    changes: record['changes'].map((entry, index) => {
      const change = objectField(entry, `edit.changes[${index}]`)
      const path = change['path']
      if (typeof path !== 'string' || path === '') throw new WorkbenchError('invalid-argument', 'edit path must be a non-empty string')
      if (!Array.isArray(change['edits']) || change['edits'].length > 5000) throw new WorkbenchError('invalid-argument', 'edit list is invalid or too large')
      return {
        path,
        edits: change['edits'].map((rawEdit, editIndex) => {
          const edit = objectField(rawEdit, `edit.changes[${index}].edits[${editIndex}]`)
          const newText = edit['newText']
          if (typeof newText !== 'string') throw new WorkbenchError('invalid-argument', 'edit newText must be a string')
          return { range: rangeValue(edit['range'], 'edit range'), newText }
        }),
      }
    }),
  }
}

function diagnosticsOf(body: Record<string, unknown>): LanguageDiagnostic[] {
  // 客户端可能把当前标记传上来；这里只做形状筛选，真正的来源仍由管理器按文件版本决定，
  // 所以格式不对时直接忽略，不因为一个诊断对象让快速修复整体失败。
  const value = body['diagnostics']
  if (!Array.isArray(value)) return []
  const result: LanguageDiagnostic[] = []
  for (const entry of value) {
    try {
      const record = objectField(entry, 'diagnostic')
      const message = record['message']
      const severity = record['severity']
      if (typeof message !== 'string') continue
      if (severity !== 'error' && severity !== 'warning' && severity !== 'info' && severity !== 'hint') continue
      const code = typeof record['code'] === 'string' || typeof record['code'] === 'number' ? String(record['code']) : undefined
      result.push({ range: rangeValue(record['range'], 'diagnostic.range'), severity, message, ...(code === undefined ? {} : { code }) })
    } catch { /* 跳过格式不对的项 */ }
  }
  return result
}

/**
 * 语言服务方法分发。
 *
 * `cwd` 由 api.ts 的会话解析给出；这里不再碰会话/工作目录，便于单测直接喂一个 cwd。
 */
export async function dispatchLanguage(ctx: HostContext, method: string, body: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<unknown> {
  const host = languageHostFor(ctx)
  const manager = host.managerFor(cwd)
  const pathField = (): string => {
    const value = body['path']
    if (typeof value !== 'string' || value === '') throw new WorkbenchError('invalid-argument', 'path must be a non-empty string')
    return value
  }
  try {
    switch (method) {
      case 'language.info': return await manager.info()
      case 'language.sync': {
        const kind = body['kind']
        if (kind !== 'open' && kind !== 'change' && kind !== 'close') throw new WorkbenchError('invalid-argument', 'kind must be open, change or close')
        const languageId = body['languageId']
        if (typeof languageId !== 'string' || languageId === '') throw new WorkbenchError('invalid-argument', 'languageId must be a non-empty string')
        const version = nonNegativeInteger(body['version'], 'version')
        const content = body['content']
        if (typeof content !== 'string') throw new WorkbenchError('invalid-argument', 'content must be a string')
        if (content.length > MAX_SYNC_CONTENT) throw new WorkbenchError('too-large', 'document is too large for language service', 413)
        await manager.sync({ kind, path: pathField(), languageId, version, content })
        return { ok: true }
      }
      case 'language.definition': return await manager.definition(pathField(), positionValue(body['position'], 'position'), signal)
      case 'language.hover': return await manager.hover(pathField(), positionValue(body['position'], 'position'), signal)
      case 'language.references': return await manager.references(pathField(), positionValue(body['position'], 'position'), signal)
      case 'language.rename': {
        const newName = body['newName']
        if (typeof newName !== 'string' || newName.trim() === '') throw new WorkbenchError('invalid-argument', 'newName must be a non-empty string')
        return await manager.rename(pathField(), positionValue(body['position'], 'position'), newName, signal)
      }
      case 'language.documentSymbols': return await manager.documentSymbols(pathField(), signal)
      case 'language.workspaceSymbols': {
        const query = body['query']
        if (typeof query !== 'string') throw new WorkbenchError('invalid-argument', 'query must be a string')
        const limit = body['limit'] === undefined ? 200 : nonNegativeInteger(body['limit'], 'limit')
        return await manager.workspaceSymbols(query, Math.min(Math.max(limit, 1), 500), signal)
      }
      case 'language.completion': {
        const trigger = body['triggerCharacter']
        return await manager.completion(pathField(), positionValue(body['position'], 'position'), typeof trigger === 'string' ? trigger : undefined, signal)
      }
      case 'language.signatureHelp': return await manager.signatureHelp(pathField(), positionValue(body['position'], 'position'), signal)
      case 'language.codeActions': {
        const path = pathField()
        const range = rangeValue(body['range'], 'range')
        const diagnostics = diagnosticsOf(body)
        return await manager.codeActions(path, range, diagnostics.length > 0 ? diagnostics : manager.diagnosticsOf(path), signal)
      }
      case 'language.scan': {
        const state = await manager.scan(signal)
        return { supported: state !== undefined, ...(state === undefined ? {} : { state }) }
      }
      case 'language.read': {
        const file = await manager.readFile(pathField(), typeof body['languageId'] === 'string' ? body['languageId'] : undefined)
        if (file === undefined) throw new WorkbenchError('not-found', 'file is not available to the language service', 404)
        return file
      }
      case 'language.applyEdit': return { written: await manager.applyEdits(workspaceEditValue(body['edit'])) }
      default: throw new WorkbenchError('not-found', `unknown language API method ${method}`, 404)
    }
  } catch (error) {
    if (error instanceof WorkbenchError) throw error
    if (error instanceof LanguageRequestError) throw new WorkbenchError(error.code, error.message, error.status)
    throw new WorkbenchError('language-failed', error instanceof Error ? error.message : String(error), 500)
  }
}
