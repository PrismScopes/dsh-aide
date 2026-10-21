import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { MenuEntry } from '../src/client/ContextMenu.tsx'
import { changeMenuItems, commitFileMenuItems, commitMenuItems, graphMenuItems, groupMenuItems, scmMenuItems, stashMenuItems, type ChangeMenuActions, type CommitFileMenuActions, type CommitMenuActions, type GitMenuActions, type GroupMenuActions } from '../src/client/gitMenus.ts'

type Item = Extract<MenuEntry, { kind: 'item' }>

/** 把菜单压成「id + 是否禁用（+ 子菜单 id 列表）」的序列，断言分组/嵌套顺序比逐字段比对清楚。 */
function shape(entries: readonly MenuEntry[]): string[] {
  return entries.map(entry => {
    if (entry.kind === 'separator') return '---'
    const children = entry.submenu === undefined ? undefined : entry.submenu.map(child => child.kind === 'separator' ? '---' : `${child.id}${child.disabled === true ? '(禁用)' : ''}`)
    return `${entry.id}${entry.disabled === true ? '(禁用)' : ''}${children === undefined ? '' : ` ▸ ${children.join(',')}`}`
  })
}

/** 所有菜单项（含子菜单里的），供「标签、危险标记、动作、id 唯一」这类断言复用。 */
function items(entries: readonly MenuEntry[]): Item[] {
  return entries.flatMap(entry => entry.kind === 'item' ? [entry, ...(entry.submenu === undefined ? [] : items(entry.submenu))] : [])
}

// vi.fn() 的类型是 Mock<Procedure>，不能直接赋给「() => void」参数；测试里只需要调用与调用计数，统一转一次。
function changeActions(): ChangeMenuActions {
  return { open: vi.fn(), stage: vi.fn(), unstage: vi.fn(), discard: vi.fn(), copyPath: vi.fn() } as unknown as ChangeMenuActions
}

function commitActions(): CommitMenuActions {
  return { copyHash: vi.fn(), toggleFiles: vi.fn(), copyMessage: vi.fn(), checkout: vi.fn(), createBranch: vi.fn(), createTag: vi.fn(), cherryPick: vi.fn(), revert: vi.fn(), reset: vi.fn(), drop: vi.fn() } as unknown as CommitMenuActions
}

function commitFileActions(): CommitFileMenuActions {
  return { openDiff: vi.fn(), copyPath: vi.fn() } as unknown as CommitFileMenuActions
}

const MENU_ACTION_KEYS = ['refresh', 'pull', 'push', 'fetch', 'sync', 'clone', 'checkout', 'commitStaged', 'commitAll', 'undoCommit', 'stageAll', 'unstageAll', 'discardAll', 'branchCreate', 'branchRename', 'branchDelete', 'branchMerge', 'branchRebase', 'openGraph', 'remoteAdd', 'remoteRemove', 'stashPush', 'stashApply', 'stashPop', 'stashDrop', 'tagCreate', 'tagDelete', 'tagPush', 'copyBranch', 'copyRepository', 'toggleTree', 'sortByPath', 'sortByName', 'loadMore', 'openFind', 'openBranchFilter', 'clearBranchFilter', 'toggleViewAuthor', 'toggleViewDate', 'toggleViewHash', 'toggleEmoji', 'showTagDetail', 'clearReviews', 'openRepoSettings', 'showOutput'] as const

function menuActions(): GitMenuActions & Record<typeof MENU_ACTION_KEYS[number], ReturnType<typeof vi.fn>> {
  return Object.fromEntries(MENU_ACTION_KEYS.map(key => [key, vi.fn()])) as unknown as GitMenuActions & Record<typeof MENU_ACTION_KEYS[number], ReturnType<typeof vi.fn>>
}

function groupActions(): GroupMenuActions {
  return { stageAll: vi.fn(), unstageAll: vi.fn(), discardAll: vi.fn(), refreshGraph: vi.fn(), toggleAllCommits: vi.fn(), loadMore: vi.fn(), collapseCommit: vi.fn() } as unknown as GroupMenuActions
}

interface ScmBase { busy: boolean; remote: boolean; stagedCount: number; changeCount: number; tree: boolean; sort: 'path' | 'name' }
const SCM_BASE: ScmBase = { busy: false, remote: true, stagedCount: 2, changeCount: 1, tree: false, sort: 'path' }

function scm(overrides: Partial<ScmBase> = {}, actions = menuActions()) {
  return scmMenuItems({ ...SCM_BASE, ...overrides, actions })
}

describe('change context menu', () => {
  it('offers open, stage and discard for an untracked worktree file', () => {
    const actions = changeActions()
    expect(shape(changeMenuItems({ path: 'src/new.ts', group: 'worktree', untracked: true, actions }))).toEqual([
      'open-change', '---',
      'stage-change', 'discard-change', '---',
      'copy-relative-path', 'copy-absolute-path(禁用)',
    ])
  })

  it('switches to unstage and disables discard for a staged change', () => {
    const actions = changeActions()
    // 已暂存的项不该出现「放弃更改」：撤销暂存才是正确路径，直接还原工作区会留下暂存区。
    expect(shape(changeMenuItems({ path: 'src/a.ts', group: 'staged', untracked: false, actions }))).toEqual([
      'open-change', '---',
      'unstage-change', 'discard-change(禁用)', '---',
      'copy-relative-path', 'copy-absolute-path(禁用)',
    ])
  })

  it('enables the absolute-path copy once the workspace root is known', () => {
    const actions = changeActions()
    const entries = changeMenuItems({ path: 'src/a.ts', group: 'worktree', untracked: false, absoluteRoot: 'H:/repo', actions })
    expect(shape(entries)).toContain('copy-absolute-path')
    expect(shape(entries)).not.toContain('copy-absolute-path(禁用)')
  })

  it('marks only discard as destructive and runs the bound actions', () => {
    const actions = changeActions()
    const worktree = items(changeMenuItems({ path: 'src/a.ts', group: 'worktree', untracked: false, actions }))
    expect(worktree.filter(entry => entry.danger === true).map(entry => entry.id)).toEqual(['discard-change'])
    worktree.forEach(entry => entry.onSelect())
    expect(actions.open).toHaveBeenCalledTimes(1)
    expect(actions.stage).toHaveBeenCalledTimes(1)
    expect(actions.discard).toHaveBeenCalledTimes(1)
    expect(actions.copyPath).toHaveBeenCalledWith(false)
    expect(actions.copyPath).toHaveBeenCalledWith(true)
  })
})

describe('commit context menu', () => {
  const commit = { hash: 'a1b2c3d', subject: 'feat: 中文提交说明' }

  it('lists read-only info first and the graph actions after a separator', () => {
    expect(shape(commitMenuItems({ commit, expanded: false, actions: commitActions() }))).toEqual([
      'copy-commit-hash', 'copy-commit-message', 'toggle-commit-files', '---',
      'commit-checkout', 'commit-create-branch', 'commit-create-tag', 'commit-cherry-pick', 'commit-revert', '---',
      'commit-reset ▸ commit-reset-soft,commit-reset-mixed,commit-reset-hard', 'commit-drop',
    ])
  })

  it('marks only revert as destructive', () => {
    const entries = items(commitMenuItems({ commit, expanded: false, actions: commitActions() }))
    expect(entries.filter(entry => entry.danger === true).map(entry => entry.id)).toEqual(['commit-revert', 'commit-reset-hard', 'commit-drop'])
  })

  it('renames the file toggle while the commit files are expanded', () => {
    const actions = commitActions()
    expect(commitMenuItems({ commit, expanded: true, actions }).find(entry => entry.kind === 'item' && entry.id === 'toggle-commit-files')).toMatchObject({ label: '隐藏提交文件' })
    expect(commitMenuItems({ commit, expanded: false, actions }).find(entry => entry.kind === 'item' && entry.id === 'toggle-commit-files')).toMatchObject({ label: '查看提交文件' })
  })

  it('runs every action bound to the clicked commit', () => {
    const actions = commitActions()
    items(commitMenuItems({ commit, expanded: false, actions })).forEach(entry => entry.onSelect())
    // reset 在子菜单里有三种模式，其余动作各一次。
    expect(actions.reset).toHaveBeenCalledTimes(3)
    for (const key of Object.keys(actions) as Array<keyof typeof actions>) {
      if (key === 'reset') continue
      expect(actions[key], key).toHaveBeenCalledTimes(1)
    }
  })
})

describe('source control title menu', () => {
  it('nests the VS Code submenus under one level', () => {
    expect(shape(scm())).toEqual([
      'scm-refresh', 'scm-view ▸ scm-view-tree,scm-view-sort-path,scm-view-sort-name', '---',
      'scm-pull', 'scm-push', 'scm-clone', 'scm-checkout', 'scm-fetch', '---',
      'scm-commit-group ▸ scm-commit-staged,scm-commit-all,scm-commit-undo',
      'scm-changes-group ▸ scm-changes-stage,scm-changes-unstage,scm-changes-discard',
      'scm-sync-group ▸ scm-sync-pull,scm-sync-push,scm-sync,scm-sync-fetch,scm-sync-tags',
      'scm-branch-group ▸ scm-branch-create,scm-branch-rename,scm-branch-delete,scm-branch-merge,scm-branch-rebase,scm-branch-graph',
      'scm-remote-group ▸ scm-remote-add,scm-remote-remove',
      'scm-stash-group ▸ scm-stash-push,scm-stash-push-staged,scm-stash-apply,scm-stash-pop,scm-stash-drop',
      'scm-tag-group ▸ scm-tag-create,scm-tag-delete,scm-tag-push', '---',
      'scm-output',
    ])
  })

  it('disables the remote actions until a remote is configured', () => {
    const withoutRemote = shape(scm({ remote: false }))
    for (const id of ['scm-pull(禁用)', 'scm-push(禁用)', 'scm-fetch(禁用)']) expect(withoutRemote).toContain(id)
    // 子菜单里的同名动作同样禁用，「拉取，推送」里不会出现能点的假入口。
    expect(withoutRemote.join(' ')).toContain('scm-sync-pull(禁用),scm-sync-push(禁用),scm-sync(禁用),scm-sync-fetch(禁用),scm-sync-tags(禁用)')
    expect(withoutRemote.join(' ')).toContain('scm-remote-remove(禁用)')
  })

  it('disables bulk staging and commits when the matching group is empty', () => {
    const empty = shape(scm({ stagedCount: 0, changeCount: 0 })).join(' ')
    expect(empty).toContain('scm-commit-staged(禁用)')
    expect(empty).toContain('scm-commit-all(禁用)')
    expect(empty).toContain('scm-changes-stage(禁用)')
    expect(empty).toContain('scm-changes-unstage(禁用)')
    expect(empty).toContain('scm-changes-discard(禁用)')
    expect(empty).toContain('scm-stash-push-staged(禁用)')
  })

  it('disables every action while a git command is running', () => {
    const busy = shape(scm({ busy: true })).filter(entry => entry !== '---').join(' ')
    // 克隆/添加远程这类「不改变仓库」的入口也一并禁用：忙时不该叠加第二条命令。
    for (const id of ['scm-refresh(禁用)', 'scm-clone(禁用)', 'scm-checkout(禁用)', 'scm-remote-add(禁用)', 'scm-branch-create(禁用)']) expect(busy).toContain(id)
  })

  it('marks only the destructive entries as danger', () => {
    const entries = items(scm())
    expect(entries.filter(entry => entry.danger === true).map(entry => entry.id)).toEqual(['scm-commit-undo', 'scm-changes-discard', 'scm-stash-drop'])
  })

  it('runs the actions bound to each entry', () => {
    const actions = menuActions()
    items(scm({}, actions)).forEach(entry => entry.onSelect())
    expect(actions.refresh).toHaveBeenCalledTimes(1)
    expect(actions.commitStaged).toHaveBeenCalledTimes(1)
    expect(actions.commitAll).toHaveBeenCalledTimes(1)
    expect(actions.undoCommit).toHaveBeenCalledTimes(1)
    expect(actions.stashPush).toHaveBeenCalledWith(false)
    expect(actions.stashPush).toHaveBeenCalledWith(true)
    expect(actions.openGraph).toHaveBeenCalledWith(false)
    expect(actions.clone).toHaveBeenCalledTimes(1)
    expect(actions.showOutput).toHaveBeenCalledTimes(1)
  })

  it('reflects the current sort order and tree mode in the view submenu', () => {
    expect(items(scm({ sort: 'path' })).find(entry => entry.id === 'scm-view-sort-path')?.label).toBe('按路径排序（当前）')
    expect(items(scm({ sort: 'name' })).find(entry => entry.id === 'scm-view-sort-name')?.label).toBe('按名称排序（当前）')
    expect(items(scm({ tree: true })).find(entry => entry.id === 'scm-view-tree')?.label).toBe('按路径列表查看')
    expect(items(scm({ tree: false })).find(entry => entry.id === 'scm-view-tree')?.label).toBe('按目录分组查看')
  })
})

describe('commit graph tab menu', () => {
  const base = { busy: false, remote: true, allCommits: false, canLoadMore: true }

  it('nests range, branch, stash and tag submenus', () => {
    expect(shape(graphMenuItems({ ...base, filtered: false, view: { showAuthor: true, showDate: true, showHash: true, emoji: true }, actions: menuActions() }))).toEqual([
      'graph-refresh', 'graph-find', 'graph-filter', 'graph-view ▸ graph-view-author,graph-view-date,graph-view-hash,graph-view-emoji,graph-view-clear-reviews', 'graph-repo-settings', 'graph-range ▸ graph-range-current,graph-range-all', 'graph-load-more', '---',
      'graph-checkout',
      'graph-branch-group ▸ graph-branch-create,graph-branch-delete,graph-branch-merge',
      'graph-stash-group ▸ graph-stash-push,graph-stash-apply,graph-stash-pop',
      'graph-tag-group ▸ graph-tag-create,graph-tag-detail,graph-tag-delete,graph-tag-push', '---',
      'graph-copy-branch',
    ])
  })

  it('marks the active range and disables load-more at the cap', () => {
    const all = graphMenuItems({ ...base, filtered: false, view: { showAuthor: true, showDate: true, showHash: true, emoji: true }, allCommits: true, canLoadMore: false, actions: menuActions() })
    expect(items(all).find(entry => entry.id === 'graph-range-all')).toMatchObject({ label: '全部分支（当前）' })
    expect(items(all).find(entry => entry.id === 'graph-load-more')).toMatchObject({ disabled: true })
  })

  it('disables tag push without a remote and switches the range through openGraph', () => {
    const noRemote = items(graphMenuItems({ ...base, filtered: false, view: { showAuthor: true, showDate: true, showHash: true, emoji: true }, remote: false, actions: menuActions() }))
    expect(noRemote.find(entry => entry.id === 'graph-tag-push')?.disabled).toBe(true)
    const actions = menuActions()
    items(graphMenuItems({ ...base, filtered: false, view: { showAuthor: true, showDate: true, showHash: true, emoji: true }, actions })).forEach(entry => entry.onSelect())
    expect(actions.openGraph).toHaveBeenCalledWith(false)
    expect(actions.openGraph).toHaveBeenCalledWith(true)
    expect(actions.copyBranch).toHaveBeenCalledTimes(1)
    expect(actions.loadMore).toHaveBeenCalledTimes(1)
  })
})

describe('group title menus', () => {
  const base = { busy: false, count: 3, allCommits: false, canLoadMore: true, expandedCommit: false }

  it('offers unstage-all only on the staged group', () => {
    expect(shape(groupMenuItems({ ...base, group: 'staged', actions: groupActions() }))).toEqual(['group-unstage-all'])
  })

  it('offers stage-all and discard-all on the changes group', () => {
    const entries = groupMenuItems({ ...base, group: 'changes', actions: groupActions() })
    expect(shape(entries)).toEqual(['group-stage-all', 'group-discard-all'])
    expect(items(entries).filter(entry => entry.danger === true).map(entry => entry.id)).toEqual(['group-discard-all'])
  })

  it('toggles the graph scope label and disables load-more at the cap', () => {
    const all = groupMenuItems({ ...base, group: 'graph', allCommits: true, canLoadMore: false, actions: groupActions() })
    expect(shape(all)).toEqual(['graph-refresh', 'graph-toggle-all', 'graph-load-more(禁用)', 'graph-collapse-commit(禁用)'])
    expect(all.find(entry => entry.kind === 'item' && entry.id === 'graph-toggle-all')).toMatchObject({ label: '仅显示当前分支' })
    expect(groupMenuItems({ ...base, group: 'graph', actions: groupActions() }).find(entry => entry.kind === 'item' && entry.id === 'graph-toggle-all')).toMatchObject({ label: '显示全部分支' })
  })

  it('runs the graph actions', () => {
    const actions = groupActions()
    items(groupMenuItems({ ...base, group: 'graph', actions })).forEach(entry => entry.onSelect())
    expect(actions.refreshGraph).toHaveBeenCalledTimes(1)
    expect(actions.toggleAllCommits).toHaveBeenCalledTimes(1)
    expect(actions.loadMore).toHaveBeenCalledTimes(1)
    expect(actions.collapseCommit).toHaveBeenCalledTimes(1)
  })
})

describe('stash row menu', () => {
  it('offers apply, pop, copy and a destructive drop', () => {
    const actions = { apply: vi.fn(), pop: vi.fn(), drop: vi.fn(), copyName: vi.fn() }
    const entries = stashMenuItems({ label: 'stash@{0}: On main: 说明', actions })
    expect(shape(entries)).toEqual(['stash-apply', 'stash-pop', 'stash-copy', '---', 'stash-drop'])
    expect(items(entries).filter(entry => entry.danger === true).map(entry => entry.id)).toEqual(['stash-drop'])
    items(entries).forEach(entry => entry.onSelect())
    expect(actions.apply).toHaveBeenCalledTimes(1)
    expect(actions.copyName).toHaveBeenCalledTimes(1)
  })
})

describe('graph find and branch filter entries', () => {
  const base = { busy: false, remote: true, allCommits: false, canLoadMore: true }

  it('shows the branch-filter entry in the clear state when a filter is active', () => {
    expect(shape(graphMenuItems({ ...base, filtered: false, view: { showAuthor: true, showDate: true, showHash: true, emoji: true }, actions: menuActions() }))).toContain('graph-filter')
    expect(items(graphMenuItems({ ...base, filtered: true, view: { showAuthor: true, showDate: true, showHash: true, emoji: true }, actions: menuActions() })).find(entry => entry.id === 'graph-filter')?.label).toBe('清除分支过滤')
  })

  it('wires find and filter to their actions', () => {
    const actions = menuActions()
    const entries = items(graphMenuItems({ ...base, filtered: false, view: { showAuthor: true, showDate: true, showHash: true, emoji: true }, actions }))
    entries.find(entry => entry.id === 'graph-find')?.onSelect()
    entries.find(entry => entry.id === 'graph-filter')?.onSelect()
    expect(actions.openFind).toHaveBeenCalledTimes(1)
    expect(actions.openBranchFilter).toHaveBeenCalledTimes(1)
    const clear = items(graphMenuItems({ ...base, filtered: true, view: { showAuthor: true, showDate: true, showHash: true, emoji: true }, actions }))
    clear.find(entry => entry.id === 'graph-filter')?.onSelect()
    expect(actions.clearBranchFilter).toHaveBeenCalledTimes(1)
  })
})
describe('git menu labels', () => {
  const chinese = /[\u4e00-\u9fff]/

  /** 所有会出现在工作台里的菜单（含子菜单项）。 */
  function allMenus(): MenuEntry[][] {
    return [
      changeMenuItems({ path: 'src/a.ts', group: 'worktree', untracked: false, actions: changeActions() }),
      changeMenuItems({ path: 'src/a.ts', group: 'staged', untracked: false, actions: changeActions() }),
      commitMenuItems({ commit: { hash: 'a1b2c3d', subject: 'feat: 中文提交说明' }, expanded: false, actions: commitActions() }),
      commitFileMenuItems({ path: 'src/a.ts', actions: commitFileActions() }),
      scm(),
      graphMenuItems({ busy: false, remote: true, allCommits: false, canLoadMore: true, filtered: false, view: { showAuthor: true, showDate: true, showHash: true, emoji: true }, actions: menuActions() }),
      stashMenuItems({ label: 'stash@{0}: On main: 说明', actions: { apply: vi.fn(), pop: vi.fn(), drop: vi.fn(), copyName: vi.fn() } }),
      groupMenuItems({ group: 'changes', busy: false, count: 1, allCommits: false, canLoadMore: true, expandedCommit: false, actions: groupActions() }),
      groupMenuItems({ group: 'graph', busy: false, count: 1, allCommits: false, canLoadMore: true, expandedCommit: false, actions: groupActions() }),
    ]
  }

  it('uses Chinese labels for every item, allowing only the product name Git', () => {
    for (const entries of allMenus()) {
      for (const entry of items(entries)) {
        expect(entry.label, `菜单项 ${entry.id} 的标签应含中文`).toMatch(chinese)
        // 标签里出现英文单词通常是从 VS Code 原样抄来的文案；「Git」是产品名，放行。
        expect(entry.label.replace(/Git/g, ''), `菜单项 ${entry.id} 的标签不应含英文单词`).not.toMatch(/[A-Za-z]{2,}/)
      }
    }
  })

  it('keeps ids unique inside every menu, including nested submenus', () => {
    for (const entries of allMenus()) {
      const ids = items(entries).map(entry => entry.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('renders the git context menus through the shared ContextMenu instead of a hand-written one', () => {
    // Git 面板里不再保留手写的菜单容器（如 .dvw-context-menu 那种），否则样式与键盘行为会分叉。
    const source = readFileSync(new URL('../src/client/GitPanel.tsx', import.meta.url), 'utf8')
    expect(source).toContain('<ContextMenu')
    expect(source).not.toContain('dvw-context-menu')
    // 菜单结构在 gitMenus，动作与选择器在 gitCommands：面板与提交图标签页共用一份。
    expect(source).toContain("from './gitMenus.ts'")
    expect(source).toContain('useGitCommands')
  })
})
