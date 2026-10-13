import { describe, expect, it, vi } from 'vitest'
import { applyEvent, CompletionClient, contextFingerprint, triggerPlan } from '../src/client/completion.ts'
import type * as monaco from 'monaco-editor'
import { ACCEPT_COMMAND_ID, buildInlineCompletionItems, InlineCompletionController, nextLineOf, nextWordOf } from '../src/client/inlineCompletion.ts'
import { encodeSseEvent, type CompletionEvent } from '../src/completion/protocol.ts'
import { DEFAULT_COMPLETION_PARAMS } from '../src/completion/params.ts'

/** 用给定的分块拼一个流式响应，分块边界故意切在 SSE 记录中间，检验跨块解析。 */
function streamResponse(chunks: string[], init: { status?: number; onCancel?: () => void } = {}): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
    cancel() { init.onCancel?.() },
  })
  return new Response(stream, { status: init.status ?? 200, headers: { 'content-type': 'text/event-stream' } })
}

const events = (...list: CompletionEvent[]): string[] => list.map(event => encodeSseEvent(event))

const input = (overrides: Partial<Parameters<CompletionClient['suggest']>[0]> = {}) => ({
  filePath: 'src/a.ts',
  language: 'typescript',
  document: 'const value = useSt',
  rewriteAt: { line: 1, column: 19 },
  ...overrides,
})

describe('completion trigger plan', () => {
  it('triggers immediately on a newline and debounces otherwise', () => {
    expect(triggerPlan({ isNewLine: true }, 'rust')).toEqual({ immediate: true, delayMs: 0 })
    expect(triggerPlan({ isNewLine: false }, 'typescript')).toEqual({ immediate: false, delayMs: DEFAULT_COMPLETION_PARAMS.debounceFastMs })
    expect(triggerPlan({ isNewLine: false }, 'rust')).toEqual({ immediate: false, delayMs: DEFAULT_COMPLETION_PARAMS.debounceSlowMs })
  })
})

describe('candidate slots', () => {
  it('appends to the addressed slot and fills gaps with empty strings', () => {
    let slots: string[] = []
    slots = applyEvent(slots, { type: 'output', candidates: [{ index: 0, text: 'a', finishReason: '', elapsedMs: 1 }] }).slots
    slots = applyEvent(slots, { type: 'output', candidates: [{ index: 2, text: 'c', finishReason: '', elapsedMs: 2 }] }).slots
    expect(slots).toEqual(['a', '', 'c'])
    slots = applyEvent(slots, { type: 'output', candidates: [{ index: 0, text: 'b', finishReason: '', elapsedMs: 3 }] }).slots
    expect(slots).toEqual(['ab', '', 'c'])
  })

  it('ignores events that carry no candidate text', () => {
    expect(applyEvent(['a'], { type: 'done' }).slots).toEqual(['a'])
  })
})

describe('context fingerprint', () => {
  it('is stable for the same context and changes with the text around the cursor', () => {
    const base = input()
    expect(contextFingerprint(base)).toBe(contextFingerprint({ ...base }))
    expect(contextFingerprint(base)).not.toBe(contextFingerprint({ ...base, document: 'const value = useSta' }))
    expect(contextFingerprint(base)).not.toBe(contextFingerprint({ ...base, rewriteAt: { line: 1, column: 15 } }))
  })
})

describe('inline completion items', () => {
  const emptyRangeAt = (position: { lineNumber: number; column: number }) => ({
    startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column,
  })

  it('anchors the insertion at the cursor instead of the current word', () => {
    // 省略 range 时 Monaco 的默认替换范围是「当前词起点到行尾」，会把插入当成替换，
    // 而类型声明要求被替换文本是插入文本的前缀 —— 不满足就静默丢弃，表现为「拿到了候选却不显示幻影文本」。
    expect(buildInlineCompletionItems(['ate'], { lineNumber: 2, column: 16 }, emptyRangeAt)).toEqual([
      { insertText: 'ate', filterText: 'ate', range: { startLineNumber: 2, startColumn: 16, endLineNumber: 2, endColumn: 16 } },
    ])
  })

  it('drops empty candidates and keeps the order', () => {
    const items = buildInlineCompletionItems(['first', '', 'second'], { lineNumber: 1, column: 1 }, emptyRangeAt)
    expect(items.map(item => item.insertText)).toEqual(['first', 'second'])
  })
})

describe('accept granularity', () => {
  it('takes a whole identifier as one word and a single character otherwise', () => {
    expect(nextWordOf('useState(0)')).toBe('useState')
    expect(nextWordOf('  call()')).toBe('  call')
    expect(nextWordOf('(0)')).toBe('(')
    expect(nextWordOf('42 + 1')).toBe('42')
    expect(nextWordOf('')).toBe('')
  })

  it('takes one line, keeping the newline so repeated accepts continue', () => {
    expect(nextLineOf('first()\nsecond()')).toBe('first()\n')
    expect(nextLineOf('only()')).toBe('only()')
    expect(nextLineOf('\nrest')).toBe('\n')
  })

  it('writes one word per accept and records the accepted range', () => {
    // acceptPartial 需要一个编辑器：这里用最小的假编辑器，把「切几分之几」「写了什么」「记了什么」钉住。
    const edits: Array<{ range: unknown; text: string }> = []
    const recorded: Array<{ filePath: string; start: number; end: number; text: string; inline: boolean }> = []
    const model = { getOffsetAt: (position: { lineNumber: number; column: number }) => position.column - 1 }
    const editor = {
      executeEdits: (_source: string, list: Array<{ range: unknown; text: string }>) => { for (const edit of list) edits.push(edit) },
      // 建议从第 3 列（偏移 2）起：假编辑器的光标位置必须带上这个基数。
      getPosition: () => ({ lineNumber: 1, column: 3 + edits.reduce((sum, edit) => sum + edit.text.length, 0) }),
      getModel: () => model,
    }
    const client = { recordAccept: (range: typeof recorded[number]) => recorded.push(range) }
    const controller = new InlineCompletionController({
      client: client as unknown as CompletionClient,
      kinds: { automatic: 0 as unknown as monaco.languages.InlineCompletionTriggerKind, explicit: 1 as unknown as monaco.languages.InlineCompletionTriggerKind },
      emptyRangeAt: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } as unknown as monaco.Range),
      editor: editor as unknown as monaco.editor.IStandaloneCodeEditor,
      controllerId: 'test-controller',
    })
    // 建议内容与位置由 provide 决定，这里直接注入：'useState(0)' 从第 3 列起。
    ;(controller as unknown as { current: unknown }).current = { text: 'useState(0)', position: { lineNumber: 1, column: 3 }, path: 'a.ts' }
    // 切词定义：标识符整体、数字整体、其余取单个非空白字符。
    expect(controller.acceptPartial('word')).toBe('useState')
    expect(controller.acceptPartial('word')).toBe('(')
    expect(controller.acceptPartial('word')).toBe('0')
    expect(controller.acceptPartial('word')).toBe(')')
    expect(controller.acceptPartial('word')).toBeUndefined()
    expect(edits.map(edit => edit.text)).toEqual(['useState', '(', '0', ')'])
    expect(recorded[0]).toEqual({ filePath: 'a.ts', start: 2, end: 10, text: 'useState', inline: true })
    // 每次采纳记录的是它自己插入的位置：光标随之前移，所以最后一段的偏移是 2 + 8 + 1 + 1。
    expect(recorded[1]).toEqual({ filePath: 'a.ts', start: 10, end: 11, text: '(', inline: true })
    expect(recorded[3]).toEqual({ filePath: 'a.ts', start: 12, end: 13, text: ')', inline: true })
  })

  it('attaches an accept command to every item', () => {
    const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }
    const items = buildInlineCompletionItems(['ate', 'ation'], { lineNumber: 1, column: 1 }, () => range, text => ({ id: ACCEPT_COMMAND_ID, title: 'record', arguments: [{ path: 'a.ts', offset: 3, text }] }))
    expect(items.map(item => item.command?.id)).toEqual([ACCEPT_COMMAND_ID, ACCEPT_COMMAND_ID])
    expect(items[0]?.command?.arguments[0]).toEqual({ path: 'a.ts', offset: 3, text: 'ate' })
  })
})

describe('completion client', () => {
  it('collects streamed candidates and reports the timing triple', async () => {
    let clock = 100
    const fetchImpl = vi.fn(async () => streamResponse([
      encodeSseEvent({ type: 'meta', model: 'm-1' }).slice(0, 12),
      encodeSseEvent({ type: 'meta', model: 'm-1' }).slice(12),
      ...events(
        { type: 'output', candidates: [{ index: 0, text: 'ate', finishReason: '', elapsedMs: 5 }] },
      ),
      ...events({ type: 'done' }),
    ]))
    const client = new CompletionClient({ endpoint: '/dsh-vscode/completion', sessionId: 's', fetchImpl, now: () => (clock += 5) })
    const updates: string[][] = []
    const result = await client.suggest(input({ onUpdate: candidates => updates.push([...candidates]) }))
    expect(result.candidates).toEqual(['ate'])
    expect(result.model).toBe('m-1')
    expect(result.finishReason).toBe('done')
    expect(result.timing.firstByteAt).toBeDefined()
    expect(result.timing.rttMs).toBeGreaterThanOrEqual(0)
    expect(result.timing.lastByteAt).toBeGreaterThanOrEqual(result.timing.firstByteAt ?? 0)
    expect(updates).toEqual([['ate']])
  })

  it('serves a repeated request from cache and stops after a recorded accept', async () => {
    const fetchImpl = vi.fn(async () => streamResponse(events({ type: 'output', candidates: [{ index: 0, text: 'ate', finishReason: '', elapsedMs: 1 }] }, { type: 'done' })))
    const client = new CompletionClient({ endpoint: '/c', sessionId: 's', fetchImpl })
    await client.suggest(input())
    await client.suggest(input())
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    client.recordAccept({ filePath: 'src/a.ts', start: 0, end: 3, text: 'ate', inline: true })
    await client.suggest(input())
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('forgets the cache entry once its lifetime has passed', async () => {
    let clock = 0
    const fetchImpl = vi.fn(async () => streamResponse(events({ type: 'done' })))
    const client = new CompletionClient({ endpoint: '/c', sessionId: 's', fetchImpl, cacheTtlMs: 10, now: () => clock })
    await client.suggest(input())
    clock = 50
    await client.suggest(input())
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('drops candidates that fail the filters and applies post-processing', async () => {
    const fetchImpl = vi.fn(async () => streamResponse(events(
      { type: 'output', candidates: [{ index: 0, text: 'ate', finishReason: '', elapsedMs: 1 }] },
      { type: 'output', candidates: [{ index: 1, text: 'x', finishReason: '', elapsedMs: 1 }] },
      { type: 'output', candidates: [{ index: 2, text: 'call(a', finishReason: '', elapsedMs: 1 }] },
      { type: 'done' },
    )))
    const client = new CompletionClient({ endpoint: '/c', sessionId: 's', fetchImpl })
    // 文档在光标之后是空的，所以候选 'ate' 通过；'x' 太短被丢；'call(a' 补上右括号。
    const result = await client.suggest(input({ document: 'const value = useSt' }))
    expect(result.candidates).toEqual(['ate', 'call(a)'])
  })

  it('drops a candidate identical to the text after the cursor', async () => {
    const fetchImpl = vi.fn(async () => streamResponse(events({ type: 'output', candidates: [{ index: 0, text: 'ate()', finishReason: '', elapsedMs: 1 }] }, { type: 'done' })))
    const client = new CompletionClient({ endpoint: '/c', sessionId: 's', fetchImpl })
    const result = await client.suggest(input({ document: 'const value = useState()' }))
    expect(result.candidates).toEqual([])
  })

  it('reports an error event as a thrown failure', async () => {
    const fetchImpl = vi.fn(async () => streamResponse(events({ type: 'error', code: 'completion-timeout', message: 'slow' })))
    const client = new CompletionClient({ endpoint: '/c', sessionId: 's', fetchImpl })
    await expect(client.suggest(input())).rejects.toThrow('completion-timeout: slow')
  })

  it('flags a content security hit', async () => {
    const fetchImpl = vi.fn(async () => streamResponse(events(
      { type: 'content_security', action: 'mask', ruleId: 'r', ruleName: 'SECRET' },
      { type: 'output', candidates: [{ index: 0, text: 'safe value', finishReason: '', elapsedMs: 1 }] },
      { type: 'done' },
    )))
    const client = new CompletionClient({ endpoint: '/c', sessionId: 's', fetchImpl })
    const result = await client.suggest(input())
    expect(result.masked).toBe(true)
    expect(result.candidates).toEqual(['safe value'])
  })

  it('calls the global fetch so the browser does not raise Illegal invocation', async () => {
    // 浏览器要求 fetch 的接收者是全局对象：把裸 fetch 存成字段再以 this.fetchImpl(...) 调用会抛
    // "Illegal invocation"，表现为请求一条都发不出去。这里用真实的调用语义把它钉住。
    const spy = vi.fn(function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
      return Promise.resolve(streamResponse(events({ type: 'output', candidates: [{ index: 0, text: 'ate', finishReason: '', elapsedMs: 1 }] }, { type: 'done' })))
    })
    vi.stubGlobal('fetch', spy)
    try {
      const client = new CompletionClient({ endpoint: '/c', sessionId: 's' })
      const result = await client.suggest(input())
      expect(result.candidates).toEqual(['ate'])
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('forwards the cancellation signal to the request and rejects a failed response', async () => {
    const controller = new AbortController()
    const seen: Array<AbortSignal | undefined> = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.signal ?? undefined)
      return streamResponse(events({ type: 'done' }))
    })
    const client = new CompletionClient({ endpoint: '/c', sessionId: 's', fetchImpl })
    await client.suggest(input({ signal: controller.signal }))
    expect(seen[0]).toBe(controller.signal)

    const failing = vi.fn(async () => new Response('nope', { status: 500 }))
    const failingClient = new CompletionClient({ endpoint: '/c', sessionId: 's', fetchImpl: failing })
    await expect(failingClient.suggest(input())).rejects.toThrow('completion request failed: 500')
  })
})
