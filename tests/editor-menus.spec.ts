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

const isItem = (entry: MenuEntry): entry is MenuItem => entry.kind === 'item'

/** 顶层按 id 找 —— 父项与顶层单项都在这一层。 */
function topEntry(entries: readonly MenuEntry[], id: string): MenuItem | undefined {
  return entries.find((candidate): candidate is MenuItem => candidate.kind === 'item' && candidate.id === id)
}

/**
 * 递归拍平所有**叶子项**（跳过父项与分隔线）。
 *
 * 为什么仍然单独抽「叶子」：父项（`*-menu`）与叶子承担不同职责，禁用矩阵和 commandId 断言只
 * 关心真正会被执行的叶子；这样父项的展开语义（onSelect 是空操作）不会被误当成叶子动作。
 */
function leaves(entries: readonly MenuEntry[]): MenuItem[] {
  return entries.flatMap(entry => {
    if (entry.kind === 'separator') return []
    return entry.submenu === undefined ? [entry] : leaves(entry.submenu)
  })
}

function leaf(entries: readonly MenuEntry[], id: string): MenuItem | undefined {
  return leaves(entries).find(candidate => candidate.id === id)
}

function disabledLeafIds(entries: readonly MenuEntry[]): string[] {
  return leaves(entries).flatMap(candidate => candidate.disabled === true ? [candidate.id] : [])
}

/** 递归收集所有 label（含父项），用来钉住「菜单文案全中文」。 */
function allLabels(entries: readonly MenuEntry[]): string[] {
  return entries.flatMap(entry => entry.kind === 'separator'
    ? []
    : [entry.label, ...(entry.submenu === undefined ? [] : allLabels(entry.submenu))])
}

/** 递归收集所有菜单项 id（父项 + 叶子），用来断言「整张菜单 id 全表唯一」。 */
function allItemIds(entries: readonly MenuEntry[]): string[] {
  return entries.flatMap(entry => entry.kind === 'separator'
    ? []
    : [entry.id, ...(entry.submenu === undefined ? [] : allItemIds(entry.submenu))])
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

/** 父项禁用规则：父项 disabled ⇔ 它的所有叶子都 disabled。所有场景都成立。 */
function expectParentsFollowLeaves(entries: readonly MenuEntry[]): void {
  for (const parent of entries) {
    if (parent.kind !== 'item' || parent.submenu === undefined) continue
    const children = parent.submenu.filter(isItem)
    expect(children.length, `父项 ${parent.id} 应有叶子项`).toBeGreaterThan(0)
    expect(parent.disabled === true, `父项 ${parent.id} 的禁用状态应等于「所有叶子禁用」`).toBe(children.every(child => child.disabled === true))
  }
}

describe('source editor top-level structure', () => {
  it('keeps the top level short: five singles, six groups, then save', () => {
    expect(shape(editorMenuItems(context()))).toEqual([
      'editor-undo', 'editor-redo', 'editor-cut', 'editor-copy', 'editor-paste', '---',
      'editor-select-menu', 'editor-find-menu', 'editor-goto-menu',
      'editor-lines-menu', 'editor-convert-menu', 'editor-format-menu', '---',
      'editor-save',
    ])
  })

  it('puts each group behind a submenu with the expected leaf order', () => {
    const entries = editorMenuItems(context())
    const submenu = (id: string): string[] | undefined => {
      const parent = topEntry(entries, id)
      return parent?.submenu === undefined ? undefined : shape(parent.submenu)
    }
    expect(submenu('editor-select-menu')).toEqual([
      'editor-select-all', 'editor-select-highlights', '---',
      'editor-cursor-above', 'editor-cursor-below',
    ])
    expect(submenu('editor-find-menu')).toEqual(['editor-find', 'editor-replace', 'editor-goto-line'])
    expect(submenu('editor-goto-menu')).toEqual(['editor-reveal-definition', 'editor-find-references', 'editor-rename-symbol'])
    expect(submenu('editor-lines-menu')).toEqual([
      'editor-move-line-up', 'editor-move-line-down', 'editor-copy-line-down', 'editor-delete-line', '---',
      'editor-indent-lines', 'editor-outdent-lines',
    ])
    expect(submenu('editor-convert-menu')).toEqual([
      'editor-transform-uppercase', 'editor-transform-lowercase', '---',
      'editor-comment-line', 'editor-block-comment',
    ])
    expect(submenu('editor-format-menu')).toEqual([
      'editor-format', 'editor-format-selection', '---',
      'editor-fold', 'editor-unfold',
    ])
  })

  it('never nests a third level: submenu items have no submenu of their own', () => {
    for (const parent of editorMenuItems(context())) {
      if (parent.kind !== 'item' || parent.submenu === undefined) continue
      for (const child of parent.submenu) {
        if (child.kind === 'item') expect(child.submenu).toBeUndefined()
      }
    }
  })

  it('makes group parents expand-only: no shortcut and onSelect does nothing', () => {
    const actions = editorActions()
    for (const parent of editorMenuItems(context({ actions }))) {
      if (parent.kind !== 'item' || parent.submenu === undefined) continue
      expect(parent.shortcut).toBeUndefined()
      parent.onSelect()
    }
    expect(actions.run).not.toHaveBeenCalled()
    expect(actions.save).not.toHaveBeenCalled()
  })

  it('keeps the 30 existing leaf ids in menu order', () => {
    expect(leaves(editorMenuItems(context())).map(candidate => candidate.id)).toEqual([
      'editor-undo', 'editor-redo', 'editor-cut', 'editor-copy', 'editor-paste',
      'editor-select-all', 'editor-select-highlights', 'editor-cursor-above', 'editor-cursor-below',
      'editor-find', 'editor-replace', 'editor-goto-line',
      'editor-reveal-definition', 'editor-find-references', 'editor-rename-symbol',
      'editor-move-line-up', 'editor-move-line-down', 'editor-copy-line-down', 'editor-delete-line',
      'editor-indent-lines', 'editor-outdent-lines',
      'editor-transform-uppercase', 'editor-transform-lowercase',
      'editor-comment-line', 'editor-block-comment',
      'editor-format', 'editor-format-selection', 'editor-fold', 'editor-unfold',
      'editor-save',
    ])
  })

  it('keeps every item id unique across both levels; group parents use a -menu suffix', () => {
    const entries = editorMenuItems(context())
    // 全表（父项 + 叶子，不分层级）不允许撞 id：埋点/测试按 id 查时没有层级歧义。
    const allIds = allItemIds(entries)
    expect(allIds).toHaveLength(36) // 12 个顶层项（5 单项 + 6 父项 + 保存）+ 24 个子菜单项
    expect(new Set(allIds).size).toBe(allIds.length)

    const parents = entries.filter(isItem).filter(candidate => candidate.submenu !== undefined)
    expect(parents.map(candidate => candidate.id)).toEqual([
      'editor-select-menu', 'editor-find-menu', 'editor-goto-menu',
      'editor-lines-menu', 'editor-convert-menu', 'editor-format-menu',
    ])
    for (const parent of parents) expect(parent.id.endsWith('-menu')).toBe(true)
    // 既有叶子 id 保持不带后缀；「查找」「格式化」两个叶子与父项不再重名。
    expect(leaf(entries, 'editor-find')?.submenu).toBeUndefined()
    expect(leaf(entries, 'editor-format')?.submenu).toBeUndefined()
    expect(topEntry(entries, 'editor-find')).toBeUndefined()
    expect(topEntry(entries, 'editor-format')).toBeUndefined()
  })
})

describe('leaf disabled matrix', () => {
  it('disables cut/copy/selection transforms when there is no selected text', () => {
    const entries = editorMenuItems(context({ hasSelection: false }))
    expect(disabledLeafIds(entries).sort()).toEqual([
      'editor-copy',
      'editor-cut',
      'editor-format-selection',
      'editor-select-highlights',
      'editor-transform-lowercase',
      'editor-transform-uppercase',
    ].sort())
    // 粘贴、全选、行操作不依赖本编辑器当前选区，不能被连坐。
    expect(leaf(entries, 'editor-paste')?.disabled).not.toBe(true)
    expect(leaf(entries, 'editor-select-all')?.disabled).not.toBe(true)
  })

  it('disables editing commands on a read-only model but keeps view/navigation commands usable', () => {
    const entries = editorMenuItems(context({ readOnly: true }))
    expect(disabledLeafIds(entries).sort()).toEqual([
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
    for (const id of ['editor-copy', 'editor-select-all', 'editor-find', 'editor-fold', 'editor-save']) {
      expect(leaf(entries, id)?.disabled).not.toBe(true)
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
    expect(disabledLeafIds(entries).sort()).toEqual([
      'editor-find-references',
      'editor-rename-symbol',
      'editor-reveal-definition',
      'editor-select-highlights',
    ].sort())
    expect(leaf(entries, 'editor-format')?.disabled).not.toBe(true)
  })

  it('disables formatting when Monaco reports no formatter for the document', () => {
    const entries = editorMenuItems(context({ canFormat: false }))
    expect(disabledLeafIds(entries).sort()).toEqual(['editor-format', 'editor-format-selection'])
    expect(leaf(editorMenuItems(context({ canFormat: true })), 'editor-format')?.disabled).not.toBe(true)
  })
})

describe('parent disabled rules', () => {
  it('disables the 行操作/转换 groups when every leaf in them is disabled by read-only', () => {
    const entries = editorMenuItems(context({ readOnly: true }))
    expect(topEntry(entries, 'editor-lines-menu')).toMatchObject({ label: '行操作', disabled: true })
    expect(topEntry(entries, 'editor-convert-menu')).toMatchObject({ label: '转换', disabled: true })
    // 只读时选择/查找/转到/格式化仍有可用叶子，父项保持可展开。
    for (const id of ['editor-select-menu', 'editor-find-menu', 'editor-goto-menu', 'editor-format-menu']) {
      expect(topEntry(entries, id)?.disabled).not.toBe(true)
    }
  })

  it('disables the 转到 group for plain-text files, where all three language leaves are unsupported', () => {
    const entries = editorMenuItems(context({ isSupported: () => false }))
    expect(topEntry(entries, 'editor-goto-menu')).toMatchObject({ label: '转到', disabled: true })
    expect(topEntry(entries, 'editor-select-menu')?.disabled).not.toBe(true)
  })

  it('keeps the 格式化 group expandable while 折叠/展开 are available', () => {
    // 任务描述里的例子预期这里父项禁用，但折叠/展开是始终可用的视图操作；
    // 按「父项在所有叶子禁用时才禁用」的规则，父项必须保持可展开。
    const entries = editorMenuItems(context({ canFormat: false, hasSelection: false }))
    expect(topEntry(entries, 'editor-format-menu')?.disabled).not.toBe(true)
    expect(leaf(entries, 'editor-format')?.disabled).toBe(true)
    expect(leaf(entries, 'editor-format-selection')?.disabled).toBe(true)
    expect(leaf(entries, 'editor-fold')?.disabled).not.toBe(true)
    expect(leaf(entries, 'editor-unfold')?.disabled).not.toBe(true)
  })

  it('keeps every parent disabled exactly when all of its leaves are disabled, in every scenario', () => {
    for (const overrides of [
      {},
      { hasSelection: false },
      { readOnly: true },
      { canFormat: false },
      { isSupported: () => false },
      { readOnly: true, hasSelection: false, canFormat: false },
    ] as const) {
      expectParentsFollowLeaves(editorMenuItems(context(overrides)))
    }
  })
})

describe('leaf command routing', () => {
  it('runs the expected Monaco command for representative leaves', () => {
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
      leaf(entries, id)?.onSelect()
      expect(actions.run).toHaveBeenLastCalledWith(commandId)
    }
    expect(actions.run).toHaveBeenCalledTimes(expected.length)
  })

  it('routes every leaf through actions.run, and saves through the save callback', () => {
    const actions = editorActions()
    const entries = editorMenuItems(context({ actions }))
    const allLeaves = leaves(entries)
    expect(allLeaves).toHaveLength(30)
    for (const candidate of allLeaves) candidate.onSelect()
    const commands = actions.run.mock.calls.map(([commandId]) => commandId)
    // 30 个叶子里只有「保存」不是 Monaco 命令。
    expect(commands).toHaveLength(29)
    expect(commands.every(commandId => commandId.length > 0)).toBe(true)
    expect(new Set(commands).size).toBe(commands.length)
    expect(actions.save).toHaveBeenCalledTimes(1)
    expect(actions.run).not.toHaveBeenCalledWith('editor-save')
  })

  it('shows display-only shortcuts on the leaves that have keybindings', () => {
    const entries = editorMenuItems(context())
    for (const id of ['editor-undo', 'editor-cut', 'editor-copy', 'editor-find', 'editor-format', 'editor-reveal-definition', 'editor-save']) {
      expect(leaf(entries, id)?.shortcut).toBeTruthy()
    }
  })

  it('writes every label in Chinese (parents and leaves)', () => {
    const labels = allLabels(editorMenuItems(context()))
    // 12 个顶层项（5 单项 + 6 子菜单 + 保存）+ 24 个子菜单项。
    expect(labels).toHaveLength(36)
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
    expect(topEntry(inline, 'diff-toggle-display')).toMatchObject({ label: '切换到并排显示', icon: 'diff-sidebyside' })
    const split = diffMenuItems({ hasSelection: true, mode: 'split', actions: diffActions() })
    expect(topEntry(split, 'diff-toggle-display')).toMatchObject({ label: '切换到行内显示', icon: 'diff-single' })
  })

  it('runs copy/select-all/toggle on the diff actions', () => {
    const actions = diffActions()
    const entries = diffMenuItems({ hasSelection: true, mode: 'split', actions })
    topEntry(entries, 'diff-copy')?.onSelect()
    topEntry(entries, 'diff-select-all')?.onSelect()
    topEntry(entries, 'diff-toggle-display')?.onSelect()
    expect(actions.copy).toHaveBeenCalledTimes(1)
    expect(actions.selectAll).toHaveBeenCalledTimes(1)
    expect(actions.toggleDisplay).toHaveBeenCalledTimes(1)
  })

  it('writes every label in Chinese', () => {
    for (const mode of ['inline', 'split'] as const) {
      const labels = allLabels(diffMenuItems({ hasSelection: true, mode, actions: diffActions() }))
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
