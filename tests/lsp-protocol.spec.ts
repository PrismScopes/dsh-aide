import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { LspClient, pathToUri } from '../src/language/lsp/client.ts'
import type { LspTransport } from '../src/language/lsp/transport.ts'
import { encodeLspMessage, LspStreamParser, spawnLspTransport } from '../src/language/lsp/transport.ts'
import type { LanguageDiagnostic } from '../src/language/protocol.ts'

const roots: string[] = []
async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dvw-lsp-'))
  roots.push(root)
  return root
}
/** Windows 上子进程退出前仍持有 cwd 句柄，rmdir 会短暂 EBUSY：重试到它真正退出。 */
async function removeRoot(root: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rm(root, { recursive: true, force: true }); return }
    catch (error) {
      if (attempt >= 40) throw error
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(removeRoot)) })

const fixturePath = fileURLToPath(new URL('./fixtures/fake-lsp-server.mjs', import.meta.url))
const tick = (ms = 10): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** 内存传输：把 client 发出的消息记下来，测试手动投递服务端消息，不启动进程。 */
class MemoryTransport implements LspTransport {
  readonly sent: Array<Record<string, unknown>> = []
  closed = false
  private readonly messageListeners = new Set<(message: unknown) => void>()
  private readonly closeListeners = new Set<(error?: Error) => void>()

  send(message: unknown): void { this.sent.push(message as Record<string, unknown>) }
  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener)
    return () => { this.messageListeners.delete(listener) }
  }
  onClose(listener: (error?: Error) => void): () => void {
    if (this.closed) { listener(); return () => undefined }
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }
  receive(message: unknown): void { for (const listener of [...this.messageListeners]) listener(message) }
  close(): void { this.closeWithError() }
  closeWithError(error?: Error): void {
    if (this.closed) return
    this.closed = true
    this.messageListeners.clear()
    for (const listener of [...this.closeListeners]) listener(error)
  }
}

function sentMethod(transport: MemoryTransport, method: string): Record<string, unknown> | undefined {
  return transport.sent.find(message => message.method === method)
}

function createClient(transport: MemoryTransport, workspace: string, options: { requestTimeoutMs?: number; onDiagnostics?: (path: string, diagnostics: readonly LanguageDiagnostic[]) => void } = {}): LspClient {
  return new LspClient({ transport, workspace, ...options })
}

describe('LSP framing', () => {
  it('encodes a Content-Length header with the UTF-8 byte length', () => {
    const frame = encodeLspMessage({ jsonrpc: '2.0', method: 'x', params: { text: '中文' } })
    const separator = frame.indexOf(Buffer.from('\r\n\r\n', 'ascii'))
    expect(separator).toBeGreaterThan(0)
    const header = frame.subarray(0, separator).toString('ascii')
    const body = frame.subarray(separator + 4)
    const match = /^Content-Length: (\d+)$/.exec(header)
    expect(match).not.toBeNull()
    // '中文' 是 6 个 UTF-8 字节：Content-Length 必须按字节而不是字符数算。
    expect(Number(match![1])).toBe(body.length)
    expect(JSON.parse(body.toString('utf8'))).toEqual({ jsonrpc: '2.0', method: 'x', params: { text: '中文' } })
  })

  it('parses a message split across arbitrarily small chunks', () => {
    const frame = encodeLspMessage({ jsonrpc: '2.0', id: 7, result: { ok: true, text: '中文' } })
    const parser = new LspStreamParser()
    const messages: unknown[] = []
    for (const byte of frame) messages.push(...parser.push(Buffer.from([byte])))
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 7, result: { ok: true, text: '中文' } }])
    expect(parser.pendingBytes).toBe(0)
  })

  it('parses multiple messages glued into one chunk', () => {
    const parser = new LspStreamParser()
    const glued = Buffer.concat([encodeLspMessage({ id: 1 }), encodeLspMessage({ id: 2 }), encodeLspMessage({ id: 3 })])
    expect(parser.push(glued)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  })

  it('accepts LF-only headers, extra headers and case-insensitive names', () => {
    const parser = new LspStreamParser()
    expect(parser.push(Buffer.from('content-length: 2\r\ncontent-type: application/vscode-jsonrpc\r\n\r\n{}'))).toEqual([{}])
    expect(parser.push(Buffer.from('Content-Length: 2\n\n{}'))).toEqual([{}])
    // 多字节正文跨 chunk：Body 只在凑够 Content-Length 字节后才解析。
    const frame = encodeLspMessage({ text: '中文' })
    expect(parser.push(frame.subarray(0, 5))).toEqual([])
    expect(parser.push(frame.subarray(5))).toEqual([{ text: '中文' }])
  })

  it('rejects malformed headers', () => {
    expect(() => new LspStreamParser().push(Buffer.from('X-Test: 1\r\n\r\n{}'))).toThrow(/Content-Length/)
    expect(() => new LspStreamParser().push(Buffer.from('Content-Length: nope\r\n\r\n{}'))).toThrow(/Content-Length/)
    expect(() => new LspStreamParser().push(Buffer.from('garbage\r\n\r\n'))).toThrow(/header line/)
  })

  it('reports invalid JSON bodies', () => {
    const parser = new LspStreamParser()
    expect(() => parser.push(Buffer.from('Content-Length: 3\r\n\r\nnop'))).toThrow(/not valid JSON/)
  })

  it('reports spawn failures through onClose', async () => {
    const root = await temp()
    const transport = spawnLspTransport({ command: join(root, 'definitely-missing-lsp-binary'), cwd: root })
    const error = await new Promise<Error | undefined>(resolve => transport.onClose(resolve))
    expect(error).toBeInstanceOf(Error)
  })

  it.skipIf(process.platform !== 'win32')('launches .cmd servers through cmd.exe', async () => {
    const root = await temp()
    const command = join(root, 'fake-lsp.cmd')
    await writeFile(command, `@echo off\r\n"${process.execPath}" "${fixturePath}"\r\n`, 'utf8')
    const transport = spawnLspTransport({ command, cwd: root })
    try {
      transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: null, rootUri: pathToFileURL(root).href, capabilities: {} } })
      const message = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for the .cmd fake server')), 10_000)
        transport.onMessage(value => { clearTimeout(timer); resolve(value as Record<string, unknown>) })
        transport.onClose(error => { clearTimeout(timer); reject(error ?? new Error('transport closed before a response')) })
      })
      expect(message.id).toBe(1)
      expect(message.result).toBeDefined()
    } finally { transport.close() }
  })
})

describe('LSP JSON-RPC client', () => {
  it('initializes with rootUri, workspace folders and the declared capabilities', async () => {
    const workspace = await temp()
    const transport = new MemoryTransport()
    const client = createClient(transport, workspace)
    const starting = client.start()
    const initialize = transport.sent[0]
    expect(initialize?.method).toBe('initialize')
    const params = initialize?.params as Record<string, unknown>
    expect(params.rootUri).toBe(pathToFileURL(workspace).href)
    expect(params.workspaceFolders).toEqual([{ uri: pathToFileURL(workspace).href, name: expect.any(String) }])
    expect(params.processId).toBe(process.pid)
    expect((params.clientInfo as Record<string, unknown>).name).toBe('dsh-aide')
    const capabilities = params.capabilities as Record<string, Record<string, unknown>>
    expect(capabilities.workspace).toMatchObject({ configuration: true, workspaceFolders: true })
    const textDocument = capabilities.textDocument as Record<string, unknown>
    expect(textDocument.publishDiagnostics).toBeDefined()
    const completion = textDocument.completion as { completionItem?: { snippetSupport?: boolean } }
    expect(completion.completionItem?.snippetSupport).toBe(false)
    transport.receive({ jsonrpc: '2.0', id: initialize?.id, result: { capabilities: { hoverProvider: true } } })
    await starting
    expect(client.capabilities).toEqual({ hoverProvider: true })
    expect(sentMethod(transport, 'initialized')).toBeDefined()
  })

  it('round-trips requests and rejects JSON-RPC errors', async () => {
    const transport = new MemoryTransport()
    const client = createClient(transport, await temp())
    const hover = client.request('textDocument/hover', { textDocument: { uri: pathToUri('x') } })
    const request = transport.sent[0]!
    transport.receive({ jsonrpc: '2.0', id: request.id, result: { contents: 'hi' } })
    await expect(hover).resolves.toEqual({ contents: 'hi' })

    const failing = client.request('textDocument/definition')
    const failingRequest = transport.sent[1]!
    transport.receive({ jsonrpc: '2.0', id: failingRequest.id, error: { code: -32601, message: 'boom' } })
    await expect(failing).rejects.toThrow(/boom/)
  })

  it('times out slow requests', async () => {
    const transport = new MemoryTransport()
    const client = createClient(transport, await temp(), { requestTimeoutMs: 25 })
    await expect(client.request('textDocument/hover')).rejects.toThrow(/timed out/)
  })

  it('cancels a request with $/cancelRequest when the signal aborts', async () => {
    const transport = new MemoryTransport()
    const client = createClient(transport, await temp())
    const controller = new AbortController()
    const requested = client.request('textDocument/references', undefined, controller.signal)
    const request = transport.sent[0]!
    controller.abort()
    await expect(requested).rejects.toThrow(/cancelled/)
    expect(sentMethod(transport, '$/cancelRequest')?.params).toEqual({ id: request.id })
  })

  it('answers server-initiated requests with defaults', async () => {
    const transport = new MemoryTransport()
    const client = createClient(transport, await temp())
    transport.receive({ jsonrpc: '2.0', id: 11, method: 'workspace/configuration', params: { items: [{ section: 'python' }] } })
    transport.receive({ jsonrpc: '2.0', id: 12, method: 'client/registerCapability', params: { registrations: [] } })
    transport.receive({ jsonrpc: '2.0', id: 13, method: 'window/workDoneProgress/create', params: { token: 't' } })
    await tick()
    expect(transport.sent.find(message => message.id === 11)).toMatchObject({ result: [] })
    expect(transport.sent.find(message => message.id === 12)).toMatchObject({ result: null })
    expect(transport.sent.find(message => message.id === 13)).toMatchObject({ result: null })
    // 未知请求要回 -32601，不能让服务器一直等响应。
    transport.receive({ jsonrpc: '2.0', id: 14, method: 'unknown/custom' })
    await tick()
    expect((transport.sent.find(message => message.id === 14)?.error as Record<string, unknown>).code).toBe(-32601)
  })

  it('logs window/showMessage notifications', async () => {
    const logs: Array<{ level: string; message: string }> = []
    const transport = new MemoryTransport()
    void new LspClient({ transport, workspace: await temp(), onLog: (level, message) => logs.push({ level, message }) })
    transport.receive({ jsonrpc: '2.0', method: 'window/showMessage', params: { type: 2, message: 'careful' } })
    transport.receive({ jsonrpc: '2.0', method: 'window/logMessage', params: { type: 3, message: 'hello' } })
    expect(logs).toEqual([{ level: 'warn', message: 'careful' }, { level: 'info', message: 'hello' }])
  })

  it('converts publishDiagnostics to absolute paths and the public diagnostic shape', async () => {
    const root = await temp()
    const path = join(root, 'a.py')
    const other = join(root, 'b.py')
    const pushes: Array<{ path: string; diagnostics: readonly LanguageDiagnostic[] }> = []
    const transport = new MemoryTransport()
    createClient(transport, root, { onDiagnostics: (diagnosticPath, diagnostics) => pushes.push({ path: diagnosticPath, diagnostics }) })
    transport.receive({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: pathToUri(path),
        diagnostics: [
          {
            range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
            severity: 1,
            code: 4242,
            source: 'fake',
            tags: [1, 2],
            message: 'something is wrong',
            relatedInformation: [{ location: { uri: pathToUri(other), range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } } }, message: 'declared here' }],
          },
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 4, code: 'H1', message: 'hint' },
        ],
      },
    })
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.path).toBe(path)
    expect(pushes[0]!.diagnostics[0]).toMatchObject({
      severity: 'error',
      code: '4242',
      source: 'fake',
      message: 'something is wrong',
      tags: ['unnecessary', 'deprecated'],
      range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
    })
    expect(pushes[0]!.diagnostics[0]!.related).toEqual([{ path: other, range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, message: 'declared here' }])
    expect(pushes[0]!.diagnostics[1]).toMatchObject({ severity: 'hint', code: 'H1' })
  })

  it('rejects pending requests when the transport closes', async () => {
    const transport = new MemoryTransport()
    const client = createClient(transport, await temp())
    const pending = client.request('textDocument/hover')
    transport.closeWithError(new Error('server crashed'))
    await expect(pending).rejects.toThrow(/server crashed/)
    await expect(client.request('textDocument/hover')).rejects.toThrow(/not available/)
  })

  it('shuts down with shutdown + exit and closes the transport', async () => {
    const transport = new MemoryTransport()
    const client = createClient(transport, await temp())
    const starting = client.start()
    const initialize = transport.sent[0]!
    transport.receive({ jsonrpc: '2.0', id: initialize.id, result: { capabilities: {} } })
    await starting
    const stopping = client.stop()
    const shutdown = transport.sent.find(message => message.method === 'shutdown')
    expect(shutdown).toBeDefined()
    transport.receive({ jsonrpc: '2.0', id: shutdown?.id, result: null })
    await stopping
    expect(sentMethod(transport, 'exit')).toBeDefined()
    expect(transport.closed).toBe(true)
  })
})
