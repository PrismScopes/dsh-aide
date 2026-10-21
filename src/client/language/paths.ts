/**
 * 客户端侧的文件路径小工具。
 *
 * 浏览器里没有 node:path，而工作台拿到的路径来自宿主（Windows 下是 `C:\x\y`）与标签路径
 * （工作区相对、统一 `/`）。语言服务的诊断与跳转都用**绝对路径 + 0 基位置**作为协议，
 * 所以必须在两侧统一：这里只做字符串层面的归一化，不碰文件系统。
 */

/** 当前是否 Windows 平台。优先读 DSH 写在 html 上的 data-platform，浏览器测试环境回落到 navigator。 */
export function isWindowsPlatform(): boolean {
  if (typeof document !== 'undefined') {
    const platform = document.documentElement?.dataset?.['platform']
    if (platform !== undefined) return /windows|win32/i.test(platform)
  }
  if (typeof navigator !== 'undefined') return /windows|win32/i.test(navigator.platform ?? '')
  return false
}

/** 统一分隔符为 `/`（只用于比较与显示，不用于发回宿主）。 */
export function slashed(path: string): string {
  return path.replaceAll('\\', '/')
}

/** 路径比较键：Windows 大小写不敏感，其余平台保留大小写。 */
export function pathKey(path: string): string {
  const normalized = slashed(path).replace(/\/+$/, '')
  return isWindowsPlatform() ? normalized.toLowerCase() : normalized
}

/** 工作区相对路径 → 绝对路径（宿主给的工作区根可能是 `C:\x`，标签路径统一 `/`）。 */
export function absolutePathOf(root: string, relative: string): string {
  if (relative === '') return root
  const base = root.replace(/[\\/]+$/, '')
  const separator = isWindowsPlatform() ? '\\' : '/'
  if (isWindowsPlatform()) return `${base}\\${relative.replaceAll('/', '\\')}`
  return `${base}${separator}${relative.replace(/^\/+/, '')}`
}

/** 绝对路径 → 相对于指定根的路径；不在根内时返回 undefined。 */
export function workspaceRelativeOf(root: string, absolute: string): string | undefined {
  const base = slashed(root).replace(/\/+$/, '')
  const target = slashed(absolute)
  const compares = isWindowsPlatform()
  const left = compares ? base.toLowerCase() : base
  const right = compares ? target.toLowerCase() : target
  if (right === left) return ''
  if (!right.startsWith(`${left}/`)) return undefined
  return target.slice(base.length + 1)
}

/** 路径最后一段。 */
export function baseName(path: string): string {
  const parts = slashed(path).split('/').filter(part => part !== '')
  return parts.at(-1) ?? path
}

/** 路径的父目录（工作区相对路径）；根目录返回空串。 */
export function parentPath(path: string): string {
  const parts = slashed(path).split('/').filter(part => part !== '')
  return parts.slice(0, -1).join('/')
}

/** 两个绝对路径是否指向同一实体（Windows 大小写不敏感）。 */
export function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right)
}
