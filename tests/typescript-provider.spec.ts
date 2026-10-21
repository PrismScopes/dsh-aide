/**
 * 内置 TypeScript 语言服务的集成测试。
 *
 * 测试用临时工作区 + 真实 typescript 编译器 API（不做 mock）：这一层要证明的正是「TypeScript 的返回
 * 形状被正确映射成协议类型」，mock 掉 TS 就什么也没证明。为了不把 lib 的加载成本乘上用例数，读能力
 * 相关的用例共用一个只读工作区与一个 provider；会改文档/改磁盘的用例各自建独立工作区。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createTypeScriptProvider, TypeScriptLanguageProvider } from '../src/language/typescript.ts'
import type { LanguageDiagnostic, LanguageDocument, LanguageRenameResult, LanguagePosition } from '../src/language/protocol.ts'

const require_ = createRequire(import.meta.url)

/* 只读共享工作区的内容。行号（0 基）在断言里被直接使用，改内容时必须一起改断言。 */
const A_TS = [
  '/** 把两个数字相加。 */',
  'export function add(a: number, b: number): number { return a + b }',
  'export const shared = 1',
  'export class Widget {',
  '  render(): void {}',
  '}',
  'export interface Shape { area(): number }',
  '',
].join('\n')

const B_TS = [
  "import { add, shared } from './a'",
  'export const total = add(1, 2) + shared',
  'export function read(): number { return shared }',
  '',
].join('\n')

const ERRORS_TS = [
  'const value: number = "text"',
  'function passthrough(value) { return value }',
  'const alpha = 1',
  'alpa',
  '',
].join('\n')

const SHARED_FILES: Record<string, string> = {
  'a.ts': A_TS,
  'b.ts': B_TS,
  'errors.ts': ERRORS_TS,
  'syntax.ts': 'function broken( {\n',
  'completion.ts': 'const alpha = 1\nconst beta = 2\nalp\n',
  'signature.ts': 'function combine(a: number, b: string): void {}\ncombine(1, ',
  // 2420（类没有实现接口成员）会带 relatedInformation，指向接口成员的声明处。
  'implements.ts': 'interface HasArea { area(): number }\nclass Square implements HasArea { }\n',
}

const roots: string[] = []
const providers: TypeScriptLanguageProvider[] = []
let sharedRoot = ''
let shared: TypeScriptLanguageProvider

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value))
  return normalize(left) === normalize(right)
}

/** 在临时目录写入一棵文件树。 */
async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const target = join(root, name)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
}

async function makeWorkspace(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dvw-ts-'))
  roots.push(root)
  await writeTree(root, files)
  return root
}

/**
 * 建 provider。磁盘版本缓存设为 0，测试里直接改盘后立刻可见（生产默认 2 秒）。
 */
function makeProvider(root: string, hooks: { onLog?: (level: 'info' | 'warn' | 'error', message: string) => void; onDiagnostics?: (path: string, diagnostics: readonly LanguageDiagnostic[]) => void } = {}): TypeScriptLanguageProvider {
  const provider = new TypeScriptLanguageProvider({
    workspace: root,
    onDiagnostics: hooks.onDiagnostics ?? (() => undefined),
    ...(hooks.onLog === undefined ? {} : { onLog: hooks.onLog }),
  }, { diskVersionCacheMs: 0 })
  providers.push(provider)
  return provider
}

/** 文本里第 occurrence 次出现的 needle 的起始 0 基行列。 */
function positionOf(content: string, needle: string, occurrence = 0): LanguagePosition {
  let index = -1
  for (let count = 0; count <= occurrence; count++) index = content.indexOf(needle, index + 1)
  if (index < 0) throw new Error(`找不到 ${needle}`)
  const lines = content.slice(0, index).split('\n')
  return { line: lines.length - 1, character: (lines.at(-1) ?? '').length }
}

function document(path: string, content: string, version: number): LanguageDocument {
  return { path, content, version, languageId: path.endsWith('.js') ? 'javascript' : 'typescript' }
}

beforeAll(async () => {
  sharedRoot = await mkdtemp(join(tmpdir(), 'dvw-ts-shared-'))
  await writeTree(sharedRoot, SHARED_FILES)
  shared = new TypeScriptLanguageProvider({ workspace: sharedRoot, onDiagnostics: () => undefined }, { diskVersionCacheMs: 0 })
})

afterAll(async () => {
  await shared.dispose()
  await rm(sharedRoot, { recursive: true, force: true })
})

afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('diagnostics', () => {
  it('maps syntactic and semantic errors to severity, TS code and a 0-based range', async () => {
    const semantic = await shared.diagnostics(join(sharedRoot, 'errors.ts'))
    // `const value: number = "text"` 的 2322 落在变量名 `value`（0 基第 6 列，长度 5）。
    const mismatch = semantic.find(diagnostic => diagnostic.code === 'TS2322')
    expect(mismatch).toMatchObject({
      severity: 'error',
      source: 'ts',
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
    })
    expect(mismatch?.message).toContain('not assignable')

    const syntactic = await shared.diagnostics(join(sharedRoot, 'syntax.ts'))
    const missingBrace = syntactic.find(diagnostic => diagnostic.code === 'TS1005')
    expect(missingBrace).toMatchObject({ severity: 'error', source: 'ts' })
    // 语法错误的范围也必须是 0 基、且 end 不早于 start。
    expect(missingBrace?.range.start.line).toBeGreaterThanOrEqual(0)
    expect(missingBrace?.range.end.line).toBeGreaterThanOrEqual(missingBrace?.range.start.line ?? 0)

    // 建议（suggestion）映射成 info：隐式 any 参数是 TS 给出的 suggestion 诊断。
    const suggestion = semantic.find(diagnostic => diagnostic.code === 'TS7044')
    expect(suggestion?.severity).toBe('info')
  })

  it('keeps related information with an absolute path and a 0-based range', async () => {
    const diagnostics = await shared.diagnostics(join(sharedRoot, 'implements.ts'))
    const missing = diagnostics.find(diagnostic => diagnostic.code === 'TS2420')
    expect(missing).toBeDefined()
    const related = missing?.related ?? []
    expect(related.length).toBeGreaterThanOrEqual(1)
    expect(samePath(related[0]?.path ?? '', join(sharedRoot, 'implements.ts'))).toBe(true)
    expect(isAbsolute(related[0]?.path ?? '')).toBe(true)
    expect(related[0]?.message).toContain('declared here')
    expect(related[0]?.range.start).toEqual({ line: 0, character: 20 })
  })

  it('pushes the computed diagnostics through onDiagnostics and caches by file version', async () => {
    const root = await makeWorkspace({ 'a.ts': 'const value: number = 1\n' })
    const pushed: Array<{ path: string; diagnostics: readonly LanguageDiagnostic[] }> = []
    const provider = makeProvider(root, { onDiagnostics: (path, diagnostics) => { pushed.push({ path, diagnostics }) } })
    const first = await provider.diagnostics(join(root, 'a.ts'))
    expect(first).toEqual([])
    expect(pushed).toHaveLength(1)
    // 命中缓存时不再重复推送。
    await provider.diagnostics(join(root, 'a.ts'))
    expect(pushed).toHaveLength(1)
  })
})

describe('navigation', () => {
  it('jumps across files to the exact declaration', async () => {
    const from = positionOf(B_TS, 'add(')
    const definitions = await shared.definition(join(sharedRoot, 'b.ts'), from)
    expect(definitions).toHaveLength(1)
    expect(samePath(definitions[0]?.path ?? '', join(sharedRoot, 'a.ts'))).toBe(true)
    // `export function add`：add 从第 1 行（0 基）第 16 列开始。
    expect(definitions[0]?.range).toEqual({ start: { line: 1, character: 16 }, end: { line: 1, character: 19 } })
  })

  it('returns markdown hover with the type signature and the doc comment', async () => {
    const hover = await shared.hover(join(sharedRoot, 'b.ts'), positionOf(B_TS, 'add('))
    expect(hover).not.toBeNull()
    expect(hover?.contents.startsWith('```typescript')).toBe(true)
    // 跨文件导入的符号 quick info 是 `(alias) add(...)` 形式，关键是签名里的完整类型。
    expect(hover?.contents).toContain('add(a: number, b: number): number')
    expect(hover?.contents).toContain('number')
    // JSDoc 文档注释也要出现在 markdown 里。
    expect(hover?.contents).toContain('把两个数字相加')
    expect(hover?.range?.start.line).toBe(1)
  })

  it('lists references including the declaration, sorted by file and de-duplicated', async () => {
    const references = await shared.references(join(sharedRoot, 'a.ts'), positionOf(A_TS, 'shared = 1'))
    const files = references.map(reference => reference.path)
    expect(files.some(path => samePath(path, join(sharedRoot, 'a.ts')))).toBe(true)
    expect(files.some(path => samePath(path, join(sharedRoot, 'b.ts')))).toBe(true)
    expect(references.length).toBeGreaterThanOrEqual(3)
    // 每个位置都必须是 0 基且位于有效行列上。
    expect(references.every(reference => reference.range.start.line >= 0 && reference.range.start.character >= 0)).toBe(true)
    const keys = references.map(reference => `${reference.path}:${reference.range.start.line}:${reference.range.start.character}`)
    expect(new Set(keys).size).toBe(keys.length)
    // 跨文件结果按路径排序，客户端展示顺序稳定。
    expect(files).toEqual([...files].sort((left, right) => left.localeCompare(right)))
  })

  it('renames across files and refuses non-renamable positions with a Chinese reason', async () => {
    const result = await shared.rename(join(sharedRoot, 'a.ts'), positionOf(A_TS, 'shared = 1'), 'renamed')
    expect(result.canRename).toBe(true)
    const files = result.edit?.changes ?? []
    expect(files.some(change => samePath(change.path, join(sharedRoot, 'a.ts')))).toBe(true)
    expect(files.some(change => samePath(change.path, join(sharedRoot, 'b.ts')))).toBe(true)
    expect(files.flatMap(change => change.edits).every(edit => edit.newText === 'renamed')).toBe(true)
    expect(files.flatMap(change => change.edits).every(edit => edit.range.start.line >= 0)).toBe(true)

    // 数字字面量不可重命名：`export const shared = 1` 里的 `1` 在第 2 行第 22 列（0 基）。
    const numeric: LanguageRenameResult = await shared.rename(join(sharedRoot, 'a.ts'), { line: 2, character: 22 }, 'two')
    expect(numeric.canRename).toBe(false)
    expect(numeric.message).toMatch(/无法重命名/)
    expect(numeric.message).toMatch(/[\u4e00-\u9fa5]/)
  })

  it('builds hierarchical document symbols and flat workspace symbols', async () => {
    const symbols = await shared.documentSymbols(join(sharedRoot, 'a.ts'))
    const names = symbols.map(symbol => symbol.name)
    // 根节点（文件本身）不应出现在大纲里。
    expect(names).not.toContain('"a"')
    const widget = symbols.find(symbol => symbol.name === 'Widget')
    expect(widget?.kind).toBe('class')
    expect(widget?.children?.some(child => child.name === 'render' && child.kind === 'method')).toBe(true)
    expect(widget?.selectionRange.start).toEqual({ line: 3, character: 13 })
    expect(symbols.find(symbol => symbol.name === 'Shape')?.kind).toBe('interface')
    expect(symbols.find(symbol => symbol.name === 'add')?.kind).toBe('function')

    const found = await shared.workspaceSymbols('Widget', 10)
    expect(found.some(item => item.name === 'Widget' && item.kind === 'class' && samePath(item.path, join(sharedRoot, 'a.ts')))).toBe(true)
    expect((await shared.workspaceSymbols('   ', 10))).toEqual([])
  })

  it('offers completions with kinds and sort text', async () => {
    // 光标在第三行 `alp` 之后（0 基第 2 行、第 3 列）。
    const completions = await shared.completion(join(sharedRoot, 'completion.ts'), { line: 2, character: 3 })
    expect(completions).not.toBeNull()
    const alpha = completions?.items.find(item => item.label === 'alpha')
    expect(alpha).toMatchObject({ kind: 'constant' })
    expect(typeof alpha?.sortText).toBe('string')
  })

  it('maps signature help for a partially typed call', async () => {
    const signature = await shared.signatureHelp(join(sharedRoot, 'signature.ts'), { line: 1, character: 'combine(1, '.length })
    expect(signature?.signatures).toHaveLength(1)
    expect(signature?.signatures[0]?.label).toContain('combine(')
    expect(signature?.signatures[0]?.parameters.map(parameter => parameter.label)).toEqual(['a: number', 'b: string'])
    expect(signature?.activeParameter).toBe(1)
  })

  it('turns a diagnostic error code into a quick fix with a workspace edit', async () => {
    const diagnostics = await shared.diagnostics(join(sharedRoot, 'errors.ts'))
    const misspelled = diagnostics.find(diagnostic => diagnostic.code === 'TS2552')
    expect(misspelled).toBeDefined()
    const actions = await shared.codeActions(join(sharedRoot, 'errors.ts'), misspelled?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, diagnostics)
    const fix = actions.find(action => action.kind === 'quickfix' && action.edit !== undefined)
    expect(fix).toBeDefined()
    expect(fix?.title).toContain('alpha')
    const edits = fix?.edit?.changes.flatMap(change => change.edits) ?? []
    expect(edits.some(edit => edit.newText === 'alpha')).toBe(true)
    expect(fix?.edit?.changes.every(change => samePath(change.path, join(sharedRoot, 'errors.ts')))).toBe(true)
  })
})

describe('workspace scan and readFile', () => {
  it('scans every non-declaration program file, reports counts and honours cancellation', async () => {
    const root = await makeWorkspace({
      'a.ts': 'export const ok = 1\n',
      'b.ts': 'const bad: number = "x"\n',
    })
    const provider = makeProvider(root)
    const seen: string[] = []
    const result = await provider.workspaceDiagnostics((path, diagnostics) => { seen.push(path) })
    expect(result.checked).toBe(2)
    expect(result.errors).toBeGreaterThanOrEqual(1)
    expect(result.warnings).toBe(0)
    expect(seen).toHaveLength(2)
    expect(new Set(seen.map(path => path.toLowerCase())).size).toBe(2)

    // 预先取消：一个文件都不检查。
    const controller = new AbortController()
    controller.abort()
    expect(await provider.workspaceDiagnostics(() => undefined, controller.signal)).toEqual({ checked: 0, errors: 0, warnings: 0 })
  })

  it('uses tsconfig include/exclude instead of scanning when one exists', async () => {
    const root = await makeWorkspace({
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', noEmit: true, skipLibCheck: true }, include: ['src'] }),
      'src/main.ts': 'export const value: number = 1\n',
      'ignored/bad.ts': 'const broken: number = "x"\n',
    })
    const provider = makeProvider(root)
    const seen: string[] = []
    const result = await provider.workspaceDiagnostics(path => { seen.push(path) })
    expect(result.checked).toBe(1)
    expect(seen).toHaveLength(1)
    expect(samePath(seen[0] ?? '', join(root, 'src', 'main.ts'))).toBe(true)
    expect(result.errors).toBe(0)
  })

  it('skips dependency and build directories when there is no tsconfig', async () => {
    const root = await makeWorkspace({
      'main.ts': 'export const ok = 1\n',
      'node_modules/broken.ts': 'const x: number = "y"\n',
      'build/ignored.ts': 'const z: number = "w"\n',
    })
    const provider = makeProvider(root)
    const seen: string[] = []
    const result = await provider.workspaceDiagnostics(path => { seen.push(path) })
    expect(result.checked).toBe(1)
    expect(samePath(seen[0] ?? '', join(root, 'main.ts'))).toBe(true)
    // 被跳过的目录里的文件不能作为根进入程序。
    expect(seen.some(path => path.includes('node_modules') || path.includes('build'))).toBe(false)
  })

  it('reads files the program knows about and refuses everything else', async () => {
    // 程序内的普通源文件。
    expect(await shared.readFile(join(sharedRoot, 'a.ts'))).toBe(A_TS)
    // 程序内的 lib.d.ts（工作区之外）：语言服务解析过的文件才允许读。
    const typescriptEntry = require_.resolve('typescript')
    const libFile = join(dirname(typescriptEntry), 'lib.es5.d.ts')
    const lib = await shared.readFile(libFile)
    expect(typeof lib).toBe('string')
    expect(lib?.length).toBeGreaterThan(1000)

    // 工作区里存在、但不在程序里的非源码文件。
    await writeFile(join(sharedRoot, 'notes.txt'), 'hello', 'utf8')
    expect(await shared.readFile(join(sharedRoot, 'notes.txt'))).toBeUndefined()
    // 工作区之外任意存在的文件。
    const outside = await makeWorkspace({ 'secret.ts': 'export const secret = 1\n' })
    expect(await shared.readFile(join(outside, 'secret.ts'))).toBeUndefined()
  })
})

describe('document synchronisation', () => {
  it('lets in-memory content override the file on disk, and reflects version changes', async () => {
    const root = await makeWorkspace({ 'a.ts': 'export const value: number = 1\n' })
    const provider = makeProvider(root)
    const path = join(root, 'a.ts')
    expect(await provider.diagnostics(path)).toEqual([])

    provider.openDocument(document(path, 'export const value: number = "x"\n', 1))
    const broken = await provider.diagnostics(path)
    expect(broken.some(diagnostic => diagnostic.code === 'TS2322')).toBe(true)
    // 读取走的是内存正文，而不是磁盘。
    expect(await provider.readFile(path)).toBe('export const value: number = "x"\n')

    provider.changeDocument(document(path, 'export const value: number = 2\n', 2))
    expect((await provider.diagnostics(path)).some(diagnostic => diagnostic.code === 'TS2322')).toBe(false)

    // 乱序的旧版本必须被忽略（否则旧正文会覆盖新正文）。
    provider.changeDocument(document(path, 'export const value: number = "old"\n', 1))
    expect((await provider.diagnostics(path)).some(diagnostic => diagnostic.code === 'TS2322')).toBe(false)

    // 关闭之后回落到磁盘内容。
    provider.closeDocument(path)
    expect(await provider.diagnostics(path)).toEqual([])
  })

  it('adds a client-opened file that tsconfig does not include to the program', async () => {
    const root = await makeWorkspace({
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', noEmit: true, skipLibCheck: true }, include: ['src'] }),
      'src/main.ts': 'export const ok = 1\n',
    })
    const provider = makeProvider(root)
    const loose = join(root, 'loose.ts')
    provider.openDocument(document(loose, 'const value: number = "loose"\n', 1))
    const diagnostics = await provider.diagnostics(loose)
    expect(diagnostics.some(diagnostic => diagnostic.code === 'TS2322')).toBe(true)
  })

  it('picks up a change made on disk through the mtime-derived script version', async () => {
    const root = await makeWorkspace({ 'a.ts': 'export const value: number = 1\n' })
    const provider = makeProvider(root)
    const path = join(root, 'a.ts')
    expect(await provider.diagnostics(path)).toEqual([])
    await writeFile(path, 'export const value: number = "changed"\n', 'utf8')
    const diagnostics = await provider.diagnostics(path)
    expect(diagnostics.some(diagnostic => diagnostic.code === 'TS2322')).toBe(true)
  })

  it('never throws after dispose and releases its state', async () => {
    const root = await makeWorkspace({ 'a.ts': 'export const value: number = 1\n' })
    const provider = makeProvider(root)
    const path = join(root, 'a.ts')
    await provider.diagnostics(path)
    await provider.dispose()
    // dispose 之后所有公开方法都返回空结果而不是抛错，路由层不需要为「服务已关闭」写特判。
    await expect(provider.diagnostics(path)).resolves.toEqual([])
    await expect(provider.hover(path, { line: 0, character: 13 })).resolves.toBeNull()
    await expect(provider.documentSymbols(path)).resolves.toEqual([])
    await expect(provider.readFile(path)).resolves.toBeUndefined()
    await expect(provider.workspaceDiagnostics(() => undefined)).resolves.toEqual({ checked: 0, errors: 0, warnings: 0 })
    expect(() => provider.openDocument(document(path, 'x', 1))).not.toThrow()
    expect(() => provider.dispose()).not.toThrow()
  })

  it('exposes the provider through the factory with the builtin descriptor', () => {
    const provider = createTypeScriptProvider({ workspace: sharedRoot, onDiagnostics: () => undefined })
    providers.push(provider as TypeScriptLanguageProvider)
    expect(provider.info).toEqual({ id: 'builtin-typescript', name: '内置 TypeScript', languages: ['typescript', 'javascript', 'javascriptreact', 'typescriptreact'], kind: 'builtin' })
  })

  it('loads typescript lazily instead of importing it at module scope', () => {
    // 宿主 bundle 里 typescript 是外部化依赖；模块顶层一旦 import，加载补全/工作台就会拖上整个编译器。
    const source = readFileSync(new URL('../src/language/typescript.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/^import\s[^\n]*from\s+['"]typescript['"]/m)
    expect(source).toContain("await import('typescript')")
  })
})
