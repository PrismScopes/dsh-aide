import { mkdtemp, mkdir, realpath, rm, symlink, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { codiconAsset, createEntry, gitAction, gitStatus, listFiles, pdfWorkerAsset, readDocument, renameEntry, resetGitRootCache, saveDocument, searchWorkspace, uploadFile, workspacePath, workspacePreviewFile, type ProcessRunner } from '../src/host.ts'

const roots:string[]=[]
async function temp(){const value=await mkdtemp(join(tmpdir(),'dvw-'));roots.push(value);return value}
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})))})

describe('workspace filesystem',()=>{
  it('lists lazily and performs guarded mutations',async()=>{const root=await temp();await mkdir(join(root,'src'));await writeFile(join(root,'src','a.ts'),'one');expect((await listFiles(root,'')).map(x=>x.name)).toEqual(['src']);const doc=await readDocument(root,'src/a.ts');await saveDocument(root,'src/a.ts','two',doc.revision);expect(await readFile(join(root,'src','a.ts'),'utf8')).toBe('two');await createEntry(root,'src/b.ts','file');await renameEntry(root,'src/b.ts','src/c.ts');expect((await listFiles(root,'src')).map(x=>x.name)).toEqual(['a.ts','c.ts'])})
  it('rejects traversal and symlink escape',async()=>{const root=await temp();const outside=await temp();await writeFile(join(outside,'secret'),'x');await symlink(outside,join(root,'link'));await expect(workspacePath(root,'../x')).rejects.toMatchObject({code:'path-outside'});await expect(readDocument(root,'link/secret')).rejects.toMatchObject({code:'path-outside'})})
  it('hides external links and follows links that stay inside the workspace',async()=>{const root=await temp();const outside=await temp();await mkdir(join(root,'src'));await writeFile(join(root,'src','inside.txt'),'inside');await writeFile(join(outside,'outside.txt'),'outside');await symlink(join(root,'src'),join(root,'internal-link'),process.platform==='win32'?'junction':'dir');await symlink(outside,join(root,'external-link'),process.platform==='win32'?'junction':'dir');expect((await listFiles(root,'')).map(entry=>[entry.name,entry.kind])).toEqual([['internal-link','directory'],['src','directory']]);expect((await listFiles(root,'internal-link')).map(entry=>entry.name)).toEqual(['inside.txt']);expect((await readDocument(root,'internal-link/inside.txt')).content).toBe('inside')})
  it('rejects stale saves',async()=>{const root=await temp();await writeFile(join(root,'a'),'one');const doc=await readDocument(root,'a');await writeFile(join(root,'a'),'external');await expect(saveDocument(root,'a','mine',doc.revision)).rejects.toMatchObject({code:'revision-conflict'})})
  it('uploads files only to an existing workspace directory without overwriting',async()=>{const root=await temp();await mkdir(join(root,'uploads'));const entry=await uploadFile(root,'uploads','report.txt',Buffer.from('received'));expect(entry.path).toBe('uploads/report.txt');expect(await readFile(join(root,'uploads','report.txt'),'utf8')).toBe('received');await expect(uploadFile(root,'uploads','report.txt',Buffer.from('again'))).rejects.toMatchObject({code:'EEXIST'});await expect(uploadFile(root,'../outside','x.txt',Buffer.from('x'))).rejects.toMatchObject({code:'path-outside'});await expect(uploadFile(root,'uploads','../x.txt',Buffer.from('x'))).rejects.toMatchObject({code:'filename-invalid'})})
  it('serves images, PDF and Word documents through the protected preview resolver',async()=>{const root=await temp();await writeFile(join(root,'preview.png'),'image');await writeFile(join(root,'report.pdf'),'pdf');await writeFile(join(root,'report.docx'),'word');await writeFile(join(root,'notes.txt'),'text');expect(await workspacePreviewFile(root,'preview.png')).toMatchObject({type:'image/png'});expect(await workspacePreviewFile(root,'report.pdf')).toMatchObject({type:'application/pdf'});expect(await workspacePreviewFile(root,'report.docx')).toMatchObject({type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});await expect(workspacePreviewFile(root,'notes.txt')).rejects.toMatchObject({code:'unsupported-media'});await expect(workspacePreviewFile(root,'../preview.png')).rejects.toMatchObject({code:'path-outside'})})
})

describe('workspace path resolution', () => {
  it('keeps the file API error codes for absolute/traversal/missing/create-parent cases', async () => {
    const root = await temp()
    await mkdir(join(root, 'src'))
    await expect(workspacePath(root, '../x')).rejects.toMatchObject({ code: 'path-outside', status: 403 })
    await expect(workspacePath(root, 'src/../../x')).rejects.toMatchObject({ code: 'path-outside', status: 403 })
    await expect(workspacePath(root, '/outside/absolute')).rejects.toMatchObject({ code: 'path-invalid', status: 400 })
    await expect(workspacePath(root, 'missing.txt')).rejects.toMatchObject({ code: 'not-found', status: 404 })
    await expect(workspacePath(root, 'missing/gone.txt', true)).rejects.toMatchObject({ code: 'parent-missing', status: 404 })
    await expect(workspacePath(root, 'src')).resolves.toMatchObject({ absolute: join(await realpath(root), 'src') })
    await expect(workspacePath(root, 'src/new.txt', true)).resolves.toMatchObject({ absolute: join(await realpath(root), 'src', 'new.txt') })
  })
})

/**
 * 造一个假的进程执行器：记录每次 `command args...`，按 args 返回假 stdout。
 * 用于断言 spawn 次数与上限逻辑，不真的起 git/rg。
 */
function fakeProcess(handler: (args: string[]) => { stdout?: string; stderr?: string; code?: number; truncated?: boolean }): { runner: ProcessRunner; calls: string[][] } {
  const calls: string[][] = []
  const runner: ProcessRunner = async (command, args) => {
    calls.push([command, ...args])
    const reply = handler(args)
    return { stdout: reply.stdout ?? '', stderr: reply.stderr ?? '', code: reply.code ?? 0, truncated: reply.truncated === true }
  }
  return { runner, calls }
}

const STATUS_OUTPUT = '# branch.head main\0# branch.ab +1 -2\0? untracked.txt\0'
const LOG_OUTPUT = 'aaaa1111\x1fb000\x1fAuthor\x1f2026-01-01T00:00:00Z\x1fsubject\x1fHEAD -> main\x00'
const revParseCount = (calls: string[][]): number => calls.filter(call => call[1] === 'rev-parse').length

/** 常规 git 假实现：root 探测 / status / log / 各种写动作。 */
function gitHandler(root: string) {
  return (args: string[]) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { stdout: `${root}\n` }
    if (args[0] === 'status') return { stdout: STATUS_OUTPUT }
    if (args[0] === 'log') return { stdout: LOG_OUTPUT }
    if (['add', 'commit', 'restore', 'clean', 'switch', 'diff', 'show', 'diff-tree', 'for-each-ref'].includes(args[0] ?? '')) return {}
    throw new Error(`unexpected git args: ${args.join(' ')}`)
  }
}

describe('git process budget', () => {
  it('cold refresh shares one rev-parse (3 spawns) and a warm refresh is status+log only (2)', async () => {
    const root = await temp()
    const fake = fakeProcess(gitHandler(root))
    const [status, commits] = await Promise.all([
      gitStatus(root, fake.runner),
      gitAction(root, 'log', undefined, undefined, fake.runner),
    ])
    expect(status).toMatchObject({ repository: root, branch: 'main', ahead: 1, behind: 2 })
    expect(status.changes).toEqual([{ path: 'untracked.txt', index: '?', worktree: '?', staged: false, untracked: true }])
    expect(commits).toMatchObject([{ hash: 'aaaa1111', parents: ['b000'], subject: 'subject' }])
    expect(revParseCount(fake.calls)).toBe(1) // 并发的 status/log 共用同一次 rev-parse
    expect(fake.calls.length).toBe(3) // rev-parse + status + log（旧实现 5）
    fake.calls.length = 0
    await Promise.all([gitStatus(root, fake.runner), gitAction(root, 'log', undefined, undefined, fake.runner)])
    expect(revParseCount(fake.calls)).toBe(0)
    expect(fake.calls.length).toBe(2) // 热缓存：status + log
  })

  it('stage/commit reuse the cached root; action result keeps the old GitStatus shape', async () => {
    const root = await temp()
    const fake = fakeProcess(gitHandler(root))
    // 冷启动 stage：rev-parse + add + status = 3（旧实现 4）
    await gitAction(root, 'stage', 'a.txt', undefined, fake.runner)
    expect(fake.calls.map(call => call[1])).toEqual(['rev-parse', 'add', 'status'])
    expect(revParseCount(fake.calls)).toBe(1)
    fake.calls.length = 0
    // 热缓存 stage：add + status = 2
    const staged = await gitAction(root, 'stage', 'a.txt', undefined, fake.runner) as { repository: string }
    expect(staged.repository).toBe(root)
    expect(fake.calls.map(call => call[1])).toEqual(['add', 'status'])
    fake.calls.length = 0
    // 冷 commit：rev-parse + commit + status = 3（旧实现 4，客户端 refresh 另计）
    resetGitRootCache(fake.runner)
    await gitAction(root, 'commit', undefined, 'msg', fake.runner)
    expect(fake.calls.map(call => call[1])).toEqual(['rev-parse', 'commit', 'status'])
    fake.calls.length = 0
    await gitAction(root, 'commit', undefined, 'msg', fake.runner)
    expect(fake.calls.map(call => call[1])).toEqual(['commit', 'status'])
  })

  it('keeps the empty-repository log behaviour while normal repos need no HEAD probe', async () => {
    const root = await temp()
    let logCalls = 0
    const fake = fakeProcess(args => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { stdout: `${root}\n` }
      if (args[0] === 'log') { logCalls++; return { code: 128, stderr: 'fatal: your current branch does not have any commits yet' } }
      if (args[0] === 'rev-parse') return { code: 128, stderr: 'fatal: Needed a single revision' }
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    await expect(gitAction(root, 'log', undefined, undefined, fake.runner)).resolves.toEqual([])
    expect(logCalls).toBe(1)
    expect(fake.calls.map(call => call[1])).toEqual(['rev-parse', 'log', 'rev-parse'])
  })
})

function rgMatchLine(path: string, line: number, text: string): string {
  return JSON.stringify({ type: 'match', data: { path: { text: `./${path}` }, lines: { text }, line_number: line, submatches: [{ start: 0, end: 1, match: { text: text.slice(0, 1) } }] } })
}

describe('search limits', () => {
  it('stops at the global match cap and reports truncation', async () => {
    const root = await temp()
    const stdout = [rgMatchLine('a.ts', 1, 'alpha'), rgMatchLine('b.ts', 2, 'beta'), rgMatchLine('c.ts', 3, 'gamma')].join('\n')
    const fake = fakeProcess(() => ({ stdout }))
    const result = await searchWorkspace(root, { query: 'a', maxMatches: 2 }, undefined, fake.runner)
    expect(result.matches).toHaveLength(2)
    expect(result.matches.map(match => match.path)).toEqual(['a.ts', 'b.ts'])
    expect(result).toMatchObject({ limited: true, truncated: true })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toContain('--max-filesize')
    expect(fake.calls[0]).toContain('2097152') // 默认单文件 2 MiB
  })

  it('reports truncated=false for small results', async () => {
    const root = await temp()
    const fake = fakeProcess(() => ({ stdout: rgMatchLine('only.ts', 1, 'needle') }))
    const result = await searchWorkspace(root, { query: 'needle' }, undefined, fake.runner)
    expect(result.matches).toHaveLength(1)
    expect(result).toMatchObject({ limited: false, truncated: false })
  })

  it('honours the runner stdout cap and ignores a partial trailing line', async () => {
    const root = await temp()
    const partial = rgMatchLine('half.ts', 1, 'half').slice(0, 10)
    const fake = fakeProcess(() => ({ stdout: partial, truncated: true }))
    const result = await searchWorkspace(root, { query: 'h', maxOutputBytes: 64 }, undefined, fake.runner)
    expect(result).toMatchObject({ matches: [], limited: true, truncated: true })
    expect(fake.calls).toHaveLength(1)
  })

  it('does not spawn for an empty query', async () => {
    const fake = fakeProcess(() => { throw new Error('should not spawn') })
    await expect(searchWorkspace('C:/irrelevant', { query: '' }, undefined, fake.runner)).resolves.toEqual({ matches: [], limited: false, truncated: false })
    expect(fake.calls).toHaveLength(0)
  })

  it('works end-to-end against the real ripgrep binary and caps at maxMatches', async () => {
    const root = await temp()
    await mkdir(join(root, 'src'))
    for (let index = 0; index < 5; index++) await writeFile(join(root, 'src', `f${index}.ts`), 'const x = 1\nconst y = 2\n')
    const all = await searchWorkspace(root, { query: 'const' })
    expect(all.matches).toHaveLength(10)
    expect(all).toMatchObject({ limited: false, truncated: false })
    const capped = await searchWorkspace(root, { query: 'const', maxMatches: 3 })
    expect(capped.matches).toHaveLength(3)
    expect(capped).toMatchObject({ limited: true, truncated: true })
  })
})

describe('local Git',()=>{
  it('shows diffs for untracked and tracked files',async()=>{const root=await temp();const {execFile}=await import('node:child_process');const run=(args:string[])=>new Promise<void>((resolve,reject)=>execFile('git',args,{cwd:root},error=>error?reject(error):resolve()));await run(['init']);await run(['config','user.email','test@example.com']);await run(['config','user.name','Test']);await mkdir(join(root,'src'));await writeFile(join(root,'src','a.txt'),'first\n');let status=await gitStatus(root);expect(status.changes).toMatchObject([{path:'src/a.txt',untracked:true}]);const added=await gitAction(root,'diff','src/a.txt','untracked') as {diff:string};expect(added.diff).toContain('+first');await gitAction(root,'stage','src/a.txt');await gitAction(root,'commit',undefined,'initial');await writeFile(join(root,'src','a.txt'),'second\n');status=await gitStatus(root);expect(status.changes[0]?.path).toBe('src/a.txt');const changed=await gitAction(root,'diff','src/a.txt','worktree') as {diff:string};expect(changed.diff).toContain('-first');expect(changed.diff).toContain('+second')})
  it('returns graph commits and commit patches',async()=>{const root=await temp();const {execFile}=await import('node:child_process');const run=(args:string[])=>new Promise<void>((resolve,reject)=>execFile('git',args,{cwd:root},error=>error?reject(error):resolve()));await run(['init']);await run(['config','user.email','test@example.com']);await run(['config','user.name','Test']);await writeFile(join(root,'a.txt'),'first\n');await gitAction(root,'stage.all');await gitAction(root,'commit',undefined,'initial commit');const commits=await gitAction(root,'log') as Array<{hash:string;subject:string}>;expect(commits[0]?.subject).toBe('initial commit');const detail=await gitAction(root,'commit.show',undefined,commits[0]?.hash) as {diff:string};expect(detail.diff).toContain('initial commit');expect(detail.diff).toContain('+first')})
  it('lists every file in every returned commit and returns its patch',async()=>{const root=await temp();const {execFile}=await import('node:child_process');const run=(args:string[])=>new Promise<void>((resolve,reject)=>execFile('git',args,{cwd:root},error=>error?reject(error):resolve()));await run(['init']);await run(['config','user.email','test@example.com']);await run(['config','user.name','Test']);await writeFile(join(root,'a.txt'),'first\n');await gitAction(root,'stage.all');await gitAction(root,'commit',undefined,'initial');await writeFile(join(root,'a.txt'),'second\n');await writeFile(join(root,'b.txt'),'added\n');await gitAction(root,'stage.all');await gitAction(root,'commit',undefined,'second');const commits=await gitAction(root,'log') as Array<{hash:string}>;expect(commits.every(commit=>/^[0-9a-f]{40}$/i.test(commit.hash))).toBe(true);for(const commit of commits)expect((await gitAction(root,'commit.files',undefined,commit.hash) as unknown[]).length).toBeGreaterThan(0);const files=await gitAction(root,'commit.files',undefined,commits[0]?.hash) as Array<{path:string;status:string}>;expect(files).toEqual([{path:'a.txt',status:'M'},{path:'b.txt',status:'A'}]);const detail=await gitAction(root,'commit.file.diff','a.txt',commits[0]?.hash) as {diff:string};expect(detail.diff).toContain('-first');expect(detail.diff).toContain('+second')})
  it('discards tracked and untracked changes together',async()=>{const root=await temp();const {execFile}=await import('node:child_process');const run=(args:string[])=>new Promise<void>((resolve,reject)=>execFile('git',args,{cwd:root},error=>error?reject(error):resolve()));await run(['init']);await run(['config','user.email','test@example.com']);await run(['config','user.name','Test']);await run(['config','core.autocrlf','false']);await writeFile(join(root,'tracked.txt'),'original\n');await gitAction(root,'stage.all');await gitAction(root,'commit',undefined,'initial');await writeFile(join(root,'tracked.txt'),'changed\n');await writeFile(join(root,'untracked.txt'),'temporary\n');expect((await gitStatus(root)).changes).toHaveLength(2);await gitAction(root,'discard.all');expect((await gitStatus(root)).changes).toEqual([]);expect(await readFile(join(root,'tracked.txt'),'utf8')).toBe('original\n');await expect(readFile(join(root,'untracked.txt'),'utf8')).rejects.toMatchObject({code:'ENOENT'})})
})

describe('client assets',()=>{it('resolves the VS Code Codicon font',()=>{expect(codiconAsset()).toMatchObject({type:'font/ttf'});expect(codiconAsset().path).toMatch(/codicon\.ttf$/)});it('resolves the PDF.js module worker',()=>{expect(pdfWorkerAsset()).toMatchObject({type:'text/javascript; charset=utf-8'});expect(pdfWorkerAsset().path).toMatch(/pdf\.worker\.min\.mjs$/)})})

/**
 * 七个 immutable 静态资源路由的行为锁：URL、响应头、内容类型与错误码与重构前一致。
 * 只调用注册后的 handler（最小 req/res 替身），不启动真实 HTTP server。
 */
describe('immutable asset routes', () => {
  interface RegisteredRoute { kind: 'exact' | 'prefix'; path: string; handler: (req: never, res: never) => void | Promise<void> }
  const routes: RegisteredRoute[] = []
  const disposers: Array<() => void> = []

  beforeAll(async () => {
    const { registerWorkbenchRoutes } = await import('../src/routes.ts')
    const ctx = {
      connection: { requestRejection: () => undefined },
      effect: (callback: () => void | (() => void)) => { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose) },
      webServer: {
        register: (route: RegisteredRoute) => { routes.push(route); return () => {} },
        registerUpgrade: () => () => {},
      },
    }
    registerWorkbenchRoutes(ctx as never)
  })

  afterAll(() => { for (const dispose of disposers.reverse()) dispose() })

  function routeFor(path: string): RegisteredRoute {
    const route = routes.find(candidate => candidate.path === path)
    if (route === undefined) throw new Error(`route not registered: ${path}`)
    return route
  }

  async function fetchAsset(url: string, routePath: string): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
    const response = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown }
    const res = {
      writeHead(status: number, headers: Record<string, string>) { response.status = status; response.headers = headers },
      end(body?: unknown) { response.body = body },
    }
    await routeFor(routePath).handler({ url, method: 'GET', headers: {} } as never, res as never)
    return response
  }

  it('serves codicon font and PDF.js worker as exact immutable routes', async () => {
    expect(routeFor('/dsh-vscode/codicons/codicon.ttf').kind).toBe('exact')
    expect(routeFor('/dsh-vscode/pdfjs/worker.mjs').kind).toBe('exact')
    const codicon = await fetchAsset('/dsh-vscode/codicons/codicon.ttf', '/dsh-vscode/codicons/codicon.ttf')
    expect(codicon.status).toBe(200)
    expect(codicon.headers).toEqual({ 'content-type': 'font/ttf', 'cache-control': 'public, max-age=31536000, immutable' })
    expect(Buffer.isBuffer(codicon.body)).toBe(true)
    const worker = await fetchAsset('/dsh-vscode/pdfjs/worker.mjs', '/dsh-vscode/pdfjs/worker.mjs')
    expect(worker.status).toBe(200)
    expect(worker.headers).toEqual({ 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' })
  })

  it('serves grammars as JSON and keeps the historical "no decode" behaviour', async () => {
    expect(routeFor('/dsh-vscode/grammar').kind).toBe('prefix')
    const grammar = await fetchAsset('/dsh-vscode/grammar/typescript.mjs', '/dsh-vscode/grammar')
    expect(grammar.status).toBe(200)
    expect(grammar.headers).toEqual({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' })
    const parsed = JSON.parse(String(grammar.body)) as { scopeName?: unknown }
    expect(typeof parsed.scopeName).toBe('string')
    // 语法名历史上就不解码：编码后的名字不会被还原成真实文件名，因此拿不到资源。
    const encoded = await fetchAsset('/dsh-vscode/grammar/typescript%2Emjs', '/dsh-vscode/grammar')
    expect(encoded.status).not.toBe(200)
  })

  it('decodes Monaco / KaTeX / file-icon paths and keeps their content types', async () => {
    const monaco = await fetchAsset('/dsh-vscode/monaco/vs/loader.js', '/dsh-vscode/monaco')
    expect(monaco.status).toBe(200)
    expect(monaco.headers).toEqual({ 'content-type': 'text/javascript', 'cache-control': 'public, max-age=31536000, immutable' })
    const monacoEncoded = await fetchAsset('/dsh-vscode/monaco/vs%2Floader.js', '/dsh-vscode/monaco')
    expect(monacoEncoded.status).toBe(200)
    expect(String(monacoEncoded.body)).toBe(String(monaco.body))
    const katex = await fetchAsset('/dsh-vscode/katex/katex.min.css', '/dsh-vscode/katex')
    expect(katex.status).toBe(200)
    expect(katex.headers).toEqual({ 'content-type': 'text/css', 'cache-control': 'public, max-age=31536000, immutable' })
    const icon = await fetchAsset('/dsh-vscode/file-icons/typescript.svg', '/dsh-vscode/file-icons')
    expect(icon.status).toBe(200)
    expect(icon.headers).toEqual({ 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=31536000, immutable' })
  })

  it('rejects a decoded traversal outside the asset package (403, unchanged error code)', async () => {
    const escape = await fetchAsset('/dsh-vscode/file-icons/..%2F..%2Fpackage.json', '/dsh-vscode/file-icons')
    expect(escape.status).toBe(403)
    expect(JSON.parse(String(escape.body))).toMatchObject({ ok: false, error: { code: 'asset-invalid' } })
  })

  it('serves oniguruma wasm as a prefix route with application/wasm', async () => {
    expect(routeFor('/dsh-vscode/onig').kind).toBe('prefix')
    const wasm = await fetchAsset('/dsh-vscode/onig/onig.wasm', '/dsh-vscode/onig')
    expect(wasm.status).toBe(200)
    expect(wasm.headers).toEqual({ 'content-type': 'application/wasm', 'cache-control': 'public, max-age=31536000, immutable' })
    expect(Buffer.isBuffer(wasm.body)).toBe(true)
  })
})
