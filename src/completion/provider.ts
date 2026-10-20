/**
 * 模型提供方。
 *
 * 分成两个实现：
 *   - `localCompletion`：不联网的兜底。用文档里出现过的标识符补全当前词，或在括号/引号未闭合时
 *     补齐。它的价值有两条：链路可以在没有模型、没有密钥的情况下端到端跑通；没配模型时用户也不会
 *     看到一个什么都不做的开关。
 *   - `httpProvider`：OpenAI 兼容的 FIM 补全端点（`POST {baseUrl}/completions`，`stream: true`），
 *     按流返回增量文本。地址、模型、密钥都由配置给，代码里不固化任何厂商。
 */
import { DEFAULT_COMPLETION_PARAMS, type CompletionParams } from './params.ts'

/**
 * 上游产出的一块内容。
 *
 * `index` 是候选序号：逐字流式的模型把同一条候选拆成多块，这些块必须共用同一个序号，
 * 客户端才知道是「追加」而不是「另一条候选」。缺省为 0（单候选的常见情形）。
 * 一次产出多条完整候选的实现（本地兜底）才需要自增。
 */
export interface CompletionChunk { text: string; done: boolean; index?: number }

export interface ProviderContext {
  signal: AbortSignal
  /**
   * 会话号。
   *
   * DSH 默认启用的请求扩展（`dsh_session_log`）要求请求携带它，缺了会在发出请求之前就失败，
   * 而失败被适配器包成 TRANSPORT，看不出原因。
   */
  sessionId: string
  language: string
  params: CompletionParams
  /** FIM 的前缀与后缀，本地兜底与调试都用它们，不必再解析 prompt。 */
  prefix: string
  suffix: string
}

export interface CompletionProvider {
  id: string
  model: string
  complete(prompt: string, context: ProviderContext): AsyncIterable<CompletionChunk>
}

/** 光标左侧的标识符片段；没有就是空串。 */
export function trailingIdentifier(prefix: string): string {
  const match = /([A-Za-z_$][\w$]*)$/.exec(prefix)
  return match?.[1] ?? ''
}

/**
 * 文档里出现过的、以 fragment 开头且更长的标识符，按离光标由近到远排序。
 *
 * 光标偏移必须由调用方给出：早先版本拿「文档长度的一半」当光标位置，排序结果与事实无关。
 * 同一个标识符出现多次时取离光标最近的那次。
 */
export function identifiersStartingWith(document: string, fragment: string, cursorOffset: number, limit: number): string[] {
  if (fragment === '') return []
  const found = new Map<string, number>()
  const pattern = /[A-Za-z_$][\w$]*/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(document)) !== null) {
    const word = match[0]
    if (word === fragment || !word.startsWith(fragment)) continue
    const distance = Math.abs(match.index - cursorOffset)
    const previous = found.get(word)
    if (previous === undefined || distance < previous) found.set(word, distance)
  }
  return [...found.entries()]
    .sort((left, right) => left[1] - right[1] || left[0].length - right[0].length)
    .slice(0, limit)
    .map(([word]) => word)
}

const CLOSERS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' }

/**
 * 从光标往前统计未闭合的括号与引号。
 *
 * 只看前缀，且引号按「成对出现」处理：代码里的引号大多成对，逐字符配对已经够用；真要做准需要词法
 * 分析，那属于第二期结构解析的活。
 */
export function unclosedClosers(prefix: string): string[] {
  const stack: string[] = []
  for (const char of prefix) {
    if (char in CLOSERS) { stack.push(CLOSERS[char] as string); continue }
    if (stack.at(-1) === char) stack.pop()
  }
  return stack
}

/**
 * 本地兜底补全。
 *
 * 顺序：先用文档里的标识符补当前词（最贴近「他写了一半」的场景），再退到补齐未闭合的括号与引号。
 * 两者都不适用时返回空数组 —— 宁可不给建议，也不要给一个无意义的建议。
 */
export function localCompletion(prefix: string, suffix: string, params: CompletionParams = DEFAULT_COMPLETION_PARAMS): string[] {
  const fragment = trailingIdentifier(prefix)
  if (fragment.length >= 1) {
    // 光标就在前缀末尾，所以整篇文档是前缀加后缀、光标偏移是前缀长度。
    const words = identifiersStartingWith(prefix + suffix, fragment, prefix.length, params.candidateLimit)
    if (words.length > 0) return words.map(word => word.slice(fragment.length))
  }
  const closers = unclosedClosers(prefix)
  if (closers.length > 0) {
    // 只有末尾确实是未闭合的结构时才补齐，且一次只补一层，避免弹出很长的一串。
    return [closers.at(-1) as string]
  }
  return []
}

/** 本地兜底作为提供方：把上面那套逻辑接到统一接口上。 */
export function localProvider(params: CompletionParams = DEFAULT_COMPLETION_PARAMS): CompletionProvider {
  return {
    id: 'local',
    model: 'local-heuristic',
    async *complete(_prompt: string, context: ProviderContext): AsyncIterable<CompletionChunk> {
      let index = 0
      for (const text of localCompletion(context.prefix, context.suffix, params)) {
        if (context.signal.aborted) return
        yield { text, done: false, index: index++ }
      }
      yield { text: '', done: true }
    },
  }
}

interface HttpProviderConfig {
  baseUrl: string
  model: string
  apiKey?: string
  /** 额外请求头，例如某些中转服务要求自定义字段。 */
  headers?: Record<string, string>
  maxTokens?: number
  temperature?: number
  stop?: string[]
}

interface CompletionApiChunk { choices?: Array<{ text?: string; finish_reason?: string | null }> }

/**
 * OpenAI 兼容的 FIM 补全端点。
 *
 * 只认经典 completions 接口的流式返回：`data: {"choices":[{"text":"..."}]}`，以 `data: [DONE]` 结束。
 * 这是多数代码模型暴露 FIM 能力的方式；要接 chat 接口应该在提供方这一层再加一个实现，而不是把
 * 两套协议揉进一个函数。
 */
export function httpProvider(config: HttpProviderConfig): CompletionProvider {
  return {
    id: 'http',
    model: config.model,
    async *complete(prompt: string, context: ProviderContext): AsyncIterable<CompletionChunk> {
      const response = await fetch(new URL('completions', config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` }),
          ...config.headers,
        },
        body: JSON.stringify({
          model: config.model,
          prompt,
          stream: true,
          max_tokens: config.maxTokens ?? 256,
          temperature: config.temperature ?? 0,
          ...(config.stop === undefined ? {} : { stop: config.stop }),
        }),
        signal: context.signal,
      })
      if (!response.ok || response.body === null) throw new Error(`completion upstream failed: ${response.status}`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.indexOf('\n\n')
          while (boundary !== -1) {
            const record = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            boundary = buffer.indexOf('\n\n')
            for (const line of record.split('\n')) {
              if (!line.startsWith('data:')) continue
              const data = line.slice(5).trim()
              if (data === '[DONE]') { yield { text: '', done: true }; return }
              try {
                const parsed = JSON.parse(data) as CompletionApiChunk
                const text = parsed.choices?.[0]?.text
                if (typeof text === 'string' && text !== '') yield { text, done: false }
              } catch { /* 上游心跳之类的非 JSON 记录 */ }
            }
          }
        }
      } finally {
        // 取消要真的生效：中止读取器，底层连接随之关闭（文档 4.1 明确要求）。
        if (context.signal.aborted) await reader.cancel().catch(() => undefined)
      }
      yield { text: '', done: true }
    },
  }
}
