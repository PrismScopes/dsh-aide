import { describe, expect, it } from 'vitest'
import { branchTips, buildGraphList, filterCommits, graphSubtitle, reachableCommits, refKind, refLabel, shortHash } from '../src/client/gitGraph.ts'

describe('提交图引用分类', () => {
  it('separates HEAD, tags, remote branches and local branches', () => {
    expect(refKind('HEAD')).toBe('head')
    expect(refKind('HEAD -> main')).toBe('head')
    expect(refKind('tag: v0.3.1')).toBe('tag')
    expect(refKind('origin/main', ['origin'])).toBe('remote')
    expect(refKind('main', ['origin'])).toBe('branch')
  })

  it('does not mistake a local branch containing a slash for a remote one', () => {
    // 本地分支允许带 `/`（feature/x）；只有「远程名 + 斜杠」才算远程分支。
    expect(refKind('feature/x', ['origin'])).toBe('branch')
    expect(refKind('origin/feature/x', ['origin'])).toBe('remote')
    expect(refKind('upstream/main', ['origin'])).toBe('branch')
  })

  it('renders HEAD and tag decorations without their prefixes', () => {
    expect(refLabel('HEAD -> main')).toBe('main')
    expect(refLabel('tag: v0.3.1')).toBe('v0.3.1')
    expect(refLabel('origin/main')).toBe('origin/main')
    expect(refLabel('main')).toBe('main')
  })
})

describe('提交图行信息', () => {
  it('shortens the hash the way git log --oneline does', () => {
    expect(shortHash('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')).toBe('a1b2c3d')
    expect(shortHash('abc')).toBe('abc')
  })

  it('builds the author · hash subtitle', () => {
    expect(graphSubtitle({ author: '棱镜视察', hash: 'a1b2c3d4e5f' })).toBe('棱镜视察 · a1b2c3d')
  })
})

describe('提交查找与分支过滤', () => {
  const commits = [
    { hash: 'aaaaaaa1', parents: ['bbbbbbb2'], subject: 'feat: 搜索面板', author: '棱镜视察', refs: ['HEAD -> main', 'origin/main'] },
    { hash: 'bbbbbbb2', parents: ['ccccccc3'], subject: 'fix: 终端预热', author: '别的作者', refs: [] },
    { hash: 'ccccccc3', parents: [], subject: 'chore: 初始化', author: '棱镜视察', refs: ['tag: v0.1.0'] },
  ]

  it('matches every word against subject, author, hash and refs', () => {
    expect(filterCommits(commits, '').length).toBe(3)
    expect(filterCommits(commits, '搜索').map(commit => commit.hash)).toEqual(['aaaaaaa1'])
    expect(filterCommits(commits, '棱镜 搜索').map(commit => commit.hash)).toEqual(['aaaaaaa1'])
    expect(filterCommits(commits, 'bbbb').map(commit => commit.hash)).toEqual(['bbbbbbb2'])
    expect(filterCommits(commits, 'origin').length).toBe(1)
    expect(filterCommits(commits, '不存在的词')).toEqual([])
  })

  it('walks parents inside the loaded window for branch filtering', () => {
    const reachable = reachableCommits(commits, ['aaaaaaa1'])
    expect([...reachable].sort()).toEqual(['aaaaaaa1', 'bbbbbbb2', 'ccccccc3'])
    expect([...reachableCommits(commits, ['bbbbbbb2'])].sort()).toEqual(['bbbbbbb2', 'ccccccc3'])
    expect(reachableCommits(commits, [])).toEqual(new Set())
  })

  it('resolves branch names (including remote refs) to tip hashes', () => {
    expect(branchTips(commits, new Set(['main']))).toEqual(['aaaaaaa1'])
    expect(branchTips(commits, new Set(['origin/main']))).toEqual(['aaaaaaa1'])
    expect(branchTips(commits, new Set(['v0.1.0']))).toEqual([])
    expect(branchTips(commits, new Set())).toEqual([])
  })
})

describe('提交图列表条目', () => {
  it('puts uncommitted changes first, then stashes, then commits', () => {
    expect(buildGraphList({ commitCount: 2, stashCount: 2, hasUncommitted: true })).toEqual([
      { kind: 'uncommitted', index: -1 },
      { kind: 'stash', index: 0 },
      { kind: 'stash', index: 1 },
      { kind: 'commit', index: 0 },
      { kind: 'commit', index: 1 },
    ])
  })

  it('omits the uncommitted row when the worktree is clean and handles empty histories', () => {
    expect(buildGraphList({ commitCount: 1, stashCount: 0, hasUncommitted: false })).toEqual([{ kind: 'commit', index: 0 }])
    expect(buildGraphList({ commitCount: 0, stashCount: 0, hasUncommitted: false })).toEqual([])
  })
})
