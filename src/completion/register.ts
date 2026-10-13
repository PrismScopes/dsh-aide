/**
 * 补全端点的注册与提供方解析。
 *
 * 单独成模块而不是塞进 routes.ts：这条链路有自己的提供方选择与流式收尾，放在一起会让两边都变难读。
 * 复用 routes.ts 已有的 trusted / readBody / send 辅助函数，由调用方传进来，不重复实现。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DEFAULT_COMPLETION_PARAMS, type CompletionParams } from './params.ts'
import { encodeSseEvent, type CompletionEvent, type CompletionRequest } from './protocol.ts'
import { dshProvider, type DshDefaultModelService, type DshLlmService } from './dshProvider.ts'
import { localProvider, type CompletionProvider } from './provider.ts'
import { DEFAULT_PROMPT_PROFILE, INSTRUCTION_PROMPT_PROFILE, type PromptProfile } from './prompt.ts'
import { runCompletion } from './service.ts'

/** 只是把 cordis 的可选服务读取收窄到本模块需要的形状。 */
export interface CompletionContextLike { get(name: string): unknown }

export interface ResolvedCompletionProvider {
  provider: CompletionProvider
  profile: PromptProfile
  source: 'dsh' | 'local'
  model: string
}

/**
 * 选提供方：有 DSH 模型服务就用它，没有就退到不联网的本地兜底。
 *
 * 两个服务分别探测而不是一起判：缺 `agentDefaultModel` 时仍可让配置里指定模型（第二期加），
 * 但缺 `llm` 就一定没有模型可用。
 */
export function resolveProvider(ctx: CompletionContextLike, params: CompletionParams = DEFAULT_COMPLETION_PARAMS): ResolvedCompletionProvider {
  const llm = ctx.get('llm') as DshLlmService | undefined
  const defaultModel = ctx.get('agentDefaultModel') as DshDefaultModelService | undefined
  // 允许显式指定本地兜底：离线、或要单独验证客户端链路时用；不设则优先用 DSH 的模型服务。
  const forced = (globalThis.process?.env?.['DSH_COMPLETION_PROVIDER'] ?? '').toLowerCase()
  if (forced !== 'local' && llm !== undefined && defaultModel !== undefined) {
    const provider = dshProvider(llm, defaultModel, { params })
    return { provider, profile: INSTRUCTION_PROMPT_PROFILE, source: 'dsh', model: provider.model }
  }
  const provider = localProvider(params)
  return { provider, profile: DEFAULT_PROMPT_PROFILE, source: 'local', model: provider.model }
}

/** 客户端从请求体里取出的必要字段；缺一不可，缺就按 400 处理。 */
function readRequest(body: unknown): CompletionRequest {
  if (typeof body !== 'object' || body === null) throw new Error('request body must be an object')
  const candidate = body as Partial<CompletionRequest>
  const cursor = candidate.cursor
  if (cursor === undefined || typeof cursor.document !== 'string' || typeof cursor.filePath !== 'string') throw new Error('cursor.document and cursor.filePath are required')
  if (typeof candidate.language !== 'string' || candidate.language === '') throw new Error('language is required')
  if (cursor.rewriteAt === undefined || typeof cursor.rewriteAt.line !== 'number' || typeof cursor.rewriteAt.column !== 'number') throw new Error('cursor.rewriteAt is required')
  return {
    sessionId: typeof candidate.sessionId === 'string' ? candidate.sessionId : '',
    environment: candidate.environment ?? { ideVersion: '', extensionVersion: '', region: '', channel: '', repository: '' },
    language: candidate.language,
    trigger: candidate.trigger === 'other' ? 'other' : 'inline',
    edits: Array.isArray(candidate.edits) ? candidate.edits : [],
    cursor: { filePath: cursor.filePath, rewriteAt: cursor.rewriteAt, document: cursor.document, ...(cursor.lastEdit === undefined ? {} : { lastEdit: cursor.lastEdit }) },
    diagnostics: Array.isArray(candidate.diagnostics) ? candidate.diagnostics : [],
    forceRewrite: candidate.forceRewrite === true,
    ...(candidate.intent === undefined ? {} : { intent: candidate.intent }),
    ...(candidate.security === undefined ? {} : { security: candidate.security }),
  }
}

export interface CompletionRouteHelpers {
  trusted(req: IncomingMessage, hosts: readonly string[]): boolean
  readBody(req: IncomingMessage): Promise<unknown>
  send(res: ServerResponse, status: number, payload: unknown): void
  sendError(res: ServerResponse, error: unknown): void
  trustedHosts: readonly string[]
}

/**
 * 注册 `POST /dsh-vscode/completion`。
 *
 * 事件以 SSE 写出：meta → output* → done。客户端断开时中止上游 —— 这是文档 4.1 的硬要求，
 * 否则用户在连续输入时会把在途连接堆起来。
 */
export function registerCompletionRoute(ctx: CompletionContextLike & { effect(run: () => void, label?: string): void; webServer: { register(route: { kind: 'exact'; path: string; handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }): () => void } }, helpers: CompletionRouteHelpers, params: CompletionParams = DEFAULT_COMPLETION_PARAMS): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-vscode/completion',
    handler: async (req, res) => {
      if (!helpers.trusted(req, helpers.trustedHosts)) return helpers.send(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
      if (req.method !== 'POST') return helpers.send(res, 405, { ok: false, error: { code: 'method', message: 'POST required' } })
      let request: CompletionRequest
      try {
        request = readRequest(await helpers.readBody(req))
      } catch (error) {
        return helpers.send(res, 400, { ok: false, error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error) } })
      }

      const controller = new AbortController()
      req.once('aborted', () => controller.abort())
      // 流式响应下 'close' 才是可靠的断开信号：客户端取消、切页、关标签都会走到这里。
      res.once('close', () => controller.abort())

      const resolved = resolveProvider(ctx, params)
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      try {
        for await (const event of runCompletion(request, { provider: resolved.provider, params, profile: resolved.profile, signal: controller.signal })) {
          if (res.writableEnded) break
          res.write(encodeSseEvent(event))
        }
      } catch (error) {
        const failure: CompletionEvent = { type: 'error', code: 'completion-failed', message: error instanceof Error ? error.message : String(error) }
        if (!res.writableEnded) res.write(encodeSseEvent(failure))
      } finally {
        if (!res.writableEnded) res.end()
      }
    },
  }), 'dsh-vscode-workbench: inline completion')
}
