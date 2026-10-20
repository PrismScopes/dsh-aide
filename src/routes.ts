import { readFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { isAbsolute, relative, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { createWorkspaceWatcher, type WatchHandle } from './watch.ts'
import { WebSocket, WebSocketServer } from 'ws'
import type { HostContext } from './context.ts'
import { codiconAsset, cwdFor, fileIconAsset, katexAsset, monacoAsset, onigWasmAsset, pdfWorkerAsset, uploadFile, workspacePreviewFile } from './host.ts'
import { readGrammar } from './assets.ts'
import { authorize, readBinaryBody, readBody, send, sendError, WorkbenchError } from './wire.ts'
import { localBase } from './terminal.ts'
import { dispatch } from './api.ts'
import { completionTelemetry, registerCompletionRoute, resolveProvider } from './completion/register.ts'
import { completionSettingsView, SettingsWriteError, updateCompletionSettings, type CompletionSettingsPatch } from './completion/settings.ts'

/**
 * 宿主侧的全部 HTTP / WebSocket 路由。
 *
 * 从 index.ts 拆出：那里只留 name / inject / apply 三件事，路由与文件监听放在这里。
 * 静态资源一律走 immutable 缓存；入参来自 URL 的部分都经 authorize() 与包目录包含判断守卫。
 */
/**
 * 按工作区共享的文件监听。
 *
 * 原先每条 ws/files 连接都自己建一次监听。实测这个工作区（仓库根）约 1.8 万个非
 * node_modules 文件，遍历式建监听要 3.4 秒，而工作台每次打开、每次重连都要付一遍；
 * 这段时间里宿主是共用的，终端的响应也会被一起拖住（实测宿主 API 往返延迟从 2ms 冲到 146ms）。
 *
 * 现在同一工作区共用一个监听，最后一个使用者离开后再等一小段时间才关，避免「关掉又马上打开」
 * 时白重建一次。
 */
export class WorkspaceWatch {
  private readonly entries = new Map<string, { watcher: WatchHandle; users: number; closing: ReturnType<typeof setTimeout> | undefined }>()

  constructor(private readonly create: (workspace: string) => WatchHandle, private readonly graceMs = 5000) {}

  acquire(workspace: string): WatchHandle {
    const existing = this.entries.get(workspace)
    if (existing !== undefined) {
      clearTimeout(existing.closing)
      existing.closing = undefined
      existing.users++
      return existing.watcher
    }
    const watcher = this.create(workspace)
    this.entries.set(workspace, { watcher, users: 1, closing: undefined })
    return watcher
  }

  release(workspace: string): void {
    const entry = this.entries.get(workspace)
    if (entry === undefined) return
    entry.users--
    if (entry.users > 0) return
    entry.closing = setTimeout(() => {
      entry.closing = undefined
      if (entry.users > 0) return
      this.entries.delete(workspace)
      void entry.watcher.close()
    }, this.graceMs)
  }

  closeAll(): void {
    for (const [workspace, entry] of [...this.entries]) {
      clearTimeout(entry.closing)
      this.entries.delete(workspace)
      void entry.watcher.close()
    }
  }

  /** 仅供测试观察当前持有几个监听。 */
  size(): number { return this.entries.size }
}

/**
 * 设置页要显示的全部状态。
 *
 * 除设置本身，还带上「当前实际在用哪个模型」和「最近一次补全失败原因」：排查「没有补全」时
 * 这两条决定下一步该看哪里 —— 是路由配错了，还是模型调用本身失败。来源解析与补全请求走同一套
 * resolveProvider，所以这里显示的就是请求真正会用的那条路。
 */
function settingsPayload(ctx: HostContext): unknown {
  const resolved = resolveProvider(ctx)
  return {
    completion: {
      ...completionSettingsView(),
      effective: { source: resolved.source, model: resolved.model },
      lastFailure: completionTelemetry.failure() ?? null,
    },
  }
}

export function registerWorkbenchRoutes(ctx: HostContext): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/dsh-vscode/codicons/codicon.ttf', handler: async (req, res) => {
      if (!authorize(req, res, ctx.connection)) return
      try {
        const asset = codiconAsset()
        res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'public, max-age=31536000, immutable' })
        res.end(await readFile(asset.path))
      } catch (error) { sendError(res, error) }
    },
  }), 'dsh-vscode-workbench: Codicon font')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/dsh-vscode/pdfjs/worker.mjs', handler: async (req, res) => {
      if (!authorize(req, res, ctx.connection)) return
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
      if (!authorize(req, res, ctx.connection)) return
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
      if (!authorize(req, res, ctx.connection)) return

      if (req.method !== 'POST') return send(res, 405, { ok: false, error: { code: 'method', message: 'POST required' } })
      try {
        const controller = new AbortController()
        req.once('aborted', () => controller.abort())
        const path = new URL(req.url ?? '/', 'http://dsh.local').pathname
        const method = path.slice('/dsh-vscode/api/'.length)
        // 顺带带上宿主本机地址：桌面端的页面在 dsh-app://app/ 下，location.host 是 app，
        // 客户端拼不出可连的 WebSocket 地址（文件变更监听就依赖它）。
        send(res, 200, { ok: true, value: await dispatch(ctx, method, await readBody(req), controller.signal), wsBase: localBase(req) })
      } catch (error) { sendError(res, error) }
    },
  }), 'dsh-vscode-workbench: API')

  // 补全走独立的 SSE 端点：它要边算边发，与 /api 的一问一答不同。
  registerCompletionRoute(ctx, { authorize: (req, res) => authorize(req, res, ctx.connection), readBody, send, sendError, cwdFor: sessionId => cwdFor(ctx, sessionId) })

  // 设置页的读写端点。
  // 为什么单独一条、而不是并进 /api：/api 的每个方法都要先解析会话工作目录（dispatch 里第一行），
  // 而设置页在「还没选会话」时也要能用 —— 那时 /api 一律 409。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/dsh-vscode/settings', handler: async (req, res) => {
      if (!authorize(req, res, ctx.connection)) return
      try {
        if (req.method === 'GET') return send(res, 200, { ok: true, value: settingsPayload(ctx) })
        if (req.method !== 'POST') return send(res, 405, { ok: false, error: { code: 'method', message: 'GET or POST required' } })
        const body = await readBody(req)
        const patch: CompletionSettingsPatch = {}
        if ('route' in body) {
          if (body['route'] !== null && typeof body['route'] !== 'string') throw new WorkbenchError('invalid-argument', 'route must be a string or null')
          patch.route = body['route'] as string | null
        }
        if ('fallback' in body) {
          if (typeof body['fallback'] !== 'boolean') throw new WorkbenchError('invalid-argument', 'fallback must be a boolean')
          patch.fallback = body['fallback']
        }
        updateCompletionSettings(patch)
        send(res, 200, { ok: true, value: settingsPayload(ctx) })
      } catch (error) {
        // 路由格式写错、数据目录不可写：这两类要给出可读的提示，而不是一句 internal。
        if (error instanceof SettingsWriteError) send(res, 400, { ok: false, error: { code: 'settings-write', message: error.message } })
        else sendError(res, error)
      }
    },
  }), 'dsh-vscode-workbench: settings')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/dsh-vscode/upload', handler: async (req, res) => {
      if (!authorize(req, res, ctx.connection)) return

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
    kind:'prefix',path:'/dsh-vscode/file',handler:async(req,res)=>{if(!authorize(req,res,ctx.connection))return;try{const url=new URL(req.url??'/','http://dsh.local');const sessionId=url.searchParams.get('sessionId');const path=url.searchParams.get('path');if(sessionId===null||path===null)throw new WorkbenchError('bad-request','sessionId and path are required');const asset=await workspacePreviewFile(cwdFor(ctx,sessionId),path);res.writeHead(200,{'content-type':asset.type,'x-content-type-options':'nosniff','cache-control':'no-store'});res.end(await readFile(asset.path))}catch(error){sendError(res,error)}}
  }), 'dsh-vscode-workbench: file preview')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/dsh-vscode/monaco', handler: async (req, res) => {
      if (!authorize(req, res, ctx.connection)) return
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
      if (!authorize(req, res, ctx.connection)) return
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
      if (!authorize(req, res, ctx.connection)) return
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
      if (!authorize(req, res, ctx.connection)) return
      try {
        const asset = onigWasmAsset()
        res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'public, max-age=31536000, immutable' })
        res.end(await readFile(asset.path))
      } catch (error) { sendError(res, error) }
    },
  }), 'dsh-vscode-workbench: oniguruma wasm')

  const wss = new WebSocketServer({ noServer: true })
  const watches = new WorkspaceWatch(createWorkspaceWatcher)
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/dsh-vscode/ws/files', handler(req, socket, head) {
      if (ctx.connection.requestRejection(req) !== undefined) { socket.destroy(); return }
      wss.handleUpgrade(req as IncomingMessage, socket as Duplex, head, (ws) => {
        const sessionId = new URL(req.url ?? '/', 'http://dsh.local').searchParams.get('sessionId')
        if (sessionId === null) { ws.close(1008, 'sessionId required'); return }
        // 会话可能尚未就绪（工作目录服务尚未给出路径）：关闭连接而不是抛进 upgrade 回调。
        let workspace: string
        try { workspace = cwdFor(ctx, sessionId) }
        catch { ws.close(1008, 'session workspace unavailable'); return }
        const watcher = watches.acquire(workspace)
        let paths = new Set<string>(); let timer: ReturnType<typeof setTimeout> | undefined
        const onAll = (_event: string, path: string): void => {
          const changed = isAbsolute(path) ? relative(workspace, path) : path
          paths.add(changed.split(sep).join('/')); clearTimeout(timer); timer = setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'files.changed', paths: [...paths] }))
            paths = new Set()
          }, 150)
        }
        watcher.on('all', onAll)
        ws.on('close', () => { clearTimeout(timer); watcher.off('all', onAll); watches.release(workspace) })
      })
    },
  }), 'dsh-vscode-workbench: file watcher')
  ctx.effect(() => () => { watches.closeAll(); wss.close() }, 'dsh-vscode-workbench: watcher teardown')
}
