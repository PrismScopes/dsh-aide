/**
 * 按需加载包内客户端 chunk。
 *
 * DSH 客户端模块系统的 factory 参数 `require` 带一个 `.async(specifier)`：它会用同源
 * classic script 加载 `./client.<name>.js`（宿主 `/plugins/<pkg>/...` 路由，Web 与桌面同一条路），
 * 再把 chunk 的 `window.__ModuleLoader__.load({ id, chunk, factory })` 结果 materialize 成模块。
 *
 * `__dshRequire` 由 build/client-bundle.ts 的 intro 在主 bundle 里注入（`var __dshRequire = require`）。
 * 单测里没有 loader，可以往 `globalThis.__dshRequire` 放一个假的；两者都没有时给出可读错误。
 */
export interface ClientChunkLoader {
  async<T = unknown>(specifier: string): Promise<T>
}

declare const __dshRequire: ClientChunkLoader | undefined

const cache = new Map<string, Promise<unknown>>()

function loader(): ClientChunkLoader | undefined {
  // typeof 一个未声明变量是安全的：没有注入时就是 'undefined'。
  const injected = typeof __dshRequire === 'undefined' ? undefined : __dshRequire
  if (injected !== undefined && typeof injected.async === 'function') return injected
  const global = (globalThis as { __dshRequire?: ClientChunkLoader }).__dshRequire
  return global !== undefined && typeof global.async === 'function' ? global : undefined
}

/**
 * 加载一个 chunk 并返回它的导出对象。
 *
 * 同一个 chunk 的 Promise 会被 memoize：并发/重复打开文档只发一次请求。
 * 失败时清掉缓存，下一次打开可以重试。
 */
export function loadClientChunk<T>(fileName: string): Promise<T> {
  const active = loader()
  if (active === undefined) return Promise.reject(new Error('当前 DSH 版本不支持按需加载客户端模块（require.async）'))
  const specifier = `./${fileName}`
  const existing = cache.get(specifier) as Promise<T> | undefined
  if (existing !== undefined) return existing
  const promise = active.async<T>(specifier).catch((error: unknown) => {
    cache.delete(specifier)
    throw error
  })
  cache.set(specifier, promise as Promise<unknown>)
  return promise
}

/** 仅供测试：清掉 memoize 的 chunk Promise。 */
export function resetClientChunkCache(): void { cache.clear() }
