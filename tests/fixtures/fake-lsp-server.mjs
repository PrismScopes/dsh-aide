/**
 * 测试用的最小 LSP 服务器（真实子进程）。
 *
 * 由 lsp-external.spec.ts 用 `process.execPath` 启动，走真正的 stdio 管道；因此这里刻意只
 * 依赖 Node 标准库、不 import 仓库里的 TS。它覆盖 initialize / 文档同步 / 诊断推送 / 几种
 * 语言特性请求 / shutdown，并在收到 exit 时写一个标记文件，供测试确认子进程确实退出了。
 *
 * 环境变量：
 *   DSH_FAKE_LSP_EXIT_FILE — 收到 exit 通知后写入此文件（用于断言 dispose 停掉了子进程）。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const exitFile = process.env.DSH_FAKE_LSP_EXIT_FILE
const state = { initializeParams: undefined, document: undefined }

// 供 lsp-external 测试断言 stderr 按行回调：启动时往 stderr 写一条。
if (process.env.DSH_FAKE_LSP_STDERR !== undefined) process.stderr.write(`${process.env.DSH_FAKE_LSP_STDERR}\n`)

const ZERO_RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]))
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function workspaceDir() {
  const rootUri = state.initializeParams?.rootUri
  if (typeof rootUri !== 'string') return process.cwd()
  try { return fileURLToPath(rootUri) } catch { return process.cwd() }
}

/** 一个「跳转目标」文件：路径从 initialize 的 rootUri 推导，顺便验证客户端传了工作区根。 */
function targetUri() {
  return pathToFileURL(join(workspaceDir(), 'target.py')).href
}

function currentUri() {
  return state.document?.uri ?? targetUri()
}

function publish(message) {
  if (state.document === undefined) return
  send({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: {
      uri: state.document.uri,
      version: state.document.version,
      diagnostics: [{ range: ZERO_RANGE, severity: 1, code: 4242, source: 'fake', message }],
    },
  })
}

function handleRequest(id, method, params) {
  switch (method) {
    case 'initialize':
      state.initializeParams = params ?? {}
      return respond(id, {
        capabilities: {
          textDocumentSync: 1,
          hoverProvider: true,
          definitionProvider: true,
          referencesProvider: true,
          renameProvider: true,
          documentSymbolProvider: true,
          workspaceSymbolProvider: true,
          completionProvider: { triggerCharacters: ['.'] },
          signatureHelpProvider: { triggerCharacters: ['('] },
          codeActionProvider: true,
        },
        serverInfo: { name: 'fake-lsp-server' },
      })
    case 'shutdown':
      return respond(id, null)
    case 'textDocument/hover':
      // folders:N 用来证明 initialize 里确实带了 workspaceFolders。
      return respond(id, { contents: { kind: 'markdown', value: `**fake hover** folders:${state.initializeParams?.workspaceFolders?.length ?? 0}` }, range: ZERO_RANGE })
    case 'textDocument/definition':
      return respond(id, [{ uri: targetUri(), range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } } }])
    case 'textDocument/references':
      return respond(id, [{ uri: currentUri(), range: ZERO_RANGE }])
    case 'textDocument/rename':
      return respond(id, { changes: { [currentUri()]: [{ range: ZERO_RANGE, newText: String(params?.newName ?? 'renamed') }] } })
    case 'textDocument/documentSymbol':
      return respond(id, [{
        name: 'fakeSymbol',
        detail: 'detail',
        kind: 12,
        range: ZERO_RANGE,
        selectionRange: ZERO_RANGE,
        children: [{ name: 'fakeChild', kind: 13, range: ZERO_RANGE, selectionRange: ZERO_RANGE }],
      }])
    case 'workspace/symbol':
      return respond(id, [{ name: 'fakeWorkspaceSymbol', kind: 12, containerName: 'module', location: { uri: currentUri(), range: ZERO_RANGE } }])
    case 'textDocument/completion':
      return respond(id, {
        isIncomplete: true,
        items: [{
          label: 'fakeCompletion',
          kind: 3,
          detail: 'detail text',
          documentation: 'doc text',
          insertText: 'fakeCompletion',
          sortText: '1',
          filterText: 'fake',
          textEdit: { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'fakeCompletion' },
          additionalTextEdits: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, newText: 'import fake\n' }],
        }],
      })
    case 'textDocument/signatureHelp':
      return respond(id, {
        signatures: [{ label: 'fake(a: int)', documentation: 'sig doc', parameters: [{ label: [5, 10] }, { label: 'b' }], activeParameter: 0 }],
        activeSignature: 0,
        activeParameter: 0,
      })
    case 'textDocument/codeAction':
      return respond(id, [
        { title: 'Fake quick fix', kind: 'quickfix', isPreferred: true, edit: { changes: { [currentUri()]: [{ range: ZERO_RANGE, newText: 'fixed' }] } } },
        { title: 'Command only', command: { title: 'noop', command: 'noop' } },
      ])
    default:
      return respondError(id, -32601, `unsupported request: ${method}`)
  }
}

function handleNotification(method, params) {
  switch (method) {
    case 'initialized':
      return
    case 'textDocument/didOpen': {
      const document = params?.textDocument
      if (document === undefined) return
      state.document = { uri: document.uri, version: document.version, languageId: document.languageId, text: document.text }
      publish(`fake diagnostic ${document.languageId} v${document.version} 中文 ${String(document.text).trim()}`)
      return
    }
    case 'textDocument/didChange': {
      const document = params?.textDocument
      const text = params?.contentChanges?.[0]?.text
      if (document === undefined) return
      state.document = { ...(state.document ?? {}), uri: document.uri, version: document.version, text }
      publish(`fake diagnostic changed v${document.version} ${String(text).trim()}`)
      return
    }
    case 'textDocument/didClose':
      state.document = undefined
      return
    case 'exit':
      return finish()
    case '$/cancelRequest':
      return
    default:
      return
  }
}

function finish() {
  if (exitFile !== undefined) {
    try { writeFileSync(exitFile, 'exited') } catch { /* 标记文件写不了不影响退出 */ }
  }
  // 先让已写出的响应 flush，再退出；否则客户端可能收不到 shutdown 的响应。
  process.stdout.write('', () => process.exit(0))
  setTimeout(() => process.exit(0), 200).unref()
}

let buffer = Buffer.alloc(0)
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const header = buffer.subarray(0, headerEnd).toString('ascii')
    const lengthMatch = /content-length:\s*(\d+)/i.exec(header)
    if (lengthMatch === null) return process.exit(1)
    const length = Number(lengthMatch[1])
    const bodyStart = headerEnd + 4
    if (buffer.length - bodyStart < length) return
    const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
    buffer = buffer.subarray(bodyStart + length)
    let message
    try { message = JSON.parse(body) } catch { continue }
    if (message === null || typeof message !== 'object' || typeof message.method !== 'string') continue
    if (message.id !== undefined && message.id !== null) handleRequest(message.id, message.method, message.params)
    else handleNotification(message.method, message.params)
  }
})

// 传输层 close() 会 end stdin：没有 exit 通知时也照常退出，避免测试留下子进程。
process.stdin.on('end', () => process.exit(0))
process.on('uncaughtException', error => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`)
  process.exit(1)
})
