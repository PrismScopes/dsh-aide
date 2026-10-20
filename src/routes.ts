import { readFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { isAbsolute, relative, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { createWorkspaceWatcher, RESCAN_EVENT, type WatchHandle } from './watch.ts'
import { WebSocket, WebSocketServer } from 'ws'
import type { HostContext } from './context.ts'
import { codiconAsset, cwdFor, fileIconAsset, katexAsset, monacoAsset, onigWasmAsset, pdfWorkerAsset, uploadFile, workspacePreviewFile } from './host.ts'
import { readGrammar } from './assets.ts'
import { authorize, readBinaryBody, readBody, send, sendError, WorkbenchError } from './wire.ts'
import { localBase } from './terminal.ts'
import { dispatch } from './api.ts'
import { completionTelemetry, registerCompletionRoute, resolveProvider } from './completion/register.ts'
import { completionSettingsView, SettingsWriteError, updateCompletionSettings, type CompletionSettingsPatch } from './completion/settings.ts'
import { registerModelRoutes } from './modelRoutes.ts'

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

interface ImmutableAssetFile { path: string; type: string }
interface ImmutableAssetJson { json: string }

/** 一条 immutable 静态资源路由的声明（七个资源端点共用同一个 handler 骨架）。 */
interface ImmutableAssetRoute {
  /** ctx.effect 标签；与拆分前逐字一致，便于排查/卸载。 */
  label: string
  kind: 'exact' | 'prefix'
  path: string
  /**
   * prefix 路由从 pathname 取资源名；不提供表示这条路由没有路径参数（codicon/pdfjs/onig）。
   * 需要解码的路由自己在这里 decodeURIComponent —— 语法名历史上不解码，行为保持原样。
   */
  resource?: (pathname: string) => string
  /** 返回要发送的文件描述，或已经序列化好的 JSON 文本。 */
  resolve: (resource: string) => ImmutableAssetFile | ImmutableAssetJson | Promise<ImmutableAssetFile | ImmutableAssetJson>
}

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/**
 * 注册一条静态资源路由。
 *
 * 七个资源 handler 原先各写一遍 authorize → 解析路径 → 取 asset → writeHead → readFile → sendError，
 * 差异只有三处：exact/prefix、是否 decodeURIComponent、文件还是 JSON。这里用参数表达差异；
 * URL、响应头（含字段顺序）、缓存策略与错误路径全部保持不变。
 */
function registerImmutableAssetRoute(ctx: HostContext, route: ImmutableAssetRoute): void {
  ctx.effect(() => ctx.webServer.register({
    kind: route.kind,
    path: route.path,
    handler: async (req, res) => {
      if (!authorize(req, res, ctx.connection)) return
      try {
        // 只有带资源名的 prefix 路由才解析 URL；exact 路由保持原先「不碰 req.url」的行为。
        const resource = route.resource === undefined ? '' : route.resource(new URL(req.url ?? '/', 'http://dsh.local').pathname)
        // 先把内容取好再写 header：writeHead 之后抛错无法再 sendError（二次 writeHead 会中断连接）。
        const asset = await route.resolve(resource)
        if ('json' in asset) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': IMMUTABLE_CACHE_CONTROL })
          res.end(asset.json)
        } else {
          res.writeHead(200, { 'content-type': asset.type, 'cache-control': IMMUTABLE_CACHE_CONTROL })
          res.end(await readFile(asset.path))
        }
      } catch (error) { sendError(res, error) }
    },
  }), route.label)
}

/** files.changed 的聚合窗口；与拆分前的 150ms 一致。 */
export const FILES_CHANGED_FLUSH_MS = 150

/** 推给客户端的文件变更消息；`reload` 只在 watcher 溢出（事件可能丢了）时出现。 */
export interface FilesChangedMessage { type: 'files.changed'; paths: string[]; reload?: true }

export interface FilesChangedBatcher {
  push(event: string, changed: string): void
  dispose(): void
}

/**
 * 工作区文件事件的 150ms 聚合。
 *
 * 普通事件：换算成工作区相对路径（统一 `/`）后同批去重，发送 `{type:'files.changed', paths}`。
 * watcher 溢出（`RESCAN_EVENT`）：置 reload，flush 时发送 `{type:'files.changed', paths, reload:true}`
 * —— 客户端据此整体重扫，而不是只刷新受影响的目录。没有事件时不会发消息，与拆分前一致。
 */
export function createFilesChangedBatcher(workspace: string, send: (message: FilesChangedMessage) => void, delayMs = FILES_CHANGED_FLUSH_MS): FilesChangedBatcher {
  let paths = new Set<string>()
  let reload = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = (): void => {
    timer = undefined
    const message: FilesChangedMessage = { type: 'files.changed', paths: [...paths], ...(reload ? { reload: true as const } : {}) }
    paths = new Set(); reload = false
    send(message)
  }
  const schedule = (): void => { if (timer !== undefined) clearTimeout(timer); timer = setTimeout(flush, delayMs) }
  return {
    push(event, changed) {
      if (event === RESCAN_EVENT) reload = true
      else {
        const normalized = isAbsolute(changed) ? relative(workspace, changed) : changed
        paths.add(normalized.split(sep).join('/'))
      }
      schedule()
    },
    dispose() { if (timer !== undefined) clearTimeout(timer); timer = undefined },
  }
}

export function registerWorkbenchRoutes(ctx: HostContext): void {
  registerImmutableAssetRoute(ctx, { label: 'dsh-vscode-workbench: Codicon font', kind: 'exact', path: '/dsh-vscode/codicons/codicon.ttf', resolve: () => codiconAsset() })
  registerImmutableAssetRoute(ctx, { label: 'dsh-vscode-workbench: PDF.js worker', kind: 'exact', path: '/dsh-vscode/pdfjs/worker.mjs', resolve: () => pdfWorkerAsset() })

  // TextMate 语法按需提供：全部语法约 2.5MB，留在宿主侧就不会进客户端 bundle。
  // 客户端只在真正需要某种语言时取一次，之后由 immutable 缓存接管。
  registerImmutableAssetRoute(ctx, { label: 'dsh-vscode-workbench: TextMate grammars', kind: 'prefix', path: '/dsh-vscode/grammar', resource: pathname => pathname.slice('/dsh-vscode/grammar/'.length), resolve: async name => ({ json: JSON.stringify(await readGrammar(name)) }) })

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

  // 设置页的模型下拉：DSH 当前可用的 provider/model。和 settings 一样不依赖会话，
  // 也不受补全设置影响 —— 它读的是 DSH 自己的模型目录（llm / agentDefaultModel 服务）。
  registerModelRoutes(ctx, { authorize: (req, res) => authorize(req, res, ctx.connection), send, sendError })

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

  registerImmutableAssetRoute(ctx, { label: 'dsh-vscode-workbench: Monaco assets', kind: 'prefix', path: '/dsh-vscode/monaco', resource: pathname => decodeURIComponent(pathname.slice('/dsh-vscode/monaco/'.length)), resolve: monacoAsset })
  registerImmutableAssetRoute(ctx, { label: 'dsh-vscode-workbench: KaTeX assets', kind: 'prefix', path: '/dsh-vscode/katex', resource: pathname => decodeURIComponent(pathname.slice('/dsh-vscode/katex/'.length)), resolve: katexAsset })
  registerImmutableAssetRoute(ctx, { label: 'dsh-vscode-workbench: file type icons', kind: 'prefix', path: '/dsh-vscode/file-icons', resource: pathname => decodeURIComponent(pathname.slice('/dsh-vscode/file-icons/'.length)), resolve: fileIconAsset })
  registerImmutableAssetRoute(ctx, { label: 'dsh-vscode-workbench: oniguruma wasm', kind: 'prefix', path: '/dsh-vscode/onig', resolve: () => onigWasmAsset() })

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
        const batcher = createFilesChangedBatcher(workspace, message => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
        })
        const onAll = (event: string, changed: string): void => { batcher.push(event, changed) }
        watcher.on('all', onAll)
        ws.on('close', () => { batcher.dispose(); watcher.off('all', onAll); watches.release(workspace) })
      })
    },
  }), 'dsh-vscode-workbench: file watcher')
  ctx.effect(() => () => { watches.closeAll(); wss.close() }, 'dsh-vscode-workbench: watcher teardown')
}
