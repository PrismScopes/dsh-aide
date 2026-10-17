import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'

export interface WorkbenchWebServer {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }): () => void
  registerUpgrade(route: { path: string; handler(req: IncomingMessage, socket: Duplex, head: Buffer): void | Promise<void> }): () => void
}
/** DSH 0.2.1 起会话的工作目录由 workingDirectory 服务统一解析，header.cwd 不再是权威来源。 */
export interface WorkbenchSessions { get(id: string): Session | undefined }
/** DSH 0.2.1 起连接认证由 connection 服务负责（含部署感知的 Host/Origin 防线）。 */
export interface WorkbenchConnection { requestRejection(req: IncomingMessage): 401 | 403 | undefined }
export type HostContext = CordisContext & {
  webServer: WorkbenchWebServer
  sessions: WorkbenchSessions
  connection: WorkbenchConnection
  workingDirectory: { get(session: Session): string }
  effect(callback: () => void | (() => void), label?: string): void
}
