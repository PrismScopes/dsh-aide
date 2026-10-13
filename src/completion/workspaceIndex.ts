/**
 * 工作区索引器：把磁盘上的代码送进检索索引，并按项目提供检索入口（文档 5.1、5.3）。
 *
 * 索引文件放在工作区内的 `.dsh-workbench/index.json`：按项目分库（文档 5.3），且不写系统盘。
 * 该目录自身被排除在索引之外，避免索引把自己的产物也收进去。
 *
 * 增量策略：扫描时先问 `needsUpdate`，未变更的文件不读内容；全量重建由周期（默认 24 小时）或
 * 显式刷新触发。刷新在后台进行，不阻塞补全请求 —— 检索没就绪时按「没有片段」继续。
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { CompletionParams } from './params.ts'
import type { CompletionRequest } from './protocol.ts'
import { formatSnippets, RetrievalIndex, buildQuery, snippetKey, type IndexStatus } from './retrieval.ts'

/** 索引自身的产物与常见依赖/构建目录都排除在外。 */
export const INDEX_IGNORED_DIRS = new Set([
  '.git', '.dsh-workbench', 'node_modules', 'dist', 'out', 'build', 'lib', 'coverage', '.next', '.nuxt',
  '.venv', 'venv', '__pycache__', '.cache', 'tmp', 'target', 'vendor', '.idea', '.vscode-test',
])

/** 参与索引的扩展名到语言标识的映射。没有映射的文件不参与索引。 */
export const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  ['.ts', 'typescript'], ['.tsx', 'typescriptreact'], ['.mts', 'typescript'], ['.cts', 'typescript'],
  ['.js', 'javascript'], ['.jsx', 'javascriptreact'], ['.mjs', 'javascript'], ['.cjs', 'javascript'],
  ['.py', 'python'], ['.rb', 'ruby'], ['.go', 'go'], ['.rs', 'rust'], ['.java', 'java'],
  ['.c', 'c'], ['.h', 'c'], ['.cpp', 'cpp'], ['.hpp', 'cpp'], ['.cc', 'cpp'], ['.cs', 'csharp'],
  ['.php', 'php'], ['.swift', 'swift'], ['.kt', 'kotlin'], ['.lua', 'lua'], ['.sh', 'shell'],
  ['.ps1', 'powershell'], ['.sql', 'sql'], ['.css', 'css'], ['.scss', 'scss'], ['.less', 'less'],
  ['.html', 'html'], ['.vue', 'vue'], ['.svelte', 'svelte'], ['.yml', 'yaml'], ['.yaml', 'yaml'],
  ['.toml', 'toml'], ['.json', 'json'],
])

export interface RefreshReport {
  scanned: number
  indexed: number
  unchanged: number
  skipped: number
  chunks: number
  durationMs: number
}

export interface WorkspaceIndexOptions {
  root: string
  params: CompletionParams
  /** 覆盖索引文件位置；默认在工作区内。 */
  storePath?: string
}

export class WorkspaceIndex {
  private readonly index: RetrievalIndex
  private refreshing: Promise<RefreshReport> | undefined

  private constructor(private readonly options: WorkspaceIndexOptions, index: RetrievalIndex) {
    this.index = index
  }

  static async open(options: WorkspaceIndexOptions): Promise<WorkspaceIndex> {
    const storePath = options.storePath ?? join(options.root, '.dsh-workbench', 'index.json')
    const index = new RetrievalIndex({
      storePath,
      snippetCount: options.params.snippetCount,
      snippetChars: options.params.snippetChars,
      similarityThreshold: options.params.similarityThreshold,
      rebuildIntervalMs: 24 * 60 * 60 * 1000,
    })
    await index.load()
    // 索引目录自带忽略规则：它落在用户仓库里，不该显示成未跟踪文件。
    await mkdir(join(options.root, '.dsh-workbench'), { recursive: true }).catch(() => undefined)
    await writeFile(join(options.root, '.dsh-workbench', '.gitignore'), '*\n', 'utf8').catch(() => undefined)
    return new WorkspaceIndex(options, index)
  }

  status(): IndexStatus & { root: string } {
    return { ...this.index.status(), root: this.options.root }
  }

  /** 需要时（首次或过期）在后台刷新，返回同一个进行中的任务。 */
  ensureFresh(): Promise<RefreshReport> | undefined {
    if (this.refreshing !== undefined) return this.refreshing
    if (!this.index.needsRebuild()) return undefined
    return this.refresh()
  }

  /**
   * 全量扫描并增量更新索引。
   *
   * 进行中的任务由本方法自己持有并复用：后台刷新与手动重建同时发生时，同一份索引只扫一遍。
   * 因此它不是 async 函数 —— async 会让每次调用都包出一个新 promise，复用就无从谈起。
   */
  refresh(): Promise<RefreshReport> {
    if (this.refreshing !== undefined) return this.refreshing
    const running = this.runRefresh().finally(() => {
      if (this.refreshing === running) this.refreshing = undefined
    })
    this.refreshing = running
    return running
  }

  private async runRefresh(): Promise<RefreshReport> {
    const started = Date.now()
    const report: RefreshReport = { scanned: 0, indexed: 0, unchanged: 0, skipped: 0, chunks: 0, durationMs: 0 }
    // 先收集候选再入库：入库顺序决定上限用完之后谁被留下，这件事不该由目录的字母序决定。
    const candidates: Array<{ absolute: string; path: string; language: string; mtimeMs: number; size: number }> = []
    const walk = async (directory: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch { return /* 读不到的目录直接跳过：权限或竞态都不是索引该报错的地方。 */ }
      for (const entry of entries) {
        const absolute = join(directory, entry.name)
        if (entry.isDirectory()) {
          if (INDEX_IGNORED_DIRS.has(entry.name)) continue
          await walk(absolute)
          continue
        }
        if (!entry.isFile()) continue
        const dot = entry.name.lastIndexOf('.')
        const language = dot === -1 ? undefined : LANGUAGE_BY_EXTENSION.get(entry.name.slice(dot).toLowerCase())
        if (language === undefined) continue
        report.scanned++
        let info
        try {
          info = await stat(absolute)
        } catch { report.skipped++; continue }
        candidates.push({ absolute, path: relative(this.options.root, absolute).split(sep).join('/'), language, mtimeMs: info.mtimeMs, size: info.size })
      }
    }
    await walk(this.options.root)

    // 最近修改的排前面：用户正在动的代码最可能被检索到，而已入库的旧文件不会被顶掉。
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    for (const candidate of candidates) {
      if (!this.index.needsUpdate(candidate.path, candidate.mtimeMs, candidate.size)) { report.unchanged++; continue }
      let text
      try {
        text = await readFile(candidate.absolute, 'utf8')
      } catch { report.skipped++; continue }
      const outcome = this.index.update({ path: candidate.path, language: candidate.language, text, mtimeMs: candidate.mtimeMs, size: candidate.size })
      if (outcome === 'indexed') report.indexed++
      else if (outcome === 'unchanged') report.unchanged++
      else report.skipped++
    }
    await this.index.save()
    report.chunks = this.index.status().chunks
    report.durationMs = Date.now() - started
    return report
  }

  /**
   * 检索一次补全请求对应的片段，并拼成注入 prompt 的文本。
   *
   * 正文是按行范围从文件里读的：索引不存正文，所以片段永远与磁盘一致，也不会让索引把整个仓库
   * 复制一份（实测存正文时索引文件 66.9 MB）。只读命中的那几个文件，开销可忽略。
   */
  async retrieve(request: CompletionRequest): Promise<string[]> {
    const { line, column } = request.cursor.rewriteAt
    const query = buildQuery(request.cursor.document, line, column)
    const hits = this.index.search(query, request.cursor.filePath)
    const texts = new Map<string, string>()
    for (const hit of hits) {
      const body = await this.readLines(hit.path, hit.startLine, hit.endLine)
      if (body !== undefined) texts.set(snippetKey(hit), body)
    }
    return formatSnippets(hits, texts, this.index.snippetChars)
  }

  /** 按行范围读取片段正文；读不到就返回 undefined，由调用方跳过这一条。 */
  private async readLines(path: string, startLine: number, endLine: number): Promise<string | undefined> {
    try {
      const text = await readFile(join(this.options.root, path), 'utf8')
      return text.split('\n').slice(Math.max(0, startLine - 1), endLine).join('\n')
    } catch {
      return undefined
    }
  }
}
