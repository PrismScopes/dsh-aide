/**
 * 命令面板与快速打开的纯逻辑：输入解析、模糊匹配、排序与结果裁剪。
 *
 * 与 React 无关：面板组件只负责画，匹配规则放在这里才能单测。性能约束同样是硬性的 ——
 * 大工作区一次要过两三万个路径，逐项跑正则会让每次按键都掉帧；这里全部是字符扫描，
 * 命中失败立即返回，结果按分数截断到固定条数。
 */

export type PaletteKind = 'file' | 'command'

/** 面板里的一行。`weight` 越大越靠前；空查询时按它排序。 */
export interface PaletteEntry {
  id: string
  label: string
  /** 右侧灰字：文件是所在目录，命令是分组。 */
  detail?: string
  /** 命令分组标题（只有命令有）。 */
  group?: string
  /** 键位提示（已格式化的键帽文字）。 */
  keys?: readonly string[]
  kind: PaletteKind
  weight?: number
}

/** 一个匹配区间，供界面给命中字符加底色。 */
export interface MatchRange {
  start: number
  end: number
}

export interface RankedEntry {
  entry: PaletteEntry
  score: number
  ranges: MatchRange[]
}

/** 面板支持两种输入模式；`>` 开头是命令，其余是文件。 */
export interface PaletteInput {
  mode: PaletteKind
  query: string
}

/**
 * 解析输入框内容。
 *
 * `>` 是命令模式（与 VS Code 一致）；去掉前缀后的内容才是查询。前导空格不算前缀，
 * 否则用户想搜以空格开头的路径就永远进不了命令。
 */
export function splitPaletteInput(raw: string): PaletteInput {
  if (raw.startsWith('>')) return { mode: 'command', query: raw.slice(1).trimStart() }
  return { mode: 'file', query: raw }
}

/** 文件名：路径最后一段。空路径返回空串，由调用方过滤。 */
export function paletteFileLabel(path: string): string {
  const name = path.split('/').at(-1) ?? path
  return name
}

/** 文件所在目录；根目录文件返回空串（界面不显示右侧灰字）。 */
export function paletteFileDetail(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

/**
 * 由工作区路径生成快速打开项。
 *
 * `recent` 是「最近打开」的路径顺序：越靠前权重越高。最近打开列表来自标签栏与本地记录，
 * 空查询时用户第一眼看到的应该是刚才用过的文件，而不是字母序第一个。
 */
export function filePaletteEntries(paths: readonly string[], recent: readonly string[] = []): PaletteEntry[] {
  const recentRank = new Map<string, number>()
  for (let index = 0; index < recent.length; index++) {
    if (!recentRank.has(recent[index] as string)) recentRank.set(recent[index] as string, recent.length - index)
  }
  const entries: PaletteEntry[] = []
  for (const path of paths) {
    if (path === '') continue
    const detail = paletteFileDetail(path)
    const weight = recentRank.get(path)
    entries.push({
      id: `file:${path}`,
      label: paletteFileLabel(path),
      ...(detail === '' ? {} : { detail }),
      kind: 'file',
      ...(weight === undefined ? {} : { weight }),
    })
  }
  return entries
}

/**
 * 模糊匹配：先找连续子串（分数最高），再退回按顺序出现的子序列。
 *
 * 评分规则简单且可解释：连续命中、词首命中加分，位置越靠前越好。不做编辑距离 ——
 * 用户输入的每个字符都必须按顺序出现，拼错就是没结果，这与 VS Code 的快速打开一致。
 */
export function fuzzyMatch(query: string, target: string): { score: number; ranges: MatchRange[] } | undefined {
  if (query === '') return { score: 0, ranges: [] }
  const needle = query.toLowerCase()
  const haystack = target.toLowerCase()
  if (needle.length > haystack.length) return undefined

  const direct = haystack.indexOf(needle)
  if (direct !== -1) {
    // 词首的连续子串最值钱；出现在越靠后的位置扣分，避免「src/foo/bar.ts」压过「bar.ts」。
    const boundary = direct === 0 || isWordBoundary(haystack, direct)
    return { score: 1200 + (boundary ? 200 : 0) - direct - Math.max(0, haystack.length - needle.length) / 4, ranges: [{ start: direct, end: direct + needle.length }] }
  }

  const ranges: MatchRange[] = []
  let score = 0
  let cursor = 0
  let lastIndex = -1
  for (const char of needle) {
    const found = haystack.indexOf(char, cursor)
    if (found === -1) return undefined
    const boundary = found === 0 || isWordBoundary(haystack, found)
    if (found === lastIndex + 1) score += 18
    else score -= Math.min(12, found - lastIndex - 1)
    if (boundary) score += 22
    if (found === 0) score += 12
    ranges.push({ start: found, end: found + 1 })
    lastIndex = found
    cursor = found + 1
  }
  // 词首命中占比高的结果更可能是用户想要的；按命中数归一后再给一个位置奖励。
  score += Math.round(120 / needle.length)
  return { score, ranges }
}

/** 位置是否是词首：开头、或前一个字符是常见分隔符、或大小写边界（`fooBar` 的 B）。 */
function isWordBoundary(text: string, index: number): boolean {
  if (index === 0) return true
  const previous = text[index - 1] as string
  if (previous === '/' || previous === '\\' || previous === '.' || previous === '-' || previous === '_' || previous === ' ' || previous === '@') return true
  const current = text[index] as string
  return previous !== previous.toUpperCase() && current === current.toUpperCase() && current !== current.toLowerCase()
}

/**
 * 合并相邻区间：连续命中的字符画成一段底色，而不是一格一格的。
 */
export function mergeRanges(ranges: readonly MatchRange[]): MatchRange[] {
  if (ranges.length <= 1) return [...ranges]
  const merged: MatchRange[] = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else merged.push({ start: range.start, end: range.end })
  }
  return merged
}

/**
 * 排序并截断。
 *
 * 文件项先匹配文件名，文件名没命中再看目录（分数打折）—— 用户搜 `utils` 时既想看到
 * `utils.ts`，也想看到 `src/utils/` 里的文件，但前者必须排在前面。
 */
export function rankPaletteEntries(entries: readonly PaletteEntry[], query: string, limit = 60): RankedEntry[] {
  const capped = Math.max(0, Math.floor(limit))
  if (capped === 0) return []
  const needle = query.trim()
  if (needle === '') {
    const sorted = [...entries].sort((left, right) => (right.weight ?? 0) - (left.weight ?? 0))
    return sorted.slice(0, capped).map(entry => ({ entry, score: entry.weight ?? 0, ranges: [] }))
  }
  const ranked: RankedEntry[] = []
  for (const entry of entries) {
    const onLabel = fuzzyMatch(needle, entry.label)
    if (onLabel !== undefined) {
      ranked.push({ entry, score: onLabel.score + (entry.weight ?? 0) * 8, ranges: mergeRanges(onLabel.ranges) })
      continue
    }
    const detail = entry.detail
    if (detail === undefined || detail === '') continue
    const onDetail = fuzzyMatch(needle, detail)
    if (onDetail !== undefined) ranked.push({ entry, score: onDetail.score * 0.45, ranges: [] })
  }
  ranked.sort((left, right) => right.score - left.score
    || left.entry.label.length - right.entry.label.length
    // 同分时目录更浅的排前面：「src/utils.ts」比「docs/other/utils.ts」更可能是目标。
    || (left.entry.detail?.length ?? 0) - (right.entry.detail?.length ?? 0)
    || left.entry.label.localeCompare(right.entry.label)
    || left.entry.id.localeCompare(right.entry.id))
  return ranked.slice(0, capped)
}

/** 命令项：`keys` 是格式化后的键帽，`group` 用于分段标题。 */
export interface CommandPaletteSource {
  id: string
  label: string
  group?: string
  keys?: readonly string[]
}

export function commandPaletteEntries(commands: readonly CommandPaletteSource[]): PaletteEntry[] {
  return commands.map(command => ({
    id: command.id,
    label: command.label,
    kind: 'command' as const,
    // 分组已经是独立标题行，右侧不再重复一遍同样的字；有键位时右侧留给键帽。
    ...(command.group === undefined ? {} : { group: command.group }),
    ...(command.keys === undefined ? {} : { keys: command.keys }),
  }))
}
