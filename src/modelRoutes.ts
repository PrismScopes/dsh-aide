/**
 * DSH 模型目录：把宿主当前可用的 provider / model 暴露给设置页。
 *
 * 设置页原先只能手填 `provider/model`，写错只有等到真正补全失败才知道。这里从 DSH 的
 * `llm` 服务读出各 provider 公布的模型目录，连同 `agentDefaultModel` 的当前选择一起返回，
 * 设置页就能给出下拉候选并标出「跟随默认模型」用的是哪条。
 *
 * 三个硬约束（设置页是宿主 API 的旁路，不能因为它把页面拖垮）：
 * - 任何一步失败都只影响它自己：某个 provider 不支持发现、抛错、或卡住，别的 provider 照常返回；
 * - 每次模型发现都有超时，某个适配器卡住不会让设置页一直转圈；
 * - 整体永不抛错，最坏退化成空列表。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HostContext } from './context.ts'

export interface DshModelRoute { route: string; provider: string; model: string; label: string }
export interface DshModelRoutes { default: string | null; routes: DshModelRoute[] }

/**
 * `ctx.get('llm')` 里本模块用到的部分。
 *
 * 只声明用到的字段：插件与宿主是两套独立的依赖，宿主接口一旦变动，typecheck 会在这里报错，
 * 而不是在设置页上静默变成空下拉。运行时仍然逐个判断方法是否存在 —— 不同的 DSH 组合与
 * 适配器能力不同，缺方法不该等于报错。
 */
interface DshLlmCatalog {
  listProviders(): unknown[] | Promise<unknown[]>
  listModels(provider: string): unknown[] | Promise<unknown[]>
}

/** `ctx.get('agentDefaultModel')` 里本模块用到的部分。 */
interface DshDefaultModelCatalog {
  currentSelection(): unknown
}

interface CollectModelRoutesOptions {
  /** 每次 listModels 的超时，默认 1500ms。 */
  timeoutMs?: number
  /** 返回的路由条数上限，默认 200 条。 */
  limit?: number
}

/** 端点所需的最小宿主能力：只用来登记一条路由，便于测试时替换。 */
interface ModelRouteHelpers {
  /** 复用宿主 connection 服务的认证结果；返回 false 时已经写好 401/403 响应。 */
  authorize(req: IncomingMessage, res: ServerResponse): boolean
  send(res: ServerResponse, status: number, payload: unknown): void
  sendError(res: ServerResponse, error: unknown): void
  /** 挂到宿主生命周期上的注册器；不传时退回 ctx.effect。 */
  effect?(fn: () => void, label?: string): void
}

const DEFAULT_TIMEOUT_MS = 1500
const DEFAULT_LIMIT = 200
const ROUTE_LABEL = 'dsh-aide: model routes'

/**
 * 收集 DSH 可用的 provider/model 路由；永不抛错，失败的那一路记为缺失。
 *
 * 顺序即 provider 的注册顺序 + 适配器公布模型时的顺序：设置页照这个顺序展示，用户看到的
 * 「第一项」与 DSH 自己的偏好顺序一致。
 */
export async function collectDshModelRoutes(ctx: { get(name: string): unknown }, options: CollectModelRoutesOptions = {}): Promise<DshModelRoutes> {
  const timeoutMs = normalizedTimeout(options.timeoutMs)
  const limit = normalizedLimit(options.limit)
  try {
    const defaultRoute = defaultRouteOf(ctx)
    const llm = safeGet(ctx, 'llm') as DshLlmCatalog | undefined
    // 没有模型服务（其它部署、或插件被单独装载）不是错误：设置页照样能打开，只是拿不到候选。
    if (llm === null || llm === undefined || typeof llm.listProviders !== 'function') return { default: defaultRoute, routes: [] }
    const providers = await readProviders(llm)
    // 并行发现：每个 provider 各有自己的超时，最慢的那一路最多等一个 timeoutMs，而不是累加。
    const catalogs = await Promise.all(providers.map(provider => readModels(llm, provider, timeoutMs)))
    return { default: defaultRoute, routes: mergeRoutes(providers, catalogs, limit) }
  } catch {
    // 每一步都已单独兜住，正常走不到这里；万一宿主内部结构异常，也不能让设置页白屏。
    return { default: null, routes: [] }
  }
}

/**
 * 注册 `GET /dsh-vscode/model-routes`（会话无关，只需连接认证）。
 *
 * 不并进 `/dsh-vscode/api` 的原因与设置页端点相同：`/api` 先解析会话工作目录，还没选会话时一律 409，
 * 而模型下拉在这之前就要能用。
 */
export function registerModelRoutes(ctx: HostContext, helpers: ModelRouteHelpers): void {
  const mount = (): (() => void) => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-vscode/model-routes',
    handler: async (req, res) => {
      if (!helpers.authorize(req, res)) return
      if (req.method !== 'GET') return helpers.send(res, 405, { ok: false, error: { code: 'method', message: 'GET required' } })
      try {
        helpers.send(res, 200, { ok: true, value: await collectDshModelRoutes(ctx) })
      } catch (error) { helpers.sendError(res, error) }
    },
  })
  // 由 routes.ts 传入挂载器时复用它（测试里也能不建真宿主就登记路由），否则用 ctx 自带的。
  if (helpers.effect !== undefined) helpers.effect(mount, ROUTE_LABEL)
  else ctx.effect(mount, ROUTE_LABEL)
}

/** 读当前默认模型；服务缺失或选择不可用时为 null（列表本身仍然可用）。 */
function defaultRouteOf(ctx: { get(name: string): unknown }): string | null {
  try {
    const service = safeGet(ctx, 'agentDefaultModel') as Partial<DshDefaultModelCatalog> | undefined
    if (service === null || service === undefined || typeof service.currentSelection !== 'function') return null
    const selection = service.currentSelection()
    if (!isRecord(selection)) return null
    const provider = stringField(selection, 'provider')
    const model = stringField(selection, 'model')
    return provider === undefined || model === undefined ? null : `${provider}/${model}`
  } catch {
    return null
  }
}

/** provider 列表：按注册顺序取 id，去重后保留原始顺序。 */
async function readProviders(llm: DshLlmCatalog): Promise<string[]> {
  try {
    const listed = await Promise.resolve(llm.listProviders())
    if (!Array.isArray(listed)) return []
    const providers: string[] = []
    const seen = new Set<string>()
    for (const entry of listed) {
      const id = providerIdOf(entry)
      if (id === undefined || seen.has(id)) continue
      seen.add(id)
      providers.push(id)
    }
    return providers
  } catch {
    return []
  }
}

/**
 * 读一个 provider 的模型目录。
 *
 * 不支持发现（没有 listModels、或直接抛错）、超时，都按「这一路没有目录」处理：别的 provider 不受影响。
 */
async function readModels(llm: DshLlmCatalog, provider: string, timeoutMs: number): Promise<unknown[]> {
  if (typeof llm.listModels !== 'function') return []
  try {
    const listed = await withTimeout(() => llm.listModels(provider), timeoutMs)
    return Array.isArray(listed) ? listed : []
  } catch {
    return []
  }
}

/** 合并成 `provider/model` 路由：按 provider 顺序、模型顺序，去重并截断到上限。 */
function mergeRoutes(providers: string[], catalogs: unknown[][], limit: number): DshModelRoute[] {
  const routes: DshModelRoute[] = []
  const seen = new Set<string>()
  for (let index = 0; index < providers.length && routes.length < limit; index++) {
    const provider = providers[index]
    if (provider === undefined) continue
    for (const listed of catalogs[index] ?? []) {
      const entry = modelEntryOf(listed)
      if (entry === undefined) continue
      const route = `${provider}/${entry.id}`
      if (seen.has(route)) continue
      seen.add(route)
      routes.push({ route, provider, model: entry.id, label: entry.label })
      if (routes.length >= limit) break
    }
  }
  return routes
}

/**
 * 给一次模型发现加超时。
 *
 * 不用 AbortSignal：`listModels` 的契约里没有 signal 参数，传不进去；这里按「结果与超时赛跑」
 * 实现，谁先到算谁。迟到的那一方（例如超时后才返回或抛错的适配器）直接丢弃，不会变成
 * unhandled rejection，也不会改变已经返回的列表。
 */
function withTimeout<T>(run: () => Promise<T> | T, timeoutMs: number): Promise<T | undefined> {
  return new Promise<T | undefined>(resolve => {
    let settled = false
    // 超时与结果谁先到都只认第一个：另一个随后到达时直接丢弃。
    const finish = (value: T | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    // 两参 then：原 Promise 迟到的失败被这里接住，不会变成 unhandled rejection。
    Promise.resolve().then(run).then(value => finish(value), () => finish(undefined))
    const timer = setTimeout(() => finish(undefined), timeoutMs)
  })
}

/** provider 条目可能是 `{ id }`，也可能是裸 id；两种都认。 */
function providerIdOf(entry: unknown): string | undefined {
  if (typeof entry === 'string') return stringValue(entry)
  if (!isRecord(entry)) return undefined
  return stringField(entry, 'id')
}

/** 模型条目可能是 `{ id, displayName? }`，也可能只是裸模型名。 */
function modelEntryOf(entry: unknown): { id: string; label: string } | undefined {
  if (typeof entry === 'string') {
    const id = stringValue(entry)
    return id === undefined ? undefined : { id, label: id }
  }
  if (!isRecord(entry)) return undefined
  // 基类实现公布的是 `id`；个别适配器把模型名放在 `model` 里，也一并接受。
  const id = stringField(entry, 'id') ?? stringField(entry, 'model')
  if (id === undefined) return undefined
  const label = stringField(entry, 'displayName') ?? stringField(entry, 'name') ?? id
  return { id, label: label.trim() }
}

/** 服务缺失时 ctx.get 可能抛错（组合未加载），这里统一按要求「没有这个服务」处理。 */
function safeGet(ctx: { get(name: string): unknown }, name: string): unknown {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

function normalizedTimeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS
}

function normalizedLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT
  return Math.max(0, Math.floor(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 非空字符串才认：空白 id / 标签按缺失处理，避免生成 `provider/` 这种路由。 */
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return stringValue(record[key])
}
