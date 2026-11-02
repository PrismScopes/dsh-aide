/**
 * 编辑器内 AI 修改的客户端部分：选区快照、请求事件、diff 提案与「应用到缓冲区」。
 *
 * 与编辑器绑定的只有两处：MonacoEditor 负责把当前选区做成快照并触发请求；
 * 应用时通过语言服务动作层登记的编辑器实例执行一次可撤销的编辑。其余逻辑（截取上下文、
 * 行号换算、范围替换）都是纯函数，能直接在测试里断言。
 */
import type { editor as MonacoEditorApi } from 'monaco-editor'
import { editorForPath } from './language/actions.ts'

/** 触发编辑器内 AI 修改的事件名；Workbench 监听它并弹出指令输入框。 */
export const INLINE_EDIT_EVENT = 'dvw-inline-edit'

/** 选区位置；行列都从 1 起，与 Monaco 一致。 */
export interface InlineEditRange { startLine: number; startColumn: number; endLine: number; endColumn: number }

/** 一次修改请求的输入快照：文档全文 + 选区 + 前后文。 */
export interface InlineEditSnapshot {
  /** 文件绝对路径（应用修改时用它找编辑器实例）。 */
  absolutePath: string
  language: string
  /** 生成时刻的完整文档：应用前用它判断缓冲区是否已经变了。 */
  document: string
  /** 选中文本（没有选区时是当前行）。 */
  text: string
  range: InlineEditRange
  /** 选区之前的上下文（按行截取）。 */
  before: string
  /** 选区之后的上下文（按行截取）。 */
  after: string
}

/** 模型返回后的 diff 提案：原文档、改后文档、替换范围与替换文本。 */
export interface InlineEditProposal {
  /** 工作区相对路径。 */
  path: string
  absolutePath: string
  instruction: string
  originalDocument: string
  modifiedDocument: string
  replacement: string
  range: InlineEditRange
}

/** 上下文窗口：前后各取多少行。40 行足够让模型看见所在函数与 import，又不会把整个文件塞进去。 */
const CONTEXT_LINES = 40

/** 把编辑器当前选区做成快照。没有选区时取光标所在整行（VS Code 的 Ctrl+K 语义）。 */
export function snapshotOfEditor(instance: MonacoEditorApi.IStandaloneCodeEditor, absolutePath: string): InlineEditSnapshot | undefined {
  const model = instance.getModel()
  if (model === null) return undefined
  const selection = instance.getSelection()
  const range: InlineEditRange = selection === null || selection === undefined || selection.isEmpty()
    ? currentLineRange(instance, model)
    : { startLine: selection.startLineNumber, startColumn: selection.startColumn, endLine: selection.endLineNumber, endColumn: selection.endColumn }
  const monoRange = { startLineNumber: range.startLine, startColumn: range.startColumn, endLineNumber: range.endLine, endColumn: range.endColumn }
  const before = model.getValueInRange({
    startLineNumber: Math.max(1, range.startLine - CONTEXT_LINES), startColumn: 1,
    endLineNumber: range.startLine, endColumn: range.startColumn,
  })
  const after = model.getValueInRange({
    startLineNumber: range.endLine, startColumn: range.endColumn,
    endLineNumber: Math.min(model.getLineCount(), range.endLine + CONTEXT_LINES), endColumn: model.getLineMaxColumn(Math.min(model.getLineCount(), range.endLine + CONTEXT_LINES)),
  })
  return {
    absolutePath,
    language: model.getLanguageId(),
    document: model.getValue(),
    text: model.getValueInRange(monoRange),
    range,
    before,
    after,
  }
}

/** 光标所在整行；空行也给出一个可替换的范围（整行文本为空，模型会补内容）。 */
function currentLineRange(instance: MonacoEditorApi.IStandaloneCodeEditor, model: MonacoEditorApi.ITextModel): InlineEditRange {
  const line = instance.getPosition()?.lineNumber ?? 1
  return { startLine: line, startColumn: 1, endLine: line, endColumn: model.getLineMaxColumn(line) }
}

/** 派发请求事件；Workbench 是唯一的监听者（它持有 sessionId 与工作区路径）。 */
export function requestInlineEdit(snapshot: InlineEditSnapshot): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(INLINE_EDIT_EVENT, { detail: snapshot }))
}

/**
 * 在文档里把 range 换成 text。
 *
 * 行列从 1 起；列按 UTF-16 码元计，与 Monaco 的列语义一致。越界的行/列夹到文档范围内，
 * 这样模型返回后再改文档也不会因为一行被删掉而算出负偏移。
 */
export function replaceDocumentRange(document: string, range: InlineEditRange, text: string): string {
  const lines = document.split('\n')
  const offsetOf = (line: number, column: number): number => {
    if (line > lines.length) return document.length
    const clampedLine = Math.max(1, line)
    let offset = 0
    for (let index = 0; index < clampedLine - 1; index++) offset += (lines[index] ?? '').length + 1
    const current = lines[clampedLine - 1] ?? ''
    return offset + Math.min(Math.max(0, column - 1), current.length)
  }
  const start = offsetOf(range.startLine, range.startColumn)
  const end = Math.max(start, offsetOf(range.endLine, range.endColumn))
  return document.slice(0, start) + text + document.slice(end)
}

/**
 * 应用提案：优先写回已挂载的编辑器（一次可撤销的编辑），编辑器不在时返回 false，
 * 由调用方退回「直接替换标签草稿」。
 *
 * 缓冲区在生成之后被改过就不应用：范围是按旧文档算的，硬套会覆盖用户刚写的内容。
 */
export function applyInlineEdit(proposal: InlineEditProposal): boolean {
  const instance = editorForPath(proposal.absolutePath)
  if (instance === undefined) return false
  const model = instance.getModel()
  if (model === null || model.getValue() !== proposal.originalDocument) return false
  instance.pushUndoStop()
  instance.executeEdits('dsh-inline-edit', [{
    range: { startLineNumber: proposal.range.startLine, startColumn: proposal.range.startColumn, endLineNumber: proposal.range.endLine, endColumn: proposal.range.endColumn },
    text: proposal.replacement,
    forceMoveMarkers: true,
  }])
  instance.pushUndoStop()
  instance.focus()
  return true
}
