import { separator, type MenuEntry, type MenuItem } from './ContextMenu.tsx'

/**
 * 源代码管理面板（Git）的三套右键菜单内容 —— **纯数据**，不碰 DOM，也不直接调 API。
 *
 * 与 menus.ts 同样的理由：菜单项只描述「有哪些项、什么图标、何时禁用、点了做什么」，
 * 真正的动作由 GitPanel 注入（复用面板里已有的 action/toggleCommit/openCommitFile），
 * 于是分组顺序、按暂存/未跟踪/绝对根变化的禁用规则、破坏性标记都能单测，
 * 而不需要渲染 React 或模拟 git 服务。
 */

const item = (value: Omit<MenuItem, 'kind'>): MenuItem => ({ kind: 'item', ...value })

/** 改动行菜单里，面板能提供的那几个动作。 */
export interface ChangeMenuActions {
  /** 打开差异：未跟踪文件需要 untracked 模式，否则按 staged/worktree 取 diff。 */
  open(): void
  stage(): void
  unstage(): void
  /** 放弃前由调用方保留 confirm 二次确认（这里不弹窗，保持纯数据可测）。 */
  discard(): void
  /** absolute=false 复制工作区相对路径，true 复制绝对路径；无绝对根时后者不可点。 */
  copyPath(absolute: boolean): void
}

export interface ChangeMenuContext {
  /** 工作区相对路径（git 输出里就是仓库相对路径）。 */
  path: string
  /** 这一行属于「暂存的更改」还是「更改」。 */
  group: 'staged' | 'worktree'
  /** 未跟踪文件：只有 worktree 组能出现。 */
  untracked: boolean
  /** 工作区绝对根；拿不到时「复制绝对路径」禁用而不是消失，避免菜单项位置跳动。 */
  absoluteRoot?: string
  actions: ChangeMenuActions
}

/**
 * 单个改动项的菜单。
 *
 * 分组对应操作性质：先「看」，再「暂存/丢弃」，最后才是复制路径这类不作变更的附属操作。
 * 「放弃更改」对已暂存的项禁用：暂存区已被写进去，要撤销应该走「取消暂存」，
 * 直接 restore --worktree 只会丢掉工作区内容而暂存区仍在，容易被理解成「撤销成功」。
 */
export function changeMenuItems(context: ChangeMenuContext): MenuEntry[] {
  const { group, untracked, absoluteRoot, actions } = context
  const discardable = group === 'worktree' || untracked
  return [
    item({ id: 'open-change', label: '打开更改', icon: 'diff', onSelect: actions.open }),
    separator(),
    group === 'staged'
      ? item({ id: 'unstage-change', label: '取消暂存', icon: 'remove', onSelect: actions.unstage })
      : item({ id: 'stage-change', label: '暂存更改', icon: 'add', onSelect: actions.stage }),
    item({ id: 'discard-change', label: '放弃更改', icon: 'discard', danger: true, disabled: !discardable, onSelect: actions.discard }),
    separator(),
    item({ id: 'copy-relative-path', label: '复制相对路径', icon: 'copy', onSelect: () => actions.copyPath(false) }),
    item({ id: 'copy-absolute-path', label: '复制绝对路径', disabled: absoluteRoot === undefined, onSelect: () => actions.copyPath(true) }),
  ]
}

/** 提交图里某次提交的菜单动作。 */
export interface CommitMenuActions {
  copyHash(): void
  /** 等同于点一下提交行：展开/收起这次提交的文件列表。 */
  toggleFiles(): void
  copyMessage(): void
}

export interface CommitMenuContext {
  commit: { hash: string; subject: string }
  /** 这次提交的文件列表当前是否展开，决定第二项是「查看」还是「隐藏」。 */
  expanded: boolean
  actions: CommitMenuActions
}

/** 提交图行的菜单：复制哈希 / 查看提交文件 / 复制提交说明 —— 都是点开一次就能拿到的信息。 */
export function commitMenuItems(context: CommitMenuContext): MenuEntry[] {
  const { expanded, actions } = context
  return [
    item({ id: 'copy-commit-hash', label: '复制提交哈希', icon: 'copy', onSelect: actions.copyHash }),
    // 文案跟随当前状态：已展开时再写「查看」会让人以为点了不生效。
    item({ id: 'toggle-commit-files', label: expanded ? '隐藏提交文件' : '查看提交文件', icon: 'list-tree', onSelect: actions.toggleFiles }),
    item({ id: 'copy-commit-message', label: '复制提交说明', icon: 'edit', onSelect: actions.copyMessage }),
  ]
}

/** 某次提交里的文件菜单动作。 */
export interface CommitFileMenuActions {
  openDiff(): void
  /** 复制该文件在提交里的路径（仓库相对路径，git 命令可直接用）。 */
  copyPath(): void
}

export interface CommitFileMenuContext {
  /** 提交里的文件路径（仓库相对路径）。 */
  path: string
  actions: CommitFileMenuActions
}

/** 提交内文件的菜单：打开差异 / 复制路径。行本身点击也会打开差异，这里只是把发现路径摊开。 */
export function commitFileMenuItems(context: CommitFileMenuContext): MenuEntry[] {
  const { actions } = context
  return [
    item({ id: 'open-commit-file-diff', label: '打开差异', icon: 'diff', onSelect: actions.openDiff }),
    item({ id: 'copy-commit-file-path', label: '复制路径', icon: 'copy', onSelect: actions.copyPath }),
  ]
}
