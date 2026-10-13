/**
 * 补全客户端核心：触发判定、请求发送、流式消费与结果过滤。
 *
 * 与编辑器无关：它只认「文件路径、语言、文档、光标位置」这几个输入，返回可直接插入的文本。
 * 这样 Monaco 之外再来一个编辑器（或做端到端测试）都能复用同一套逻辑，编辑器绑定只负责把
 * 光标与文档喂进来、把文本画成幻影。
 */
import { DEFAULT_COMPLETION_PARAMS, debounceFor, type CompletionParams } from '../completion/params.ts'
import { parseSse, type CompletionEvent, type CompletionRequest, type EditHistoryEntry } from '../completion/protocol.ts'
import {
  DEFAULT_FILTER_OPTIONS,
  filterCandidates,
  postProcess,
  type AcceptedRange,
  type FilterOptions,
} from '../completion/filter.ts'

export interface TriggerChange {
  /** 本次变更是否包含换行。换行意味着一个语句或代码块结束，是补全价值最高的时刻，跳过防抖。 */
  isNewLine: boolean
}

export interface TriggerPlan {
  immediate: boolean
  delayMs: number
}

/**
 * 触发决策：换行立即触发，其余按语言防抖。
 *
 * 单独成函数是为了能单测 —— 防抖时长与「换行例外」是文档明确规定的行为，不该埋在效果回调里。
 */
export function triggerPlan(change: TriggerChange, language: string, params: CompletionParams = DEFAULT_COMPLETION_PARAMS): TriggerPlan {
  if (change.isNewLine) return { immediate: true, delayMs: 0 }
  return { immediate: false, delayMs: debounceFor(language, params) }
}

export interface CompletionTiming {
  requestedAt: number
  firstByteAt?: number
  lastByteAt?: number
  /** 由计时三元组派生：请求发出到首字节到达。 */
  rttMs?: number
}

export interface CompletionResponse {
  /** 按候选序号排列的文本，序号跳跃处补空串。 */
  candidates: string[]
  finishReason: string
  model?: string
  experiment?: string
  /** 是否被内容安全策略处理过。 */
  masked: boolean
  timing: CompletionTiming
}

export interface SuggestInput {
  filePath: string
  language: string
  document: string
  /** 行号 1 起、列 0 起。 */
  rewriteAt: { line: number; column: number }
  edits?: EditHistoryEntry[]
  diagnostics?: CompletionRequest['diagnostics']
  signal?: AbortSignal
  /** 收到增量就回调，用于边流边渲染。 */
  onUpdate?: (candidates: string[]) => void
  /**
   * 只要首个候选可用就返回，不等整个流结束。
   *
   * Monaco 的行内补全接口一次请求一次返回，增量推不上屏幕；此时「等整个流」只会白等，
   * 拿到首个候选就收工才能把首字节优势用上。
   */
  firstCandidateOnly?: boolean
}

export interface CompletionClientOptions {
  /** 宿主侧的补全端点。 */
  endpoint: string
  sessionId: string
  params?: CompletionParams
  filterOptions?: FilterOptions
  /** 相同上下文的缓存有效期。文档要求命中缓存时直接呈现、不发请求。 */
  cacheTtlMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
}

/** 简单的内容指纹：够用来判断"上下文没变过"，不追求抗碰撞。 */
export function contextFingerprint(input: Pick<SuggestInput, 'filePath' | 'language' | 'document' | 'rewriteAt'>): string {
  const lines = input.document.split('\n')
  const line = lines[input.rewriteAt.line - 1] ?? ''
  const before = line.slice(0, input.rewriteAt.column)
  const after = line.slice(input.rewriteAt.column)
  const nextLine = lines[input.rewriteAt.line] ?? ''
  return [input.filePath, input.language, input.rewriteAt.line, before, after, nextLine].join('\u0000')
}

/** 把事件流按序号装进槽位：序号跳跃时补空串，保证槽位与序号一一对应。 */
export function applyEvent(slots: string[], event: CompletionEvent): { slots: string[]; finishReason?: string } {
  if (event.type !== 'output') return { slots }
  const next = [...slots]
  for (const candidate of event.candidates) {
    while (next.length < candidate.index) next.push('')
    next[candidate.index] = (next[candidate.index] ?? '') + candidate.text
  }
  return { slots: next }
}

export class CompletionClient {
  private readonly params: CompletionParams
  private readonly filterOptions: FilterOptions
  private readonly cacheTtlMs: number
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private cache: { key: string; at: number; response: CompletionResponse } | undefined
  private lastAccepted: AcceptedRange | undefined
  private cancelled: string | undefined

  constructor(private readonly options: CompletionClientOptions) {
    this.params = options.params ?? DEFAULT_COMPLETION_PARAMS
    this.filterOptions = options.filterOptions ?? DEFAULT_FILTER_OPTIONS
    this.cacheTtlMs = options.cacheTtlMs ?? 2_000
    // 不能直接把裸 fetch 存下来当方法用：浏览器要求它的接收者是全局对象，方法式调用会抛
    // "Illegal invocation"，于是请求一条都发不出去，而调用方只会看到一个永不落地的 promise。
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.now = options.now ?? (() => Date.now())
  }

  /** 记录一次采纳，供「与上次采纳区间」两条判定使用。 */
  recordAccept(range: AcceptedRange): void {
    this.lastAccepted = range
    this.cancelled = undefined
    this.cache = undefined
  }

  /** 记录因选择变化而取消的建议文本，供「刚建议过但未采纳」判定使用。 */
  recordCancel(text: string): void {
    this.cancelled = text
  }

  get tracking(): { lastAccepted?: AcceptedRange; cancelledSuggestion?: string } {
    return { ...(this.lastAccepted === undefined ? {} : { lastAccepted: this.lastAccepted }), ...(this.cancelled === undefined ? {} : { cancelledSuggestion: this.cancelled }) }
  }

  /**
   * 发一次补全请求并把流读完。
   *
   * 取消分两处生效：调用方的信号传给 fetch（连接真的被中止），循环里也不再消费后续增量。
   */
  async suggest(input: SuggestInput): Promise<CompletionResponse> {
    const key = contextFingerprint(input)
    const cached = this.cache
    if (cached !== undefined && cached.key === key && this.now() - cached.at <= this.cacheTtlMs) return cached.response

    const requestedAt = this.now()
    const body: CompletionRequest = {
      sessionId: this.options.sessionId,
      environment: { ideVersion: 'dsh-workbench', extensionVersion: '0.1.8', region: '', channel: 'desktop', repository: '' },
      language: input.language,
      trigger: 'inline',
      edits: input.edits ?? [],
      cursor: { filePath: input.filePath, rewriteAt: input.rewriteAt, document: input.document },
      diagnostics: input.diagnostics ?? [],
      forceRewrite: false,
    }

    const response = await this.fetchImpl(this.options.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    if (!response.ok || response.body === null) throw new Error(`completion request failed: ${response.status}`)

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let rest = ''
    let slots: string[] = []
    const timing: CompletionTiming = { requestedAt }
    let model: string | undefined
    let experiment: string | undefined
    let finishReason = ''
    let masked = false
    let failure: string | undefined
    // 首个候选已够用：下面收工时会把连接取消掉，不留下没人读的流。
    let early = false

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (timing.firstByteAt === undefined) timing.firstByteAt = this.now()
        const parsed = parseSse(decoder.decode(value, { stream: true }), rest)
        rest = parsed.rest
        for (const event of parsed.events) {
          if (event.type === 'meta') { model = event.model; experiment = event.experiment }
          else if (event.type === 'output') {
            const applied = applyEvent(slots, event)
            slots = applied.slots
            input.onUpdate?.(slots)
            if (input.firstCandidateOnly === true && (slots[0] ?? '') !== '') { early = true; break }
          } else if (event.type === 'error') { failure = `${event.code}: ${event.message}` }
          else if (event.type === 'content_security') { masked = true }
          else if (event.type === 'done') { finishReason = 'done' }
        }
        // 首个候选已够用：把连接取消掉（文档 4.1 要求取消真正生效），但不等待它结算 ——
        // 有在途数据时 cancel 的 Promise 不落地，await 会把 suggest 挂死，调用方因此永远拿不到候选。
        if (early) { void reader.cancel().catch(() => undefined); break }
      }
    } finally {
      // 同理：取消要发出去，但不能等它结算。
      if (input.signal?.aborted === true) void reader.cancel().catch(() => undefined)
    }

    timing.lastByteAt = this.now()
    if (timing.firstByteAt !== undefined) timing.rttMs = timing.firstByteAt - requestedAt
    if (failure !== undefined) throw new Error(failure)

    const filtered = filterCandidates(slots, this.filterState(input, slots), this.filterOptions)
    const candidates = filtered
      .filter((entry): entry is { text: string } => entry.dropped === undefined)
      .map(entry => postProcess(entry.text, { document: input.document, offset: this.offsetOf(input) }))
      .filter(text => text !== '')

    const result: CompletionResponse = { candidates, finishReason, masked, timing, ...(model === undefined ? {} : { model }), ...(experiment === undefined ? {} : { experiment }) }
    this.cache = { key, at: this.now(), response: result }
    return result
  }

  private offsetOf(input: Pick<SuggestInput, 'document' | 'rewriteAt'>): number {
    const lines = input.document.split('\n')
    let offset = 0
    for (let index = 0; index < Math.max(0, input.rewriteAt.line - 1); index++) offset += (lines[index] ?? '').length + 1
    return Math.min(offset + Math.max(0, input.rewriteAt.column), input.document.length)
  }

  private filterState(input: SuggestInput, slots: readonly string[]) {
    return {
      filePath: input.filePath,
      document: input.document,
      offset: this.offsetOf(input),
      language: input.language,
      ...(this.lastAccepted === undefined ? {} : { lastAccepted: this.lastAccepted }),
      ...(this.cancelled === undefined || slots.length === 0 ? {} : { cancelledSuggestion: this.cancelled }),
    }
  }
}
