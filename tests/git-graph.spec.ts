import { describe, expect, it } from 'vitest'
import { graphSubtitle, refKind, refLabel, shortHash } from '../src/client/gitGraph.ts'

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
