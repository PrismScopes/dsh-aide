import type { UserConfig } from 'tsdown'

const EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'cordis',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-runtime/client',
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
      // KaTeX 经 marked-katex-extension 间接引入，默认走包里的 katex.mjs（589KB）。
      // 换成官方压缩版（266KB），功能相同、纯体积收益。它是少数无法改走宿主路由的大依赖
      // —— 其它大块（TextMate 语法、文件图标、WASM、KaTeX 字体与样式）都是数据，这个是代码。
      // 注意 alias 是 tsdown 的顶层字段，写成 resolve.alias 不会生效。
      alias: { katex: 'katex/dist/katex.min.js' },
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
