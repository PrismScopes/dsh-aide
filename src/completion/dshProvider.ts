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

/**
 * 结束原因：正常结束、被中止，或失败。
 *
 * 失败时带上提供方返回的 HTTP 状态与机器码：这条路径的 message 是适配器包装过的通用文案，
 * 真正的原因（鉴权、路由、网络）只能从状态码区分。
 */
export interface DshFinishReason { kind?: string; failure?: { message?: string; code?: string; status?: number } }

/** 适配器产出的增量；只关心文本增量与结束。 */
export interface DshStreamChunk { type: string; text?: string; reason?: DshFinishReason }

export interface DshPreparedCall {
  /** 解析后的生效配置（含适配器默认值）：必须原样喂回 stream，否则 DSH 会拒绝这次调用。 */
  config?: DshCallConfig
  stream(options: DshGenerateOptions): AsyncIterable<DshStreamChunk>
}

export interface DshLlmService {
  /**
   * 服务级流式入口：只要求适配器实现 stream，agent 对话走的也是它。
   *
   * 不走服务级 prepareCall —— 那条路会再调适配器的 prepareCall，而适配器接口只强制 stream。
   * 实测某个第三方提供方的适配器没有 prepareCall，用 prepared 入口会直接报方法不存在。
   */
  stream(options: DshGenerateOptions): AsyncIterable<DshStreamChunk>
  prepareCall(config: DshCallConfig, signal?: AbortSignal): Promise<DshPreparedCall>
}

export interface DshDefaultModelService { currentSelection(): DshModelSelection }

/**
 * 对话式补全的停止串。
 *
 * 这里**不能**放代码围栏：对话模型往往一开头就输出 ```，把它当停止串会让生成刚起步就被截停、
 * 结果一个字都拿不到。围栏改由后处理剥掉（见 filter.ts 的 stripCodeFence）。
 */
export const COMPLETION_STOP = ['\n\n\n', '<CURSOR>']

export interface DshProviderOptions {
  params?: CompletionParams
  /** 覆盖默认模型选择；不传就用 DSH 的当前默认模型。 */
  selection?: DshModelSelection
  maxTokens?: number
}

/**
 * 把 DSH 的模型服务包成补全提供方。
 *
 * 每调用一次 `complete` 都重新取一次模型选择：用户可能在两分钟内改掉它，缓存住就会拿旧模型继续出结果。
 * 取选择与开流都不做推理，开销可以接受。
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
      const stream = llm.stream({
        provider: chosen.provider,
        model: chosen.model,
        temperature: 0,
        maxTokens,
        stop: COMPLETION_STOP,
        // 单条用户消息：补全不需要多轮，把上下文与指令都放进这一条里。
        messages: [{ role: 'user', content: prompt }],
        signal: context.signal,
      })
      for await (const chunk of stream) {
        if (context.signal.aborted) return
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
          yield { text: chunk.text, done: false }
          continue
        }
        if (chunk.type === 'finish') {
          // 失败的结束必须抛出去：否则调用方只看到一个空结果，把上游故障当成"模型没想出内容"。
          const kind = chunk.reason?.kind
          // 带上路由：失败信息里没有提供方与模型时，只能靠猜是哪条路断了。
          if (kind === 'error') {
            // 状态码与机器码一并带出：message 是适配器包装过的通用文案，区分鉴权 / 路由 / 网络只能靠它们。
            const failure = chunk.reason?.failure
            const parts = [
              failure?.message ?? 'unknown error',
              failure?.code,
              failure?.status === undefined ? undefined : `status ${failure.status}`,
            ].filter(part => part !== undefined).map(part => String(part))
            throw new Error(`completion upstream failed (${chosen.provider}/${chosen.model}): ${parts.join(' · ')}`)
          }
          if (kind === 'aborted') return
          break
        }
      }
      yield { text: '', done: true }
    },
  } satisfies CompletionProvider
}
