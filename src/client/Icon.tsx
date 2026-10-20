import { ICON_BY_EXTENSION, ICON_BY_NAME, ICON_FILES } from './fileIcons.ts'

export type CodiconName =  | 'add' | 'check' | 'chevron-down' | 'chevron-right' | 'close' | 'close-all' | 'cloud-upload' | 'code'
  | 'diff' | 'diff-sidebyside' | 'diff-single' | 'discard' | 'file' | 'file-code' | 'file-media' | 'file-pdf' | 'file-zip'
  | 'files' | 'folder' | 'folder-opened' | 'git-branch' | 'home' | 'list-tree' | 'new-file'
  | 'layout-sidebar-right' | 'layout-sidebar-right-off' | 'new-folder' | 'preview' | 'refresh' | 'remove' | 'search' | 'settings' | 'source-control' | 'split-horizontal' | 'terminal' | 'trash'

/** Render one glyph from Microsoft's VS Code Codicon font. */
export function Icon({ name, className = '' }: { name: CodiconName; className?: string }) {
  return <span aria-hidden="true" className={`codicon codicon-${name} ${className}`.trim()}/>
}

const CODE_EXTENSIONS = new Set(['c','cc','cpp','cs','css','go','h','hpp','html','java','js','jsx','json','kt','lua','mjs','py','rb','rs','scss','sh','sql','swift','ts','tsx','vue','xml','yaml','yml'])
const MEDIA_EXTENSIONS = new Set(['avif','bmp','gif','ico','jpeg','jpg','mp3','mp4','ogg','png','svg','webm','webp','wav'])

/**
 * material-icon-theme 没有对应图标时的回退字形（比如新建的、尚未收录的后缀）。
 * 只有 file / file-code / file-media / file-pdf / file-zip 这五个文件类字形可用。
 */
export function fileIcon(name: string): CodiconName {
  const extension = name.includes('.') ? name.split('.').at(-1)?.toLowerCase() ?? '' : ''
  if (CODE_EXTENSIONS.has(extension)) return 'file-code'
  if (MEDIA_EXTENSIONS.has(extension)) return 'file-media'
  if (extension === 'pdf') return 'file-pdf'
  if (['zip','gz','tgz','tar','7z'].includes(extension)) return 'file-zip'
  return 'file'
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
