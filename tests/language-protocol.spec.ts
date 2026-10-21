import { describe, expect, it } from 'vitest'
import {
  comparePositions,
  diagnosticCounts,
  displayPosition,
  isTypeScriptLanguage,
  languageIdForPath,
  positionInRange,
  rangeOverlaps,
  severityRank,
} from '../src/language/protocol.ts'

/**
 * 公共协议里的纯函数：两端（宿主/客户端）都依赖它们，
 * 一旦排序或语言映射变了，问题面板的顺序与路由会一起错，所以单独钉住。
 */
describe('语言服务公共协议', () => {
  it('maps extensions and fixed file names to Monaco language ids', () => {
    expect(languageIdForPath('a.ts')).toBe('typescript')
    expect(languageIdForPath('src/A.TSX')).toBe('typescript')
    expect(languageIdForPath('a.mjs')).toBe('javascript')
    expect(languageIdForPath('a.py')).toBe('python')
    expect(languageIdForPath('a.rs')).toBe('rust')
    expect(languageIdForPath('a.cc')).toBe('cpp')
    expect(languageIdForPath('a.yaml')).toBe('yaml')
    expect(languageIdForPath('Dockerfile')).toBe('dockerfile')
    expect(languageIdForPath('Makefile')).toBe('makefile')
    expect(languageIdForPath('README')).toBeUndefined()
    expect(languageIdForPath('a.unknown')).toBeUndefined()
  })

  it('only TypeScript service languages count as builtin', () => {
    for (const language of ['typescript', 'javascript', 'typescriptreact', 'javascriptreact']) expect(isTypeScriptLanguage(language)).toBe(true)
    expect(isTypeScriptLanguage('python')).toBe(false)
  })

  it('counts diagnostics by severity and ranks errors first', () => {
    const counts = diagnosticCounts([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 'error', message: 'a' },
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, severity: 'error', message: 'b' },
      { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } }, severity: 'warning', message: 'c' },
      { range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } }, severity: 'hint', message: 'd' },
    ])
    expect(counts).toEqual({ errors: 2, warnings: 1, infos: 0, hints: 1 })
    expect(['hint', 'warning', 'error', 'info'].sort((left, right) => severityRank(left as 'error') - severityRank(right as 'error')))
      .toEqual(['error', 'warning', 'info', 'hint'])
  })

  it('compares positions and tests range containment/overlap', () => {
    expect(comparePositions({ line: 1, character: 2 }, { line: 1, character: 3 })).toBeLessThan(0)
    expect(comparePositions({ line: 2, character: 0 }, { line: 1, character: 9 })).toBeGreaterThan(0)
    const range = { start: { line: 2, character: 1 }, end: { line: 2, character: 5 } }
    expect(positionInRange({ line: 2, character: 1 }, range)).toBe(true)
    expect(positionInRange({ line: 2, character: 5 }, range)).toBe(false)
    expect(rangeOverlaps(range, { start: { line: 2, character: 4 }, end: { line: 3, character: 0 } })).toBe(true)
    expect(rangeOverlaps(range, { start: { line: 1, character: 0 }, end: { line: 2, character: 1 } })).toBe(false)
  })

  it('renders one-based positions for display', () => {
    expect(displayPosition({ line: 0, character: 0 })).toBe('1:1')
    expect(displayPosition({ line: 9, character: 4 })).toBe('10:5')
  })
})
