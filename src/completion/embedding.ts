/**
 * 本地嵌入与相似度打分（文档 5.3、5.4）。
 *
 * 嵌入是本地做的，代码不出机器：这里用特征哈希把「标识符、字面量、字符三连」映射成定长稠密向量，
 * 再做 L2 归一化。它是可直接离线跑的嵌入，不需要下载模型、不产生网络往返；换成真正的代码嵌入模型时，
 * 只需实现同一个 `Embedder` 接口，检索与存储层不用改。
 *
 * 打分同时提供余弦与 Jaccard 两个族：文档 5.4 允许二选一，余弦做召回、Jaccard 做重排是常见搭配。
 */
export interface Embedder {
  id: string
  dimensions: number
  embed(text: string): Float32Array
}

/** 把代码切成查询与嵌入用的词元：标识符按驼峰与下划线拆开，另收字面量。 */
export function tokenizeCode(text: string): string[] {
  const tokens: string[] = []
  const pattern = /[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[0]
    if (raw.startsWith('"') || raw.startsWith("'") || raw.startsWith('`')) {
      tokens.push(raw.slice(1, -1))
      continue
    }
    // 驼峰与下划线拆分：useState → use, state；snake_case → snake, case。
    const parts = raw.split(/[_\s]+/).flatMap(part => part.split(/(?=[A-Z])/).map(value => value.toLowerCase())).filter(value => value !== '')
    tokens.push(...parts)
  }
  return tokens
}

/** 字符 n 连：中文标识符、拼接字符串这类词元切不干净的内容靠它兜住。 */
export function charNGrams(text: string, size = 3): string[] {
  const normalized = text.replace(/\s+/g, ' ')
  const grams: string[] = []
  for (let index = 0; index + size <= normalized.length; index++) grams.push(normalized.slice(index, index + size))
  return grams
}

/** 稳定的 32 位哈希：同一输入在任何进程里都得到同一结果，便于索引落盘后复用。 */
export function hashFeature(feature: string): number {
  let hash = 2166136261
  for (let index = 0; index < feature.length; index++) {
    hash ^= feature.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export const DEFAULT_EMBEDDING_DIMENSIONS = 256

/**
 * 特征哈希嵌入。
 *
 * 词频取次线性（1 + log tf），避免长文件在向量里压过短文件；负号哈希用于抵消碰撞的系统性偏移，
 * 这是哈希技巧的常规做法。
 */
export function hashingEmbedder(dimensions = DEFAULT_EMBEDDING_DIMENSIONS): Embedder {
  return {
    id: `hashing-${dimensions}`,
    dimensions,
    embed(text: string): Float32Array {
      const vector = new Float32Array(dimensions)
      const counts = new Map<string, number>()
      for (const token of tokenizeCode(text)) counts.set(`w:${token}`, (counts.get(`w:${token}`) ?? 0) + 1)
      for (const gram of charNGrams(text)) counts.set(`g:${gram}`, (counts.get(`g:${gram}`) ?? 0) + 1)
      for (const [feature, count] of counts) {
        const hash = hashFeature(feature)
        const index = hash % dimensions
        const sign = (hash & 0x80000000) === 0 ? 1 : -1
        vector[index] = (vector[index] ?? 0) + sign * (1 + Math.log(count))
      }
      return l2Normalize(vector)
    },
  }
}

/** 就地做 L2 归一化；零向量原样返回（余弦相似度此时定义为 0）。 */
export function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0
  for (const value of vector) sum += value * value
  if (sum === 0) return vector
  const norm = Math.sqrt(sum)
  for (let index = 0; index < vector.length; index++) vector[index] = (vector[index] ?? 0) / norm
  return vector
}

/** 余弦相似度。输入已归一化时就是点积；这里不假设已归一化。 */
export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length)
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < length; index++) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

/** 词级 Jaccard：把两边切成词元集合后比交集。 */
export function jaccardWord(left: string, right: string): number {
  const a = new Set(tokenizeCode(left))
  const b = new Set(tokenizeCode(right))
  return jaccardOfSets(a, b)
}

/** 字符级 Jaccard：对标识符不敏感、但能抓住整体写法相似的内容。 */
export function jaccardChar(left: string, right: string, size = 3): number {
  const a = new Set(charNGrams(left, size))
  const b = new Set(charNGrams(right, size))
  return jaccardOfSets(a, b)
}

function jaccardOfSets(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let intersection = 0
  for (const value of a) if (b.has(value)) intersection++
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}
