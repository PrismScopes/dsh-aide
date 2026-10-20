import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { access, cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import type { HostContext } from './context.ts'
import type { FileDocument, FileEntry, GitChange, GitCommit, GitCommitFile, GitDiff, GitStatus, SearchMatch, SearchRequest } from './types.ts'
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

/** target 是否落在 root 之内（含 root 本身）。assets.ts 也用它守卫包目录。 */
export function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function canonicalRoot(cwd: string): Promise<string> {
  return realpath(cwd).catch(() => { throw new WorkbenchError('cwd-missing', 'session working directory does not exist', 404) })
}

/** Resolve a caller-relative path and reject traversal and symlink escape. */
export async function workspacePath(cwd: string, raw: string, create = false): Promise<{ root: string; absolute: string }> {
  if (isAbsolute(raw)) throw new WorkbenchError('path-invalid', 'absolute paths are not accepted')
  const root = await canonicalRoot(cwd)
  const absolute = resolve(root, raw === '' ? '.' : raw)
  if (!inside(root, absolute)) throw new WorkbenchError('path-outside', 'path is outside the workspace', 403)
  if (create) {
    const parent = await realpath(dirname(absolute)).catch(() => { throw new WorkbenchError('parent-missing', 'parent directory does not exist', 404) })
    if (!inside(root, parent)) throw new WorkbenchError('path-outside', 'path follows a symlink outside the workspace', 403)
  } else {
    const actual = await realpath(absolute).catch(() => { throw new WorkbenchError('not-found', 'path does not exist', 404) })
    if (!inside(root, actual)) throw new WorkbenchError('path-outside', 'path follows a symlink outside the workspace', 403)
  }
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
  const temp = join(dirname(absolute), `.${randomUUID()}.dsh-vscode.tmp`)
  await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' })
  try { await rename(temp, absolute) } catch (error) { await rm(temp, { force: true }); throw error }
  return readDocument(cwd, path)
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

interface ProcessResult { stdout: string; stderr: string; code: number }
export function run(command: string, args: string[], cwd: string, timeout = PROCESS_TIMEOUT, signal?: AbortSignal): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true })
    let stdout = ''; let stderr = ''; let settled = false
    const timer = setTimeout(() => { child.kill(); if (!settled) reject(new WorkbenchError('timeout', `${command} timed out`, 504)) }, timeout)
    const abort = () => { child.kill(); if (!settled) { settled = true; clearTimeout(timer); reject(new WorkbenchError('cancelled', `${command} cancelled`, 499)) } }
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (!settled) { settled = true; reject(error) } })
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (!settled) { settled = true; resolvePromise({ stdout, stderr, code: code ?? 1 }) } })
  })
}

export async function searchWorkspace(cwd: string, request: SearchRequest, signal?: AbortSignal): Promise<{ matches: SearchMatch[]; limited: boolean }> {
  if (request.query === '') return { matches: [], limited: false }
  const root = await canonicalRoot(cwd)
  const rg = require('@vscode/ripgrep').rgPath as string
  const args = ['--json', '--line-number', '--column', '--hidden', '--glob', '!.git/**', '--max-count', '2000']
  if (!request.regex) args.push('--fixed-strings')
  if (!request.caseSensitive) args.push('--ignore-case')
  if (request.wholeWord) args.push('--word-regexp')
  if (request.include) args.push('--glob', request.include)
  if (request.exclude) args.push('--glob', `!${request.exclude}`)
  args.push('--', request.query, '.')
  const result = await run(rg, args, root, PROCESS_TIMEOUT, signal)
  if (result.code > 1) throw new WorkbenchError('search-failed', result.stderr || 'ripgrep failed', 500)
  const matches: SearchMatch[] = []
  for (const line of result.stdout.split('\n')) {
    if (line === '') continue
    const event = JSON.parse(line) as { type: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number; submatches?: Array<{ start: number; end: number; match?: { text?: string } }> } }
    if (event.type !== 'match' || event.data?.path?.text === undefined || event.data.lines?.text === undefined) continue
    for (const hit of event.data.submatches ?? []) {
      matches.push({ path: event.data.path.text.replace(/^\.\//, ''), line: event.data.line_number ?? 1, column: hit.start + 1, preview: event.data.lines.text.trimEnd(), match: hit.match?.text ?? '' })
      if (matches.length >= 2000) return { matches, limited: true }
    }
  }
  return { matches, limited: false }
}

async function gitRoot(cwd: string): Promise<string> {
  const result = await run('git', ['rev-parse', '--show-toplevel'], cwd)
  if (result.code !== 0) throw new WorkbenchError('not-repository', 'current workspace is not inside a Git repository', 404)
  return result.stdout.trim()
}

function validateCommitHash(value?: string): string {
  if (!/^[0-9a-f]{7,64}$/i.test(value ?? '')) throw new WorkbenchError('bad-request', 'commit hash is invalid')
  return value!
}

function validateGitPath(repository: string, path?: string): string {
  if (path === undefined || path === '' || isAbsolute(path) || !inside(repository, resolve(repository, path))) throw new WorkbenchError('bad-request', 'repository-relative path is required')
  return path
}

async function gitObject(repository: string, spec: string): Promise<string> {
  const result = await run('git', ['show', '--no-textconv', spec], repository)
  return result.code === 0 ? result.stdout : ''
}

async function commitFiles(repository: string, hash: string): Promise<GitCommitFile[]> {
  const parent=await run('git',['rev-parse','--verify',`${hash}^1`],repository)
  const result = parent.code===0
    ? await run('git',['diff','--name-status','-z','-M',parent.stdout.trim(),hash,'--'],repository)
    : await run('git', ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', '-M', hash], repository)
  if (result.code !== 0) throw new WorkbenchError('git-failed', result.stderr || result.stdout, 409)
  const tokens = result.stdout.split('\0').filter(Boolean); const files: GitCommitFile[] = []
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++] ?? ''; const code = status[0] ?? ''
    if (code === 'R' || code === 'C') { const previousPath=tokens[index++]??'';const path=tokens[index++]??'';files.push({path,previousPath,status:code}) }
    else { const path=tokens[index++]??'';files.push({path,status:code}) }
  }
  return files
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const repository = await gitRoot(cwd)
  const result = await run('git', ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], repository)
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

export async function gitAction(cwd: string, action: string, path?: string, value?: string): Promise<unknown> {
  const repository = await gitRoot(cwd)
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
      const head = await run('git', ['rev-parse', '--verify', 'HEAD'], repository)
      if (head.code === 0) {
        const restore = await run('git', ['restore', '--source=HEAD', '--staged', '--worktree', '--', '.'], repository)
        if (restore.code !== 0) throw new WorkbenchError('git-failed', restore.stderr || restore.stdout, 409)
      }
      const clean = await run('git', ['clean', '-fd'], repository)
      if (clean.code !== 0) throw new WorkbenchError('git-failed', clean.stderr || clean.stdout, 409)
      return gitStatus(cwd)
    }
    case 'commit': args = ['commit', '-m', value ?? '']; break
    case 'branch.create': args = ['switch', '-c', value ?? '']; break
    case 'branch.switch': args = ['switch', value ?? '']; break
    case 'branches': {
      const result = await run('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], repository)
      if (result.code !== 0) throw new WorkbenchError('git-failed', result.stderr, 500)
      return result.stdout.split('\n').filter(Boolean)
    }
    case 'log': {
      const head = await run('git', ['rev-parse', '--verify', 'HEAD'], repository)
      if (head.code !== 0) return []
      const result = await run('git', ['log', '--topo-order', '--date=iso-strict', '--decorate=short', '--pretty=format:%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%D%x00', '-n', '100'], repository)
      if (result.code !== 0) throw new WorkbenchError('git-failed', result.stderr || result.stdout, 500)
      return result.stdout.split('\0').filter(Boolean).map((record): GitCommit => {
        const [rawHash = '', parents = '', author = '', date = '', subject = '', refs = ''] = record.split('\x1f');const hash=rawHash.trim()
        return { hash, parents: parents.split(' ').filter(Boolean), author, date, subject, refs: refs.split(',').map(item => item.trim()).filter(Boolean) }
      })
    }
    case 'commit.show': {
      const hash = validateCommitHash(value)
      const result = await run('git', ['show', '--no-ext-diff', '--find-renames', '--format=fuller', '--stat', '--patch', '--no-color', hash], repository)
      if (result.code !== 0) throw new WorkbenchError('git-failed', result.stderr || result.stdout, 409)
      return { diff: result.stdout, original: '', modified: result.stdout } satisfies GitDiff
    }
    case 'commit.files': return commitFiles(repository, validateCommitHash(value))
    case 'commit.file.diff': {
      const hash=validateCommitHash(value);const target=validateGitPath(repository,path);const files=await commitFiles(repository,hash);const file=files.find(item=>item.path===target)
      if (file===undefined) throw new WorkbenchError('not-found','file is not part of the commit',404)
      const parent=await run('git',['rev-parse','--verify',`${hash}^1`],repository)
      const shown=parent.code===0
        ? await run('git',['diff','--no-ext-diff','--find-renames','--patch','--no-color',parent.stdout.trim(),hash,'--',file.previousPath??target,target],repository)
        : await run('git',['show','--no-ext-diff','--find-renames','--format=','--patch','--no-color',hash,'--',file.previousPath??target,target],repository)
      if(shown.code!==0)throw new WorkbenchError('git-failed',shown.stderr||shown.stdout,409)
      const original=file.status==='A'||parent.code!==0?'':await gitObject(repository,`${parent.stdout.trim()}:${file.previousPath??target}`)
      const modified=file.status==='D'?'':await gitObject(repository,`${hash}:${target}`)
      return {diff:shown.stdout,original,modified} satisfies GitDiff
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
  const result = await run('git', args, repository)
  const expectedUntrackedDifference = action === 'diff' && value === 'untracked' && result.code === 1
  if (result.code !== 0 && !expectedUntrackedDifference) throw new WorkbenchError('git-failed', result.stderr || result.stdout, 409)
  if(action!=='diff')return gitStatus(cwd)
  const target=validateGitPath(repository,path)
  const original=value==='untracked'?'':await gitObject(repository,`${value==='staged'?'HEAD:':':'}${target}`)
  const modified=value==='staged'?await gitObject(repository,`:${target}`):await readFile(resolve(repository,target),'utf8').catch(()=> '')
  return {diff:result.stdout,original,modified} satisfies GitDiff
}

