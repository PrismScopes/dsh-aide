import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dshPackage } from '../build/client-bundle.ts'
import { loadClientChunk, resetClientChunkCache } from '../src/client/chunk-loader.ts'

/**
 * 按需 chunk 的接线测试。
 *
 * 冷启动拆分依赖 DSH 客户端模块系统的 `require.async('./client.xxx.js')`：chunk 脚本以
 * `window.__ModuleLoader__.load({ id, chunk, factory })` 注册，宿主从 `lib/` 同目录提供。
 * 这里钉住三件事：
 *   1. 加载器在没有 require.async 的环境里给出可读错误、同一 chunk 只请求一次、失败可重试；
 *   2. 构建产出的 chunk 声明形状与文件名符合 loader 的约定；
 *   3. 主包不再直接 import pdf/docx 渲染栈，而是走 loadClientChunk。
 */
const read = (relative: string): string => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8')
const CHUNK_FILE = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/

/** tsdown 的 outputOptions 允许写成函数；本仓库只用对象形式，测试里按对象读取。 */
interface BundleOutput { banner?: string; intro?: string; entryFileNames?: string; codeSplitting?: boolean }
function outputOf(config: ReturnType<typeof dshPackage>[number]): BundleOutput {
  return (config.outputOptions ?? {}) as BundleOutput
}

afterEach(() => {
  resetClientChunkCache()
  delete (globalThis as { __dshRequire?: unknown }).__dshRequire
})

function installLoader(async: (specifier: string) => Promise<unknown>): void {
  (globalThis as { __dshRequire?: unknown }).__dshRequire = { async }
}

describe('client chunk loader', () => {
  it('rejects with a readable reason when the host provides no require.async', async () => {
    await expect(loadClientChunk('client.pdf.js')).rejects.toThrow(/require\.async/)
  })

  it('requests a chunk once and retries after a failure', async () => {
    const resolveOnce = vi.fn(async () => ({ pdfjs: { ok: true } }))
    installLoader(resolveOnce)
    const first = loadClientChunk<{ pdfjs: unknown }>('client.pdf.js')
    const second = loadClientChunk<{ pdfjs: unknown }>('client.pdf.js')
    expect(first).toBe(second)
    await expect(first).resolves.toEqual({ pdfjs: { ok: true } })
    expect(resolveOnce).toHaveBeenCalledTimes(1)
    expect(resolveOnce).toHaveBeenCalledWith('./client.pdf.js')

    const flaky = vi.fn()
      .mockRejectedValueOnce(new Error('chunk 404'))
      .mockResolvedValueOnce({ pdfjs: { retried: true } })
    resetClientChunkCache()
    installLoader(flaky)
    await expect(loadClientChunk('client.pdf.js')).rejects.toThrow('chunk 404')
    // 失败不缓存：下一次打开文档会重新请求。
    await expect(loadClientChunk('client.pdf.js')).resolves.toEqual({ pdfjs: { retried: true } })
    expect(flaky).toHaveBeenCalledTimes(2)
  })
})

describe('chunk build wiring', () => {
  it('emits pdf/docx chunks with the loader registration banner', () => {
    const configs = dshPackage('dsh-vscode-workbench')
    const chunks = configs.slice(2)
    expect(chunks).toHaveLength(2)
    const banners = chunks.map(config => outputOf(config).banner ?? '')
    const files = banners.map(banner => /chunk: "([^"]+)"/.exec(banner)?.[1] ?? '')
    expect(files).toEqual(['client.pdf.js', 'client.docx.js'])
    for (const [index, banner] of banners.entries()) {
      expect(banner).toBe(`window.__ModuleLoader__.load({ id: "dsh-vscode-workbench", chunk: "${files[index]}", factory: (require) => {`)
      expect(files[index]).toMatch(CHUNK_FILE)
    }
    // chunk 必须各自单入口、禁用代码分割（rolldown 不允许 false + 多入口）。
    for (const config of chunks) {
      expect(Object.keys(config.entry as Record<string, string>)).toHaveLength(1)
      expect(outputOf(config).codeSplitting).toBe(false)
    }
  })

  it('injects the loader require into the main bundle and keeps it chunk-free', () => {
    const main = dshPackage('dsh-vscode-workbench')[1]!
    expect(outputOf(main).intro ?? '').toContain('var __dshRequire = require')
    expect(outputOf(main).banner ?? '').not.toContain('chunk:')
  })

  it('moves the pdf/docx render stacks out of the main client module', () => {
    const preview = read('src/client/documentPreview.tsx')
    expect(preview).toContain("loadClientChunk<{ pdfjs: PdfJs }>('client.pdf.js')")
    expect(preview).toContain("loadClientChunk<DocxRenderer>('client.docx.js')")
    // 只允许残留 type-only 的 typeof import()（用于类型），不允许运行时动态 import。
    expect(preview).not.toMatch(/await import\('pdfjs-dist/)
    expect(preview).not.toMatch(/await import\('docx-preview'\)/)
    // 渲染栈只允许出现在各自 chunk 的入口里。
    expect(read('src/client/chunks/pdf.ts')).toContain("from 'pdfjs-dist/build/pdf.min.mjs'")
    expect(read('src/client/chunks/docx.ts')).toContain("from 'docx-preview'")
  })
})
