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
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DEFAULT_CHUNK_LIMITS, extractChunks, shouldSkipFile, type Chunk, type ChunkLimits } from './chunks.ts'
import { cosineSimilarity, hashingEmbedder, jaccardWord, tokenizeCode, type Embedder } from './embedding.ts'

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

/** 片段正文的取用键：同一文件的不同行范围必须能区分开。 */
export function snippetKey(snippet: Pick<RetrievedSnippet, 'path' | 'startLine' | 'endLine'>): string {
  return `${snippet.path}:${snippet.startLine}-${snippet.endLine}`
}

type StoredChunk = Omit<Chunk, 'text' | 'embeddingText' | 'language'> & { vector: string }

/** 向量按 Float32 的 base64 落盘：JSON 数组里每个分量约 19 个字符，实测索引体积的绝大部分是它。 */
export function encodeVector(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64')
}

export function decodeVector(encoded: string): Float32Array {
  const buffer = Buffer.from(encoded, 'base64')
  return new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4))
}

interface StoreFile {
  version: 1
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
  const before = (lines[cursor] ?? '').slice(0, Math.max(0, column))
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
    }
  }

  /** 从磁盘载入索引；文件不存在或版本不符时当作空索引。 */
  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.options.storePath, 'utf8')) as StoreFile
      if (parsed.version !== 1 || parsed.embedder !== this.embedder.id) return
      this.builtAt = parsed.builtAt
      this.files = new Map(Object.entries(parsed.files))
      this.stored = new Map()
      for (const chunk of parsed.chunks) {
        const list = this.stored.get(chunk.path) ?? []
        list.push(chunk)
        this.stored.set(chunk.path, list)
      }
    } catch { /* 首次运行没有索引文件，或文件损坏：都从空索引开始。 */ }
  }

  async save(): Promise<void> {
    if (!this.dirty) return
    const chunks: StoredChunk[] = []
    for (const list of this.stored.values()) chunks.push(...list)
    const payload: StoreFile = { version: 1, embedder: this.embedder.id, builtAt: this.builtAt, files: Object.fromEntries(this.files), chunks }
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

    const chunks = extractChunks(file.path, file.language, file.text, this.chunkLimits).map<StoredChunk>(chunk => ({
      path: chunk.path,
      kind: chunk.kind,
      ...(chunk.name === undefined ? {} : { name: chunk.name }),
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      vector: encodeVector(this.embedder.embed(chunk.embeddingText)),
    }))
    if (chunks.length === 0) return 'skipped'
    this.stored.set(file.path, chunks)
    this.files.set(file.path, { mtimeMs: file.mtimeMs, size: file.size, chunks: chunks.length })
    this.builtAt = Date.now()
    this.dirty = true
    return 'indexed'
  }

  remove(path: string): void {
    if (this.stored.delete(path)) { this.dirty = true }
    if (this.files.delete(path)) { this.dirty = true }
  }

  clear(): void {
    this.stored.clear()
    this.files.clear()
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
    const queryTokens = new Set(tokenizeCode(query))
    const scored: Array<{ chunk: StoredChunk; cosine: number; score: number }> = []
    for (const [path, list] of this.stored) {
      if (path === excludePath) continue
      for (const chunk of list) {
        const cosine = cosineSimilarity(queryVector, decodeVector(chunk.vector))
        if (cosine < this.options.similarityThreshold) continue
        // 重排用两族的加权和：余弦看整体语义，Jaccard 看词元重合。
        const rerank = 0.7 * cosine + 0.3 * jaccardOfTokens(queryTokens, new Set(tokenizeCode(`${chunk.path} ${chunk.name ?? ''}`)))
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

function jaccardOfTokens(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const token of left) if (right.has(token)) intersection++
  const union = left.size + right.size - intersection
  return union === 0 ? 0 : intersection / union
}

/** 供测试与调试：词级相似度的直通实现。 */
export const wordSimilarity = jaccardWord
