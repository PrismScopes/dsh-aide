/**
 * 一次补全请求的编排：裁剪 → 组装 → 模型 → 事件流。
 *
 * 这一层不碰 HTTP：它只把事件按顺序产出来，宿主的路由负责写成 SSE。这样编排可以脱离网络单测，
 * 换传输方式（比如改成 WebSocket 或直接进程内调用）也不必改这里。
 */
import { DEFAULT_COMPLETION_PARAMS, type CompletionParams } from './params.ts'
import { assemblePrompt, truncateDocument, type PromptProfile } from './prompt.ts'
import type { CompletionEvent, CompletionRequest } from './protocol.ts'
import type { CompletionProvider } from './provider.ts'
import { evaluateSecurity, rulesForRequest, type SecurityHit } from './security.ts'

export interface CompletionServiceOptions {
  provider: CompletionProvider
  params?: CompletionParams
  /** 不含时用 provider 自己的默认排布（由调用方按模型挑好）。 */
  profile?: PromptProfile
  /** 调用方的取消信号：客户端断开时应当一并中止上游。 */
  signal?: AbortSignal
  /** 便于单测注入的时间源。 */
  now?: () => number
  /**
   * 检索钩子：返回要注入上下文的片段文本（文档 4.2 的「片段上下文」）。
   * 不含则不注入 —— 第一期就是这种形态，检索缺失时链路照常可用。
   */
  retrieve?: (request: CompletionRequest, params: CompletionParams) => Promise<readonly string[]> | readonly string[]
  /**
   * 内容安全命中回调。文档 6.4 要求拦截与脱敏两种动作都写入审计日志；
   * 这里只把命中交出去，落盘方式由宿主决定（它才知道工作区在哪、日志写到哪里）。
   */
  onSecurityHit?: (hit: SecurityHit, request: CompletionRequest) => void
}


export async function* runCompletion(request: CompletionRequest, options: CompletionServiceOptions): AsyncGenerator<CompletionEvent> {
  const params = options.params ?? DEFAULT_COMPLETION_PARAMS
  const now = options.now ?? (() => Date.now())
  const started = now()

  // 超时与调用方取消合成一个信号：任一触发都要真的中止上游。
  // 监听必须在第一个 yield 之前注册：消费者可能在收到 meta 之后、上游启动之前就取消，
  // 而 AbortSignal 不会重放已经发生的事件 —— 晚注册就会漏掉那次取消。
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (options.signal?.aborted === true) controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  // 超时与取消要走不同的收尾：取消是客户端自己的决定，不该再收到事件；超时必须上报。
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, params.completionTimeoutMs)
  // 判定对象是累积到目前的候选文本：流式输出会把一条模式切成两半，逐块匹配必然漏。
  let accumulated = ''
  const securityRules = rulesForRequest(request.security)
  try {
    const truncated = truncateDocument(request.cursor.document, request.cursor.rewriteAt, params)
    // 检索失败不能拖垮补全：拿不到片段就按没有片段继续（文档把检索列为可选上下文来源）。
    // 钩子可能是同步抛错的：必须先把它包进 promise 再 catch，否则异常会直接冒出编排层。
    const snippets = options.retrieve === undefined ? [] : await Promise.resolve().then(() => options.retrieve?.(request, params)).catch(() => [])
    const assembled = assemblePrompt({
      filePath: request.cursor.filePath,
      language: request.language,
      document: truncated.document,
      rewriteAt: truncated.rewriteAt,
      edits: request.edits,
      snippets,
    }, params, options.profile)

    if (controller.signal.aborted) return
    yield {
      type: 'meta',
      model: options.provider.model,
      ...(request.environment.experiment === undefined ? {} : { experiment: request.environment.experiment }),
      // 注入了几条检索片段：没有它就只能靠猜判断检索有没有生效。
      snippets: assembled.snippetCount,
    }
    for await (const chunk of options.provider.complete(assembled.prompt, {
      signal: controller.signal,
      language: request.language,
      params,
      prefix: assembled.prefix,
      suffix: assembled.suffix,
    })) {
      // 取消后上游可能还会吐出已经发出去的增量：这里必须丢掉，否则客户端会收到作废内容。
      if (controller.signal.aborted) return
      if (chunk.done || chunk.text === '') continue
      accumulated += chunk.text
      const hit = evaluateSecurity(accumulated, securityRules)
      if (hit !== undefined) {
        yield { type: 'content_security', ...hit }
        options.onSecurityHit?.(hit, request)
        if (hit.action === 'block') return
      }
      // 序号由 provider 决定：同一条候选的多个增量共用序号，否则流式模型会被拆成多条候选。
      const candidateIndex = chunk.index ?? 0
      yield { type: 'output', candidates: [{ index: candidateIndex, text: chunk.text, finishReason: '', elapsedMs: now() - started }] }
      if (candidateIndex + 1 >= params.candidateLimit) break
    }
  } catch (error) {
    if (timedOut) {
      yield { type: 'error', code: 'completion-timeout', message: `no completion within ${params.completionTimeoutMs} ms` }
      return
    }
    // 取消不是错误：客户端已经不要这次结果了，不发 error 事件让上层去分辨。
    if (!controller.signal.aborted) {
      yield { type: 'error', code: 'completion-failed', message: error instanceof Error ? error.message : String(error) }
      return
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
  if (timedOut) {
    yield { type: 'error', code: 'completion-timeout', message: `no completion within ${params.completionTimeoutMs} ms` }
    return
  }
  // 被取消的运行不补 done：这次请求在客户端那边已经作废了。
  if (controller.signal.aborted) return
  yield { type: 'done' }
}
