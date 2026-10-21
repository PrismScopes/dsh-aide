import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import type { HostContext } from '../src/context.ts'
import { registerWorkbenchRoutes } from '../src/routes.ts'
import { resetLanguageSettings } from '../src/language/settings.ts'
import type { LanguageInfo, LanguageLocation, LanguagePushMessage } from '../src/language/protocol.ts'

/**
 * 语言服务路由的端到端测试：真实的 routes/api/manager/TypeScript 语言服务 + 真实 HTTP/WS 服务器。
 *
 * 这一层最容易出的问题是「每段单测都过、接起来却没通」：会话 → cwd → dispatchLanguage → manager →
 * WebSocket 推送。这里用假 HostContext 注册真实路由，再用 fetch/ws 客户端走一遍。
 */
const roots: string[] = []
let server: ReturnType<typeof createServer> | undefined
let base = ''
let socket: WebSocket | undefined
let context: HostContext | undefined
const originalHome = process.env['DSH_HOME']

async function tempWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dvw-language-routes-'))
  roots.push(root)
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' } }))
  await writeFile(join(root, 'src', 'a.ts'), 'export const value: number = 1\n')
  await writeFile(join(root, 'src', 'b.ts'), "import { value } from './a'\nconst total = value + 1\n")
  return root
}

async function api<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${base}/dsh-vscode/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session', ...body }),
  })
  const answer = await response.json() as { ok: boolean; value?: T; error?: { message?: string } }
  if (!answer.ok) throw new Error(answer.error?.message ?? 'request failed')
  return answer.value as T
}

let workspaceRoot = ''

beforeAll(async () => {
  workspaceRoot = await tempWorkspace()
  const home = await mkdtemp(join(tmpdir(), 'dvw-language-routes-home-'))
  roots.push(home)
  process.env['DSH_HOME'] = home
  resetLanguageSettings()

  interface RegisteredRoute { kind: 'exact' | 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }
  interface UpgradeRoute { path: string; handler(req: IncomingMessage, socket: Duplex, head: Buffer): void | Promise<void> }
  const routes: RegisteredRoute[] = []
  const upgrades: UpgradeRoute[] = []
  const cleanups: (() => void)[] = []
  context = {
    webServer: {
      register(route: RegisteredRoute) { routes.push(route); return () => {} },
      registerUpgrade(route: UpgradeRoute) { upgrades.push(route); return () => {} },
    },
    sessions: { get: (id: string) => id === 'session' ? ({ id } as never) : undefined },
    workingDirectory: { get: () => workspaceRoot },
    connection: { requestRejection: () => undefined },
    effect: (callback: () => void | (() => void)) => {
      const dispose = callback()
      cleanups.push(typeof dispose === 'function' ? dispose : () => {})
    },
  } as unknown as HostContext
  registerWorkbenchRoutes(context)

  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://dsh.local').pathname
    const route = routes.find(candidate => candidate.kind === 'exact' ? candidate.path === pathname : pathname.startsWith(candidate.path))
    if (route === undefined) { res.writeHead(404); res.end('not found'); return }
    void route.handler(req, res)
  })
  server.on('upgrade', (req, netSocket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://dsh.local').pathname
    const route = upgrades.find(candidate => candidate.path === pathname)
    if (route === undefined) { netSocket.destroy(); return }
    void route.handler(req, netSocket, head)
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  ;(context as unknown as { cleanups: (() => void)[] }).cleanups = cleanups
})

afterAll(async () => {
  socket?.close()
  await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve())
  const cleanups = (context as unknown as { cleanups?: (() => void)[] }).cleanups ?? []
  for (const cleanup of cleanups.reverse()) cleanup()
  if (originalHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = originalHome
  resetLanguageSettings()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('语言服务路由端到端', () => {
  it('serves language.info over the real HTTP route', async () => {
    const info = await api<LanguageInfo>('language.info', {})
    expect(info.enabled).toBe(true)
    expect(info.builtin.enabled).toBe(true)
    expect(info.languages).toContain('typescript')
  })

  it('syncs documents and pushes diagnostics through /dsh-vscode/ws/language', async () => {
    const messages: LanguagePushMessage[] = []
    socket = new WebSocket(`${base.replace('http', 'ws')}/dsh-vscode/ws/language?sessionId=session`)
    socket.on('message', raw => { try { messages.push(JSON.parse(String(raw)) as LanguagePushMessage) } catch { /* ignore */ } })
    await new Promise<void>((resolve, reject) => { socket!.once('open', () => resolve()); socket!.once('error', reject) })
    // 等先到的 status 推送（host.attach 会立刻发一次；info 里的服务器发现可能要几毫秒）。
    const statusDeadline = Date.now() + 4000
    while (Date.now() < statusDeadline && !messages.some(message => message.type === 'status')) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect(messages.some(message => message.type === 'status')).toBe(true)

    const a = join(workspaceRoot, 'src', 'a.ts')
    await api('language.sync', { kind: 'open', path: a, languageId: 'typescript', version: 1, content: 'export const value: number = "bad"\n' })
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && !messages.some(message => message.type === 'diagnostics' && message.diagnostics.length > 0)) {
      await new Promise(resolve => setTimeout(resolve, 80))
    }
    const diagnostics = messages.find(message => message.type === 'diagnostics' && message.diagnostics.length > 0)
    expect(diagnostics).toBeDefined()
    if (diagnostics?.type === 'diagnostics') {
      expect(diagnostics.path.endsWith('a.ts')).toBe(true)
      expect(diagnostics.diagnostics[0]?.severity).toBe('error')
      expect(diagnostics.diagnostics[0]?.code).toMatch(/^TS\d+$/)
    }
  })

  it('answers definition/workspace symbols against the same session workspace', async () => {
    const b = join(workspaceRoot, 'src', 'b.ts')
    await api('language.sync', { kind: 'open', path: b, languageId: 'typescript', version: 1, content: "import { value } from './a'\nconst total = value + 1\n" })
    const locations = await api<LanguageLocation[]>('language.definition', { path: b, position: { line: 1, character: 14 } })
    expect(locations.length).toBeGreaterThan(0)
    expect(locations[0]?.path.endsWith('a.ts')).toBe(true)
    const symbols = await api<{ name: string; path: string }[]>('language.workspaceSymbols', { query: 'value' })
    expect(symbols.some(symbol => symbol.name === 'value' && symbol.path.endsWith('a.ts'))).toBe(true)
  })

  it('rejects malformed language requests without crashing the route', async () => {
    const response = await fetch(`${base}/dsh-vscode/api/language.sync`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session', kind: 'open', path: 'relative.ts', languageId: 'typescript', version: 1, content: '' }),
    })
    expect(response.status).toBe(403)
    const answer = await response.json() as { ok: boolean; error?: { code?: string } }
    expect(answer.ok).toBe(false)
    expect(answer.error?.code).toBe('path-outside')
  })
})
