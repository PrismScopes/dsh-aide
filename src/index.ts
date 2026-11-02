/** DSH host plugin for the VS Code workbench. */
import type { HostContext } from './context.ts'
import { registerWorkbenchRoutes } from './routes.ts'
import { installTerminal } from './terminal.ts'
import { setLanguageSettings } from './language/settings.ts'

export { WorkbenchError } from './wire.ts'

/** 从 cordis 的 entry 选项里取本插件的配置；形状不认识就返回 undefined。 */
function entryConfig(ctx: HostContext): unknown {
  const entry = (ctx as unknown as { fiber?: { entry?: { options?: { config?: unknown } } } }).fiber?.entry?.options
  return entry?.config
}
export * from './types.ts'

export const name = 'dsh-aide'
export const inject = ['webServer', 'sessions', 'connection', 'workingDirectory']

/**
 * 插件入口。
 *
 * 只做两件事：装终端、注册路由。方法分发在 api.ts，路由与文件监听在 routes.ts ——
 * 原先三者都挤在本文件里（177 行），拆开后入口只剩接线，改路由不必再翻一整个文件。
 *
 * 第二个参数是插件配置（profile 里那一行的 config，或应用里的插件设置）：语言服务的覆盖
 * 从这里读；补全只使用 DSH 当前的默认模型，没有路由与兜底配置。
 */
export function apply(ctx: HostContext, config?: unknown): void {
  setLanguageSettings(config ?? entryConfig(ctx))
  installTerminal(ctx)
  registerWorkbenchRoutes(ctx)
}
