import { describe, expect, it } from 'vitest'
import { buildInlineEditPrompt, readInlineEditInput, runInlineEdit, sanitizeInlineEditText, type InlineEditInput } from '../src/inlineEdit.ts'
import { replaceDocumentRange, snapshotOfEditor } from '../src/client/inlineEdit.ts'
import { selectionPreview } from '../src/client/InlineEditPrompt.tsx'

const input: InlineEditInput = {
  filePath: 'src/a.ts',
  language: 'typescript',
  instruction: '改成 async/await',
  selectionText: 'function f() { return 1 }',
  before: 'const x = 1',
  after: 'const y = 2',
}

describe('inline edit prompt', () => {
  it('carries file, language, context and instruction in a fixed order', () => {
    const prompt = buildInlineEditPrompt(input)
    const order = ['文件：src/a.ts', '语言：typescript', '【选中内容之前】', 'const x = 1', '【选中的代码】', 'function f() { return 1 }', '【选中内容之后】', 'const y = 2', '【用户要求】', '改成 async/await']
    let cursor = -1
    for (const piece of order) {
      const at = prompt.indexOf(piece)
      expect(at).toBeGreaterThan(cursor)
      cursor = at
    }
    expect(prompt).toContain('只输出改写后的代码本身')
  })

  it('marks empty context instead of leaving a blank section', () => {
    const prompt = buildInlineEditPrompt({ ...input, before: '', after: '' })
    expect(prompt).toContain('（文件开头）')
    expect(prompt).toContain('（文件结尾）')
  })
})

describe('sanitizeInlineEditText', () => {
  it('strips a fenced block and trims', () => {
    expect(sanitizeInlineEditText('```ts\nconst a = 1\n```')).toBe('const a = 1')
    expect(sanitizeInlineEditText('```\n\nconst a = 1\n\n```')).toBe('const a = 1')
  })

  it('strips an unterminated opening fence and normalizes CRLF', () => {
    expect(sanitizeInlineEditText('```python\r\nprint(1)\r\n```\r\n')).toBe('print(1)')
    expect(sanitizeInlineEditText('a\r\nb')).toBe('a\nb')
  })

  it('leaves plain code untouched', () => {
    expect(sanitizeInlineEditText('  const a = 1\n')).toBe('const a = 1')
  })
})

describe('readInlineEditInput', () => {
  it('rejects missing or non-string fields', () => {
    expect(() => readInlineEditInput({})).toThrow(/filePath/)
    expect(() => readInlineEditInput({ ...input, selectionText: 1 })).toThrow(/selectionText/)
  })

  it('accepts the complete shape', () => {
    expect(readInlineEditInput({ ...input })).toEqual(input)
  })
})

describe('runInlineEdit', () => {
  it('reports ai-unavailable when the host has no model service', async () => {
    const ctx = { get: () => undefined } as never
    await expect(runInlineEdit(ctx, 's', input)).rejects.toMatchObject({ code: 'ai-unavailable' })
  })

  it('rejects an empty selection before touching the model', async () => {
    const ctx = { get: () => undefined } as never
    await expect(runInlineEdit(ctx, 's', { ...input, selectionText: '   ' })).rejects.toMatchObject({ code: 'invalid-argument' })
  })
})

/** 极简的 Monaco 替身：只实现快照函数用到的读取方法。 */
function fakeEditor(document: string, selection?: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }, position = { lineNumber: 1, column: 1 }) {
  const lines = document.split('\n')
  const offset = (line: number, column: number) => lines.slice(0, line - 1).reduce((total, text) => total + text.length + 1, 0) + column - 1
  const model = {
    getValue: () => document,
    getLanguageId: () => 'typescript',
    getLineCount: () => lines.length,
    getLineMaxColumn: (line: number) => (lines[line - 1] ?? '').length + 1,
    getValueInRange: (range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }) =>
      document.slice(offset(range.startLineNumber, range.startColumn), offset(range.endLineNumber, range.endColumn)),
  }
  const instance = {
    getModel: () => model,
    getSelection: () => (selection === undefined ? null : { ...selection, isEmpty: () => false }),
    getPosition: () => position,
  }
  return instance as never
}

describe('snapshotOfEditor', () => {
  it('captures the selection, surrounding context and full document', () => {
    const document = ['const a = 1', 'function f() {', '  return 1', '}', 'const b = 2'].join('\n')
    const snapshot = snapshotOfEditor(fakeEditor(document, { startLineNumber: 2, startColumn: 1, endLineNumber: 4, endColumn: 2 }), '/ws/src/a.ts')
    expect(snapshot?.text).toBe('function f() {\n  return 1\n}')
    expect(snapshot?.before).toBe('const a = 1\n')
    expect(snapshot?.after).toBe('\nconst b = 2')
    expect(snapshot?.document).toBe(document)
    expect(snapshot?.range).toEqual({ startLine: 2, startColumn: 1, endLine: 4, endColumn: 2 })
  })

  it('falls back to the current line when nothing is selected', () => {
    const document = ['one', 'two', 'three'].join('\n')
    const snapshot = snapshotOfEditor(fakeEditor(document, undefined, { lineNumber: 2, column: 3 }), '/ws/a.ts')
    expect(snapshot?.text).toBe('two')
    expect(snapshot?.range).toEqual({ startLine: 2, startColumn: 1, endLine: 2, endColumn: 4 })
  })
})

describe('replaceDocumentRange', () => {
  const document = ['a', 'b', 'c', 'd'].join('\n')

  it('replaces a single line and a multi-line range', () => {
    expect(replaceDocumentRange(document, { startLine: 2, startColumn: 1, endLine: 2, endColumn: 2 }, 'B')).toBe('a\nB\nc\nd')
    expect(replaceDocumentRange(document, { startLine: 2, startColumn: 1, endLine: 3, endColumn: 2 }, 'X')).toBe('a\nX\nd')
  })

  it('clamps out-of-range lines and columns', () => {
    expect(replaceDocumentRange(document, { startLine: 99, startColumn: 1, endLine: 99, endColumn: 1 }, 'EOF')).toBe('a\nb\nc\ndEOF')
    expect(replaceDocumentRange(document, { startLine: 1, startColumn: 99, endLine: 1, endColumn: 99 }, '!')).toBe('a!\nb\nc\nd')
  })
})

describe('selectionPreview', () => {
  it('shows an empty-line marker and truncates long selections', () => {
    expect(selectionPreview('')).toBe('（空行）')
    expect(selectionPreview(Array.from({ length: 8 }, (_value, index) => `line ${index}`).join('\n'))).toContain('还有 3 行')
  })
})
