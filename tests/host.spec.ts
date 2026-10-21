import { mkdtemp, mkdir, realpath, rm, symlink, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { codiconAsset, compileSearchPattern, createEntry, gitAction, gitStatus, listFiles, matchCase, pdfWorkerAsset, readDocument, renameEntry, replaceInText, replaceInWorkspace, replaceSingleInText, resetGitRootCache, saveDocument, searchWorkspace, uploadFile, workspacePath, workspacePreviewFile, type ProcessRunner } from '../src/host.ts'
import type { GitBranchList, GitStash, GitStatus, GitTag } from '../src/types.ts'

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

describe('search replace', () => {
  it('replaces every match in matching files and reports the counts', async () => {
    const root = await temp()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'a.ts'), 'const foo = foo\nconst bar = 1\n')
    await writeFile(join(root, 'src', 'b.ts'), 'nothing here\n')
    const result = await replaceInWorkspace(root, { query: 'foo', replace: 'baz' })
    expect(result.replacements).toBe(2)
    expect(result.files.map(path => path.replace(/\\/g, '/'))).toEqual(['src/a.ts'])
    expect(await readFile(join(root, 'src', 'a.ts'), 'utf8')).toBe('const baz = baz\nconst bar = 1\n')
    expect(await readFile(join(root, 'src', 'b.ts'), 'utf8')).toBe('nothing here\n')
  })

  it('honours whole words, case sensitivity and regex capture groups', async () => {
    const root = await temp()
    await writeFile(join(root, 'a.ts'), 'Foo foo foobar user_id\n')
    await replaceInWorkspace(root, { query: 'foo', replace: 'x', wholeWord: true })
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('x x foobar user_id\n')
    await replaceInWorkspace(root, { query: '(\\w+)_id', replace: '$1Id', regex: true })
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('x x foobar userId\n')
    await expect(replaceInWorkspace(root, { query: 'x', replace: 'y', caseSensitive: true })).resolves.toMatchObject({ replacements: 2 })
  })

  it('preserves the matched case when asked', async () => {
    const root = await temp()
    await writeFile(join(root, 'a.ts'), 'FOO Foo foo\n')
    await replaceInWorkspace(root, { query: 'foo', replace: 'bar', preserveCase: true })
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('BAR Bar bar\n')
  })

  it('replaces a single reported position only and reports a stale one', async () => {
    const root = await temp()
    await writeFile(join(root, 'a.ts'), 'foo foo foo\nsecond foo\n')
    await expect(replaceInWorkspace(root, { query: 'foo', replace: 'bar', only: { path: 'a.ts', line: 1, column: 9 } }))
      .resolves.toEqual({ files: ['a.ts'], replacements: 1 })
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('foo foo bar\nsecond foo\n')
    // 这个位置现在已经是 bar：行列对不上就一处都不改，由客户端提示重新搜索。
    await expect(replaceInWorkspace(root, { query: 'foo', replace: 'bar', only: { path: 'a.ts', line: 1, column: 9 } }))
      .resolves.toEqual({ files: [], replacements: 0 })
  })

  it('keeps CRLF line endings and skips binary files', async () => {
    const root = await temp()
    await writeFile(join(root, 'a.ts'), 'foo\r\nbar\r\n')
    await writeFile(join(root, 'bin.dat'), Buffer.from('needle\0more'))
    await replaceInWorkspace(root, { query: 'foo', replace: 'baz' })
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('baz\r\nbar\r\n')
    const binary = await replaceInWorkspace(root, { query: 'needle', replace: 'x' })
    expect(binary.replacements).toBe(0)
    expect((await readFile(join(root, 'bin.dat'))).includes(0)).toBe(true)
  })

  it('rejects an empty query and an invalid regular expression', async () => {
    const root = await temp()
    await expect(replaceInWorkspace(root, { query: '', replace: 'x' })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(replaceInWorkspace(root, { query: '(', replace: 'x', regex: true })).rejects.toMatchObject({ code: 'invalid-regex' })
  })
})

describe('search replace text helpers', () => {
  it('applies replacements per line and keeps the original separators', () => {
    expect(replaceInText('foo\r\nfoo bar\r\n', compileSearchPattern({ query: 'foo' }), 'x')).toEqual({ text: 'x\r\nx bar\r\n', replacements: 2 })
    expect(replaceInText('', compileSearchPattern({ query: 'foo' }), 'x')).toEqual({ text: '', replacements: 0 })
  })

  it('maps the matched case shape for preserve-case', () => {
    expect(matchCase('FOO', 'bar')).toBe('BAR')
    expect(matchCase('foo', 'BAR')).toBe('bar')
    expect(matchCase('Foo', 'bar')).toBe('Bar')
    expect(matchCase('fOo', 'bar')).toBe('bar')
    expect(matchCase('', 'bar')).toBe('bar')
  })

  it('replaces only the matched column and treats a moved match as stale', () => {
    const pattern = compileSearchPattern({ query: 'foo' })
    expect(replaceSingleInText('foo foo', pattern, 'x', false, 1, 5)).toEqual({ text: 'foo x', replacements: 1 })
    expect(replaceSingleInText('foo foo', pattern, 'x', false, 1, 2)).toEqual({ text: 'foo foo', replacements: 0 })
    expect(replaceSingleInText('foo', pattern, 'x', false, 3, 1)).toEqual({ text: 'foo', replacements: 0 })
  })
})

describe('local Git',()=>{
  it('shows diffs for untracked and tracked files',async()=>{const root=await temp();const {execFile}=await import('node:child_process');const run=(args:string[])=>new Promise<void>((resolve,reject)=>execFile('git',args,{cwd:root},error=>error?reject(error):resolve()));await run(['init']);await run(['config','user.email','test@example.com']);await run(['config','user.name','Test']);await mkdir(join(root,'src'));await writeFile(join(root,'src','a.txt'),'first\n');let status=await gitStatus(root);expect(status.changes).toMatchObject([{path:'src/a.txt',untracked:true}]);const added=await gitAction(root,'diff','src/a.txt','untracked') as {diff:string};expect(added.diff).toContain('+first');await gitAction(root,'stage','src/a.txt');await gitAction(root,'commit',undefined,'initial');await writeFile(join(root,'src','a.txt'),'second\n');status=await gitStatus(root);expect(status.changes[0]?.path).toBe('src/a.txt');const changed=await gitAction(root,'diff','src/a.txt','worktree') as {diff:string};expect(changed.diff).toContain('-first');expect(changed.diff).toContain('+second')})
  it('returns graph commits and commit patches',async()=>{const root=await temp();const {execFile}=await import('node:child_process');const run=(args:string[])=>new Promise<void>((resolve,reject)=>execFile('git',args,{cwd:root},error=>error?reject(error):resolve()));await run(['init']);await run(['config','user.email','test@example.com']);await run(['config','user.name','Test']);await writeFile(join(root,'a.txt'),'first\n');await gitAction(root,'stage.all');await gitAction(root,'commit',undefined,'initial commit');const commits=await gitAction(root,'log') as Array<{hash:string;subject:string}>;expect(commits[0]?.subject).toBe('initial commit');const detail=await gitAction(root,'commit.show',undefined,commits[0]?.hash) as {diff:string};expect(detail.diff).toContain('initial commit');expect(detail.diff).toContain('+first')})
  it('lists every file in every returned commit and returns its patch',async()=>{const root=await temp();const {execFile}=await import('node:child_process');const run=(args:string[])=>new Promise<void>((resolve,reject)=>execFile('git',args,{cwd:root},error=>error?reject(error):resolve()));await run(['init']);await run(['config','user.email','test@example.com']);await run(['config','user.name','Test']);await writeFile(join(root,'a.txt'),'first\n');await gitAction(root,'stage.all');await gitAction(root,'commit',undefined,'initial');await writeFile(join(root,'a.txt'),'second\n');await writeFile(join(root,'b.txt'),'added\n');await gitAction(root,'stage.all');await gitAction(root,'commit',undefined,'second');const commits=await gitAction(root,'log') as Array<{hash:string}>;expect(commits.every(commit=>/^[0-9a-f]{40}$/i.test(commit.hash))).toBe(true);for(const commit of commits)expect((await gitAction(root,'commit.files',undefined,commit.hash) as unknown[]).length).toBeGreaterThan(0);const files=await gitAction(root,'commit.files',undefined,commits[0]?.hash) as Array<{path:string;status:string}>;expect(files).toEqual([{path:'a.txt',status:'M'},{path:'b.txt',status:'A'}]);const detail=await gitAction(root,'commit.file.diff','a.txt',commits[0]?.hash) as {diff:string};expect(detail.diff).toContain('-first');expect(detail.diff).toContain('+second')})
  it('discards tracked and untracked changes together',async()=>{const root=await temp();const {execFile}=await import('node:child_process');const run=(args:string[])=>new Promise<void>((resolve,reject)=>execFile('git',args,{cwd:root},error=>error?reject(error):resolve()));await run(['init']);await run(['config','user.email','test@example.com']);await run(['config','user.name','Test']);await run(['config','core.autocrlf','false']);await writeFile(join(root,'tracked.txt'),'original\n');await gitAction(root,'stage.all');await gitAction(root,'commit',undefined,'initial');await writeFile(join(root,'tracked.txt'),'changed\n');await writeFile(join(root,'untracked.txt'),'temporary\n');expect((await gitStatus(root)).changes).toHaveLength(2);await gitAction(root,'discard.all');expect((await gitStatus(root)).changes).toEqual([]);expect(await readFile(join(root,'tracked.txt'),'utf8')).toBe('original\n');await expect(readFile(join(root,'untracked.txt'),'utf8')).rejects.toMatchObject({code:'ENOENT'})})
})

/** 建一个有一个提交的真仓库；默认分支名不写死（受 init.defaultBranch 影响）。 */
async function gitFixture(): Promise<{ root: string; original: string; first: string }> {
  const root = await temp()
  const { execFile } = await import('node:child_process')
  const shell = (args: string[]) => new Promise<void>((resolve, reject) => execFile('git', args, { cwd: root }, error => error ? reject(error) : resolve()))
  await shell(['init'])
  await shell(['config', 'user.email', 'test@example.com'])
  await shell(['config', 'user.name', 'Test'])
  await shell(['config', 'core.autocrlf', 'false'])
  await writeFile(join(root, 'a.txt'), 'one\n')
  await gitAction(root, 'stage.all')
  await gitAction(root, 'commit', undefined, 'first')
  const first = ((await gitAction(root, 'log')) as Array<{ hash: string }>)[0]!.hash
  const original = ((await gitAction(root, 'branch.list')) as { current: string }).current
  return { root, original, first }
}

describe('git panel actions', () => {
  it('lists branches, switches, creates and deletes them', async () => {
    const { root, original } = await gitFixture()
    expect((await gitAction(root, 'remotes'))).toEqual([])
    await gitAction(root, 'branch.create', undefined, 'temp')
    expect(((await gitAction(root, 'branch.list')) as { current: string }).current).toBe('temp')
    await gitAction(root, 'branch.switch', undefined, original)
    await gitAction(root, 'branch.delete', undefined, 'temp')
    const list = (await gitAction(root, 'branch.list')) as { current: string; local: string[]; remote: string[] }
    expect(list.current).toBe(original)
    expect(list.local).not.toContain('temp')
    expect(list.remote).toEqual([])
    // 分支名会拼进 git 参数：空白与以 - 开头的写法必须在宿主侧就挡掉。
    await expect(gitAction(root, 'branch.create', undefined, 'bad name')).rejects.toMatchObject({ code: 'bad-request' })
    await expect(gitAction(root, 'branch.create', undefined, '-x')).rejects.toMatchObject({ code: 'bad-request' })
    await expect(gitAction(root, 'branch.create', undefined, 'a..b')).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('checks out a commit in detached HEAD and creates a branch from it', async () => {
    const { root, original, first } = await gitFixture()
    await writeFile(join(root, 'a.txt'), 'two\n')
    await gitAction(root, 'stage.all')
    await gitAction(root, 'commit', undefined, 'second')
    await gitAction(root, 'commit.checkout', undefined, first)
    // 分离头指针的写法随 git 版本变化：porcelain v2 有的是 (detached)，老版本是 HEAD。
    expect(['HEAD', '(detached)']).toContain((await gitStatus(root)).branch)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\n')
    const status = (await gitAction(root, 'commit.branch', 'from-first', first)) as { branch: string }
    expect(status.branch).toBe('from-first')
    await gitAction(root, 'branch.switch', undefined, original)
    const list = (await gitAction(root, 'branch.list')) as { local: string[] }
    expect(list.local).toContain('from-first')
  })

  it('cherry-picks and reverts commits', async () => {
    const { root, original } = await gitFixture()
    await gitAction(root, 'branch.create', undefined, 'side')
    await writeFile(join(root, 'a.txt'), 'side\n')
    await gitAction(root, 'stage.all')
    await gitAction(root, 'commit', undefined, 'side commit')
    const side = ((await gitAction(root, 'log')) as Array<{ hash: string }>)[0]!.hash
    await gitAction(root, 'branch.switch', undefined, original)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\n')
    await gitAction(root, 'commit.cherrypick', undefined, side)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('side\n')
    expect(((await gitAction(root, 'log')) as Array<{ subject: string }>).map(commit => commit.subject)).toContain('side commit')
    await gitAction(root, 'commit.revert', undefined, side)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\n')
    // first + 拣选出来的提交 + 还原提交
    expect(((await gitAction(root, 'log')) as Array<{ subject: string }>).length).toBe(3)
  })

  it('pages the commit graph and can include every branch', async () => {
    const { root, original } = await gitFixture()
    await gitAction(root, 'branch.create', undefined, 'side')
    await writeFile(join(root, 'side.txt'), 'side\n')
    await gitAction(root, 'stage.all')
    await gitAction(root, 'commit', undefined, 'side only')
    await gitAction(root, 'branch.switch', undefined, original)
    await writeFile(join(root, 'a.txt'), 'two\n')
    await gitAction(root, 'stage.all')
    await gitAction(root, 'commit', undefined, 'second')
    expect(((await gitAction(root, 'log')) as unknown[]).length).toBe(2)
    expect(((await gitAction(root, 'log', undefined, '1')) as unknown[]).length).toBe(1)
    expect(((await gitAction(root, 'log.all')) as unknown[]).length).toBe(3)
    await expect(gitAction(root, 'push')).rejects.toMatchObject({ code: 'git-failed' })
  })
})

describe('git stash', () => {
  it('stashes the working tree with a message, lists it and pops it back', async () => {
    const { root } = await gitFixture()
    await writeFile(join(root, 'a.txt'), 'two\n')
    await writeFile(join(root, 'untracked.txt'), 'temporary\n')
    await gitAction(root, 'stash.push', undefined, 'work in progress')
    expect((await gitStatus(root)).changes).toEqual([])
    const listed = (await gitAction(root, 'stash.list')) as GitStash[]
    expect(listed).toHaveLength(1)
    expect(listed[0]?.index).toBe(0)
    // message 是 `%gs` 原文（`On <branch>: <说明>`），宿主不改写。
    expect(listed[0]?.message).toContain('work in progress')
    expect(listed[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    await gitAction(root, 'stash.pop', undefined, '0')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('two\n')
    expect(await readFile(join(root, 'untracked.txt'), 'utf8')).toBe('temporary\n')
    expect((await gitAction(root, 'stash.list')) as GitStash[]).toEqual([])
    await expect(gitAction(root, 'stash.apply', undefined, 'x')).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('stashes only staged changes with the staged path and leaves the worktree dirty', async () => {
    const { root } = await gitFixture()
    await writeFile(join(root, 'a.txt'), 'staged\n')
    await gitAction(root, 'stage', 'a.txt')
    await writeFile(join(root, 'b.txt'), 'unstaged\n')
    await gitAction(root, 'stash.push', 'staged', 'only staged')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\n') // 暂存区被清空
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('unstaged\n') // 工作区仍有改动
    const status = await gitStatus(root)
    expect(status.changes).toMatchObject([{ path: 'b.txt', untracked: true }])
    expect(status.changes.some(change => change.staged)).toBe(false)
    expect(((await gitAction(root, 'stash.list')) as GitStash[])[0]?.message).toContain('only staged')
  })
})

describe('git tags', () => {
  it('creates, lists and deletes tags and rejects invalid names', async () => {
    const { root, first } = await gitFixture()
    await gitAction(root, 'tag.create', undefined, 'v1')
    const tags = (await gitAction(root, 'tag.list')) as GitTag[]
    expect(tags.map(tag => tag.name)).toEqual(['v1'])
    expect(tags[0]?.subject).toBe('first')
    // 轻量标签指向提交：短哈希就是第一个提交的前缀。
    expect(first.startsWith(tags[0]!.hash)).toBe(true)
    await gitAction(root, 'tag.create', first, 'pinned')
    expect(((await gitAction(root, 'tag.list')) as GitTag[]).map(tag => tag.name).sort()).toEqual(['pinned', 'v1'])
    await gitAction(root, 'tag.delete', undefined, 'v1')
    await gitAction(root, 'tag.delete', undefined, 'pinned')
    expect((await gitAction(root, 'tag.list')) as GitTag[]).toEqual([])
    await expect(gitAction(root, 'tag.create', undefined, 'bad tag')).rejects.toMatchObject({ code: 'bad-request' })
    await expect(gitAction(root, 'tag.delete', undefined, '-x')).rejects.toMatchObject({ code: 'bad-request' })
    await expect(gitAction(root, 'tag.create', undefined, 'a..b')).rejects.toMatchObject({ code: 'bad-request' })
    // 没有配置远程：推送单个标签或全部标签都必须报 git-failed，而不是假装成功。
    await expect(gitAction(root, 'tag.push', undefined, 'v1')).rejects.toMatchObject({ code: 'git-failed' })
    await expect(gitAction(root, 'tag.push', undefined, '')).rejects.toMatchObject({ code: 'git-failed' })
  })
})

describe('git branch rename, merge and rebase', () => {
  it('renames a branch and rejects invalid names', async () => {
    const { root, original } = await gitFixture()
    await gitAction(root, 'branch.create', undefined, 'temp')
    await gitAction(root, 'branch.switch', undefined, original)
    const status = (await gitAction(root, 'branch.rename', 'temp', 'renamed')) as GitStatus
    expect(status.branch).toBe(original)
    const list = (await gitAction(root, 'branch.list')) as GitBranchList
    expect(list.local).toContain('renamed')
    expect(list.local).not.toContain('temp')
    await expect(gitAction(root, 'branch.rename', 'renamed', 'bad name')).rejects.toMatchObject({ code: 'bad-request' })
    await expect(gitAction(root, 'branch.rename', '-x', 'fine')).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('merges a branch into the current one and aborts a conflicted merge', async () => {
    const { root, original } = await gitFixture()
    await gitAction(root, 'branch.create', undefined, 'side')
    await writeFile(join(root, 'side.txt'), 'side\n')
    await gitAction(root, 'stage.all')
    await gitAction(root, 'commit', undefined, 'side commit')
    await gitAction(root, 'branch.switch', undefined, original)
    const status = (await gitAction(root, 'merge', undefined, 'side')) as GitStatus
    expect(status.changes).toEqual([])
    expect(await readFile(join(root, 'side.txt'), 'utf8')).toBe('side\n')
    expect(((await gitAction(root, 'log')) as Array<{ subject: string }>).map(commit => commit.subject)).toContain('side commit')
    await expect(gitAction(root, 'merge', undefined, 'missing-branch')).rejects.toMatchObject({ code: 'git-failed' })
    // 双方各改同一个文件 → 冲突：merge 报 git-failed，merge.abort 把工作区恢复干净。
    await gitAction(root, 'branch.create', undefined, 'conflict')
    await writeFile(join(root, 'side.txt'), 'branch side\n')
    await gitAction(root, 'stage.all')
    await gitAction(root, 'commit', undefined, 'conflict commit')
    await gitAction(root, 'branch.switch', undefined, original)
    await writeFile(join(root, 'side.txt'), 'main side\n')
    await gitAction(root, 'stage.all')
    await gitAction(root, 'commit', undefined, 'main side commit')
    await expect(gitAction(root, 'merge', undefined, 'conflict')).rejects.toMatchObject({ code: 'git-failed' })
    expect(((await gitAction(root, 'merge.abort')) as GitStatus).changes).toEqual([])
    expect(await readFile(join(root, 'side.txt'), 'utf8')).toBe('main side\n')
  })

  it('rebases a branch onto another one', async () => {
    const { root, original } = await gitFixture()
    await gitAction(root, 'branch.create', undefined, 'side')
    await writeFile(join(root, 'side.txt'), 'side\n')
    await gitAction(root, 'stage.all')
    await gitAction(root, 'commit', undefined, 'side commit')
    await gitAction(root, 'branch.switch', undefined, original)
    await writeFile(join(root, 'a.txt'), 'main change\n')
    await gitAction(root, 'stage.all')
    await gitAction(root, 'commit', undefined, 'main only')
    await gitAction(root, 'branch.switch', undefined, 'side')
    const status = (await gitAction(root, 'rebase', undefined, original)) as GitStatus
    expect(status.branch).toBe('side')
    expect(((await gitAction(root, 'log')) as Array<{ subject: string }>).map(commit => commit.subject)).toEqual(['side commit', 'main only', 'first'])
  })
})

describe('git commit, remote and clone actions', () => {
  it('commits every change in one action', async () => {
    const { root } = await gitFixture()
    await writeFile(join(root, 'a.txt'), 'two\n')
    await writeFile(join(root, 'untracked.txt'), 'new\n')
    const status = (await gitAction(root, 'commit.all', undefined, 'commit all')) as GitStatus
    expect(status.changes).toEqual([])
    expect(((await gitAction(root, 'log')) as Array<{ subject: string }>)[0]?.subject).toBe('commit all')
  })

  it('undoes the last commit into the staging area', async () => {
    const { root } = await gitFixture()
    await writeFile(join(root, 'a.txt'), 'two\n')
    await gitAction(root, 'stage.all')
    await gitAction(root, 'commit', undefined, 'second')
    expect(((await gitAction(root, 'log')) as unknown[]).length).toBe(2)
    const status = (await gitAction(root, 'commit.undo')) as GitStatus
    expect(status.changes).toMatchObject([{ path: 'a.txt', staged: true }])
    expect(((await gitAction(root, 'log')) as unknown[]).length).toBe(1)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('two\n')
  })

  it('adds and removes remotes', async () => {
    const { root } = await gitFixture()
    expect(await gitAction(root, 'remotes')).toEqual([])
    const added = (await gitAction(root, 'remote.add', 'origin', 'https://example.com/repo.git')) as string[]
    expect(added).toEqual(['origin'])
    expect(await gitAction(root, 'remotes')).toEqual(['origin'])
    const removed = (await gitAction(root, 'remote.remove', undefined, 'origin')) as string[]
    expect(removed).toEqual([])
    expect(await gitAction(root, 'remotes')).toEqual([])
    await expect(gitAction(root, 'remote.remove', undefined, 'origin')).rejects.toMatchObject({ code: 'git-failed' })
    await expect(gitAction(root, 'remote.add', '', 'https://example.com/x.git')).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('clones a repository into an empty workspace directory', async () => {
    const source = await gitFixture()
    const workspace = await temp()
    await expect(gitAction(workspace, 'clone', 'cloned', source.root)).resolves.toEqual({ cloned: true })
    // 克隆出的仓库按它自己的 core.autocrlf 检出，Windows 上可能是 CRLF。
    expect((await readFile(join(workspace, 'cloned', 'a.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('one\n')
    expect((await gitStatus(join(workspace, 'cloned'))).changes).toEqual([])
    // 目标已存在时 git 自己报错，原样变成 git-failed；绝对路径与 `..` 在宿主侧就挡掉。
    await expect(gitAction(workspace, 'clone', 'cloned', source.root)).rejects.toMatchObject({ code: 'git-failed' })
    await expect(gitAction(workspace, 'clone', '../escape', source.root)).rejects.toMatchObject({ code: 'bad-request' })
    await expect(gitAction(workspace, 'clone', join(workspace, 'absolute'), source.root)).rejects.toMatchObject({ code: 'bad-request' })
  })
})

describe('commit detail and comparison', () => {
  it('reports author, body and per-file additions/deletions, including the root commit', async () => {
    const { root, first } = await gitFixture()
    await writeFile(join(root, 'a.txt'), 'one\ntwo\n')
    await writeFile(join(root, 'b.txt'), 'new\n')
    await gitAction(root, 'stage.all')
    await gitAction(root, 'commit', undefined, 'second\n\nbody line')
    const head = ((await gitAction(root, 'log')) as Array<{ hash: string }>)[0]!.hash
    const detail = (await gitAction(root, 'commit.detail', undefined, head)) as { hash: string; author: string; email: string; subject: string; body: string; files: Array<{ path: string; status: string; additions: number; deletions: number }> }
    expect(detail.hash).toBe(head)
    expect(detail.author).toBe('Test')
    expect(detail.email).toBe('test@example.com')
    expect(detail.subject).toBe('second')
    expect(detail.body).toContain('body line')
    expect(detail.files.map(file => file.path).sort()).toEqual(['a.txt', 'b.txt'])
    expect(detail.files.find(file => file.path === 'a.txt')).toMatchObject({ status: 'M', additions: 1, deletions: 0 })
    expect(detail.files.find(file => file.path === 'b.txt')).toMatchObject({ status: 'A', additions: 1, deletions: 0 })
    // 根提交没有父：diff-tree --root 也必须列出首次提交的文件。
    const rootDetail = (await gitAction(root, 'commit.detail', undefined, first)) as { files: Array<{ path: string; additions: number }> }
    expect(rootDetail.files).toMatchObject([{ path: 'a.txt', additions: 1 }])
  })

  it('lists and diffs the files changed between two commits', async () => {
    const { root, first } = await gitFixture()
    await writeFile(join(root, 'a.txt'), 'one\ntwo\n')
    await gitAction(root, 'stage.all')
    await gitAction(root, 'commit', undefined, 'second')
    const second = ((await gitAction(root, 'log')) as Array<{ hash: string }>)[0]!.hash
    const files = (await gitAction(root, 'compare.files', first, second)) as Array<{ path: string; status: string; additions: number; deletions: number }>
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'a.txt', status: 'M', additions: 1, deletions: 0 })
    const diff = (await gitAction(root, 'range.file.diff', 'a.txt', first + '..' + second)) as { diff: string; original: string; modified: string }
    expect(diff.original).toBe('one\n')
    expect(diff.modified).toBe('one\ntwo\n')
    expect(diff.diff).toContain('+two')
    await expect(gitAction(root, 'range.file.diff', 'a.txt', 'bad..hash')).rejects.toMatchObject({ code: 'bad-request' })
  })
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
