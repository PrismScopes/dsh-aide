/**
 * 宿主侧语言服务的「按工作区路由」。
 *
 * 一个 DSH 进程里可能有多个会话、多个工作区；每个工作区一份 LanguageManager（各自的项目程序、
 * 各自的外部服务器进程）。WebSocket 连接按工作区归组，诊断/状态推送只发给同一个工作区的客户端。
 *
 * 这个模块同时是设置页的服务器发现入口：设置页没有会话，不能走「解析工作区」那条路。
 */
import { resolve } from 'node:path'
import { discoverServers, type DetectedServer, type ExternalServerDefinition } from './servers.ts'
import { LanguageManager } from './manager.ts'
import { configuredLanguageServers, languageSettingsView } from './settings.ts'
import type { LanguagePushMessage, LanguageServerInfo, LanguageSettingsView } from './protocol.ts'

/** 客户端 WebSocket 的最小结构面（ws 的 WebSocket 满足它；测试可以传假对象）。 */
export interface LanguageSocket {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
}

interface WorkspaceEntry {
  manager: LanguageManager
  clients: Set<LanguageSocket>
}

function workspaceKey(workspace: string): string {
  const absolute = resolve(workspace)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** 把发现结果摊平成设置页/状态栏用的服务器列表。 */
function serverInfos(discovered: { available: DetectedServer[]; missing: ExternalServerDefinition[] }): LanguageServerInfo[] {
  const infos: LanguageServerInfo[] = []
  for (const server of discovered.available) {
    infos.push({ id: server.id, name: server.name, languages: server.languages, state: 'idle', command: [server.executable, ...server.args].join(' ') })
  }
  for (const server of discovered.missing) {
    infos.push({ id: server.id, name: server.name, languages: server.languages, state: 'missing', detail: '未找到可执行文件', command: server.command })
  }
  return infos
}

export class LanguageHost {
  private readonly entries = new Map<string, WorkspaceEntry>()
  private disposed = false

  constructor(private readonly env: Record<string, string | undefined> = globalThis.process?.env ?? {}) {}

  /** 取（或创建）某工作区的管理器。 */
  managerFor(workspace: string): LanguageManager {
    const key = workspaceKey(workspace)
    const existing = this.entries.get(key)
    if (existing !== undefined) return existing.manager
    const entry: WorkspaceEntry = { manager: undefined as unknown as LanguageManager, clients: new Set() }
    const manager = new LanguageManager({
      workspace,
      emit: (message: LanguagePushMessage) => {
        const data = JSON.stringify(message)
        for (const client of entry.clients) {
          // 1 = WebSocket.OPEN；常量不 import 'ws'，避免测试与浏览器侧误引。
          if (client.readyState === 1) {
            try { client.send(data) } catch { /* 连接刚断开：忽略这一条 */ }
          }
        }
      },
      env: this.env,
    })
    entry.manager = manager
    this.entries.set(key, entry)
    return manager
  }

  /** 工作台语言 WebSocket 接入；立刻回一次状态，客户端不用额外轮询。 */
  attach(workspace: string, client: LanguageSocket): void {
    const manager = this.managerFor(workspace)
    const entry = this.entries.get(workspaceKey(workspace))
    if (entry === undefined) return
    entry.clients.add(client)
    void manager.info().then(info => {
      if (client.readyState !== 1) return
      const message: LanguagePushMessage = { type: 'status', servers: info.servers, builtin: info.builtin, ...(info.scan === undefined ? {} : { scan: info.scan }) }
      try { client.send(JSON.stringify(message)) } catch { /* 已断开 */ }
    }).catch(() => {})
  }

  detach(workspace: string, client: LanguageSocket): void {
    this.entries.get(workspaceKey(workspace))?.clients.delete(client)
  }

  /** 设置页用：已发现/未安装的服务器（不依赖工作区）。 */
  servers(env: Record<string, string | undefined> = this.env): readonly LanguageServerInfo[] {
    try {
      return serverInfos(discoverServers(env, { language: { servers: configuredLanguageServers() } }))
    } catch {
      return []
    }
  }

  /** 设置页用：语言服务设置 + 服务器发现结果。 */
  settingsView(env: Record<string, string | undefined> = this.env): LanguageSettingsView {
    return languageSettingsView(env, this.servers(env))
  }

  /** 设置改变后重建全部工作区记录：关掉旧服务器，客户端重连后拿到新的能力集合。 */
  reset(): void {
    for (const entry of this.entries.values()) {
      entry.manager.dispose()
      for (const client of entry.clients) {
        try { client.close(1012, 'language settings changed') } catch { /* 已断开 */ }
      }
    }
    this.entries.clear()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.reset()
  }
}

const hosts = new WeakMap<object, LanguageHost>()

/** 每个插件应用一份（ctx 的弱引用键）；避免把状态挂到全局单例上导致测试之间串。 */
export function languageHostFor(owner: object): LanguageHost {
  const existing = hosts.get(owner)
  if (existing !== undefined) return existing
  const host = new LanguageHost()
  hosts.set(owner, host)
  return host
}
