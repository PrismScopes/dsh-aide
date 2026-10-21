import { createRequire } from 'node:module'
import { dirname, extname, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { WorkbenchError } from './wire.ts'
import { inside } from './paths.ts'

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

/** Monaco 的构建目录：min 是运行时用的那份，dev/esm 只在 min 缺文件时兜底。 */
const MONACO_BUILDS = ['min', 'dev', 'esm'] as const

export function monacoAsset(raw: string): { path: string; type: string } {
  const packageRoot = dirname(require.resolve('monaco-editor/package.json'))
  const root = resolve(packageRoot, MONACO_BUILDS[0])
  const requested = resolve(root, raw)
  if (!inside(root, requested)) throw new WorkbenchError('asset-invalid', 'invalid Monaco asset path', 403)
  // 按序查找：min 缺文件时去 dev/esm 找（三个构建的文件集并不相同），并把结果留痕。
  let path = requested
  let found = existsSync(requested)
  if (!found) {
    for (const build of MONACO_BUILDS.slice(1)) {
      const candidate = resolve(packageRoot, build, raw)
      if (!inside(resolve(packageRoot, build), candidate)) continue
      if (existsSync(candidate)) {
        console.warn(`[dsh-completion] Monaco 资源 min 构建缺失，改用 ${build}：${raw}`)
        path = candidate
        found = true
        break
      }
    }
  }
  if (!found) {
    console.warn(`[dsh-completion] Monaco 资源在 ${MONACO_BUILDS.join("/")} 中都不存在：${raw}`)
    throw new WorkbenchError('asset-missing', `Monaco asset not found: ${raw}`, 404)
  }
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

/**
 * 读取一份 shiki 的 TextMate 语法，返回它的原始 JSON。
 *
 * 之所以要这样取：@shikijs/langs 的每个语法模块只是 `JSON.parse("…")` 的包装，
 * 而 vscode-textmate 的 loadGrammar 收的正是这个 JSON 对象。把语法留在宿主侧按需提供，
 * 客户端就不必把它们打进 bundle —— 全部语法合计约 2.5MB（cpp 一份 521KB、cpp-macro 296KB、
 * 还有 ts/js/jsx/tsx/objc-cpp/php/less/csharp/swift… 各数十至上百 KB），
 * 这是客户端体积的最大来源。
 *
 * 入参来自 URL，先经 inside() 确认没有越出包目录。
 */
export async function readGrammar(raw: string): Promise<unknown> {
  // 注意：@shikijs/langs 的 exports 不允许访问 ./package.json（会抛
  // ERR_PACKAGE_PATH_NOT_EXPORTED），所以不能像其它包那样用它定位包目录。
  // 改用主入口 —— 它就在 dist 里，取其所在目录即可。
  const root = dirname(require.resolve('@shikijs/langs'))
  const path = resolve(root, raw)
  if (!inside(root, path)) throw new WorkbenchError('asset-invalid', 'invalid grammar path', 403)
  const source = await readFile(path, 'utf8')
  const match = /JSON\.parse\("([\s\S]*)"\)/.exec(source)
  if (match === null) throw new WorkbenchError('asset-invalid', 'unexpected grammar format', 500)
  // 文件里那一段是 JSON 字符串字面量的内容，先反转义成 JSON 文本，再解析。
  return JSON.parse(JSON.parse(`"${match[1]}"`)) as unknown
}
