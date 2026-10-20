import { describe, expect, it, vi } from 'vitest'
import { clampMenuPosition, enabledIndexes, type MenuEntry } from '../src/client/ContextMenu.tsx'
import { explorerMenuItems, parentDirectory, tabMenuItems, terminalPaneMenuItems, workspaceAbsolutePath } from '../src/client/menus.ts'
import type { FileEntry } from '../src/types.ts'

/** 把菜单项压成「id + 是否禁用」的序列，断言起来比逐个字段比对清楚。 */
function shape(entries: readonly MenuEntry[]): string[] {
  return entries.map(entry => entry.kind === 'separator' ? '---' : `${entry.id}${entry.disabled === true ? '(禁用)' : ''}`)
}

const file: FileEntry = { name: 'a.ts', path: 'src/a.ts', kind: 'file' }
const directory: FileEntry = { name: 'src', path: 'src', kind: 'directory' }

function explorerActions() {
  return {
    open: vi.fn(), createFile: vi.fn(), createDirectory: vi.fn(), upload: vi.fn(),
    rename: vi.fn(), remove: vi.fn(), copy: vi.fn(), paste: vi.fn(),
    copyPath: vi.fn(), copyWorkspacePath: vi.fn(), openTerminal: vi.fn(), refresh: vi.fn(),
  }
}

describe('context menu placement', () => {
  it('opens where the pointer is when there is room', () => {
    expect(clampMenuPosition({ x: 40, y: 30 }, { width: 200, height: 300 }, { width: 1000, height: 800 })).toEqual({ left: 40, top: 30, flippedX: false, flippedY: false })
  })

  it('flips to the other side of the pointer instead of being squeezed into the viewport', () => {
    // 贴右边：菜单翻到指针左侧，而不是被夹到 x=792 那样离指针很远。
    expect(clampMenuPosition({ x: 990, y: 100 }, { width: 200, height: 300 }, { width: 1000, height: 800 })).toMatchObject({ left: 790, flippedX: true })
    // 贴底部：翻到指针上方。
    expect(clampMenuPosition({ x: 100, y: 790 }, { width: 200, height: 300 }, { width: 1000, height: 800 })).toMatchObject({ top: 490, flippedY: true })
  })

  it('keeps a margin when the menu is larger than the viewport', () => {
    expect(clampMenuPosition({ x: 5, y: 5 }, { width: 2000, height: 2000 }, { width: 800, height: 600 }, 8)).toEqual({ left: 8, top: 8, flippedX: true, flippedY: true })
  })

  it('skips separators and disabled items when moving with the keyboard', () => {
    const entries: MenuEntry[] = [
      { kind: 'item', id: 'a', label: 'A', onSelect: vi.fn() },
      { kind: 'separator' },
      { kind: 'item', id: 'b', label: 'B', disabled: true, onSelect: vi.fn() },
      { kind: 'item', id: 'c', label: 'C', onSelect: vi.fn() },
    ]
    expect(enabledIndexes(entries)).toEqual([0, 3])
  })
})

describe('explorer context menu', () => {
  it('offers the full file menu, with absolute path disabled until the workspace root is known', () => {
    const actions = explorerActions()
    expect(shape(explorerMenuItems({ entry: file, canPaste: false, actions }))).toEqual([
      'open', '---',
      'create-file', 'create-directory', 'upload', '---',
      'cut', 'copy', 'paste(禁用)', '---',
      'rename', 'delete', '---',
      'copy-relative-path', 'copy-absolute-path(禁用)', '---',
      'open-terminal',
    ])
    // 有绝对根时该项可用。
    const withRoot = explorerMenuItems({ entry: file, canPaste: true, absolute: 'H:/repo', actions })
    expect(shape(withRoot)).toContain('copy-absolute-path')
  })

  it('targets the directory itself for creation and the parent for files', () => {
    // 这一条是 VS Code 的语义，误在文件上「新建文件」到文件里会直接把操作弄失败。
    expect(parentDirectory('src/deep/a.ts')).toBe('src/deep')
    expect(parentDirectory('a.ts')).toBe('')
    expect(parentDirectory('src')).toBe('')
  })

  it('puts creation actions first for a directory, and refreshes from the blank area', () => {
    const actions = explorerActions()
    expect(shape(explorerMenuItems({ entry: directory, canPaste: true, actions }))[0]).toBe('create-file')
    expect(shape(explorerMenuItems({ entry: null, canPaste: false, actions }))).toEqual([
      'create-file', 'create-directory', 'upload', '---', 'paste(禁用)', '---', 'refresh', 'open-terminal',
    ])
  })

  it('runs the action bound to the clicked entry', () => {
    const actions = explorerActions()
    const entries = explorerMenuItems({ entry: file, canPaste: false, actions })
    const open = entries.find(entry => entry.kind === 'item' && entry.id === 'open')
    if (open?.kind === 'item') open.onSelect()
    expect(actions.open).toHaveBeenCalledWith(file)
    const terminal = entries.find(entry => entry.kind === 'item' && entry.id === 'open-terminal')
    if (terminal?.kind === 'item') terminal.onSelect()
    // 文件上的「在终端中打开」落在它所在目录。
    expect(actions.openTerminal).toHaveBeenCalledWith('src')
  })
})

describe('tab and terminal context menus', () => {
  const tabActions = () => ({ close: vi.fn(), closeOthers: vi.fn(), closeRight: vi.fn(), closeSaved: vi.fn(), togglePin: vi.fn(), copyPath: vi.fn(), openTerminal: vi.fn() })

  it('disables the bulk-close items that would do nothing', () => {
    const actions = tabActions()
    expect(shape(tabMenuItems({ path: 'src/a.ts', pinned: false, dirty: false, others: false, right: false, saved: false, actions }))).toEqual([
      'close', 'close-others(禁用)', 'close-right(禁用)', 'close-saved(禁用)', '---',
      'toggle-pin', '---',
      'copy-relative-path', 'copy-absolute-path(禁用)', '---',
      'open-terminal',
    ])
  })

  it('switches the pin label and hides path actions for a diff tab', () => {
    const actions = tabActions()
    const pinned = tabMenuItems({ path: 'src/a.ts', pinned: true, dirty: false, others: true, right: true, saved: true, absolute: 'H:/repo', actions })
    expect(pinned.find(entry => entry.kind === 'item' && entry.id === 'toggle-pin')).toMatchObject({ label: '取消固定' })
    expect(shape(tabMenuItems({ path: 'diff:src/a.ts', pinned: false, dirty: false, others: true, right: true, saved: true, actions }))).toContain('copy-relative-path(禁用)')
  })

  it('offers clipboard and lifecycle actions for a terminal pane', () => {
    const actions = { newTerminal: vi.fn(), split: vi.fn(), rename: vi.fn(), kill: vi.fn(), copySelection: vi.fn(), paste: vi.fn(), selectAll: vi.fn(), clear: vi.fn() }
    const entries = terminalPaneMenuItems({ hasSelection: false, canSplit: true, actions })
    expect(shape(entries)).toEqual([
      'terminal-new', 'terminal-split', '---',
      'terminal-copy(禁用)', 'terminal-paste', 'terminal-select-all', 'terminal-clear', '---',
      'terminal-rename', 'terminal-kill',
    ])
    // 破坏性项用警示色。
    expect(entries.find(entry => entry.kind === 'item' && entry.id === 'terminal-kill')).toMatchObject({ danger: true })
  })
})

describe('workspace absolute paths', () => {
  it('joins with the separator the workspace root already uses', () => {
    // Windows 根是反斜杠、posix 是正斜杠：贴给别人的路径不该出现 H:\repo/src/a.ts 这种混合写法。
    expect(workspaceAbsolutePath('H:/repo', 'src/a.ts')).toBe('H:/repo/src/a.ts')
    expect(workspaceAbsolutePath('H:\\repo', 'src/a.ts')).toBe('H:\\repo\\src\\a.ts')
    expect(workspaceAbsolutePath('/home/me', 'a.ts')).toBe('/home/me/a.ts')
    // 根目录本身与结尾多余的斜杠都要归一。
    expect(workspaceAbsolutePath('H:/repo', '')).toBe('H:/repo')
    expect(workspaceAbsolutePath('H:/repo/', '')).toBe('H:/repo')
  })
})

describe('explorer menu wiring', () => {
  const run = (entries: readonly MenuEntry[], id: string) => {
    const found = entries.find(entry => entry.kind === 'item' && entry.id === id)
    if (found?.kind === 'item') found.onSelect()
  }

  it('adds the workspace path and terminal entries to the blank-area menu', () => {
    const actions = explorerActions()
    const entries = explorerMenuItems({ entry: null, canPaste: true, absolute: 'H:/repo', actions })
    expect(shape(entries)).toEqual([
      'create-file', 'create-directory', 'upload', '---', 'paste', '---', 'refresh', 'copy-workspace-path', 'open-terminal',
    ])
    // 空白处右键：新建/上传/终端都作用在工作区根，而不是上一次选中的目录。
    run(entries, 'copy-workspace-path'); run(entries, 'open-terminal'); run(entries, 'create-file'); run(entries, 'refresh')
    expect(actions.copyWorkspacePath).toHaveBeenCalledTimes(1)
    expect(actions.openTerminal).toHaveBeenCalledWith('')
    expect(actions.createFile).toHaveBeenCalledWith('')
    expect(actions.refresh).toHaveBeenCalledTimes(1)
  })

  it("targets a file's parent directory for creation and paste", () => {
    const actions = explorerActions()
    const entries = explorerMenuItems({ entry: file, canPaste: true, absolute: 'H:/repo', actions })
    run(entries, 'create-file'); run(entries, 'create-directory'); run(entries, 'upload'); run(entries, 'paste')
    expect(actions.createFile).toHaveBeenCalledWith('src')
    expect(actions.createDirectory).toHaveBeenCalledWith('src')
    expect(actions.upload).toHaveBeenCalledWith('src')
    expect(actions.paste).toHaveBeenCalledWith('src')
  })

  it('binds clipboard, rename, delete, path and terminal actions to the clicked entry', () => {
    const actions = explorerActions()
    const entries = explorerMenuItems({ entry: directory, canPaste: false, absolute: 'H:/repo', actions })
    run(entries, 'copy'); run(entries, 'cut'); run(entries, 'rename'); run(entries, 'delete')
    run(entries, 'copy-relative-path'); run(entries, 'copy-absolute-path'); run(entries, 'open-terminal')
    expect(actions.copy).toHaveBeenCalledWith(directory, 'copy')
    expect(actions.copy).toHaveBeenCalledWith(directory, 'cut')
    expect(actions.rename).toHaveBeenCalledWith(directory)
    expect(actions.remove).toHaveBeenCalledWith(directory)
    expect(actions.copyPath).toHaveBeenCalledWith(directory, false)
    expect(actions.copyPath).toHaveBeenCalledWith(directory, true)
    // 目录上的「在终端中打开」落在它自己。
    expect(actions.openTerminal).toHaveBeenCalledWith('src')
  })

  it('labels every entry in Chinese', () => {
    const actions = explorerActions()
    const tabActions = { close: vi.fn(), closeOthers: vi.fn(), closeRight: vi.fn(), closeSaved: vi.fn(), togglePin: vi.fn(), copyPath: vi.fn(), openTerminal: vi.fn() }
    const labels = [
      ...explorerMenuItems({ entry: file, canPaste: true, absolute: 'H:/repo', actions }),
      ...explorerMenuItems({ entry: directory, canPaste: true, actions }),
      ...explorerMenuItems({ entry: null, canPaste: false, actions }),
      ...tabMenuItems({ path: 'src/a.ts', pinned: false, dirty: false, others: true, right: true, saved: true, absolute: 'H:/repo', actions: tabActions }),
    ].flatMap(entry => entry.kind === 'item' ? [entry.label] : [])
    expect(labels.length).toBeGreaterThan(20)
    for (const label of labels) expect(label).toMatch(/[\u4e00-\u9fff]/)
  })
})

describe('tab menu wiring', () => {
  const actions = () => ({ close: vi.fn(), closeOthers: vi.fn(), closeRight: vi.fn(), closeSaved: vi.fn(), togglePin: vi.fn(), copyPath: vi.fn(), openTerminal: vi.fn() })
  const run = (entries: readonly MenuEntry[], id: string) => {
    const found = entries.find(entry => entry.kind === 'item' && entry.id === id)
    if (found?.kind === 'item') found.onSelect()
  }

  it('runs the bulk-close, pin and path actions the tab menu offers', () => {
    const bound = actions()
    const entries = tabMenuItems({ path: 'src/a.ts', pinned: false, dirty: false, others: true, right: true, saved: true, absolute: 'H:/repo', actions: bound })
    for (const id of ['close', 'close-others', 'close-right', 'close-saved', 'toggle-pin', 'copy-relative-path', 'copy-absolute-path', 'open-terminal']) run(entries, id)
    expect(bound.close).toHaveBeenCalledTimes(1)
    expect(bound.closeOthers).toHaveBeenCalledTimes(1)
    expect(bound.closeRight).toHaveBeenCalledTimes(1)
    expect(bound.closeSaved).toHaveBeenCalledTimes(1)
    expect(bound.togglePin).toHaveBeenCalledTimes(1)
    expect(bound.copyPath).toHaveBeenNthCalledWith(1, false)
    expect(bound.copyPath).toHaveBeenNthCalledWith(2, true)
    expect(bound.openTerminal).toHaveBeenCalledTimes(1)
  })
})
