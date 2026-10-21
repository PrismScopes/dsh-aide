import { separator, type MenuEntry, type MenuItem } from './ContextMenu.tsx'

/**
 * 源代码管理面板 / 提交图标签页的菜单内容 —— **纯数据**，不碰 DOM，也不直接调 API。
 *
 * 与 menus.ts 同样的理由：菜单项只描述「有哪些项、什么图标、何时禁用、点了做什么」，
 * 真正的动作由面板注入（复用面板里已有的 action / 选择器），于是分组顺序、按状态变化的禁用规则、
 * 破坏性标记都能单测，而不需要渲染 React 或模拟 git 服务。
 *
 * 菜单结构对齐 VS Code 源代码管理视图标题上的 `...`：一级项 + 带箭头的一级子菜单
 * （查看和排序 / 提交 / 更改 / 拉取，推送 / 分支 / 远程 / 存储 / 标记）。
 */

/**
 * 菜单项构造器。
 *
 * `onSelect` 在带子菜单的父项上没有意义（ContextMenu 展开子菜单而不是执行它），
 * 这里给它一个空操作的默认值，避免每个子菜单父项都写一遍 `onSelect: () => undefined`。
 */
type MenuItemInput = Omit<MenuItem, 'kind' | 'onSelect'> & { onSelect?: MenuItem['onSelect'] }
const item = (value: MenuItemInput): MenuItem => ({ kind: 'item', onSelect: () => undefined, ...value })

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
export interface CommitMenuActions {
  copyHash(): void
  /** 等同于点一下提交行：展开/收起这次提交的文件列表。 */
  toggleFiles(): void
  copyMessage(): void
  /** 分离头指针检出这次提交（VS Code Git Graph 的「签出」）。 */
  checkout(): void
  /** 以这次提交为基准新建分支（名字由面板层的分支选择器输入）。 */
  createBranch(): void
  /** 在这次提交上打标签（名字由输入框给）。 */
  createTag(): void
  /** 把这次提交拣选到当前分支。 */
  cherryPick(): void
  /** 反向提交，撤销这次提交的改动（危险操作，面板层负责二次确认）。 */
  revert(): void
  /** 重置到这次提交（软/混合/硬）；硬重置会丢工作区改动，危险操作。 */
  reset(mode: 'soft' | 'mixed' | 'hard'): void
  /** 把这次提交从当前分支摘掉（rebase --onto）。 */
  drop(): void
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
 * （检出 / 建分支 / 打标签 / 拣选 / 还原）；写操作都放在分隔线之后，避免手滑点到。
 */
export function commitMenuItems(context: CommitMenuContext): MenuEntry[] {
  const { expanded, actions } = context
  return [
    item({ id: 'copy-commit-hash', label: '复制提交哈希', onSelect: actions.copyHash }),
    item({ id: 'copy-commit-message', label: '复制提交说明', onSelect: actions.copyMessage }),
    // 文案跟随当前状态：已展开时再写「查看」会让人以为点了不生效。
    item({ id: 'toggle-commit-files', label: expanded ? '隐藏提交文件' : '查看提交文件', onSelect: actions.toggleFiles }),
    separator(),
    item({ id: 'commit-checkout', label: '检出此提交', onSelect: actions.checkout }),
    item({ id: 'commit-create-branch', label: '在此创建分支…', onSelect: actions.createBranch }),
    item({ id: 'commit-create-tag', label: '在此创建标签…', onSelect: actions.createTag }),
    item({ id: 'commit-cherry-pick', label: '拣选此提交', onSelect: actions.cherryPick }),
    item({ id: 'commit-revert', label: '还原此提交', danger: true, onSelect: actions.revert }),
    separator(),
    item({
      id: 'commit-reset', label: '重置到此提交', submenu: [
        item({ id: 'commit-reset-soft', label: '软重置（保留改动并暂存）', onSelect: () => actions.reset('soft') }),
        item({ id: 'commit-reset-mixed', label: '混合重置（保留工作区改动）', onSelect: () => actions.reset('mixed') }),
        item({ id: 'commit-reset-hard', label: '硬重置（丢弃改动）', danger: true, onSelect: () => actions.reset('hard') }),
      ],
    }),
    item({ id: 'commit-drop', label: '丢弃此提交', danger: true, onSelect: actions.drop }),
  ]
}

/** 某次提交里的文件菜单动作。 */
export interface CommitFileMenuActions {
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

/**
 * 菜单里每一项能触发的动作。
 *
 * 面板与提交图标签页共用同一份菜单结构，各自注入实现：面板在侧栏就地打开选择器，
 * 标签页在编辑器里做同样的事，两边的行为（含二次确认）不会分叉。
 */
export interface GitMenuActions {
  refresh(): void
  pull(): void
  push(): void
  fetch(): void
  sync(): void
  clone(): void
  checkout(): void
  commitStaged(): void
  commitAll(): void
  undoCommit(): void
  stageAll(): void
  unstageAll(): void
  discardAll(): void
  branchCreate(): void
  branchRename(): void
  branchDelete(): void
  branchMerge(): void
  branchRebase(): void
  openGraph(all: boolean): void
  remoteAdd(): void
  remoteRemove(): void
  stashPush(staged: boolean): void
  stashApply(): void
  stashPop(): void
  stashDrop(): void
  tagCreate(): void
  tagDelete(): void
  tagPush(): void
  copyBranch(): void
  copyRepository(): void
  toggleTree(): void
  sortByPath(): void
  sortByName(): void
  /** 打开提交图里的查找框 / 分支过滤选择器；清除已选的分支过滤。 */
  openFind(): void
  openBranchFilter(): void
  clearBranchFilter(): void
  /** 提交图的列显示 / emoji 替换开关。 */
  toggleViewAuthor(): void
  toggleViewDate(): void
  toggleViewHash(): void
  toggleEmoji(): void
  /** 打开标签详情（附注标签的打标签人、日期、说明）。 */
  showTagDetail(): void
  /** 清除代码审查的已读记录。 */
  clearReviews(): void
  /** 打开仓库设置（远程管理 / Issue 链接 / 视图配置导出）。 */
  openRepoSettings(): void
  /** 打开 Pull Request 创建页（按远程托管方生成 URL，目标分支可在仓库设置里固定）。 */
  createPullRequest(): void
  /** 提交图多取一页（只有图表标签页/图表分组用得到）。 */
  loadMore(): void
  showOutput(): void
}

/** 源代码管理视图标题菜单的上下文。 */
export interface ScmMenuContext {
  busy: boolean
  /** 是否配置了远程：拉取/推送/同步/抓取在没远程时禁用而不是隐藏，菜单位置不会跳。 */
  remote: boolean
  /** 暂存区条目数，决定「取消暂存所有更改」「提交已暂存的更改」是否可点。 */
  stagedCount: number
  /** 未暂存条目数，决定「暂存 / 放弃所有更改」是否可点。 */
  changeCount: number
  /** 更改列表是否按目录分组（查看和排序子菜单里切换）。 */
  tree?: boolean
  /** 更改列表排序方式（查看和排序子菜单里切换）。 */
  sort?: 'path' | 'name'
  actions: GitMenuActions
}

/**
 * 源代码管理视图标题上的 `...` 菜单。
 *
 * 一级结构照 VS Code：查看和排序 / 拉取·推送·克隆·签出·抓取 / 提交 / 更改 / 拉取，推送 /
 * 分支 / 远程 / 存储 / 标记 / 显示输出。会写仓库的项带 `danger`，没有远程时远程相关项禁用。
 */
export function scmMenuItems(context: ScmMenuContext): MenuEntry[] {
  const { busy, remote, stagedCount, changeCount, tree, sort, actions } = context
  const offline = busy || !remote
  return [
    item({ id: 'scm-refresh', label: '刷新', disabled: busy, onSelect: actions.refresh }),
    item({
      id: 'scm-view', label: '查看和排序', submenu: [
        item({ id: 'scm-view-tree', label: tree === true ? '按路径列表查看' : '按目录分组查看', onSelect: actions.toggleTree }),
        item({ id: 'scm-view-sort-path', label: sort === 'name' ? '按路径排序' : '按路径排序（当前）', onSelect: actions.sortByPath }),
        item({ id: 'scm-view-sort-name', label: sort === 'name' ? '按名称排序（当前）' : '按名称排序', onSelect: actions.sortByName }),
      ],
    }),
    separator(),
    item({ id: 'scm-pull', label: '拉取', disabled: offline, onSelect: actions.pull }),
    item({ id: 'scm-push', label: '推送', disabled: offline, onSelect: actions.push }),
    item({ id: 'scm-clone', label: '克隆…', disabled: busy, onSelect: actions.clone }),
    item({ id: 'scm-checkout', label: '签出到…', disabled: busy, onSelect: actions.checkout }),
    item({ id: 'scm-fetch', label: '抓取', disabled: offline, onSelect: actions.fetch }),
    separator(),
    item({
      id: 'scm-commit-group', label: '提交', submenu: [
        item({ id: 'scm-commit-staged', label: '提交已暂存的更改…', disabled: busy || stagedCount === 0, onSelect: actions.commitStaged }),
        item({ id: 'scm-commit-all', label: '提交所有更改…', disabled: busy || stagedCount + changeCount === 0, onSelect: actions.commitAll }),
        item({ id: 'scm-commit-undo', label: '撤销上次提交…', danger: true, disabled: busy, onSelect: actions.undoCommit }),
      ],
    }),
    item({
      id: 'scm-changes-group', label: '更改', submenu: [
        item({ id: 'scm-changes-stage', label: '暂存所有更改', disabled: busy || changeCount === 0, onSelect: actions.stageAll }),
        item({ id: 'scm-changes-unstage', label: '取消暂存所有更改', disabled: busy || stagedCount === 0, onSelect: actions.unstageAll }),
        item({ id: 'scm-changes-discard', label: '放弃所有更改', danger: true, disabled: busy || changeCount === 0, onSelect: actions.discardAll }),
      ],
    }),
    item({
      id: 'scm-sync-group', label: '拉取，推送', submenu: [
        item({ id: 'scm-sync-pull', label: '拉取', disabled: offline, onSelect: actions.pull }),
        item({ id: 'scm-sync-push', label: '推送', disabled: offline, onSelect: actions.push }),
        item({ id: 'scm-sync', label: '同步', disabled: offline, onSelect: actions.sync }),
        item({ id: 'scm-sync-fetch', label: '抓取', disabled: offline, onSelect: actions.fetch }),
        item({ id: 'scm-sync-tags', label: '推送全部标签', disabled: offline, onSelect: actions.tagPush }),
      ],
    }),
    item({
      id: 'scm-branch-group', label: '分支', submenu: [
        item({ id: 'scm-branch-create', label: '新建分支…', disabled: busy, onSelect: actions.branchCreate }),
        item({ id: 'scm-branch-rename', label: '重命名分支…', disabled: busy, onSelect: actions.branchRename }),
        item({ id: 'scm-branch-delete', label: '删除分支…', disabled: busy, onSelect: actions.branchDelete }),
        item({ id: 'scm-branch-merge', label: '合并到当前分支…', disabled: busy, onSelect: actions.branchMerge }),
        item({ id: 'scm-branch-rebase', label: '变基到当前分支…', disabled: busy, onSelect: actions.branchRebase }),
        item({ id: 'scm-branch-graph', label: '打开提交图', disabled: busy, onSelect: () => actions.openGraph(false) }),
      ],
    }),
    item({
      id: 'scm-remote-group', label: '远程', submenu: [
        item({ id: 'scm-remote-add', label: '添加远程…', disabled: busy, onSelect: actions.remoteAdd }),
        item({ id: 'scm-remote-remove', label: '移除远程…', disabled: busy || !remote, onSelect: actions.remoteRemove }),
      ],
    }),
    item({
      id: 'scm-stash-group', label: '存储', submenu: [
        item({ id: 'scm-stash-push', label: '贮藏所有更改…', disabled: busy, onSelect: () => actions.stashPush(false) }),
        item({ id: 'scm-stash-push-staged', label: '贮藏已暂存的更改…', disabled: busy || stagedCount === 0, onSelect: () => actions.stashPush(true) }),
        item({ id: 'scm-stash-apply', label: '应用贮藏…', disabled: busy, onSelect: actions.stashApply }),
        item({ id: 'scm-stash-pop', label: '弹出最新贮藏', disabled: busy, onSelect: actions.stashPop }),
        item({ id: 'scm-stash-drop', label: '删除贮藏…', danger: true, disabled: busy, onSelect: actions.stashDrop }),
      ],
    }),
    item({
      id: 'scm-tag-group', label: '标记', submenu: [
        item({ id: 'scm-tag-create', label: '创建标签…', disabled: busy, onSelect: actions.tagCreate }),
        item({ id: 'scm-tag-delete', label: '删除标签…', disabled: busy, onSelect: actions.tagDelete }),
        item({ id: 'scm-tag-push', label: '推送全部标签', disabled: offline, onSelect: actions.tagPush }),
      ],
    }),
    separator(),
    item({ id: 'scm-output', label: '显示 Git 输出', onSelect: actions.showOutput }),
  ]
}

/** 提交图标签页工具栏菜单的上下文。 */
export interface GraphMenuContext {
  busy: boolean
  /** 是否配置了远程：推送标签需要远程。 */
  remote: boolean
  /** 当前是否有分支过滤（决定菜单里是「分支过滤…」还是「清除分支过滤」）。 */
  filtered: boolean
  /** 列显示 / emoji 等视图开关的当前值（菜单文案随状态变）。 */
  view: { showAuthor: boolean; showDate: boolean; showHash: boolean; emoji: boolean }
  /** 提交图当前是否显示全部分支。 */
  allCommits: boolean
  canLoadMore: boolean
  actions: GitMenuActions
}

/** 提交图标签页标题上的 `...` 菜单：范围、分页、提交/分支/贮藏/标记操作。 */
export function graphMenuItems(context: GraphMenuContext): MenuEntry[] {
  const { busy, remote, filtered, view, allCommits, canLoadMore, actions } = context
  return [
    item({ id: 'graph-refresh', label: '刷新提交图', disabled: busy, onSelect: actions.refresh }),
    item({ id: 'graph-find', label: '查找提交…', onSelect: actions.openFind }),
    item({ id: 'graph-filter', label: filtered ? '清除分支过滤' : '分支过滤…', onSelect: filtered ? actions.clearBranchFilter : actions.openBranchFilter }),
    item({
      id: 'graph-view', label: '视图', submenu: [
        item({ id: 'graph-view-author', label: view.showAuthor ? '隐藏作者列' : '显示作者列', onSelect: actions.toggleViewAuthor }),
        item({ id: 'graph-view-date', label: view.showDate ? '隐藏日期列' : '显示日期列', onSelect: actions.toggleViewDate }),
        item({ id: 'graph-view-hash', label: view.showHash ? '隐藏哈希列' : '显示哈希列', onSelect: actions.toggleViewHash }),
        item({ id: 'graph-view-emoji', label: view.emoji ? '关闭表情替换' : '开启表情替换', onSelect: actions.toggleEmoji }),
        item({ id: 'graph-view-clear-reviews', label: '清除代码审查记录', danger: true, onSelect: actions.clearReviews }),
      ],
    }),
    item({ id: 'graph-repo-settings', label: '仓库设置…', onSelect: actions.openRepoSettings }),
    item({ id: 'graph-pull-request', label: '创建拉取请求…', disabled: !remote, onSelect: actions.createPullRequest }),
    item({
      id: 'graph-range', label: '提交范围', submenu: [
        item({ id: 'graph-range-current', label: allCommits ? '仅当前分支' : '仅当前分支（当前）', disabled: busy, onSelect: () => actions.openGraph(false) }),
        item({ id: 'graph-range-all', label: allCommits ? '全部分支（当前）' : '全部分支', disabled: busy, onSelect: () => actions.openGraph(true) }),
      ],
    }),
    item({ id: 'graph-load-more', label: '加载更多提交', disabled: busy || !canLoadMore, onSelect: actions.loadMore }),
    separator(),
    item({ id: 'graph-checkout', label: '签出到…', disabled: busy, onSelect: actions.checkout }),
    item({
      id: 'graph-branch-group', label: '分支', submenu: [
        item({ id: 'graph-branch-create', label: '新建分支…', disabled: busy, onSelect: actions.branchCreate }),
        item({ id: 'graph-branch-delete', label: '删除分支…', disabled: busy, onSelect: actions.branchDelete }),
        item({ id: 'graph-branch-merge', label: '合并到当前分支…', disabled: busy, onSelect: actions.branchMerge }),
      ],
    }),
    item({
      id: 'graph-stash-group', label: '存储', submenu: [
        item({ id: 'graph-stash-push', label: '贮藏所有更改…', disabled: busy, onSelect: () => actions.stashPush(false) }),
        item({ id: 'graph-stash-apply', label: '应用贮藏…', disabled: busy, onSelect: actions.stashApply }),
        item({ id: 'graph-stash-pop', label: '弹出最新贮藏', disabled: busy, onSelect: actions.stashPop }),
      ],
    }),
    item({
      id: 'graph-tag-group', label: '标记', submenu: [
        item({ id: 'graph-tag-create', label: '创建标签…', disabled: busy, onSelect: actions.tagCreate }),
        item({ id: 'graph-tag-detail', label: '查看标签详情…', disabled: busy, onSelect: actions.showTagDetail }),
        item({ id: 'graph-tag-delete', label: '删除标签…', disabled: busy, onSelect: actions.tagDelete }),
        item({ id: 'graph-tag-push', label: '推送全部标签', disabled: busy || !remote, onSelect: actions.tagPush }),
      ],
    }),
    separator(),
    item({ id: 'graph-copy-branch', label: '复制当前分支名', onSelect: actions.copyBranch }),
  ]
}

/** 分组标题上的 `...` 菜单：暂存的更改 / 更改 / 图表。 */
export type GitGroup = 'staged' | 'changes' | 'graph'

export interface GroupMenuActions {
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

/** 贮藏行右键菜单的动作。 */
export interface StashMenuActions {
  apply(): void
  pop(): void
  drop(): void
  /** 复制 `stash@{n}` 这个名字，方便在终端里直接用。 */
  copyName(): void
}

interface StashMenuContext {
  /** 展示用的名字，例如 `stash@{0}: On main: 说明`。 */
  label: string
  actions: StashMenuActions
}

/** 提交图里贮藏节点的菜单：应用 / 弹出 / 删除（危险）/ 复制名字。 */
export function stashMenuItems(context: StashMenuContext): MenuEntry[] {
  const { actions } = context
  return [
    item({ id: 'stash-apply', label: '应用贮藏', onSelect: actions.apply }),
    item({ id: 'stash-pop', label: '弹出贮藏', onSelect: actions.pop }),
    item({ id: 'stash-copy', label: '复制贮藏名', onSelect: actions.copyName }),
    separator(),
    item({ id: 'stash-drop', label: '删除贮藏', danger: true, onSelect: actions.drop }),
  ]
}
