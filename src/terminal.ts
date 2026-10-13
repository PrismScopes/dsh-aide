import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { basename, delimiter, dirname, join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { WebSocket, WebSocketServer } from 'ws'
import type { HostContext } from './context.ts'
import { cwdFor } from './host.ts'
import { readBody, send, sendError } from './wire.ts'

export interface TerminalInfo { id: string; title: string; cwd: string; running: boolean; exitCode?: number; sequence: number }
export interface TerminalOutput { sequence: number; data: string }

interface TerminalHandle { info: TerminalInfo; process: IPty; replay: string; listeners: Set<(output: TerminalOutput) => void> }
const SENSITIVE = /(api[_-]?key|token|credential|secret|password|passwd|private[_-]?key|^dsh_.*(?:key|token|secret))/i
const MAX_TERMINALS = 8
const REPLAY_BYTES = 2 * 1024 * 1024

/** Remove credentials while retaining ordinary interactive-shell variables. */
export function sanitizedTerminalEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && !SENSITIVE.test(key)) as Array<[string, string]>)
}

/**
 * 选择用户的交互式 shell。
 *
 * Windows 上用 COMSPEC —— 也就是用户自己的命令解释器 —— 原样启动，不替换成别的、也不加
 * 抑制启动横幅的参数。原先的写法是「COMSPEC 指向 powershell 就用它，否则一律 powershell.exe
 * 加 -NoLogo」：当用户的 COMSPEC 是 cmd.exe 时，它会被悄悄换成 PowerShell，于是终端里看到的
 * 是 PS 提示符，用户熟悉的 cmd 横幅（Microsoft Windows [版本 …]）永远不会出现。终端应当呈现
 * 用户自己的环境。
 */
export function defaultTerminalShell(platform = process.platform, env = process.env): { shell: string; args: string[] } {
  if (platform === 'win32') {
    const comspec = env.COMSPEC?.trim()
    return { shell: comspec !== undefined && comspec !== '' ? comspec : 'powershell.exe', args: [] }
  }
  return { shell: env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash'), args: ['-l'] }
}

/** 一个可选 shell 的对外描述。不含本机路径 —— 客户端不需要，也不该拿到。 */
export interface TerminalProfile { id: string; label: string }

/** 探测文件与 PATH 的能力。抽成接口是为了让测试能给定确定的文件系统。 */
export interface ProfileProbe {
  exists(path: string): boolean
  which(file: string): string | undefined
}

/** probe 的真实实现：读 PATH、查文件系统。 */
export function systemProbe(env: NodeJS.ProcessEnv = process.env): ProfileProbe {
  const path = env.PATH ?? ''
  return {
    exists: candidate => existsSync(candidate),
    which: file => {
      for (const directory of path.split(delimiter)) {
        if (directory === '') continue
        const candidate = join(directory, file)
        if (existsSync(candidate)) return candidate
      }
      return undefined
    },
  }
}

interface ResolvedProfile extends TerminalProfile { shell: string; args: string[] }

/**
 * 探测本机可用的交互式 shell。
 *
 * 只认这几个已知名字，**不接受客户端传来的任意路径**：客户端给的是 profile id，
 * 由宿主在自己的探测结果里查，查不到就报错。否则这个接口就成了「按调用者的意思启动任意程序」。
 *
 * Git Bash 的定位方式：从 `git.exe` 回推安装目录（PATH 上的 git 通常位于 `<root>\cmd\git.exe`，
 * 与 `<root>\bin\bash.exe` 同级），比硬编码 `C:\Program Files\Git` 稳 —— 便携安装不在那里。
 */
function resolvedTerminalProfiles(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, probe: ProfileProbe): ResolvedProfile[] {
  if (platform !== 'win32') {
    const shell = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    return [{ id: 'default', label: basename(shell), shell, args: ['-l'] }]
  }
  const profiles: ResolvedProfile[] = []
  const pwsh = probe.which('pwsh.exe')
  if (pwsh !== undefined) profiles.push({ id: 'pwsh', label: 'PowerShell', shell: pwsh, args: [] })
  const powershell = probe.which('powershell.exe')
  if (powershell !== undefined) profiles.push({ id: 'windows-powershell', label: 'Windows PowerShell', shell: powershell, args: [] })
  const git = probe.which('git.exe')
  if (git !== undefined) {
    const root = dirname(dirname(git))
    const bash = [join(root, 'bin', 'bash.exe'), join(root, 'usr', 'bin', 'bash.exe')].find(candidate => probe.exists(candidate))
    if (bash !== undefined) profiles.push({ id: 'git-bash', label: 'Git Bash', shell: bash, args: ['--login', '-i'] })
  }
  const comspec = env.COMSPEC?.trim()
  if (comspec !== undefined && comspec !== '') profiles.push({ id: 'cmd', label: 'Command Prompt', shell: comspec, args: [] })
  const systemRoot = env.SystemRoot?.trim() || env.windir?.trim()
  if (systemRoot !== undefined && systemRoot !== '') {
    const wsl = join(systemRoot, 'System32', 'bash.exe')
    if (probe.exists(wsl)) profiles.push({ id: 'wsl', label: 'WSL', shell: wsl, args: [] })
  }
  return profiles
}

/** 供客户端渲染「新建终端」菜单的列表。 */
export function terminalProfiles(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, probe: ProfileProbe = systemProbe(env)): TerminalProfile[] {
  return resolvedTerminalProfiles(platform, env, probe).map(({ id, label }) => ({ id, label }))
}

/** 按 profile id 解析出要启动的 shell；id 缺失时用平台默认（COMSPEC / SHELL）。 */
export function terminalShell(profileId?: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, probe: ProfileProbe = systemProbe(env)): { shell: string; args: string[] } {
  if (profileId === undefined || profileId === '') return defaultTerminalShell(platform, env)
  const profile = resolvedTerminalProfiles(platform, env, probe).find(candidate => candidate.id === profileId)
  if (profile === undefined) throw new Error(`unknown terminal profile: ${profileId}`)
  return { shell: profile.shell, args: profile.args }
}

/** Own interactive terminals by their canonical workspace directory. */
export class TerminalManager {
  private readonly workspaces = new Map<string, Map<string, TerminalHandle>>()

  private workspace(cwd: string): string { return realpathSync(cwd) }

  list(cwd: string): TerminalInfo[] { return [...(this.workspaces.get(this.workspace(cwd))?.values() ?? [])].map(handle => ({ ...handle.info })) }

  create(cwd: string, title?: string, profileId?: string): TerminalInfo {
    const key = this.workspace(cwd)
    const terminals = this.workspaces.get(key) ?? new Map<string, TerminalHandle>()
    this.workspaces.set(key, terminals)
    if (terminals.size >= MAX_TERMINALS) throw new Error(`terminal limit reached (${MAX_TERMINALS})`)
    const { shell, args } = terminalShell(profileId)
    const child = pty.spawn(shell, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd: key, env: sanitizedTerminalEnv(process.env) })
    const info: TerminalInfo = { id: randomUUID(), title: title || basename(shell), cwd: key, running: true, sequence: 0 }
    const handle: TerminalHandle = { info, process: child, replay: '', listeners: new Set() }
    terminals.set(info.id, handle)
    child.onData(data => {
      info.sequence++
      handle.replay += data
      if (Buffer.byteLength(handle.replay) > REPLAY_BYTES) handle.replay = handle.replay.slice(-REPLAY_BYTES)
      for (const listener of handle.listeners) listener({ sequence: info.sequence, data })
    })
    child.onExit(({ exitCode }) => {
      info.running = false
      info.exitCode = exitCode
      info.sequence++
      const data = `\r\n[process exited with code ${exitCode}]\r\n`
      for (const listener of handle.listeners) listener({ sequence: info.sequence, data })
    })
    return { ...info }
  }

  get(cwd: string, id: string): TerminalHandle | undefined { return this.workspaces.get(this.workspace(cwd))?.get(id) }

  close(cwd: string, id: string): void {
    const key = this.workspace(cwd)
    const terminals = this.workspaces.get(key)
    const handle = terminals?.get(id)
    if (handle === undefined || terminals === undefined) return
    terminals.delete(id)
    try { handle.process.kill() } catch { /* The shell may already have exited. */ }
    if (terminals.size === 0) this.workspaces.delete(key)
  }

  rename(cwd: string, id: string, title: string): TerminalInfo {
    const handle = this.get(cwd, id)
    if (handle === undefined) throw new Error('terminal not found')
    handle.info.title = title
    return { ...handle.info }
  }

  dispose(): void { for (const [cwd, terminals] of this.workspaces) for (const id of terminals.keys()) this.close(cwd, id) }
}

function terminalRequestAllowed(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined || req.headers['sec-fetch-site'] === 'cross-site') return false
  let hostname: string
  try { hostname = new URL(`http://${host}`).hostname } catch { return false }
  if (hostname !== 'localhost' && hostname !== '[::1]' && !hostname.startsWith('127.')) return false
  const origin = req.headers.origin
  try { return origin === undefined || new URL(origin).host === host } catch { return false }
}

/**
 * 本机地址，供客户端拼 WebSocket 用。
 *
 * 为什么需要它：桌面端(Electron)的页面跑在 `dsh-app://app/` 下，`location.host` 是 `app`，
 * 客户端按它拼出来的 `ws://app/…` 根本无法连接（实测 close code 1006）。桌面端把 HTTP 请求
 * 经自定义协议转发给宿主，但 **WebSocket 的 upgrade 不经过那条转发**，所以必须给客户端一个
 * 宿主的绝对地址。
 *
 * **只用 `req.socket.localPort`** —— 它回答的是「这个请求打到了哪个端口」，是第一手事实。
 *
 * 明确不用 `DSH_WEB_URL`：它由 DSH 的 web-app 注册在 shellEnv 上，描述的是 **shell 命令所在
 * 那个 Harness 实例**的地址，未必是当前宿主。实测代价很直观 —— 在桌面端内启动的 Web 测试实例
 * 会继承 `DSH_WEB_URL=http://127.0.0.1:19387`，于是 Web 端的终端跑去连桌面端的端口，连接失败
 * （close 1006）、终端空白。两个来源在这种情况下会给出互相矛盾的答案，而 localPort 是对的。
 *
 * 只输出回环地址：客户端就在本机，没有理由把对外地址交出去。
 */
export function localBase(req: IncomingMessage): string | undefined {
  const port = req.socket.localPort
  if (typeof port !== 'number' || port <= 0) return undefined
  const host = req.socket.localAddress === '::1' ? '[::1]' : '127.0.0.1'
  return `http://${host}:${port}`
}

/** Register the private local terminal API and WebSocket transport. */
export function installTerminal(ctx: HostContext): void {
  const manager = new TerminalManager()
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-vscode-terminal/api', handler: async (req, res) => {
    if (!terminalRequestAllowed(req)) return send(res, 403, { ok: false, error: { message: 'forbidden' } })
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: { message: 'POST required' } })
    try {
      const body = await readBody(req)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (sessionId === '') throw new Error('sessionId required')
      const cwd = cwdFor(ctx, sessionId)
      const method = new URL(req.url ?? '/', 'http://dsh.local').pathname.slice('/dsh-vscode-terminal/api/'.length)
      let value: unknown
      if (method === 'list') value = manager.list(cwd)
      else if (method === 'profiles') value = terminalProfiles()
      else if (method === 'create') value = manager.create(cwd, typeof body.title === 'string' ? body.title : undefined, typeof body.profile === 'string' ? body.profile : undefined)
      else if (method === 'close') { manager.close(cwd, typeof body.id === 'string' ? body.id : ''); value = manager.list(cwd) }
      else if (method === 'rename') value = manager.rename(cwd, typeof body.id === 'string' ? body.id : '', typeof body.title === 'string' ? body.title : '')
      else throw new Error('unknown terminal method')
      // 把本机地址一并带上，供客户端拼 WebSocket 用（桌面端按 location.host 拼不出可连的地址）。
      send(res, 200, { ok: true, value, wsBase: localBase(req) })
    } catch (error) { sendError(res, error) }
  } }), 'dsh-vscode-workbench: terminal API')

  const webSocket = new WebSocketServer({ noServer: true })
  ctx.effect(() => ctx.webServer.registerUpgrade({ path: '/dsh-vscode-terminal/ws', handler(req, socket, head) {
    if (!terminalRequestAllowed(req as IncomingMessage)) { socket.destroy(); return }
    webSocket.handleUpgrade(req as IncomingMessage, socket as Duplex, head, connection => {
      const url = new URL(req.url ?? '/', 'http://dsh.local')
      const sessionId = url.searchParams.get('sessionId')
      const id = url.searchParams.get('id')
      if (sessionId === null || id === null) { connection.close(1008, 'sessionId and id required'); return }
      const handle = manager.get(cwdFor(ctx, sessionId), id)
      if (handle === undefined) { connection.close(1008, 'terminal not found'); return }
      if (handle.replay !== '') connection.send(JSON.stringify({ type: 'replay', sequence: handle.info.sequence, data: handle.replay }))
      const listener = (output: TerminalOutput) => { if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: 'output', ...output })) }
      handle.listeners.add(listener)
      connection.on('message', raw => {
        const text = raw.toString()
        try {
          const message: unknown = JSON.parse(text)
          if (message !== null && typeof message === 'object' && 'type' in message && message.type === 'input' && 'data' in message && typeof message.data === 'string') handle.process.write(message.data)
          else if (message !== null && typeof message === 'object' && 'type' in message && message.type === 'resize' && 'cols' in message && 'rows' in message && typeof message.cols === 'number' && typeof message.rows === 'number') handle.process.resize(Math.max(2, Math.floor(message.cols)), Math.max(2, Math.floor(message.rows)))
        } catch { handle.process.write(text) }
      })
      connection.on('close', () => handle.listeners.delete(listener))
    })
  } }), 'dsh-vscode-workbench: terminal WebSocket')
  ctx.effect(() => () => { webSocket.close(); manager.dispose() }, 'dsh-vscode-workbench: terminal teardown')
}
