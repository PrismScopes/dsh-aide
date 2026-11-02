/**
 * 编辑器内 AI 修改：把「选中代码 + 周边上下文 + 一条自然语言指令」交给 DSH 的模型，拿回替换文本。
 *
 * 为什么由宿主构造 prompt 并调用模型：模型选择、凭据与调用链都在 DSH 进程里（与补全同一条路），
 * 客户端不持有密钥，也不必知道 provider 的细节。客户端只负责选区、上下文窗口与最终 diff 的呈现。
 *
 * 与补全的差别：补全追求「短、快、只续写」，编辑任务要覆盖整段选中的代码，所以不设停止串、
 * 预算更高，并且要求模型只输出替换文本 —— 代码围栏与解释由这里剥掉，不指望模型每次都听话。
 */
import type { HostContext } from './context.ts'
import type { DshDefaultModelService, DshLlmService, DshStreamChunk } from './completion/dshProvider.ts'
import { completionSettings } from './completion/settings.ts'
import { WorkbenchError } from './wire.ts'

/** 客户端提交的一次编辑请求。上下文由客户端按行裁剪，宿主不再读盘。 */
export interface InlineEditInput {
  /** 工作区相对路径，仅用于 prompt 与日志。 */
  filePath: string
  language: string
  instruction: string
  selectionText: string
  /** 选区前面的若干行（已按行对齐）。 */
  before: string
  /** 选区后面的若干行（已按行对齐）。 */
  after: string
}

export interface InlineEditResult { text: string; model: string }

/** prompt 各段的字符上限：超过就截断，避免把整文件塞进上下文。 */
export const INLINE_EDIT_LIMITS = { selection: 20_000, surrounding: 8_000, instruction: 2_000 } as const
/** 输出上限：编辑整段函数通常够用，再大就说明模型在写解释或整文件。 */
const INLINE_EDIT_MAX_TOKENS = 4_096
/** 模型调用超时；超时按失败处理，客户端可以重新发起。 */
const INLINE_EDIT_TIMEOUT_MS = 120_000

/** 截断到上限，保留头尾（截中间会丢掉正在改的那一段）。 */
function clip(value: string, limit: number): string {
  if (value.length <= limit) return value
  const head = Math.ceil(limit * 0.6)
  return `${value.slice(0, head)}\n…（已截断 ${value.length - limit} 字符）…\n${value.slice(-(limit - head))}`
}

/**
 * 构造 prompt。
 *
 * 明确要求「只输出替换文本」比依赖模型自觉更可靠；同时给出语言与文件路径，模型才会按该语言的
 * 缩进与惯用写法生成，而不是把 JavaScript 片段写进 Python 文件。
 */
export function buildInlineEditPrompt(input: InlineEditInput): string {
  const instruction = clip(input.instruction.trim(), INLINE_EDIT_LIMITS.instruction)
  const selection = clip(input.selectionText, INLINE_EDIT_LIMITS.selection)
  const before = clip(input.before, INLINE_EDIT_LIMITS.surrounding)
  const after = clip(input.after, INLINE_EDIT_LIMITS.surrounding)
  const sections = [
    '你在一个代码编辑器里工作。根据用户要求改写下面「选中的代码」，只输出改写后的代码本身。',
    '规则：不要输出 Markdown 围栏；不要解释、不要复述原代码；保持原文件的缩进风格；输出必须是可直接替换选中内容的完整代码。',
    '',
    `文件：${input.filePath}`,
    `语言：${input.language}`,
    '',
    '【选中内容之前】',
    before === '' ? '（文件开头）' : before,
    '',
    '【选中的代码】',
    selection,
    '',
    '【选中内容之后】',
    after === '' ? '（文件结尾）' : after,
    '',
    '【用户要求】',
    instruction,
  ]
  return sections.join('\n')
}

/** 去掉代码围栏与解释性前后缀；CRLF 统一成 LF（Monaco 的模型内容是 LF）。 */
export function sanitizeInlineEditText(raw: string): string {
  let text = raw.replace(/\r\n/g, '\n').trim()
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text)
  if (fenced !== null) text = (fenced[1] ?? '').trim()
  else if (text.startsWith('```')) {
    text = text.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim()
  }
  return text
}

/** 请求体校验：字段必须是字符串；超长请求直接拒绝，避免把几 MB 文本喂进模型。 */
export function readInlineEditInput(body: Record<string, unknown>): InlineEditInput {
  const field = (name: string): string => {
    const value = body[name]
    if (typeof value !== 'string') throw new WorkbenchError('invalid-argument', `${name} must be a string`, 400)
    return value
  }
  const input: InlineEditInput = {
    filePath: field('filePath'),
    language: field('language'),
    instruction: field('instruction'),
    selectionText: field('selectionText'),
    before: field('before'),
    after: field('after'),
  }
  if (input.instruction.length > 8_000) throw new WorkbenchError('invalid-argument', 'instruction is too long', 400)
  if (input.selectionText.length > 200_000) throw new WorkbenchError('invalid-argument', 'selection is too long', 400)
  return input
}

/**
 * 调用模型完成一次编辑。
 *
 * 模型选择：优先用补全设置里显式配置的路由（用户可能把补全指到更快/更便宜的模型），
 * 否则用 DSH 的当前默认模型 —— 编辑是重任务，默认模型更合适。
 */
export async function runInlineEdit(ctx: HostContext, sessionId: string, input: InlineEditInput, signal?: AbortSignal): Promise<InlineEditResult> {
  if (input.selectionText.trim() === '') throw new WorkbenchError('invalid-argument', 'selection is empty', 400)
  if (input.instruction.trim() === '') throw new WorkbenchError('invalid-argument', 'instruction is empty', 400)
  const llm = ctx.get('llm') as DshLlmService | undefined
  const defaultModel = ctx.get('agentDefaultModel') as DshDefaultModelService | undefined
  if (llm === undefined) throw new WorkbenchError('ai-unavailable', 'DSH 模型服务不可用', 503)
  let provider: string
  let model: string
  // 编辑是重任务：优先用 DSH 的当前默认模型（对话用的那条），而不是补全设置里可能指向小模型的
  // 补全路由。只有默认模型服务缺席时才退回补全路由。
  const selection = defaultModel?.currentSelection()
  if (selection !== undefined) {
    provider = selection.provider
    model = selection.model
  } else {
    const configured = completionSettings().route
    if (configured === undefined) throw new WorkbenchError('ai-unavailable', 'DSH 没有可用的默认模型', 503)
    provider = configured.provider
    model = configured.model
  }

  const prompt = buildInlineEditPrompt(input)
  const request = {
    provider,
    model,
    ...(sessionId === '' ? {} : { sessionId }),
    temperature: 0.2,
    maxTokens: INLINE_EDIT_MAX_TOKENS,
    messages: [{ role: 'user' as const, content: prompt }],
    ...(signal === undefined ? {} : { signal }),
  }
  const text = await collectStream(llm, request)
  const cleaned = sanitizeInlineEditText(text)
  if (cleaned === '') throw new WorkbenchError('ai-empty', '模型没有返回可用的修改', 502)
  return { text: cleaned, model: `${provider}/${model}` }
}

/** 与补全相同的调用顺序：prepared 入口优先，不可用时退回服务级 stream。 */
async function collectStream(llm: DshLlmService, request: {
  provider: string
  model: string
  sessionId?: string
  temperature?: number
  maxTokens?: number
  messages: Array<{ role: 'user'; content: string }>
  signal?: AbortSignal
}): Promise<string> {
  const timeout = AbortSignal.timeout(INLINE_EDIT_TIMEOUT_MS)
  const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
  let stream: AsyncIterable<DshStreamChunk>
  try {
    const prepared = await llm.prepareCall({
      provider: request.provider,
      model: request.model,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      temperature: request.temperature,
      maxTokens: request.maxTokens,
    }, signal)
    stream = prepared.stream({ ...request, ...prepared.config, signal })
  } catch (error) {
    console.warn('[dsh-inline-edit] prepared 入口不可用，改用直接 stream：', error instanceof Error ? error.message : String(error))
    stream = llm.stream({ ...request, signal })
  }
  let text = ''
  for await (const chunk of stream) {
    if (signal.aborted) throw new WorkbenchError('ai-aborted', '模型调用已取消', 499)
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') { text += chunk.text; continue }
    if (chunk.type === 'finish') {
      const kind = chunk.reason?.kind
      if (kind === 'error') {
        const failure = chunk.reason?.failure
        const parts = [failure?.message ?? 'unknown error', failure?.code, failure?.status === undefined ? undefined : `status ${failure.status}`].filter(part => part !== undefined).map(part => String(part))
        throw new WorkbenchError('ai-failed', `模型调用失败（${request.provider}/${request.model}）：${parts.join(' · ')}`, 502)
      }
      if (kind === 'aborted') throw new WorkbenchError('ai-aborted', '模型调用已取消', 499)
      break
    }
  }
  return text
}
