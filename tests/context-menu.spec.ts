import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { clampMenuPosition, clampSubmenuPosition, enabledIndexes, separator, SUBMENU_HOVER_MS, type MenuEntry } from '../src/client/ContextMenu.tsx'
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

/**
 * 子菜单（第二级）的落点。
 *
 * 这段逻辑必须是纯函数：node 环境不渲染 React，靠它把「右侧优先 / 放不下翻左 / 垂直夹取」
 * 钉死；组件的键盘与悬停行为再用下方的源码静态断言兜住。
 */
describe('submenu placement', () => {
  const anchor = { left: 100, top: 100, width: 200, height: 28 }
  const viewport = { width: 1000, height: 800 }

  it('opens to the right of its parent when there is room', () => {
    expect(clampSubmenuPosition(anchor, { width: 200, height: 300 }, viewport)).toEqual({ left: 300, top: 100, flippedX: false })
  })

  it('flips to the left of the parent instead of being squeezed at the right edge', () => {
    // 父项右边放不下：子菜单翻到父项左侧，左边缘与父项右边缘的关系保持可读。
    expect(clampSubmenuPosition({ ...anchor, left: 800 }, { width: 200, height: 300 }, viewport)).toEqual({ left: 600, top: 100, flippedX: true })
    // 自定义 margin 也参与翻转判定与夹取。
    expect(clampSubmenuPosition({ ...anchor, left: 950 }, { width: 200, height: 100 }, viewport, 20)).toEqual({ left: 750, top: 100, flippedX: true })
  })

  it('clamps the submenu inside the viewport vertically', () => {
    // 靠近底部：整体上移到还放得下的位置，而不是从底部溢出。
    expect(clampSubmenuPosition({ ...anchor, top: 780 }, { width: 200, height: 300 }, viewport).top).toBe(492)
    // 顶部越界：夹回 margin。
    expect(clampSubmenuPosition({ ...anchor, top: 2 }, { width: 200, height: 300 }, viewport).top).toBe(8)
    // 比视口还高：贴上边，靠子菜单自己的 max-height 滚动。
    expect(clampSubmenuPosition({ ...anchor, top: 0 }, { width: 200, height: 2000 }, { width: 1000, height: 600 }, 8).top).toBe(8)
  })
})

describe('submenu menu structure', () => {
  it('keeps a submenu parent focusable and allows separators inside the second level', () => {
    const entries: MenuEntry[] = [
      { kind: 'item', id: 'parent', label: '父项', submenu: [separator(), { kind: 'item', id: 'child', label: '子项', onSelect: vi.fn() }], onSelect: vi.fn() },
      separator(),
    ]
    // 父项与普通项一样参与键盘漫游；子菜单里的分隔线不算可聚焦项。
    expect(enabledIndexes(entries)).toEqual([0])
    const parent = entries[0]
    expect(parent?.kind === 'item' ? shape(parent.submenu ?? []) : undefined).toEqual(['---', 'child'])
  })

  it('uses a short hover delay so sweeping the pointer does not pop every submenu', () => {
    expect(SUBMENU_HOVER_MS).toBe(120)
  })
})

/**
 * 渲染契约的静态断言。
 *
 * 不引入 jsdom：组件里「父子两级菜单」的接线（ARIA、箭头、展开/收起、定位函数调用）只靠
 * 源码文本断言钉住，配合上面的纯函数测试，避免以后重构时无声地删掉可访问性或键盘入口。
 */
describe('submenu rendering contract', () => {
  const source = () => readFileSync(new URL('../src/client/ContextMenu.tsx', import.meta.url), 'utf8')

  it('marks the parent item as a menu opener and renders the second level as .dvw-submenu', () => {
    const text = source()
    expect(text).toContain('aria-haspopup')
    expect(text).toContain("? 'menu' : undefined")
    expect(text).toContain('aria-expanded')
    expect(text).toContain('dvw-submenu')
    expect(text).toContain('<Icon name="chevron-right"/>')
    // 子菜单的无障碍名称由父项 label 拼出来，屏幕阅读器才知道它属于哪一项。
    expect(text).toContain('`${parentItem.label} 子菜单`')
  })

  it('opens the second level from hover, click and the keyboard', () => {
    const text = source()
    // 悬停：120ms 延迟后展开。
    expect(text).toMatch(/setTimeout\(\(\) => \{ hoverTimer\.current = undefined; openSubmenu\(index\) \}, SUBMENU_HOVER_MS\)/)
    // 点击父项：展开而不是执行 onSelect。
    expect(text).toContain("if (context === 'root' && entry.submenu !== undefined) { openSubmenu(index); return }")
    // 键盘：ArrowRight 展开；Enter 在父项上同样展开。
    expect(text).toContain("if (event.key === 'ArrowRight')")
    expect(text).toContain('if (entry.submenu !== undefined) { openSubmenu(active); return }')
  })

  it('closes the second level layer by layer and keeps keyboard navigation inside it', () => {
    const text = source()
    // ArrowLeft 只收子菜单并交还高亮；Esc 在 window 捕获阶段先收子菜单。
    expect(text).toContain('if (event.key === \'ArrowLeft\') { event.preventDefault(); closeSubmenu(); root.current?.focus(); return }')
    expect(text).toContain('if (submenuIndexRef.current !== undefined) { closeSubmenu(); return }')
    // 子菜单开着时方向键在第二级里移动，Enter 执行叶子项并关闭全部（run 里先 onClose）。
    expect(text).toContain('if (submenuEntries !== undefined) {')
    expect(text).toContain('moveSubmenu(1)')
  })

  it('positions the second level with the exported pure function', () => {
    expect(source()).toMatch(/clampSubmenuPosition\(\{ left: rect\.left, top: rect\.top, width: rect\.width, height: rect\.height \}/)
  })
})
