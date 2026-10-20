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

function itemIds(entries: readonly MenuEntry[]): string[] {
  return entries.flatMap(candidate => candidate.kind === 'item' ? [candidate.id] : [])
}

function disabledIds(entries: readonly MenuEntry[]): string[] {
  return entries.flatMap(candidate => candidate.kind === 'item' && candidate.disabled === true ? [candidate.id] : [])
}

function labelsOf(entries: readonly MenuEntry[]): string[] {
  return entries.flatMap(candidate => candidate.kind === 'item' ? [candidate.label] : [])
}

/** 每个 label 至少含一个 CJK 字符；英文标签（Monaco 内置菜单那种）会立刻失败。 */
const CJK = /[\u4e00-\u9fff]/

function editorActions() {
  return {
    undo: vi.fn(), redo: vi.fn(), cut: vi.fn(), copy: vi.fn(), paste: vi.fn(),
    selectAll: vi.fn(), find: vi.fn(), replace: vi.fn(), gotoLine: vi.fn(),
    commentLine: vi.fn(), format: vi.fn(), fold: vi.fn(), unfold: vi.fn(), save: vi.fn(),
    run: vi.fn<(commandId: string) => void>(),
  }
}

function context(overrides: Partial<Pick<EditorMenuContext, 'readOnly' | 'hasSelection' | 'canFormat' | 'isSupported' | 'actions'>> = {}): EditorMenuContext {
  return { readOnly: false, hasSelection: true, canFormat: true, isSupported: () => true, actions: editorActions(), ...overrides }
}

function diffActions(): DiffMenuActions {
  return { copy: vi.fn(), selectAll: vi.fn(), toggleDisplay: vi.fn() }
}

describe('source editor context menu', () => {
  it('groups the items in the order requested for the VS Code-style menu', () => {
    expect(shape(editorMenuItems(context()))).toEqual([
      'editor-undo', 'editor-redo', 'editor-cut', 'editor-copy', 'editor-paste', '---',
      'editor-select-all', 'editor-select-highlights', '---',
      'editor-find', 'editor-replace', 'editor-goto-line', '---',
      'editor-reveal-definition', 'editor-find-references', 'editor-rename-symbol', '---',
      'editor-move-line-up', 'editor-move-line-down', 'editor-copy-line-down', 'editor-delete-line',
      'editor-indent-lines', 'editor-outdent-lines',
      'editor-transform-uppercase', 'editor-transform-lowercase', '---',
      'editor-cursor-above', 'editor-cursor-below', '---',
      'editor-comment-line', 'editor-block-comment',
      'editor-format', 'editor-format-selection',
      'editor-fold', 'editor-unfold', '---',
      'editor-save',
    ])
  })

  it('keeps ids unique so the menu can be keyed and asserted on', () => {
    const ids = itemIds(editorMenuItems(context()))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('disables cut/copy/selection transforms when there is no selected text', () => {
    const disabled = disabledIds(editorMenuItems(context({ hasSelection: false }))).sort()
    expect(disabled).toEqual([
      'editor-copy',
      'editor-cut',
      'editor-format-selection',
      'editor-select-highlights',
      'editor-transform-lowercase',
      'editor-transform-uppercase',
    ].sort())
    // 粘贴、全选、行操作不依赖本编辑器当前选区，不能被连坐。
    const entries = editorMenuItems(context({ hasSelection: false }))
    expect(entry(entries, 'editor-paste')?.disabled).not.toBe(true)
    expect(entry(entries, 'editor-select-all')?.disabled).not.toBe(true)
  })

  it('disables editing commands on a read-only model but keeps view/navigation commands usable', () => {
    const entries = editorMenuItems(context({ readOnly: true }))
    expect(disabledIds(entries).sort()).toEqual([
      'editor-block-comment',
      'editor-comment-line',
      'editor-copy-line-down',
      'editor-cut',
      'editor-delete-line',
      'editor-format',
      'editor-format-selection',
      'editor-indent-lines',
      'editor-move-line-down',
      'editor-move-line-up',
      'editor-outdent-lines',
      'editor-paste',
      'editor-redo',
      'editor-transform-lowercase',
      'editor-transform-uppercase',
      'editor-undo',
    ].sort())
    // 只读时复制、查找、折叠、保存仍然有意义（VS Code 同样保留）。
    for (const id of ['editor-copy', 'editor-select-all', 'editor-find', 'editor-fold', 'editor-save']) {
      expect(entry(entries, id)?.disabled).not.toBe(true)
    }
  })

  it('asks the language service only about the commands that have a provider', () => {
    const isSupported = vi.fn((_commandId: string) => true)
    editorMenuItems(context({ isSupported }))
    expect(new Set(isSupported.mock.calls.map(([commandId]) => commandId))).toEqual(new Set([
      'editor.action.selectHighlights',
      'editor.action.revealDefinition',
      'editor.action.referenceSearch.trigger',
      'editor.action.rename',
    ]))
  })

  it('disables language-service commands when Monaco reports them unsupported (plain text files)', () => {
    const entries = editorMenuItems(context({ isSupported: () => false }))
    expect(disabledIds(entries).sort()).toEqual([
      'editor-find-references',
      'editor-rename-symbol',
      'editor-reveal-definition',
      'editor-select-highlights',
    ].sort())
    // 其余编辑项不参与语言服务判定。
    expect(entry(entries, 'editor-format')?.disabled).not.toBe(true)
  })

  it('disables formatting when Monaco reports no formatter for the document', () => {
    const disabled = disabledIds(editorMenuItems(context({ canFormat: false }))).sort()
    expect(disabled).toEqual(['editor-format', 'editor-format-selection'])
    expect(entry(editorMenuItems(context({ canFormat: true })), 'editor-format')?.disabled).not.toBe(true)
  })

  it('runs the expected Monaco command for representative items', () => {
    const actions = editorActions()
    const entries = editorMenuItems(context({ actions }))
    const expected: Array<[string, string]> = [
      ['editor-undo', 'undo'],
      ['editor-redo', 'redo'],
      ['editor-copy', 'editor.action.clipboardCopyAction'],
      ['editor-select-highlights', 'editor.action.selectHighlights'],
      ['editor-reveal-definition', 'editor.action.revealDefinition'],
      ['editor-move-line-up', 'editor.action.moveLinesUpAction'],
      ['editor-cursor-below', 'editor.action.insertCursorBelow'],
      ['editor-format-selection', 'editor.action.formatSelection'],
      ['editor-fold', 'editor.fold'],
    ]
    for (const [id, commandId] of expected) {
      entry(entries, id)?.onSelect()
      expect(actions.run).toHaveBeenLastCalledWith(commandId)
    }
    expect(actions.run).toHaveBeenCalledTimes(expected.length)
  })

  it('routes every command item through actions.run, and saves through the save callback', () => {
    const actions = editorActions()
    const entries = editorMenuItems(context({ actions }))
    for (const candidate of entries) {
      if (candidate.kind === 'item') candidate.onSelect()
    }
    const commands = actions.run.mock.calls.map(([commandId]) => commandId)
    // 30 个菜单项里只有「保存」不是 Monaco 命令。
    expect(commands).toHaveLength(29)
    expect(commands.every(commandId => commandId.length > 0)).toBe(true)
    expect(new Set(commands).size).toBe(commands.length)
    expect(actions.save).toHaveBeenCalledTimes(1)
    expect(actions.run).not.toHaveBeenCalledWith('editor-save')
  })

  it('shows display-only shortcuts on the items that have keybindings', () => {
    const entries = editorMenuItems(context())
    for (const id of ['editor-undo', 'editor-cut', 'editor-copy', 'editor-find', 'editor-format', 'editor-reveal-definition', 'editor-save']) {
      expect(entry(entries, id)?.shortcut).toBeTruthy()
    }
  })

  it('writes every label in Chinese', () => {
    const labels = labelsOf(editorMenuItems(context()))
    expect(labels).toHaveLength(30)
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
