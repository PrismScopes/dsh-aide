/** DSH host plugin for the VS Code workbench. */
import type { HostContext } from './context.ts'
import { registerWorkbenchRoutes } from './routes.ts'
import { installTerminal } from './terminal.ts'

export { WorkbenchError } from './wire.ts'
export * from './types.ts'

export const name = 'dsh-vscode-workbench'
export const inject = ['webServer', 'sessions', 'webRuntime']

/**
 * 插件入口。
 *
 * 只做两件事：装终端、注册路由。方法分发在 api.ts，路由与文件监听在 routes.ts ——
 * 原先三者都挤在本文件里（177 行），拆开后入口只剩接线，改路由不必再翻一整个文件。
 */
export function apply(ctx: HostContext): void {
  installTerminal(ctx)
  registerWorkbenchRoutes(ctx)
}
