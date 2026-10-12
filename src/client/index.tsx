import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { useEffect } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Icon } from './Icon.tsx'
import type { VscodeWorkbench } from './service.ts'
import { WorkbenchController } from './service.ts'
import { TerminalPanel } from './TerminalPanel.tsx'
import { Workbench } from './Workbench.tsx'
import { installStyles } from './styles.ts'
import { handleTerminalShortcut } from './shortcuts.ts'

export type { BottomPanelContribution, BottomPanelProps, VscodeWorkbench, WorkbenchCommand, WorkbenchSnapshot, WorkbenchView } from './service.ts'

/**
 * 侧栏“全局面板”行的 id，同时用作 main 面板的 key。
 * 两者必须配对注册：layout.selectPanel 会校验 hasMainPanel(id)，缺任一侧点击即抛错。
 */
const PANEL_ID = 'dsh-vscode-workbench'

declare module '@deepseek-ai/cordis' { interface Context { vscodeWorkbench: VscodeWorkbench } }
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotInjectMap { 'dsh-vscode-workbench.overlay': { service: VscodeWorkbench } }
  /**
   * 本插件绑定的 @deepseek-ai 客户端类型停在 0.1.1-rc.2，早于下面两个 slot 的引入：
   * ui-layout 在该版本只声明了 sidebar/conversation/details/shell.overlay，ui-sidebar 只声明了
   * brand/workspaces/settings/footer.action。两者在运行时（0.2.0 起）都存在，这里按运行时形状补齐，
   * 否则注册“全局面板”入口会因 slot 名不在 SlotMap 中而无法通过类型检查。
   */
  interface SlotMap {
    /** 侧栏“全局面板”行：与下方 main 面板配对注册，缺任一侧点击即抛错。 */
    'sidebar.panellist': { kind: 'list'; scope: 'root'; owner: { size: number; active: boolean } }
    /** 主区域面板：entryKey 即 activePanelId。 */
    'main': { kind: 'keyed'; scope: 'root'; keyProps: Record<string, object> }
  }
}

/** layout 服务的最小结构面（不 import 官方类型；旧版缺失时降级为 no-op）。 */
interface LayoutLike { selectPanel(id: string | null): void }

const Overlay = ({ service, useSessions }: PropsRuntime<'shell.overlay'> & { service: VscodeWorkbench }) => {
  // DSH 0.2.0 起 sessions store 不再提供 state.current。官方在 shell 层的取法是
  // 在 state.byId 里找 retainedBy.mainView > 0 的会话（对齐 dsh-client-ui-layout 的 DocumentTitle
  // 与 dsh-client-ui-cordis 的 current 取法）。state.current 读取保留，用于兼容 0.1.x。
  const sessionId = useSessions((state: any) => state.current ?? (Object.values(state.byId ?? {}) as any[]).find((session: any) => (session.retainedBy?.mainView ?? 0) > 0)?.id) as string | undefined
  return <Workbench key={sessionId ?? 'no-session'} service={service} useSessions={useSessions as never}/>
}

/** 侧栏面板行的图标（renderSlot 只取这一处作为 glyph）。 */
const PanelIcon = () => <Icon name="code" />

/**
 * 面板行被点击后 DSH 会把主区域切到本组件。工作台是全屏 overlay，
 * 主区域不需要留内容，因此挂载后立刻把主区域交还会话视图。
 *
 * layout 取 unknown：插件绑定的旧类型里 ILayout 还没有 selectPanel（0.2.0 才加），
 * 声明成具体形状会与 slot 推导出的 ILayout 不兼容，因此运行时收窄后再调用。
 */
const PanelPage = ({ service, layout }: { service: VscodeWorkbench; layout?: unknown }) => {
  useEffect(() => {
    service.show()
    const select = (layout as LayoutLike | undefined)?.selectPanel
    if (typeof select === 'function') select.call(layout, null)
  }, [service, layout])
  return null
}

// layout 是跨插件面板动作契约（layout.selectPanel）。必须声明注入：cordis 拒绝访问未注入的
// 服务，此前用 `as unknown as` 绕过类型读取 ctx.layout，运行时直接让整个插件激活失败。
export const inject = ['slots', 'layout']
export function apply(ctx: ClientContext): void {
  const service = new WorkbenchController()
  const layout = ctx.layout
  ctx.effect(() => installStyles(), 'dsh-vscode-workbench: styles')
  ctx.effect(() => { const dispose = ctx.reflect.provide('vscodeWorkbench', service); return () => { void dispose() } }, 'dsh-vscode-workbench: service')
  ctx.effect(() => service.registerBottomPanel({ id: 'terminal', title: '终端', component: TerminalPanel }), 'dsh-vscode-workbench: terminal panel')
  ctx.effect(() => service.registerCommand({ id: 'terminal.new', run() { window.dispatchEvent(new Event('dvw-terminal-new')) } }), 'dsh-vscode-workbench: terminal command')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-vscode-workbench-overlay', inject: () => ({ service }) }, Overlay))
  // 侧栏“全局面板”入口：与下方 main 面板成对注册。
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({ service, layout }) }, PanelPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: 'VS Code 工作台' }, PanelIcon))
  ctx.effect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (handleTerminalShortcut(event, service)) return
      if (event.isComposing || !event.ctrlKey || event.altKey) return
      const view = event.shiftKey && event.code === 'KeyE' ? 'explorer' : event.shiftKey && event.code === 'KeyF' ? 'search' : event.shiftKey && event.code === 'KeyG' ? 'git' : undefined
      if (view !== undefined) { event.preventDefault(); service.show(view) }
    }
    window.addEventListener('keydown', onKey, true); return () => window.removeEventListener('keydown', onKey, true)
  }, 'dsh-vscode-workbench: navigation shortcuts')
}
