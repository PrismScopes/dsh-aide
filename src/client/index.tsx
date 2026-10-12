import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Icon } from './Icon.tsx'
import type { VscodeWorkbench } from './service.ts'
import { WorkbenchController } from './service.ts'
import { TerminalPanel } from './TerminalPanel.tsx'
import { SettingsPanel } from './SettingsPanel.tsx'
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
    /**
     * DSH 设置导航里的一项（kind: list，scope: root）。owner 由 shell 提供 close()，
     * 这里不消费它。工作台的布局偏好放在这一页，取代插件自建的设置面板。
     *
     * 原先注册的是 settings.plugins.tab，但那个 slot 由「插件市场」页在挂载期间才声明，
     * 页面没打开就不存在，注册会一直等下去；settings.section 始终存在，且 order 能让这一页
     * 正好落在「插件市场」下面。
     */
    'settings.section': { kind: 'list'; scope: 'root'; owner: { close: () => void } }
  }
}

/**
 * 打开 DSH 自己的设置面板，工作台保持打开。
 *
 * 不再去点侧栏入口，也不伪造键盘事件 —— 两者在桌面端都不成立：
 *   - 那个入口在**已登录时是二级菜单**（账户菜单：设置 / 意见反馈 / 退出登录），由 primitives 的
 *     Menu 渲染并 portal 到 body，role / class / 可点元素都不是稳定契约；
 *   - 伪造的 KeyboardEvent 带 isTrusted: false，而桌面端走的是 window.dshDesktop.keyboard
 *     原生键盘桥（见 dsh-client-shortcuts 的 ShortcutsService），不认这种合成事件。
 *     **web 端能过、桌面端过不去，正是这个原因。**
 *
 * 直接用 DSH 的 shortcuts 服务执行它自己注册的命令：
 *   ShortcutRegistry.invoke(id, context) —— 从命令表取 settings.open 并 run()，
 *   context.modal 为 null 时不做模态门控。与平台无关，也不碰 DOM。
 * registry 是该服务的内部字段，取不到时回退到派发组合键（web 端仍有效）。
 *
 * 工作台**不收起**：设置面板是 z-index 1000（wCInkW_overlay）、工作台 overlay 是 100，
 * 设置会浮在工作台之上，两者共存 —— 用户要的就是这个。
 */
function openDshSettings(): void {
  const registry = (shortcutsService as { registry?: { invoke?(id: string, context: unknown): unknown } } | undefined)?.registry
  if (typeof registry?.invoke === 'function') {
    console.info('[dvw] 打开 DSH 设置：走 shortcuts.registry.invoke')
    registry.invoke(SETTINGS_COMMAND, { modal: null, source: 'dsh-vscode-workbench' })
    return
  }
  console.warn('[dvw] 打开 DSH 设置：shortcuts.registry.invoke 不可用，回退到派发组合键（桌面端此回退无效）')
  dispatchSettingsKeys()
}

/** DSH 为设置面板注册的命令 id（dsh-client-ui-settings-general 里 ctx.shortcuts.register）。 */
const SETTINGS_COMMAND = 'settings.open'

/**
 * 回退路径：派发设置快捷键。
 *
 * DSH 的绑定写的是 modifiers: ["primary"]，即 mac 是 Cmd、其余平台是 Ctrl，所以修饰键要按
 * 平台给，不能一律用 Ctrl。平台取自 DSH 自己的判定方式（见 dsh-client-shortcuts 的
 * detectEnvironment）：html[data-platform] 存在即桌面端，其值用于区分 macos / windows / linux；
 * 不存在则退回 navigator.platform。
 *
 * web 端还有一个 Alt 变体（defaults 里 web:windows 是 primary+alt），所以两种都派发。
 * 桌面端不认合成事件，这条回退只在 web 端有效 —— 桌面端依赖上面的 registry.invoke。
 */
function dispatchSettingsKeys(): void {
  const raw = document.documentElement.dataset.platform ?? navigator.platform ?? ''
  const isMac = /darwin|mac|iphone|ipad/i.test(raw)
  const primary = isMac ? { metaKey: true } : { ctrlKey: true }
  for (const altKey of [false, true]) {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: ',', code: 'Comma', ...primary, altKey, bubbles: true, cancelable: true
    }))
  }
}

/** 由 apply 注入，供 openDshSettings 使用。 */
let shortcutsService: unknown

/** layout 服务的最小结构面（不 import 官方类型；旧版缺失时降级为 no-op）。 */
interface LayoutLike { selectPanel(id: string | null): void }

/**
 * 工作台显示期间，把 DSH 侧栏底部那个账户/设置入口整行从 DOM 里移除。
 *
 * 它的行位于 (10, 948)–(270, 990)，伸进工作台活动栏（x 0–48）的区域。被 overlay 盖住之后
 * 它既收不到点击（命中测试落在活动栏上），里面的图标又会从活动栏与侧栏的缝隙里透出来 ——
 * 表现为「两个图标重叠、其中一个点了没反应」。工作台活动栏的设置按钮提供的是同一个入口。
 *
 * 为什么移除整行而不是隐藏、也不是只删 svg：那一行里放什么取决于登录状态 ——
 * 未登录时是 IconEllipsisOutlineMedium（省略号），已登录时是 AccountAvatar（可能是 <img>）。
 * 只删 svg 会在已登录时漏掉头像，所以整行一起摘掉；关闭工作台时按原位插回。
 *
 * 以 triggerRow 类名定位（DSH 的 CSS Module 类，前缀哈希但不影响后缀匹配）。
 */
function useHideShadowedSettingsEntry(visible: boolean): void {
  useEffect(() => {
    // 只在工作台显示期间收起：关掉工作台就要把入口还给 DSH，否则用户从侧栏进不去设置。
    if (!visible) return
    const rows = [...document.querySelectorAll<HTMLElement>('[class*=_triggerRow]')]
      .map((row) => ({ row, parent: row.parentElement, next: row.nextSibling }))
    for (const { row } of rows) row.remove()
    return () => { for (const { row, parent, next } of rows) parent?.insertBefore(row, next) }
  }, [visible])
}

const Overlay = ({ service, useSessions }: PropsRuntime<'shell.overlay'> & { service: VscodeWorkbench }) => {
  // DSH 0.2.0 起 sessions store 不再提供 state.current。官方在 shell 层的取法是
  // 在 state.byId 里找 retainedBy.mainView > 0 的会话（对齐 dsh-client-ui-layout 的 DocumentTitle
  // 与 dsh-client-ui-cordis 的 current 取法）。state.current 读取保留，用于兼容 0.1.x。
  const sessionId = useSessions((state: any) => state.current ?? (Object.values(state.byId ?? {}) as any[]).find((session: any) => (session.retainedBy?.mainView ?? 0) > 0)?.id) as string | undefined
  // 两个 effect 的声明顺序有意义：先恢复被隐藏的侧栏入口，再触发它。见各自的注释。
  // 两个 effect 的声明顺序有意义：先按 visible 隐藏/恢复侧栏入口，再注册 opener。
  const [visible, setVisible] = useState(() => service.getSnapshot().visible)
  useEffect(() => service.subscribe(() => setVisible(service.getSnapshot().visible)), [service])
  useHideShadowedSettingsEntry(visible)
  useEffect(() => {
    service.setSettingsOpener(openDshSettings)
    return () => { service.setSettingsOpener(() => {}) }
  }, [service])
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
  return <>
    {/* 图标必须是正常的 flex 项：宿主 glyph 席位是 display:contents，绝对定位的子元素会脱离流，
        那样图标不占位，行文字会顶到行首把图标压住。 */}
    <span className="dvw-panel-icon"><Icon name="code"/></span>
    {/* 命中层单独一个绝对定位元素：铺满整行，在冒泡阶段吃掉点击。 */}
    <span ref={hit} className="dvw-panel-hit" role="button" tabIndex={0} title="VS Code 工作台"
      onClick={open}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') open(event) }}/>
  </>
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
// shortcuts 同样必须声明：openDshSettings 要经它执行 settings.open 命令（桌面端唯一可行的路径）。
export const inject = ['slots', 'layout', 'shortcuts']
export function apply(ctx: ClientContext): void {
  const service = new WorkbenchController()
  const layout = ctx.layout
  // shortcuts 服务的类型在绑定的旧版官方类型里还没有，按运行时形状取（同 layout 的做法）。
  shortcutsService = (ctx as unknown as { shortcuts?: unknown }).shortcuts
  ctx.effect(() => installStyles(), 'dsh-vscode-workbench: styles')
  ctx.effect(() => { const dispose = ctx.reflect.provide('vscodeWorkbench', service); return () => { void dispose() } }, 'dsh-vscode-workbench: service')
  ctx.effect(() => service.registerBottomPanel({ id: 'terminal', title: '终端', component: TerminalPanel }), 'dsh-vscode-workbench: terminal panel')
  ctx.effect(() => service.registerCommand({ id: 'terminal.new', run() { window.dispatchEvent(new Event('dvw-terminal-new')) } }), 'dsh-vscode-workbench: terminal command')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-vscode-workbench-overlay', inject: () => ({ service }) }, Overlay))
  // 侧栏“全局面板”入口：与下方 main 面板成对注册。
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({ service, layout }) }, PanelPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: 'VS Code 工作台', inject: () => ({ service }) }, PanelIcon))
  // DSH 设置导航里的「VS Code 工作台」页。order 取较大值，排在「插件市场」下面。
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: PANEL_ID, order: 1000, label: 'VS Code 工作台', inject: () => ({ service }) }, SettingsPanel))
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
