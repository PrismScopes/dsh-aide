/**
 * 模型失败时的回落。
 *
 * 存在的理由：模型通道可能临时不可用（网络、凭据、上游策略）。没有回落时用户在编辑器里只会看到
 * 「什么都没有」—— 而「什么都没有」无法与「这个功能没做」区分。回落让编辑器至少还有本地兜底的候选。
 *
 * 两条自我约束：
 *   - **必须留痕**。回落不是静默降级：每次回落都要经由 `onFallback` 报告原因，否则模型故障会被
 *     掩盖成「补全质量忽然变差」，那比直接不可用更难查。
 *   - **只有真的失败才回落**。上游正常返回空候选（模型认为这里没有可补的内容）不触发回落 ——
 *     那是有效结果，回落会把「模型说没有」变成「本地硬塞一条」，属于错误行为。
 */
import type { CompletionProvider, CompletionChunk, ProviderContext } from './provider.ts'

export interface FallbackOptions {
  /** 回落发生时调用：带上被放弃的主提供方与失败原因。 */
  onFallback?: (failure: { provider: string; model: string; error: string }) => void
}

/**
 * 主提供方失败时改用备用提供方。
 *
 * 只在主提供方**抛错**时回落；已经产出的增量会被保留（不重放），因为重放会让客户端收到两遍内容。
 */
export function fallbackProvider(primary: CompletionProvider, secondary: CompletionProvider, options: FallbackOptions = {}): CompletionProvider {
  return {
    id: `${primary.id}+${secondary.id}`,
    get model(): string { return primary.model },
    async *complete(prompt: string, context: ProviderContext): AsyncIterable<CompletionChunk> {
      let emitted = false
      try {
        for await (const chunk of primary.complete(prompt, context)) {
          if (chunk.done === false && chunk.text !== '') emitted = true
          yield chunk
        }
        return
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        options.onFallback?.({ provider: primary.id, model: primary.model, error: reason })
        // 已经吐过内容的失败不再回落：半条候选之后接上另一家的文本只会得到一段拼接垃圾。
        if (emitted) throw error
      }
      if (context.signal.aborted) return
      yield* secondary.complete(prompt, context)
    },
  }
}
