import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseSse, type CompletionEvent } from '../src/completion/protocol.ts'
import { registerCompletionRoute } from '../src/completion/register.ts'
import { WorkspaceIndex } from '../src/completion/workspaceIndex.ts'

/** 可控的 WorkspaceIndex.open：让索引加载一直挂起，验证响应头是否已经先发出去。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class FakeResponse extends EventEmitter {
  readonly events: string[] = []
  readonly chunks: string[] = []
  writableEnded = false
  readonly writeHead = vi.fn((_status: number, _headers?: Record<string, string>) => {
    this.events.push('writeHead')
  })
  readonly flushHeaders = vi.fn(() => {
    this.events.push('flushHeaders')
  })
  readonly write = vi.fn((chunk: string) => {
    this.chunks.push(chunk)
    this.events.push('write')
    return true
  })
  readonly end = vi.fn(() => {
    this.events.push('end')
    this.writableEnded = true
  })
}

const requestBody = (): Record<string, unknown> => ({
  sessionId: 's',
  environment: { ideVersion: '1', extensionVersion: '1', region: '', channel: 'dev', repository: '' },
  language: 'typescript',
  trigger: 'inline',
  edits: [],
  cursor: { filePath: 'src/a.ts', rewriteAt: { line: 1, column: 6 }, document: 'const ' },
  diagnostics: [],
  forceRewrite: false,
})

const setupRoute = (cwd: string, body: Record<string, unknown> = requestBody()) => {
  let handler: ((request: unknown, response: unknown) => void | Promise<void>) | undefined
  const ctx = {
    get: (name: string) =>
      name === 'sessions'
        ? { get: () => ({ header: { cwd } }), list: () => [] }
        : undefined,
    effect: (run: () => void) => run(),
    webServer: {
      register: (route: { handler: (request: unknown, response: unknown) => void | Promise<void> }) => {
        handler = route.handler
        return () => undefined
      },
    },
  }
  const helpers = {
    authorize: () => true,
    readBody: async () => body,
    send: vi.fn(),
    sendError: vi.fn(),
    cwdFor: () => cwd,
  }
  registerCompletionRoute(ctx as never, helpers as never)
  return { handler: handler as (request: unknown, response: unknown) => Promise<void>, helpers }
}

const waitMicrotasks = async (times = 10): Promise<void> => {
  for (let index = 0; index < times; index++) await Promise.resolve()
}

const savedEnv = { provider: process.env['DSH_COMPLETION_PROVIDER'], endpoint: process.env['DSH_COMPLETION_ENDPOINT'] }
afterEach(() => {
  vi.restoreAllMocks()
  if (savedEnv.provider === undefined) delete process.env['DSH_COMPLETION_PROVIDER']
  else process.env['DSH_COMPLETION_PROVIDER'] = savedEnv.provider
  if (savedEnv.endpoint === undefined) delete process.env['DSH_COMPLETION_ENDPOINT']
  else process.env['DSH_COMPLETION_ENDPOINT'] = savedEnv.endpoint
})

describe('completion first byte is not blocked by index preparation', () => {
  it('flushes SSE headers while the workspace index is still loading, then keeps the event sequence', async () => {
    process.env['DSH_COMPLETION_PROVIDER'] = 'local'
    delete process.env['DSH_COMPLETION_ENDPOINT']
    const cwd = `C:\\tmp\\dvw-first-byte-${randomUUID()}`
    const gate = deferred<WorkspaceIndex>()
    const openSpy = vi.spyOn(WorkspaceIndex, 'open').mockImplementation(() => gate.promise)
    const { handler } = setupRoute(cwd)
    const request = new EventEmitter() as EventEmitter & { method: string }
    request.method = 'POST'
    const response = new FakeResponse()
    const completion = handler(request, response)

    // 索引还在 loading：响应头必须已经发出去，而且一个 SSE 事件都还没写。
    await waitMicrotasks()
    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(response.flushHeaders).toHaveBeenCalledTimes(1)
    expect(response.events).toContain('writeHead')
    // 关键顺序：响应头先于任何 SSE 事件写出；索引还在 pending，所以此时还没有 write。
    expect(response.chunks).toHaveLength(0)
    expect(response.events.indexOf('writeHead')).toBeLessThan(response.events.indexOf('flushHeaders'))

    const fakeIndex = {
      ensureFresh: () => undefined,
      retrieve: async () => [],
    } as unknown as WorkspaceIndex
    gate.resolve(fakeIndex)
    await completion

    // 索引就绪后事件顺序与内容不变：meta → done（本地 provider 无候选）。
    const parsed = parseSse(response.chunks.join(''))
    expect(parsed.events.map((event: CompletionEvent) => event.type)).toEqual(['meta', 'done'])
    expect(response.end).toHaveBeenCalledTimes(1)
    expect(response.writableEnded).toBe(true)
    // 第一个 SSE 事件（meta）在响应头之后才写出。
    expect(response.events.indexOf('flushHeaders')).toBeLessThan(response.events.indexOf('write'))
  })

  it('still finishes the SSE stream when index preparation fails', async () => {
    process.env['DSH_COMPLETION_PROVIDER'] = 'local'
    delete process.env['DSH_COMPLETION_ENDPOINT']
    const cwd = `C:\\tmp\\dvw-first-byte-${randomUUID()}`
    const gate = deferred<WorkspaceIndex>()
    const openSpy = vi.spyOn(WorkspaceIndex, 'open').mockImplementation(() => gate.promise)
    const { handler } = setupRoute(cwd)
    const request = new EventEmitter() as EventEmitter & { method: string }
    request.method = 'POST'
    const response = new FakeResponse()
    const completion = handler(request, response)

    await waitMicrotasks()
    expect(response.flushHeaders).toHaveBeenCalledTimes(1)
    gate.reject(new Error('index exploded'))
    await completion

    const parsed = parseSse(response.chunks.join(''))
    expect(parsed.events.map((event: CompletionEvent) => event.type)).toEqual(['meta', 'done'])
    expect(response.end).toHaveBeenCalledTimes(1)
    openSpy.mockRestore()
  })
})
