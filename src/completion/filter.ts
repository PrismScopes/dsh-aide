/**
 * 候选的过滤与后处理（文档 4.5）。
 *
 * 全部是纯函数：输入候选文本与一份「判定所需的状态」，输出保留或丢弃。这样这一层可以脱离编辑器
 * 单测，也不会因为编辑器状态变化而被绕过。
 *
 * 有两条判定的语义依赖「候选是一段替换」的模型（例如「跨行删除」）。当前实现是插入式补全
 * （FIM 生成的是要插入的文本），所以这两条按插入式能表达的方式落地，并在注释里写明是哪一条被简化了。
 */

/** 一次采纳留下的区间记录，供「与上次采纳区间」两条判定使用。 */
export interface AcceptedRange {
  filePath: string
  start: number
  end: number
  text: string
  /** 内联补全的采纳（与「上次采纳」区分：判定 2 只看内联的）。 */
  inline: boolean
}

export interface FilterState {
  filePath: string
  /** 当前文档全文。 */
  document: string
  /** 光标在文档中的字符偏移，也是候选的插入位置。 */
  offset: number
  language: string
  lastAccepted?: AcceptedRange
  lastEdit?: { before: string; after: string }
  /** 因选择变化而取消的那次建议文本（判定 4）。 */
  cancelledSuggestion?: string
  /** 光标所在行的上一版本文本（判定 3 要比长度）。 */
  previousLineText?: string
}

export interface FilterOptions {
  dropDuplicateText: boolean
  dropNextLineDuplicate: boolean
  dropImports: boolean
  dropTooShort: boolean
  minLength: number
  dropForeignLanguage: boolean
}

export const DEFAULT_FILTER_OPTIONS: FilterOptions = {
  dropDuplicateText: true,
  dropNextLineDuplicate: true,
  dropImports: true,
  dropTooShort: true,
  minLength: 2,
  dropForeignLanguage: true,
}

export type DropReason =
  | 'same-line-as-last-accept'
  | 'overlaps-last-inline-accept'
  | 'deletion-after-growth'
  | 'repeats-cancelled-suggestion'
  | 'identical-to-document'
  | 'rollback-edit'
  | 'multi-line-deletion'
  | 'empty-change'
  | 'duplicate-text'
  | 'next-line-duplicate'
  | 'import-statement'
  | 'too-short'
  | 'no-language-chars'

export interface FilteredCandidate { text: string; dropped?: DropReason }

/** 光标所在行的文本（不含换行）。 */
export function lineAt(document: string, offset: number): string {
  const start = document.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
  const end = document.indexOf('\n', offset)
  return document.slice(start, end === -1 ? document.length : end)
}

/** 候选插入位置之后的原文（用于比对「与编辑器内容无差异」）。 */
function textAfterCursor(document: string, offset: number, length: number): string {
  return document.slice(offset, offset + length)
}

const IMPORT_PATTERN = /^\s*(?:import\s|export\s+.*from\s|from\s+\S+\s+import\s|const\s+\S+\s*=\s*require\(|#include\s|using\s+\S+\s*=|package\s+\S+$)/

/** 判定 1 到 8 逐条实现；命中任一条即返回丢弃原因。 */
export function dropReason(candidate: string, state: FilterState, options: FilterOptions = DEFAULT_FILTER_OPTIONS): DropReason | undefined {
  const { lastAccepted, lastEdit, document, offset } = state

  // 8. 空内容变更：没产生实际变化。
  if (candidate.trim() === '') return 'empty-change'

  // 1. 与上次采纳区间同行：重写区间落在上次采纳区间内、文本长度等于区间长度、且同一文件。
  if (lastAccepted !== undefined && lastAccepted.filePath === state.filePath) {
    // 左闭右开：采纳后光标停在区间末端，那一位置属于「新的补全起点」，不该被当作重叠。
    const inside = offset >= lastAccepted.start && offset < lastAccepted.end
    if (inside && candidate.length === lastAccepted.end - lastAccepted.start) return 'same-line-as-last-accept'
    // 2. 与上次内联采纳区间重叠：只看内联补全的采纳区间。
    if (lastAccepted.inline && inside) return 'overlaps-last-inline-accept'
  }

  // 5. 与编辑器内容无差异：候选与光标处原文一致。
  if (candidate === textAfterCursor(document, offset, candidate.length)) return 'identical-to-document'

  // 6. 回滚编辑：候选把最近一次编辑改回去。
  if (lastEdit !== undefined && candidate === lastEdit.before && textAfterCursor(document, offset, lastEdit.after.length) !== lastEdit.after) return 'rollback-edit'

  // 3. 刚编辑却建议删除：光标所在行比上一版本更长，而候选是删除。
  //    插入式模型里「删除」表现为空候选或纯空白，上面第 8 条已经拦掉；这里补一层：行变长了却给出
  //    比上一行更短的内容，也算建议删除。
  if (state.previousLineText !== undefined) {
    const current = lineAt(document, offset)
    if (current.length > state.previousLineText.length && candidate.length < current.length - state.previousLineText.length) return 'deletion-after-growth'
  }

  // 4. 刚建议过但未采纳：与因选择变化取消的那次完全相同。
  if (state.cancelledSuggestion !== undefined && candidate === state.cancelledSuggestion) return 'repeats-cancelled-suggestion'

  // 7. 多行删除：候选造成跨行删除。插入式模型下把「候选为空且替换范围跨行」视为跨行删除；
  //    由于插入式不产生替换范围，这里以「候选去掉换行后为空、而光标之后跨行有内容」为界。
  if (candidate.replace(/\n/g, '').trim() === '') {
    const rest = document.slice(offset)
    if (rest.includes('\n') && rest.trim() !== '') return 'multi-line-deletion'
  }

  if (options.dropDuplicateText) {
    const before = document.slice(Math.max(0, offset - candidate.length), offset)
    if (before !== '' && before === candidate) return 'duplicate-text'
  }
  if (options.dropNextLineDuplicate) {
    const nextLine = document.slice(offset).split('\n')[1]
    if (nextLine !== undefined && nextLine.trim() !== '' && candidate.split('\n')[0]?.trim() === nextLine.trim()) return 'next-line-duplicate'
  }
  if (options.dropImports && IMPORT_PATTERN.test(candidate)) return 'import-statement'
  if (options.dropTooShort && candidate.trim().length < options.minLength) return 'too-short'
  if (options.dropForeignLanguage && !/[\p{L}\p{N}_]/u.test(candidate)) return 'no-language-chars'
  return undefined
}

/** 批量过滤，保留未被丢弃的候选并附带丢弃原因（原因用于埋点，不呈现给用户）。 */
export function filterCandidates(candidates: readonly string[], state: FilterState, options: FilterOptions = DEFAULT_FILTER_OPTIONS): FilteredCandidate[] {
  return candidates.map(text => {
    const reason = dropReason(text, state, options)
    return reason === undefined ? { text } : { text, dropped: reason }
  })
}

const PAIRS: Array<[string, string]> = [['(', ')'], ['[', ']'], ['{', '}'], ['"', '"'], ["'", "'"], ['`', '`']]

/** 后处理：处理重复尾符号。候选末尾若与插入点之后的字符重复，则去掉候选末尾那一个。 */
export function trimDuplicateTrailingSymbol(candidate: string, document: string, offset: number): string {
  const last = candidate.at(-1)
  if (last === undefined || !')]}"\';,:'.includes(last)) return candidate
  if (document.startsWith(last, offset)) return candidate.slice(0, -1)
  return candidate
}

/** 后处理：闭合括号与引号。候选自身括号不平衡时，按开合顺序补齐。 */
export function closeBrackets(candidate: string): string {
  const stack: string[] = []
  for (const char of candidate) {
    const pair = PAIRS.find(([open]) => open === char)
    if (pair !== undefined) { stack.push(pair[1]); continue }
    const closing = PAIRS.find(([, close]) => close === char)?.[1]
    if (closing !== undefined && stack.at(-1) === closing) stack.pop()
  }
  return stack.length === 0 ? candidate : candidate + stack.reverse().filter(close => close !== '"' && close !== "'" && close !== '`').join('')
}

/** 与光标前文本比对的最长长度：真实重叠都很短，比得过长只是白做功。 */
const PREFIX_OVERLAP_LIMIT = 128

/**
 * 后处理：去掉候选开头与光标前文本重复的部分。
 *
 * 候选是插入式的，而对话模型常把已输入的内容重复一遍（输入 `use`、它返回 `useState`）。
 * 不去掉就会在同一行出现两份。取最长重叠、重叠多长去多长 —— 模型重复上下文远比「巧合地
 * 从同样的字符开始」常见，这也是 FIM 补全的通行做法。
 */
export function trimPrefixOverlap(candidate: string, document: string, offset: number): string {
  const before = document.slice(Math.max(0, offset - PREFIX_OVERLAP_LIMIT), offset)
  const limit = Math.min(before.length, candidate.length, PREFIX_OVERLAP_LIMIT)
  for (let length = limit; length > 0; length--) {
    if (before.endsWith(candidate.slice(0, length))) return candidate.slice(length)
  }
  return candidate
}

/** 后处理：处理重复文本。候选内部同一行连续重复三次以上时压成一次。 */
export function collapseRepeatedLines(candidate: string): string {
  const lines = candidate.split('\n')
  const out: string[] = []
  let run = 0
  for (const line of lines) {
    run = out.at(-1) === line ? run + 1 : 1
    // 达到第三次时把已保留的那一次也去掉：文档要求的是压成一次，不是压成两次。
    if (run === 3) out.pop()
    if (run >= 3) continue
    out.push(line)
  }
  return out.join('\n')
}

/** 后处理：截断完整代码块。候选里第一次出现「括号已闭合的块」之后的内容去掉。 */
export function truncateAfterCompleteBlock(candidate: string): string {
  let depth = 0
  let seenBlock = false
  for (let index = 0; index < candidate.length; index++) {
    const char = candidate[index]
    if (char === '{') { depth++; seenBlock = true; continue }
    if (char === '}') {
      depth--
      if (seenBlock && depth === 0) return candidate.slice(0, index + 1)
    }
  }
  return candidate
}

/**
 * 剥掉对话模型补上的代码围栏与语言标注行。
 *
 * 对话模型被要求「只输出要插入的内容」时，仍常常包一层围栏；这属于呈现层杂质，不该插进代码。
 * 只剥最外层的一对，内部的围栏（比如写在字符串里的）不动。
 */
export function stripCodeFence(candidate: string): string {
  const lines = candidate.split('\n')
  const open = lines.findIndex(line => line.trim().startsWith('```'))
  if (open === -1) return candidate
  let body = lines.slice(open + 1)
  // 收尾围栏：可能独占一行，也可能贴在最后一行的末尾。
  const close = body.findIndex(line => line.trim().startsWith('```'))
  if (close !== -1) body = body.slice(0, close)
  else if ((body.at(-1) ?? '').trimEnd().endsWith('```')) body[body.length - 1] = (body.at(-1) as string).trimEnd().slice(0, -3)
  // 围栏前后都可能挂着说明文字（「这是补全：」「希望有帮助」），整段丢掉：它们是呈现层杂质。
  while ((body[0] ?? '').trim() === '') body.shift()
  while ((body.at(-1) ?? '').trim() === '') body.pop()
  return body.join('\n')
}

/** 后处理五件事的组合入口，顺序按文档给出的次序。 */
export function postProcess(candidate: string, state: Pick<FilterState, 'document' | 'offset'>): string {
  let text = stripCodeFence(candidate)
  text = trimPrefixOverlap(text, state.document, state.offset)
  text = collapseRepeatedLines(text)
  text = trimDuplicateTrailingSymbol(text, state.document, state.offset)
  text = closeBrackets(text)
  text = truncateAfterCompleteBlock(text)
  return text
}
