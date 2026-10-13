import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { Icon } from './Icon.tsx'
import type { BottomPanelProps } from './service.ts'
import { isTerminalProtocolReply, TerminalWorkspaceController } from './terminal.ts'

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

function XtermView({ workspace, id, colorScheme }: { workspace: TerminalWorkspaceController; id: string; colorScheme: 'dark' | 'light' }) {
  const root = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal>()
  const replaying = useRef(false)
  const replayGuard = useRef<ReturnType<typeof setTimeout>>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (root.current === null) return
    const terminal = new Terminal({ convertEol: false, cursorBlink: true, fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace', fontSize: 13, theme: terminalTheme(colorScheme) })
    terminalRef.current = terminal
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(root.current)
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
    return () => { terminalRef.current = undefined; clearTimeout(replayGuard.current); observer.disconnect(); input.dispose(); resize.dispose(); output(); connection.close(); terminal.dispose() }
  }, [workspace, id])
  useEffect(() => { if (terminalRef.current !== undefined) terminalRef.current.options.theme = terminalTheme(colorScheme) }, [colorScheme])
  return error === undefined ? <div ref={root} className="dvw-terminal-host" /> : <div className="dvw-terminal-error">{error}</div>
}

/** Render interactive terminal tabs in the workbench bottom panel. */
export function TerminalPanel({ sessionId, colorScheme, header }: BottomPanelProps) {
  const workspaceRef = useRef<{ sessionId: string; value: TerminalWorkspaceController }>()
  if (workspaceRef.current?.sessionId !== sessionId) workspaceRef.current = { sessionId, value: new TerminalWorkspaceController(sessionId) }
  const workspace = workspaceRef.current.value
  const snapshot = useSyncExternalStore(workspace.subscribe.bind(workspace), workspace.getSnapshot.bind(workspace))
  const [active, setActive] = useState<string>()
  const [context, setContext] = useState<{ id: string; x: number; y: number }>()
  // 改名可能从两个地方发起（顶部标签、右侧列表），输入框只在该处出现，所以记下 where。
  const [renaming, setRenaming] = useState<{ id: string; value: string; where: 'tab' | 'list' }>()
  const [split, setSplit] = useState<readonly string[]>()
  const [sideWidth, setSideWidth] = useState(220)
  useEffect(() => {
    let cancelled = false
    void workspace.refresh().then(() => { if (!cancelled && workspace.getSnapshot().terminals.length === 0) void workspace.create().then(value => { if (!cancelled) setActive(value.id) }) })
    return () => { cancelled = true }
  }, [workspace])
  useEffect(() => { if (snapshot.terminals.length > 0 && (!active || !snapshot.terminals.some(value => value.id === active))) setActive(snapshot.terminals[0]?.id) }, [snapshot.terminals, active])
  // profile 从事件 detail 里拿：面板头部那个分体按钮选中某个 shell 时会带上它。
  // 命令入口（terminal.new）派发的是不带 detail 的普通事件，走平台默认 shell。
  useEffect(() => {
    const create = (event: Event) => {
      const profile = (event as CustomEvent<{ profile?: string }>).detail?.profile
      void workspace.create(profile === undefined ? {} : { profile }).then(value => setActive(value.id))
    }
    window.addEventListener('dvw-terminal-new', create)
    return () => window.removeEventListener('dvw-terminal-new', create)
  }, [workspace])
  useEffect(() => {
    if (context === undefined) return
    const close = () => setContext(undefined)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape) }
  }, [context])
  const closeTerminal = (id: string) => { setContext(undefined); setSplit(current => current?.filter(value => value !== id)); void workspace.close(id) }
  const saveRename = (id: string) => { const title = renaming?.id === id ? renaming.value.trim() : ''; setRenaming(undefined); if (title) void workspace.rename(id, title) }
  const splitTerminal = (first = active) => { if (first === undefined) return; void workspace.create().then(value => { setSplit(current => [...(current?.includes(first) ? current : [first]), value.id]); setActive(value.id) }) }
  const shown = (split ?? (active === undefined ? [] : [active])).filter(id => snapshot.terminals.some(value => value.id === id))
  const selectTerminal = (id: string) => { setActive(id); setSplit(current => current?.includes(id) ? current : [id]) }
  const startRename = (id: string, title: string, where: 'tab' | 'list') => setRenaming({ id, value: title, where })
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
            onContextMenu={event => { event.preventDefault(); selectTerminal(value.id); setContext({ id: value.id, x: event.clientX, y: event.clientY }) }}>
            <Icon name="terminal"/><span className="dvw-bottom-tab-name">{value.title}</span>
          </button>}
      <button type="button" className="dvw-bottom-tab-close" title="终止终端" aria-label={`终止 ${value.title}`} onClick={() => closeTerminal(value.id)}>
        <svg className="dvw-bottom-tab-close-icon" viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><path d="M1 1L7 7M7 1L1 7" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>
      </button>
    </span>)}
  </div>
  return <div className="dvw-terminal-root">
    {header !== undefined && header !== null && createPortal(tabs, header)}
    <div className="dvw-terminal-main">
      {snapshot.error !== undefined && <div className="dvw-terminal-error">{snapshot.error}</div>}
      <div className="dvw-terminal-panes" data-split={shown.length > 1 || undefined}>{shown.map(id => <XtermView key={id} workspace={workspace} id={id} colorScheme={colorScheme} />)}</div>
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
      <div className="dvw-terminal-list">{snapshot.terminals.map(value => renaming?.id === value.id && renaming.where === 'list' ? <div key={value.id} className="dvw-terminal-entry" data-active><div className="dvw-terminal-tab"><Icon name="terminal"/>{renameInput(value.id, 'dvw-terminal-rename')}</div></div> : <div key={value.id} className="dvw-terminal-entry" data-active={active === value.id}><button className="dvw-terminal-tab" onClick={() => selectTerminal(value.id)} onDoubleClick={() => startRename(value.id, value.title, 'list')} onContextMenu={event => { event.preventDefault(); selectTerminal(value.id); setContext({ id: value.id, x: event.clientX, y: event.clientY }) }}><Icon name="terminal"/>{value.title}</button><div className="dvw-terminal-entry-actions"><button title="拆分终端" onClick={() => splitTerminal(value.id)}><Icon name="split-horizontal"/></button><button title="终止终端" onClick={() => closeTerminal(value.id)}><Icon name="trash"/></button></div></div>)}</div>
      {context !== undefined && <div className="dvw-terminal-menu" role="menu" style={{ left: context.x, top: context.y }} onPointerDown={event => event.stopPropagation()}><button role="menuitem" onClick={() => { const terminal = snapshot.terminals.find(value => value.id === context.id); setContext(undefined); if (terminal !== undefined) setRenaming({ id: terminal.id, value: terminal.title, where: 'list' }) }}>重命名</button><button className="dvw-terminal-menu-danger" role="menuitem" onClick={() => closeTerminal(context.id)}>终止终端</button></div>}
    </aside>
  </div>
}
