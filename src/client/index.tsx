import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { useEffect, useLayoutEffect, useRef } from 'react'
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

/**
 * 侧栏面板行的图标。renderSlot 只把它渲染进行内的 glyph 位置，但这里额外铺满整行作为命中层：
 * DSH 的面板行被点击会调 layout.selectPanel，把主区域换成插件注册的空面板；那一次切换会卸载
 * 整个会话视图——连同 dsh-context、dsh-recall-plugin 这类挂在 conversation slot 上的组件一起——
 * 再重新挂载。每次打开工作台都要付这个代价（在装了这类插件的实例上是约 1 秒的整屏冻结）。
 * 在冒泡阶段吃掉点击，selectPanel 就不会执行，主区域保持原样。
 */
const PanelIcon = ({ service }: { service: VscodeWorkbench }) => {
  const hit = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    // 面板行本身是 static 定位，命中层要铺满它，得先给它一个定位上下文。
    const row = hit.current?.closest('button') ?? null
    if (row === null) return
    row.style.position = 'relative'
    return () => { row.style.removeProperty('position') }
  }, [])
  const open = (event: { stopPropagation: () => void; preventDefault: () => void }) => {
    event.stopPropagation()
    event.preventDefault()
    service.show()
  }
  return <span ref={hit} className="dvw-panel-hit" role="button" tabIndex={0} title="VS Code 工作台"
    onClick={open}
    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') open(event) }}>
    <Icon name="code"/>
  </span>
}

/**
 * 面板行被点击后 DSH 会把主区域切到本组件。工作台是全屏 overlay、会盖住主区域，
 * 所以主区域不需要留内容——但**不能**在这里立刻切回会话：那会让每次打开都多一次
 * 主区域往返（切到空面板、再切回会话），会话越长代价越大。
 * 改成等用户关闭工作台后再交还主区域，打开路径只剩一次切换。
 *
 * layout 取 unknown：插件绑定的旧类型里 ILayout 还没有 selectPanel（0.2.0 才加），
 * 声明成具体形状会与 slot 推导出的 ILayout 不兼容，因此运行时收窄后再调用。
 */
const PanelPage = ({ service, layout }: { service: VscodeWorkbench; layout?: unknown }) => {
  useEffect(() => {
    service.show()
    const release = () => {
      const select = (layout as LayoutLike | undefined)?.selectPanel
      if (typeof select === 'function') select.call(layout, null)
    }
    // 工作台关闭后主区域仍停在空白面板上，这一刻才把会话视图交还回去。
    return service.subscribe(() => { if (!service.getSnapshot().visible) release() })
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
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: 'VS Code 工作台', inject: () => ({ service }) }, PanelIcon))
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
