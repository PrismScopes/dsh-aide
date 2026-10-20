import { describe, expect, it, vi } from 'vitest'
import type { MenuEntry, MenuItem } from '../src/client/ContextMenu.tsx'
import {
  copyFallbackText,
  diffMenuItems,
  editorMenuItems,
  menuPositionAtCursor,
  pasteFallbackText,
  type DiffMenuActions,
  type EditorMenuActions,
  type EditorMenuContext,
} from '../src/client/editorMenus.ts'

/** 把菜单项压成「id + 是否禁用」的序列，分组顺序与禁用规则一眼可读。 */
function shape(entries: readonly MenuEntry[]): string[] {
  return entries.map(entry => entry.kind === 'separator' ? '---' : `${entry.id}${entry.disabled === true ? '(禁用)' : ''}`)
}

function entry(entries: readonly MenuEntry[], id: string): MenuItem | undefined {
  return entries.find((candidate): candidate is MenuItem => candidate.kind === 'item' && candidate.id === id)
}

function labelsOf(entries: readonly MenuEntry[]): string[] {
  return entries.flatMap(candidate => candidate.kind === 'item' ? [candidate.label] : [])
}

/** 每个 label 至少含一个 CJK 字符；英文标签（Monaco 内置菜单那种）会立刻失败。 */
const CJK = /[\u4e00-\u9fff]/

function editorActions(): EditorMenuActions {
  return {
    undo: vi.fn(), redo: vi.fn(), cut: vi.fn(), copy: vi.fn(), paste: vi.fn(),
    selectAll: vi.fn(), find: vi.fn(), replace: vi.fn(), gotoLine: vi.fn(),
    commentLine: vi.fn(), format: vi.fn(), fold: vi.fn(), unfold: vi.fn(), save: vi.fn(),
  }
}

function context(overrides: Partial<Pick<EditorMenuContext, 'readOnly' | 'hasSelection' | 'canFormat'>> = {}): EditorMenuContext {
  return { readOnly: false, hasSelection: true, canFormat: true, actions: editorActions(), ...overrides }
}

function diffActions(): DiffMenuActions {
  return { copy: vi.fn(), selectAll: vi.fn(), toggleDisplay: vi.fn() }
}

describe('source editor context menu', () => {
  it('groups the items in VS Code order', () => {
    expect(shape(editorMenuItems(context()))).toEqual([
      'editor-undo', 'editor-redo', '---',
      'editor-cut', 'editor-copy', 'editor-paste', '---',
      'editor-select-all', '---',
      'editor-find', 'editor-replace', 'editor-goto-line', '---',
      'editor-comment-line', 'editor-format', '---',
      'editor-fold', 'editor-unfold', '---',
      'editor-save',
    ])
  })

  it('disables cut and copy when there is no selected text', () => {
    const entries = editorMenuItems(context({ hasSelection: false }))
    expect(shape(entries)).toContain('editor-cut(禁用)')
    expect(shape(entries)).toContain('editor-copy(禁用)')
    // 粘贴不依赖本编辑器的选区，不能被连坐。
    expect(shape(entries)).toContain('editor-paste')
  })

  it('disables editing actions on a read-only model but keeps view/navigation actions usable', () => {
    const entries = editorMenuItems(context({ readOnly: true }))
    for (const id of ['editor-undo', 'editor-redo', 'editor-cut', 'editor-paste', 'editor-comment-line', 'editor-format']) {
      expect(shape(entries)).toContain(`${id}(禁用)`)
    }
    // 复制、查找、折叠、保存只读时仍然有意义（VS Code 同样保留）。
    expect(shape(entries)).toContain('editor-copy')
    expect(entry(entries, 'editor-select-all')?.disabled).not.toBe(true)
    expect(entry(entries, 'editor-save')?.disabled).not.toBe(true)
  })

  it('disables formatting when Monaco reports no formatter for the document', () => {
    expect(entry(editorMenuItems(context({ canFormat: false })), 'editor-format')).toMatchObject({ disabled: true })
    expect(entry(editorMenuItems(context({ canFormat: true })), 'editor-format')?.disabled).not.toBe(true)
  })

  it('runs the action bound to each item', () => {
    const ctx = context()
    const entries = editorMenuItems(ctx)
    const actionById: Record<string, keyof EditorMenuActions> = {
      'editor-undo': 'undo',
      'editor-redo': 'redo',
      'editor-cut': 'cut',
      'editor-copy': 'copy',
      'editor-paste': 'paste',
      'editor-select-all': 'selectAll',
      'editor-find': 'find',
      'editor-replace': 'replace',
      'editor-goto-line': 'gotoLine',
      'editor-comment-line': 'commentLine',
      'editor-format': 'format',
      'editor-fold': 'fold',
      'editor-unfold': 'unfold',
      'editor-save': 'save',
    }
    for (const candidate of entries) {
      if (candidate.kind !== 'item') continue
      const action = actionById[candidate.id]
      expect(action, `菜单项 ${candidate.id} 没有绑定动作`).toBeDefined()
      if (action === undefined) continue
      candidate.onSelect()
      expect(ctx.actions[action]).toHaveBeenCalledTimes(1)
    }
  })

  it('shows display-only shortcuts on the items that have keybindings', () => {
    const entries = editorMenuItems(context())
    for (const id of ['editor-undo', 'editor-cut', 'editor-copy', 'editor-find', 'editor-format', 'editor-save']) {
      expect(entry(entries, id)?.shortcut).toBeTruthy()
    }
  })

  it('writes every label in Chinese', () => {
    const labels = labelsOf(editorMenuItems(context()))
    expect(labels.length).toBeGreaterThan(0)
    for (const label of labels) expect(label).toMatch(CJK)
  })
})

describe('diff editor context menu', () => {
  it('offers only copy, select-all and the display toggle on the read-only diff view', () => {
    expect(shape(diffMenuItems({ hasSelection: false, mode: 'inline', actions: diffActions() }))).toEqual([
      'diff-copy(禁用)', 'diff-select-all', '---', 'diff-toggle-display',
    ])
  })

  it('labels the toggle with the mode it switches to', () => {
    const inline = diffMenuItems({ hasSelection: true, mode: 'inline', actions: diffActions() })
    expect(entry(inline, 'diff-toggle-display')).toMatchObject({ label: '切换到并排显示', icon: 'diff-sidebyside' })
    const split = diffMenuItems({ hasSelection: true, mode: 'split', actions: diffActions() })
    expect(entry(split, 'diff-toggle-display')).toMatchObject({ label: '切换到行内显示', icon: 'diff-single' })
  })

  it('runs copy/select-all/toggle on the diff actions', () => {
    const actions = diffActions()
    const entries = diffMenuItems({ hasSelection: true, mode: 'split', actions })
    entry(entries, 'diff-copy')?.onSelect()
    entry(entries, 'diff-select-all')?.onSelect()
    entry(entries, 'diff-toggle-display')?.onSelect()
    expect(actions.copy).toHaveBeenCalledTimes(1)
    expect(actions.selectAll).toHaveBeenCalledTimes(1)
    expect(actions.toggleDisplay).toHaveBeenCalledTimes(1)
  })

  it('writes every label in Chinese', () => {
    for (const mode of ['inline', 'split'] as const) {
      const labels = labelsOf(diffMenuItems({ hasSelection: true, mode, actions: diffActions() }))
      expect(labels.length).toBeGreaterThan(0)
      for (const label of labels) expect(label).toMatch(CJK)
    }
  })
})

describe('clipboard fallback decisions', () => {
  it('copies the selected text when there is a selection', () => {
    expect(copyFallbackText({ hasSelection: true, text: 'const answer = 42' })).toBe('const answer = 42')
  })

  it('does not touch the clipboard when nothing (or an empty string) is selected', () => {
    // 空选区写剪贴板会把用户原有的内容清掉，所以必须返回 undefined。
    expect(copyFallbackText({ hasSelection: false, text: '' })).toBeUndefined()
    expect(copyFallbackText({ hasSelection: true, text: '' })).toBeUndefined()
  })

  it('pastes only when the clipboard has content', () => {
    expect(pasteFallbackText('粘贴')).toBe('粘贴')
    expect(pasteFallbackText('')).toBeUndefined()
    expect(pasteFallbackText(undefined)).toBeUndefined()
  })
})

describe('keyboard menu placement', () => {
  const container = { left: 300, top: 100, width: 800, height: 600 }

  it('anchors the menu on the cursor line, offset by the editor container', () => {
    // 光标相对容器左上角 (40,120)，行高 18：菜单落在该行下方。
    expect(menuPositionAtCursor({ left: 40, top: 120, height: 18 }, container)).toEqual({ x: 340, y: 238 })
    // 行高缺失时至少落在行首，不产生 NaN。
    expect(menuPositionAtCursor({ left: 0, top: 0 }, container)).toEqual({ x: 300, y: 100 })
  })

  it('falls back to the editor center when the cursor is scrolled out of view', () => {
    expect(menuPositionAtCursor(null, container)).toEqual({ x: 700, y: 400 })
    expect(menuPositionAtCursor(undefined, { left: 0, top: 0, width: 200, height: 100 })).toEqual({ x: 100, y: 50 })
  })
})
