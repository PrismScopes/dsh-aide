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
interface ChangeMenuActions {
  /** 打开差异：未跟踪文件需要 untracked 模式，否则按 staged/worktree 取 diff。 */
  open(): void
  stage(): void
  unstage(): void
  /** 放弃前由调用方保留 confirm 二次确认（这里不弹窗，保持纯数据可测）。 */
  discard(): void
  /** absolute=false 复制工作区相对路径，true 复制绝对路径；无绝对根时后者不可点。 */
  copyPath(absolute: boolean): void
}

interface ChangeMenuContext {
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
    item({ id: 'open-change', label: '打开更改', onSelect: actions.open }),
    separator(),
    group === 'staged'
      ? item({ id: 'unstage-change', label: '取消暂存', onSelect: actions.unstage })
      : item({ id: 'stage-change', label: '暂存更改', onSelect: actions.stage }),
    item({ id: 'discard-change', label: '放弃更改', danger: true, disabled: !discardable, onSelect: actions.discard }),
    separator(),
    item({ id: 'copy-relative-path', label: '复制相对路径', onSelect: () => actions.copyPath(false) }),
    item({ id: 'copy-absolute-path', label: '复制绝对路径', disabled: absoluteRoot === undefined, onSelect: () => actions.copyPath(true) }),
  ]
}

/** 提交图里某次提交的菜单动作。 */
interface CommitMenuActions {
  copyHash(): void
  /** 等同于点一下提交行：展开/收起这次提交的文件列表。 */
  toggleFiles(): void
  copyMessage(): void
  /** 分离头指针检出这次提交（VS Code Git Graph 的「签出」）。 */
  checkout(): void
  /** 以这次提交为基准新建分支（名字由面板层的分支选择器输入）。 */
  createBranch(): void
  /** 把这次提交拣选到当前分支。 */
  cherryPick(): void
  /** 反向提交，撤销这次提交的改动（危险操作，面板层负责二次确认）。 */
  revert(): void
}

interface CommitMenuContext {
  commit: { hash: string; subject: string }
  /** 这次提交的文件列表当前是否展开，决定第二项是「查看」还是「隐藏」。 */
  expanded: boolean
  actions: CommitMenuActions
}

/**
 * 提交图行的菜单。
 *
 * 前一组是「点开一次就能拿到的信息」，后一组是 Git Graph 扩展里对单次提交的常用操作
 * （检出 / 建分支 / 拣选 / 还原）；写操作都放在分隔线之后，避免手滑点到。
 */
export function commitMenuItems(context: CommitMenuContext): MenuEntry[] {
  const { expanded, actions } = context
  return [
    item({ id: 'copy-commit-hash', label: '复制提交哈希', onSelect: actions.copyHash }),
    // 文案跟随当前状态：已展开时再写「查看」会让人以为点了不生效。
    item({ id: 'toggle-commit-files', label: expanded ? '隐藏提交文件' : '查看提交文件', onSelect: actions.toggleFiles }),
    item({ id: 'copy-commit-message', label: '复制提交说明', onSelect: actions.copyMessage }),
    separator(),
    item({ id: 'commit-checkout', label: '检出此提交', onSelect: actions.checkout }),
    item({ id: 'commit-create-branch', label: '在此创建分支', onSelect: actions.createBranch }),
    item({ id: 'commit-cherry-pick', label: '拣选此提交', onSelect: actions.cherryPick }),
    item({ id: 'commit-revert', label: '还原此提交', danger: true, onSelect: actions.revert }),
  ]
}

/** 某次提交里的文件菜单动作。 */
interface CommitFileMenuActions {
  openDiff(): void
  /** 复制该文件在提交里的路径（仓库相对路径，git 命令可直接用）。 */
  copyPath(): void
}

interface CommitFileMenuContext {
  /** 提交里的文件路径（仓库相对路径）。 */
  path: string
  actions: CommitFileMenuActions
}

/** 提交内文件的菜单：打开差异 / 复制路径。行本身点击也会打开差异，这里只是把发现路径摊开。 */
export function commitFileMenuItems(context: CommitFileMenuContext): MenuEntry[] {
  const { actions } = context
  return [
    item({ id: 'open-commit-file-diff', label: '打开差异', onSelect: actions.openDiff }),
    item({ id: 'copy-commit-file-path', label: '复制路径', onSelect: actions.copyPath }),
  ]
}

/** 面板顶部「更多操作」菜单（VS Code 源代码管理视图标题上的 `...`）。 */
interface ScmMenuActions {
  refresh(): void
  fetch(): void
  pull(): void
  push(): void
  sync(): void
  stageAll(): void
  unstageAll(): void
  discardAll(): void
  checkout(): void
  createBranch(): void
  deleteBranch(): void
}

interface ScmMenuContext {
  busy: boolean
  /** 是否配置了远程：拉取/推送/同步/获取在没远程时禁用而不是隐藏，菜单位置不会跳。 */
  remote: boolean
  /** 暂存区条目数，决定「取消暂存所有更改」是否可点。 */
  stagedCount: number
  /** 未暂存条目数，决定「暂存 / 放弃所有更改」是否可点。 */
  changeCount: number
  actions: ScmMenuActions
}

/**
 * 顶部菜单。分组顺序与 VS Code 一致：先同步（拉取/推送/同步/获取），
 * 再整批的暂存与放弃，最后才是分支操作；破坏性操作带 danger 标记。
 */
export function scmMenuItems(context: ScmMenuContext): MenuEntry[] {
  const { busy, remote, stagedCount, changeCount, actions } = context
  const offline = busy || !remote
  return [
    item({ id: 'scm-refresh', label: '刷新', disabled: busy, onSelect: actions.refresh }),
    separator(),
    item({ id: 'scm-pull', label: '拉取', disabled: offline, onSelect: actions.pull }),
    item({ id: 'scm-push', label: '推送', disabled: offline, onSelect: actions.push }),
    item({ id: 'scm-sync', label: '同步', disabled: offline, onSelect: actions.sync }),
    item({ id: 'scm-fetch', label: '获取', disabled: offline, onSelect: actions.fetch }),
    separator(),
    item({ id: 'scm-stage-all', label: '暂存所有更改', disabled: busy || changeCount === 0, onSelect: actions.stageAll }),
    item({ id: 'scm-unstage-all', label: '取消暂存所有更改', disabled: busy || stagedCount === 0, onSelect: actions.unstageAll }),
    item({ id: 'scm-discard-all', label: '放弃所有更改', danger: true, disabled: busy || changeCount === 0, onSelect: actions.discardAll }),
    separator(),
    item({ id: 'scm-checkout', label: '检出到…', disabled: busy, onSelect: actions.checkout }),
    item({ id: 'scm-create-branch', label: '新建分支…', disabled: busy, onSelect: actions.createBranch }),
    item({ id: 'scm-delete-branch', label: '删除分支…', disabled: busy, onSelect: actions.deleteBranch }),
  ]
}

/** 分组标题上的 `...` 菜单：暂存的更改 / 更改 / 图表。 */
export type GitGroup = 'staged' | 'changes' | 'graph'

interface GroupMenuActions {
  stageAll(): void
  unstageAll(): void
  discardAll(): void
  refreshGraph(): void
  /** 在「全部提交」与「仅当前分支」之间切换提交图的范围。 */
  toggleAllCommits(): void
  /** 提交图多取一页。 */
  loadMore(): void
  /** 收起当前展开的提交文件列表。 */
  collapseCommit(): void
}

interface GroupMenuContext {
  group: GitGroup
  busy: boolean
  /** 该组的条目数（图表组不用，传提交数也行）。 */
  count: number
  /** 提交图当前是否显示全部分支。 */
  allCommits: boolean
  /** 提交图是否还有下一页可加载。 */
  canLoadMore: boolean
  /** 是否有展开的提交（决定「收起提交文件」是否可点）。 */
  expandedCommit: boolean
  actions: GroupMenuActions
}

/** 分组菜单：只列这一组能做的操作，避免把所有动作塞进一个巨型菜单。 */
export function groupMenuItems(context: GroupMenuContext): MenuEntry[] {
  const { group, busy, count, allCommits, canLoadMore, expandedCommit, actions } = context
  if (group === 'staged') {
    return [item({ id: 'group-unstage-all', label: '取消暂存所有更改', disabled: busy || count === 0, onSelect: actions.unstageAll })]
  }
  if (group === 'changes') {
    return [
      item({ id: 'group-stage-all', label: '暂存所有更改', disabled: busy || count === 0, onSelect: actions.stageAll }),
      item({ id: 'group-discard-all', label: '放弃所有更改', danger: true, disabled: busy || count === 0, onSelect: actions.discardAll }),
    ]
  }
  return [
    item({ id: 'graph-refresh', label: '刷新提交图', disabled: busy, onSelect: actions.refreshGraph }),
    item({ id: 'graph-toggle-all', label: allCommits ? '仅显示当前分支' : '显示全部分支', disabled: busy, onSelect: actions.toggleAllCommits }),
    item({ id: 'graph-load-more', label: '加载更多提交', disabled: busy || !canLoadMore, onSelect: actions.loadMore }),
    item({ id: 'graph-collapse-commit', label: '收起提交文件', disabled: expandedCommit === false, onSelect: actions.collapseCommit }),
  ]
}
