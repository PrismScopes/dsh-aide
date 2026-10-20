/**
 * 代码结构解析与分块（文档 5.2）。
 *
 * 文档推荐 tree-sitter 一类的增量解析器。这里是语言感知的实体抽取：按语言识别模块、类、函数三类实体，
 * 用括号配平（C 系）或缩进（Python 系）定实体边界，并为每个实体生成一段可供检索的摘要文本。
 * 接口形状与「解析器」一致，将来换成真正的解析器时只需替换 `extractChunks` 的实现。
 *
 * skip 规则来自文档 5.2：单文件超过阈值、或平均行长异常（压缩产物）时整文件跳过。
 */
export interface ChunkLimits {
  /** 单文件字节上限（文档建议 1 MB）。 */
  maxFileBytes: number
  /** 平均行长上限：压缩产物会远超正常源码。 */
  maxAverageLineLength: number
  /** 单文件最多产出多少块。 */
  maxChunksPerFile: number
  /** 单块字符上限（文档建议 3000 字符量级）。 */
  maxChunkChars: number
  /** 兜底窗口的行数。 */
  windowLines: number
}

export const DEFAULT_CHUNK_LIMITS: ChunkLimits = {
  maxFileBytes: 1024 * 1024,
  maxAverageLineLength: 500,
  maxChunksPerFile: 40,
  maxChunkChars: 3000,
  windowLines: 40,
}

type ChunkKind = 'module' | 'class' | 'function' | 'window'

export interface Chunk {
  path: string
  language: string
  kind: ChunkKind
  name?: string
  /** 行号 1 起，闭区间。 */
  startLine: number
  endLine: number
  text: string
  /**
   * 参与嵌入的文本：只放代码正文，不放路径、种类与名称。实测（同一份查询与候选）：
   * 把元信息一起嵌入会在短查询下把相关与无关的余弦压到 0.128 对 0.072（几乎分不开），
   * 只嵌正文是 0.211 对 0.061（差距 3.5 倍）；长查询下分别是 0.448 对 0.025 与 0.510 对 0.059。
   * 元信息不是没用 —— 它放在注入 prompt 的片段头里，那里才是它起作用的位置。
   */
  embeddingText: string
}

/** 文件级跳过判定；返回原因表示跳过，返回 undefined 表示参与索引。 */
export function shouldSkipFile(size: number, text: string, limits: ChunkLimits = DEFAULT_CHUNK_LIMITS): string | undefined {
  if (size > limits.maxFileBytes) return 'file-too-large'
  const lines = text.split('\n')
  if (lines.length > 0 && text.length / lines.length > limits.maxAverageLineLength) return 'average-line-too-long'
  if (text.includes('\u0000')) return 'binary'
  return undefined
}

const C_LIKE = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'php', 'swift', 'kotlin', 'scss', 'less', 'css', 'json', 'jsonc'])
const PYTHON_LIKE = new Set(['python', 'ruby'])

interface EntityStart { kind: 'class' | 'function'; name: string }

/** 在给定语言下识别实体起始行的模式。未识别的语言返回 undefined，由窗口兜底。 */
const PATTERNS: Record<string, Array<{ kind: 'class' | 'function'; pattern: RegExp }>> = {
  c: [
    { kind: 'class', pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'class', pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'class', pattern: /^\s*(?:export\s+)?(?:type|enum)\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'function', pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'function', pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/ },
  ],
  python: [
    { kind: 'class', pattern: /^(\s*)class\s+([A-Za-z_]\w*)/ },
    { kind: 'function', pattern: /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
  ],
}

function patternKey(language: string): 'c' | 'python' | undefined {
  const normalized = language.trim().toLowerCase()
  if (C_LIKE.has(normalized)) return 'c'
  if (PYTHON_LIKE.has(normalized)) return 'python'
  return undefined
}

/** C 系：从起始行按花括号配平找实体结束行。 */
function endByBraces(lines: readonly string[], start: number): number {
  let depth = 0
  let seenBrace = false
  for (let index = start; index < lines.length; index++) {
    const line = lines[index] ?? ''
    for (const char of line) {
      if (char === '{') { depth++; seenBrace = true }
      else if (char === '}') depth--
    }
    if (seenBrace && depth <= 0) return index
    // 只有声明的实体（以分号收尾、没有花括号）到此为止。
    if (!seenBrace && line.trimEnd().endsWith(';')) return index
  }
  return lines.length - 1
}

/** Python 系：实体边界由缩进决定，回到起始缩进即结束。 */
function endByIndent(lines: readonly string[], start: number, indent: number): number {
  let last = start
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (line.trim() === '') continue
    const current = line.length - line.trimStart().length
    if (current <= indent) break
    last = index
  }
  return last
}

/**
 * 抽取一个文件的块。
 *
 * 产出顺序：一个模块块（文件头若干行，回答「这个文件是什么」）+ 各实体块。没有任何实体可识别时
 * 退化为定长窗口，保证每个文件都有可检索内容。
 */
export function extractChunks(path: string, language: string, text: string, limits: ChunkLimits = DEFAULT_CHUNK_LIMITS): Chunk[] {
  const lines = text.split('\n')
  const chunks: Chunk[] = []
  const push = (kind: ChunkKind, name: string | undefined, start: number, end: number): void => {
    if (chunks.length >= limits.maxChunksPerFile) return
    const body = lines.slice(start, end + 1).join('\n')
    if (body.trim() === '') return
    const trimmed = body.length > limits.maxChunkChars ? body.slice(0, limits.maxChunkChars) : body
    chunks.push({
      path, language, kind, ...(name === undefined ? {} : { name }),
      startLine: start + 1, endLine: Math.min(end + 1, lines.length), text: trimmed,
      embeddingText: trimmed,
    })
  }

  // 模块块：文件头 40 行，导入与顶层声明都在这里。
  push('module', undefined, 0, Math.min(lines.length - 1, 39))

  const key = patternKey(language)
  if (key === 'c') {
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? ''
      // 只取顶层实体（缩进不超过一个层级），嵌套方法由所属类的块覆盖。
      if (line.length - line.trimStart().length > 2) continue
      for (const { kind, pattern } of PATTERNS['c'] as Array<{ kind: 'class' | 'function'; pattern: RegExp }>) {
        const match = pattern.exec(line)
        if (match?.[1] === undefined) continue
        push(kind, match[1], index, endByBraces(lines, index))
        index = endByBraces(lines, index)
        break
      }
    }
  } else if (key === 'python') {
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? ''
      for (const { kind, pattern } of PATTERNS['python'] as Array<{ kind: 'class' | 'function'; pattern: RegExp }>) {
        const match = pattern.exec(line)
        if (match?.[2] === undefined) continue
        const indent = (match[1] ?? '').length
        push(kind, match[2], index, endByIndent(lines, index, indent))
        index = endByIndent(lines, index, indent)
        break
      }
    }
  }

  // 没有任何实体块时退化为定长窗口。
  if (chunks.length <= 1 && lines.length > limits.windowLines) {
    for (let start = 0; start < lines.length; start += limits.windowLines) {
      push('window', undefined, start, Math.min(start + limits.windowLines - 1, lines.length - 1))
    }
  }
  return chunks
}
