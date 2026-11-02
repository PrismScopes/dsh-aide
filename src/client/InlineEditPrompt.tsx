import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { api } from './api.ts'
import { replaceDocumentRange, type InlineEditProposal, type InlineEditSnapshot } from './inlineEdit.ts'

/**
 * 「用 AI 修改选中代码」的指令输入框。
 *
 * 只做三件事：让用户写一句要求、把请求发给宿主、把结果变成 diff 提案。真正的预览与接受/拒绝
 * 在编辑器区的 diff 标签里完成 —— 用户在看过改动之前，磁盘与缓冲区都不会变。
 *
 * 请求期间允许取消：AbortSignal 一路传到宿主，模型调用跟着中止，不会在后台白算。
 */

/** 选区预览最多显示这么多行/字符：足够确认改的是哪一段，又不会把对话框撑破。 */
const PREVIEW_LINES = 5
const PREVIEW_CHARS = 320

export function InlineEditPrompt(props: {
  snapshot: InlineEditSnapshot
  /** 工作区相对路径（写进 prompt 与 diff 标签标题）。 */
  path: string
  sessionId: string
  onClose(): void
  onProposal(proposal: InlineEditProposal): void
}) {
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const controller = useRef<AbortController>()
  // 卸载（切会话/关工作台）时中止在途请求；已经结束的请求不会有副作用。
  useEffect(() => () => controller.current?.abort(), [])
  const preview = selectionPreview(props.snapshot.text)

  const submit = async (): Promise<void> => {
    const text = instruction.trim()
    if (text === '' || busy) return
    const abort = new AbortController()
    controller.current = abort
    setBusy(true)
    setError(undefined)
    try {
      const result = await api<{ text: string; model: string }>('ai.inlineEdit', {
        sessionId: props.sessionId,
        filePath: props.path,
        language: props.snapshot.language,
        instruction: text,
        selectionText: props.snapshot.text,
        before: props.snapshot.before,
        after: props.snapshot.after,
      }, abort.signal)
      if (abort.signal.aborted) return
      props.onProposal({
        path: props.path,
        absolutePath: props.snapshot.absolutePath,
        instruction: text,
        originalDocument: props.snapshot.document,
        modifiedDocument: replaceDocumentRange(props.snapshot.document, props.snapshot.range, result.text),
        replacement: result.text,
        range: props.snapshot.range,
      })
    } catch (failure) {
      if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (controller.current === abort) setBusy(false)
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); props.onClose(); return }
    // Enter 生成、Shift+Enter 换行：与聊天框一致，能写多行要求。
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() }
  }

  return <div className="dvw-inline-edit-backdrop" onMouseDown={() => { if (!busy) props.onClose() }}>
    <div className="dvw-inline-edit" role="dialog" aria-label="用 AI 修改选中代码" onMouseDown={event => event.stopPropagation()}>
      <div className="dvw-inline-edit-head">用 AI 修改选中代码</div>
      <div className="dvw-inline-edit-meta">{props.path} · 第 {props.snapshot.range.startLine}–{props.snapshot.range.endLine} 行</div>
      <pre className="dvw-inline-edit-preview" aria-label="选中的代码">{preview}</pre>
      <textarea className="dvw-inline-edit-input" autoFocus value={instruction} rows={3}
        placeholder="说明想怎么改，例如：改成 async/await，并补上错误处理"
        aria-label="修改要求" disabled={busy}
        onChange={event => setInstruction(event.target.value)} onKeyDown={onKeyDown}/>
      {error !== undefined && <div className="dvw-inline-edit-error" role="alert">{error}</div>}
      <div className="dvw-inline-edit-foot">
        <span className="dvw-inline-edit-hint">{busy ? '正在生成…' : 'Enter 生成 · Shift+Enter 换行 · Esc 取消'}</span>
        <button type="button" className="dvw-mode-button" onClick={() => props.onClose()} disabled={busy}>取消</button>
        <button type="button" className="dvw-mode-button" data-variant="primary" onClick={() => void submit()} disabled={busy || instruction.trim() === ''}>{busy ? '生成中' : '生成修改'}</button>
      </div>
    </div>
  </div>
}

/** 选区预览：最多 5 行、320 字符，超出的部分用省略说明替代。 */
export function selectionPreview(text: string): string {
  const lines = text.split('\n')
  const shown = lines.slice(0, PREVIEW_LINES).join('\n')
  const head = shown.length > PREVIEW_CHARS ? shown.slice(0, PREVIEW_CHARS) : shown
  const hiddenLines = lines.length - PREVIEW_LINES
  const suffix = hiddenLines > 0 ? `\n… 还有 ${hiddenLines} 行` : shown.length > PREVIEW_CHARS ? '\n…' : ''
  return head === '' ? '（空行）' : head + suffix
}
