import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import type { UserConfig } from 'tsdown'

const require = createRequire(import.meta.url)

/**
 * docx-preview 的 exports 只声明了 "."，没有通配，所以不能写成
 * alias 值 'docx-preview/dist/docx-preview.min.mjs'（会 RESOLVE_ERROR）。
 * 从主入口推出同目录下的压缩版，用绝对路径做别名。
 */
const DOCX_MIN = resolve(dirname(require.resolve('docx-preview')), 'docx-preview.min.mjs')

const EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'cordis',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots',
]

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
        intro: 'var module = { exports: {} }; var exports = module.exports;',
        footer: 'return module.exports; } });',
      },
    },
  ]
}
