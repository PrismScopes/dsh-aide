/**
 * 用 DSH 自己的模型服务做补全提供方。
 *
 * 为什么不自建 HTTP 端点：DSH 已经持有用户配置好的 provider / 模型 / 凭据，插件再去配一遍等于要求
 * 用户维护第二份配置，而且密钥会多一处落点。这里通过 `llm.prepareCall(...).stream(...)` 走同一条
 * 调用链，模型选择默认取用户当前的默认模型。
 *
 * 只声明用到的部分，不引入 DSH 内部类型包：插件与宿主是两套独立的依赖，插件只需要这一小片接口。
 * 一旦 DSH 的接口变动，typecheck 会在这里报错，而不是在别处静默失效。
 */
import { DEFAULT_COMPLETION_PARAMS, type CompletionParams } from './params.ts'
import type { CompletionChunk, CompletionProvider, ProviderContext } from './provider.ts'

/** `ctx.agentDefaultModel.currentSelection()` 的返回值里我们用到的字段。 */
export interface DshModelSelection { provider: string; model: string; reasoningEffort?: string }

/** `GenerateOptions` 里我们用到的字段。 */
export interface DshGenerateOptions {
  provider: string
  model: string
  messages: Array<{ role: 'user'; content: string }>
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
}

/** `LlmCallConfig` 里我们用到的字段。 */
export interface DshCallConfig {
  provider: string
  model: string
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

/** 适配器产出的增量；只关心文本增量与结束。 */
export interface DshStreamChunk { type: string; text?: string; reason?: string }

export interface DshPreparedCall { stream(options: DshGenerateOptions): AsyncIterable<DshStreamChunk> }

export interface DshLlmService {
  prepareCall(config: DshCallConfig, signal?: AbortSignal): Promise<DshPreparedCall>
}

export interface DshDefaultModelService { currentSelection(): DshModelSelection }

/**
 * 对话式补全的停止串。
 *
 * 对话模型输出代码块时习惯补一个围栏，或在新一轮对话前停下；这些串出现即视为补全结束，
 * 免得把解释性文字一起插进代码里。
 */
export const COMPLETION_STOP = ['```', '\n\n\n', '<CURSOR>']

export interface DshProviderOptions {
  params?: CompletionParams
  /** 覆盖默认模型选择；不传就用 DSH 的当前默认模型。 */
  selection?: DshModelSelection
  maxTokens?: number
}

/**
 * 把 DSH 的模型服务包成补全提供方。
 *
 * 每调用一次 `complete` 都重新 `prepareCall`：模型选择可能在两分钟内被用户改掉，缓存 call 会拿旧
 * 模型继续出结果。`prepareCall` 本身不做推理，开销可以接受。
 */
export function dshProvider(llm: DshLlmService, defaultModel: DshDefaultModelService, options: DshProviderOptions = {}): CompletionProvider {
  const params = options.params ?? DEFAULT_COMPLETION_PARAMS
  const maxTokens = options.maxTokens ?? 256
  const selection = (): DshModelSelection => options.selection ?? defaultModel.currentSelection()
  return {
    id: 'dsh',
    get model(): string { return selection().model },
    async *complete(prompt: string, context: ProviderContext): AsyncIterable<CompletionChunk> {
      const chosen = selection()
      const call = await llm.prepareCall({ provider: chosen.provider, model: chosen.model, temperature: 0, maxTokens, stop: COMPLETION_STOP }, context.signal)
      const stream = call.stream({
        provider: chosen.provider,
        model: chosen.model,
        // 单条用户消息：补全不需要多轮，把上下文与指令都放进这一条里。
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        maxTokens,
        stop: COMPLETION_STOP,
        signal: context.signal,
      })
      for await (const chunk of stream) {
        if (context.signal.aborted) return
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
          yield { text: chunk.text, done: false }
          continue
        }
        if (chunk.type === 'finish') break
      }
      yield { text: '', done: true }
    },
  } satisfies CompletionProvider
}
