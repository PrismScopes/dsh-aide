import type { FileEntry } from '../types.ts'
import { separator, type MenuEntry, type MenuItem } from './ContextMenu.tsx'

/**
 * 各处右键菜单的**内容**（纯数据）。
 *
 * 与画法分开：菜单项只描述「有哪些项、什么图标、是否禁用、点了做什么」，不碰 DOM。
 * 于是可以单测「资源管理器对文件/目录/空白分别给哪些项」「标签页的关闭其他在没有其他标签时是否禁用」，
 * 而不需要渲染 React 或模拟指针事件。
 */

const item = (value: Omit<MenuItem, 'kind'>): MenuItem => ({ kind: 'item', ...value })

/** 父目录（工作区相对路径，根为 ''）。 */
export function parentDirectory(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

/**
 * 把工作区相对路径拼成绝对路径（「复制绝对路径」用）。
 *
 * 不能直接 `${cwd}/${path}`：Windows 的工作区根是 `H:\repo` 这种反斜杠形式，
 * 拼出来会变成 `H:\repo/src/a.ts` 这种两端都能用、但贴给别人就不像真的路径的混合写法。
 * 这里按根目录实际用的分隔符来拼，跨平台都不别扭。
 */
export function workspaceAbsolutePath(cwd: string, path: string): string {
  const base = cwd.replace(/[\\/]+$/, '')
  if (path === '') return base
  const separator = base.includes('\\') ? '\\' : '/'
  return `${base}${separator}${path.split('/').join(separator)}`
}

export interface FileClipboard { op: 'copy' | 'cut'; path: string; kind: 'file' | 'directory' }

export interface ExplorerMenuActions {
  open(entry: FileEntry): void
  createFile(directory: string): void
  createDirectory(directory: string): void
  upload(directory: string): void
  rename(entry: FileEntry): void
  remove(entry: FileEntry): void
  copy(entry: FileEntry, op: 'copy' | 'cut'): void
  paste(directory: string): void
  copyPath(entry: FileEntry, absolute: boolean): void
  copyWorkspacePath(): void
  openTerminal(directory: string): void
  refresh(): void
}

export interface ExplorerMenuContext {
  /** 右键落在哪一项；null 表示落在空白处（工作区根）。 */
  entry: FileEntry | null
  /** 文件剪贴板里有没有东西，决定「粘贴」是否可用。 */
  canPaste: boolean
  /** 已知工作区绝对路径时才提供绝对路径相关的项。 */
  absolute?: string
  actions: ExplorerMenuActions
}

/**
 * 资源管理器菜单。
 *
 * 覆盖 VS Code 资源管理器里真正会用到的那些项，并按「打开 / 新建 / 剪贴板 / 改名删除 / 路径 / 终端」
 * 分组：分组之间的分隔线比给每项加图标更能说明一件事属于哪一类。
 */
export function explorerMenuItems(context: ExplorerMenuContext): MenuEntry[] {
  const { entry, canPaste, absolute, actions } = context
  if (entry === null) {
    const entries: MenuEntry[] = [
      item({ id: 'create-file', label: '新建文件', onSelect: () => actions.createFile('') }),
      item({ id: 'create-directory', label: '新建文件夹', onSelect: () => actions.createDirectory('') }),
      item({ id: 'upload', label: '上传文件…', onSelect: () => actions.upload('') }),
      separator(),
      item({ id: 'paste', label: '粘贴', disabled: !canPaste, onSelect: () => actions.paste('') }),
      separator(),
      item({ id: 'refresh', label: '刷新', onSelect: () => actions.refresh() }),
    ]
    if (absolute !== undefined) entries.push(item({ id: 'copy-workspace-path', label: '复制工作区路径', onSelect: () => actions.copyWorkspacePath() }))
    entries.push(item({ id: 'open-terminal', label: '在终端中打开', onSelect: () => actions.openTerminal('') }))
    return entries
  }

  // 目录上的「新建 / 上传 / 粘贴」落在它自己身上；文件上则落在父目录 —— 与 VS Code 一致。
  const container = entry.kind === 'directory' ? entry.path : parentDirectory(entry.path)
  const entries: MenuEntry[] = []
  if (entry.kind === 'file') {
    entries.push(item({ id: 'open', label: '打开', shortcut: 'Enter', onSelect: () => actions.open(entry) }))
    entries.push(separator())
  }
  entries.push(
    item({ id: 'create-file', label: '新建文件', onSelect: () => actions.createFile(container) }),
    item({ id: 'create-directory', label: '新建文件夹', onSelect: () => actions.createDirectory(container) }),
    item({ id: 'upload', label: '上传文件…', onSelect: () => actions.upload(container) }),
    separator(),
    item({ id: 'cut', label: '剪切', onSelect: () => actions.copy(entry, 'cut') }),
    item({ id: 'copy', label: '复制', onSelect: () => actions.copy(entry, 'copy') }),
    item({ id: 'paste', label: '粘贴', disabled: !canPaste, onSelect: () => actions.paste(container) }),
    separator(),
    item({ id: 'rename', label: '重命名', shortcut: 'F2', onSelect: () => actions.rename(entry) }),
    item({ id: 'delete', label: '删除', shortcut: 'Delete', danger: true, onSelect: () => actions.remove(entry) }),
    separator(),
    item({ id: 'copy-relative-path', label: '复制相对路径', onSelect: () => actions.copyPath(entry, false) }),
    item({ id: 'copy-absolute-path', label: '复制绝对路径', disabled: absolute === undefined, onSelect: () => actions.copyPath(entry, true) }),
    separator(),
    item({ id: 'open-terminal', label: entry.kind === 'directory' ? '在终端中打开' : '在终端中打开所在目录', onSelect: () => actions.openTerminal(entry.kind === 'directory' ? entry.path : parentDirectory(entry.path)) }),
  )
  return entries
}

export interface TabMenuActions {
  close(): void
  closeOthers(): void
  closeRight(): void
  closeSaved(): void
  togglePin(): void
  copyPath(absolute: boolean): void
  openTerminal(): void
}

export interface TabMenuContext {
  path: string
  pinned: boolean
  /** 当前标签有没有未保存改动（决定「关闭」是否需要确认，这里只用于提示）。 */
  dirty: boolean
  /** 除本标签外还有没有别的标签。 */
  others: boolean
  /** 本标签右侧还有没有标签。 */
  right: boolean
  /** 有没有「已保存」的标签可关。 */
  saved: boolean
  absolute?: string
  actions: TabMenuActions
}

/** 标签页菜单：VS Code 编辑器标签右键的那几项，外加工作台自己的「在终端中打开」。 */
export function tabMenuItems(context: TabMenuContext): MenuEntry[] {
  const { actions, others, right, saved, pinned, absolute } = context
  const entries: MenuEntry[] = [
    item({ id: 'close', label: '关闭', onSelect: actions.close }),
    item({ id: 'close-others', label: '关闭其他', disabled: !others, onSelect: actions.closeOthers }),
    item({ id: 'close-right', label: '关闭右侧', disabled: !right, onSelect: actions.closeRight }),
    item({ id: 'close-saved', label: '关闭已保存', disabled: !saved, onSelect: actions.closeSaved }),
    separator(),
    item({ id: 'toggle-pin', label: pinned ? '取消固定' : '固定标签', onSelect: actions.togglePin }),
    separator(),
    item({ id: 'copy-relative-path', label: '复制相对路径', disabled: context.path.startsWith('diff:'), onSelect: () => actions.copyPath(false) }),
    item({ id: 'copy-absolute-path', label: '复制绝对路径', disabled: absolute === undefined || context.path.startsWith('diff:'), onSelect: () => actions.copyPath(true) }),
    separator(),
    item({ id: 'open-terminal', label: '在终端中打开所在目录', disabled: context.path.startsWith('diff:'), onSelect: actions.openTerminal }),
  ]
  return entries
}

export interface TerminalMenuActions {
  newTerminal(): void
  split(): void
  rename(): void
  kill(): void
  copySelection(): void
  paste(): void
  selectAll(): void
  clear(): void
}

export interface TerminalMenuContext {
  hasSelection: boolean
  canSplit: boolean
  actions: TerminalMenuActions
}

/** 终端窗格里的右键菜单：复制粘贴、全选清屏，以及标签操作 —— 终端里没有别的入口发现这些。 */
export function terminalPaneMenuItems(context: TerminalMenuContext): MenuEntry[] {
  const { actions, hasSelection, canSplit } = context
  return [
    item({ id: 'terminal-new', label: '新建终端', onSelect: actions.newTerminal }),
    item({ id: 'terminal-split', label: '拆分终端', disabled: !canSplit, onSelect: actions.split }),
    separator(),
    item({ id: 'terminal-copy', label: '复制', shortcut: 'Ctrl+Shift+C', disabled: !hasSelection, onSelect: actions.copySelection }),
    item({ id: 'terminal-paste', label: '粘贴', shortcut: 'Ctrl+Shift+V', onSelect: actions.paste }),
    item({ id: 'terminal-select-all', label: '全选', onSelect: actions.selectAll }),
    item({ id: 'terminal-clear', label: '清屏', onSelect: actions.clear }),
    separator(),
    item({ id: 'terminal-rename', label: '重命名', onSelect: actions.rename }),
    item({ id: 'terminal-kill', label: '终止终端', danger: true, onSelect: actions.kill }),
  ]
}
