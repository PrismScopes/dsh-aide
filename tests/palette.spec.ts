import { describe, expect, it } from 'vitest'
import { commandPaletteEntries, filePaletteEntries, fuzzyMatch, mergeRanges, paletteFileDetail, paletteFileLabel, rankPaletteEntries, splitPaletteInput } from '../src/client/palette.ts'

describe('palette input', () => {
  it('treats a leading > as command mode and keeps the rest as query', () => {
    expect(splitPaletteInput('')).toEqual({ mode: 'file', query: '' })
    expect(splitPaletteInput('work')).toEqual({ mode: 'file', query: 'work' })
    expect(splitPaletteInput('>')).toEqual({ mode: 'command', query: '' })
    expect(splitPaletteInput('> save')).toEqual({ mode: 'command', query: 'save' })
    // 前导空格不是命令前缀：用户可能想搜以空格开头的路径。
    expect(splitPaletteInput(' >save')).toEqual({ mode: 'file', query: ' >save' })
  })

  it('splits a path into label and directory', () => {
    expect(paletteFileLabel('src/client/Workbench.tsx')).toBe('Workbench.tsx')
    expect(paletteFileDetail('src/client/Workbench.tsx')).toBe('src/client')
    expect(paletteFileDetail('README.md')).toBe('')
  })
})

describe('fuzzy matching', () => {
  it('prefers a direct substring and reports its range', () => {
    const hit = fuzzyMatch('work', 'Workbench.tsx')
    expect(hit).toBeDefined()
    expect(hit?.ranges).toEqual([{ start: 0, end: 4 }])
  })

  it('falls back to an ordered subsequence', () => {
    const hit = fuzzyMatch('wbn', 'Workbench.tsx')
    expect(hit).toBeDefined()
    expect(hit?.ranges).toEqual([{ start: 0, end: 1 }, { start: 4, end: 5 }, { start: 6, end: 7 }])
  })

  it('returns undefined when a character is missing or out of order', () => {
    expect(fuzzyMatch('zzz', 'Workbench.tsx')).toBeUndefined()
    expect(fuzzyMatch('hcn', 'Workbench.tsx')).toBeUndefined()
    expect(fuzzyMatch('toolong', 'abc')).toBeUndefined()
  })

  it('merges adjacent hit ranges so the UI paints one block', () => {
    expect(mergeRanges([{ start: 0, end: 2 }, { start: 2, end: 4 }, { start: 8, end: 9 }]))
      .toEqual([{ start: 0, end: 4 }, { start: 8, end: 9 }])
  })
})

describe('rankPaletteEntries', () => {
  const entries = filePaletteEntries(['src/utils.ts', 'src/client/utils/index.tsx', 'docs/utils.md', 'zzz.ts'])

  it('keeps the original order for an empty query and honours weights', () => {
    const weighted = [{ id: 'a', label: 'a.ts', kind: 'file' as const }, { id: 'b', label: 'b.ts', kind: 'file' as const, weight: 3 }]
    expect(rankPaletteEntries(weighted, '').map(row => row.entry.id)).toEqual(['b', 'a'])
  })

  it('ranks filename hits above directory-only hits', () => {
    const ranked = rankPaletteEntries(entries, 'utils')
    const ids = ranked.map(row => row.entry.id)
    expect(ids[0]).toBe('file:src/utils.ts')
    expect(ids.indexOf('file:docs/utils.md')).toBeLessThan(ids.indexOf('file:src/client/utils/index.tsx'))
    expect(ids).not.toContain('file:zzz.ts')
  })

  it('still finds a file through its directory', () => {
    const ranked = rankPaletteEntries(entries, 'docs')
    expect(ranked.map(row => row.entry.id)).toEqual(['file:docs/utils.md'])
  })

  it('truncates to the requested limit and caps invalid limits at zero', () => {
    expect(rankPaletteEntries(entries, '', 2)).toHaveLength(2)
    expect(rankPaletteEntries(entries, '', 0)).toHaveLength(0)
    expect(rankPaletteEntries(entries, '', -4)).toHaveLength(0)
  })
})

describe('palette entries', () => {
  it('marks recent files with descending weight', () => {
    const rows = filePaletteEntries(['a.ts', 'b.ts'], ['b.ts', 'a.ts'])
    expect(rows.find(row => row.id === 'file:b.ts')?.weight).toBe(2)
    expect(rows.find(row => row.id === 'file:a.ts')?.weight).toBe(1)
  })

  it('carries command groups and formatted keys through', () => {
    const rows = commandPaletteEntries([
      { id: 'view.explorer', label: '资源管理器', group: '视图', keys: ['Ctrl', 'Shift', 'E'] },
      { id: 'editor.save', label: '保存当前文件', group: '文件' },
    ])
    expect(rows[0]).toMatchObject({ id: 'view.explorer', kind: 'command', group: '视图', keys: ['Ctrl', 'Shift', 'E'] })
    expect(rows[1]?.keys).toBeUndefined()
    // 分组已由标题行表达，右侧不再重复分组名。
    expect(rows[0]?.detail).toBeUndefined()
  })
})
