import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { copyText, readClipboard } from './clipboard.ts'
import { ContextMenu } from './ContextMenu.tsx'
import type { MenuEntry } from './ContextMenu.tsx'
import { Icon } from './Icon.tsx'
import { getPreferences, usePreferences } from './preferences.ts'
import { terminalPaneMenuItems } from './menus.ts'
import type { BottomPanelProps } from './service.ts'
import { isTerminalProtocolReply, takeTerminalRequests, TerminalWorkspaceController } from './terminal.ts'
import type { TerminalRequest } from './terminal.ts'

/** 终端配色接入 DSH 主题令牌（渲染期从 body 读；无 document 时回落到原固定值）。 */
function terminalTheme(colorScheme: 'dark' | 'light') {
  const dark = colorScheme === 'dark'
  const token = (name: string, fallback: string) => {
    if (typeof document === 'undefined') return fallback
    const value = getComputedStyle(document.body).getPropertyValue(name).trim()
    return value || fallback
  }
  return {
    background: token('--dsw-alias-markdown-code-block', dark ? '#131417' : '#ffffff'),
    foreground: token('--dsw-alias-label-primary', dark ? '#f1f3f5' : '#1d2025'),
    cursor: token('--dsw-alias-label-secondary', dark ? '#c2c6cc' : '#4b515b'),
    selectionBackground: token('--dsw-alias-bg-document-selection', dark ? '#355d94' : '#add6ff')
  }
}

/** 回放结束后解除输入抑制的等待时间。 */
const REPLAY_SETTLE_MS = 250

/** 右键菜单落在哪一类元素上。列表与标签的「重命名」分别落在自己的输入框里。 */
interface TerminalMenuState { kind: 'tab' | 'list' | 'pane'; id: string; x: number; y: number }

interface XtermViewProps {
  workspace: TerminalWorkspaceController
  id: string
  colorScheme: 'dark' | 'light'
  /**
   * 当前窗格是否显示。
   *
   * 不显示的窗格**不销毁**：切标签时把实例留在 DOM 里（hidden），回来时不需要重建 xterm、
   * 也不需要宿主重放输出。终端的回放按 1000 行/256 KiB 裁剪，重建一次就要重新解析一遍。
   */
  hidden: boolean
  /**
   * 把 xterm 实例交给父组件。
   *
   * 为什么由子组件上报而不是父层自己 new：实例的生命周期绑定在 DOM 挂载上，只有这里知道
   * 什么时候创建、什么时候 dispose。父层只留一个 ref Map，供右键菜单的复制/粘贴/全选/清屏
   * 找到当前实例 —— 不把 terminal 状态复制到父组件（那会立刻产生两份不同步的状态）。
   */
  onReady(id: string, terminal: Terminal | undefined): void
  /** 内容区右键：只上报位置，菜单是面板级的一次性状态。 */
  onContextMenu(id: string, position: { x: number; y: number }): void
}

function XtermView({ workspace, id, colorScheme, hidden, onReady, onContextMenu }: XtermViewProps) {
  const root = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal>()
  // 字号是设置页里的偏好（默认 13）；实例建立后改设置也要立刻生效，所以要留 fit 的引用重新适配。
  const fitRef = useRef<FitAddon>()
  const replaying = useRef(false)
  const replayGuard = useRef<ReturnType<typeof setTimeout>>()
  const [error, setError] = useState<string>()
  const preferences = usePreferences()
  useEffect(() => {
    if (root.current === null) return
    // scrollback 写明确：宿主回放时按这个行数裁剪（见 src/terminal.ts 的 REPLAY_LINES），
    // 两处必须一致，否则要么白送字节、要么回放不够铺满。
    const terminal = new Terminal({ convertEol: false, cursorBlink: true, scrollback: 1000, fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace', fontSize: getPreferences().terminalFontSize, theme: terminalTheme(colorScheme) })
    terminalRef.current = terminal
    const fit = new FitAddon()
    fitRef.current = fit
    terminal.loadAddon(fit)
    terminal.open(root.current)
    onReady(id, terminal)
    const connection = workspace.connect(id)
    const output = connection.subscribe(value => {
      if (value.replay) {
        replaying.current = true
        // 收到回放时就先挂一个兜底定时器。原先只在 terminal.write 的回调里解除抑制，
        // 而那个回调并不保证一定触发（渲染时序因环境而异）；一旦没触发，replaying 会永久为
        // true，此后用户的每一次按键都被丢弃 —— 表现为「提示符在、打字毫无反应」。
        clearTimeout(replayGuard.current)
        replayGuard.current = setTimeout(() => { replaying.current = false }, REPLAY_SETTLE_MS)
      }
      terminal.write(value.data, () => {
        if (value.replay) {
          clearTimeout(replayGuard.current)
          replayGuard.current = setTimeout(() => { replaying.current = false }, REPLAY_SETTLE_MS)
        }
      })
    })
    const input = terminal.onData(data => { if (!replaying.current || !isTerminalProtocolReply(data)) connection.write(data) })
    const resize = terminal.onResize(({ cols, rows }) => connection.resize(cols, rows))
    const observer = new ResizeObserver(() => { try { fit.fit() } catch { /* The panel can be hidden during layout changes. */ } })
    observer.observe(root.current)
    // fit 与 focus 必须分开：面板刚显示时容器尺寸可能是 0，此时 fit.fit() 会抛错。
    // 原先两者写在同一个 try 里，一次抛错就把 terminal.focus() 整个跳过 —— 终端拿不到焦点，
    // 用户打字完全没有反应，而提示符照常显示。
    try { fit.fit() } catch { /* 尺寸未就绪时允许失败，下一次 ResizeObserver 会重试。 */ }
    try { terminal.focus() } catch (exception) { setError(exception instanceof Error ? exception.message : String(exception)) }
    return () => {
      // 先注销实例再 dispose：菜单若在卸载期间还被打开，拿到的必须是「没有实例」而不是已销毁的实例。
      onReady(id, undefined)
      terminalRef.current = undefined
      clearTimeout(replayGuard.current)
      observer.disconnect()
      input.dispose()
      resize.dispose()
      output()
      connection.close()
      terminal.dispose()
    }
  }, [workspace, id, onReady])
  useEffect(() => { if (terminalRef.current !== undefined) terminalRef.current.options.theme = terminalTheme(colorScheme) }, [colorScheme])
  // 切回来时容器从 display:none 变回有尺寸：ResizeObserver 会触发一次 fit，这里再做一次焦点回收。
  useEffect(() => {
    if (hidden) return
    try { fitRef.current?.fit() } catch { /* 面板还没拿到尺寸，下一次 ResizeObserver 会再试。 */ }
    try { terminalRef.current?.focus() } catch { /* 终端即将卸载时 focus 可能失败，忽略。 */ }
  }, [hidden])
  // 字号来自设置页：xterm 实例常驻，改 options 后重新 fit 即可，不必重开终端（重开会丢回放缓冲）。
  useEffect(() => {
    const terminal = terminalRef.current
    if (terminal === undefined) return
    terminal.options.fontSize = preferences.terminalFontSize
    try { fitRef.current?.fit() } catch { /* 面板隐藏时尺寸为 0，下一次 ResizeObserver 会再适配 */ }
  }, [preferences.terminalFontSize])
  if (error !== undefined) return <div className="dvw-terminal-error">{error}</div>
  // 内容区右键：xterm 自己也会处理 contextmenu（默认弹出浏览器菜单），这里统一 preventDefault，
  // 改由工作台的共享菜单接管。终端专属的复制/粘贴走菜单项，不再依赖浏览器原生菜单。
  return <div ref={root} className="dvw-terminal-host" hidden={hidden} onContextMenu={event => { event.preventDefault(); onContextMenu(id, { x: event.clientX, y: event.clientY }) }} />
}

/** Render interactive terminal tabs in the workbench bottom panel. */
export function TerminalPanel({ sessionId, colorScheme, header, visible }: BottomPanelProps) {
  const workspaceRef = useRef<{ sessionId: string; value: TerminalWorkspaceController }>()
  if (workspaceRef.current?.sessionId !== sessionId) workspaceRef.current = { sessionId, value: new TerminalWorkspaceController(sessionId) }
  const workspace = workspaceRef.current.value
  // subscribe/getSnapshot 的标识必须稳定：每次 render 都 bind 一次会让 useSyncExternalStore
  // 每帧退订再订阅（首帧还有一次多余的同步检查）。
  const subscribeWorkspace = useCallback((listener: () => void) => workspace.subscribe(listener), [workspace])
  const readWorkspace = useCallback(() => workspace.getSnapshot(), [workspace])
  const snapshot = useSyncExternalStore(subscribeWorkspace, readWorkspace)
  const [active, setActive] = useState<string>()
  // 改名可能从两个地方发起（顶部标签、右侧列表），输入框只在该处出现，所以记下 where。
  const [renaming, setRenaming] = useState<{ id: string; value: string; where: 'tab' | 'list' }>()
  const [split, setSplit] = useState<readonly string[]>()
  const [sideWidth, setSideWidth] = useState(220)
  const [menu, setMenu] = useState<TerminalMenuState>()
  const [actionError, setActionError] = useState<string>()
  /** 已挂载的 xterm 实例，key 是终端 id；未显示的窗格不在里面（它没有被渲染，也就没有实例）。 */
  const terminals = useRef(new Map<string, Terminal>())
  /**
   * 已经建过 xterm 实例的终端 id。
   *
   * 切标签/收起面板时不销毁实例：回来的那一刻直接显示，不需要重建 xterm，也不需要宿主
   * 重新回放 scrollback。只在终端被关闭（从 snapshot 里消失）时剔除。
   */
  const [opened, setOpened] = useState<readonly string[]>([])
  /** 已发出、宿主还没返回的新建请求数：先给一个占位窗格，点击后不会看起来毫无反应。 */
  const [pending, setPending] = useState(0)

  const reportError = (error: unknown) => setActionError(error instanceof Error ? error.message : String(error))

  /** 建终端（可能来自右键菜单、面板头按钮或队列）。directory/title/profile 原样透传给宿主。 */
  const createTerminal = useCallback((request: TerminalRequest) => {
    setActionError(undefined)
    // 占位窗格在请求发出前就显示：到提示符之间还有 pty 启动与 shell 初始化，不给反馈会像卡住。
    setPending(value => value + 1)
    void workspace.create(request)
      .then(value => setActive(value.id))
      .catch(reportError)
      .finally(() => setPending(value => Math.max(0, value - 1)))
  }, [workspace])

  /**
   * 取走排队的「新建终端」请求。
   *
   * requestTerminal 会同时入队并派发事件：面板没挂载时事件没人听、只能靠挂载时补一次 drain；
   * 已挂载时事件立刻到达、队列里也就那一批。因此 drain 的返回值就是「这次事件有没有被队列消费」，
   * 为 false 时才回落到旧行为（面板头分体按钮带 detail.profile 直接建一个）。
   */
  const drainRequests = useCallback(() => {
    const requests = takeTerminalRequests()
    if (requests.length === 0) return false
    // 逐条建：同一个队列里的请求各自带 directory/profile/title，不能合并。
    for (const request of requests) createTerminal(request)
    return true
  }, [createTerminal])

  const registerTerminal = useCallback((id: string, terminal: Terminal | undefined) => {
    if (terminal === undefined) terminals.current.delete(id)
    else terminals.current.set(id, terminal)
  }, [])

  const openPaneMenu = useCallback((id: string, position: { x: number; y: number }) => {
    setMenu({ kind: 'pane', id, x: position.x, y: position.y })
  }, [])

  const closeMenu = useCallback(() => setMenu(undefined), [])

  // 打开面板只把已有的终端列出来，不自动新建：启动时不该凭空多出一个 shell。
  // 当前终端由下面那条 effect 按列表挑，这里不需要自己设。
  useEffect(() => { void workspace.refresh() }, [workspace])
  /**
   * 预热默认 shell。
   *
   * pwsh 这类 shell 自己就要 ~0.5s 才能接命令（profile 加载），点「新建终端」后才开始起的话
   * 这段时间只能干等。面板已经打开、又没有终端可切时，先把默认 shell 起在宿主那边；用户点新建
   * 时它已经在回放缓冲里放着提示符了。延迟 150ms 是为了避开「刚打开就关掉」的抖动。
   */
  useEffect(() => {
    if (!visible || snapshot.terminals.length > 0) return
    const timer = setTimeout(() => { void workspace.prewarm().catch(() => { /* 预热失败不影响正常新建。 */ }) }, 150)
    return () => clearTimeout(timer)
  }, [visible, snapshot.terminals.length, workspace])
  useEffect(() => { if (snapshot.terminals.length > 0 && (!active || !snapshot.terminals.some(value => value.id === active))) setActive(snapshot.terminals[0]?.id) }, [snapshot.terminals, active])
  // 挂载时先 drain：从资源管理器「在终端中打开」时面板可能还没挂载，那时事件没人听。
  useEffect(() => { drainRequests() }, [drainRequests])
  // 事件到达后先 drain；队列为空才走旧行为（面板头分体按钮的 detail.profile）。
  useEffect(() => {
    const create = (event: Event) => {
      if (drainRequests()) return
      const profile = (event as CustomEvent<{ profile?: string }>).detail?.profile
      createTerminal(profile === undefined ? {} : { profile })
    }
    window.addEventListener('dvw-terminal-new', create)
    return () => window.removeEventListener('dvw-terminal-new', create)
  }, [drainRequests, createTerminal])
  // 关掉终端后若 split 只剩空数组，要收回 undefined：留下空数组会让 `split ?? [active]` 一直选中
  // 那个空数组，之后新建的终端也不会渲染（面板整块空白）。
  const closeTerminal = (id: string) => { setMenu(undefined); setSplit(current => { const next = current?.filter(value => value !== id); return next === undefined || next.length === 0 ? undefined : next }); void workspace.close(id).catch(reportError) }
  const saveRename = (id: string) => { const title = renaming?.id === id ? renaming.value.trim() : ''; setRenaming(undefined); if (title) void workspace.rename(id, title).catch(reportError) }
  const splitTerminal = (first = active) => {
    if (first === undefined) return
    setActionError(undefined)
    void workspace.create().then(value => { setSplit(current => [...(current?.includes(first) ? current : [first]), value.id]); setActive(value.id) }).catch(reportError)
  }
  // 兜底不变量：只要还有终端，就必须有一个窗格在渲染 —— 状态一旦错位，面板会整块空白。
  const panes = (split ?? (active === undefined ? [] : [active])).filter(id => snapshot.terminals.some(value => value.id === id))
  const shown = panes.length > 0 || snapshot.terminals.length === 0 ? panes : snapshot.terminals.slice(0, 1).map(value => value.id)
  // 实例常驻：跨终端/跨显示的并集。显示与否只由 hidden 决定，不触发 xterm 重建。
  const shownKey = shown.join('\n')
  useEffect(() => {
    setOpened(current => {
      const alive = current.filter(id => snapshot.terminals.some(value => value.id === id))
      const next = [...alive, ...shown.filter(id => !alive.includes(id))]
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next
    })
  }, [shownKey, snapshot.terminals])
  const selectTerminal = (id: string) => { setActive(id); setSplit(current => current?.includes(id) ? current : [id]) }
  const startRename = (id: string, title: string, where: 'tab' | 'list') => setRenaming({ id, value: title, where })
  /** 右键菜单的操作对象：菜单打开时记下的终端 id，动作再回到实例 Map / 列表里取。 */
  const menuTerminal = (id: string) => terminals.current.get(id)
  const openTabMenu = (id: string, kind: 'tab' | 'list', position: { x: number; y: number }) => {
    setMenu({ kind, id, x: position.x, y: position.y })
  }
  // 菜单内容来自共享的 menus.ts（唯一一份终端菜单描述），这里只接动作。
  // 标签/列表与内容区给的是同一份菜单：终端里没有别的入口发现复制、粘贴、清屏这些操作。
  const menuEntries: MenuEntry[] = menu === undefined ? [] : terminalPaneMenuItems({
    hasSelection: menuTerminal(menu.id)?.hasSelection() ?? false,
    canSplit: snapshot.terminals.some(value => value.id === menu.id),
    actions: {
      newTerminal: () => createTerminal({}),
      split: () => splitTerminal(menu.id),
      rename: () => { const terminal = snapshot.terminals.find(value => value.id === menu.id); if (terminal !== undefined) startRename(terminal.id, terminal.title, menu.kind === 'list' ? 'list' : 'tab') },
      kill: () => closeTerminal(menu.id),
      copySelection: () => { const text = menuTerminal(menu.id)?.getSelection() ?? ''; if (text !== '') void copyText(text) },
      paste: () => { void readClipboard().then(text => { if (text !== undefined) menuTerminal(menu.id)?.paste(text) }) },
      selectAll: () => menuTerminal(menu.id)?.selectAll(),
      clear: () => menuTerminal(menu.id)?.clear(),
    },
  })
  // 顶部标签栏。渲染进面板头里留给面板的那块容器（见 service.ts 的 BottomPanelProps.header）：
  // 标签状态属于终端面板，上提到 Workbench 只为了挪个位置会把职责弄乱。
  const renameInput = (id: string, className: string) => <input className={className} value={renaming?.value ?? ''} autoFocus aria-label="终端名称"
    onChange={event => setRenaming({ id, value: event.target.value, where: renaming?.where ?? 'tab' })}
    onKeyDown={event => { if (event.key === 'Enter') saveRename(id); if (event.key === 'Escape') setRenaming(undefined) }}
    onBlur={() => saveRename(id)}/>
  const tabs = <div className="dvw-bottom-tabs" role="tablist" aria-label="终端标签">
    {snapshot.terminals.map(value => <span key={value.id} className="dvw-bottom-tab" data-active={active === value.id || undefined}>
      {renaming?.id === value.id && renaming.where === 'tab'
        ? renameInput(value.id, 'dvw-bottom-tab-rename')
        : <button type="button" role="tab" aria-selected={active === value.id} className="dvw-bottom-tab-label" title={value.title}
            onClick={() => selectTerminal(value.id)}
            onDoubleClick={() => startRename(value.id, value.title, 'tab')}
            onContextMenu={event => { event.preventDefault(); selectTerminal(value.id); openTabMenu(value.id, 'tab', { x: event.clientX, y: event.clientY }) }}>
            <Icon name="terminal"/><span className="dvw-bottom-tab-name">{value.title}</span>
          </button>}
      <button type="button" className="dvw-bottom-tab-close" title="终止终端" aria-label={`终止 ${value.title}`} onClick={() => closeTerminal(value.id)}>
        <svg className="dvw-bottom-tab-close-icon" viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><path d="M1 1L7 7M7 1L1 7" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>
      </button>
    </span>)}
  </div>
  const error = snapshot.error ?? actionError
  return <div className="dvw-terminal-root">
    {header !== undefined && header !== null && createPortal(tabs, header)}
    <div className="dvw-terminal-main">
      {error !== undefined && <div className="dvw-terminal-error">{error}</div>}
      <div className="dvw-terminal-panes" data-split={shown.length > 1 || undefined}>
        {snapshot.terminals.length === 0 && pending === 0
          ? <div className="dvw-terminal-empty">没有找到终端</div>
          : [...new Set([...opened, ...shown])].map(id => <XtermView key={id} workspace={workspace} id={id} colorScheme={colorScheme} hidden={!shown.includes(id)} onReady={registerTerminal} onContextMenu={openPaneMenu} />)}
        {pending > 0 && <div className="dvw-terminal-pending" role="status">正在启动终端…</div>}
      </div>
    </div>
    <div className="dvw-terminal-resizer" role="separator" aria-label="终端列表宽度" aria-orientation="vertical" onPointerDown={event => {
      if (event.button !== 0) return
      event.preventDefault()
      const startX = event.clientX
      const startWidth = sideWidth
      const move = (next: PointerEvent) => setSideWidth(Math.max(160, Math.min(420, Math.round(startWidth + startX - next.clientX))))
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    }}/>
    <aside className="dvw-terminal-tabs" style={{ width: sideWidth }} aria-label="终端会话">
      <div className="dvw-terminal-list">{snapshot.terminals.map(value => renaming?.id === value.id && renaming.where === 'list' ? <div key={value.id} className="dvw-terminal-entry" data-active><div className="dvw-terminal-tab"><Icon name="terminal"/>{renameInput(value.id, 'dvw-terminal-rename')}</div></div> : <div key={value.id} className="dvw-terminal-entry" data-active={active === value.id}><button className="dvw-terminal-tab" onClick={() => selectTerminal(value.id)} onDoubleClick={() => startRename(value.id, value.title, 'list')} onContextMenu={event => { event.preventDefault(); selectTerminal(value.id); openTabMenu(value.id, 'list', { x: event.clientX, y: event.clientY }) }}><Icon name="terminal"/>{value.title}</button><div className="dvw-terminal-entry-actions"><button title="拆分终端" onClick={() => splitTerminal(value.id)}><Icon name="split-horizontal"/></button><button title="终止终端" onClick={() => closeTerminal(value.id)}><Icon name="trash"/></button></div></div>)}</div>
    </aside>
    {menu !== undefined && <ContextMenu position={{ x: menu.x, y: menu.y }} entries={menuEntries} label="终端操作" onClose={closeMenu}/>}
  </div>
}
