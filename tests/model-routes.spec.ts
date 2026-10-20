import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { HostContext } from '../src/context.ts'
import { collectDshModelRoutes, registerModelRoutes } from '../src/modelRoutes.ts'
import { listDshModelRoutes } from '../src/client/dshModels.ts'

/** 最小的假 ctx：只按服务名返回内容，不启动宿主。 */
function fakeCtx(services: Record<string, unknown>): { get(name: string): unknown } {
  return { get: name => services[name] }
}

describe('collectDshModelRoutes', () => {
  it('collects every provider catalog in registration order and reports the default model', async () => {
    const asked: string[] = []
    const ctx = fakeCtx({
      llm: {
        listProviders: () => [{ id: 'a' }, { id: 'b' }],
        listModels: async (provider: string) => {
          asked.push(provider)
          return provider === 'a' ? [{ provider: 'a', id: 'm1' }] : [{ provider: 'b', id: 'm2' }]
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'a', model: 'm1', reasoningEffort: 'high' }) },
    })

    expect(await collectDshModelRoutes(ctx)).toEqual({
      default: 'a/m1',
      routes: [
        { route: 'a/m1', provider: 'a', model: 'm1', label: 'm1' },
        { route: 'b/m2', provider: 'b', model: 'm2', label: 'm2' },
      ],
    })
    // 每个 provider 都问过，且按注册顺序问。
    expect(asked).toEqual(['a', 'b'])
  })

  it('keeps the providers that answer when another one throws', async () => {
    // 个别适配器不支持发现会直接抛错：不能让它把整份目录清空。
    const ctx = fakeCtx({
      llm: {
        listProviders: () => ['broken', 'fine'],
        listModels: (provider: string) => {
          if (provider === 'broken') throw new Error('discovery unsupported')
          return [{ id: 'm2' }]
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'broken', model: 'm0' }) },
    })

    const result = await collectDshModelRoutes(ctx)
    expect(result.routes).toEqual([{ route: 'fine/m2', provider: 'fine', model: 'm2', label: 'm2' }])
    // 默认模型与服务可用性无关：补全实际会用的那条路照样报出来。
    expect(result.default).toBe('broken/m0')
  })

  it('does not let a hung catalog hold the whole list', async () => {
    // 某个端点卡住时设置页不能一直转圈：超时按「这一路没有目录」处理。
    const ctx = fakeCtx({
      llm: {
        listProviders: () => ['hung', 'fine'],
        listModels: (provider: string) => provider === 'hung'
          ? new Promise(() => undefined)
          : Promise.resolve([{ id: 'm1' }]),
      },
    })

    const started = Date.now()
    const result = await collectDshModelRoutes(ctx, { timeoutMs: 20 })
    expect(result.routes.map(route => route.route)).toEqual(['fine/m1'])
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('degrades to an empty catalog when the DSH services are missing', async () => {
    // 其它部署/组合里两个服务都可能不存在：这是正常情况，不是异常。
    expect(await collectDshModelRoutes(fakeCtx({}))).toEqual({ default: null, routes: [] })
    expect(await collectDshModelRoutes({ get: () => undefined })).toEqual({ default: null, routes: [] })
  })

  it('treats a provider listing failure as an empty catalog instead of throwing', async () => {
    const ctx = fakeCtx({
      llm: { listProviders: () => { throw new Error('boom') }, listModels: () => [] },
    })
    expect(await collectDshModelRoutes(ctx)).toEqual({ default: null, routes: [] })
  })

  it('dedupes identical routes and truncates to the limit', async () => {
    const ctx = fakeCtx({
      llm: {
        listProviders: () => [{ id: 'a' }],
        listModels: () => [{ id: 'm1' }, { id: 'm1' }, { provider: 'a', id: 'm2' }, { id: 'm3' }],
      },
    })

    expect((await collectDshModelRoutes(ctx)).routes.map(route => route.route)).toEqual(['a/m1', 'a/m2', 'a/m3'])
    expect((await collectDshModelRoutes(ctx, { limit: 2 })).routes.map(route => route.route)).toEqual(['a/m1', 'a/m2'])
    expect(await collectDshModelRoutes(ctx, { limit: 0 })).toEqual({ default: null, routes: [] })
  })

  it('prefers a display name and falls back to the model id', async () => {
    const ctx = fakeCtx({
      llm: {
        listProviders: () => ['a'],
        listModels: () => [
          { id: 'm1', displayName: 'Model One' },
          { id: 'm2', name: 'Model Two' },
          { id: 'm3' },
        ],
      },
    })

    expect((await collectDshModelRoutes(ctx)).routes.map(route => route.label)).toEqual(['Model One', 'Model Two', 'm3'])
  })

  it('reports no default when the default-model service fails, but keeps the catalog', async () => {
    const ctx = fakeCtx({
      llm: { listProviders: () => ['a'], listModels: () => [{ id: 'm1' }] },
      agentDefaultModel: { currentSelection: () => { throw new Error('not ready') } },
    })

    expect(await collectDshModelRoutes(ctx)).toEqual({
      default: null,
      routes: [{ route: 'a/m1', provider: 'a', model: 'm1', label: 'm1' }],
    })
  })
})

/** 收起路由登记测试里重复的桩：只记录登记了什么、回了什么。 */
interface RegisteredRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
}

function routeHarness(services: Record<string, unknown>, authorize = true): {
  registered: RegisteredRoute[]
  sent: Array<{ status: number; payload: unknown }>
  dispatch(method: string, route?: RegisteredRoute): Promise<void>
} {
  const registered: RegisteredRoute[] = []
  const sent: Array<{ status: number; payload: unknown }> = []
  const ctx = {
    get: (name: string) => services[name],
    webServer: {
      register: (route: RegisteredRoute) => { registered.push(route); return () => undefined },
      registerUpgrade: () => () => undefined,
    },
  } as unknown as HostContext

  registerModelRoutes(ctx, {
    authorize: () => authorize,
    send: (_res, status, payload) => { sent.push({ status, payload }) },
    sendError: (_res, error) => { sent.push({ status: 500, payload: error }) },
    // 不建真宿主：收到挂载器就直接执行，拿到注册出来的路由。
    effect: run => { run() },
  })

  return {
    registered,
    sent,
    async dispatch(method, route = registered[0]) {
      const target = route
      if (target === undefined) throw new Error('no route registered')
      await target.handler({ method } as IncomingMessage, {} as ServerResponse)
    },
  }
}

describe('model routes endpoint', () => {
  it('registers GET /dsh-vscode/model-routes and answers with the host envelope', async () => {
    const { registered, sent, dispatch } = routeHarness({
      llm: { listProviders: () => ['a'], listModels: () => [{ id: 'm1' }] },
      agentDefaultModel: { currentSelection: () => ({ provider: 'a', model: 'm1' }) },
    })

    expect(registered.map(route => [route.kind, route.path])).toEqual([['exact', '/dsh-vscode/model-routes']])
    await dispatch('GET')
    expect(sent).toEqual([{
      status: 200,
      payload: {
        ok: true,
        value: {
          default: 'a/m1',
          routes: [{ route: 'a/m1', provider: 'a', model: 'm1', label: 'm1' }],
        },
      },
    }])
  })

  it('rejects non-GET methods with 405', async () => {
    const { sent, dispatch } = routeHarness({})
    await dispatch('POST')
    expect(sent).toEqual([{ status: 405, payload: { ok: false, error: { code: 'method', message: 'GET required' } } }])
  })

  it('does not answer when the connection is not authorized', async () => {
    const { sent, dispatch } = routeHarness({ llm: { listProviders: () => [], listModels: () => [] } }, false)
    await dispatch('GET')
    expect(sent).toEqual([])
  })

  it('falls back to the host context lifecycle when the wiring passes no effect helper', () => {
    const registered: RegisteredRoute[] = []
    const lifecycle: string[] = []
    const ctx = {
      get: () => undefined,
      webServer: {
        register: (route: RegisteredRoute) => { registered.push(route); return () => undefined },
        registerUpgrade: () => () => undefined,
      },
      effect: (run: () => void | (() => void), label?: string) => { lifecycle.push(label ?? ''); run() },
    } as unknown as HostContext

    registerModelRoutes(ctx, { authorize: () => true, send: () => undefined, sendError: () => undefined })

    // routes.ts 只传 authorize/send/sendError 时也必须真的挂到宿主生命周期上，否则插件一卸载端点就没了。
    expect(lifecycle).toEqual([expect.stringContaining('model routes')])
    expect(registered.map(route => route.path)).toEqual(['/dsh-vscode/model-routes'])
  })
})

describe('client model routes', () => {
  function stubFetch(impl: () => Promise<Response>): void {
    vi.stubGlobal('fetch', vi.fn(impl))
  }

  it('reads the host envelope and keeps the route fields', async () => {
    stubFetch(async () => new Response(JSON.stringify({
      ok: true,
      value: {
        default: 'a/m1',
        routes: [
          { route: 'a/m1', provider: 'a', model: 'm1', label: 'Model One' },
          { route: 'b/m2', provider: 'b', model: 'm2' },
          { route: 'c/m3', model: 'm3' },
        ],
      },
    }), { status: 200 }))
    try {
      const result = await listDshModelRoutes()
      expect(result.default).toBe('a/m1')
      // label 缺失时回落到模型 id；坏条目（缺 provider）被丢掉而不是整份列表作废。
      expect(result.routes).toEqual([
        { route: 'a/m1', provider: 'a', model: 'm1', label: 'Model One' },
        { route: 'b/m2', provider: 'b', model: 'm2', label: 'm2' },
      ])
      expect(fetch).toHaveBeenCalledWith('/dsh-vscode/model-routes', { cache: 'no-store' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('never throws when the host is unreachable, old, or answers with garbage', async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => { throw new Error('offline') },
      async () => new Response('not found', { status: 404 }),
      async () => new Response('<!doctype html><html></html>', { status: 200 }),
      async () => new Response(JSON.stringify({ ok: false, error: { code: 'nope' } }), { status: 200 }),
      async () => new Response(JSON.stringify({ ok: true, value: { default: 42, routes: 'nope' } }), { status: 200 }),
    ]
    for (const impl of cases) {
      stubFetch(impl)
      try {
        await expect(listDshModelRoutes()).resolves.toEqual({ default: null, routes: [] })
      } finally {
        vi.unstubAllGlobals()
      }
    }
  })

  it('forwards the cancellation signal', async () => {
    const controller = new AbortController()
    stubFetch(async () => new Response(JSON.stringify({ ok: true, value: { default: null, routes: [] } }), { status: 200 }))
    try {
      await listDshModelRoutes(controller.signal)
      expect(fetch).toHaveBeenCalledWith('/dsh-vscode/model-routes', { cache: 'no-store', signal: controller.signal })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
