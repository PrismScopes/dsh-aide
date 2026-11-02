/**
 * 补全提供方的类型契约。
 *
 * 这里只留接口：补全只有 DSH 默认模型这一条路（见 dshProvider.ts）。本地兜底、OpenAI 兼容端点
 * 与自定义路由已经移除 —— 模型不可用时由用户自己换 DSH 的模型，插件不做静默降级。
 */

/** 上游产出的一块内容；`index` 是候选序号，同一候选的流式增量共用它。 */
export interface CompletionChunk { text: string; done: boolean; index?: number }

export interface ProviderContext {
  signal: AbortSignal
  /** 会话号：DSH 的请求扩展要求它，缺了会在发请求前失败。 */
  sessionId: string
  language: string
  params: import('./params.ts').CompletionParams
  /** FIM 的前缀与后缀。 */
  prefix: string
  suffix: string
}

export interface CompletionProvider {
  id: string
  model: string
  complete(prompt: string, context: ProviderContext): AsyncIterable<CompletionChunk>
}
