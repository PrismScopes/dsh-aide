/** DSH host plugin for the VS Code workbench. */
import type { HostContext } from './context.ts'
import { registerWorkbenchRoutes } from './routes.ts'
import { installTerminal } from './terminal.ts'
import { setCompletionSettings } from './completion/settings.ts'

export { WorkbenchError } from './wire.ts'

/** 从 cordis 的 entry 选项里取本插件的配置；形状不认识就返回 undefined。 */
function entryConfig(ctx: HostContext): unknown {
  const entry = (ctx as unknown as { fiber?: { entry?: { options?: { config?: unknown } } } }).fiber?.entry?.options
  return entry?.config
}
export * from './types.ts'

export const name = 'dsh-vscode-workbench'
export const inject = ['webServer', 'sessions', 'connection', 'workingDirectory']

/**
 * 插件入口。
 *
 * 只做两件事：装终端、注册路由。方法分发在 api.ts，路由与文件监听在 routes.ts ——
 * 原先三者都挤在本文件里（177 行），拆开后入口只剩接线，改路由不必再翻一整个文件。
 *
 * 第二个参数是插件配置（profile 里那一行的 config，或应用里的插件设置）：补全用哪条模型路由、
 * 模型失败要不要回落本地兜底，都从这里读；环境变量可以覆盖它，便于排查与临时试验。
 */
export function apply(ctx: HostContext, config?: unknown): void {
  // 加载器未必把配置作为第二个参数传进来（实测如此）：再从 cordis 的 entry 选项里取一次。
  // 两处都取不到就按没有配置处理，行为与之前一致。
  setCompletionSettings(config ?? entryConfig(ctx))
  installTerminal(ctx)
  registerWorkbenchRoutes(ctx)
}
