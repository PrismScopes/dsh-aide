/**
 * 关闭确认对话框（VS Code 同款）。
 *
 * 为什么单独做成组件：原先关闭标签页用的是浏览器原生确认框 —— 文案只有一句「确定关闭？」，
 * 一次只能问一个文件，样式不可控，也不能列出到底是哪些文件没保存。这里把它换成一个
 * `role="alertdialog"` 的页内对话框：
 *   - 单个脏文件：保存 / 不保存 / 取消，默认焦点在「保存」；
 *   - 多个脏文件：全部保存 / 不保存全部 / 取消，文件列表超过可见高度时滚动。
 *
 * 它**纯展示**：不调 api、不碰 service，也不自己保存文件。要不要关、保存成功后关哪些，
 * 由 Workbench 决定（它才知道 revision 冲突、批量关闭的范围）。回调只有三个：
 * `onSave` / `onDiscard` / `onCancel`。
 *
 * 样式复用资源管理器删除确认框的 `.dvw-confirm-backdrop` / `.dvw-confirm`，只有文件列表的
 * 滚动容器用 inline style（避免为一次性的布局往 styles.ts 里加类）。
 */
import { useEffect, useRef } from 'react'

/** 单个文件与多文件用两套按钮文案：批量时「保存」含义不清，必须说「全部保存」。 */
type ClosePromptMode = 'single' | 'multiple'

interface ClosePromptProps {
  /** 待关闭的脏文件路径（只应包含 dirty 的标签，由调用方筛过并保持标签顺序）。 */
  paths: readonly string[]
  onSave(): void
  onDiscard(): void
  onCancel(): void
}

/** 单个 vs 批量：只有真的多于一个文件才用批量文案。 */
export function closePromptMode(count: number): ClosePromptMode {
  return count > 1 ? 'multiple' : 'single'
}

/** 按标签对象过滤出真正需要提示的：只认 `dirty === true`，缺字段/其它值都不算。 */
export function dirtyCloseTabs<T extends { dirty?: boolean }>(tabs: readonly T[]): T[] {
  return tabs.filter(tab => tab.dirty === true)
}

/** 是否需要弹关闭确认：只要有任意一个标签真的脏了。 */
export function needsClosePrompt<T extends { dirty?: boolean }>(tabs: readonly T[]): boolean {
  return tabs.some(tab => tab.dirty === true)
}

/**
 * 对话框主文案。
 *
 * 单个文件带上路径（用户可能是从右键菜单批量关到只剩一个，需要知道关的是谁）；
 * 多个文件只给数量，具体列表由组件逐行渲染。
 */
export function closePromptSummary(paths: readonly string[]): string {
  if (paths.length === 0) return '没有未保存的更改，可以安全关闭。'
  const only = paths[0] ?? ''
  if (paths.length === 1) return `“${only}”有未保存的更改。`
  return `以下 ${paths.length} 个文件有未保存的更改：`
}

/** 三个按钮的文案；按 VS Code 的顺序排列（保存类在前，取消在最后）。 */
export function closePromptLabels(mode: ClosePromptMode): { save: string; discard: string; cancel: string } {
  return mode === 'single'
    ? { save: '保存', discard: '不保存', cancel: '取消' }
    : { save: '全部保存', discard: '不保存全部', cancel: '取消' }
}

const TITLE_ID = 'dvw-close-prompt-title'
const DESC_ID = 'dvw-close-prompt-desc'

/** 文件列表：最多 180px 高，超出滚动 —— 批量关闭几十个标签时对话框不会撑出屏幕。 */
const listStyle = {
  maxHeight: 180,
  overflowY: 'auto',
  margin: '12px 0 0',
  padding: 0,
  listStyle: 'none',
  display: 'grid',
  gap: 6,
} as const

const listItemStyle = {
  border: '1px solid var(--dvw-border)',
  borderRadius: 'var(--dvw-radius-xs)',
  background: 'var(--dvw-surface-2)',
  padding: '6px 8px',
  fontFamily: 'var(--dvw-font-mono, monospace)',
  fontSize: 12,
  wordBreak: 'break-all',
} as const

const listNoteStyle = { display: 'block', marginTop: 2, color: 'var(--dvw-text-3)', fontFamily: 'inherit', fontSize: 11 } as const

/**
 * 关闭确认对话框。
 *
 * 无障碍：`role="alertdialog"` + `aria-modal`，标题与说明用固定 id 关联；挂载后焦点进「保存」
 * 按钮，Tab 在三个按钮间循环，Esc 等于「取消」。点遮罩不算取消 —— VS Code 的这个框也是
 * 必须明确选一个（避免误触关掉对话框导致不知道文件没保存）。
 */
export function ClosePrompt({ paths, onSave, onDiscard, onCancel }: ClosePromptProps) {
  const saveButton = useRef<HTMLButtonElement>(null)
  const mode = closePromptMode(paths.length)
  const labels = closePromptLabels(mode)
  const summary = closePromptSummary(paths)

  useEffect(() => { saveButton.current?.focus() }, [])

  return <div className="dvw-confirm-backdrop" role="presentation">
    <section
      className="dvw-confirm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={TITLE_ID}
      aria-describedby={DESC_ID}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          // 捕获阶段由外层 overlay 的键盘监听先看到也只会触发一次：这里阻止冒泡，避免连带关掉工作台。
          event.preventDefault()
          event.stopPropagation()
          onCancel()
          return
        }
        if (event.key !== 'Tab') return
        // 焦点陷阱：对话框没被挂到 body 顶层，Tab 不应该跑到背后的标签页与编辑器里。
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('footer button')]
        const first = buttons[0]
        const last = buttons.at(-1)
        if (first === undefined || last === undefined) return
        const active = document.activeElement
        if (event.shiftKey && (active === first || !buttons.includes(active as HTMLButtonElement))) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && (active === last || !buttons.includes(active as HTMLButtonElement))) {
          event.preventDefault()
          first.focus()
        }
      }}
    >
      <h2 id={TITLE_ID}>{mode === 'single' ? '关闭文件' : '关闭多个文件'}</h2>
      <p id={DESC_ID}>{summary}</p>
      {paths.length > 1 && <ul style={listStyle} aria-label="有未保存更改的文件">
        {paths.map(path => <li key={path} style={listItemStyle}>
          {path}
          <span style={listNoteStyle}>有未保存的更改</span>
        </li>)}
      </ul>}
      <p className="dvw-confirm-note">
        {mode === 'single'
          ? '选择「保存」会先保存再关闭；「不保存」会丢弃这个文件的更改。'
          : '选择「全部保存」会逐个保存后再关闭；「不保存全部」会丢弃这些文件的更改。'}
      </p>
      <footer>
        <button ref={saveButton} onClick={onSave}>{labels.save}</button>
        <button onClick={onDiscard}>{labels.discard}</button>
        <button onClick={onCancel}>{labels.cancel}</button>
      </footer>
    </section>
  </div>
}
