/**
 * 补全端点的注册与提供方解析。
 *
 * 单独成模块而不是塞进 routes.ts：这条链路有自己的提供方选择与流式收尾，放在一起会让两边都变难读。
 * 复用 routes.ts 已有的 trusted / readBody / send 辅助函数，由调用方传进来，不重复实现。
 */
import { normalize } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fallbackProvider } from './fallback.ts'
import { completionSettings } from './settings.ts'
import { DEFAULT_COMPLETION_PARAMS, type CompletionParams } from './params.ts'
import { encodeSseEvent, type CompletionEvent, type CompletionRequest } from './protocol.ts'
import { dshProvider, type DshDefaultModelService, type DshLlmService } from './dshProvider.ts'
import { httpProvider, localProvider, type CompletionProvider } from './provider.ts'
import { DEFAULT_PROMPT_PROFILE, INSTRUCTION_PROMPT_PROFILE, type PromptProfile } from './prompt.ts'
import { runCompletion } from './service.ts'
import { WorkspaceIndex } from './workspaceIndex.ts'
import type { SecurityHit } from './security.ts'
import { groupForSession, paramsForGroup } from './experiment.ts'
import { TelemetryAggregator, type CompletionTelemetryEvent } from './telemetry.ts'
import { appendFile } from 'node:fs/promises'
import path from 'node:path'

/** 只是把 cordis 的可选服务读取收窄到本模块需要的形状。 */
export interface CompletionContextLike { get(name: string): unknown }

export interface ResolvedCompletionProvider {
  provider: CompletionProvider
  profile: PromptProfile
  source: 'dsh' | 'local' | 'http'
  model: string
}

/**
 * 选提供方。三种来源，按部署条件挑一条：
 *
 * - 显式要求本地兜底（`DSH_COMPLETION_PROVIDER=local`）：离线、或单独验证客户端链路时用；
 * - 配了 OpenAI 兼容的补全端点（`DSH_COMPLETION_ENDPOINT`）：不依赖 DSH 账号的部署通道；
 * - 其余情况用 DSH 的模型服务。模型不可用时**不会**自动回落：要回落得显式开启（见 settings.ts）。
 *
 * DSH 的两个服务分别探测而不是一起判：缺 `agentDefaultModel` 时仍可让配置里指定模型，
 * 但缺 `llm` 就一定没有模型可用。
 */
export function resolveProvider(ctx: CompletionContextLike, params: CompletionParams = DEFAULT_COMPLETION_PARAMS): ResolvedCompletionProvider {
  const llm = ctx.get('llm') as DshLlmService | undefined
  const defaultModel = ctx.get('agentDefaultModel') as DshDefaultModelService | undefined
  // 允许显式指定本地兜底：离线、或要单独验证客户端链路时用；不设则优先用 DSH 的模型服务。
  const forced = (globalThis.process?.env?.['DSH_COMPLETION_PROVIDER'] ?? '').toLowerCase()
  const endpoint = globalThis.process?.env?.['DSH_COMPLETION_ENDPOINT'] ?? ''
  if (forced !== 'local' && endpoint !== '') {
    const model = globalThis.process?.env?.['DSH_COMPLETION_MODEL'] ?? 'completion'
    const apiKey = globalThis.process?.env?.['DSH_COMPLETION_API_KEY']
    const provider = httpProvider({
      baseUrl: endpoint, model,
      ...(apiKey === undefined || apiKey === '' ? {} : { apiKey }),
    })
    return { provider, profile: DEFAULT_PROMPT_PROFILE, source: 'http', model }
  }
  if (forced !== 'local' && llm !== undefined && defaultModel !== undefined) {
    // 补全可以单独指定路由：用户可能希望对话与补全用不同的模型（例如补全走免费模型）。
    // 不设时沿用应用的默认模型，行为与以前一致。设置来源见 completion/settings.ts。
    const route = completionSettings().route
    const provider = dshProvider(llm, defaultModel, {
      params,
      ...(route === undefined ? {} : { selection: route }),
    })
    return { provider: withFallback(provider, params), profile: INSTRUCTION_PROMPT_PROFILE, source: 'dsh', model: provider.model }
  }
  const provider = localProvider(params)
  return { provider, profile: DEFAULT_PROMPT_PROFILE, source: 'local', model: provider.model }
}

/**
 * 按开关决定是否给模型提供方套上本地兜底。
 *
 * 默认关闭：模型故障应当显式暴露，而不是悄悄降级。开启后编辑器至少还有候选可用，
 * 同时每次回落都写宿主日志 —— 回落不等于把故障藏起来。
 */
function withFallback(provider: CompletionProvider, params: CompletionParams): CompletionProvider {
  if (!completionSettings().fallback) return provider
  return fallbackProvider(provider, localProvider(params), {
    onFallback: failure => {
      console.warn(`[dsh-completion] 模型调用失败，已回落本地兜底：${failure.provider}/${failure.model} · ${failure.error}`)
    },
  })
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
  /** 把会话解析成工作区根目录：索引按项目分库，检索要按同一个根目录进行。 */
  cwdFor(sessionId: string): string
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

      // 分组由服务端决定并按会话稳定分配（文档 4.3、七）：写回环境元数据后再往下走，
      // 这样 meta 事件、埋点与日志看到的是同一个分组。
      const experiment = groupForSession(request.sessionId)
      const tuned = { ...request, environment: { ...request.environment, experiment } }
      const groupParams = paramsForGroup(experiment)
      const resolved = resolveProvider(ctx, groupParams)
      const cwd = safeCwd(ctx, helpers, request.sessionId)
      // 解析不到工作区就不注入片段（文档把检索列为可选上下文来源）：好过索引错目录。
      const index = cwd === undefined ? undefined : await completionIndexFor(cwd, groupParams)
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      try {
        let candidateCount = 0
        let firstByteMs: number | undefined
        for await (const event of runCompletion(tuned, {
          provider: resolved.provider, params: groupParams, profile: resolved.profile, signal: controller.signal,
          // 索引没就绪就先不注入片段：刷新在后台跑，补全不等它。
          ...(index === undefined ? {} : { retrieve: (current: CompletionRequest) => index.retrieve(current) }),
          // 解析不到工作区时不写审计文件：不要往未知目录里落东西。
          ...(cwd === undefined ? {} : { onSecurityHit: (hit: SecurityHit, current: CompletionRequest) => { appendSecurityAudit(cwd, hit, current) } }),
        })) {
          if (event.type === 'output') {
            for (const candidate of event.candidates) {
              candidateCount = Math.max(candidateCount, candidate.index + 1)
              firstByteMs ??= candidate.elapsedMs
            }
          }
          if (res.writableEnded) break
          res.write(encodeSseEvent(event))
        }
        // 给出过候选才算一次「展示」：采纳率的分母是它。
        if (candidateCount > 0) {
          completionTelemetry.record({ kind: 'shown', sessionId: request.sessionId, language: request.language, model: resolved.model, experiment, ...(firstByteMs === undefined ? {} : { firstByteMs }), candidateCount })
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

/** 补全埋点聚合器（文档七：采纳率为主指标）。进程内保存，重启即清零。 */
export const completionTelemetry = new TelemetryAggregator()

/**
 * 内容安全审计（文档 6.4：拦截与脱敏两种动作都要写入审计日志）。
 *
 * 写在索引同一个工作区目录下（那里已经被索引自带的 .gitignore 排除），一行一条，便于事后追查。
 * 落盘失败不影响补全：审计是旁路，不能因为它把补全拖垮。
 */
function appendSecurityAudit(cwd: string, hit: SecurityHit, request: CompletionRequest): void {
  const line = JSON.stringify({ at: new Date().toISOString(), action: hit.action, ruleId: hit.ruleId, ruleName: hit.ruleName, sessionId: request.sessionId, filePath: request.cursor.filePath, language: request.language }) + '\n'
  void appendFile(path.join(cwd, '.dsh-workbench', 'audit.jsonl'), line, 'utf8').catch(() => undefined)
}

/** 每个工作区一份索引，进程内复用；索引文件本身由 WorkspaceIndex 落到工作区里。 */
const indexes = new Map<string, Promise<WorkspaceIndex>>()

export function completionIndexFor(cwd: string, params: CompletionParams = DEFAULT_COMPLETION_PARAMS): Promise<WorkspaceIndex> {
  const existing = indexes.get(cwd)
  if (existing !== undefined) return existing
  const created = WorkspaceIndex.open({ root: cwd, params }).then(index => {
    // 首次或过期时在后台刷新，补全请求不等它。
    void index.ensureFresh()?.catch(() => undefined)
    return index
  })
  indexes.set(cwd, created)
  return created
}

/**
 * 解析这次补全该在哪个工作区里检索。
 *
 * 优先用请求里的会话；会话号对不上（例如接口探针传的是占位值）时退到任一已知会话的工作区；
 * 都拿不到就返回 undefined，由调用方跳过检索。**不能退到进程目录**：桌面端进程的工作目录是
 * 应用自己的目录，索引它既白扫一遍，又会让检索永远命中无关内容。
 */
function safeCwd(ctx: CompletionContextLike, helpers: CompletionRouteHelpers, sessionId: string): string | undefined {
  const sessions = ctx.get('sessions') as
    | { get(id: string): { header?: { cwd?: string } } | undefined; list(): readonly { header?: { cwd?: string } }[] }
    | undefined
  const own = sessions?.get(sessionId)?.header?.cwd
  if (own !== undefined && own !== '') {
    try {
      return helpers.cwdFor(sessionId)
    } catch {
      return normalize(own)
    }
  }
  for (const session of sessions?.list() ?? []) {
    const cwd = session?.header?.cwd
    if (cwd !== undefined && cwd !== '') return normalize(cwd)
  }
  return undefined
}
