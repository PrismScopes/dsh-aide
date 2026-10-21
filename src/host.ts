import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { access, cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import type { HostContext } from './context.ts'
import type { FileDocument, FileEntry, GitBranchList, GitChange, GitCommit, GitCommitDetail, GitCommitFile, GitCommitFileDetail, GitDiff, GitStash, GitStatus, GitTag, SearchMatch, SearchReplaceRequest, SearchReplaceResult, SearchRequest, SearchResult } from './types.ts'
import { inside, resolveCreatableWorkspacePath, resolveExistingWorkspacePath, type WorkspacePathErrors } from './paths.ts'
import { WorkbenchError } from './wire.ts'

// 静态资源解析已拆到 assets.ts；从这里重新导出，保持既有引用（含路由与单测）不变。
export { codiconAsset, fileIconAsset, katexAsset, monacoAsset, onigWasmAsset } from './assets.ts'

const require = createRequire(import.meta.url)
/** 超过这个大小就不再读全文（即使调用方带了 force）。 */
const HARD_READ_LIMIT = 64 * 1024 * 1024
const TEXT_LIMIT = 5 * 1024 * 1024
const PROCESS_TIMEOUT = 30_000

export function cwdFor(ctx: HostContext, sessionId: string): string {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new WorkbenchError('session-unknown', 'session is not ready yet; retry once it exists', 409)
  // 0.2.1 起工作目录是独立服务（会话可因工作区切换而改变），不再读 header.cwd 的静态快照。
  const cwd = ctx.workingDirectory.get(session)
  // 会话还没就绪时**不能**回落到进程目录：桌面端进程的工作目录是应用自己的数据目录，
  // 那样列出来的文件树与随后的读写会指向不同的地方（表现为列出 tools、点它却报路径不存在）。
  // 这里明确报「未就绪」，让客户端等会话出现后重试。
  if (cwd === undefined || cwd === '') throw new WorkbenchError('session-unknown', 'session is not ready yet; retry once it exists', 409)
  if (!isAbsolute(cwd)) throw new WorkbenchError('cwd-invalid', 'session working directory is not absolute')
  return normalize(cwd)
}

/** 文件 API 的错误码与消息；与重构前逐字一致（tests/host.spec.ts 依赖这些 code）。 */
const PATH_ERRORS: WorkspacePathErrors = {
  outside: () => new WorkbenchError('path-outside', 'path is outside the workspace', 403),
  symlinkOutside: () => new WorkbenchError('path-outside', 'path follows a symlink outside the workspace', 403),
  missing: () => new WorkbenchError('not-found', 'path does not exist', 404),
}

/** create 模式只要求父目录存在，父目录缺失是独立错误码（与重构前一致）。 */
const PARENT_PATH_ERRORS: WorkspacePathErrors = {
  ...PATH_ERRORS,
  missing: () => new WorkbenchError('parent-missing', 'parent directory does not exist', 404),
}

async function canonicalRoot(cwd: string): Promise<string> {
  return realpath(cwd).catch(() => { throw new WorkbenchError('cwd-missing', 'session working directory does not exist', 404) })
}

/** Resolve a caller-relative path and reject traversal and symlink escape. */
export async function workspacePath(cwd: string, raw: string, create = false): Promise<{ root: string; absolute: string }> {
  if (isAbsolute(raw)) throw new WorkbenchError('path-invalid', 'absolute paths are not accepted')
  const root = await canonicalRoot(cwd)
  const { absolute } = create
    ? await resolveCreatableWorkspacePath(root, raw, PARENT_PATH_ERRORS)
    : await resolveExistingWorkspacePath(root, raw, PATH_ERRORS)
  return { root, absolute }
}

function relativePath(root: string, absolute: string): string { return relative(root, absolute).split(sep).join('/') }
function revision(content: Buffer, mtimeMs: number): string {
  return createHash('sha256').update(content).update(String(mtimeMs)).digest('hex')
}

export async function listFiles(cwd: string, path: string): Promise<FileEntry[]> {
  const { root, absolute } = await workspacePath(cwd, path)
  const values = await readdir(absolute, { withFileTypes: true })
  const rows = await Promise.all(values.filter(item => item.name !== '.git').map(async item => {
    const full = join(absolute, item.name)
    if (!item.isSymbolicLink()) return { name: item.name, path: relativePath(root, full), kind: item.isDirectory() ? 'directory' as const : 'file' as const }
    const actual = await realpath(full).catch(() => undefined)
    if (actual === undefined || !inside(root, actual)) return undefined
    const info = await stat(full)
    const kind = info.isDirectory() ? 'directory' as const : 'file' as const
    return { name: item.name, path: relativePath(root, full), kind, size: info.size, mtimeMs: info.mtimeMs }
  }))
  return rows.filter(row => row !== undefined).sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1)
}

export async function readDocument(cwd: string, path: string, force = false): Promise<FileDocument> {
  const { root, absolute } = await workspacePath(cwd, path)
  const info = await stat(absolute)
  if (!info.isFile()) throw new WorkbenchError('not-file', 'path is not a file')
  // 超过 TEXT_LIMIT 时默认只回一个标记，由客户端在编辑器里问用户；force 是用户确认后再读一次。
  // 确认后仍有一个硬上限：再大就不读，避免把上百 MiB 塞进内存与消息体。
  const tooLarge = info.size > TEXT_LIMIT && !force
  if (!tooLarge && info.size > HARD_READ_LIMIT) throw new WorkbenchError('too-large', `file is larger than ${HARD_READ_LIMIT / 1048576} MiB`, 413)
  const handle = await open(absolute, 'r')
  try {
    const head = Buffer.alloc(Math.min(info.size, tooLarge ? 4096 : info.size))
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    const bytes = head.subarray(0, bytesRead)
    const binary = bytes.includes(0)
    return {
      path: relativePath(root, absolute), content: binary || tooLarge ? '' : bytes.toString('utf8'),
      revision: revision(bytes, info.mtimeMs), size: info.size, binary, tooLarge,
    }
  } finally { await handle.close() }
}

export async function saveDocument(cwd: string, path: string, content: string, expected: string): Promise<FileDocument> {
  const { absolute } = await workspacePath(cwd, path)
  const current = await readDocument(cwd, path)
  if (current.revision !== expected) throw new WorkbenchError('revision-conflict', 'file changed on disk; reload before saving', 409)
  await writeAtomic(absolute, content)
  return readDocument(cwd, path)
}

/**
 * 原子写：同目录临时文件 + rename。
 *
 * 搜索替换要一次改很多文件，用户也可能正开着其中几个；直接 writeFile 在进程被中断时
 * 会留下半截文件，而 rename 在同一文件系统内是原子的（保存文档也走这里）。
 */
async function writeAtomic(absolute: string, content: string): Promise<void> {
  const temp = join(dirname(absolute), `.${randomUUID()}.dsh-vscode.tmp`)
  await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' })
  try { await rename(temp, absolute) } catch (error) { await rm(temp, { force: true }); throw error }
}

export async function createEntry(cwd: string, path: string, kind: 'file' | 'directory'): Promise<void> {
  const { absolute } = await workspacePath(cwd, path, true)
  if (kind === 'directory') await mkdir(absolute)
  else { const handle = await open(absolute, 'wx'); await handle.close() }
}

/** Write an uploaded file into an existing workspace directory without overwriting files. */
export async function uploadFile(cwd: string, directory: string, name: string, content: Buffer): Promise<FileEntry> {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new WorkbenchError('filename-invalid', 'uploaded file name is invalid')
  const targetPath = directory === '' ? name : `${directory}/${name}`
  const { root, absolute } = await workspacePath(cwd, targetPath, true)
  const handle = await open(absolute, 'wx')
  try { await handle.writeFile(content) } finally { await handle.close() }
  const info = await lstat(absolute)
  return { name, path: relativePath(root, absolute), kind: 'file', size: info.size, mtimeMs: info.mtimeMs }
}

export async function renameEntry(cwd: string, path: string, nextPath: string): Promise<void> {
  const source = await workspacePath(cwd, path)
  const target = await workspacePath(cwd, nextPath, true)
  await access(target.absolute, constants.F_OK).then(
    () => { throw new WorkbenchError('target-exists', 'destination already exists', 409) }, () => undefined,
  )
  await rename(source.absolute, target.absolute)
}

export async function deleteEntry(cwd: string, path: string): Promise<void> {
  if (path === '') throw new WorkbenchError('root-delete', 'cannot delete workspace root', 403)
  const { absolute } = await workspacePath(cwd, path)
  await rm(absolute, { recursive: true, force: false })
}

/**
 * 把工作区里的文件或目录复制到另一个目录下（保持原名）。
 *
 * 三个约束，都是为了「粘错了还能救」：
 *   - 目标已存在就报 409，绝不覆盖 —— 这里没有撤销，覆盖等于静默毁掉对方的文件；
 *   - 目录不能粘进自己的子目录（否则 node 的 cp 会无限递归，或留下半份副本）；
 *   - 目标目录必须已存在（workspacePath 的 create 分支会校验父目录），不替用户顺手建目录。
 */
export async function copyEntry(cwd: string, source: string, directory: string): Promise<FileEntry> {
  if (source === '') throw new WorkbenchError('path-invalid', 'source path is required')
  const from = await workspacePath(cwd, source)
  const name = basename(source)
  const targetPath = directory === '' ? name : `${directory}/${name}`
  const to = await workspacePath(cwd, targetPath, true)
  if (from.absolute === to.absolute || inside(from.absolute, to.absolute)) throw new WorkbenchError('copy-into-self', 'cannot copy a directory into itself', 400)
  await access(to.absolute, constants.F_OK).then(
    () => { throw new WorkbenchError('target-exists', 'destination already exists', 409) },
    () => undefined,
  )
  await cp(from.absolute, to.absolute, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true })
  const info = await stat(to.absolute)
  return { name, path: relativePath(to.root, to.absolute), kind: info.isDirectory() ? 'directory' : 'file', size: info.size, mtimeMs: info.mtimeMs }
}

/**
 * 把工作区里的文件或目录移动到另一个目录下（保持原名），即资源管理器的「剪切 → 粘贴」。
 *
 * 约束与 copyEntry 一致（不覆盖、不移入自身、目标目录必须已存在），另外这里用 `rename` 而不是
 * 「复制再删除」：同一块盘上的 rename 是原子的，中途失败不会留下「源已删、目标只有一半」的状态。
 * 跨盘时 rename 会抛 EXDEV，宁可把错误报给用户，也不静默退化成慢且非原子的复制。
 */
export async function moveEntry(cwd: string, source: string, directory: string): Promise<FileEntry> {
  if (source === '') throw new WorkbenchError('path-invalid', 'source path is required')
  const from = await workspacePath(cwd, source)
  const name = basename(source)
  const targetPath = directory === '' ? name : `${directory}/${name}`
  const to = await workspacePath(cwd, targetPath, true)
  // 先判「目标已存在」再判「移入自身」：剪切后粘回原目录时，目标就是源文件本身，
  // 报「目标已存在」比报「不能把目录移进自己」准确（后者对文件更是误导）。
  await access(to.absolute, constants.F_OK).then(
    () => { throw new WorkbenchError('target-exists', 'destination already exists', 409) },
    () => undefined,
  )
  if (from.absolute === to.absolute || inside(from.absolute, to.absolute)) throw new WorkbenchError('copy-into-self', 'cannot move a directory into itself', 400)
  await rename(from.absolute, to.absolute)
  const info = await stat(to.absolute)
  return { name, path: relativePath(to.root, to.absolute), kind: info.isDirectory() ? 'directory' : 'file', size: info.size, mtimeMs: info.mtimeMs }
}

const IMAGE_TYPES:Record<string,string>={'.avif':'image/avif','.bmp':'image/bmp','.gif':'image/gif','.ico':'image/x-icon','.jpeg':'image/jpeg','.jpg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.webp':'image/webp'}
const PREVIEW_TYPES:Record<string,string>={...IMAGE_TYPES,'.pdf':'application/pdf','.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.odt':'application/vnd.oasis.opendocument.text'}
/** Resolve a supported preview file inside the workspace. */
export async function workspacePreviewFile(cwd:string,path:string):Promise<{path:string;type:string}>{const resolved=await workspacePath(cwd,path);const type=PREVIEW_TYPES[extname(resolved.absolute).toLowerCase()];if(type===undefined)throw new WorkbenchError('unsupported-media','file is not a supported preview format',415);return {path:resolved.absolute,type}}

/** Resolve the PDF.js worker shipped with this plugin's runtime dependency. */
export function pdfWorkerAsset(): { path: string; type: string } {
  return { path: require.resolve('pdfjs-dist/build/pdf.worker.min.mjs'), type: 'text/javascript; charset=utf-8' }
}

interface ProcessResult { stdout: string; stderr: string; code: number; truncated: boolean }

/**
 * 可注入的进程执行器：生产环境默认 `run`；测试可传 fake，用假的 git/rg 输出断言 spawn 次数与结果，
 * 不必真的起进程。
 */
export type ProcessRunner = (command: string, args: string[], cwd: string, timeout?: number, signal?: AbortSignal, maxStdoutBytes?: number) => Promise<ProcessResult>

/**
 * spawn 一个进程并收集输出。
 *
 * `maxStdoutBytes` 用于搜索这类可能产生巨量输出的调用：超过上限就 kill 子进程并返回已收到的前缀
 * （`truncated: true`，前缀末尾可能是半行，调用方自己跳过）。git 调用不传该参数，行为与以前一致。
 */
export function run(command: string, args: string[], cwd: string, timeout = PROCESS_TIMEOUT, signal?: AbortSignal, maxStdoutBytes = Number.POSITIVE_INFINITY): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    // git 的网络动作（fetch/pull/push）在凭据缺失时会等 stdin 输入，而这里没有 stdin：
    // 不关掉终端提示的话只能等满 30s 超时。GIT_TERMINAL_PROMPT=0 让它立刻报「需要认证」。
    const env = command === 'git' ? { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } : undefined
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, ...(env === undefined ? {} : { env }) })
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let truncated = false
    let settled = false
    const timer = setTimeout(() => { child.kill(); if (!settled) reject(new WorkbenchError('timeout', `${command} timed out`, 504)) }, timeout)
    const abort = () => { child.kill(); if (!settled) { settled = true; clearTimeout(timer); reject(new WorkbenchError('cancelled', `${command} cancelled`, 499)) } }
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', chunk => {
      if (truncated || settled) return
      const text = String(chunk)
      const bytes = Buffer.byteLength(text)
      if (stdoutBytes + bytes > maxStdoutBytes) {
        const remaining = Math.max(0, maxStdoutBytes - stdoutBytes)
        stdout += Buffer.from(text).subarray(0, remaining).toString('utf8')
        stdoutBytes += remaining
        truncated = true
        child.kill()
        return
      }
      stdout += text
      stdoutBytes += bytes
    })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (!settled) { settled = true; reject(error) } })
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (!settled) { settled = true; resolvePromise({ stdout, stderr, code: code ?? 1, truncated }) } })
  })
}

/** 全局匹配条数默认上限：与旧实现一致（客户端据此显示「结果已截断到 2000 条」）。 */
const SEARCH_MAX_MATCHES = 2000
/** 单次 rg 的 stdout 字节上限：大仓里 `--max-count` 按文件计，不设总量会把上百 MB 拼进内存。 */
const SEARCH_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
/** 单文件大小上限：跳过压缩产物、大日志这类不该参与搜索的文件。 */
const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback
}

/**
 * rg 输出的路径归一成工作区相对路径（正斜杠）。
 *
 * rg 把命令行里的 `.` 原样拼在路径前：POSIX 上是 `./src/a.ts`，Windows 上是 `.\src\a.ts`，
 * 所以前缀两种分隔符都要剥；Windows 的分隔符再统一成正斜杠，客户端（含标签页/资源管理器）
 * 只认一种写法。POSIX 上的反斜杠是合法文件名字符，不能动。
 */
function ripgrepRelative(value: string): string {
  const stripped = value.replace(/^\.[\\/]/, '')
  return sep === '\\' ? stripped.split('\\').join('/') : stripped
}

export async function searchWorkspace(cwd: string, request: SearchRequest, signal?: AbortSignal, runner: ProcessRunner = run): Promise<SearchResult> {
  if (request.query === '') return { matches: [], limited: false, truncated: false }
  const root = await canonicalRoot(cwd)
  const rg = require('@vscode/ripgrep').rgPath as string
  const maxMatches = positiveLimit(request.maxMatches, SEARCH_MAX_MATCHES)
  const maxOutputBytes = positiveLimit(request.maxOutputBytes, SEARCH_MAX_OUTPUT_BYTES)
  const maxFileSize = positiveLimit(request.maxFileSize, SEARCH_MAX_FILE_BYTES)
  // --max-count 是「每文件」上限；全局上限由下面的流式读取（maxOutputBytes）+ maxMatches 负责。
  const args = ['--json', '--line-number', '--column', '--hidden', '--glob', '!.git/**', '--max-count', '2000', '--max-filesize', String(maxFileSize)]
  if (!request.regex) args.push('--fixed-strings')
  if (!request.caseSensitive) args.push('--ignore-case')
  if (request.wholeWord) args.push('--word-regexp')
  if (request.include) args.push('--glob', request.include)
  if (request.exclude) args.push('--glob', `!${request.exclude}`)
  args.push('--', request.query, '.')
  const result = await runner(rg, args, root, PROCESS_TIMEOUT, signal, maxOutputBytes)
  // 达到字节上限时是我们主动 kill 的，退出码不可信，不能按 rg 失败处理。
  if (!result.truncated && result.code > 1) throw new WorkbenchError('search-failed', result.stderr || 'ripgrep failed', 500)
  const matches: SearchMatch[] = []
  for (const line of result.stdout.split('\n')) {
    if (line === '') continue
    let event: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number; submatches?: Array<{ start: number; end: number; match?: { text?: string } }> } }
    try { event = JSON.parse(line) as typeof event } catch { continue } // 字节上限截断时最后一行可能是半行
    if (event.type !== 'match' || event.data?.path?.text === undefined || event.data.lines?.text === undefined) continue
    for (const hit of event.data.submatches ?? []) {
      matches.push({ path: ripgrepRelative(event.data.path.text), line: event.data.line_number ?? 1, column: hit.start + 1, preview: event.data.lines.text.trimEnd(), match: hit.match?.text ?? '' })
      if (matches.length >= maxMatches) return { matches, limited: true, truncated: true }
    }
  }
  return { matches, limited: result.truncated, truncated: result.truncated }
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/**
 * 把搜索参数编译成与 ripgrep 语义对齐的全局 RegExp。
 *
 * - `regex=false` 时查询串转义成字面量；
 * - `wholeWord` 用 `\b` 包裹（rg 的 --word-regexp 也是词边界语义）；
 * - `caseSensitive=false` 加 `i` 标志。
 * 正则写错时抛 invalid-regex：客户端在输入时就校验过，这里是服务端兜底。
 */
export function compileSearchPattern(request: Pick<SearchRequest, 'query' | 'regex' | 'wholeWord' | 'caseSensitive'>): RegExp {
  const source = request.regex === true ? request.query : escapeRegExp(request.query)
  const body = request.wholeWord === true ? `\\b(?:${source})\\b` : source
  try { return new RegExp(body, request.caseSensitive === true ? 'g' : 'gi') }
  catch (error) { throw new WorkbenchError('invalid-regex', error instanceof Error ? error.message : 'invalid regular expression') }
}

/**
 * VS Code 的「保留大小写」：按命中文本的形态改写替换结果。
 *
 * 只识别三种可判定形态（全大写 / 全小写 / 首字母大写），其余保持替换文本原样；
 * 逐词首字母大写（Title Case）的分支在这里刻意不做 —— 对中文与混合标识符都会给出意外结果。
 */
export function matchCase(matched: string, replacement: string): string {
  if (matched === '' || replacement === '') return replacement
  const upper = matched.toUpperCase()
  const lower = matched.toLowerCase()
  if (matched === upper && matched !== lower) return replacement.toUpperCase()
  if (matched === lower && matched !== upper) return replacement.toLowerCase()
  if (upper.charAt(0) === matched.charAt(0)) return replacement.charAt(0).toUpperCase() + replacement.slice(1)
  return replacement
}

/** 一行的替换结果；`replacements` 用于汇总替换总数。 */
function replaceLine(line: string, pattern: RegExp, replacement: string, preserveCase: boolean): { line: string; replacements: number } {
  let replacements = 0
  const next = line.replace(pattern, (matched: string) => {
    replacements++
    // 复用同一 pattern 展开 $1/$&/$$：命中文本本身必然在位置 0 上与 pattern 匹配，
    // 所以这次 replace 的捕获组与当前命中一致。
    const value = matched.replace(pattern, replacement)
    return preserveCase ? matchCase(matched, value) : value
  })
  return { line: next, replacements }
}

/**
 * 按行替换全文，保留原有行分隔符（CRLF 文件不会被改写成 LF）。
 *
 * 按行而不是整篇：ripgrep 是行内匹配，整篇替换会让 `^`/`$`/`\s` 这类元字符跨行，
 * 与「搜索结果里看到的那些命中」不再是同一批。
 */
export function replaceInText(text: string, pattern: RegExp, replacement: string, preserveCase = false): { text: string; replacements: number } {
  if (text === '') return { text, replacements: 0 }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  let replacements = 0
  const lines = text.split(eol).map(line => {
    const result = replaceLine(line, pattern, replacement, preserveCase)
    replacements += result.replacements
    return result.line
  })
  return { text: lines.join(eol), replacements }
}

/**
 * 只替换「某一行某一列」的那一处命中（VS Code 结果行上的单条替换）。
 *
 * 行列来自上一次搜索的结果，磁盘上的内容可能已经变了：这里要求该列上确实还有一个
 * 与 pattern 匹配的命中，否则返回 0 处（调用方据此提示「文件已变化」）。
 */
export function replaceSingleInText(text: string, pattern: RegExp, replacement: string, preserveCase: boolean, lineNumber: number, column: number): { text: string; replacements: number } {
  if (text === '' || lineNumber < 1 || column < 1) return { text, replacements: 0 }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(eol)
  const index = lineNumber - 1
  if (index >= lines.length) return { text, replacements: 0 }
  const target = lines[index] ?? ''
  pattern.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(target)) !== null) {
    if (match.index === column - 1) {
      const value = match[0].replace(pattern, replacement)
      const replaced = preserveCase ? matchCase(match[0], value) : value
      lines[index] = target.slice(0, match.index) + replaced + target.slice(match.index + match[0].length)
      return { text: lines.join(eol), replacements: 1 }
    }
    if (match.index > column - 1) break
    // 空匹配（例如 `a*`）会让 exec 原地打转，必须手动推进。
    if (match[0] === '') pattern.lastIndex++
  }
  return { text, replacements: 0 }
}

/**
 * 工作区替换。
 *
 * - 传了 `only` 就只改那一处，不再跑 ripgrep（结果行上的单条替换）；
 * - 否则 `rg --files-with-matches` 先取文件清单，再逐文件按行替换。
 *   为什么用 -l 而不是复用 searchWorkspace：替换全部命中不该被「2000 条匹配上限」截断。
 * 所有写入都走 writeAtomic，二进制文件与超限文件跳过（rg 侧已按 .gitignore/大小过滤）。
 */
export async function replaceInWorkspace(cwd: string, request: SearchReplaceRequest, signal?: AbortSignal, runner: ProcessRunner = run): Promise<SearchReplaceResult> {
  if (request.query === '') throw new WorkbenchError('bad-request', 'query is required')
  if (typeof request.replace !== 'string') throw new WorkbenchError('bad-request', 'replace must be a string')
  const only = request.only
  if (only !== undefined && (typeof only !== 'object' || only === null || typeof only.path !== 'string' || typeof only.line !== 'number' || typeof only.column !== 'number')) {
    throw new WorkbenchError('bad-request', 'only must be { path, line, column }')
  }
  const pattern = compileSearchPattern(request)
  const preserveCase = request.preserveCase === true
  const files: string[] = []
  let replacements = 0

  if (request.only !== undefined) {
    const { path, line, column } = request.only
    const { absolute } = await workspacePath(cwd, path)
    const text = await readFile(absolute, 'utf8')
    const result = replaceSingleInText(text, pattern, request.replace, preserveCase, line, column)
    if (result.replacements > 0) { await writeAtomic(absolute, result.text); files.push(path); replacements = result.replacements }
    return { files, replacements }
  }

  const root = await canonicalRoot(cwd)
  const rg = require('@vscode/ripgrep').rgPath as string
  const maxFileSize = positiveLimit(request.maxFileSize, SEARCH_MAX_FILE_BYTES)
  const args = ['--files-with-matches', '--null', '--hidden', '--glob', '!.git/**', '--max-filesize', String(maxFileSize)]
  if (!request.regex) args.push('--fixed-strings')
  if (!request.caseSensitive) args.push('--ignore-case')
  if (request.wholeWord) args.push('--word-regexp')
  if (request.include) args.push('--glob', request.include)
  if (request.exclude) args.push('--glob', `!${request.exclude}`)
  args.push('--', request.query, '.')
  const listed = await runner(rg, args, root, PROCESS_TIMEOUT, signal, SEARCH_MAX_OUTPUT_BYTES)
  if (listed.code > 1) throw new WorkbenchError('search-failed', listed.stderr || 'ripgrep failed', 500)
  for (const entry of listed.stdout.split('\0')) {
    const path = ripgrepRelative(entry.replace(/\r?\n$/, ''))
    if (path === '') continue
    if (signal?.aborted === true) break
    const { absolute } = await workspacePath(cwd, path)
    const text = await readFile(absolute, 'utf8')
    if (text.includes('\0')) continue // 二进制文件不参与文本替换
    const result = replaceInText(text, pattern, request.replace, preserveCase)
    if (result.replacements === 0) continue
    await writeAtomic(absolute, result.text)
    files.push(path); replacements += result.replacements
  }
  return { files, replacements }
}

/**
 * 每个 workspace 只跑一次 `rev-parse --show-toplevel`：一次面板 refresh / 一次动作里的
 * gitStatus、gitAction、gitObject 都复用同一个仓库根。失败不缓存（变为 git 仓库后可以重试）。
 * 进程生命周期内工作区被移动/删除时缓存会过期 —— 与审计报告一致的已知取舍。
 */
const gitRootCaches = new WeakMap<ProcessRunner, Map<string, Promise<string>>>()

function gitRootCacheFor(runner: ProcessRunner): Map<string, Promise<string>> {
  let cache = gitRootCaches.get(runner)
  if (cache === undefined) { cache = new Map(); gitRootCaches.set(runner, cache) }
  return cache
}

/** 仅供测试：清掉某个 runner 的 workspace→root 缓存。 */
export function resetGitRootCache(runner: ProcessRunner = run): void { gitRootCaches.get(runner)?.clear() }

async function gitRoot(cwd: string, runner: ProcessRunner = run): Promise<string> {
  const cache = gitRootCacheFor(runner)
  const cached = cache.get(cwd)
  if (cached !== undefined) return cached
  // 存 Promise 而不是结果：并发的 status/log 两个请求会共用同一次 rev-parse（refresh 冷启动 5→3）。
  const pending = (async () => {
    const result = await runner('git', ['rev-parse', '--show-toplevel'], cwd)
    if (result.code !== 0) throw new WorkbenchError('not-repository', 'current workspace is not inside a Git repository', 404)
    return result.stdout.trim()
  })()
  cache.set(cwd, pending)
  pending.catch(() => { if (cache.get(cwd) === pending) cache.delete(cwd) })
  return pending
}

function validateCommitHash(value?: string): string {
  if (!/^[0-9a-f]{7,64}$/i.test(value ?? '')) throw new WorkbenchError('bad-request', 'commit hash is invalid')
  return value!
}

function validateGitPath(repository: string, path?: string): string {
  if (path === undefined || path === '' || isAbsolute(path) || !inside(repository, resolve(repository, path))) throw new WorkbenchError('bad-request', 'repository-relative path is required')
  return path
}

async function gitObject(repository: string, spec: string, runner: ProcessRunner = run): Promise<string> {
  const result = await runner('git', ['show', '--no-textconv', spec], repository)
  return result.code === 0 ? result.stdout : ''
}

/**
 * 一次提交的文件列表 + 父提交探测结果。
 *
 * `commit.files` 只要 files；`commit.file.diff` 还要 parent 来决定用 diff 还是 show、以及拿
 * `previousPath`/`status`。两处共用同一次 `rev-parse hash^1`，避免 commit.file.diff 里重复探测。
 */
async function commitFilesWithParent(repository: string, hash: string, runner: ProcessRunner = run): Promise<{ files: GitCommitFile[]; parent: ProcessResult }> {
  const parent = await runner('git', ['rev-parse', '--verify', `${hash}^1`], repository)
  const result = parent.code===0
    ? await runner('git',['diff','--name-status','-z','-M',parent.stdout.trim(),hash,'--'],repository)
    : await runner('git', ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', '-M', hash], repository)
  if (result.code !== 0) throw new WorkbenchError('git-failed', result.stderr || result.stdout, 409)
  return { files: parseNameStatus(result.stdout), parent }
}

async function commitFiles(repository: string, hash: string, runner: ProcessRunner = run): Promise<GitCommitFile[]> {
  return (await commitFilesWithParent(repository, hash, runner)).files
}

export async function gitStatus(cwd: string, runner: ProcessRunner = run): Promise<GitStatus> {
  const repository = await gitRoot(cwd, runner)
  const result = await runner('git', ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], repository)
  if (result.code !== 0) throw new WorkbenchError('git-failed', result.stderr, 500)
  let branch = 'HEAD'; let ahead = 0; let behind = 0
  const changes: GitChange[] = []
  for (const record of result.stdout.split('\0')) {
    if (record.startsWith('# branch.head ')) branch = record.slice(14)
    else if (record.startsWith('# branch.ab ')) {
      const match = /\+(\d+) -(\d+)/.exec(record); ahead = Number(match?.[1] ?? 0); behind = Number(match?.[2] ?? 0)
    } else if (record.startsWith('? ')) changes.push({ path: record.slice(2), index: '?', worktree: '?', staged: false, untracked: true })
    else if (record.startsWith('1 ') || record.startsWith('2 ')) {
      const parts = record.split(' '); const xy = parts[1] ?? '..'; const path = parts.slice(record.startsWith('2 ') ? 9 : 8).join(' ')
      changes.push({ path, index: xy[0] ?? '.', worktree: xy[1] ?? '.', staged: xy[0] !== '.', untracked: false })
    }
  }
  return { repository, branch, ahead, behind, changes }
}

/**
 * 引用名守卫（分支 / 标签共用）。
 *
 * git 自己的规则很碎（`check-ref-format`），这里只挡「明显非法 / 危险」的写法：
 * 选项注入（以 `-` 开头）、空白、`..`、以及 git 明确禁止的字符，避免把用户输入当命令参数。
 */
const FORBIDDEN_REF_CHARS = [' ', '~', '^', ':', '?', '*', '[', '\\']
function validateRefName(value: string | undefined, label: string): string {
  const name = (value ?? '').trim()
  if (name === '' || name.startsWith('-') || name.includes('..') || name.endsWith('/') || name.endsWith('.')) {
    throw new WorkbenchError('bad-request', `${label} name is invalid`)
  }
  if (FORBIDDEN_REF_CHARS.some(char => name.includes(char))) throw new WorkbenchError('bad-request', `${label} name is invalid`)
  return name
}

export function validateBranchName(value: string | undefined): string { return validateRefName(value, 'branch') }

/** 标签名规则与分支一致：`check-ref-format` 对 refs/heads 与 refs/tags 是同一套。 */
export function validateTagName(value: string | undefined): string { return validateRefName(value, 'tag') }

/** 贮藏索引只接受纯数字：它会被拼进 `stash@{n}`，不能带任何其它字符。 */
function stashIndex(value: string | undefined): string {
  if (!/^\d+$/.test(value ?? '')) throw new WorkbenchError('bad-request', 'stash index is invalid')
  return value!
}

/** 提交图的取数：`-n` 条，可选 `--all`（显示全部分支）。 */
async function gitLog(runGit: (args: string[]) => Promise<ProcessResult>, count: number, all: boolean): Promise<GitCommit[]> {
  const limit = String(Math.min(1000, Math.max(1, count)))
  const args = ['log', '--topo-order', '--date=iso-strict', '--decorate=short', '--pretty=format:%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%D%x00', '-n', limit]
  if (all) args.push('--all')
  // 不再先跑 `rev-parse --verify HEAD`：正常仓库直接 log（-1 spawn）；失败时才懒回退判断空仓库。
  const result = await runGit(args)
  if (result.code !== 0) {
    const head = await runGit(['rev-parse', '--verify', 'HEAD'])
    if (head.code !== 0) return []
    throw new WorkbenchError('git-failed', result.stderr || result.stdout, 500)
  }
  return result.stdout.split('\0').filter(Boolean).map((record): GitCommit => {
    const [rawHash = '', parents = '', author = '', date = '', subject = '', refs = ''] = record.split('\x1f'); const hash = rawHash.trim()
    return { hash, parents: parents.split(' ').filter(Boolean), author, date, subject, refs: refs.split(',').map(item => item.trim()).filter(Boolean) }
  })
}

/** 本地 + 远程分支清单；空仓库（没有 HEAD）时 current 为空串。 */
async function gitBranchList(runGit: (args: string[]) => Promise<ProcessResult>): Promise<GitBranchList> {
  const current = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])
  const local = await runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  const remote = await runGit(['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])
  return {
    current: current.code === 0 ? current.stdout.trim() : '',
    local: local.code === 0 ? local.stdout.split('\n').map(value => value.trim()).filter(Boolean) : [],
    // `origin/HEAD` 是符号引用，列出来也签不出东西。
    remote: remote.code === 0 ? remote.stdout.split('\n').map(value => value.trim()).filter(value => value !== '' && !value.endsWith('/HEAD')) : [],
  }
}

/** 远程名列表：`remotes` / `remote.add` / `remote.remove` 返回同一形状（字符串数组）。 */
async function gitRemoteNames(runGit: (args: string[]) => Promise<ProcessResult>): Promise<string[]> {
  const result = await runGit(['remote'])
  if (result.code !== 0) throw new WorkbenchError('git-failed', result.stderr, 500)
  return result.stdout.split('\n').map(item => item.trim()).filter(Boolean)
}

/** 第一个远程名：push 类动作都约定推到第一个远程（与 VS Code 的提示语义一致）。 */
async function firstRemote(runGit: (args: string[]) => Promise<ProcessResult>): Promise<string> {
  const name = (await gitRemoteNames(runGit))[0]
  if (name === undefined) throw new WorkbenchError('git-failed', '没有配置远程仓库', 409)
  return name
}

/** 推送参数：有上游就普通 push，没有上游就把当前分支推到第一个远程（与 VS Code 的提示语义一致）。 */
async function gitPushArgs(runGit: (args: string[]) => Promise<ProcessResult>): Promise<string[]> {
  const upstream = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (upstream.code === 0) return ['push']
  const name = await firstRemote(runGit)
  const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])
  const branchName = branch.code === 0 ? branch.stdout.trim() : ''
  if (branchName === '' || branchName === 'HEAD') throw new WorkbenchError('git-failed', '当前不在任何分支上，无法推送', 409)
  return ['push', '--set-upstream', name, branchName]
}

/**
 * 把远程仓库克隆到工作区里的一个子目录。
 *
 * 不能先走 `gitRoot`：调用时工作区还不是 git 仓库（克隆成功后才变成仓库），所以这是唯一
 * 在解析仓库根之前执行的动作。目标只接受工作区相对路径：绝对路径或 `..` 一律拒绝，
 * 避免把仓库写到用户没有指定的位置；目录已存在等错误由 git 自己报，原样回传 stderr。
 */
async function cloneRepository(cwd: string, path: string | undefined, url: string | undefined, runner: ProcessRunner = run): Promise<{ cloned: true }> {
  const target = path ?? ''
  if (target === '' || isAbsolute(target) || target.split(/[\\/]/).some(part => part === '..')) throw new WorkbenchError('bad-request', 'clone destination is invalid')
  if (url === undefined || url === '') throw new WorkbenchError('bad-request', 'clone url is required')
  const result = await runner('git', ['clone', '--', url, target], cwd)
  if (result.code !== 0) throw new WorkbenchError('git-failed', result.stderr || result.stdout, 409)
  return { cloned: true }
}

/** `git --name-status -z` 的解析：R/C 记录后面跟「旧路径 + 新路径」两个 token。 */
function parseNameStatus(stdout: string): GitCommitFile[] {
  const tokens = stdout.split('\0').filter(Boolean)
  const files: GitCommitFile[] = []
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++] ?? ''
    const code = status[0] ?? ''
    if (code === 'R' || code === 'C') { const previousPath = tokens[index++] ?? ''; const path = tokens[index++] ?? ''; files.push({ path, previousPath, status: code }) }
    else { const path = tokens[index++] ?? ''; files.push({ path, status: code }) }
  }
  return files
}

/**
 * `--numstat -z` 的解析。
 *
 * 为什么要和 name-status 的文件列表配对：-z 模式下 numstat 把路径拆成独立 token（重命名还会多一个旧路径），
 * 单看 numstat 无法可靠区分「普通文件」与「重命名」；而 name-status 里已经知道哪些记录是 R/C，
 * 按同一顺序消费 token 就是确定的。两个命令必须用同一套 `-M` 与提交区间，否则顺序可能不同。
 */
function parseNumstat(stdout: string, files: readonly GitCommitFile[]): GitCommitFileDetail[] {
  // 实测格式（git 2.52，-z）：普通文件是 `adds\tdels\tpath` 一个 token；重命名是 `adds\tdels\t` + 旧路径 + 新路径。
  const tokens = stdout.split('\0').filter(token => token !== '')
  let cursor = 0
  return files.map(file => {
    const header = tokens[cursor++] ?? ''
    const parts = header.split('\t')
    const adds = parts[0] ?? '0'
    const dels = parts[1] ?? '0'
    let path = parts.slice(2).join('\t')
    let previousPath: string | undefined
    if (path === '') { previousPath = tokens[cursor++] ?? undefined; path = tokens[cursor++] ?? '' }
    const binary = adds === '-' || dels === '-'
    return { status: file.status, path: path === '' ? file.path : path, ...(previousPath === undefined ? {} : { previousPath }), binary, additions: binary ? 0 : Number.parseInt(adds, 10) || 0, deletions: binary ? 0 : Number.parseInt(dels, 10) || 0 }
  })
}
async function numstatFiles(runGit: (args: string[]) => Promise<ProcessResult>, args: string[], files: readonly GitCommitFile[]): Promise<GitCommitFileDetail[]> {
  if (files.length === 0) return []
  const result = await runGit(args)
  if (result.code !== 0) throw new WorkbenchError('git-failed', result.stderr || result.stdout, 409)
  return parseNumstat(result.stdout, files)
}

/** 一次提交的完整详情（提交详情面板）：元信息 + 完整正文 + 每个文件的增删行数。 */
async function commitDetail(repository: string, hash: string, runner: ProcessRunner): Promise<GitCommitDetail> {
  const runGit = (gitArgs: string[]) => runner('git', gitArgs, repository)
  const meta = await runGit(['log', '-1', '--date=iso-strict', '--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b', hash])
  if (meta.code !== 0) throw new WorkbenchError('git-failed', meta.stderr || meta.stdout, 409)
  const [fullHash = '', parents = '', author = '', email = '', date = '', subject = '', body = ''] = meta.stdout.split('\x1f')
  const { files, parent } = await commitFilesWithParent(repository, hash, runner)
  // 根提交没有父：diff-tree --root 才能列出首次提交的文件（与 commitFilesWithParent 的根分支同一套参数）。
  const stats = await numstatFiles(runGit, parent.code === 0
    ? ['diff', '--numstat', '-z', '-M', parent.stdout.trim(), hash]
    : ['diff-tree', '--root', '--no-commit-id', '-r', '--numstat', '-z', '-M', hash], files)
  return { hash: fullHash.trim() || hash, parents: parents.split(' ').filter(Boolean), author, email, date, subject, body: body.trimEnd(), files: stats }
}

/** 两个提交之间的文件变更（提交对比视图）。 */
async function compareFiles(repository: string, from: string, to: string, runner: ProcessRunner): Promise<GitCommitFileDetail[]> {
  const runGit = (gitArgs: string[]) => runner('git', gitArgs, repository)
  const nameStatus = await runGit(['diff', '--name-status', '-z', '-M', from, to])
  if (nameStatus.code !== 0) throw new WorkbenchError('git-failed', nameStatus.stderr || nameStatus.stdout, 409)
  const files = parseNameStatus(nameStatus.stdout)
  return numstatFiles(runGit, ['diff', '--numstat', '-z', '-M', from, to], files)
}

export async function gitAction(cwd: string, action: string, path?: string, value?: string, runner: ProcessRunner = run): Promise<unknown> {
  // clone 必须在 gitRoot 之前：这是唯一能把「非仓库工作区」变成仓库的动作。
  if (action === 'clone') return cloneRepository(cwd, path, value, runner)
  const repository = await gitRoot(cwd, runner)
  // 同一个动作里的所有 git 调用共用一个已解析的仓库根：不再每个 run 都重新 rev-parse。
  const runGit = (gitArgs: string[]): Promise<ProcessResult> => runner('git', gitArgs, repository)
  let args: string[]
  switch (action) {
    case 'stage': args = ['add', '--', path ?? '']; break
    case 'stage.all': args = ['add', '-A']; break
    case 'unstage': args = ['restore', '--staged', '--', path ?? '']; break
    case 'unstage.all': args = ['restore', '--staged', '--', '.']; break
    case 'discard': {
      args = value === 'untracked' ? ['clean', '-f', '--', path ?? ''] : ['restore', '--worktree', '--', path ?? '']
      break
    }
    case 'discard.all': {
      const head = await runGit(['rev-parse', '--verify', 'HEAD'])
      if (head.code === 0) {
        const restore = await runGit(['restore', '--source=HEAD', '--staged', '--worktree', '--', '.'])
        if (restore.code !== 0) throw new WorkbenchError('git-failed', restore.stderr || restore.stdout, 409)
      }
      const clean = await runGit(['clean', '-fd'])
      if (clean.code !== 0) throw new WorkbenchError('git-failed', clean.stderr || clean.stdout, 409)
      return gitStatus(cwd, runner)
    }
    case 'commit': args = ['commit', '-m', value ?? '']; break
    // 一次做完 add -A + commit：客户端「提交全部」少一次往返，也避免两步之间工作区被外部改脏。
    case 'commit.all': {
      const add = await runGit(['add', '-A'])
      if (add.code !== 0) throw new WorkbenchError('git-failed', add.stderr || add.stdout, 409)
      const commit = await runGit(['commit', '-m', value ?? ''])
      if (commit.code !== 0) throw new WorkbenchError('git-failed', commit.stderr || commit.stdout, 409)
      return gitStatus(cwd, runner)
    }
    // 软回退：提交内容退回暂存区，工作区不动；没有 HEAD 时 git 自己非零退出。
    case 'commit.undo': args = ['reset', '--soft', 'HEAD~1']; break
    case 'branch.create': args = ['switch', '-c', validateBranchName(value)]; break
    case 'branch.switch': {
      const name = validateBranchName(value)
      const direct = await runGit(['switch', name])
      // 远程分支（origin/x）不能直接签出：先试一次，失败再退回 --track 建同名本地分支。
      if (direct.code !== 0) {
        const local = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name
        const track = await runGit(['switch', '--track', '-c', local, name])
        if (track.code !== 0) throw new WorkbenchError('git-failed', track.stderr || direct.stderr || direct.stdout, 409)
      }
      return gitStatus(cwd, runner)
    }
    case 'branch.delete': args = ['branch', '-d', validateBranchName(value)]; break
    // path 复用为旧名、value 为新名：与 commit.branch 的「path 放名字」约定一致。
    case 'branch.rename': args = ['branch', '-m', validateBranchName(path), validateBranchName(value)]; break
    case 'branch.list': return gitBranchList(runGit)
    // 冲突时 git 非零退出；这里不自动 abort，由用户决定解冲突还是 merge.abort。
    case 'merge': {
      const branch = validateBranchName(value)
      const merged = await runGit(['merge', '--no-edit', branch])
      if (merged.code !== 0) throw new WorkbenchError('git-failed', merged.stderr || merged.stdout, 409)
      return gitStatus(cwd, runner)
    }
    case 'merge.abort': args = ['merge', '--abort']; break
    case 'rebase': args = ['rebase', validateBranchName(value)]; break
    // 贮藏：默认连未跟踪文件一起收走，否则 stash 之后工作区仍然是脏的（面板「贮藏」的用户预期）。
    // `--staged` 只贮藏已暂存内容；这时未暂存/未跟踪的改动留在工作区。
    case 'stash.push': {
      const message = value ?? ''
      args = path === 'staged' ? ['stash', 'push', '--staged'] : ['stash', 'push', '--include-untracked']
      if (message !== '') args.push('-m', message)
      break
    }
    case 'stash.list': {
      // 不能用 `%gI`：git 没有这个 pretty 占位符（会原样输出）；`%cI` 同样是严格 ISO 8601。
      // 也不能带 `--date=...`：那会把 `%gd` 从 `stash@{0}` 变成日期形式，索引就取不出来了。
      const listed = await runGit(['stash', 'list', '--pretty=format:%gd%x1f%gs%x1f%cI%x00'])
      if (listed.code !== 0) throw new WorkbenchError('git-failed', listed.stderr || listed.stdout, 500)
      const stashes: GitStash[] = []
      // `%x00` 之后 git 还会补一个换行：先剥掉记录之间的分隔符。
      for (const record of listed.stdout.split('\0')) {
        const line = record.replace(/^\r?\n/, '')
        if (line === '') continue
        const [ref = '', message = '', date = ''] = line.split('\x1f')
        const match = /stash@\{(\d+)\}/.exec(ref)
        if (match === null) continue
        stashes.push({ index: Number(match[1]), message, date })
      }
      return stashes
    }
    case 'stash.apply':
    case 'stash.pop':
    case 'stash.drop': {
      // 索引会拼进 stash@{n}：只接受纯数字，绝不能把别的字符带进 git 参数。
      args = ['stash', action.slice('stash.'.length), `stash@{${stashIndex(value)}}`]
      break
    }
    case 'tag.list': {
      // for-each-ref 的转义是 `%xx`（不是 pretty 格式的 `%xNN`），所以这里写 `%1f`；`%x1f` 会印成字面量。
      const listed = await runGit(['for-each-ref', '--format=%(refname:short)%1f%(objectname:short)%1f%(subject)', 'refs/tags'])
      if (listed.code !== 0) throw new WorkbenchError('git-failed', listed.stderr || listed.stdout, 500)
      return listed.stdout.split('\n').filter(Boolean).map((record): GitTag => {
        const [name = '', hash = '', subject = ''] = record.split('\x1f')
        return { name, hash, subject }
      })
    }
    case 'tag.create': {
      const name = validateTagName(value)
      // 轻量标签：不传 path 就钉在 HEAD，传了就钉在指定提交上。
      args = path === undefined || path === '' ? ['tag', name] : ['tag', name, validateCommitHash(path)]
      break
    }
    case 'tag.delete': args = ['tag', '-d', validateTagName(value)]; break
    case 'tag.push': {
      // 空串表示推送全部标签；空值不进 args，否则会被统一的「空参数」检查误判成 bad-request。
      const name = (value ?? '') === '' ? undefined : validateTagName(value)
      const remote = await firstRemote(runGit)
      args = name === undefined ? ['push', remote, '--tags'] : ['push', remote, name]
      break
    }
    case 'remotes': return gitRemoteNames(runGit)
    case 'remote.add': {
      if (path === undefined || path === '' || value === undefined || value === '') throw new WorkbenchError('bad-request', 'remote name and url are required')
      const added = await runGit(['remote', 'add', path, value])
      if (added.code !== 0) throw new WorkbenchError('git-failed', added.stderr || added.stdout, 409)
      return gitRemoteNames(runGit)
    }
    case 'remote.remove': {
      if (value === undefined || value === '') throw new WorkbenchError('bad-request', 'remote name is required')
      const removed = await runGit(['remote', 'remove', value])
      if (removed.code !== 0) throw new WorkbenchError('git-failed', removed.stderr || removed.stdout, 409)
      return gitRemoteNames(runGit)
    }
    case 'branches': {
      const result = await runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
      if (result.code !== 0) throw new WorkbenchError('git-failed', result.stderr, 500)
      return result.stdout.split('\n').filter(Boolean)
    }
    case 'log':
    case 'log.all': return gitLog(runGit, Number.parseInt(value ?? '', 10) || 100, action === 'log.all')
    case 'commit.show': {
      const hash = validateCommitHash(value)
      const result = await runGit(['show', '--no-ext-diff', '--find-renames', '--format=fuller', '--stat', '--patch', '--no-color', hash])
      if (result.code !== 0) throw new WorkbenchError('git-failed', result.stderr || result.stdout, 409)
      return { diff: result.stdout, original: '', modified: result.stdout } satisfies GitDiff
    }
    case 'commit.files': return commitFiles(repository, validateCommitHash(value), runner)
    case 'commit.file.diff': {
      const hash=validateCommitHash(value);const target=validateGitPath(repository,path)
      // 文件列表与父提交由同一次探测得到：不再先 commitFiles 再单独 rev-parse hash^1。
      const { files, parent } = await commitFilesWithParent(repository, hash, runner);const file=files.find(item=>item.path===target)
      if (file===undefined) throw new WorkbenchError('not-found','file is not part of the commit',404)
      const shown=parent.code===0
        ? await runGit(['diff','--no-ext-diff','--find-renames','--patch','--no-color',parent.stdout.trim(),hash,'--',file.previousPath??target,target])
        : await runGit(['show','--no-ext-diff','--find-renames','--format=','--patch','--no-color',hash,'--',file.previousPath??target,target])
      if(shown.code!==0)throw new WorkbenchError('git-failed',shown.stderr||shown.stdout,409)
      const original=file.status==='A'||parent.code!==0?'':await gitObject(repository,`${parent.stdout.trim()}:${file.previousPath??target}`, runner)
      const modified=file.status==='D'?'':await gitObject(repository,`${hash}:${target}`, runner)
      return {diff:shown.stdout,original,modified} satisfies GitDiff
    }
    case 'commit.detail': return commitDetail(repository, validateCommitHash(value), runner)
    case 'compare.files': return compareFiles(repository, validateCommitHash(path), validateCommitHash(value), runner)
    /**
     * 提交对比里打开单个文件的差异：path = 文件，value = `from..to` 两个哈希。
     * 与原版 Git Graph 的 Commit Comparison View 一样，diff 走编辑器里现成的差异标签。
     */
    case 'range.file.diff': {
      const target = validateGitPath(repository, path)
      const [rawFrom = '', rawTo = ''] = (value ?? '').split('..')
      const from = validateCommitHash(rawFrom); const to = validateCommitHash(rawTo)
      const shown = await runGit(['diff', '--no-ext-diff', '--find-renames', '--patch', '--no-color', from, to, '--', target])
      if (shown.code !== 0) throw new WorkbenchError('git-failed', shown.stderr || shown.stdout, 409)
      const original = await gitObject(repository, `${from}:${target}`, runner)
      const modified = await gitObject(repository, `${to}:${target}`, runner)
      return { diff: shown.stdout, original, modified } satisfies GitDiff
    }
    case 'commit.checkout': args = ['switch', '--detach', validateCommitHash(value)]; break
    // path 在这里复用为「新分支名」，value 是基准提交（与 commit.show / commit.files 一样把哈希放 value）。
    case 'commit.branch': args = ['switch', '-c', validateBranchName(path), validateCommitHash(value)]; break
    case 'commit.cherrypick': args = ['cherry-pick', validateCommitHash(value)]; break
    case 'commit.revert': args = ['revert', '--no-edit', validateCommitHash(value)]; break
    // 远程动作：`run()` 给 git 带了 GIT_TERMINAL_PROMPT=0，缺凭据时立刻报错而不是等满超时。
    case 'fetch': args = ['fetch', '--all', '--prune', '--quiet']; break
    case 'pull': args = ['pull']; break
    case 'push': args = await gitPushArgs(runGit); break
    case 'sync': {
      const pull = await runGit(['pull'])
      if (pull.code !== 0) throw new WorkbenchError('git-failed', pull.stderr || pull.stdout, 409)
      const push = await runGit(await gitPushArgs(runGit))
      if (push.code !== 0) throw new WorkbenchError('git-failed', push.stderr || push.stdout, 409)
      return gitStatus(cwd, runner)
    }
    case 'diff': {
      const untracked = value === 'untracked'
      const staged = value === 'staged'
      args = untracked
        ? ['diff', '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', path ?? '']
        : ['diff', ...(staged ? ['--cached'] : []), '--', path ?? '']
      break
    }
    default: throw new WorkbenchError('bad-action', `unknown Git action ${action}`)
  }
  if (args.some(arg => arg === '') && action !== 'commit') throw new WorkbenchError('bad-request', 'path or value is required')
  const result = await runGit(args)
  const expectedUntrackedDifference = action === 'diff' && value === 'untracked' && result.code === 1
  if (result.code !== 0 && !expectedUntrackedDifference) throw new WorkbenchError('git-failed', result.stderr || result.stdout, 409)
  if(action!=='diff')return gitStatus(cwd, runner)
  const target=validateGitPath(repository,path)
  const original=value==='untracked'?'':await gitObject(repository,`${value==='staged'?'HEAD:':':'}${target}`, runner)
  const modified=value==='staged'?await gitObject(repository,`:${target}`, runner):await readFile(resolve(repository,target),'utf8').catch(()=> '')
  return {diff:result.stdout,original,modified} satisfies GitDiff
}

