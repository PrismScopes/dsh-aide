import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { GitBranchList, GitCommit, GitStash, GitStatus, GitTag } from '../types.ts'
import { api } from './api.ts'
import type { MenuEntry } from './ContextMenu.tsx'
import { commitMenuItems, graphMenuItems, scmMenuItems, type GitMenuActions } from './gitMenus.ts'
import { shortHash } from './gitGraph.ts'
import { QuickPick, type QuickPickItem } from './quickPick.tsx'

/**
 * 源代码管理面板与提交图标签页共用的「菜单 + 快速选择器」逻辑。
 *
 * 为什么抽成 hook：菜单结构（gitMenus.ts）是纯数据，两边共用，但每项背后的动作都要先跑一次
 * `git.action`、再刷新状态；如果两个组件各写一遍，「放弃前二次确认」「贮藏索引校验」这类规则
 * 迟早会分叉。这里只依赖一个很小的 `GitCommandBridge`（执行动作 + 刷新 + 反馈），
 * 面板和标签页各自把自己已有的 action/refresh 接进来即可。
 */

export interface GitCommandBridge {
  sessionId: string
  busy: boolean
  status?: GitStatus
  remotes: readonly string[]
  /** 执行一个 git 动作（实现方负责状态更新、错误展示与提交图刷新）。 */
  run(action: string, path?: string, value?: string): Promise<unknown>
  /** 动作之后重取数据。 */
  refresh(): void
  /** 打开提交图标签页。 */
  openGraph(all: boolean): void
  /** 打开 Git 输出标签页。 */
  openOutput(): void
  onError(message: string): void
  onCopy(text: string): void
  /** 更改列表的视图状态与切换（只有源代码管理面板提供）。 */
  tree?: boolean
  sort?: 'path' | 'name'
  toggleTree?(): void
  sortBy?(mode: 'path' | 'name'): void
  /** 提交图多取一页（只有图表标签页提供）。 */
  loadMore?(): void
  /** 提交图的查找框与分支过滤（只有图表标签页提供）。 */
  openFind?(): void
  openBranchFilter?(): void
  clearBranchFilter?(): void
  /** 已选分支过滤（用于菜单里显示「清除分支过滤」）。 */
  filteredBranches?: readonly string[]
  /** 列显示 / emoji 等视图设置（只有提交图标签页提供）。 */
  view?: { showAuthor: boolean; showDate: boolean; showHash: boolean; emoji: boolean }
  updateView?(patch: Partial<{ showAuthor: boolean; showDate: boolean; showHash: boolean; emoji: boolean }>): void
  /** 标签详情 / 代码审查清除 / 仓库设置（只有提交图标签页提供，面板里是 no-op）。 */
  showTagDetail?(): void
  clearReviews?(): void
  openRepoSettings?(): void
  /** 创建 Pull Request（只有提交图标签页提供实现）。 */
  createPullRequest?(): void
}

/** 输入型选择器的描述：标题、占位符、是否允许空串，以及提交后的动作。 */
interface TextPrompt {
  title: string
  placeholder: string
  allowEmpty?: boolean
  submitLabel?(value: string): string
  submit(value: string): void
}

type PickerState =
  | { kind: 'loading'; title: string }
  | { kind: 'branch'; mode: 'switch' | 'rename' | 'delete' | 'merge' | 'rebase'; branches: GitBranchList }
  | { kind: 'stash'; mode: 'apply' | 'pop' | 'drop'; stashes: GitStash[] }
  | { kind: 'tag'; tags: GitTag[] }
  | { kind: 'remote'; remotes: readonly string[] }
  | { kind: 'text'; prompt: TextPrompt }

const BRANCH_TITLES: Record<'switch' | 'rename' | 'delete' | 'merge' | 'rebase', string> = {
  switch: '签出到…', rename: '重命名分支…', delete: '删除分支…', merge: '合并到当前分支…', rebase: '变基到当前分支…',
}

/** 从仓库 URL 里猜一个目标目录名（克隆用）：`https://x/y.git` → `y`。 */
export function cloneTargetName(url: string): string {
  const trimmed = url.trim().replace(/[\\/]+$/, '')
  const last = trimmed.split(/[\\/:]/).at(-1) ?? ''
  return last.replace(/\.git$/i, '') || 'repository'
}

export function useGitCommands(bridge: GitCommandBridge) {
  const [picker, setPicker] = useState<PickerState>()
  // 异步选择器（分支/贮藏/标签列表）在 await 之后才 setPicker，闭包里的 bridge 可能已经过期。
  const bridgeRef = useRef(bridge); bridgeRef.current = bridge
  const run = (action: string, path?: string, value?: string) => { void bridgeRef.current.run(action, path, value) }
  const copy = (text: string) => bridgeRef.current.onCopy(text)

  /** 先显示「读取中…」再异步取列表；失败时把错误交给面板并收起选择器。 */
  const load = async <T,>(title: string, loader: () => Promise<T>): Promise<T | undefined> => {
    setPicker({ kind: 'loading', title })
    try { return await loader() } catch (error) { setPicker(undefined); bridgeRef.current.onError(String(error)); return undefined }
  }
  const openBranch = async (mode: 'switch' | 'rename' | 'delete' | 'merge' | 'rebase') => {
    const branches = await load(BRANCH_TITLES[mode], () => api<GitBranchList>('git.action', { sessionId: bridgeRef.current.sessionId, action: 'branch.list' }))
    if (branches !== undefined) setPicker({ kind: 'branch', mode, branches })
  }
  const openStash = async (mode: 'apply' | 'pop' | 'drop') => {
    const stashes = await load(mode === 'drop' ? '删除贮藏…' : mode === 'pop' ? '弹出贮藏…' : '应用贮藏…', () => api<GitStash[]>('git.action', { sessionId: bridgeRef.current.sessionId, action: 'stash.list' }))
    if (stashes !== undefined) setPicker({ kind: 'stash', mode, stashes })
  }
  const openTag = async () => {
    const tags = await load('删除标签…', () => api<GitTag[]>('git.action', { sessionId: bridgeRef.current.sessionId, action: 'tag.list' }))
    if (tags !== undefined) setPicker({ kind: 'tag', tags })
  }
  const openRemote = async () => {
    const remotes = await load('移除远程…', () => api<string[]>('git.action', { sessionId: bridgeRef.current.sessionId, action: 'remotes' }))
    if (remotes !== undefined) setPicker({ kind: 'remote', remotes })
  }
  const promptText = (prompt: TextPrompt) => setPicker({ kind: 'text', prompt })
  const close = () => setPicker(undefined)

  /** 提交说明输入：先暂存（可选）再提交，两条命令都走同一套错误/刷新路径。 */
  const promptCommit = (all: boolean) => promptText({
    title: all ? '提交所有更改' : '提交已暂存的更改',
    placeholder: '提交信息',
    submitLabel: value => `提交 “${value}”`,
    submit: message => { if (message.trim() !== '') run(all ? 'commit.all' : 'commit', undefined, message) },
  })

  const actions: GitMenuActions = {
    refresh: () => bridgeRef.current.refresh(),
    pull: () => run('pull'), push: () => run('push'), fetch: () => run('fetch'), sync: () => run('sync'),
    clone: () => promptText({
      title: '克隆仓库',
      placeholder: '仓库 URL',
      submitLabel: value => `克隆到 ${cloneTargetName(value)}`,
      submit: url => { if (url.trim() !== '') run('clone', cloneTargetName(url), url.trim()) },
    }),
    checkout: () => void openBranch('switch'),
    commitStaged: () => promptCommit(false),
    commitAll: () => promptCommit(true),
    undoCommit: () => { if (confirm('撤销上次提交？改动会退回暂存区。')) run('commit.undo') },
    stageAll: () => run('stage.all'),
    unstageAll: () => run('unstage.all'),
    discardAll: () => { if (confirm('放弃所有已跟踪和未跟踪的更改？此操作无法撤销。')) run('discard.all') },
    branchCreate: () => promptText({
      title: '新建分支',
      placeholder: '分支名称',
      submitLabel: value => `创建分支 “${value}”`,
      submit: name => { if (name.trim() !== '') run('branch.create', undefined, name.trim()) },
    }),
    branchRename: () => void openBranch('rename'),
    branchDelete: () => void openBranch('delete'),
    branchMerge: () => void openBranch('merge'),
    branchRebase: () => void openBranch('rebase'),
    openGraph: all => bridgeRef.current.openGraph(all),
    remoteAdd: () => promptText({
      title: '添加远程',
      placeholder: '远程名称（例如 origin）',
      submitLabel: value => `使用名称 “${value}”`,
      submit: name => promptText({
        title: `添加远程 ${name.trim() || 'origin'}`,
        placeholder: '仓库 URL',
        submitLabel: value => `添加到 ${name.trim() || 'origin'}`,
        submit: url => { if (url.trim() !== '') run('remote.add', name.trim() || 'origin', url.trim()) },
      }),
    }),
    remoteRemove: () => { const remotes = bridgeRef.current.remotes; if (remotes.length === 1) { if (confirm(`移除远程 ${remotes[0]}？`)) run('remote.remove', undefined, remotes[0]) } else void openRemote() },
    stashPush: staged => promptText({
      title: staged ? '贮藏已暂存的更改' : '贮藏所有更改',
      placeholder: '贮藏说明（可留空）',
      allowEmpty: true,
      submitLabel: value => value === '' ? '不写说明直接贮藏' : `贮藏 “${value}”`,
      submit: message => run('stash.push', staged ? 'staged' : undefined, message),
    }),
    stashApply: () => void openStash('apply'),
    stashPop: () => run('stash.pop', undefined, '0'),
    stashDrop: () => void openStash('drop'),
    tagCreate: () => promptText({
      title: '创建标签',
      placeholder: '标签名称（打在 HEAD 上）',
      submitLabel: value => `创建标签 “${value}”`,
      submit: name => { if (name.trim() !== '') run('tag.create', undefined, name.trim()) },
    }),
    tagDelete: () => void openTag(),
    tagPush: () => { if (confirm('把全部标签推送到远程？')) run('tag.push') },
    copyBranch: () => copy(bridgeRef.current.status?.branch ?? ''),
    copyRepository: () => copy(bridgeRef.current.status?.repository ?? ''),
    toggleTree: () => bridgeRef.current.toggleTree?.(),
    sortByPath: () => bridgeRef.current.sortBy?.('path'),
    sortByName: () => bridgeRef.current.sortBy?.('name'),
    openFind: () => bridgeRef.current.openFind?.(),
    openBranchFilter: () => bridgeRef.current.openBranchFilter?.(),
    clearBranchFilter: () => bridgeRef.current.clearBranchFilter?.(),
    toggleViewAuthor: () => bridgeRef.current.updateView?.({ showAuthor: !(bridgeRef.current.view?.showAuthor ?? true) }),
    toggleViewDate: () => bridgeRef.current.updateView?.({ showDate: !(bridgeRef.current.view?.showDate ?? true) }),
    toggleViewHash: () => bridgeRef.current.updateView?.({ showHash: !(bridgeRef.current.view?.showHash ?? true) }),
    toggleEmoji: () => bridgeRef.current.updateView?.({ emoji: !(bridgeRef.current.view?.emoji ?? true) }),
    showTagDetail: () => bridgeRef.current.showTagDetail?.(),
    clearReviews: () => { if (confirm('清除代码审查的已读记录？')) bridgeRef.current.clearReviews?.() },
    openRepoSettings: () => bridgeRef.current.openRepoSettings?.(),
    createPullRequest: () => bridgeRef.current.createPullRequest?.(),
    loadMore: () => bridgeRef.current.loadMore?.(),
    showOutput: () => bridgeRef.current.openOutput(),
  }

  /** 面板标题的 `...`：需要调用方给出两组条目数（菜单里的禁用规则依赖它们）。 */
  const scmMenu = (counts: { staged: number; changes: number }): MenuEntry[] => scmMenuItems({
    busy: bridge.busy, remote: bridge.remotes.length > 0, stagedCount: counts.staged, changeCount: counts.changes,
    tree: bridge.tree, sort: bridge.sort, actions,
  })
  /** 提交图标签页的 `...`。 */
  const graphMenu = (state: { allCommits: boolean; canLoadMore: boolean }): MenuEntry[] => graphMenuItems({
    busy: bridge.busy, remote: bridge.remotes.length > 0, filtered: (bridge.filteredBranches?.length ?? 0) > 0,
    view: bridge.view ?? { showAuthor: true, showDate: true, showHash: true, emoji: true },
    allCommits: state.allCommits, canLoadMore: state.canLoadMore, actions,
  })
  /** 提交行的右键菜单：复制类动作由调用方给（它们只依赖已读到的提交信息）。 */
  const commitMenu = (commit: GitCommit, expanded: boolean, extra: { copyHash(): void; copyMessage(): void; toggleFiles(): void }): MenuEntry[] => commitMenuItems({
    commit, expanded,
    actions: {
      ...extra,
      checkout: () => run('commit.checkout', undefined, commit.hash),
      createBranch: () => promptText({
        title: `在 ${shortHash(commit.hash)} 上创建分支`,
        placeholder: '分支名称',
        submitLabel: value => `创建分支 “${value}”`,
        submit: name => { if (name.trim() !== '') run('commit.branch', name.trim(), commit.hash) },
      }),
      createTag: () => promptText({
        title: `在 ${shortHash(commit.hash)} 上创建标签`,
        placeholder: '标签名称',
        submitLabel: value => `创建标签 “${value}”`,
        submit: name => { if (name.trim() !== '') run('tag.create', commit.hash, name.trim()) },
      }),
      cherryPick: () => run('commit.cherrypick', undefined, commit.hash),
      reset: mode => { if (mode === 'hard' && !confirm('硬重置会丢弃工作区改动，继续？')) return; run('commit.reset', mode, commit.hash) },
      drop: () => { if (confirm('把这次提交从当前分支丢弃？如果它不是分支尾部，后续提交会被重放到它的父提交上。')) run('commit.drop', undefined, commit.hash) },
      revert: () => { if (confirm(`还原提交 ${shortHash(commit.hash)}？这会新增一个反向提交。`)) run('commit.revert', undefined, commit.hash) },
    },
  })

  const pickerElement: ReactNode = picker === undefined ? null : (() => {
    if (picker.kind === 'loading') return <QuickPick title={picker.title} items={[]} emptyText="读取中…" onClose={close} onPick={() => undefined}/>
    if (picker.kind === 'text') {
      const prompt = picker.prompt
      return <QuickPick title={prompt.title} placeholder={prompt.placeholder} allowEmpty={prompt.allowEmpty}
        submitLabel={prompt.submitLabel ?? (value => `确认 “${value}”`)}
        onSubmit={value => { close(); prompt.submit(value) }} onClose={close}/>
    }
    if (picker.kind === 'branch') {
      const { mode, branches } = picker
      const names = mode === 'delete' || mode === 'merge' || mode === 'rebase'
        ? branches.local.filter(name => name !== branches.current)
        : mode === 'rename' ? [...branches.local, ...branches.remote] : [...branches.local, ...branches.remote]
      const items: QuickPickItem[] = names.map(name => ({
        id: name, label: name, current: name === branches.current,
        ...(branches.remote.includes(name) ? { detail: '远程' } : {}),
      }))
      return <QuickPick title={BRANCH_TITLES[mode]} placeholder="搜索分支" items={items}
        emptyText="没有匹配的分支"
        onPick={item => {
          close()
          if (mode === 'switch') run('branch.switch', undefined, item.id)
          else if (mode === 'delete') { if (confirm(`删除分支 ${item.id}？未合并的分支会被 git 拒绝。`)) run('branch.delete', undefined, item.id) }
          else if (mode === 'merge') { if (confirm(`把 ${item.id} 合并到当前分支？`)) run('merge', undefined, item.id) }
          else if (mode === 'rebase') { if (confirm(`把当前分支变基到 ${item.id}？`)) run('rebase', undefined, item.id) }
          else promptText({ title: `重命名分支 ${item.id}`, placeholder: '新名称', submitLabel: value => `重命名为 “${value}”`, submit: name => { if (name.trim() !== '') run('branch.rename', item.id, name.trim()) } })
        }} onClose={close}/>
    }
    if (picker.kind === 'stash') {
      const items: QuickPickItem[] = picker.stashes.map(stash => ({ id: String(stash.index), label: `stash@{${stash.index}}`, detail: stash.message }))
      return <QuickPick title={picker.mode === 'drop' ? '删除贮藏…' : picker.mode === 'pop' ? '弹出贮藏…' : '应用贮藏…'} placeholder="搜索贮藏" items={items} emptyText="没有贮藏"
        onPick={item => {
          close()
          const index = item.id
          if (picker.mode === 'apply') run('stash.apply', undefined, index)
          else if (picker.mode === 'pop') run('stash.pop', undefined, index)
          else if (confirm(`删除 ${item.label}？`)) run('stash.drop', undefined, index)
        }} onClose={close}/>
    }
    if (picker.kind === 'tag') {
      const items: QuickPickItem[] = picker.tags.map(tag => ({ id: tag.name, label: tag.name, detail: tag.hash }))
      return <QuickPick title="删除标签…" placeholder="搜索标签" items={items} emptyText="没有标签"
        onPick={item => { close(); if (confirm(`删除标签 ${item.label}？`)) run('tag.delete', undefined, item.id) }} onClose={close}/>
    }
    const items: QuickPickItem[] = picker.remotes.map(name => ({ id: name, label: name }))
    return <QuickPick title="移除远程…" placeholder="搜索远程" items={items} emptyText="没有配置远程"
      onPick={item => { close(); if (confirm(`移除远程 ${item.label}？`)) run('remote.remove', undefined, item.id) }} onClose={close}/>
  })()

  return { actions, scmMenu, graphMenu, commitMenu, pickerElement }
}
