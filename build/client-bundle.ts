import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { UserConfig } from 'tsdown'

const require = createRequire(import.meta.url)

/**
 * docx-preview 的 exports 只声明了 "."，没有通配，所以不能写成
 * alias 值 'docx-preview/dist/docx-preview.min.mjs'（会 RESOLVE_ERROR）。
 * 从主入口推出同目录下的压缩版，用绝对路径做别名。
 */
const DOCX_MIN = resolve(dirname(require.resolve('docx-preview')), 'docx-preview.min.mjs')

/**
 * docx-preview 用 jszip，但 jszip 只是它的传递依赖（pnpm 严格 node_modules 下从仓库根解析不到），
 * 所以用 docx-preview 自己的 require 去定位，再取同一包的 UMD 压缩版。
 * 拿不到就不加别名（chunk 里退回未压缩版，只影响 chunk 体积，不影响首包）。
 */
function jszipMinPath(): string | undefined {
  try {
    const jszipRoot = dirname(dirname(createRequire(DOCX_MIN).resolve('jszip')))
    const candidate = resolve(jszipRoot, 'dist', 'jszip.min.js')
    return existsSync(candidate) ? candidate : undefined
  } catch { return undefined }
}
const JSZIP_MIN = jszipMinPath()

const EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'cordis',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots',
]

/**
 * 一个「按需 chunk」。DSH 客户端模块系统支持包内动态 chunk：
 *   主 bundle 的 factory 里 `require.async('./client.pdf.js')`
 *   → loader 用同源 classic script 加载 `/plugins/<pkg>/client.pdf.js?rev=<rev>`
 *   → chunk 脚本执行 `window.__ModuleLoader__.load({ id, chunk, factory })` 注册进模块表。
 *
 * 约束（实测）：
 *   - chunk 文件名必须匹配 `client.<name>.js`，且与 client.js 同级放在 lib/ 下；
 *   - `codeSplitting:false` 不能配多入口，所以每个 chunk 是一个独立的 tsdown config；
 *   - rolldown 1.2.5 下 banner 用函数会产出 0 字节，必须用静态字符串。
 */
function clientChunk(packageName: string, fileName: string, entry: string, alias: Record<string, string> = {}): UserConfig {
  return {
    entry: { [fileName.replace(/\.js$/, '')]: entry }, outDir: './lib', format: 'cjs',
    platform: 'browser', dts: false, sourcemap: true, clean: false,
    deps: {
      neverBundle: EXTERNALS,
      alwaysBundle: (id: string) => EXTERNALS.includes(id) ? undefined : true,
    },
    alias,
    define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
    outputOptions: {
      entryFileNames: '[name].js', codeSplitting: false,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}, chunk: ${JSON.stringify(fileName)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  }
}

/** Create a DSH host bundle and dynamic browser-client bundle. */
export function dshPackage(packageName: string): UserConfig[] {
  return [
    {
      entry: { index: './src/index.ts' }, outDir: './lib', format: 'esm',
      platform: 'node', dts: false, sourcemap: true, clean: false,
      deps: { neverBundle: true }, outputOptions: { entryFileNames: '[name].js' },
    },
    {
      entry: { client: './src/client/index.tsx' }, outDir: './lib', format: 'cjs',
      platform: 'browser', dts: false, sourcemap: true, clean: false,
      deps: {
        neverBundle: EXTERNALS,
        alwaysBundle: (id: string) => EXTERNALS.includes(id) ? undefined : true,
      },
      // 几个体积大、且官方提供了压缩构建的依赖，统一指向压缩版（功能相同，纯体积收益）。
      // 它们是少数无法改走宿主路由的大依赖 —— 其它大块（TextMate 语法、文件图标、WASM、
      // KaTeX 字体与样式）都是数据，这几个是代码。
      // 注意 alias 是 tsdown 的顶层字段，写成 resolve.alias 不会生效。
      alias: {
        katex: 'katex/dist/katex.min.js',
        'docx-preview': DOCX_MIN,
      },
      define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
      outputOptions: {
        entryFileNames: 'client.js', codeSplitting: false,
        banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}, factory: (require) => {`,
        // __dshRequire 是 loader 给 factory 的 require（带 .async），chunk-loader 靠它按需加载。
        intro: 'var module = { exports: {} }; var exports = module.exports; var __dshRequire = require;',
        footer: 'return module.exports; } });',
      },
    },
    // 工作区扫描的 CPU 密集部分放到 worker：宿主事件循环不能被 TypeScript 语义检查占住。
    {
      entry: { 'scan-worker': './src/language/scan-worker.ts' },
      outDir: './lib', format: 'esm', platform: 'node', dts: false, sourcemap: true, clean: false,
      deps: { neverBundle: true },
      outputOptions: { entryFileNames: 'scan-worker.js' },
    },
    // 冷启动瘦身：PDF 与 DOCX 的渲染栈只在打开对应文件时才需要，移出首包。
    clientChunk(packageName, 'client.pdf.js', './src/client/chunks/pdf.ts'),
    clientChunk(packageName, 'client.docx.js', './src/client/chunks/docx.ts', { 'docx-preview': DOCX_MIN, ...(JSZIP_MIN === undefined ? {} : { jszip: JSZIP_MIN }) }),
  ]
}
