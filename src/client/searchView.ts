import type { SearchMatch } from '../types.ts'

/**
 * 搜索面板的纯逻辑：结果聚合、高亮分段、键盘步进、输入校验、状态持久化。
 *
 * 从 Search 组件里拆出来是因为这些都能在 node 里直接断言（不需要 DOM）；
 * 组件只负责渲染与请求，行为规则集中在这里。
 */

/** 一处命中的高亮区间：0 基起点 + UTF-16 长度（与宿主返回的 column/match 对应）。 */
export interface SearchHit { start: number; length: number }

/**
 * 一条结果行 = 一处命中。与 VS Code 一致：同一行有两处命中就会出现两行（各自的列号不同），
 * 行上 `hits` 保存该行**所有**高亮区间，渲染时用来在预览里标出全部命中。
 */
export interface SearchRow { path: string; line: number; column: number; preview: string; hits: SearchHit[] }

/** 按文件聚合的结果。`name`/`directory` 是拆好的路径片段，渲染时文件名加粗、目录变暗。 */
export interface SearchFile { path: string; name: string; directory: string; rows: SearchRow[] }

function lineKey(path: string, line: number): string { return `${path}\u0000${line}` }

/**
 * 把宿主返回的扁平命中聚合为「文件 → 行」。
 *
 * 去重只针对完全相同的 (行, 列)：同一条命中在回包里出现两次不会再渲染两遍。
 * 文件按路径、行内按 (行号, 列号) 排序 —— 与 VS Code 的默认展示顺序一致，不依赖 rg 的输出顺序。
 */
export function groupMatches(matches: readonly SearchMatch[]): SearchFile[] {
  const hitsByLine = new Map<string, SearchHit[]>()
  for (const match of matches) {
    const key = lineKey(match.path, match.line)
    const hits = hitsByLine.get(key) ?? []
    const start = Math.max(0, match.column - 1)
    const length = Math.max(0, match.match.length)
    // 同一位置重复出现的命中（同一行被多处规则匹配到）只保留一份高亮。
    if (!hits.some(hit => hit.start === start && hit.length === length)) hits.push({ start, length })
    hitsByLine.set(key, hits)
  }
  const files = new Map<string, SearchFile>()
  const seen = new Set<string>()
  for (const match of matches) {
    const key = lineKey(match.path, match.line)
    const rowKey = `${key}\u0000${match.column}`
    if (seen.has(rowKey)) continue
    seen.add(rowKey)
    let file = files.get(match.path)
    if (file === undefined) {
      const slash = match.path.lastIndexOf('/')
      file = {
        path: match.path,
        name: slash === -1 ? match.path : match.path.slice(slash + 1),
        directory: slash === -1 ? '' : match.path.slice(0, slash + 1),
        rows: [],
      }
      files.set(match.path, file)
    }
    file.rows.push({ path: match.path, line: match.line, column: match.column, preview: match.preview, hits: hitsByLine.get(key) ?? [] })
  }
  const list = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const file of list) {
    for (const row of file.rows) row.hits.sort((a, b) => a.start - b.start)
    file.rows.sort((a, b) => a.line - b.line || a.column - b.column)
  }
  return list
}

/** 渲染顺序下的所有行；F4/方向键在这条序列上步进。 */
export function flattenRows(files: readonly SearchFile[]): SearchRow[] {
  return files.flatMap(file => file.rows)
}

/** 高亮片段：命中的部分单独成段，交给 `<mark>` 渲染。`start` 是片段在预览里的起点。 */
export interface Segment { text: string; hit: boolean; start: number }

/**
 * 把一行预览切成「普通 / 命中」交替的片段。
 *
 * 越界的区间会被夹到文本长度内（宿主按字节外的 UTF-16 计数给列号，但预览被 trimEnd 过，
 * 尾部命中可能落在文本之外），重叠的区间按并集渲染，不会出现重复文字。
 */
export function highlightSegments(preview: string, hits: readonly SearchHit[]): Segment[] {
  const segments: Segment[] = []
  let cursor = 0
  for (const hit of [...hits].sort((a, b) => a.start - b.start || a.length - b.length)) {
    const start = Math.max(cursor, Math.min(hit.start, preview.length))
    const end = Math.min(preview.length, Math.max(start, hit.start + hit.length))
    if (start > cursor) segments.push({ text: preview.slice(cursor, start), hit: false, start: cursor })
    if (end > start) segments.push({ text: preview.slice(start, end), hit: true, start })
    cursor = end
  }
  if (cursor < preview.length) segments.push({ text: preview.slice(cursor), hit: false, start: cursor })
  return segments
}

/**
 * 在长度为 `length` 的序列里按 `direction` 步进并环绕；还没有当前位置（-1）时从两端进入。
 * 空序列返回 -1，调用方据此跳过。
 */
export function stepIndex(current: number, length: number, direction: 1 | -1): number {
  if (length <= 0) return -1
  if (current < 0 || current >= length) return direction === 1 ? 0 : length - 1
  return (current + direction + length) % length
}

/**
 * 正则表达式校验：返回给用户看的错误消息，合法时返回 undefined。
 *
 * 在输入时就提示，而不是等宿主把 rg 的报错原样回传（那条消息会带上整行命令行，没法读）。
 * 与宿主的 compileSearchPattern 保持同一套包裹规则（wholeWord 用 \b 包一层）。
 */
export function regexProblem(query: string, options: { regex: boolean; wholeWord: boolean }): string | undefined {
  if (!options.regex) return undefined
  try {
    new RegExp(options.wholeWord ? `\\b(?:${query})\\b` : query)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : '正则表达式无效'
  }
}

/** 搜索面板的持久化状态：VS Code 会保留上一次搜索（含替换串与选项），这里同样按工作区保留。 */
export interface SearchState {
  query: string
  include: string
  exclude: string
  replace: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  preserveCase: boolean
}

export const DEFAULT_SEARCH: SearchState = {
  query: '', include: '', exclude: '', replace: '',
  caseSensitive: false, wholeWord: false, regex: false, preserveCase: false,
}

/** 宽松解析持久化内容：字段逐个校验，坏数据只让该项回落默认值，不会整份作废。 */
export function parseSearchState(raw: string | null): SearchState {
  if (raw === null || raw === '') return { ...DEFAULT_SEARCH }
  let value: unknown
  try { value = JSON.parse(raw) } catch { return { ...DEFAULT_SEARCH } }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_SEARCH }
  const source = value as Record<string, unknown>
  const text = (key: keyof SearchState): string => typeof source[key] === 'string' ? source[key] as string : ''
  const flag = (key: keyof SearchState): boolean => source[key] === true
  return {
    query: text('query'), include: text('include'), exclude: text('exclude'), replace: text('replace'),
    caseSensitive: flag('caseSensitive'), wholeWord: flag('wholeWord'), regex: flag('regex'), preserveCase: flag('preserveCase'),
  }
}
