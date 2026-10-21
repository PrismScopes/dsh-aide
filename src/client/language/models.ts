/**
 * Monaco 模型 ↔ 文件绝对路径的登记表。
 *
 * 语言服务的协议用绝对路径，而 Monaco 模型的主键是 URI。URI 在不同平台、不同创建方式下
 * （`file:///C:/x`、`file:///C:\x`、`file:///c%3A/x`）写法会变，靠反解 URI 猜路径很脆。
 * 编辑器在挂载/卸载时显式登记，语言特性只查这张表：唯一的事实来源是「打开这个模型的组件」。
 */
import type { editor, IPosition, IRange } from 'monaco-editor'
import type { LanguagePosition, LanguageRange } from '../../language/protocol.ts'
import { absolutePathOf, isWindowsPlatform, samePath } from './paths.ts'

type TextModel = editor.ITextModel
type ModelLike = { uri: { toString(): string } }

const pathsByUri = new Map<string, string>()
const modelsByPath = new Map<string, TextModel>()
const uriByPath = new Map<string, string>()

function uriKeyOf(model: ModelLike): string { return model.uri.toString() }

/** 编辑器挂载模型时登记；重复登记（同一 URI）以最后一次为准。 */
export function registerModelPath(model: TextModel, absolutePath: string): void {
  const uri = uriKeyOf(model)
  pathsByUri.set(uri, absolutePath)
  uriByPath.set(absolutePath, uri)
  modelsByPath.set(absolutePath, model)
}

/** 模型销毁/编辑器卸载时注销。只有登记的还是同一个模型时才删，避免旧实例把新登记抹掉。 */
export function unregisterModel(model: ModelLike): void {
  const uri = uriKeyOf(model)
  const path = pathsByUri.get(uri)
  pathsByUri.delete(uri)
  if (path === undefined) return
  if (uriByPath.get(path) === uri) uriByPath.delete(path)
  if (modelsByPath.get(path)?.uri.toString() === uri) modelsByPath.delete(path)
}

/** 查模型对应的绝对路径；没有登记时用模型 URI 兜底（模型是 Monaco 自己创建的，例如 extra lib）。 */
export function absolutePathForModel(model: ModelLike): string | undefined {
  const registered = pathsByUri.get(uriKeyOf(model))
  if (registered !== undefined) return registered
  const uri = model.uri as { scheme?: string; path?: string; fsPath?: string }
  if (uri.scheme !== 'file') return undefined
  if (typeof uri.fsPath === 'string' && uri.fsPath !== '') return uri.fsPath
  const path = uri.path
  if (typeof path !== 'string' || path === '') return undefined
  const decoded = decodeURIComponent(path)
  // Monaco 的 URI 路径总是以 `/` 开头；Windows 盘符路径要还原成 `C:\...`。
  const withoutLeading = decoded.replace(/^\/+/, '')
  return isWindowsPlatform() ? withoutLeading.replaceAll('/', '\\') : decoded
}

/** 按绝对路径找当前打开的模型（诊断标记要落到它上面）。 */
export function modelForPath(absolutePath: string): TextModel | undefined {
  const direct = modelsByPath.get(absolutePath)
  if (direct !== undefined) return direct
  for (const [registered, model] of modelsByPath) {
    if (samePath(registered, absolutePath)) return model
  }
  return undefined
}

/** 当前登记的全部模型，状态清理/整体重放标记时用。 */
export function registeredModels(): readonly { path: string; model: TextModel }[] {
  return [...modelsByPath].map(([path, model]) => ({ path, model }))
}

/** 工作区相对路径 → 绝对路径；只用于 Workbench 把标签路径交给语言层。 */
export function absolutePathForTab(root: string, relative: string): string {
  return absolutePathOf(root, relative)
}

/** 0 基协议位置 → Monaco 1 基位置。 */
export function monacoPosition(position: LanguagePosition): IPosition {
  return { lineNumber: position.line + 1, column: position.character + 1 }
}

/** 0 基协议范围 → Monaco 1 基范围。 */
export function monacoRange(range: LanguageRange): IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  }
}

/** Monaco 位置 → 0 基协议位置。 */
export function languagePosition(position: IPosition): LanguagePosition {
  return { line: Math.max(0, position.lineNumber - 1), character: Math.max(0, position.column - 1) }
}

/** Monaco 选择/范围 → 0 基协议范围。 */
export function languageRange(range: IRange): LanguageRange {
  return {
    start: { line: Math.max(0, range.startLineNumber - 1), character: Math.max(0, range.startColumn - 1) },
    end: { line: Math.max(0, range.endLineNumber - 1), character: Math.max(0, range.endColumn - 1) },
  }
}
