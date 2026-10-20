import { describe, expect, it } from 'vitest'
import { CHARS_PER_TOKEN, charBudgetForPrompt, debounceFor, usesFastDebounce } from '../src/completion/params.ts'
import { encodeSseEvent, parseSse, type CompletionEvent } from '../src/completion/protocol.ts'
import {
  assembleContext,
  assemblePrompt,
  cropDocumentForRequest,
  CURSOR_MARKER,
  DEFAULT_PROMPT_PROFILE,
  FIM_MARKERS,
  INSTRUCTION_PROMPT_PROFILE,
  offsetAt,
  renderPrompt,
  suffixFromBlockBoundary,
  truncateDocument,
  truncatePrefix,
  truncateSuffix,
  type PromptProfile,
} from '../src/completion/prompt.ts'
import { DEFAULT_COMPLETION_PARAMS } from '../src/completion/params.ts'
import {
  closeBrackets,
  collapseRepeatedLines,
  DEFAULT_FILTER_OPTIONS,
  dropReason,
  filterCandidates,
  postProcess,
  trimDuplicateTrailingSymbol,
  trimPrefixOverlap,
  truncateAfterCompleteBlock,
  type FilterState,
} from '../src/completion/filter.ts'
import { identifiersStartingWith, localCompletion, trailingIdentifier, unclosedClosers } from '../src/completion/provider.ts'
import { buildQuery } from '../src/completion/retrieval.ts'
import { runCompletion } from '../src/completion/service.ts'

describe('prefix overlap', () => {
  it('trims what a chat model repeats from before the cursor', () => {
    // 输入 use、模型返回 useState：不去掉就会在同一行出现两份 use。
    expect(trimPrefixOverlap('useState', 'const a = use', 13)).toBe('State')
    expect(trimPrefixOverlap(' value', 'const a =', 9)).toBe(' value')
    expect(trimPrefixOverlap(' value', 'const a = ', 10)).toBe('value')
    // 整条都是重叠：结果为空，调用方按空候选丢弃。
    expect(trimPrefixOverlap('useState', 'useState', 8)).toBe('')
    // 只有开头重叠时，其余内容保留。
    expect(trimPrefixOverlap('items.length)\nreturn 0', 'const n = items', 16)).toBe('.length)\nreturn 0')
    // 超出比对窗口的部分不参与判断。
    expect(trimPrefixOverlap('State', 'x'.repeat(200) + 'use', 203)).toBe('State')
  })
})

import type { CompletionProvider } from '../src/completion/provider.ts'
import type { CompletionRequest } from '../src/completion/protocol.ts'

const PSM: PromptProfile = { id: 'psm', markers: FIM_MARKERS.psm, layout: 'prefix-suffix-middle', suffixFromBlockBoundary: false }

describe('completion params', () => {
  it('uses the fast debounce for dynamic and template languages only', () => {
    expect(usesFastDebounce('javascript')).toBe(true)
    expect(usesFastDebounce('TypeScript')).toBe(true)
    expect(usesFastDebounce('html')).toBe(true)
    expect(usesFastDebounce('rust')).toBe(false)
    expect(debounceFor('javascript')).toBe(90)
    expect(debounceFor('rust')).toBe(125)
  })

  it('converts the token budget into a character budget', () => {
    expect(charBudgetForPrompt(DEFAULT_COMPLETION_PARAMS)).toBe(3950 * CHARS_PER_TOKEN)
  })
})

describe('completion protocol', () => {
  it('round-trips an encoded event', () => {
    const event: CompletionEvent = { type: 'output', candidates: [{ index: 0, text: 'x', finishReason: '', elapsedMs: 3 }] }
    const parsed = parseSse(encodeSseEvent(event))
    expect(parsed.events).toEqual([event])
    expect(parsed.rest).toBe('')
  })

  it('keeps a partial record for the next chunk', () => {
    const first = parseSse('data: {"type":"me')
    expect(first.events).toEqual([])
    expect(first.rest).toBe('data: {"type":"me')
    const second = parseSse('ta","model":"m"}\n\n', first.rest)
    expect(second.events).toEqual([{ type: 'meta', model: 'm' }])
    expect(second.rest).toBe('')
  })

  it('parses several records in one chunk and ignores records that are not ours', () => {
    const chunk = encodeSseEvent({ type: 'meta', model: 'm' }) + ': keep-alive\n\n' + encodeSseEvent({ type: 'done' })
    expect(parseSse(chunk).events).toEqual([{ type: 'meta', model: 'm' }, { type: 'done' }])
  })
})

describe('prompt assembly', () => {
  it('maps a 1-based line and column onto a character offset', () => {
    const document = 'one\ntwo\nthree'
    // 列号从 1 起，与 Monaco 的位置约定一致：列 1 就是行首。
    expect(offsetAt(document, 1, 1)).toBe(0)
    expect(offsetAt(document, 2, 1)).toBe(4)
    expect(offsetAt(document, 2, 4)).toBe(7)
    // 中段光标：偏移必须刚好落在光标处，偏一位会让前后缀整体错位（实测时补全因此消失）。
    expect(document.slice(offsetAt(document, 2, 4))).toBe('\nthree')
    // 越界的行列要夹到文档范围内，不能返回越界偏移。
    expect(offsetAt(document, 99, 99)).toBe(document.length)
    // 列越界时夹到文档末尾：Monaco 不会发出越界的列，这里只是不复现崩溃。
    expect(offsetAt(document, 1, 99)).toBe(document.length)
  })

  it('caps the prefix by lines and by characters, keeping the text nearest the cursor', () => {
    const prefix = Array.from({ length: 10 }, (_value, index) => `line-${index}`).join('\n')
    expect(truncatePrefix(prefix, { ...DEFAULT_COMPLETION_PARAMS, prefixLines: 3 })).toBe('line-7\nline-8\nline-9')
    expect(truncatePrefix('abcdefghij', { ...DEFAULT_COMPLETION_PARAMS, prefixLines: 5, prefixChars: 4 })).toBe('ghij')
    expect(truncateSuffix('abcdefghij', { ...DEFAULT_COMPLETION_PARAMS, suffixLines: 5, suffixChars: 3 })).toBe('abc')
  })

  it('starts the suffix at the next sibling boundary when asked to', () => {
    // 同级边界包含那个收尾括号本身：模型需要看到当前块是怎么结束的。
    const suffix = '    still-inside()\n  }\n  nextFunction()\n}'
    expect(suffixFromBlockBoundary(suffix, 2)).toBe('  }\n  nextFunction()\n}')
    // 没有更浅的缩进时原样返回。
    expect(suffixFromBlockBoundary('    deeper()\n      deeper()', 2)).toBe('    deeper()\n      deeper()')
  })

  it('drops context parts in the documented order when the budget is tight', () => {
    const input = { filePath: 'a.ts', language: 'typescript', document: '', rewriteAt: { line: 1, column: 0 }, repositoryContext: 'REPO', snippets: ['SNIPPET'], symbols: ['SYMBOL'], edits: [{ before: 'a', after: 'b', timestamp: 1 }] }
    const all = assembleContext(input, 10_000)
    expect(all.dropped).toEqual([])
    expect(all.context).toContain('仓库级上下文')
    expect(all.context).toContain('改前：a')
    // 预算只够编辑历史时，按优先级从低到高依次丢掉前三类。
    const tight = assembleContext(input, 40)
    expect(tight.dropped).toEqual(['仓库级上下文', '检索片段', '符号定义'])
    expect(tight.context).toContain('改前：a')
    expect(tight.context).not.toContain('仓库级上下文')
    // 预算极端时连编辑历史也保不住，此时上下文段为空而不是塞进半条。
    expect(assembleContext(input, 5)).toEqual({ context: '', dropped: ['仓库级上下文', '检索片段', '符号定义', '编辑历史'] })
  })

  it('renders each layout with the markers that belong to it', () => {
    expect(renderPrompt('P', 'S', PSM)).toBe('<|fim_prefix|>P<|fim_suffix|>S<|fim_middle|>')
    expect(renderPrompt('P', 'S', { ...PSM, layout: 'begin-hole-end', markers: FIM_MARKERS.hole })).toBe('<fim_begin>P<fim_hole>S<fim_end>')
    const instruction = renderPrompt('P', 'S', INSTRUCTION_PROMPT_PROFILE)
    expect(instruction).toContain('代码补全引擎')
    expect(instruction).toContain('不要复述光标之前已经写过的代码')
    expect(instruction).toContain('不要重复光标之后已有的代码')
    expect(instruction).toContain(`P${CURSOR_MARKER}S`)
  })

  it('assembles a prompt that still points at the cursor after truncation', () => {
    const document = Array.from({ length: 1200 }, (_value, index) => `line ${index}`).join('\n')
    const result = assemblePrompt({ filePath: 'a.ts', language: 'typescript', document, rewriteAt: { line: 1100, column: 0 } }, { ...DEFAULT_COMPLETION_PARAMS, documentLines: 200, prefixLines: 50 }, PSM)
    expect(result.prompt).toContain('line 1099')
    expect(result.prompt).toContain('<|fim_prefix|>')
    expect(result.chars).toBe(result.prompt.length)
  })

  it('keeps the rewrite position valid after the document is truncated', () => {
    const document = Array.from({ length: 1000 }, (_value, index) => `line ${index}`).join('\n')
    const truncated = truncateDocument(document, { line: 900, column: 4 }, { ...DEFAULT_COMPLETION_PARAMS, documentLines: 100 })
    const lines = truncated.document.split('\n')
    expect(lines.length).toBe(100)
    // 换算后的行号必须仍然指向同一行文本。
    expect(lines[truncated.rewriteAt.line - 1]).toBe('line 899')
  })

  it('drops whole lines at the character cap while keeping the cursor line intact', () => {
    // 字符封顶（documentChars）按整行从头丢：丢多少行就必须把行号前移多少。
    const document = Array.from({ length: 700 }, (_value, index) => `line${index} ${'x'.repeat(200)}`).join('\n')
    const truncated = truncateDocument(document, { line: 680, column: 4 }, { ...DEFAULT_COMPLETION_PARAMS, documentLines: 700, documentChars: 30_000 })
    expect(truncated.document.length).toBeLessThanOrEqual(30_000)
    expect(truncated.document.split('\n')[truncated.rewriteAt.line - 1]).toBe(`line679 ${'x'.repeat(200)}`)
    expect(truncated.rewriteAt.column).toBe(4)
    expect(truncated.rewriteAt.line).toBeLessThan(680)
  })
})

describe('request document cropping', () => {
  const params = DEFAULT_COMPLETION_PARAMS
  // 约 1MB 的普通代码文档：每行长度固定，便于把窗口预算写成可断言的公式。
  const line = 'const value_{i} = computeSomething(alpha, beta, gamma) // 普通代码行'
  const lines: string[] = []
  let size = 0
  for (let index = 0; size < 1024 * 1024; index++) {
    const text = line.replace('{i}', String(index))
    lines.push(text)
    size += text.length + 1
  }
  const bigDocument = lines.join('\n')
  const cursor = { line: Math.floor(lines.length / 2) + 1, column: 20 }

  /** 宿主实际走的链路：先 truncateDocument，再 assemblePrompt。 */
  const promptThroughHost = (document: string, rewriteAt: { line: number; column: number }, profile: PromptProfile) => {
    const truncated = truncateDocument(document, rewriteAt, params)
    return assemblePrompt({ filePath: 'src/a.ts', language: 'typescript', document: truncated.document, rewriteAt: truncated.rewriteAt }, params, profile)
  }

  it('produces byte-identical prefix, suffix and prompt to sending the full document', () => {
    const cropped = cropDocumentForRequest(bigDocument, cursor, params)
    for (const profile of [DEFAULT_PROMPT_PROFILE, INSTRUCTION_PROMPT_PROFILE]) {
      const full = promptThroughHost(bigDocument, cursor, profile)
      const after = promptThroughHost(cropped.document, cropped.rewriteAt, profile)
      expect(after.prefix).toBe(full.prefix)
      expect(after.suffix).toBe(full.suffix)
      expect(after.prompt).toBe(full.prompt)
    }
    // 请求体从 1MB 降到「前缀预算 + 后缀 200 段扫描余量」量级。
    const maxLineLength = Math.max(...lines.map(text => text.length))
    const suffixScanMargin = 200 * (maxLineLength + 1)
    expect(cropped.cropped).toBe(true)
    expect(cropped.document.length).toBeLessThanOrEqual(params.prefixChars + suffixScanMargin + maxLineLength)
    expect(cropped.document.length).toBeLessThan(bigDocument.length / 10)
  })

  it('keeps the cropped rewriteAt pointing at the same character position', () => {
    const cropped = cropDocumentForRequest(bigDocument, cursor, params)
    const fullOffset = offsetAt(bigDocument, cursor.line, cursor.column)
    const croppedOffset = offsetAt(cropped.document, cropped.rewriteAt.line, cropped.rewriteAt.column)
    // 光标两侧的字符必须与全量文档一致，否则宿主 prefix/suffix 会错位。
    expect(cropped.document.slice(croppedOffset - 40, croppedOffset)).toBe(bigDocument.slice(fullOffset - 40, fullOffset))
    expect(cropped.document.slice(croppedOffset, croppedOffset + 40)).toBe(bigDocument.slice(fullOffset, fullOffset + 40))
    expect(cropped.droppedLines).toBeGreaterThan(0)
    expect(cropped.rewriteAt.line).toBeLessThan(cursor.line)
  })

  it('leaves documents that already fit the window untouched', () => {
    const document = 'const a = 1\nconst b = 2'
    const cropped = cropDocumentForRequest(document, { line: 2, column: 8 }, params)
    expect(cropped.cropped).toBe(false)
    expect(cropped.document).toBe(document)
    expect(cropped.rewriteAt).toEqual({ line: 2, column: 8 })
  })

  it('handles an overlong single line by shifting the column instead of the line', () => {
    const document = 'x'.repeat(1024 * 1024)
    const rewriteAt = { line: 1, column: 500_000 }
    const cropped = cropDocumentForRequest(document, rewriteAt, params)
    expect(cropped.document.length).toBeLessThanOrEqual(params.prefixChars + params.suffixChars)
    expect(cropped.rewriteAt.line).toBe(1)
    const full = promptThroughHost(document, rewriteAt, DEFAULT_PROMPT_PROFILE)
    const after = promptThroughHost(cropped.document, cropped.rewriteAt, DEFAULT_PROMPT_PROFILE)
    expect(after.prefix).toBe(full.prefix)
    expect(after.suffix).toBe(full.suffix)
    expect(after.prompt).toBe(full.prompt)
  })

  it('stays equivalent when the character cap has already dropped lines', () => {
    // documentChars 封顶会丢掉前面若干行；裁剪窗口从宿主实际保留的段落里切，prompt 仍须一致。
    const document = Array.from({ length: 700 }, (_value, index) => `line${index} ${'x'.repeat(200)}`).join('\n')
    const rewriteAt = { line: 680, column: 4 }
    const cropped = cropDocumentForRequest(document, rewriteAt, params)
    for (const profile of [DEFAULT_PROMPT_PROFILE, INSTRUCTION_PROMPT_PROFILE]) {
      const full = promptThroughHost(document, rewriteAt, profile)
      const after = promptThroughHost(cropped.document, cropped.rewriteAt, profile)
      expect(after.prefix).toBe(full.prefix)
      expect(after.suffix).toBe(full.suffix)
      expect(after.prompt).toBe(full.prompt)
    }
  })

  it('keeps the retrieval query identical for a normal large document', () => {
    // 检索只看光标前 30 行 + 当前行前缀；窗口必须完整覆盖它，否则注入的片段会变。
    const cropped = cropDocumentForRequest(bigDocument, cursor, params)
    expect(buildQuery(cropped.document, cropped.rewriteAt.line, cropped.rewriteAt.column)).toBe(buildQuery(bigDocument, cursor.line, cursor.column))
  })
})

const baseState = (overrides: Partial<FilterState> = {}): FilterState => ({ filePath: 'a.ts', document: '', offset: 0, language: 'typescript', ...overrides })

describe('candidate filtering', () => {
  it('drops an empty change and a candidate identical to the document', () => {
    expect(dropReason('   ', baseState())).toBe('empty-change')
    expect(dropReason('abc', baseState({ document: 'abcdef', offset: 0 }))).toBe('identical-to-document')
  })

  it('drops the candidate that repeats the text before the cursor', () => {
    expect(dropReason('foo', baseState({ document: 'foo', offset: 3 }))).toBe('duplicate-text')
    expect(dropReason('foo', baseState({ document: 'foo bar', offset: 3 }))).toBe('duplicate-text')
    expect(dropReason('bar', baseState({ document: 'foo bar', offset: 3 }))).toBeUndefined()
    // 光标之后正好是同样的文本时，按更靠前的「与编辑器内容无差异」判定丢弃。
    expect(dropReason('foo', baseState({ document: 'foofoo', offset: 3 }))).toBe('identical-to-document')
  })

  it('drops import statements, too-short candidates and candidates with no language characters', () => {
    expect(dropReason('import { a } from "b"', baseState())).toBe('import-statement')
    expect(dropReason('x', baseState())).toBe('too-short')
    expect(dropReason('---', baseState())).toBe('no-language-chars')
    expect(dropReason('const a = 1', baseState())).toBeUndefined()
  })

  it('drops a candidate that falls inside the last accepted range', () => {
    const state = baseState({ document: '      ', offset: 3, lastAccepted: { filePath: 'a.ts', start: 0, end: 6, text: 'sixchr', inline: false } })
    expect(dropReason('sixchr', state)).toBe('same-line-as-last-accept')
    // 同一区间但长度不同不算命中。
    expect(dropReason('other', state)).toBeUndefined()
  })

  it('drops a candidate overlapping the last inline accept even when the length differs', () => {
    const state = baseState({ document: '      ', offset: 2, lastAccepted: { filePath: 'a.ts', start: 0, end: 6, text: 'sixchr', inline: true } })
    expect(dropReason('anything', state)).toBe('overlaps-last-inline-accept')
  })

  it('treats the accepted range as half-open so the position after an accept stays usable', () => {
    // 采纳后光标正好停在区间末端，那里应当是「新的补全起点」，否则采纳一次之后再也不会提示。
    const state = baseState({ document: '      ', offset: 6, lastAccepted: { filePath: 'a.ts', start: 0, end: 6, text: 'sixchr', inline: true } })
    expect(dropReason('anything', state)).toBeUndefined()
    expect(dropReason('sixchr', state)).toBeUndefined()
  })

  it('drops the rollback edit', () => {
    expect(dropReason('before', baseState({ document: 'xxxxxzzz', offset: 5, lastEdit: { before: 'before', after: 'after' } }))).toBe('rollback-edit')
  })

  it('reports a reason per candidate while keeping the survivors', () => {
    const filtered = filterCandidates(['const a = 1', 'x'], baseState())
    expect(filtered[0]).toEqual({ text: 'const a = 1' })
    expect(filtered[1]).toEqual({ text: 'x', dropped: 'too-short' })
  })

  it('honours the switchable filters', () => {
    const off = { ...DEFAULT_FILTER_OPTIONS, dropTooShort: false, dropImports: false, dropForeignLanguage: false }
    expect(dropReason('x', baseState(), off)).toBeUndefined()
    expect(dropReason('import a from "b"', baseState(), off)).toBeUndefined()
    expect(dropReason('---', baseState(), off)).toBeUndefined()
  })
})

describe('candidate post-processing', () => {
  it('removes a trailing symbol that the document already has', () => {
    expect(trimDuplicateTrailingSymbol('foo)', 'foo', 3)).toBe('foo)')
    expect(trimDuplicateTrailingSymbol('foo)', ')bar', 0)).toBe('foo')
  })

  it('closes brackets and quotes that the candidate leaves open', () => {
    expect(closeBrackets('call(a')).toBe('call(a)')
    expect(closeBrackets('{ a: 1')).toBe('{ a: 1}')
    expect(closeBrackets('done()')).toBe('done()')
  })

  it('collapses runs of the same line and cuts after the first complete block', () => {
    // 文档措辞是「三次以上压成一次」，所以四行 a 压成一行；连续两行不动（重复两行是合法代码）。
    expect(collapseRepeatedLines('a\na\na\na\nb')).toBe('a\nb')
    expect(collapseRepeatedLines('await tick()\nawait tick()\nnext()')).toBe('await tick()\nawait tick()\nnext()')
    expect(truncateAfterCompleteBlock('if (a) { b() } trailing')).toBe('if (a) { b() }')
    expect(truncateAfterCompleteBlock('no block here')).toBe('no block here')
  })

  it('keeps the output usable on Windows and after a doubled answer', () => {
    const document = 'const a = useState(0)\nconst b = useSt'
    const at = () => baseState({ document, offset: document.length })

    // CRLF：模型常带 \r，插进文档会留下看不见的字符。
    expect(postProcess('ate(0)\r\nfoo()', at())).toBe('ate(0)\nfoo()')

    // 整段重复两遍：逐行规则看不出来（每行只出现两次），整段比对才认得出。
    expect(postProcess('ate(0)\nfoo()\nate(0)\nfoo()', at())).toBe('ate(0)\nfoo()')

    // 开头的空行是模型的分隔，不是要插入的内容。
    expect(postProcess('\nate(0)', at())).toBe('ate(0)')
  })

  it('keeps presentation junk out of the inserted text', () => {
    const document = 'const a = useState(0)\nconst b = useSt'
    const at = () => baseState({ document, offset: document.length })
    const pipeline = (raw: string) => {
      const state = { document, offset: document.length, edits: [], diagnostics: [] as string[], lastAccepted: undefined }
      const [candidate] = filterCandidates([raw], state as unknown as Parameters<typeof filterCandidates>[1])
      if (candidate === undefined || candidate.dropped !== undefined) return '<丢弃：' + (candidate?.dropped ?? 'none') + '>'
      return postProcess(candidate.text, at())
    }

    // 行内反引号包裹的片段：反引号是 Markdown 记号，不是代码。
    expect(pipeline('`ate`')).toBe('ate')
    // 加粗：同理。
    expect(pipeline('**ate**')).toBe('ate')
    // 复述文件路径：那是给模型的上下文，不该插回去。
    expect(pipeline('# 文件：a.ts\nate')).toBe('ate')
    // 纯解释不会被丢：规则只看「有没有语言字符」，而中文也是语言字符 —— 中文完全可能出现在合法补全里
    // （字符串字面量、注释），按「含中文就丢」处理会误伤。模型说「补不出」的正当出口是输出空行，
    // 空候选由 empty-change 规则丢掉；指令里已经这么要求。
    expect(pipeline('无法补全。')).toBe('无法补全。')
    expect(pipeline('')).toBe('<丢弃：empty-change>')
  })

  it('runs the whole post-processing chain', () => {
    // 文档光标处已经有右括号：不该再补一个，否则插入后变成 call(a))。
    expect(postProcess('call(a', baseState({ document: ')', offset: 0 }))).toBe('call(a')
    // 文档没有那个右括号时才补。
    expect(postProcess('call(a', baseState({ document: '', offset: 0 }))).toBe('call(a)')
  })

  it('handles the shapes a chat model actually returns', () => {
    const before = 'const a = useState(0)\nconst b = useSt'
    const at = (document: string) => baseState({ document, offset: document.length })

    // 围栏 + 说明文字：只保留代码。
    expect(postProcess('```typescript\nate\n```', at(before))).toBe('ate')
    expect(postProcess('这是补全：\n```\nate\n```\n希望有帮助', at(before))).toBe('ate')

    // 复述光标前的代码：整段重叠都去掉，只剩真正的增量。
    expect(postProcess('const b = useState', at(before))).toBe('ate')

    // 截断只认花括号块：圆括号不算，否则形如 items.map(item => (…)) 的合法多行补全会被从中间截断。
    // 代价是模型若在补全之后又附一整个无关函数，那部分会保留下来（已记入交付说明的局限）。
    expect(postProcess('ate(0)\n\nfunction other() {\n  return 1\n}', at(before))).toBe('ate(0)\n\nfunction other() {\n  return 1\n}')
    expect(truncateAfterCompleteBlock('ate(0)\n\nfunction other() {\n  return 1\n}\n\nfunction more() {\n  return 2\n}')).toBe('ate(0)\n\nfunction other() {\n  return 1\n}')

    // 同一行重复三次：压成一次。
    expect(postProcess('ate(0)\nate(0)\nate(0)', at(before))).toBe('ate(0)')

    // 文档里已经有那个右括号：不重复给。
    expect(trimDuplicateTrailingSymbol('ate(0)', 'const n = useState(0)', 21)).toBe('ate(0)')
    // 插入点在文档里那个右括号之前：候选末尾再来一个就重复了。
    expect(trimDuplicateTrailingSymbol('ate)', 'n)', 1)).toBe('ate')

    // 括号没闭合：补上。
    expect(closeBrackets('useState(')).toBe('useState()')

    // 补上的那个符号，文档里紧接着已经有了：不能再补一个。
    // 这条用来钉住管线顺序 —— 去重复尾符号必须排在闭合括号之后，否则补上去的括号会重复。
    const call = 'const x = f(a'
    expect(postProcess('f(a, b(', baseState({ document: call + ')', offset: call.length }))).toBe(', b(')
  })
})

describe('local fallback provider', () => {
  it('finds the identifier fragment under the cursor', () => {
    expect(trailingIdentifier('const value = useSt')).toBe('useSt')
    expect(trailingIdentifier('const value = ')).toBe('')
  })

  it('suggests identifiers that start with the fragment', () => {
    const document = 'useState(0)\nuseSyncExternalStore(subscribe, read)\nother()'
    // 排序依据是离光标的距离：光标在文档开头时 useState 更近。
    expect(identifiersStartingWith(document, 'useS', 0, 2)).toEqual(['useState', 'useSyncExternalStore'])
    expect(identifiersStartingWith(document, 'useS', document.length, 2)).toEqual(['useSyncExternalStore', 'useState'])
  })

  it('completes the current word first and closes brackets second', () => {
    expect(localCompletion('const a = useSt', 'ate(0)', DEFAULT_COMPLETION_PARAMS)).toEqual(['ate'])
    expect(localCompletion('call(', ')', DEFAULT_COMPLETION_PARAMS)).toEqual([')'])
    expect(localCompletion('', '', DEFAULT_COMPLETION_PARAMS)).toEqual([])
  })

  it('tracks unclosed brackets and quotes', () => {
    expect(unclosedClosers('call(')).toEqual([')'])
    expect(unclosedClosers('call(a')).toEqual([')'])
    expect(unclosedClosers('const s = "abc')).toEqual(['"'])
    expect(unclosedClosers('call(a)')).toEqual([])
  })
})

const request = (overrides: Partial<CompletionRequest> = {}): CompletionRequest => ({
  sessionId: 'session-1',
  environment: { ideVersion: '1', extensionVersion: '1', region: 'cn', channel: 'dev', repository: 'repo' },
  language: 'typescript',
  trigger: 'inline',
  edits: [],
  cursor: { filePath: 'src/a.ts', rewriteAt: { line: 1, column: 6 }, document: 'const ' },
  diagnostics: [],
  forceRewrite: false,
  ...overrides,
})

const scriptedProvider = (chunks: string[], onCall?: () => void): CompletionProvider => ({
  id: 'scripted',
  model: 'scripted-1',
  async *complete(): AsyncIterable<{ text: string; done: boolean; index?: number }> {
    onCall?.()
    // 这个 fixture 模拟「一次产出多条完整候选」的提供方，因此每条各自一个序号。
    let index = 0
    for (const text of chunks) yield { text, done: false, index: index++ }
    yield { text: '', done: true }
  },
})

describe('completion service', () => {
  it('emits meta, one output per chunk and a terminal done in order', async () => {
    const events: CompletionEvent[] = []
    for await (const event of runCompletion(request(), { provider: scriptedProvider(['a', 'b', 'c']) })) events.push(event)
    expect(events[0]).toEqual({ type: 'meta', model: 'scripted-1', snippets: 0 })
    expect(events.slice(1, 4).map(event => (event.type === 'output' ? event.candidates[0]?.text : undefined))).toEqual(['a', 'b', 'c'])
    expect(events.at(-1)).toEqual({ type: 'done' })
  })

  it('treats unnumbered chunks as pieces of one candidate, not as several', async () => {
    // 逐字流式的模型不报序号：那是同一条候选的三个增量，客户端按序号追加成 ate。
    const streaming: CompletionProvider = {
      id: 'stream',
      model: 'stream-1',
      async *complete(): AsyncIterable<{ text: string; done: boolean }> {
        for (const text of ['a', 'te', '']) yield { text, done: text === '' }
      },
    }
    const events: CompletionEvent[] = []
    for await (const event of runCompletion(request(), { provider: streaming })) events.push(event)
    const outputs = events.filter(event => event.type === 'output')
    expect(outputs.map(event => event.candidates[0]?.index)).toEqual([0, 0])
    expect(outputs.map(event => event.candidates[0]?.text).join('')).toBe('ate')
  })

  it('stops after the candidate limit', async () => {
    const events: CompletionEvent[] = []
    for await (const event of runCompletion(request(), { provider: scriptedProvider(['1', '2', '3', '4', '5']) })) events.push(event)
    expect(events.filter(event => event.type === 'output')).toHaveLength(DEFAULT_COMPLETION_PARAMS.candidateLimit)
  })

  it('reports an upstream failure as an error event instead of throwing', async () => {
    const failing: CompletionProvider = {
      id: 'failing',
      model: 'failing-1',
      async *complete(): AsyncIterable<{ text: string; done: boolean }> { throw new Error('upstream down') },
    }
    const events: CompletionEvent[] = []
    for await (const event of runCompletion(request(), { provider: failing })) events.push(event)
    expect(events.at(-1)).toEqual({ type: 'error', code: 'completion-failed', message: 'upstream down' })
  })

  it('stops on a blocking security rule and masks without stopping otherwise', async () => {
    const blocked = request({ security: { rules: [{ id: 'r1', name: 'SECRET', action: 'block' }] } })
    const events: CompletionEvent[] = []
    for await (const event of runCompletion(blocked, { provider: scriptedProvider(['ok ', 'SECRET', 'after']) })) events.push(event)
    expect(events.some(event => event.type === 'content_security' && event.action === 'block')).toBe(true)
    expect(events.some(event => event.type === 'output' && event.candidates[0]?.text === 'after')).toBe(false)

    const masked = request({ security: { rules: [{ id: 'r2', name: 'SECRET', action: 'mask' }] } })
    const maskedEvents: CompletionEvent[] = []
    for await (const event of runCompletion(masked, { provider: scriptedProvider(['SECRET', 'after']) })) maskedEvents.push(event)
    expect(maskedEvents.some(event => event.type === 'content_security' && event.action === 'mask')).toBe(true)
    expect(maskedEvents.some(event => event.type === 'output' && event.candidates[0]?.text === 'after')).toBe(true)
  })

  it('aborts the upstream when the caller cancels', async () => {
    const controller = new AbortController()
    let aborted = false
    const hanging: CompletionProvider = {
      id: 'hanging',
      model: 'hanging-1',
      async *complete(_prompt, context): AsyncIterable<{ text: string; done: boolean }> {
        // 提供方可能在取消之后才被启动：此时 abort 事件已经过去，必须读状态而不是等事件。
        if (context.signal.aborted) { aborted = true; return }
        context.signal.addEventListener('abort', () => { aborted = true }, { once: true })
        await new Promise(resolve => setTimeout(resolve, 50))
        yield { text: 'late', done: false }
      },
    }
    const iterator = runCompletion(request(), { provider: hanging, signal: controller.signal })
    const first = await iterator.next()
    expect(first.value).toEqual({ type: 'meta', model: 'hanging-1', snippets: 0 })
    controller.abort()
    const after: CompletionEvent[] = []
    for await (const event of iterator) after.push(event)
    expect(aborted).toBe(true)
    // 取消之后上游晚到的增量必须被丢掉：既不产出 output，也不补一个 done。
    expect(after.filter(event => event.type === 'output')).toEqual([])
    expect(after.some(event => event.type === 'done')).toBe(false)
  })

  it('reports the request timeout as an error event instead of ending silently', async () => {
    const silent: CompletionProvider = {
      id: 'silent',
      model: 'silent-1',
      async *complete(_prompt, context): AsyncIterable<{ text: string; done: boolean }> {
        // 一直不产出，直到被中止。
        await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }))
      },
    }
    const events: CompletionEvent[] = []
    for await (const event of runCompletion(request(), { provider: silent, params: { ...DEFAULT_COMPLETION_PARAMS, completionTimeoutMs: 20 } })) events.push(event)
    expect(events.at(-1)).toEqual({ type: 'error', code: 'completion-timeout', message: 'no completion within 20 ms' })
  })

  it('catches a secret split across two chunks, which per-chunk matching would miss', async () => {
    // 同一个候选被切成两半：单独看哪一半都不含完整模式。
    const split: CompletionProvider = { id: 'split', model: 'split', async *complete() {
      yield { text: 'key = -----BEGIN RSA ', done: false }
      yield { text: 'PRIVATE KEY-----\nAAAA', done: false }
      yield { text: '', done: true }
    } }
    const events: CompletionEvent[] = []
    const secrets: Array<{ id: string; action: string }> = []
    for await (const event of runCompletion(request(), { provider: split, onSecurityHit: hit => { secrets.push({ id: hit.ruleId, action: hit.action }) } })) events.push(event)
    expect(events.some(event => event.type === 'content_security' && event.ruleId === 'private-key-block' && event.action === 'block')).toBe(true)
    // 拦截之后不再产出后续内容，且命中要交给审计回调。
    expect(secrets).toEqual([{ id: 'private-key-block', action: 'block' }])
    expect(events.at(-1)?.type).toBe('content_security')
  })

  it('marks a masked hit and keeps the completion going', async () => {
    const credential: CompletionProvider = { id: 'cred', model: 'cred', async *complete() {
      yield { text: 'const apiKey = \'abcdef123456\'', done: false }
      yield { text: '\nmore()', done: false }
      yield { text: '', done: true }
    } }
    const events: CompletionEvent[] = []
    for await (const event of runCompletion(request(), { provider: credential })) events.push(event)
    expect(events.some(event => event.type === 'content_security' && event.action === 'mask' && event.ruleId === 'generic-credential')).toBe(true)
    expect(events.some(event => event.type === 'output' && event.candidates[0]?.text.includes('more()'))).toBe(true)
  })

  it('uses the tenant rules as given, and an empty set turns the gate off', async () => {
    const tenant = { rules: [{ id: 't', name: '内部主机', action: 'mask' as const, pattern: '\\.internal\\.' }] }
    const provider: CompletionProvider = { id: 'host', model: 'host', async *complete() {
      yield { text: 'fetch("http://api.internal.svc")', done: false }
      yield { text: '', done: true }
    } }
    const tenantEvents: CompletionEvent[] = []
    for await (const event of runCompletion(request({ security: tenant }), { provider })) tenantEvents.push(event)
    expect(tenantEvents.some(event => event.type === 'content_security' && event.ruleId === 't')).toBe(true)
    const offEvents: CompletionEvent[] = []
    for await (const event of runCompletion(request({ security: { rules: [] } }), { provider })) offEvents.push(event)
    expect(offEvents.some(event => event.type === 'content_security')).toBe(false)
  })
})
