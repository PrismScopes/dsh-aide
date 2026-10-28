/**
 * 问题面板的视图模型（纯函数）。
 *
 * 为什么把「过滤之后长什么样」单独拆出来：诊断可能上千条，面板必须虚拟化 —— 也就是「只渲染可视区
 * 的行」，而虚拟化需要一个和 React 无关的行模型（行高、行偏移、可视窗口）。把这些算法留在组件里，
 * 就只能靠真实浏览器去做集成测试；拆成纯函数后，分组/平铺、当前文件过滤、多行行高、滚动窗口与键盘
 * 导航都能用普通单测钉住。
 *
 * 坐标：这里的行下标是「展开后的行列表」下标（0 基）。文件头行也算一行 —— 键盘上下要能走到它，
 * 左右键要靠它展开/收起，虚拟化也要把它的 26px 算进去。
 */
import { severityRank } from '../language/protocol.ts'
import type { LanguagePosition } from '../language/protocol.ts'
import { isWindowsPlatform, slashed } from './language/paths.ts'
import type { ProblemEntry, ProblemGroup } from './ProblemsPanel.tsx'

/** 视图模式：按文件分组，或把所有问题平铺成一张列表。 */
export type ProblemViewMode = 'grouped' | 'flat'

/** 固定行高（虚拟化按它算偏移，不测量 DOM）：文件头 26、单行 24、多行 42。 */
export const FILE_ROW_HEIGHT = 26
export const PROBLEM_ROW_HEIGHT = 24
export const PROBLEM_MULTILINE_ROW_HEIGHT = 42

/** 首帧 / 面板还没量到高度时按一屏的量渲染，避免 SSR 与隐藏状态下整块空白。 */
export const FALLBACK_VIEWPORT_HEIGHT = 420

/** 可视窗口上下多渲染几行，滚动时不容易看到空白。 */
export const VIRTUAL_OVERSCAN = 4

/** 分组模式下的文件头行。 */
export interface ProblemFileRow {
  kind: 'file'
  /** 稳定键：折叠状态、高亮、滚动锚点都靠它。 */
  key: string
  path: string
  relativePath: string
  name: string
  directory: string
  errors: number
  warnings: number
  expanded: boolean
  height: number
}

/** 一条诊断行。 */
export interface ProblemItemRow {
  kind: 'problem'
  key: string
  /** 所属文件（收起该文件时高亮要回落到文件头行）。 */
  filePath: string
  entry: ProblemEntry
  height: number
}

export type ProblemRow = ProblemFileRow | ProblemItemRow

export interface BuildRowsOptions {
  mode: ProblemViewMode
  /** 折叠的文件（绝对路径集合）；默认全部展开。 */
  collapsed?: ReadonlySet<string>
  /** 多行显示模式：诊断行加高到 42px 并显示多行内容。 */
  multiLine?: boolean
}

/** 文件头行的键；与问题行的键不会冲突（前缀不同）。 */
export function fileRowKey(path: string): string {
  return `file\u0000${path}`
}

/** 一条诊断的稳定键：同一文件同一位置同一消息算同一行。 */
export function problemRowKey(entry: ProblemEntry): string {
  const start = entry.diagnostic.range.start
  return `problem\u0000${entry.path}\u0000${start.line}\u0000${start.character}\u0000${entry.diagnostic.message}`
}

/** 平铺模式的排序：严重度 → 路径 → 行列 → 消息（最后一项只为稳定）。 */
export function sortFlatEntries(entries: readonly ProblemEntry[]): ProblemEntry[] {
  return [...entries].sort((left, right) => {
    const bySeverity = severityRank(left.diagnostic.severity) - severityRank(right.diagnostic.severity)
    if (bySeverity !== 0) return bySeverity
    const byPath = left.relativePath.localeCompare(right.relativePath) || left.path.localeCompare(right.path)
    if (byPath !== 0) return byPath
    const a = left.diagnostic.range.start
    const b = right.diagnostic.range.start
    if (a.line !== b.line) return a.line - b.line
    if (a.character !== b.character) return a.character - b.character
    return left.diagnostic.message.localeCompare(right.diagnostic.message)
  })
}

/**
 * 把「分组结果 + 过滤后的条目」展开成一行行。
 *
 * 分组模式用 `groups`（组内已排好序），平铺模式直接用 `entries` 重排（不沿用分组顺序：平铺的语义是
 * 全局按严重度排，而不是先按文件）。折叠只影响分组模式。
 */
export function buildProblemRows(
  groups: readonly ProblemGroup[],
  entries: readonly ProblemEntry[],
  options: BuildRowsOptions,
): ProblemRow[] {
  const itemHeight = options.multiLine === true ? PROBLEM_MULTILINE_ROW_HEIGHT : PROBLEM_ROW_HEIGHT
  const rows: ProblemRow[] = []
  if (options.mode === 'flat') {
    for (const entry of sortFlatEntries(entries)) {
      rows.push({ kind: 'problem', key: problemRowKey(entry), filePath: entry.path, entry, height: itemHeight })
    }
    return rows
  }
  const collapsed = options.collapsed ?? new Set<string>()
  for (const group of groups) {
    const expanded = !collapsed.has(group.path)
    rows.push({
      kind: 'file',
      key: fileRowKey(group.path),
      path: group.path,
      relativePath: group.relativePath,
      name: group.name,
      directory: group.directory,
      errors: group.errors,
      warnings: group.warnings,
      expanded,
      height: FILE_ROW_HEIGHT,
    })
    if (!expanded) continue
    for (const entry of group.items) {
      rows.push({ kind: 'problem', key: problemRowKey(entry), filePath: entry.path, entry, height: itemHeight })
    }
  }
  return rows
}

/** 工作区相对路径归一化（统一 `/`、去掉 `./` 与前导 `/`；Windows 大小写不敏感）。 */
function normalizeRelativePath(value: string): string {
  const normalized = slashed(value).replace(/^(?:\.\/|\/)+/, '').replace(/\/+$/, '')
  return isWindowsPlatform() ? normalized.toLowerCase() : normalized
}

/** 绝对路径归一化（当前文件可能是外部文件，标签里放的是绝对路径）。 */
function normalizeAbsolutePath(value: string): string {
  const normalized = slashed(value).replace(/\/+$/, '')
  return isWindowsPlatform() ? normalized.toLowerCase() : normalized
}

/** 像绝对路径吗（`/x` 或 `C:/x` / `C:\x`）。 */
function looksAbsolute(value: string): boolean {
  const normalized = slashed(value)
  return normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)
}

/**
 * 「仅当前文件」过滤。
 *
 * `activePath` 正常情况下是工作区相对路径（与标签一致），但外部只读文件的标签也可能是绝对路径；
 * 两种形态都接受，避免开关在外部文件上永远筛出空列表。路径都不在活动文件上时返回空数组。
 */
export function filterByCurrentFile(entries: readonly ProblemEntry[], activePath: string | undefined): ProblemEntry[] {
  if (activePath === undefined || activePath === '') return [...entries]
  if (looksAbsolute(activePath)) {
    const target = normalizeAbsolutePath(activePath)
    return entries.filter(entry => normalizeAbsolutePath(entry.path) === target)
  }
  const target = normalizeRelativePath(activePath)
  return entries.filter(entry => normalizeRelativePath(entry.relativePath) === target)
}

/**
 * 复制位置用的文本：`工作区相对路径:行:列`，行列都是 1 基（与编辑器、问题面板显示一致）。
 *
 * 单独成函数是为了让「1 基」这条约定只存在一处：组件、右键菜单与测试都用它，不会某处漏 +1。
 */
export function formatProblemLocation(relativePath: string, position: LanguagePosition): string {
  const start = position.line + 1
  const column = position.character + 1
  return `${relativePath}:${start}:${column}`
}

/* ────────────────────────────── 虚拟化 ────────────────────────────── */

/** 可视窗口：`start` 含、`end` 不含，`top` 是第一条渲染行的偏移。 */
export interface RowWindow {
  start: number
  end: number
  top: number
  totalHeight: number
}

/** 每行起始偏移的累计表（长度 = 行数 + 1，最后一项是总高度）。 */
export function rowOffsets(rows: readonly ProblemRow[]): number[] {
  const offsets = new Array<number>(rows.length + 1)
  offsets[0] = 0
  for (let index = 0; index < rows.length; index++) {
    offsets[index + 1] = (offsets[index] ?? 0) + (rows[index]?.height ?? 0)
  }
  return offsets
}

/**
 * 计算可视窗口。
 *
 * 用累计偏移做二分：上千行时每帧 O(log n) 定位，再线性向后找到视口底部（可视行数很少）。
 * 超出内容高度时把 scrollTop 夹到最后一屏 —— 浏览器在内容变短时会给出越界的 scrollTop，
 * 不夹取会得到一个空窗口。
 */
export function virtualWindow(
  offsets: readonly number[],
  viewportHeight: number,
  scrollTop: number,
  overscan: number = VIRTUAL_OVERSCAN,
): RowWindow {
  const count = Math.max(0, offsets.length - 1)
  const totalHeight = offsets[count] ?? 0
  if (count === 0) return { start: 0, end: 0, top: 0, totalHeight: 0 }
  const height = viewportHeight > 0 ? viewportHeight : FALLBACK_VIEWPORT_HEIGHT
  const clampedTop = Math.max(0, Math.min(scrollTop, Math.max(0, totalHeight - height)))
  // 最后一个 offsets[i] <= clampedTop 的 i 就是第一条可见行。
  let first = 0
  let low = 0
  let high = count - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if ((offsets[middle] ?? 0) <= clampedTop) {
      first = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  const visibleBottom = clampedTop + height
  let last = first
  while (last + 1 < count && (offsets[last + 1] ?? 0) < visibleBottom) last++
  const start = Math.max(0, first - Math.max(0, overscan))
  const end = Math.min(count, last + 1 + Math.max(0, overscan))
  return { start, end, top: offsets[start] ?? 0, totalHeight }
}

/**
 * 让某一行完整进入视口所需的最小 scrollTop。
 *
 * 键盘上下移动时用：只在目标行不可见时才滚（已可见就不动，避免列表自己抖）。
 */
export function ensureRowVisible(
  offsets: readonly number[],
  index: number,
  viewportHeight: number,
  scrollTop: number,
): number {
  const count = Math.max(0, offsets.length - 1)
  if (index < 0 || index >= count) return scrollTop
  const height = viewportHeight > 0 ? viewportHeight : FALLBACK_VIEWPORT_HEIGHT
  const rowTop = offsets[index] ?? 0
  const rowBottom = offsets[index + 1] ?? rowTop
  if (rowTop < scrollTop) return rowTop
  if (rowBottom > scrollTop + height) return Math.max(0, rowBottom - height)
  return scrollTop
}

/* ────────────────────────────── 键盘导航 ────────────────────────────── */

/** 行键 → 行下标；行被过滤/收起后返回 -1（调用方据此把高亮落到文件头）。 */
export function rowIndexForKey(rows: readonly ProblemRow[], key: string | undefined): number {
  if (key === undefined) return -1
  return rows.findIndex(row => row.key === key)
}

/**
 * 上下移动高亮：从「没有高亮」（-1）开始，向下落到第一行、向上落到最后一行；到边界夹住而不是循环
 * —— 循环会让用户以为自己丢了位置。
 */
export function stepRowIndex(rows: readonly ProblemRow[], current: number, direction: 1 | -1): number {
  if (rows.length === 0) return -1
  if (current < 0) return direction > 0 ? 0 : rows.length - 1
  const next = current + direction
  return Math.max(0, Math.min(rows.length - 1, next))
}

/** 左右键要展开/收起的文件：文件头行就是它自己，诊断行是它所属的文件。 */
export function toggleTargetOf(rows: readonly ProblemRow[], index: number): string | undefined {
  const row = rows[index]
  if (row === undefined) return undefined
  return row.kind === 'file' ? row.path : row.filePath
}

/* ────────────────────────────── 右键菜单描述 ────────────────────────────── */

export type ProblemMenuAction = 'open' | 'copyMessage' | 'copyPosition' | 'copyPath' | 'addToChat' | 'showQuickFix' | 'toggleFile'

export type ProblemMenuSpec =
  | { kind: 'item'; id: ProblemMenuAction; label: string }
  | { kind: 'separator' }

/**
 * 右键菜单的纯数据描述（不含 React 与动作实现）。
 *
 * 文件头行只能做「文件级」动作：展开/收起、复制路径、加入对话；诊断行才有消息/位置/快速修复。
 * 把描述与执行分开，菜单项集合可以脱离 DOM 单测，组件那边只负责映射 onSelect。
 */
export function contextMenuSpecs(row: ProblemRow | undefined): readonly ProblemMenuSpec[] {
  if (row === undefined) return []
  if (row.kind === 'file') {
    return [
      { kind: 'item', id: 'toggleFile', label: row.expanded ? '收起' : '展开' },
      { kind: 'item', id: 'copyPath', label: '复制路径' },
      { kind: 'separator' },
      { kind: 'item', id: 'addToChat', label: '添加到对话' },
    ]
  }
  return [
    { kind: 'item', id: 'open', label: '打开' },
    { kind: 'separator' },
    { kind: 'item', id: 'copyMessage', label: '复制消息' },
    { kind: 'item', id: 'copyPosition', label: '复制位置' },
    { kind: 'item', id: 'copyPath', label: '复制路径' },
    { kind: 'separator' },
    { kind: 'item', id: 'addToChat', label: '添加到对话' },
    { kind: 'item', id: 'showQuickFix', label: '显示快速修复' },
  ]
}
