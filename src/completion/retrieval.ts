/**
 * 本地向量索引与检索（文档 5.3、5.4）。
 *
 * 存储形态：按项目分库 —— 一个工作区根目录对应一个索引文件，内容是块 + 向量 + 文件指纹。
 * 没有用 SQLite：插件宿主在桌面端跑在 Electron 的 Node 里，`node:sqlite` 不保证存在；而索引规模
 * 由上限约束（文件数、块数、总量），暴力余弦在这个量级是毫秒级。存储与检索都在 `RetrievalIndex`
 * 这一个接口后面，要换成嵌入式向量库时替换它即可。
 *
 * 维护策略按文档 5.3：首次全量、按周期重建、文件变更增量更新、预算上限封顶。
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DEFAULT_CHUNK_LIMITS, extractChunks, shouldSkipFile, type Chunk, type ChunkLimits } from './chunks.ts'
import { cosineSimilarity, hashingEmbedder, tokenizeCode, type Embedder } from './embedding.ts'

export interface IndexLimits {
  maxFiles: number
  maxChunks: number
}

export const DEFAULT_INDEX_LIMITS: IndexLimits = { maxFiles: 4000, maxChunks: 12000 }

export interface RetrievalOptions {
  /** 一个项目一个索引文件。 */
  storePath: string
  embedder?: Embedder
  chunkLimits?: ChunkLimits
  indexLimits?: IndexLimits
  /** 注入的片段条数（文档建议 3 至 5 条）。 */
  snippetCount: number
  /** 单片段字符上限（文档建议 3000 字符量级）。 */
  snippetChars: number
  /** 相似度下限（文档建议 0.7 起步）。 */
  similarityThreshold: number
  /** 全量重建周期（文档建议 24 小时）。 */
  rebuildIntervalMs: number
}

export interface IndexStatus {
  storePath: string
  embedder: string
  files: number
  chunks: number
  /** 索引构建时间；0 表示尚未构建。 */
  builtAt: number
  stale: boolean
  /** 当前生效的容量上限。触顶后新增的文件与分块会被跳过。 */
  limits: IndexLimits
  /** 是否已达上限：为真时索引不完整，检索质量会低于索引规模所暗示的水平。 */
  capped: boolean
}

/** 检索命中：只带位置与分数，正文由调用方按行范围去读（索引不复制仓库内容）。 */
export interface RetrievedSnippet {
  path: string
  kind: Chunk['kind']
  name?: string
  startLine: number
  endLine: number
  score: number
}

/** 常见语言关键字与类型名：它们几乎出现在每个分块里，不构成「相关」的证据。 */
const COMMON_TOKENS = new Set([
  'const', 'let', 'var', 'function', 'return', 'import', 'export', 'default', 'async', 'await',
  'class', 'interface', 'type', 'enum', 'extends', 'implements', 'public', 'private', 'protected',
  'static', 'readonly', 'string', 'number', 'boolean', 'void', 'null', 'undefined', 'true', 'false',
  'this', 'super', 'new', 'typeof', 'instanceof', 'while', 'for', 'switch', 'case', 'break',
  'catch', 'finally', 'throw', 'error', 'value', 'items', 'index', 'length', 'name', 'path', 'text',
])

/** 片段正文的取用键：同一文件的不同行范围必须能区分开。 */
export function snippetKey(snippet: Pick<RetrievedSnippet, 'path' | 'startLine' | 'endLine'>): string {
  return `${snippet.path}:${snippet.startLine}-${snippet.endLine}`
}

/**
 * 分块内容哈希（文档 5.2 的去重依据）。
 *
 * 用 SHA-1 而不是短哈希：短哈希碰撞会让一段合法代码被当成重复丢掉，而这里哈希只是内存与
 * 索引文件里的一份字符串，代价可以忽略。
 */
const hashOf = (text: string): string => createHash('sha1').update(text).digest('hex')

type StoredChunk = Omit<Chunk, 'text' | 'embeddingText' | 'language'> & {
  vector: string
  /** 正文词元（去重、限量）：检索阶段拿不到正文，靠它判断查询与这个分块是否真的重合。 */
  tokens?: string[]
  /** 内容哈希：文档 5.2 要求同一实体在多处出现时只保留一个，靠它判重。 */
  hash: string
}

/** 向量按 Float32 的 base64 落盘：JSON 数组里每个分量约 19 个字符，实测索引体积的绝大部分是它。 */
export function encodeVector(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64')
}

export function decodeVector(encoded: string): Float32Array {
  const buffer = Buffer.from(encoded, 'base64')
  return new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4))
}

interface StoreFile {
  version: 3
  embedder: string
  builtAt: number
  files: Record<string, { mtimeMs: number; size: number; chunks: number }>
  chunks: StoredChunk[]
}

/**
 * 从光标附近的代码构造查询（文档 5.3 第 1 条）。
 *
 * 取光标所在行向前后各若干行：既要标识符与字面量，也要保留原始文本片段 —— 只取标识符会丢掉
 * 「这些标识符是怎么组合的」这一层信息。
 */
export function buildQuery(document: string, line: number, column: number, windowLines = 30): string {
  const lines = document.split('\n')
  const cursor = Math.max(0, Math.min(line - 1, lines.length - 1))
  const start = Math.max(0, cursor - windowLines)
  const end = Math.min(lines.length, cursor + 2)
  // 列号从 1 起：列 1 对应行首，取光标前文本要减一，否则会把光标后的第一个字符也算进来。
  const before = (lines[cursor] ?? '').slice(0, Math.max(0, column - 1))
  const recent = lines.slice(start, cursor).join('\n')
  // 最近编辑的行权重最高：单独重复一次，让它在向量里占更大比重。
  return `${before}\n${before}\n${recent}`
}

export class RetrievalIndex {
  private readonly embedder: Embedder
  private readonly chunkLimits: ChunkLimits
  private readonly limits: IndexLimits
  private readonly options: RetrievalOptions
  private stored = new Map<string, StoredChunk[]>()
  /** 已入库分块的内容哈希：文档 5.2 的去重依据。重建与载入时一并恢复。 */
  private readonly hashes = new Set<string>()
  private files = new Map<string, { mtimeMs: number; size: number; chunks: number }>()
  private builtAt = 0
  private dirty = false

  constructor(options: RetrievalOptions) {
    this.options = options
    this.embedder = options.embedder ?? hashingEmbedder()
    this.chunkLimits = options.chunkLimits ?? DEFAULT_CHUNK_LIMITS
    this.limits = options.indexLimits ?? DEFAULT_INDEX_LIMITS
  }

  status(now = Date.now()): IndexStatus {
    let chunks = 0
    for (const list of this.stored.values()) chunks += list.length
    return {
      storePath: this.options.storePath,
      embedder: this.embedder.id,
      files: this.stored.size,
      chunks,
      builtAt: this.builtAt,
      stale: this.builtAt === 0 || now - this.builtAt > this.options.rebuildIntervalMs,
      limits: this.limits,
      capped: this.stored.size >= this.limits.maxFiles || chunks >= this.limits.maxChunks,
    }
  }

  /** 从磁盘载入索引；文件不存在或版本不符时当作空索引。 */
  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.options.storePath, 'utf8')) as StoreFile
      // 版本不符就当作空索引：旧索引里没有内容哈希，无法迁移，重建比猜测便宜。
      if (parsed.version !== 3 || parsed.embedder !== this.embedder.id) return
      this.builtAt = parsed.builtAt
      this.files = new Map(Object.entries(parsed.files))
      this.stored = new Map()
      this.hashes.clear()
      for (const chunk of parsed.chunks) {
        const list = this.stored.get(chunk.path) ?? []
        list.push(chunk)
        this.stored.set(chunk.path, list)
        this.hashes.add(chunk.hash)
      }
    } catch { /* 首次运行没有索引文件，或文件损坏：都从空索引开始。 */ }
  }

  async save(): Promise<void> {
    if (!this.dirty) return
    const chunks: StoredChunk[] = []
    for (const list of this.stored.values()) chunks.push(...list)
    const payload: StoreFile = { version: 3, embedder: this.embedder.id, builtAt: this.builtAt, files: Object.fromEntries(this.files), chunks }
    await mkdir(dirname(this.options.storePath), { recursive: true })
    await writeFile(this.options.storePath, JSON.stringify(payload), 'utf8')
    this.dirty = false
  }

  /** 该重建吗：空索引、超过周期，或调用方要求强制。 */
  needsRebuild(now = Date.now()): boolean {
    return this.builtAt === 0 || now - this.builtAt > this.options.rebuildIntervalMs
  }

  /**
   * 这个文件需要重读吗。
   *
   * 增量扫描先问后读：mtime 与大小都没变就不必把文件内容读进来，这是「文件变更时增量更新」
   * （文档 5.3）在有上限的索引预算下真正省时间的地方。
   */
  needsUpdate(path: string, mtimeMs: number, size: number): boolean {
    const previous = this.files.get(path)
    return previous === undefined || previous.mtimeMs !== mtimeMs || previous.size !== size
  }

  /** 索引（或跳过）一个文件；mtime 与大小都没变则视为未变，直接跳过重建向量。 */
  update(file: { path: string; language: string; text: string; mtimeMs: number; size: number }): 'indexed' | 'skipped' | 'unchanged' {
    const previous = this.files.get(file.path)
    if (previous !== undefined && previous.mtimeMs === file.mtimeMs && previous.size === file.size) return 'unchanged'
    if (!this.stored.has(file.path) && this.stored.size >= this.limits.maxFiles) return 'skipped'
    const reason = shouldSkipFile(file.size, file.text, this.chunkLimits)
    if (reason !== undefined) {
      this.stored.delete(file.path)
      this.files.delete(file.path)
      this.dirty = true
      return 'skipped'
    }
    let totalChunks = 0
    for (const list of this.stored.values()) totalChunks += list.length
    if (totalChunks >= this.limits.maxChunks) return 'skipped'

    // 先按内容判重，再算向量：重复的分块连嵌入都不必做。
    // 判重时的写入发生在过滤这一步，同一文件内部的重复也因此被挡掉（同一个函数体常常既落入
    // 实体分块、又落入窗口分块）。
    const seen = this.hashes
    const unique = extractChunks(file.path, file.language, file.text, this.chunkLimits).filter(chunk => {
      const hash = hashOf(chunk.embeddingText)
      if (seen.has(hash)) return false
      seen.add(hash)
      return true
    })
    const chunks = unique.map<StoredChunk>(chunk => ({
      path: chunk.path,
      kind: chunk.kind,
      ...(chunk.name === undefined ? {} : { name: chunk.name }),
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      hash: hashOf(chunk.embeddingText),
      tokens: Array.from(new Set(tokenizeCode(chunk.embeddingText))).slice(0, 48),
      vector: encodeVector(this.embedder.embed(chunk.embeddingText)),
    }))
    // 全部被去重掉的文件也要记一笔：否则每次扫描都会重新读它再判一次重复。
    this.stored.set(file.path, chunks)
    this.files.set(file.path, { mtimeMs: file.mtimeMs, size: file.size, chunks: chunks.length })
    this.builtAt = Date.now()
    this.dirty = true
    return chunks.length === 0 ? 'skipped' : 'indexed'
  }

  remove(path: string): void {
    // 一并释放内容哈希，否则这个文件腾出来的位置再也放不进别的分块。
    for (const chunk of this.stored.get(path) ?? []) this.hashes.delete(chunk.hash)
    if (this.stored.delete(path)) { this.dirty = true }
    if (this.files.delete(path)) { this.dirty = true }
  }

  clear(): void {
    this.stored.clear()
    this.files.clear()
    this.hashes.clear()
    this.builtAt = 0
    this.dirty = true
  }

  /**
   * 检索：先按余弦召回，再按「余弦 + 词级 Jaccard」重排（文档 5.3 第 4 条、5.4）。
   *
   * 排除当前正在编辑的文件：它的内容已经在前缀里了，片段上下文的价值在于跨文件复用模式。
   */
  search(query: string, excludePath?: string, now = Date.now()): RetrievedSnippet[] {
    const queryVector = this.embedder.embed(query)
    // 只留有区分度的查询词元：短词与语言关键字几乎出现在每个分块里，拿它们判重合没有意义。
    const queryTokens = new Set(tokenizeCode(query).filter(token => token.length >= 4 && !COMMON_TOKENS.has(token.toLowerCase())))
    const scored: Array<{ chunk: StoredChunk; cosine: number; score: number }> = []
    for (const [path, list] of this.stored) {
      if (path === excludePath) continue
      for (const chunk of list) {
        // 单行片段不注入：它给不出可复用的模式，而哈希嵌入对短文本的余弦偏高，反而容易挤掉真正相关的多行片段。
        if (chunk.endLine - chunk.startLine < 1) continue
        // 打分以正文词元的重合为主：哈希嵌入只给一个很弱的语义信号，重合度才是可靠的那一半。
        const overlap = queryTokens.size === 0
          ? 0
          : [...queryTokens].filter(token => chunk.tokens?.includes(token) === true).length / queryTokens.size
        const cosine = cosineSimilarity(queryVector, decodeVector(chunk.vector))
        if (cosine < this.options.similarityThreshold) continue
        // 门槛只落在重合度上 —— 一个词元都不重合的分块不是「相关代码」，只是碰巧向量近。
        if (queryTokens.size > 0 && overlap === 0) continue
        const rerank = 0.5 * cosine + 0.5 * overlap
        scored.push({ chunk, cosine, score: rerank })
      }
    }
    scored.sort((left, right) => right.score - left.score)
    return scored.slice(0, this.options.snippetCount).map(({ chunk, score }) => ({
      path: chunk.path,
      kind: chunk.kind,
      ...(chunk.name === undefined ? {} : { name: chunk.name }),
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      score: Number(score.toFixed(4)),
    }))
  }

  /** 单片段字符上限，供调用方按同一口径截断。 */
  get snippetChars(): number {
    return this.options.snippetChars
  }
}

/**
 * 把检索结果与取回的正文拼成注入 prompt 的片段文本。
 *
 * `texts` 按 `snippetKey` 取用：同一文件的不同行范围是不同的键，不会互相覆盖。
 */
export function formatSnippets(snippets: readonly RetrievedSnippet[], texts: ReadonlyMap<string, string>, maxChars: number): string[] {
  const out: string[] = []
  for (const snippet of snippets) {
    const body = texts.get(snippetKey(snippet))
    if (body === undefined) continue
    const header = `// ${snippet.path}:${snippet.startLine}-${snippet.endLine}${snippet.name === undefined ? '' : ` (${snippet.kind} ${snippet.name})`}`
    out.push(`${header}\n${body.length > maxChars ? body.slice(0, maxChars) : body}`)
  }
  return out
}


