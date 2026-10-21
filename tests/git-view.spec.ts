import { describe, expect, it } from 'vitest'
import { COLUMN_WIDTH, DEFAULT_GIT_VIEW, clampColumnWidth, gitViewStorageKey, parseGitViewSettings } from '../src/client/gitView.ts'
import { issueSegments, parseRemoteUrl, pullRequestUrl, replaceEmojiShortcodes } from '../src/client/gitText.ts'
import { REVIEW_TTL_MS, isReviewed, markReviewed, parseReviewStore, pruneReviewStore, reviewProgress, reviewScopeKey, reviewStorageKey } from '../src/client/gitReview.ts'

describe('提交图视图设置', () => {
  it('defaults to the three columns and emoji replacement', () => {
    expect(parseGitViewSettings(null)).toEqual(DEFAULT_GIT_VIEW)
    expect(DEFAULT_GIT_VIEW.emoji).toBe(true)
    expect(DEFAULT_GIT_VIEW.showAuthor && DEFAULT_GIT_VIEW.showDate && DEFAULT_GIT_VIEW.showHash).toBe(true)
  })

  it('falls back per field instead of discarding the whole object', () => {
    const parsed = parseGitViewSettings(JSON.stringify({ showAuthor: false, authorWidth: 'wide', dateWidth: 130, emoji: false }))
    expect(parsed).toEqual({ ...DEFAULT_GIT_VIEW, showAuthor: false, dateWidth: 130, emoji: false })
  })

  it('treats broken storage as defaults', () => {
    expect(parseGitViewSettings('not json')).toEqual(DEFAULT_GIT_VIEW)
    expect(parseGitViewSettings('[]')).toEqual(DEFAULT_GIT_VIEW)
  })

  it('clamps column widths into the allowed range', () => {
    expect(clampColumnWidth(999, 90)).toBe(COLUMN_WIDTH.max)
    expect(clampColumnWidth(1, 90)).toBe(COLUMN_WIDTH.min)
    expect(clampColumnWidth(Number.NaN, 90)).toBe(90)
    expect(parseGitViewSettings(JSON.stringify({ hashWidth: 5 })).hashWidth).toBe(COLUMN_WIDTH.min)
  })

  it('keys the view settings per repository', () => {
    expect(gitViewStorageKey('H:/repo')).toBe('dvw:git-view:v1:H:/repo')
  })
})

describe('emoji 短代码', () => {
  it('replaces known gitmoji and leaves unknown ones untouched', () => {
    expect(replaceEmojiShortcodes(':bug: fix :sparkles:')).toBe('🐛 fix ✨')
    expect(replaceEmojiShortcodes(':unknown_code: keep')).toBe(':unknown_code: keep')
    expect(replaceEmojiShortcodes('a :BUG: b')).toBe('a 🐛 b')
    expect(replaceEmojiShortcodes('no codes')).toBe('no codes')
  })
})

describe('远程 URL 解析', () => {
  it('parses https, scp-style ssh and ssh:// URLs', () => {
    expect(parseRemoteUrl('https://github.com/owner/repo.git')).toEqual({ provider: 'github', repoUrl: 'https://github.com/owner/repo' })
    expect(parseRemoteUrl('git@github.com:owner/repo.git')).toEqual({ provider: 'github', repoUrl: 'https://github.com/owner/repo' })
    expect(parseRemoteUrl('ssh://git@gitlab.com/owner/repo.git')).toEqual({ provider: 'gitlab', repoUrl: 'https://gitlab.com/owner/repo' })
    expect(parseRemoteUrl('git@bitbucket.org:owner/repo.git')).toEqual({ provider: 'bitbucket', repoUrl: 'https://bitbucket.org/owner/repo' })
  })

  it('rejects empty, unsupported and malformed remotes', () => {
    expect(parseRemoteUrl('')).toBeUndefined()
    expect(parseRemoteUrl('https://example.com/owner/repo.git')).toBeUndefined()
    expect(parseRemoteUrl('not a url')).toBeUndefined()
  })
})

describe('Issue 链接', () => {
  it('links issue numbers and leaves the surrounding text intact', () => {
    expect(issueSegments('fix #12 and #34', 'github', 'https://github.com/o/r')).toEqual([
      { text: 'fix ' },
      { text: '#12', url: 'https://github.com/o/r/issues/12' },
      { text: ' and ' },
      { text: '#34', url: 'https://github.com/o/r/issues/34' },
    ])
  })

  it('uses the provider specific path and ignores a#1 style matches', () => {
    expect(issueSegments('#7', 'gitlab', 'https://gitlab.com/o/r')).toEqual([{ text: '#7', url: 'https://gitlab.com/o/r/-/issues/7' }])
    expect(issueSegments('a#1', 'github', 'https://github.com/o/r')).toEqual([{ text: 'a#1' }])
  })

  it('degrades to plain text without a provider', () => {
    expect(issueSegments('fix #1', 'none', 'https://github.com/o/r')).toEqual([{ text: 'fix #1' }])
    expect(issueSegments('fix #1', 'github', undefined)).toEqual([{ text: 'fix #1' }])
  })
})

describe('Pull Request 链接', () => {
  it('builds the three provider URLs', () => {
    expect(pullRequestUrl('github', 'https://github.com/o/r', 'feature/x', 'main')).toBe('https://github.com/o/r/compare/main...feature%2Fx?expand=1')
    expect(pullRequestUrl('gitlab', 'https://gitlab.com/o/r', 'feature/x', 'main')).toBe('https://gitlab.com/o/r/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fx&merge_request%5Btarget_branch%5D=main')
    expect(pullRequestUrl('bitbucket', 'https://bitbucket.org/o/r', 'feature/x', 'main')).toBe('https://bitbucket.org/o/r/pull-requests/new?source=feature%2Fx&dest=main')
  })

  it('returns undefined when the provider is unset or the branches are the same', () => {
    expect(pullRequestUrl('none', 'https://github.com/o/r', 'a', 'b')).toBeUndefined()
    expect(pullRequestUrl('github', undefined, 'a', 'b')).toBeUndefined()
    expect(pullRequestUrl('github', 'https://github.com/o/r', 'main', 'main')).toBeUndefined()
    expect(pullRequestUrl('github', 'https://github.com/o/r', '', 'main')).toBeUndefined()
  })
})

describe('代码审查记录', () => {
  const now = 1_700_000_000_000
  const scope = reviewScopeKey({ kind: 'commit', hash: 'a1b2c3d' })

  it('keys commit and compare scopes', () => {
    expect(scope).toBe('commit:a1b2c3d')
    expect(reviewScopeKey({ kind: 'compare', from: 'aaa', to: 'bbb' })).toBe('compare:aaa..bbb')
    expect(reviewStorageKey('H:/repo')).toBe('dvw:git-review:v1:H:/repo')
  })

  it('marks files reviewed and back, without mutating the input store', () => {
    const empty = {}
    const one = markReviewed(empty, scope, 'src/a.ts', true, now)
    expect(empty).toEqual({})
    expect(isReviewed(one, scope, 'src/a.ts')).toBe(true)
    const back = markReviewed(one, scope, 'src/a.ts', false, now)
    expect(back).toEqual({})
    expect(isReviewed(one, scope, 'src/a.ts')).toBe(true)
  })

  it('reports review progress', () => {
    const store = markReviewed(markReviewed({}, scope, 'a.ts', true, now), scope, 'b.ts', true, now)
    expect(reviewProgress(store, scope, ['a.ts', 'b.ts', 'c.ts'])).toEqual({ reviewed: 2, total: 3 })
    expect(reviewProgress(store, 'commit:other', ['a.ts'])).toEqual({ reviewed: 0, total: 1 })
  })

  it('prunes records older than 90 days and tolerates broken JSON', () => {
    const old = markReviewed({}, scope, 'old.ts', true, now - REVIEW_TTL_MS - 1)
    const fresh = markReviewed(old, scope, 'fresh.ts', true, now)
    expect(pruneReviewStore(fresh, now)).toEqual({ [scope]: { 'fresh.ts': now } })
    expect(parseReviewStore('not json')).toEqual({})
    expect(parseReviewStore(JSON.stringify({ [scope]: { 'a.ts': 1, 'b.ts': 'bad' } }))).toEqual({ [scope]: { 'a.ts': 1 } })
  })
})
