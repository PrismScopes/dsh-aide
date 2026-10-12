// 从 material-icon-theme（VS Code 默认文件图标主题）的官方映射表生成精简常量。
// 生成的 src/client/fileIcons.ts 只含 三张表：扩展名 → 图标名、文件名 → 图标名、图标名 → svg 文件名。
// SVG 本体不进 bundle，由宿主路由 /dsh-vscode/file-icons/<file>.svg 提供。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = path.dirname(require.resolve('material-icon-theme/package.json'))
const manifestPath = path.join(packageRoot, 'dist', 'material-icons.json')

if (!fs.existsSync(manifestPath)) {
  console.error('material-icon-theme manifest not found at ' + manifestPath)
  process.exit(1)
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

/** iconDefinitions 的 iconPath 形如 './../icons/typescript.svg'，这里只留文件名。 */
const files = {}
for (const [name, definition] of Object.entries(manifest.iconDefinitions ?? {})) {
  const matched = /([^/]+)\.svg$/.exec(String(definition.iconPath ?? ''))
  if (matched !== null) files[name] = matched[1] + '.svg'
}

const table = {
  extensions: manifest.fileExtensions ?? {},
  names: manifest.fileNames ?? {},
  files
}

const banner = [
  '// 本文件由 scripts/generate-file-icons.mjs 生成，请勿手改。',
  '// 数据取自 material-icon-theme（VS Code 默认文件图标主题）的 dist/material-icons.json。',
  '// SVG 本体不打进 bundle：由宿主路由 /dsh-vscode/file-icons/<file>.svg 提供。',
  '',
  '/** 扩展名 → 图标名 */',
  'export const ICON_BY_EXTENSION: Record<string, string> = ' + JSON.stringify(table.extensions),
  '',
  '/** 文件名（小写）→ 图标名 */',
  'export const ICON_BY_NAME: Record<string, string> = ' + JSON.stringify(table.names),
  '',
  '/** 图标名 → svg 文件名 */',
  'export const ICON_FILES: Record<string, string> = ' + JSON.stringify(table.files),
  ''
].join('\n')

const outPath = path.join(projectRoot, 'src', 'client', 'fileIcons.ts')
fs.writeFileSync(outPath, banner)
console.log(`generated ${path.relative(projectRoot, outPath)}  extensions=${Object.keys(table.extensions).length} names=${Object.keys(table.names).length} files=${Object.keys(table.files).length} bytes=${banner.length}`)
