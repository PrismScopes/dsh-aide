import { describe, expect, it } from 'vitest'
import { DEFAULT_SEARCH, flattenRows, groupMatches, highlightSegments, parseSearchState, regexProblem, stepIndex } from '../src/client/searchView.ts'
import type { SearchMatch } from '../src/types.ts'

function hit(path: string, line: number, column: number, match: string, preview = ''): SearchMatch {
  return { path, line, column, match, preview }
}

describe('search result grouping', () => {
  it('groups matches by file and keeps one row per match with all line highlights', () => {
    const files = groupMatches([
      hit('src/b.ts', 3, 5, 'foo', 'let foo = foo'),
      hit('src/b.ts', 3, 11, 'foo', 'let foo = foo'),
      hit('src/a.ts', 1, 1, 'x', 'x'),
    ])
    expect(files.map(file => file.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(files[0]).toMatchObject({ name: 'a.ts', directory: 'src/' })
    expect(files[1]).toMatchObject({ name: 'b.ts', directory: 'src/' })
    expect(files[1]?.rows.map(row => row.column)).toEqual([5, 11])
    // 每条结果行都带着整行的高亮区间：预览里两处 foo 都会标出来。
    expect(files[1]?.rows[0]?.hits).toEqual([{ start: 4, length: 3 }, { start: 10, length: 3 }])
    expect(files[1]?.rows[1]?.hits).toEqual([{ start: 4, length: 3 }, { start: 10, length: 3 }])
  })

  it('drops duplicate matches for the same position but keeps distinct columns', () => {
    const files = groupMatches([
      hit('a.ts', 2, 4, 'foo'),
      hit('a.ts', 2, 4, 'foo'),
      hit('a.ts', 2, 9, 'foo'),
    ])
    expect(files).toHaveLength(1)
    expect(files[0]?.rows.map(row => row.column)).toEqual([4, 9])
    expect(files[0]?.rows[0]?.hits).toHaveLength(2)
  })

  it('splits a workspace-root path into name and empty directory', () => {
    expect(groupMatches([hit('README.md', 1, 1, 'x')])[0]).toMatchObject({ path: 'README.md', name: 'README.md', directory: '' })
  })

  it('sorts rows by line then column and handles an empty result', () => {
    const files = groupMatches([hit('a.ts', 9, 2, 'a'), hit('a.ts', 1, 7, 'a'), hit('a.ts', 1, 2, 'a')])
    expect(files[0]?.rows.map(row => [row.line, row.column])).toEqual([[1, 2], [1, 7], [9, 2]])
    expect(groupMatches([])).toEqual([])
  })

  it('flattens rows in display order for F4 navigation', () => {
    const files = groupMatches([hit('b.ts', 1, 1, 'x'), hit('a.ts', 1, 1, 'x'), hit('a.ts', 2, 1, 'x')])
    expect(flattenRows(files).map(row => `${row.path}:${row.line}`)).toEqual(['a.ts:1', 'a.ts:2', 'b.ts:1'])
  })
})

describe('search preview highlighting', () => {
  it('splits a preview into plain and hit segments', () => {
    expect(highlightSegments('let foo = foo', [{ start: 4, length: 3 }, { start: 10, length: 3 }])).toEqual([
      { text: 'let ', hit: false, start: 0 },
      { text: 'foo', hit: true, start: 4 },
      { text: ' = ', hit: false, start: 7 },
      { text: 'foo', hit: true, start: 10 },
    ])
  })

  it('clamps out-of-range and overlapping hits without repeating text', () => {
    expect(highlightSegments('abc', [{ start: 99, length: 5 }])).toEqual([{ text: 'abc', hit: false, start: 0 }])
    expect(highlightSegments('abcd', [{ start: 0, length: 3 }, { start: 1, length: 3 }])).toEqual([
      { text: 'abc', hit: true, start: 0 },
      { text: 'd', hit: true, start: 3 },
    ])
    expect(highlightSegments('', [])).toEqual([])
  })
})

describe('search match stepping', () => {
  it('wraps around and enters from either end', () => {
    expect(stepIndex(-1, 0, 1)).toBe(-1)
    expect(stepIndex(-1, 3, 1)).toBe(0)
    expect(stepIndex(-1, 3, -1)).toBe(2)
    expect(stepIndex(0, 3, -1)).toBe(2)
    expect(stepIndex(2, 3, 1)).toBe(0)
    expect(stepIndex(0, 3, 1)).toBe(1)
  })
})

describe('search input validation', () => {
  it('validates regular expressions only when the regex flag is on', () => {
    expect(regexProblem('a.*b', { regex: true, wholeWord: false })).toBeUndefined()
    expect(regexProblem('(', { regex: true, wholeWord: false })).toBeTypeOf('string')
    expect(regexProblem('(', { regex: false, wholeWord: false })).toBeUndefined()
    // wholeWord 会包一层 \b(?:...)：包裹后仍然非法的表达式要照样报错。
    expect(regexProblem('a)', { regex: true, wholeWord: true })).toBeTypeOf('string')
    expect(regexProblem('a', { regex: true, wholeWord: true })).toBeUndefined()
  })
})

describe('search panel persistence', () => {
  it('restores the previous query, options and replacement', () => {
    expect(parseSearchState(JSON.stringify({ query: 'foo', include: 'src/**', exclude: '**/*.test.ts', replace: 'bar', caseSensitive: true, regex: true })))
      .toEqual({ ...DEFAULT_SEARCH, query: 'foo', include: 'src/**', exclude: '**/*.test.ts', replace: 'bar', caseSensitive: true, regex: true })
  })

  it('falls back per field instead of discarding everything', () => {
    const state = parseSearchState('{"query":"foo","caseSensitive":"yes","wholeWord":1,"replace":null}')
    expect(state).toEqual({ ...DEFAULT_SEARCH, query: 'foo' })
  })

  it('treats missing or broken storage as the default state', () => {
    expect(parseSearchState(null)).toEqual(DEFAULT_SEARCH)
    expect(parseSearchState('')).toEqual(DEFAULT_SEARCH)
    expect(parseSearchState('not json')).toEqual(DEFAULT_SEARCH)
    expect(parseSearchState('42')).toEqual(DEFAULT_SEARCH)
    // 每次返回新对象：调用方 patch 后不会改到共享的默认值。
    const state = parseSearchState(null)
    state.query = 'mutated'
    expect(DEFAULT_SEARCH.query).toBe('')
  })
})
