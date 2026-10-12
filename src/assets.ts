import { createRequire } from 'node:module'
import { dirname, extname, resolve } from 'node:path'
import { WorkbenchError } from './wire.ts'
import { inside } from './host.ts'

const require = createRequire(import.meta.url)

/**
 * 静态资源的解析：把这些第三方包里的文件按受限路径取出来交给路由层提供。
 * 从 host.ts 拆出 —— 这一组只依赖包路径与路径包含判断，与工作区的文件系统操作无关。
 * 形如 (raw: string) 的入参来自 URL，都要经 inside() 确认没有越出包目录。
 */
/** Resolve the official VS Code Codicon font shipped by @vscode/codicons. */
export function codiconAsset(): { path: string; type: string } {
  const packageRoot = dirname(require.resolve('@vscode/codicons/package.json'))
  return { path: resolve(packageRoot, 'dist', 'codicon.ttf'), type: 'font/ttf' }
}

export function monacoAsset(raw: string): { path: string; type: string } {
  const packageRoot = dirname(require.resolve('monaco-editor/package.json'))
  const path = resolve(packageRoot, 'min', raw)
  const root = resolve(packageRoot, 'min')
  if (!inside(root, path)) throw new WorkbenchError('asset-invalid', 'invalid Monaco asset path', 403)
  const type = extname(path) === '.css' ? 'text/css' : extname(path) === '.js' ? 'text/javascript' : extname(path) === '.ttf' ? 'font/ttf' : 'application/octet-stream'
  return { path, type }
}

/**
 * Resolve vscode-oniguruma's WASM binary —— TextMate 语法背后的正则引擎。
 * 走 HTTP 提供，客户端用 fetch + WebAssembly 加载。
 */
export function onigWasmAsset(): { path: string; type: string } {
  const packageRoot = dirname(require.resolve('vscode-oniguruma/package.json'))
  return { path: resolve(packageRoot, 'release', 'onig.wasm'), type: 'application/wasm' }
}

/**
 * Resolve one file-type icon from material-icon-theme (the theme VS Code ships by default).
 * The explorer renders these as <img>, so only the SVG files are served; the name→file mapping
 * lives in the client bundle (see scripts/generate-file-icons.mjs).
 */
export function fileIconAsset(raw: string): { path: string; type: string } {
  const packageRoot = dirname(require.resolve('material-icon-theme/package.json'))
  const path = resolve(packageRoot, 'icons', raw)
  const root = resolve(packageRoot, 'icons')
  if (!inside(root, path)) throw new WorkbenchError('asset-invalid', 'invalid file icon path', 403)
  return { path, type: extname(path) === '.svg' ? 'image/svg+xml' : 'application/octet-stream' }
}

/**
 * Resolve KaTeX's stylesheet and web fonts. katex.min.css references its fonts with the
 * relative url "fonts/…", so the stylesheet and the font directory must be served under one
 * prefix for the browser to resolve them.
 */
export function katexAsset(raw: string): { path: string; type: string } {
  const packageRoot = dirname(require.resolve('katex/package.json'))
  const path = resolve(packageRoot, 'dist', raw)
  const root = resolve(packageRoot, 'dist')
  if (!inside(root, path)) throw new WorkbenchError('asset-invalid', 'invalid KaTeX asset path', 403)
  const extension = extname(path)
  const type = extension === '.css' ? 'text/css'
    : extension === '.woff2' ? 'font/woff2'
      : extension === '.woff' ? 'font/woff'
        : extension === '.ttf' ? 'font/ttf'
          : 'application/octet-stream'
  return { path, type }
}
