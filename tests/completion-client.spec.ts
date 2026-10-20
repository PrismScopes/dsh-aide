import { describe, expect, it, vi } from 'vitest'
import { applyEvent, CompletionClient, contextFingerprint, triggerPlan } from '../src/client/completion.ts'
import type * as monaco from 'monaco-editor'
import { ACCEPT_COMMAND_ID, buildInlineCompletionItems, InlineCompletionController, nextLineOf } from '../src/client/inlineCompletion.ts'
import { encodeSseEvent, type CompletionEvent } from '../src/completion/protocol.ts'
import { DEFAULT_COMPLETION_PARAMS, debounceFor, type CompletionParams } from '../src/completion/params.ts'
import { DEFAULT_PREFERENCES, preferences } from '../src/client/preferences.ts'

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

describe('completion debounce parameters', () => {
  // paramsOf 是私有方法：这里按仓库既有的写法（直接读私有字段）钉住参数优先级。
  const paramsOf = (controller: InlineCompletionController): CompletionParams => (controller as unknown as { paramsOf(): CompletionParams }).paramsOf()
  const controllerWith = (params?: CompletionParams): InlineCompletionController => new InlineCompletionController({
    client: { recordAccept: () => undefined } as unknown as CompletionClient,
    kinds: { automatic: 0 as unknown as monaco.languages.InlineCompletionTriggerKind, explicit: 1 as unknown as monaco.languages.InlineCompletionTriggerKind },
    emptyRangeAt: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } as unknown as monaco.Range),
    editor: { getModel: () => null } as unknown as monaco.editor.IStandaloneCodeEditor,
    controllerId: 'debounce-test',
    ...(params === undefined ? {} : { params }),
  })
  /** 只替换偏好读取，不改任何生产全局状态；跑完恢复。 */
  const withDebouncePreference = <T>(debounceMs: number, run: () => T): T => {
    const get = vi.spyOn(preferences, 'get').mockReturnValue({ ...DEFAULT_PREFERENCES, completionDebounceMs: debounceMs })
    try { return run() } finally { get.mockRestore() }
  }

  it('keeps the server/experiment tiers while the user preference is untouched', () => {
    // 用户没改过触发延迟（偏好值等于默认值）时，不能拿它覆盖实验分组下发的快/慢档，
    // 否则 params.ts 的 usesFastDebounce/debounceFor 在生产里恒等于同一个值（审计 B-4）。
    withDebouncePreference(DEFAULT_PREFERENCES.completionDebounceMs, () => {
      const params = paramsOf(controllerWith({ ...DEFAULT_COMPLETION_PARAMS, debounceFastMs: 70, debounceSlowMs: 110 }))
      expect(params).toMatchObject({ debounceFastMs: 70, debounceSlowMs: 110 })
      expect(debounceFor('typescript', params)).toBe(70)
      expect(debounceFor('rust', params)).toBe(110)
      expect(triggerPlan({ isNewLine: false }, 'typescript', params)).toEqual({ immediate: false, delayMs: 70 })
      expect(triggerPlan({ isNewLine: false }, 'rust', params)).toEqual({ immediate: false, delayMs: 110 })
    })
  })

  it('lets an explicitly changed preference override both tiers', () => {
    // 用户真的改成 150 之后，两档统一成 150：设置页只有一个数字，行为不该因语言而异。
    withDebouncePreference(150, () => {
      const params = paramsOf(controllerWith({ ...DEFAULT_COMPLETION_PARAMS, debounceFastMs: 70, debounceSlowMs: 110 }))
      expect(params).toMatchObject({ debounceFastMs: 150, debounceSlowMs: 150 })
      expect(debounceFor('typescript', params)).toBe(150)
      expect(debounceFor('rust', params)).toBe(150)
    })
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
    ;(controller as unknown as { current: unknown }).current = { text: 'useState(0)\nnextLine()', position: { lineNumber: 1, column: 3 }, path: 'a.ts' }
    expect(controller.acceptNextLine()).toBe('useState(0)\n')
    expect(controller.acceptNextLine()).toBe('nextLine()')
    expect(controller.acceptNextLine()).toBeUndefined()
    expect(edits.map(edit => edit.text)).toEqual(['useState(0)\n', 'nextLine()'])
    expect(recorded[0]).toEqual({ filePath: 'a.ts', start: 2, end: 14, text: 'useState(0)\n', inline: true })
  })


  it('does not send anything when a blocking tenant rule matches the outgoing document', async () => {
    // 请求前预过滤：内容一旦发出去就收不回来了，所以拦截要在发之前生效。
    let calls = 0
    const client = {
      suggest: async () => { calls += 1; return { candidates: [], finishReason: 'done', masked: false, timing: { requestedAt: 0 } } },
      recordAccept: () => undefined,
    }
    const model = {
      uri: { path: '/a.ts' },
      getLanguageId: () => 'typescript',
      getValue: () => 'const key = "-----BEGIN RSA PRIVATE KEY-----"',
      getOffsetAt: (position: { column: number }) => position.column - 1,
    }
    const controller = new InlineCompletionController({
      client: client as unknown as CompletionClient,
      controllerId: 'prefilter-test',
      kinds: { automatic: 0 as unknown as monaco.languages.InlineCompletionTriggerKind, explicit: 1 as unknown as monaco.languages.InlineCompletionTriggerKind },
      emptyRangeAt: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } as unknown as monaco.Range),
      editor: { getModel: () => model, getPosition: () => ({ lineNumber: 1, column: 1 }), executeEdits: () => undefined } as unknown as monaco.editor.IStandaloneCodeEditor,
    })
    const call = () => controller.provide(
      model as unknown as monaco.editor.ITextModel,
      { lineNumber: 1, column: 1 } as unknown as monaco.Position,
      { triggerKind: 1 } as unknown as monaco.languages.InlineCompletionContext,
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as monaco.CancellationToken,
    )
    // 未设置规则时照常请求。
    await call()
    expect(calls).toBe(1)
    // 设置拦截规则后不再发出请求。
    controller.setSecurityRules([{ id: 'private-key-block', name: '私钥块', action: 'block', pattern: '-----BEGIN [A-Z ]*PRIVATE KEY-----' }])
    expect(await call()).toBeUndefined()
    expect(calls).toBe(1)
    // 脱敏规则不该拦住请求：内容照常送出，由服务端标记。
    controller.setSecurityRules([{ id: 'generic-credential', name: '硬编码凭据', action: 'mask', pattern: 'secret' }])
    // 换个位置：同一位置会命中控制器自己的「上次结果」缓存，走不到请求这一步。
    await controller.provide(
      model as unknown as monaco.editor.ITextModel,
      { lineNumber: 1, column: 2 } as unknown as monaco.Position,
      { triggerKind: 1 } as unknown as monaco.languages.InlineCompletionContext,
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as monaco.CancellationToken,
    )
    expect(calls).toBe(2)
  })

  it('records an accept only when the inserted text continues a candidate', async () => {
    // Monaco 不执行条目上的 command，采纳靠内容变更识别。这条判断判错过两次，所以正反两面都钉住。
    const reported: Array<{ kind: string }> = []
    const accepted: Array<{ filePath: string; start: number; end: number; inline: boolean; text: string }> = []
    const model = {
      uri: { path: '/a.ts' },
      getLanguageId: () => 'typescript',
      getValue: () => 'const value = useSt',
      getOffsetAt: (position: { column: number }) => position.column - 1,
    }
    const controller = new InlineCompletionController({
      client: {
        suggest: async () => ({ candidates: ['ate more'], finishReason: 'done', masked: false, model: 'local-heuristic', experiment: 'control', timing: { requestedAt: 0, rttMs: 12 } }),
        recordAccept: (payload: { filePath: string; start: number; end: number; inline: boolean; text: string }) => { accepted.push(payload) },
      } as unknown as CompletionClient,
      controllerId: 'accept-test',
      kinds: { automatic: 0 as unknown as monaco.languages.InlineCompletionTriggerKind, explicit: 1 as unknown as monaco.languages.InlineCompletionTriggerKind },
      emptyRangeAt: () => ({ startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 3 } as unknown as monaco.Range),
      editor: {
        getModel: () => model,
        getPosition: () => ({ lineNumber: 1, column: 3 }),
        executeEdits: () => undefined,
      } as unknown as monaco.editor.IStandaloneCodeEditor,
      report: event => { reported.push(event) },
    })

    await controller.provide(
      model as unknown as monaco.editor.ITextModel,
      { lineNumber: 1, column: 3 } as unknown as monaco.Position,
      { triggerKind: 1 } as unknown as monaco.languages.InlineCompletionContext,
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as monaco.CancellationToken,
    )

    const change = (text: string, rangeLength: number) => ({ changes: [{ text, rangeLength, range: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 3 } } as unknown as monaco.editor.IModelContentChange] })

    // 单字符不记：命中候选前缀的概率太高。
    controller.noteChange(change('a', 0))
    expect(accepted).toHaveLength(0)

    // 不是候选前缀：不是采纳。
    controller.noteChange(change('zz', 0))
    expect(accepted).toHaveLength(0)

    // 换行：不是行内采纳。
    controller.noteChange(change('at\nen', 0))
    expect(accepted).toHaveLength(0)

    // 命中：插入的文本是候选的前缀。
    controller.noteChange(change('ate', 0))
    // end - start 就是采纳区间，文档 4.5 第 1、2 条判定靠它。
    expect(accepted).toEqual([{ filePath: 'a.ts', start: 2, end: 5, inline: true, text: 'ate' }])
    expect(reported.filter(event => event.kind === 'accepted')).toHaveLength(1)
  })

  it('sends the last edit with the request', async () => {
    // 宿主有三条丢弃判定与 prompt 的编辑历史段都依赖它；曾经协议里有字段、客户端从不填。
    const sent: Array<{ lastEdit?: { before: string; after: string } }> = []
    let value = 'const a = 1\nconst b = 2'
    const model = {
      uri: { path: '/a.ts' },
      getLanguageId: () => 'typescript',
      getValue: () => value,
      getValueLength: () => value.length,
      getOffsetAt: (position: { column: number }) => position.column - 1,
    }
    const controller = new InlineCompletionController({
      client: {
        suggest: async (input: { lastEdit?: { before: string; after: string } }) => {
          sent.push(input)
          return { candidates: ['ate'], finishReason: 'done', masked: false, model: 'local-heuristic', experiment: 'control', timing: { requestedAt: 0, rttMs: 1 } }
        },
        recordAccept: () => undefined,
      } as unknown as CompletionClient,
      controllerId: 'last-edit-test',
      kinds: { automatic: 0 as unknown as monaco.languages.InlineCompletionTriggerKind, explicit: 1 as unknown as monaco.languages.InlineCompletionTriggerKind },
      emptyRangeAt: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } as unknown as monaco.Range),
      editor: { getModel: () => model, getPosition: () => ({ lineNumber: 1, column: 1 }), executeEdits: () => undefined } as unknown as monaco.editor.IStandaloneCodeEditor,
    })

    // 真实顺序：文档先变，变更事件后到。第一次变更还没有上一版可对照，因此记不下前后文本
    // （这是设计：宁可不记也不记错）。
    value = 'const a = 1\nconst b = 23'
    controller.noteChange({ changes: [{ text: '3', rangeLength: 0, range: { startLineNumber: 2, startColumn: 11, endLineNumber: 2, endColumn: 11 } } as unknown as monaco.editor.IModelContentChange] })
    await controller.provide(
      model as unknown as monaco.editor.ITextModel,
      { lineNumber: 2, column: 12 } as unknown as monaco.Position,
      { triggerKind: 1 } as unknown as monaco.languages.InlineCompletionContext,
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as monaco.CancellationToken,
    )
    expect(sent[0]?.lastEdit).toBeUndefined()
    // 第二次之后有一版可对照，删掉的「3」被记下来。

    // 第二次变更：删掉刚输入的「3」——被删的文本从上一版文档里取。
    value = 'const a = 1\nconst b = 2'
    controller.noteChange({ changes: [{ text: '', rangeLength: 1, range: { startLineNumber: 2, startColumn: 12, endLineNumber: 2, endColumn: 13 } } as unknown as monaco.editor.IModelContentChange] })
    // 位置与上一次不同：相同位置会命中客户端缓存、不发请求（这是设计行为）。
    await controller.provide(
      model as unknown as monaco.editor.ITextModel,
      { lineNumber: 2, column: 11 } as unknown as monaco.Position,
      { triggerKind: 1 } as unknown as monaco.languages.InlineCompletionContext,
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as monaco.CancellationToken,
    )
    expect(sent.at(-1)?.lastEdit).toEqual({ before: '3', after: '' })
  })

  it('passes the server params into suggest so the request window uses the same budgets', async () => {
    // 服务端按实验分组下发 prefixChars/suffixChars；控制器必须把这份 params 交给 suggest，
    // 否则客户端裁剪会退回本地默认值，与宿主实际使用的预算不一致。
    const params: CompletionParams = { ...DEFAULT_COMPLETION_PARAMS, prefixChars: 111, suffixChars: 222 }
    const calls: Array<[unknown, CompletionParams | undefined]> = []
    const model = {
      uri: { path: '/a.ts' },
      getLanguageId: () => 'typescript',
      getValue: () => 'const value = useSt',
      getOffsetAt: (position: { column: number }) => position.column - 1,
    }
    const controller = new InlineCompletionController({
      client: {
        suggest: async (input: unknown, received?: CompletionParams) => {
          calls.push([input, received])
          return { candidates: [], finishReason: 'done', masked: false, timing: { requestedAt: 0 } }
        },
        recordAccept: () => undefined,
      } as unknown as CompletionClient,
      params,
      controllerId: 'window-params-test',
      kinds: { automatic: 0 as unknown as monaco.languages.InlineCompletionTriggerKind, explicit: 1 as unknown as monaco.languages.InlineCompletionTriggerKind },
      emptyRangeAt: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } as unknown as monaco.Range),
      editor: { getModel: () => model, getPosition: () => ({ lineNumber: 1, column: 1 }), executeEdits: () => undefined } as unknown as monaco.editor.IStandaloneCodeEditor,
    })
    await controller.provide(
      model as unknown as monaco.editor.ITextModel,
      { lineNumber: 1, column: 3 } as unknown as monaco.Position,
      { triggerKind: 1 } as unknown as monaco.languages.InlineCompletionContext,
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as monaco.CancellationToken,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[1]).toMatchObject({ prefixChars: 111, suffixChars: 222 })
  })

  it('reports shown, accepted and cancelled through the telemetry hook', async () => {
    // 采样点必须真的接上：采纳率的分母是展示次数，取消率来自在途请求被变更作废。
    const reported: Array<{ kind: string; candidateCount?: number; firstByteMs?: number; model?: string; experiment?: string }> = []
    const model = {
      uri: { path: '/a.ts' },
      getLanguageId: () => 'typescript',
      getValue: () => 'const value = useSt',
      getOffsetAt: (position: { column: number }) => position.column - 1,
    }
    const editor = {
      getModel: () => model,
      getPosition: () => ({ lineNumber: 1, column: 3 }),
      executeEdits: () => undefined,
    }
    const client = {
      suggest: async () => ({ candidates: ['ate'], finishReason: 'done', masked: false, model: 'local-heuristic', experiment: 'control', timing: { requestedAt: 0, rttMs: 12 } }),
      recordAccept: () => undefined,
    }
    const controller = new InlineCompletionController({
      client: client as unknown as CompletionClient,
      controllerId: 'telemetry-test',
      kinds: { automatic: 0 as unknown as monaco.languages.InlineCompletionTriggerKind, explicit: 1 as unknown as monaco.languages.InlineCompletionTriggerKind },
      emptyRangeAt: () => ({ startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 3 } as unknown as monaco.Range),
      editor: editor as unknown as monaco.editor.IStandaloneCodeEditor,
      report: event => { reported.push(event) },
    })

    const completions = await controller.provide(
      model as unknown as monaco.editor.ITextModel,
      { lineNumber: 1, column: 3 } as unknown as monaco.Position,
      { triggerKind: 1 } as unknown as monaco.languages.InlineCompletionContext,
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as monaco.CancellationToken,
    )
    expect(completions?.items).toHaveLength(1)
    expect(reported[0]).toEqual({ kind: 'shown', language: 'typescript', candidateCount: 1, model: 'local-heuristic', experiment: 'control', firstByteMs: 12 })

    controller.recordAccepted({ path: 'a.ts', offset: 0, text: 'ate' })
    expect(reported[1]).toEqual({ kind: 'accepted', language: 'typescript' })

    // 有在途请求时再变更，就是一次取消。
    ;(controller as unknown as { inFlight: unknown }).inFlight = { abort: () => undefined }
    controller.noteChange({ changes: [{ text: 'x' } as unknown as monaco.editor.IModelContentChange] })
    expect(reported[2]).toEqual({ kind: 'cancelled', language: 'typescript' })

    // 上游失败要留痕，否则界面上只表现为「没有补全」。
    const failing = new InlineCompletionController({
      client: { suggest: async () => { throw new Error('upstream down') }, recordAccept: () => undefined } as unknown as CompletionClient,
      controllerId: 'failure-test',
      kinds: { automatic: 0 as unknown as monaco.languages.InlineCompletionTriggerKind, explicit: 1 as unknown as monaco.languages.InlineCompletionTriggerKind },
      emptyRangeAt: () => ({ startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 3 } as unknown as monaco.Range),
      editor: editor as unknown as monaco.editor.IStandaloneCodeEditor,
      report: event => { reported.push(event) },
    })
    await expect(failing.provide(
      model as unknown as monaco.editor.ITextModel,
      { lineNumber: 1, column: 3 } as unknown as monaco.Position,
      { triggerKind: 1 } as unknown as monaco.languages.InlineCompletionContext,
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as monaco.CancellationToken,
    )).rejects.toThrow('upstream down')
    expect(reported.at(-1)).toEqual({ kind: 'failed', language: 'typescript', error: 'upstream down' })
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

  it('wires lastEdit into the filter so a rollback candidate is dropped', async () => {
    // 宿主已经把「改前/改后」送进 suggest()，这里钉住它真的被组装进 filter state ——
    // 不接线的话 filter.ts 的 rollback-edit 判定在生产链路永远不会触发（审计 B-1）。
    const fetchImpl = vi.fn(async () => streamResponse(events(
      { type: 'output', candidates: [{ index: 0, text: 'before', finishReason: '', elapsedMs: 1 }] },
      { type: 'done' },
    )))
    // 最近一次编辑是把 'before' 改成 'after'；现在光标处是 'zzz'（看不到 'after'），
    // 模型又把 'before' 建议回来 —— 这是「回滚」，应当丢弃。
    const rollback = await new CompletionClient({ endpoint: '/c', sessionId: 's', fetchImpl }).suggest(
      input({ document: 'xxxxxzzz', rewriteAt: { line: 1, column: 6 }, lastEdit: { before: 'before', after: 'after' } }),
    )
    expect(rollback.candidates).toEqual([])
    // 同一候选、同一文档，只是不带 lastEdit 就必须保留：证明丢弃来自新接的线，而不是别的规则。
    const plain = await new CompletionClient({ endpoint: '/c', sessionId: 's', fetchImpl }).suggest(
      input({ document: 'xxxxxzzz', rewriteAt: { line: 1, column: 6 } }),
    )
    expect(plain.candidates).toEqual(['before'])
  })

  it('drops a candidate identical to the text after the cursor', async () => {
    const fetchImpl = vi.fn(async () => streamResponse(events({ type: 'output', candidates: [{ index: 0, text: 'ate()', finishReason: '', elapsedMs: 1 }] }, { type: 'done' })))
    const client = new CompletionClient({ endpoint: '/c', sessionId: 's', fetchImpl })
    const result = await client.suggest(input({ document: 'const value = useState()' }))
    expect(result.candidates).toEqual([])
  })

  it('keeps every candidate the host sent, so the user can switch between them', async () => {
    // 真实响应是逐条推来的：index 0 与 index 1。若只留第一条，切换就没有候选可切（文档 4.6）。
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(encodeSseEvent({ type: 'output', candidates: [{ index: 0, text: 'SyncExternalStore', finishReason: '', elapsedMs: 1 }] })))
        controller.enqueue(encoder.encode(encodeSseEvent({ type: 'output', candidates: [{ index: 1, text: 'State', finishReason: '', elapsedMs: 1 }] })))
        controller.enqueue(encoder.encode(encodeSseEvent({ type: 'done' })))
        controller.close()
      },
    })
    const client = new CompletionClient({ endpoint: '/c', sessionId: 's', fetchImpl: async () => new Response(stream, { status: 200 }) })
    const result = await client.suggest(input({ document: 'const a = useState(0)\nconst c = use', rewriteAt: { line: 2, column: 13 } }))
    expect(result.candidates).toEqual(['SyncExternalStore', 'State'])
  })

  it('discards every candidate when the host reports a blocking security hit', async () => {
    // 拦截的语义是「中止本次补全」：已经流过来的候选也不能给出去。
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(encodeSseEvent({ type: 'output', candidates: [{ index: 0, text: 'key = -----BEGIN', finishReason: '', elapsedMs: 1 }] })))
        controller.enqueue(encoder.encode(encodeSseEvent({ type: 'content_security', action: 'block', ruleId: 'private-key-block', ruleName: '私钥块' })))
        controller.enqueue(encoder.encode(encodeSseEvent({ type: 'done' })))
        controller.close()
      },
    })
    const client = new CompletionClient({ endpoint: '/c', sessionId: 's', fetchImpl: async () => new Response(stream, { status: 200 }) })
    const result = await client.suggest(input({}))
    expect(result.candidates).toEqual([])
    expect(result.security).toEqual({ action: 'block', ruleId: 'private-key-block', ruleName: '私钥块' })
    expect(result.masked).toBe(false)
  })

  it('keeps the candidate but marks it when the hit is only a mask', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(encodeSseEvent({ type: 'output', candidates: [{ index: 0, text: 'ate', finishReason: '', elapsedMs: 1 }] })))
        controller.enqueue(encoder.encode(encodeSseEvent({ type: 'content_security', action: 'mask', ruleId: 'generic-credential', ruleName: '硬编码凭据' })))
        controller.enqueue(encoder.encode(encodeSseEvent({ type: 'done' })))
        controller.close()
      },
    })
    const client = new CompletionClient({ endpoint: '/c', sessionId: 's', fetchImpl: async () => new Response(stream, { status: 200 }) })
    const result = await client.suggest(input({}))
    expect(result.candidates).toEqual(['ate'])
    expect(result.masked).toBe(true)
    expect(result.security?.ruleId).toBe('generic-credential')
  })

  it('removes the part of the candidate that repeats the text before the cursor', async () => {
    // 对话模型常把已输入的内容又吐一遍：候选是插入式的，不去掉就会在同一行出现两份。
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(encodeSseEvent({ type: 'output', candidates: [{ index: 0, text: 'total(', finishReason: '', elapsedMs: 1 }] })))
        controller.enqueue(encoder.encode(encodeSseEvent({ type: 'output', candidates: [{ index: 0, text: 'items)', finishReason: '', elapsedMs: 2 }] })))
        controller.enqueue(encoder.encode(encodeSseEvent({ type: 'done' })))
        controller.close()
      },
    })
    const client = new CompletionClient({ endpoint: '/c', sessionId: 's', fetchImpl: async () => new Response(stream, { status: 200 }) })
    // 光标在 'const n = total' 之后（'(' 之前，0 起第 15 列）。
    const result = await client.suggest(input({ document: 'const n = total(', rewriteAt: { line: 1, column: 15 } }))
    expect(result.candidates).toEqual(['(items)'])
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

  it('sends only a cursor window for a 1MB document while keeping the local document intact', async () => {
    const line = 'const value_{i} = computeSomething(alpha, beta, gamma) // 普通代码行'
    const lines: string[] = []
    let size = 0
    for (let index = 0; size < 1024 * 1024; index++) {
      const text = line.replace('{i}', String(index))
      lines.push(text)
      size += text.length + 1
    }
    const document = lines.join('\n')
    const rewriteAt = { line: Math.floor(lines.length / 2) + 1, column: 20 }
    let body: { cursor: { document: string; rewriteAt: { line: number; column: number } } } | undefined
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return streamResponse(events({ type: 'output', candidates: [{ index: 0, text: 'ate', finishReason: '', elapsedMs: 1 }] }, { type: 'done' }))
    })
    const client = new CompletionClient({ endpoint: '/c', sessionId: 's', fetchImpl })
    const result = await client.suggest(input({ document, rewriteAt }))
    expect(result.candidates).toEqual(['ate'])
    expect(body).toBeDefined()
    expect(body!.cursor.document.length).toBeLessThan(document.length / 10)
    // 请求里的行列换算后仍指向同一位置：裁剪掉的是前面的行。
    expect(body!.cursor.rewriteAt.line).toBeLessThan(rewriteAt.line)
    const cursorLine = body!.cursor.document.split('\n')[body!.cursor.rewriteAt.line - 1] ?? ''
    expect(cursorLine.slice(0, body!.cursor.rewriteAt.column - 1)).toMatch(/const value_/)
    // 本地过滤/后处理仍然用完整文档，候选处理结果不受请求裁剪影响。
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('leaves a small document request body byte-identical', async () => {
    let body: { cursor: { document: string; rewriteAt: { line: number; column: number } } } | undefined
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return streamResponse(events({ type: 'done' }))
    })
    const client = new CompletionClient({ endpoint: '/c', sessionId: 's', fetchImpl })
    const small = input()
    await client.suggest(small)
    expect(body!.cursor.document).toBe(small.document)
    expect(body!.cursor.rewriteAt).toEqual(small.rewriteAt)
  })

  it('honours the params passed to suggest when sizing the request window', async () => {
    const line = 'const value = computeSomething(alpha, beta, gamma)'
    const document = Array.from({ length: 2000 }, (_value, index) => `${line} // ${index}`).join('\n')
    const rewriteAt = { line: 1000, column: 20 }
    const capture = async (params: CompletionParams): Promise<number> => {
      let body: { cursor: { document: string } } | undefined
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body))
        return streamResponse(events({ type: 'done' }))
      })
      await new CompletionClient({ endpoint: '/c', sessionId: 's', fetchImpl }).suggest(input({ document, rewriteAt }), params)
      return body!.cursor.document.length
    }
    const wide = await capture({ ...DEFAULT_COMPLETION_PARAMS, prefixChars: 7000 })
    const narrow = await capture({ ...DEFAULT_COMPLETION_PARAMS, prefixChars: 200 })
    expect(narrow).toBeLessThan(wide)
  })
})
