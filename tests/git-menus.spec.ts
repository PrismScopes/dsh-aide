import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { MenuEntry } from '../src/client/ContextMenu.tsx'
import { changeMenuItems, commitFileMenuItems, commitMenuItems, groupMenuItems, scmMenuItems } from '../src/client/gitMenus.ts'

/** 把菜单项压成「id + 是否禁用」的序列，断言分组顺序比逐个字段比对清楚。 */
function shape(entries: readonly MenuEntry[]): string[] {
  return entries.map(entry => entry.kind === 'separator' ? '---' : `${entry.id}${entry.disabled === true ? '(禁用)' : ''}`)
}

/** 菜单项（跳过分隔线），供「标签、危险标记、动作」这类逐项断言复用。 */
function items(entries: readonly MenuEntry[]): Extract<MenuEntry, { kind: 'item' }>[] {
  return entries.filter((entry): entry is Extract<MenuEntry, { kind: 'item' }> => entry.kind === 'item')
}

function changeActions() {
  return { open: vi.fn(), stage: vi.fn(), unstage: vi.fn(), discard: vi.fn(), copyPath: vi.fn() }
}

function commitActions() {
  return { copyHash: vi.fn(), toggleFiles: vi.fn(), copyMessage: vi.fn(), checkout: vi.fn(), createBranch: vi.fn(), cherryPick: vi.fn(), revert: vi.fn() }
}

function scmActions() {
  return { refresh: vi.fn(), fetch: vi.fn(), pull: vi.fn(), push: vi.fn(), sync: vi.fn(), stageAll: vi.fn(), unstageAll: vi.fn(), discardAll: vi.fn(), checkout: vi.fn(), createBranch: vi.fn(), deleteBranch: vi.fn() }
}

function groupActions() {
  return { stageAll: vi.fn(), unstageAll: vi.fn(), discardAll: vi.fn(), refreshGraph: vi.fn(), toggleAllCommits: vi.fn(), loadMore: vi.fn(), collapseCommit: vi.fn() }
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

  it('marks only discard as destructive', () => {
    const entries = items(changeMenuItems({ path: 'src/a.ts', group: 'worktree', untracked: false, actions: changeActions() }))
    expect(entries.filter(entry => entry.danger === true).map(entry => entry.id)).toEqual(['discard-change'])
  })

  it('runs the actions bound to the clicked change', () => {
    const actions = changeActions()
    const worktree = items(changeMenuItems({ path: 'src/a.ts', group: 'worktree', untracked: false, actions }))
    worktree.find(entry => entry.id === 'open-change')?.onSelect()
    worktree.find(entry => entry.id === 'stage-change')?.onSelect()
    worktree.find(entry => entry.id === 'discard-change')?.onSelect()
    worktree.find(entry => entry.id === 'copy-relative-path')?.onSelect()
    expect(actions.open).toHaveBeenCalledTimes(1)
    expect(actions.stage).toHaveBeenCalledTimes(1)
    expect(actions.discard).toHaveBeenCalledTimes(1)
    expect(actions.copyPath).toHaveBeenCalledWith(false)

    const staged = items(changeMenuItems({ path: 'src/a.ts', group: 'staged', untracked: false, absoluteRoot: 'H:/repo', actions }))
    staged.find(entry => entry.id === 'unstage-change')?.onSelect()
    staged.find(entry => entry.id === 'copy-absolute-path')?.onSelect()
    expect(actions.unstage).toHaveBeenCalledTimes(1)
    expect(actions.copyPath).toHaveBeenCalledWith(true)
  })
})

describe('commit context menu', () => {
  const commit = { hash: 'a1b2c3d', subject: 'feat: 中文提交说明' }

  it('lists read-only info first and the graph actions after a separator', () => {
    const actions = commitActions()
    expect(shape(commitMenuItems({ commit, expanded: false, actions }))).toEqual([
      'copy-commit-hash', 'toggle-commit-files', 'copy-commit-message', '---',
      'commit-checkout', 'commit-create-branch', 'commit-cherry-pick', 'commit-revert',
    ])
  })

  it('marks only revert as destructive', () => {
    const entries = items(commitMenuItems({ commit, expanded: false, actions: commitActions() }))
    expect(entries.filter(entry => entry.danger === true).map(entry => entry.id)).toEqual(['commit-revert'])
  })

  it('renames the file toggle while the commit files are expanded', () => {
    const actions = commitActions()
    expect(commitMenuItems({ commit, expanded: true, actions }).find(entry => entry.kind === 'item' && entry.id === 'toggle-commit-files')).toMatchObject({ label: '隐藏提交文件' })
    expect(commitMenuItems({ commit, expanded: false, actions }).find(entry => entry.kind === 'item' && entry.id === 'toggle-commit-files')).toMatchObject({ label: '查看提交文件' })
  })

  it('runs the actions bound to the clicked commit', () => {
    const actions = commitActions()
    const entries = items(commitMenuItems({ commit, expanded: false, actions }))
    entries.forEach(entry => entry.onSelect())
    expect(actions.copyHash).toHaveBeenCalledTimes(1)
    expect(actions.toggleFiles).toHaveBeenCalledTimes(1)
    expect(actions.copyMessage).toHaveBeenCalledTimes(1)
    expect(actions.checkout).toHaveBeenCalledTimes(1)
    expect(actions.createBranch).toHaveBeenCalledTimes(1)
    expect(actions.cherryPick).toHaveBeenCalledTimes(1)
    expect(actions.revert).toHaveBeenCalledTimes(1)
  })
})

describe('source control title menu', () => {
  const base = { busy: false, remote: true, stagedCount: 1, changeCount: 2 }

  it('groups sync, bulk staging and branch actions in VS Code order', () => {
    expect(shape(scmMenuItems({ ...base, actions: scmActions() }))).toEqual([
      'scm-refresh', '---',
      'scm-pull', 'scm-push', 'scm-sync', 'scm-fetch', '---',
      'scm-stage-all', 'scm-unstage-all', 'scm-discard-all', '---',
      'scm-checkout', 'scm-create-branch', 'scm-delete-branch',
    ])
  })

  it('disables the remote actions until a remote is configured', () => {
    const shapeWithoutRemote = shape(scmMenuItems({ ...base, remote: false, actions: scmActions() }))
    for (const id of ['scm-pull', 'scm-push', 'scm-sync', 'scm-fetch']) expect(shapeWithoutRemote).toContain(`${id}(禁用)`)
  })

  it('disables bulk staging when the matching group is empty', () => {
    const empty = shape(scmMenuItems({ ...base, stagedCount: 0, changeCount: 0, actions: scmActions() }))
    expect(empty).toContain('scm-stage-all(禁用)')
    expect(empty).toContain('scm-unstage-all(禁用)')
    expect(empty).toContain('scm-discard-all(禁用)')
  })

  it('disables every action while a git command is running', () => {
    const busy = shape(scmMenuItems({ ...base, busy: true, actions: scmActions() }))
    expect(busy.filter(entry => entry !== '---').every(entry => entry.endsWith('(禁用)'))).toBe(true)
  })

  it('marks only discard-all as destructive and runs the bound actions', () => {
    const actions = scmActions()
    const entries = items(scmMenuItems({ ...base, actions }))
    expect(entries.filter(entry => entry.danger === true).map(entry => entry.id)).toEqual(['scm-discard-all'])
    entries.forEach(entry => entry.onSelect())
    expect(actions.refresh).toHaveBeenCalledTimes(1)
    expect(actions.sync).toHaveBeenCalledTimes(1)
    expect(actions.stageAll).toHaveBeenCalledTimes(1)
    expect(actions.checkout).toHaveBeenCalledTimes(1)
    expect(actions.deleteBranch).toHaveBeenCalledTimes(1)
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

describe('commit file context menu', () => {
  it('offers open-diff and copy-path', () => {
    expect(shape(commitFileMenuItems({ path: 'src/a.ts', actions: { openDiff: vi.fn(), copyPath: vi.fn() } }))).toEqual([
      'open-commit-file-diff', 'copy-commit-file-path',
    ])
  })

  it('runs both actions', () => {
    const actions = { openDiff: vi.fn(), copyPath: vi.fn() }
    items(commitFileMenuItems({ path: 'src/a.ts', actions })).forEach(entry => entry.onSelect())
    expect(actions.openDiff).toHaveBeenCalledTimes(1)
    expect(actions.copyPath).toHaveBeenCalledTimes(1)
  })
})

describe('git menu labels', () => {
  const chinese = /[\u4e00-\u9fff]/

  it('uses Chinese labels for every item in all six menus', () => {
    const menus: MenuEntry[][] = [
      changeMenuItems({ path: 'src/a.ts', group: 'worktree', untracked: false, actions: changeActions() }),
      changeMenuItems({ path: 'src/a.ts', group: 'staged', untracked: false, actions: changeActions() }),
      commitMenuItems({ commit: { hash: 'a1b2c3d', subject: 'feat: 中文提交说明' }, expanded: false, actions: commitActions() }),
      commitFileMenuItems({ path: 'src/a.ts', actions: { openDiff: vi.fn(), copyPath: vi.fn() } }),
      scmMenuItems({ busy: false, remote: true, stagedCount: 1, changeCount: 1, actions: scmActions() }),
      groupMenuItems({ group: 'graph', busy: false, count: 1, allCommits: false, canLoadMore: true, expandedCommit: true, actions: groupActions() }),
    ]
    for (const entries of menus) {
      for (const entry of items(entries)) {
        expect(entry.label, `菜单项 ${entry.id} 的标签应含中文`).toMatch(chinese)
        // 标签里出现英文单词通常是从 VS Code 原样抄来的文案，这里不放行。
        expect(entry.label, `菜单项 ${entry.id} 的标签不应含英文单词`).not.toMatch(/[A-Za-z]{2,}/)
      }
    }
  })

  it('keeps ids unique inside every menu', () => {
    const menus = [
      changeMenuItems({ path: 'src/a.ts', group: 'worktree', untracked: false, actions: changeActions() }),
      commitMenuItems({ commit: { hash: 'a1b2c3d', subject: 'feat: 中文提交说明' }, expanded: true, actions: commitActions() }),
      commitFileMenuItems({ path: 'src/a.ts', actions: { openDiff: vi.fn(), copyPath: vi.fn() } }),
      scmMenuItems({ busy: false, remote: true, stagedCount: 1, changeCount: 1, actions: scmActions() }),
      groupMenuItems({ group: 'staged', busy: false, count: 1, allCommits: false, canLoadMore: true, expandedCommit: false, actions: groupActions() }),
      groupMenuItems({ group: 'changes', busy: false, count: 1, allCommits: false, canLoadMore: true, expandedCommit: false, actions: groupActions() }),
      groupMenuItems({ group: 'graph', busy: false, count: 1, allCommits: false, canLoadMore: true, expandedCommit: false, actions: groupActions() }),
    ]
    for (const entries of menus) {
      const ids = items(entries).map(entry => entry.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('renders the git context menus through the shared ContextMenu instead of a hand-written one', () => {
    // Git 面板里不再保留手写的菜单容器（如 .dvw-context-menu 那种），否则样式与键盘行为会分叉。
    const source = readFileSync(new URL('../src/client/GitPanel.tsx', import.meta.url), 'utf8')
    expect(source).toContain('<ContextMenu')
    expect(source).not.toContain('dvw-context-menu')
    expect(source).toContain("from './gitMenus.ts'")
  })
})
