import { ICON_BY_EXTENSION, ICON_BY_NAME, ICON_FILES } from './fileIcons.ts'

export type CodiconName =  | 'add' | 'check' | 'check-all' | 'chevron-down' | 'chevron-right' | 'close' | 'close-all' | 'cloud-upload' | 'code' | 'color-mode' | 'edit'
  | 'diff' | 'diff-sidebyside' | 'diff-single' | 'discard' | 'file' | 'file-code' | 'file-media' | 'file-pdf' | 'file-zip'
  | 'files' | 'folder' | 'folder-opened' | 'git-branch' | 'git-commit' | 'graph' | 'home' | 'list-tree' | 'new-file'
  | 'layout-sidebar-right' | 'layout-sidebar-right-off' | 'new-folder' | 'preview' | 'refresh' | 'remove' | 'search' | 'settings' | 'source-control' | 'sparkle' | 'split-horizontal' | 'terminal' | 'trash'

/**
 * Render one glyph from Microsoft's VS Code Codicon font.
 * tone 用来给字形上色（资源管理器按语言着色），不传则继承当前文字颜色。
 */
export function Icon({ name, className = '', tone }: { name: CodiconName; className?: string; tone?: string }) {
  return <span aria-hidden="true" className={`codicon codicon-${name} ${className}`.trim()} style={tone === undefined ? undefined : { color: tone }}/>
}

const CODE_EXTENSIONS = new Set(['c','cc','cpp','cs','css','go','h','hpp','html','java','js','jsx','json','kt','lua','mjs','py','rb','rs','scss','sh','sql','swift','ts','tsx','vue','xml','yaml','yml'])
const MEDIA_EXTENSIONS = new Set(['avif','bmp','gif','ico','jpeg','jpg','mp3','mp4','ogg','png','svg','webm','webp','wav'])

/** Select a Codicon for a file name without depending on a file-icon theme. */
export function fileIcon(name: string): CodiconName {
  const extension = name.includes('.') ? name.split('.').at(-1)?.toLowerCase() ?? '' : ''
  if (CODE_EXTENSIONS.has(extension)) return 'file-code'
  if (MEDIA_EXTENSIONS.has(extension)) return 'file-media'
  if (extension === 'pdf') return 'file-pdf'
  if (['zip','gz','tgz','tar','7z'].includes(extension)) return 'file-zip'
  return 'file'
}

/**
 * 各语言/类型的标识色，取值参照 VS Code 里对应语言的品牌色。
 * 插件的图标字体是单色 codicon（文件类只有 file / file-code / file-media / file-pdf /
 * file-zip 五个字形，没有分语言的图形），所以按后缀区分类型只能落在颜色上。
 */
const FILE_TONES: Record<string, string> = {
  ts: '#3178c6', tsx: '#3178c6', mts: '#3178c6', cts: '#3178c6',
  js: '#e8d44d', jsx: '#e8d44d', mjs: '#e8d44d', cjs: '#e8d44d',
  py: '#3572a5', pyi: '#3572a5', rb: '#cc342d', php: '#8993be', java: '#b07219',
  go: '#00add8', rs: '#dea584', cs: '#68217a', kt: '#a97bff', kts: '#a97bff',
  swift: '#f05138', scala: '#c22d40', lua: '#5b8dd6', pl: '#0298c3', dart: '#00b4ab',
  c: '#5c6bc0', h: '#5c6bc0', cc: '#f34b7d', cpp: '#f34b7d', cxx: '#f34b7d', hpp: '#f34b7d',
  html: '#e34c26', htm: '#e34c26', vue: '#41b883', svelte: '#ff3e00',
  css: '#42a5f5', scss: '#cf649a', sass: '#cf649a', less: '#2a4d80',
  xml: '#8bc34a', svg: '#ffb13b',
  json: '#cbcb41', jsonc: '#cbcb41', json5: '#cbcb41', toml: '#9c6b4e', ini: '#7f8c8d',
  yaml: '#cb4b16', yml: '#cb4b16',
  sh: '#89e051', bash: '#89e051', zsh: '#89e051', fish: '#89e051', ps1: '#4a9edb', bat: '#c1f12e', cmd: '#c1f12e',
  sql: '#e38c00', graphql: '#e10098', gql: '#e10098',
  md: '#519aba', markdown: '#519aba', mdx: '#519aba', rst: '#4b8b9b',
  txt: '#8a9199', log: '#8a9199',
  png: '#a074c4', jpg: '#a074c4', jpeg: '#a074c4', gif: '#a074c4', bmp: '#a074c4',
  webp: '#a074c4', avif: '#a074c4', ico: '#a074c4',
  mp3: '#e0a44a', wav: '#e0a44a', ogg: '#e0a44a', flac: '#e0a44a',
  mp4: '#e05a5a', webm: '#e05a5a', mov: '#e05a5a', mkv: '#e05a5a',
  pdf: '#e05a5a',
  zip: '#c9a227', gz: '#c9a227', tgz: '#c9a227', tar: '#c9a227', '7z': '#c9a227', rar: '#c9a227', xz: '#c9a227', bz2: '#c9a227',
  exe: '#8e8e8e', dll: '#8e8e8e', so: '#8e8e8e', dylib: '#8e8e8e',
  lock: '#8a9199', patch: '#8bc34a', diff: '#8bc34a',
  woff: '#a074c4', woff2: '#a074c4', ttf: '#a074c4', otf: '#a074c4', eot: '#a074c4',
  ipynb: '#f37726', r: '#198ce7', jl: '#a270ba', nim: '#ffc200', zig: '#f7a41d',
  ex: '#6e4a7e', exs: '#6e4a7e', erl: '#b83998', hs: '#5e5086', clj: '#db5855',
  elm: '#60b5cc', fs: '#378bba', vb: '#945db7', asm: '#6e4c13', s: '#6e4c13'
}

/** 没有后缀但语义明确的文件名。 */
const FILE_NAME_TONES: Record<string, string> = {
  dockerfile: '#2496ed', '.dockerignore': '#2496ed', makefile: '#6d8086', 'cmakelists.txt': '#064f8c',
  '.gitignore': '#f14e32', '.gitattributes': '#f14e32', '.gitmodules': '#f14e32',
  '.env': '#b8c95f', license: '#d0bf41', 'cargo.toml': '#dea584', 'package.json': '#cbcb41'
}

/**
 * 按文件名给出类型标识色；无法判定时返回 undefined，调用方回落到正常文字颜色。
 * 只做颜色区分是受图标字体所限：codicon 没有分语言的图形。
 */
export function fileTone(name: string): string | undefined {
  const lower = name.toLowerCase()
  const byName = FILE_NAME_TONES[lower]
  if (byName !== undefined) return byName
  if (lower.startsWith('.env')) return FILE_NAME_TONES['.env']
  if (lower.startsWith('dockerfile')) return FILE_NAME_TONES['dockerfile']
  if (lower.startsWith('makefile')) return FILE_NAME_TONES['makefile']
  const extension = lower.includes('.') ? lower.split('.').at(-1) ?? '' : ''
  return FILE_TONES[extension]
}

/**
 * 彩色文件类型图标的 URL，数据与匹配顺序都取自 material-icon-theme（VS Code 默认的文件图标主题）：
 * 先按完整文件名匹配，再按扩展名匹配。没有匹配项时返回 undefined，调用方回落到 codicon 字形。
 * SVG 本身由宿主路由 /dsh-vscode/file-icons/ 提供，不进 bundle。
 */
export function fileIconUrl(name: string): string | undefined {
  const lower = name.toLowerCase()
  const byName = ICON_BY_NAME[lower]
  const icon = byName ?? (() => {
    const dot = lower.lastIndexOf('.')
    return dot > 0 ? ICON_BY_EXTENSION[lower.slice(dot + 1)] : undefined
  })()
  if (icon === undefined) return undefined
  const file = ICON_FILES[icon]
  return file === undefined ? undefined : `/dsh-vscode/file-icons/${file}`
}
