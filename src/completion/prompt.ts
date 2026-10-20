/**
 * prompt 组装与预算裁剪。
 *
 * 文档第六节点明：prompt 没有通用最优解，序列结构、字段顺序、截断策略都要按目标模型实测。
 * 所以这里做的是「把结构固定下来、把取值集中起来」，而不是写死某个模板：
 *   - 序列结构与 FIM 标记由 profile 描述，换模型只换 profile；
 *   - 裁剪顺序按文档给的优先级（仓库级 → 检索片段 → 符号 → 编辑历史 → 前后缀最后）。
 */
import type { EditHistoryEntry } from './protocol.ts'
import { charBudgetForPrompt, type CompletionParams, DEFAULT_COMPLETION_PARAMS } from './params.ts'

/**
 * FIM 标记。
 *
 * 文档专门警告过「选错标记会导致补全质量显著下降」，所以两套常见写法都放在这里，由模型 profile
 * 指定用哪一套；默认取 <|fim_*|> 这一套（与多数开源代码模型的分词器一致）。
 */
export interface FimMarkers { prefix: string; middle: string; suffix: string; end?: string }

export const FIM_MARKERS = {
  /** <|fim_prefix|>前缀<|fim_suffix|>后缀<|fim_middle|> */
  psm: { prefix: '<|fim_prefix|>', suffix: '<|fim_suffix|>', middle: '<|fim_middle|>' },
  /** 全角变体，与另一族分词器一致。 */
  psmFullWidth: { prefix: '<｜fim▁begin｜>', suffix: '<｜fim▁end｜>', middle: '<｜fim▁hole｜>' },
  /** <fim_begin>前缀<fim_hole>后缀<fim_end> —— 三段式，标记在文本之间而不是两端。 */
  hole: { prefix: '<fim_begin>', middle: '<fim_hole>', suffix: '<fim_end>' },
} satisfies Record<string, FimMarkers>

/** 标记的排布方式。 */
export type FimLayout = 'prefix-suffix-middle' | 'begin-hole-end' | 'instruction'

export interface PromptProfile {
  id: string
  markers: FimMarkers
  /**
   * 三种排布：
   *   - 前两种是 FIM，要求模型的词表里真的有这些标记；
   *   - `instruction` 面向对话模型：不用标记，改成把光标位置显式标出来并给出输出要求。
   * 选错排布比选错参数影响更大，所以它属于模型 profile，不写死在组装逻辑里。
   */
  layout: FimLayout
  /** 后缀是从光标处直接截，还是从最近的同级代码块边界起（缩进敏感语言效果更好）。 */
  suffixFromBlockBoundary: boolean
}

export const DEFAULT_PROMPT_PROFILE: PromptProfile = {
  id: 'default-psm',
  markers: FIM_MARKERS.psm,
  layout: 'prefix-suffix-middle',
  suffixFromBlockBoundary: false,
}

/**
 * 对话模型的默认 profile。
 *
 * 光标处用 `<CURSOR>` 标出，指令里明确「只输出插入内容」—— 对话模型不做这个约束时，
 * 十有八九会把上下文复述一遍或加上解释。
 */
export const INSTRUCTION_PROMPT_PROFILE: PromptProfile = {
  id: 'instruction',
  markers: FIM_MARKERS.psm,
  layout: 'instruction',
  suffixFromBlockBoundary: true,
}

/** 光标占位符：指令排布与调试输出都用它。 */
export const CURSOR_MARKER = '<CURSOR>'

export interface PromptInput {
  filePath: string
  language: string
  document: string
  /** 行号 1 起、列 0 起。 */
  rewriteAt: { line: number; column: number }
  edits?: readonly EditHistoryEntry[]
  snippets?: readonly string[]
  symbols?: readonly string[]
  repositoryContext?: string
}

export interface PromptResult {
  prompt: string
  prefix: string
  suffix: string
  /** 因预算被丢掉的部分，便于调试与埋点。 */
  dropped: string[]
  /** 组装后的字符数，与 token 预算的近似值一起用于观测。 */
  chars: number
  /** 实际注入的检索片段条数，用于观测检索是否生效。 */
  snippetCount: number
}

/**
 * 把「行号 1 起、列 1 起」换算成文档中的字符偏移。
 *
 * 行号与列号都从 1 开始 —— 这是 Monaco 的位置约定，也是请求里 `rewriteAt` 的约定。
 * 列号若是 0 起，整个前缀会偏一个字符：光标在文档末尾时被长度夹住看不出来，光标在文件中段时
 * 补全就会因为标识符对不上而消失（实测如此）。
 */
export function offsetAt(document: string, line: number, column: number): number {
  const lines = document.split('\n')
  const targetLine = Math.max(1, Math.min(line, lines.length))
  let offset = 0
  for (let index = 0; index < targetLine - 1; index++) offset += (lines[index] ?? '').length + 1
  return Math.min(offset + Math.max(0, column - 1), document.length)
}

/** 按行数与字符数双重封顶，保留靠近光标的那一侧。 */
export function truncatePrefix(prefix: string, params: CompletionParams): string {
  const lines = prefix.split('\n')
  const byLines = lines.length > params.prefixLines ? lines.slice(lines.length - params.prefixLines).join('\n') : prefix
  return byLines.length > params.prefixChars ? byLines.slice(byLines.length - params.prefixChars) : byLines
}

export function truncateSuffix(suffix: string, params: CompletionParams): string {
  const lines = suffix.split('\n')
  const byLines = lines.length > params.suffixLines ? lines.slice(0, params.suffixLines).join('\n') : suffix
  return byLines.length > params.suffixChars ? byLines.slice(0, params.suffixChars) : byLines
}

/** 后缀块边界扫描的行数上限；请求裁剪也用它，保证两边看的是同一个后缀窗口。 */
const SUFFIX_BLOCK_SCAN_LINES = 200

/**
 * 检索查询会看光标前多少行；必须与 retrieval.buildQuery 的 windowLines 默认值保持一致，
 * 否则客户端裁剪后宿主检索看到的上下文会与全量文档不同。
 */
const RETRIEVAL_QUERY_LINES = 30

/**
 * 从最近的同级代码块边界起截取后缀。
 *
 * 做法：在光标之后的前若干行里，找到第一条缩进不超过光标行缩进、且非空的行，从那里开始取。
 * 缩进敏感的语言里这样能避免把当前块的残尾喂给模型。
 */
export function suffixFromBlockBoundary(suffix: string, currentIndent: number): string {
  const lines = suffix.split('\n')
  for (let index = 1; index < Math.min(lines.length, SUFFIX_BLOCK_SCAN_LINES); index++) {
    const text = lines[index] ?? ''
    if (text.trim() === '') continue
    const indent = text.length - text.trimStart().length
    if (indent <= currentIndent) return lines.slice(index).join('\n')
  }
  return suffix
}

/** 当前行的缩进宽度。 */
function indentOf(text: string): number {
  const line = text.slice(text.lastIndexOf('\n') + 1)
  return line.length - line.trimStart().length
}

/**
 * 随请求发送的文档内容裁剪（文档 4.3）：按行数与字符数双重封顶，保留靠近光标的部分。
 *
 * 裁剪会把行号整体前移，所以重写位置必须一起换算 —— 否则模型收到的「光标位置」与实际文本对不上。
 */
export function truncateDocument(document: string, rewriteAt: { line: number; column: number }, params: CompletionParams): { document: string; rewriteAt: { line: number; column: number } } {
  const lines = document.split('\n')
  let kept = document
  let droppedLines = 0
  if (lines.length > params.documentLines) {
    const cursorIndex = Math.max(0, Math.min(rewriteAt.line - 1, lines.length - 1))
    // 尽力让光标两侧都有内容：光标前保留大多数行，光标后保留余下的行。
    const before = Math.min(cursorIndex, Math.max(0, params.documentLines - 200))
    const start = Math.max(0, cursorIndex - before)
    const end = Math.min(lines.length, start + params.documentLines)
    const finalStart = Math.max(0, end - params.documentLines)
    kept = lines.slice(finalStart, end).join('\n')
    droppedLines = finalStart
  }
  let column = rewriteAt.column
  if (kept.length > params.documentChars) {
    // 字符超限：整行丢掉靠前的部分，行号换算因此仍然精确。
    // 先算出要丢几行，再 join 一次：原来每丢一行都 join 一遍，长行文档上是 O(行数²) 的复制。
    const keptLines = kept.split('\n')
    let startLine = 0
    let remaining = kept.length
    while (keptLines.length - startLine > 1 && remaining > params.documentChars) {
      remaining -= (keptLines[startLine] ?? '').length + 1
      startLine++
      droppedLines++
    }
    kept = keptLines.slice(startLine).join('\n')
    // 极端情况：剩下的单行本身就超上限。此时保留该行尾部，并把列号按丢掉的字符数前移。
    if (kept.length > params.documentChars) {
      const cut = kept.length - params.documentChars
      kept = kept.slice(cut)
      // 列号从 1 起，夹取的下限是 1；给 0 会让偏移换算落到上一行末尾。
      if (rewriteAt.line - droppedLines <= 1) column = Math.max(1, column - cut)
    }
  }
  return { document: kept, rewriteAt: { line: Math.max(1, rewriteAt.line - droppedLines), column } }
}

/** 统计 \n 的个数，不构造数组。 */
function countNewlines(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) count++
  return count
}

/** offset 所在行往前第 back 行的行首（back = 0 表示当前行行首）；越界返回 0。 */
function lineStartBefore(text: string, offset: number, back: number): number {
  let position = offset
  for (let index = 0; index <= back; index++) {
    if (position <= 0) return 0
    const newline = text.lastIndexOf('\n', position - 1)
    if (newline < 0) return 0
    position = newline
  }
  return position + 1
}

/** 从 from 起完整包含 count 段（以 \n 分段）之后的位置；不足时返回文本末尾。 */
function endOfLineParts(text: string, from: number, count: number): number {
  let position = from
  for (let index = 0; index < count; index++) {
    const newline = text.indexOf('\n', position)
    if (newline < 0) return text.length
    position = newline + 1
  }
  return position
}

/** 客户端裁剪后的请求文档与光标位置。 */
export interface CroppedRequestDocument {
  document: string
  /** 行号 1 起、列 1 起；被丢掉的整行会把行号前移。 */
  rewriteAt: { line: number; column: number }
  /** 是否真的裁过；false 表示原样发送（小文件或极端兜底）。 */
  cropped: boolean
  /** 为对齐光标而丢掉的前缀行数，便于观测。 */
  droppedLines: number
}

/**
 * 把随请求发送的文档裁成「光标附近窗口」。
 *
 * 宿主 `runCompletion` 会先对请求里的 document 做 `truncateDocument`，再交给 `assemblePrompt`
 * 取前/后缀。这里先复用同一个 `truncateDocument` 得到宿主真正会看到的那段文档，再从里面切一个
 * 更小的窗口，并同步换算 `rewriteAt`。这样宿主对收到的文档再裁一次是幂等的，
 * `assemblePrompt` 算出的 prefix / suffix / prompt 与发送全量文档时逐字节相同（等价性由测试钉住）。
 *
 * 窗口取法：
 *   - 前缀：至少覆盖 `prefixChars` 字符、`prefixLines` 行、`RETRIEVAL_QUERY_LINES` 行检索窗口
 *     与光标所在行行首；行首是为了让 `assemblePrompt` 的 `indentOf(rawPrefix)` 不变。
 *   - 后缀：覆盖前 `SUFFIX_BLOCK_SCAN_LINES` 段，让宿主的 `suffixFromBlockBoundary` 扫描
 *     结果与全量文档一致；同时至少覆盖 `suffixChars` 字符。
 *   - 单行超长文件：没有行可对齐，按字符裁剪并把列号前移。
 *
 * 已知残留差异（见报告）：检索查询依赖「光标前 30 行 + 当前行前缀」。当文档超长到宿主
 * `truncateDocument` 的字符封顶把光标所在行挤出去（超长单行/极长行）时，检索 query 可能与
 * 全量文档不同；补全 prompt 本身仍逐字节一致。安全扫描只作用于模型输出，不依赖文档。
 */
export function cropDocumentForRequest(document: string, rewriteAt: { line: number; column: number }, params: CompletionParams = DEFAULT_COMPLETION_PARAMS): CroppedRequestDocument {
  // 小文件原样发送：窗口本身就是前后缀预算之和，不为几微秒改变请求形状。
  if (document.length <= params.prefixChars + params.suffixChars) {
    return { document, rewriteAt, cropped: false, droppedLines: 0 }
  }

  const truncated = truncateDocument(document, rewriteAt, params)
  const offset = offsetAt(truncated.document, truncated.rewriteAt.line, truncated.rewriteAt.column)
  // 列号从 1 起；列 0 是历史测试里的写法，按 offsetAt 的 max(0, column-1) 语义落回行首。
  const lineStart = Math.max(0, offset - Math.max(0, truncated.rewriteAt.column - 1))
  const singleLine = truncated.document.indexOf('\n') === -1

  let start = Math.max(0, offset - params.prefixChars)
  if (!singleLine) {
    // 光标行行首：保证 indentOf(rawPrefix) 与全量文档一致（suffixFromBlockBoundary 依赖它）。
    start = Math.min(start, lineStart)
    const prefixLineCount = 1 + countNewlines(truncated.document.slice(0, offset))
    if (prefixLineCount > params.prefixLines) {
      start = Math.min(start, lineStartBefore(truncated.document, offset, Math.max(0, params.prefixLines - 1)))
    }
    start = Math.min(start, lineStartBefore(truncated.document, offset, RETRIEVAL_QUERY_LINES))
  }
  start = Math.max(0, start)

  const suffixHasNewline = truncated.document.indexOf('\n', offset) !== -1
  const wantedEnd = suffixHasNewline
    ? Math.max(offset + params.suffixChars, endOfLineParts(truncated.document, offset, SUFFIX_BLOCK_SCAN_LINES))
    : offset + params.suffixChars
  const end = Math.min(truncated.document.length, Math.max(offset, wantedEnd))
  let windowDocument = truncated.document.slice(start, end)
  let windowStart = start
  if (windowDocument.length === 0 || windowDocument.length > params.documentChars) {
    // 极端参数/长行：裁掉的头寸有限，退回宿主本来就会看到的整段，保证行为完全一致。
    windowDocument = truncated.document
    windowStart = 0
  }
  if (windowStart === 0) {
    return { document: windowDocument, rewriteAt: truncated.rewriteAt, cropped: windowDocument.length !== document.length, droppedLines: 0 }
  }

  let column = truncated.rewriteAt.column
  // 只有单行超长的字符裁剪会切进光标所在行；此时列号随丢掉的字符前移，下限是 1。
  if (windowStart > lineStart) column = Math.max(1, column - (windowStart - lineStart))
  const droppedLines = countNewlines(truncated.document.slice(0, windowStart))
  return {
    document: windowDocument,
    rewriteAt: { line: Math.max(1, truncated.rewriteAt.line - droppedLines), column },
    cropped: true,
    droppedLines,
  }
}

/**
 * 组装上下文段。
 *
 * 按文档给的丢弃优先级从低到高判断：先丢仓库级上下文，再丢检索片段，再丢符号定义，
 * 最后才动编辑历史；前后缀属于生成必要输入，不在这里处理。
 */
export function assembleContext(input: PromptInput, budgetChars: number, symbolBudgetChars = Number.POSITIVE_INFINITY): { context: string; dropped: string[] } {
  const dropped: string[] = []
  // 顺序即优先级：越靠前越先被丢。丢弃单位是整类，不做类内截断 —— 半条编辑历史没有意义。
  const parts: Array<{ label: string; text: string }> = []
  if (input.repositoryContext !== undefined && input.repositoryContext.trim() !== '') parts.push({ label: '仓库级上下文', text: input.repositoryContext })
  for (const snippet of input.snippets ?? []) if (snippet.trim() !== '') parts.push({ label: '检索片段', text: snippet })
  // 符号定义有独立的小额度（文档 5.4：符号占一成余），超出额度的那部分按类丢弃。
  let symbolChars = 0
  for (const symbol of input.symbols ?? []) {
    if (symbol.trim() === '') continue
    symbolChars += symbol.length
    if (symbolChars > symbolBudgetChars) { dropped.push('符号定义'); continue }
    parts.push({ label: '符号定义', text: symbol })
  }
  const history = (input.edits ?? []).map(entry => `- 改前：${entry.before}\n  改后：${entry.after}`).join('\n')
  if (history !== '') parts.push({ label: '编辑历史', text: history })

  const sizeOf = (part: { label: string; text: string }): number => part.text.length + part.label.length + 8
  const kept = [...parts]
  let used = kept.reduce((sum, part) => sum + sizeOf(part), 0)
  // 超预算时按优先级从低到高整类丢弃，直到塞得下；丢完了还超就交给前缀/后缀的裁剪去处理。
  while (used > budgetChars && kept.length > 1) {
    const gone = kept.shift()
    if (gone !== undefined) { dropped.push(gone.label); used -= sizeOf(gone) }
  }
  if (used > budgetChars && kept.length === 1) {
    const only = kept[0]
    if (only !== undefined) { dropped.push(only.label); kept.length = 0 }
  }
  const rendered = kept.map(part => part.label === '编辑历史' ? `# 最近的编辑\n${part.text}` : `# ${part.label}\n${part.text}`)
  return { context: rendered.join('\n\n'), dropped }
}

/** 按 profile 的排布方式把三段拼成一个 prompt。 */
export function renderPrompt(prefix: string, suffix: string, profile: PromptProfile): string {
  const { markers } = profile
  if (profile.layout === 'begin-hole-end') {
    return `${markers.prefix}${prefix}${markers.middle}${suffix}${markers.suffix}`
  }
  if (profile.layout === 'instruction') {
    return [
      '你是代码补全引擎。只输出应当插入在光标处的内容，不要解释，不要加代码块围栏，不要复述光标之前已经写过的代码，也不要重复光标之后已有的代码。',
      '如果补不出内容，输出空行。',
      '',
      `光标位置标为 ${CURSOR_MARKER}。`,
      '',
      '<代码>',
      `${prefix}${CURSOR_MARKER}${suffix}`,
      '</代码>',
    ].join('\n')
  }
  return `${markers.prefix}${prefix}${markers.suffix}${suffix}${markers.middle}`
}

/**
 * 组装一次补全请求的完整 prompt。
 *
 * 生成段里保留文件路径标记：模型据此判断语言与项目约定，这一条在文档的序列结构里是显式给出的。
 */
export function assemblePrompt(input: PromptInput, params: CompletionParams = DEFAULT_COMPLETION_PARAMS, profile: PromptProfile = DEFAULT_PROMPT_PROFILE): PromptResult {
  const offset = offsetAt(input.document, input.rewriteAt.line, input.rewriteAt.column)
  const rawPrefix = input.document.slice(0, offset)
  let rawSuffix = input.document.slice(offset)
  if (profile.suffixFromBlockBoundary) rawSuffix = suffixFromBlockBoundary(rawSuffix, indentOf(rawPrefix))

  const prefix = truncatePrefix(rawPrefix, params)
  const suffix = truncateSuffix(rawSuffix, params)

  const totalBudget = charBudgetForPrompt(params)
  // 上下文段拿到的是「总预算减去前后缀实际占用」：前后缀是生成必要输入（文档 6.2 里它们的裁剪优先级
  // 最低，但也不能被上下文挤掉），剩下的才分给片段、符号与编辑历史。
  const contextBudget = Math.max(0, totalBudget - prefix.length - suffix.length)
  // 符号定义另有一成额度（文档 5.4 的比例分配）。
  const { context, dropped } = assembleContext(input, contextBudget, Math.floor(totalBudget * 0.1))
  const generation = `# 文件：${input.filePath}\n${renderPrompt(prefix, suffix, profile)}`
  const prompt = context === '' ? generation : `${context}\n\n${generation}`

  return { prompt, prefix, suffix, dropped, chars: prompt.length, snippetCount: input.snippets?.length ?? 0 }
}
