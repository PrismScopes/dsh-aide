import { describe, expect, it } from 'vitest'
import { cosineSimilarity, hashingEmbedder, jaccardChar, jaccardWord, l2Normalize, tokenizeCode } from '../src/completion/embedding.ts'
import { DEFAULT_CHUNK_LIMITS, extractChunks, shouldSkipFile } from '../src/completion/chunks.ts'
import { buildQuery, formatSnippets, RetrievalIndex, snippetKey, type RetrievalOptions } from '../src/completion/retrieval.ts'
import { assemblePrompt, DEFAULT_PROMPT_PROFILE } from '../src/completion/prompt.ts'
import { DEFAULT_COMPLETION_PARAMS } from '../src/completion/params.ts'
import { runCompletion } from '../src/completion/service.ts'
import type { CompletionEvent, CompletionRequest } from '../src/completion/protocol.ts'
import type { CompletionProvider } from '../src/completion/provider.ts'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceIndex } from '../src/completion/workspaceIndex.ts'

describe('local embedding', () => {
  it('splits identifiers on camel case and underscores and keeps literals', () => {
    const tokens = tokenizeCode('const useState = snake_case + "literal value" + 42')
    expect(tokens).toContain('use')
    expect(tokens).toContain('state')
    expect(tokens).toContain('snake')
    expect(tokens).toContain('case')
    expect(tokens).toContain('literal value')
    expect(tokens).toContain('42')
  })

  it('is deterministic and unit length', () => {
    const embedder = hashingEmbedder(64)
    const first = embedder.embed('const value = useState(0)')
    const second = embedder.embed('const value = useState(0)')
    expect(Array.from(first)).toEqual(Array.from(second))
    let norm = 0
    for (const value of first) norm += value * value
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5)
    expect(embedder.dimensions).toBe(64)
  })

  it('ranks related code above unrelated code', () => {
    // 阈值默认值就是按这组实测定的：相关 0.32 至 0.58，无关 0.05 至 0.10。
    const embedder = hashingEmbedder()
    const query = embedder.embed('const value = useState(0)')
    const related = embedder.embed('function useToggle(initial) {\n  const [on, setOn] = useState(initial)\n}')
    const unrelated = embedder.embed('class Handler(BaseHTTPRequestHandler):\n    def do_GET(self): pass')
    expect(cosineSimilarity(query, related)).toBeGreaterThan(DEFAULT_COMPLETION_PARAMS.similarityThreshold)
    expect(cosineSimilarity(query, unrelated)).toBeLessThan(DEFAULT_COMPLETION_PARAMS.similarityThreshold)
  })

  it('computes cosine and both Jaccard families', () => {
    expect(cosineSimilarity(l2Normalize(Float32Array.from([1, 0])), l2Normalize(Float32Array.from([1, 0])))).toBeCloseTo(1, 6)
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0, 6)
    expect(cosineSimilarity(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0)
    expect(jaccardWord('useState count', 'useState count')).toBe(1)
    expect(jaccardWord('useState', 'totallyOther')).toBe(0)
    expect(jaccardChar('abcdef', 'abcdef')).toBe(1)
  })
})

describe('chunk extraction', () => {
  it('skips oversized files, compressed-looking files and binary content', () => {
    expect(shouldSkipFile(DEFAULT_CHUNK_LIMITS.maxFileBytes + 1, 'x')).toBe('file-too-large')
    expect(shouldSkipFile(100, Array.from({ length: 10 }, () => 'x'.repeat(900)).join('\n'))).toBe('average-line-too-long')
    expect(shouldSkipFile(10, 'abc\u0000def')).toBe('binary')
    expect(shouldSkipFile(100, 'const a = 1\n')).toBeUndefined()
  })

  it('extracts a module chunk plus function and class chunks for TypeScript', () => {
    const text = [
      "import { useState } from 'react'",
      '',
      'export function useCounter(initial) {',
      '  const [count, setCount] = useState(initial)',
      '  return { count, setCount }',
      '}',
      '',
      'export class Store {',
      '  read() {',
      '    return 1',
      '  }',
      '}',
    ].join('\n')
    const chunks = extractChunks('src/counter.ts', 'typescript', text)
    const kinds = chunks.map(chunk => `${chunk.kind}:${chunk.name ?? '-'}`)
    expect(kinds[0]).toBe('module:-')
    expect(kinds).toContain('function:useCounter')
    expect(kinds).toContain('class:Store')
    const fn = chunks.find(chunk => chunk.name === 'useCounter')
    expect(fn?.startLine).toBe(3)
    expect(fn?.endLine).toBe(6)
    // 嵌入文本只放正文：实测把路径与元信息一起嵌入会在短查询下压垮区分度。
    expect(fn?.embeddingText).toBe(fn?.text)
    expect(fn?.embeddingText).not.toContain('src/counter.ts')
  })

  it('extracts entities by indentation for Python and falls back to windows', () => {
    const python = ['import os', '', 'class Handler:', '    def do_GET(self):', '        return 1', '', 'def main():', '    pass'].join('\n')
    const chunks = extractChunks('app.py', 'python', python)
    expect(chunks.map(chunk => `${chunk.kind}:${chunk.name ?? '-'}`)).toContain('class:Handler')
    expect(chunks.map(chunk => `${chunk.kind}:${chunk.name ?? '-'}`)).toContain('function:main')
    const fallback = extractChunks('notes.txt', 'plaintext', Array.from({ length: 90 }, (_value, index) => `line ${index}`).join('\n'), { ...DEFAULT_CHUNK_LIMITS, windowLines: 30 })
    expect(fallback.filter(chunk => chunk.kind === 'window').length).toBeGreaterThan(1)
  })

  it('respects the per-file chunk cap', () => {
    const text = Array.from({ length: 40 }, (_value, index) => `export function fn${index}() {\n  return ${index}\n}`).join('\n')
    const chunks = extractChunks('many.ts', 'typescript', text, { ...DEFAULT_CHUNK_LIMITS, maxChunksPerFile: 5 })
    expect(chunks.length).toBeLessThanOrEqual(5)
  })
})

const indexOptions = (storePath: string): RetrievalOptions => ({
  storePath,
  snippetCount: 4,
  snippetChars: 3000,
  similarityThreshold: DEFAULT_COMPLETION_PARAMS.similarityThreshold,
  rebuildIntervalMs: 24 * 60 * 60 * 1000,
})

const reactFile = { path: 'src/hooks/useToggle.ts', language: 'typescript', mtimeMs: 1, size: 120, text: ['export function useToggle(initial) {', '  const [on, setOn] = useState(initial)', '  return [on, setOn]', '}'].join('\n') }
const pythonFile = { path: 'server/handler.py', language: 'python', mtimeMs: 1, size: 120, text: ['class Handler(BaseHTTPRequestHandler):', '    def do_GET(self):', '        self.send_response(200)'].join('\n') }

describe('retrieval index', () => {
  it('builds a query from the cursor area and repeats the current line', () => {
    const document = 'const a = 1\nconst value = useSt'
    // 列是 0 起：要整行就得传整行长度。
    const query = buildQuery(document, 2, 20, 10)
    expect(query).toContain('const value = useSt')
    // 当前行重复一次：它在向量里占更大比重。
    expect(query.split('const value = useSt').length - 1).toBe(2)
  })

  it('indexes files, skips unchanged ones and reports status', async () => {
    const store = join(mkdtempSync(join(tmpdir(), 'dvw-index-')), 'index.json')
    const index = new RetrievalIndex(indexOptions(store))
    expect(index.update(reactFile)).toBe('indexed')
    expect(index.update(reactFile)).toBe('unchanged')
    expect(index.needsUpdate(reactFile.path, reactFile.mtimeMs, reactFile.size)).toBe(false)
    expect(index.needsUpdate(reactFile.path, reactFile.mtimeMs + 1, reactFile.size)).toBe(true)
    expect(index.update(pythonFile)).toBe('indexed')
    const status = index.status()
    expect(status.files).toBe(2)
    expect(status.chunks).toBeGreaterThan(1)
    expect(status.stale).toBe(false)
  })

  it('keeps one copy of a chunk that appears in several files', async () => {
    // 文档 5.2：同一实体在多处出现时保留一个 —— 否则样板代码会占掉多个片段名额。
    const store = join(mkdtempSync(join(tmpdir(), 'dvw-dedup-')), 'index.json')
    const index = new RetrievalIndex(indexOptions(store))
    const text = reactFile.text
    expect(index.update({ ...reactFile, path: 'a.ts' })).toBe('indexed')
    expect(index.update({ ...reactFile, path: 'b.ts' })).toBe('skipped')
    // 两个文件都记了账（否则每次扫描都会重新读它），但内容只入库一份。
    expect(index.status().files).toBe(2)
    expect(index.status().chunks).toBe(1)
    expect(text.length).toBeGreaterThan(0)
  })

  it('remembers which chunks were deduplicated across a reload', async () => {
    const store = join(mkdtempSync(join(tmpdir(), 'dvw-dedup-reload-')), 'index.json')
    const index = new RetrievalIndex(indexOptions(store))
    index.update({ ...reactFile, path: 'a.ts' })
    await index.save()
    const second = new RetrievalIndex(indexOptions(store))
    await second.load()
    // 载入之后同一段内容仍应判为重复：否则每次重启都会把重复分块重新收进来。
    expect(second.update({ ...reactFile, path: 'b.ts' })).toBe('skipped')
    expect(second.status().chunks).toBe(1)
  })

  it('reports the capacity limits and whether they were hit', async () => {
    // 触顶后索引不完整，必须能从状态里看出来：否则使用者只会觉得「检索效果一般」。
    const store = join(mkdtempSync(join(tmpdir(), 'dvw-cap-')), 'index.json')
    const roomy = new RetrievalIndex(indexOptions(store))
    expect(roomy.update(reactFile)).toBe('indexed')
    expect(roomy.status().limits.maxChunks).toBeGreaterThan(1)
    expect(roomy.status().capped).toBe(false)

    const tightStore = join(mkdtempSync(join(tmpdir(), 'dvw-cap-')), 'index.json')
    const tight = new RetrievalIndex({ ...indexOptions(tightStore), indexLimits: { maxFiles: 1, maxChunks: 1 } })
    expect(tight.update(reactFile)).toBe('indexed')
    expect(tight.update(pythonFile)).toBe('skipped')
    const status = tight.status()
    expect(status.limits).toEqual({ maxFiles: 1, maxChunks: 1 })
    expect(status.capped).toBe(true)
  })

  it('builds the query from the text before the cursor', () => {
    const document = 'const a = useState(0)\nconst b = useSt\nconst c = 2'
    // 列 16 是紧贴 useSt 之后：查询里不能出现下一个字符。
    const query = buildQuery(document, 2, 16)
    expect(query).toContain('const b = useSt')
    expect(query.split('\n')[0]).toBe('const b = useSt')
  })

  it('retrieves the related chunk, excludes the edited file and caps the count', () => {
    const store = join(mkdtempSync(join(tmpdir(), 'dvw-index-')), 'index.json')
    const index = new RetrievalIndex(indexOptions(store))
    index.update(reactFile)
    index.update(pythonFile)
    index.update({ path: 'src/hooks/useCounter.ts', language: 'typescript', mtimeMs: 1, size: 100, text: 'export function useCounter(initial) {\n  const [count, setCount] = useState(initial)\n  return count\n}' })
    const query = buildQuery('const value = useState', 1, 23, 5)
    const hits = index.search(query, 'src/hooks/useCounter.ts')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every(hit => hit.path !== 'src/hooks/useCounter.ts')).toBe(true)
    expect(hits.every(hit => hit.score >= DEFAULT_COMPLETION_PARAMS.similarityThreshold)).toBe(true)
    expect(hits[0]?.path).toBe(reactFile.path)
    // 片段文本由调用方按行范围取回后拼接：索引里不存正文。
    const formatted = formatSnippets(hits, new Map([[snippetKey(hits[0] as NonNullable<typeof hits[0]>), 'const [on, setOn] = useState(initial)']]), 3000)
    expect(formatted[0]).toContain(reactFile.path)
    expect(formatted[0]).toContain('setOn')
  })

  it('caps the snippet body at the configured characters when formatting', () => {
    const store = join(mkdtempSync(join(tmpdir(), 'dvw-index-')), 'index.json')
    const index = new RetrievalIndex({ ...indexOptions(store), snippetChars: 60 })
    index.update({ ...reactFile, text: `export function useToggle(initial) {\n  const [on, setOn] = useState(initial)\n${'  // padding line\n'.repeat(30)}}` })
    const hits = index.search(buildQuery('const [on, setOn] = useState', 1, 29, 5))
    const hit = hits[0]
    expect(hit).toBeDefined()
    const body = '  // padding line\n'.repeat(30)
    const formatted = formatSnippets([hit as NonNullable<typeof hit>], new Map([[snippetKey(hit as NonNullable<typeof hit>), body]]), index.snippetChars)
    // 首行是位置头，正文按上限截断。
    expect((formatted[0]?.split('\n')[1] ?? '').length).toBeLessThanOrEqual(60)
  })

  it('persists and reloads the index', async () => {
    const store = join(mkdtempSync(join(tmpdir(), 'dvw-index-')), 'index.json')
    const first = new RetrievalIndex(indexOptions(store))
    first.update(reactFile)
    await first.save()
    const second = new RetrievalIndex(indexOptions(store))
    await second.load()
    expect(second.status().files).toBe(1)
    expect(second.status().builtAt).toBeGreaterThan(0)
    expect(second.needsUpdate(reactFile.path, reactFile.mtimeMs, reactFile.size)).toBe(false)
    expect(second.search(buildQuery('const [on, setOn] = useState', 1, 29, 5)).length).toBeGreaterThan(0)
    second.remove(reactFile.path)
    expect(second.status().files).toBe(0)
  })
})

describe('workspace index', () => {
  const makeWorkspace = () => {
    const root = mkdtempSync(join(tmpdir(), 'dvw-ws-'))
    mkdirSync(join(root, 'src', 'hooks'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(root, 'src', 'hooks', 'useToggle.ts'), ['export function useToggle(initial) {', '  const [on, setOn] = useState(initial)', '  return [on, setOn]', '}'].join('\n'), 'utf8')
    writeFileSync(join(root, 'src', 'counter.ts'), ['export function useCounter(initial) {', '  const [count, setCount] = useState(initial)', '  return count', '}'].join('\n'), 'utf8')
    writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = function leftPad() { return 1 }', 'utf8')
    writeFileSync(join(root, 'notes.md'), '# 不该被索引的文件', 'utf8')
    return root
  }

  it('reuses one in-flight scan instead of starting a second one', async () => {
    // 后台刷新与手动重建同时发生时，同一份索引只该扫一遍。
    const dir = mkdtempSync(join(tmpdir(), 'dvw-scan-'))
    writeFileSync(join(dir, 'a.ts'), reactFile.text, 'utf8')
    const index = await WorkspaceIndex.open({ root: dir, params: DEFAULT_COMPLETION_PARAMS })
    const first = index.refresh()
    const second = index.refresh()
    expect(second).toBe(first)
    await first
    // 上一次结束后再调用会重新扫描，而不是永远复用一个已完成的 promise。
    expect(index.refresh()).not.toBe(first)
  })

  it('scans the workspace, skips ignored directories and writes the index next to the project', async () => {
    const root = makeWorkspace()
    const index = await WorkspaceIndex.open({ root, params: DEFAULT_COMPLETION_PARAMS })
    const report = await index.refresh()
    expect(report.scanned).toBe(2)
    expect(report.indexed).toBe(2)
    // 去重之后不再包含重复内容，因此数量比文件数与实体数简单相加要少。
    expect(index.status().chunks).toBeGreaterThanOrEqual(2)
    expect(existsSync(join(root, '.dsh-workbench', 'index.json'))).toBe(true)
    // node_modules 与 markdown 都不在索引里。
    expect(index.status().files).toBe(2)
  })

  it('reports unchanged files on a second scan and reloads the index from disk', async () => {
    const root = makeWorkspace()
    const first = await WorkspaceIndex.open({ root, params: DEFAULT_COMPLETION_PARAMS })
    await first.refresh()
    const second = await WorkspaceIndex.open({ root, params: DEFAULT_COMPLETION_PARAMS })
    const report = await second.refresh()
    expect(report.unchanged).toBe(2)
    expect(report.indexed).toBe(0)
    expect(second.status().chunks).toBeGreaterThanOrEqual(2)
    // 索引里的块不包含自己产出的索引文件。
    expect(second.status().files).toBe(2)
  })

  it('retrieves a cross-file snippet for a realistic query', async () => {
    const root = makeWorkspace()
    const index = await WorkspaceIndex.open({ root, params: DEFAULT_COMPLETION_PARAMS })
    await index.refresh()
    const snippets = await index.retrieve({
      sessionId: 's',
      environment: { ideVersion: '1', extensionVersion: '1', region: '', channel: 'dev', repository: '' },
      language: 'typescript',
      trigger: 'inline',
      edits: [],
      cursor: {
        filePath: 'src/value.ts',
        rewriteAt: { line: 5, column: 22 },
        document: ["import { useState } from 'react'", '', 'function Value() {', '  const [count, setCount] = useState(0)', '  const value = useState'].join('\n'),
      },
      diagnostics: [],
      forceRewrite: false,
    })
    expect(snippets.length).toBeGreaterThan(0)
    // 两个 hook 文件都与查询相关，谁排前面取决于长度与词元重合，所以断言相关性而不是名次。
    expect(snippets.some(snippet => snippet.includes('useState(initial)'))).toBe(true)
    expect(snippets[0]).toMatch(/src\/(hooks\/useToggle|counter)\.ts/)
  })
})

describe('prompt budget with snippets', () => {
  const request = (overrides: Partial<CompletionRequest> = {}): CompletionRequest => ({
    sessionId: 's',
    environment: { ideVersion: '1', extensionVersion: '1', region: '', channel: 'dev', repository: '' },
    language: 'typescript',
    trigger: 'inline',
    edits: [],
    cursor: { filePath: 'src/a.ts', rewriteAt: { line: 1, column: 6 }, document: 'const ' },
    diagnostics: [],
    forceRewrite: false,
    ...overrides,
  })

  it('injects retrieved snippets into the context section and reports the count', () => {
    const assembled = assemblePrompt({
      filePath: 'src/a.ts',
      language: 'typescript',
      document: 'const value = useSt',
      rewriteAt: { line: 1, column: 18 },
      snippets: ['// src/b.ts:1-3\nconst [on, setOn] = useState(initial)'],
    }, DEFAULT_COMPLETION_PARAMS, DEFAULT_PROMPT_PROFILE)
    expect(assembled.prompt).toContain('# 检索片段')
    expect(assembled.prompt).toContain('setOn')
    expect(assembled.snippetCount).toBe(1)
  })

  it('drops snippets before the edit history when the context budget runs out', () => {
    const longSnippet = `// big\n${'x'.repeat(60_000)}`
    const assembled = assemblePrompt({
      filePath: 'src/a.ts',
      language: 'typescript',
      document: 'const value = useSt',
      rewriteAt: { line: 1, column: 18 },
      snippets: [longSnippet],
      edits: [{ before: 'a', after: 'b', timestamp: 1 }],
    }, DEFAULT_COMPLETION_PARAMS, DEFAULT_PROMPT_PROFILE)
    expect(assembled.dropped).toContain('检索片段')
    expect(assembled.prompt).toContain('改前：a')
  })

  it('feeds retrieved snippets through the service retrieve hook', async () => {
    let seenPrompt = ''
    const provider: CompletionProvider = {
      id: 'capture',
      model: 'capture-1',
      async *complete(prompt): AsyncIterable<{ text: string; done: boolean }> {
        seenPrompt = prompt
        yield { text: 'ok', done: false }
        yield { text: '', done: true }
      },
    }
    const events: CompletionEvent[] = []
    for await (const event of runCompletion(request(), {
      provider,
      retrieve: () => ['// src/b.ts:1-2\nconst [on, setOn] = useState(initial)'],
    })) events.push(event)
    expect(seenPrompt).toContain('# 检索片段')
    expect(seenPrompt).toContain('setOn')
    expect(events.some(event => event.type === 'output')).toBe(true)
  })

  it('keeps completing when retrieval fails', async () => {
    const provider: CompletionProvider = {
      id: 'capture',
      model: 'capture-1',
      async *complete(): AsyncIterable<{ text: string; done: boolean }> { yield { text: 'ok', done: false } },
    }
    const events: CompletionEvent[] = []
    for await (const event of runCompletion(request(), { provider, retrieve: () => { throw new Error('index down') } })) events.push(event)
    expect(events.some(event => event.type === 'output')).toBe(true)
  })

  it('keeps completing when retrieval never returns', async () => {
    // 检索是在调用模型之前被 await 的：没有上限就意味着一卡住补全永远不出来。
    // 定位超时接上之后，超时按「没有片段」继续，与「检索失败不拖垮补全」同一条思路。
    const provider: CompletionProvider = {
      id: 'capture',
      model: 'capture-1',
      async *complete(): AsyncIterable<{ text: string; done: boolean }> { yield { text: 'ok', done: false } },
    }
    const events: CompletionEvent[] = []
    const params = { ...DEFAULT_COMPLETION_PARAMS, locateTimeoutMs: 30 }
    // 永不 resolve：模拟卡住的索引扫描。
    const stuck = new Promise<string[]>(() => undefined)
    const started = Date.now()
    for await (const event of runCompletion(request(), { provider, params, retrieve: () => stuck })) events.push(event)
    expect(events.some(event => event.type === 'output')).toBe(true)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
