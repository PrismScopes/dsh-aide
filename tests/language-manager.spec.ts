import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LanguageManager, applyTextEdits } from '../src/language/manager.ts'
import { LanguageHost } from '../src/language/host.ts'
import { resetLanguageSettings, setLanguageSettings } from '../src/language/settings.ts'
import type { LanguagePushMessage } from '../src/language/protocol.ts'

/**
 * 语言服务管理器的端到端测试（真 TypeScript 编译器 API，假 WebSocket 客户端）。
 *
 * 覆盖的是「路由层依赖的那几条不变式」：文档同步 → 诊断推送、跨文件定义、工作区符号、
 * 关闭/禁用后的降级、写盘接口、按工作区聚合推送。单文件能力由 typescript-provider.spec.ts 覆盖。
 */
const roots: string[] = []
const originalEnv = { ...process.env }

async function tempWorkspace(): Promise<{ root: string; home: string }> {
  const base = await mkdtemp(join(tmpdir(), 'dvw-language-manager-'))
  roots.push(base)
  const root = join(base, 'ws')
  const home = join(base, 'home')
  await mkdir(root, { recursive: true })
  await mkdir(home, { recursive: true })
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' } }), 'utf8')
  await writeFile(join(root, 'a.ts'), 'export const value: number = 1\nexport function add(a: number, b: number): number { return a + b }\n', 'utf8')
  await writeFile(join(root, 'b.ts'), "import { value, add } from './a'\nconst total = add(value, 2)\n", 'utf8')
  return { root, home }
}

function envOf(home: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...originalEnv, DSH_HOME: home, ...extra }
}

async function waitFor(check: () => boolean, timeout = 8000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error('等待条件超时')
}

describe('语言服务管理器', () => {
  beforeEach(() => { resetLanguageSettings(); setLanguageSettings(undefined) })
  afterEach(() => { resetLanguageSettings() })
  afterAll(async () => {
    await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('reports builtin TS support and exposes provider languages', async () => {
    const { root, home } = await tempWorkspace()
    const manager = new LanguageManager({ workspace: root, env: envOf(home), diagnosticsDelayMs: 10 })
    try {
      const info = await manager.info()
      expect(info.enabled).toBe(true)
      expect(info.builtin).toMatchObject({ enabled: true, state: 'ready' })
      expect(info.languages).toContain('typescript')
      expect(info.languages).toContain('javascript')
    } finally { manager.dispose() }
  })

  it('pushes diagnostics after sync (debounced) and keeps them on close', async () => {
    const { root, home } = await tempWorkspace()
    const messages: LanguagePushMessage[] = []
    const manager = new LanguageManager({ workspace: root, env: envOf(home), emit: message => messages.push(message), diagnosticsDelayMs: 10 })
    const a = resolve(root, 'a.ts')
    try {
      const bad = 'export const value: number = "bad"\n'
      await manager.sync({ kind: 'open', path: a, languageId: 'typescript', version: 1, content: bad })
      await waitFor(() => messages.some(message => message.type === 'diagnostics' && message.path === a && message.diagnostics.some(diagnostic => diagnostic.severity === 'error')))
      const diagnostic = messages.filter(message => message.type === 'diagnostics' && message.path === a).at(-1)
      expect(diagnostic).toMatchObject({ type: 'diagnostics' })
      if (diagnostic?.type === 'diagnostics') {
        expect(diagnostic.diagnostics[0]?.code).toMatch(/^TS\d+$/)
        expect(diagnostic.diagnostics[0]?.source).toBe('ts')
      }
      // 关闭文档后最近一次诊断仍保留（问题面板还能看到「曾有错」），但不影响后续请求。
      await manager.sync({ kind: 'close', path: a, languageId: 'typescript', version: 3, content: '' })
      expect(manager.diagnosticsOf(a).length).toBeGreaterThan(0)
    } finally { manager.dispose() }
  })

  it('serves cross-file definitions and workspace symbols from the same program', async () => {
    const { root, home } = await tempWorkspace()
    const manager = new LanguageManager({ workspace: root, env: envOf(home), diagnosticsDelayMs: 10 })
    const a = resolve(root, 'a.ts')
    const b = resolve(root, 'b.ts')
    try {
      // 打开 b.ts（引用 a.ts）：宿主应能解析到 a.ts 的定义。
      await manager.sync({ kind: 'open', path: b, languageId: 'typescript', version: 1, content: await readFile(b, 'utf8') })
      const locations = await manager.definition(b, { line: 1, character: 17 }) // add(
      expect(locations.length).toBeGreaterThan(0)
      expect(locations.some(location => resolve(location.path) === a)).toBe(true)
      const symbols = await manager.workspaceSymbols('add')
      expect(symbols.some(symbol => resolve(symbol.path) === a && symbol.name === 'add')).toBe(true)
      expect(await manager.workspaceSymbols('')).toEqual([])
      // 工作区外路径一律拒绝，不通过语言服务读任意盘。
      expect(await manager.readFile('C:/Windows/win.ini')).toBeUndefined()
    } finally { manager.dispose() }
  })

  it('writes workspace edits for unopened files and refuses paths outside the workspace', async () => {
    const { root, home } = await tempWorkspace()
    const manager = new LanguageManager({ workspace: root, env: envOf(home), diagnosticsDelayMs: 10 })
    const a = resolve(root, 'a.ts')
    try {
      const written = await manager.applyEdits({
        changes: [
          { path: a, edits: [{ range: { start: { line: 0, character: 29 }, end: { line: 0, character: 30 } }, newText: '2' }] },
          { path: 'C:/outside.ts', edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'x' }] },
        ],
      })
      expect(written).toEqual([a])
      expect((await readFile(a, 'utf8')).startsWith('export const value: number = 2')).toBe(true)
    } finally { manager.dispose() }
  })

  it('scans the whole workspace and reports progress/status', async () => {
    const { root, home } = await tempWorkspace()
    await writeFile(join(root, 'broken.ts'), 'const broken: number = "no"\n', 'utf8')
    const messages: LanguagePushMessage[] = []
    const manager = new LanguageManager({ workspace: root, env: envOf(home), emit: message => messages.push(message), diagnosticsDelayMs: 10 })
    try {
      const state = await manager.scan()
      expect(state?.running).toBe(false)
      expect(state?.errors).toBeGreaterThan(0)
      expect(messages.some(message => message.type === 'status' && message.scan?.running === true)).toBe(true)
      expect(messages.some(message => message.type === 'diagnostics' && message.path.endsWith('broken.ts') && message.diagnostics.some(diagnostic => diagnostic.severity === 'error'))).toBe(true)
    } finally { manager.dispose() }
  })

  it('stays silent when the language service is disabled', async () => {
    const { root, home } = await tempWorkspace()
    const env = envOf(home, { DSH_AIDE_LANGUAGE: '0' })
    setLanguageSettings(undefined)
    resetLanguageSettings()
    const manager = new LanguageManager({ workspace: root, env, diagnosticsDelayMs: 10 })
    const a = resolve(root, 'a.ts')
    try {
      const info = await manager.info()
      expect(info.enabled).toBe(false)
      expect(info.languages).toEqual([])
      await manager.sync({ kind: 'open', path: a, languageId: 'typescript', version: 1, content: 'const x: number = "bad"' })
      expect(await manager.definition(a, { line: 0, character: 6 })).toEqual([])
      expect(await manager.scan()).toBeUndefined()
    } finally { manager.dispose() }
  })
})

describe('语言服务宿主聚合', () => {
  it('forwards manager messages to attached sockets and closes them on reset', async () => {
    const { root, home } = await tempWorkspace()
    const host = new LanguageHost(envOf(home))
    const sent: string[] = []
    let closed: number | undefined
    const socket = { readyState: 1, send: (data: string) => { sent.push(data) }, close: (code?: number) => { closed = code } }
    try {
      host.attach(root, socket)
      await waitFor(() => sent.some(data => JSON.parse(data).type === 'status'))
      const manager = host.managerFor(root)
      const a = resolve(root, 'a.ts')
      await manager.sync({ kind: 'open', path: a, languageId: 'typescript', version: 1, content: 'const x: number = "bad"' })
      await waitFor(() => sent.some(data => JSON.parse(data).type === 'diagnostics'))
      expect(host.servers().length).toBeGreaterThan(0)
      host.reset()
      expect(closed).toBe(1012)
    } finally { host.dispose() }
  })
})

describe('文本编辑应用', () => {
  it('applies edits from back to front and validates reversed ranges', () => {
    const text = 'one two three\n'
    const next = applyTextEdits(text, [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: '1' },
      { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 13 } }, newText: '3' },
    ])
    expect(next).toBe('1 two 3\n')
    expect(() => applyTextEdits(text, [{ range: { start: { line: 0, character: 4 }, end: { line: 0, character: 1 } }, newText: 'x' }]))
      .toThrow()
  })
})
