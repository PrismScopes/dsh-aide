import { readFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { isAbsolute, relative, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import chokidar from 'chokidar'
import { WebSocket, WebSocketServer } from 'ws'
import type { HostContext } from './context.ts'
import { codiconAsset, cwdFor, fileIconAsset, katexAsset, monacoAsset, onigWasmAsset, pdfWorkerAsset, uploadFile, workspacePreviewFile } from './host.ts'
import { readGrammar } from './assets.ts'
import { readBinaryBody, readBody, send, sendError, trusted, WorkbenchError } from './wire.ts'
import { dispatch } from './api.ts'

/**
 * 宿主侧的全部 HTTP / WebSocket 路由。
 *
 * 从 index.ts 拆出：那里只留 name / inject / apply 三件事，路由与文件监听放在这里。
 * 静态资源一律走 immutable 缓存；入参来自 URL 的部分都经 trusted() 与包目录包含判断守卫。
 */
export function registerWorkbenchRoutes(ctx: HostContext): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/dsh-vscode/codicons/codicon.ttf', handler: async (req, res) => {
      if (!trusted(req, ctx.webRuntime.trustedHosts)) { res.writeHead(403); res.end(); return }
      try {
        const asset = codiconAsset()
        res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'public, max-age=31536000, immutable' })
        res.end(await readFile(asset.path))
      } catch (error) { sendError(res, error) }
    },
  }), 'dsh-vscode-workbench: Codicon font')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/dsh-vscode/pdfjs/worker.mjs', handler: async (req, res) => {
      if (!trusted(req, ctx.webRuntime.trustedHosts)) { res.writeHead(403); res.end(); return }
      try {
        const asset = pdfWorkerAsset()
        res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'public, max-age=31536000, immutable' })
        res.end(await readFile(asset.path))
      } catch (error) { sendError(res, error) }
    },
  }), 'dsh-vscode-workbench: PDF.js worker')

  // TextMate 语法按需提供：全部语法约 2.5MB，留在宿主侧就不会进客户端 bundle。
  // 客户端只在真正需要某种语言时取一次，之后由 immutable 缓存接管。
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/dsh-vscode/grammar', handler: async (req, res) => {
      if (!trusted(req, ctx.webRuntime.trustedHosts)) { res.writeHead(403); res.end(); return }
      try {
        const name = new URL(req.url ?? '/', 'http://dsh.local').pathname.slice('/dsh-vscode/grammar/'.length)
        // 先把数据取好再写 header：一旦 writeHead 发出，后面的异常就无法再用 sendError
        // 正常响应了（二次 writeHead 会 ERR_HTTP_HEADERS_SENT，客户端只看到连接中断）。
        const grammar = JSON.stringify(await readGrammar(name))
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' })
        res.end(grammar)
      } catch (error) { sendError(res, error) }
    },
  }), 'dsh-vscode-workbench: TextMate grammars')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/dsh-vscode/api', handler: async (req, res) => {
      if (!trusted(req, ctx.webRuntime.trustedHosts)) return send(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: { code: 'method', message: 'POST required' } })
      try {
        const controller = new AbortController()
        req.once('aborted', () => controller.abort())
        const path = new URL(req.url ?? '/', 'http://dsh.local').pathname
        const method = path.slice('/dsh-vscode/api/'.length)
        send(res, 200, { ok: true, value: await dispatch(ctx, method, await readBody(req), controller.signal) })
      } catch (error) { sendError(res, error) }
    },
  }), 'dsh-vscode-workbench: API')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/dsh-vscode/upload', handler: async (req, res) => {
      if (!trusted(req, ctx.webRuntime.trustedHosts)) return send(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: { code: 'method', message: 'POST required' } })
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.local')
        const sessionId = url.searchParams.get('sessionId'); const directory = url.searchParams.get('directory'); const name = url.searchParams.get('name')
        if (sessionId === null || directory === null || name === null) throw new WorkbenchError('bad-request', 'sessionId, directory and name are required')
        send(res, 201, { ok: true, value: await uploadFile(cwdFor(ctx, sessionId), directory, name, await readBinaryBody(req)) })
      } catch (error) { sendError(res, error) }
    },
  }), 'dsh-vscode-workbench: file upload')

  ctx.effect(() => ctx.webServer.register({
    kind:'prefix',path:'/dsh-vscode/file',handler:async(req,res)=>{if(!trusted(req,ctx.webRuntime.trustedHosts)){res.writeHead(403);res.end();return}try{const url=new URL(req.url??'/','http://dsh.local');const sessionId=url.searchParams.get('sessionId');const path=url.searchParams.get('path');if(sessionId===null||path===null)throw new WorkbenchError('bad-request','sessionId and path are required');const asset=await workspacePreviewFile(cwdFor(ctx,sessionId),path);res.writeHead(200,{'content-type':asset.type,'x-content-type-options':'nosniff','cache-control':'no-store'});res.end(await readFile(asset.path))}catch(error){sendError(res,error)}}
  }), 'dsh-vscode-workbench: file preview')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/dsh-vscode/monaco', handler: async (req, res) => {
      if (!trusted(req, ctx.webRuntime.trustedHosts)) { res.writeHead(403); res.end(); return }
      try {
        const raw = decodeURIComponent(new URL(req.url ?? '/', 'http://dsh.local').pathname.slice('/dsh-vscode/monaco/'.length))
        const asset = monacoAsset(raw)
        res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'public, max-age=31536000, immutable' })
        res.end(await readFile(asset.path))
      } catch (error) { sendError(res, error) }
    },
  }), 'dsh-vscode-workbench: Monaco assets')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/dsh-vscode/katex', handler: async (req, res) => {
      if (!trusted(req, ctx.webRuntime.trustedHosts)) { res.writeHead(403); res.end(); return }
      try {
        const raw = decodeURIComponent(new URL(req.url ?? '/', 'http://dsh.local').pathname.slice('/dsh-vscode/katex/'.length))
        const asset = katexAsset(raw)
        res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'public, max-age=31536000, immutable' })
        res.end(await readFile(asset.path))
      } catch (error) { sendError(res, error) }
    },
  }), 'dsh-vscode-workbench: KaTeX assets')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/dsh-vscode/file-icons', handler: async (req, res) => {
      if (!trusted(req, ctx.webRuntime.trustedHosts)) { res.writeHead(403); res.end(); return }
      try {
        const raw = decodeURIComponent(new URL(req.url ?? '/', 'http://dsh.local').pathname.slice('/dsh-vscode/file-icons/'.length))
        const asset = fileIconAsset(raw)
        res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'public, max-age=31536000, immutable' })
        res.end(await readFile(asset.path))
      } catch (error) { sendError(res, error) }
    },
  }), 'dsh-vscode-workbench: file type icons')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/dsh-vscode/onig', handler: async (req, res) => {
      if (!trusted(req, ctx.webRuntime.trustedHosts)) { res.writeHead(403); res.end(); return }
      try {
        const asset = onigWasmAsset()
        res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'public, max-age=31536000, immutable' })
        res.end(await readFile(asset.path))
      } catch (error) { sendError(res, error) }
    },
  }), 'dsh-vscode-workbench: oniguruma wasm')

  const wss = new WebSocketServer({ noServer: true })
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/dsh-vscode/ws/files', handler(req, socket, head) {
      if (!trusted(req as IncomingMessage, ctx.webRuntime.trustedHosts)) { socket.destroy(); return }
      wss.handleUpgrade(req as IncomingMessage, socket as Duplex, head, (ws) => {
        const sessionId = new URL(req.url ?? '/', 'http://dsh.local').searchParams.get('sessionId')
        if (sessionId === null) { ws.close(1008, 'sessionId required'); return }
        const workspace = cwdFor(ctx, sessionId)
        const watcher = chokidar.watch(workspace, { ignoreInitial: true, ignored: /(^|[/\\])(\.git|node_modules|\.next|\.nuxt|\.turbo|\.vite|coverage)([/\\]|$)/, awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 } })
        let paths = new Set<string>(); let timer: ReturnType<typeof setTimeout> | undefined
        watcher.on('all', (_event, path) => {
          const changed = isAbsolute(path) ? relative(workspace, path) : path
          paths.add(changed.split(sep).join('/')); clearTimeout(timer); timer = setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'files.changed', paths: [...paths] }))
            paths = new Set()
          }, 150)
        })
        ws.on('close', () => { clearTimeout(timer); void watcher.close() })
      })
    },
  }), 'dsh-vscode-workbench: file watcher')
  ctx.effect(() => () => { wss.close() }, 'dsh-vscode-workbench: watcher teardown')
}
