import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
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
export function TerminalPanel({ sessionId, colorScheme }: BottomPanelProps) {
  const workspaceRef = useRef<{ sessionId: string; value: TerminalWorkspaceController }>()
  if (workspaceRef.current?.sessionId !== sessionId) workspaceRef.current = { sessionId, value: new TerminalWorkspaceController(sessionId) }
  const workspace = workspaceRef.current.value
  const snapshot = useSyncExternalStore(workspace.subscribe.bind(workspace), workspace.getSnapshot.bind(workspace))
  const [active, setActive] = useState<string>()
  const [context, setContext] = useState<{ id: string; x: number; y: number }>()
  const [renaming, setRenaming] = useState<{ id: string; value: string }>()
  const [split, setSplit] = useState<readonly string[]>()
  useEffect(() => {
    let cancelled = false
    void workspace.refresh().then(() => { if (!cancelled && workspace.getSnapshot().terminals.length === 0) void workspace.create().then(value => { if (!cancelled) setActive(value.id) }) })
    return () => { cancelled = true }
  }, [workspace])
  useEffect(() => { if (snapshot.terminals.length > 0 && (!active || !snapshot.terminals.some(value => value.id === active))) setActive(snapshot.terminals[0]?.id) }, [snapshot.terminals, active])
  useEffect(() => { const create = () => { void workspace.create().then(value => setActive(value.id)) }; window.addEventListener('dvw-terminal-new', create); return () => window.removeEventListener('dvw-terminal-new', create) }, [workspace])
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
  // 布局照 VS Code 的终端：顶部一条标签栏（左边是各终端标签，右边是操作按钮），
  // 下面是终端本体。原先用的是「左终端 + 右侧 220px 竖列表」，那更接近老式会话列表。
  // 视觉规格直接沿用工作台自己的标签栏（.dvw-tabs / .dvw-tab），不另创一套，
  // 这样两者在圆角、分隔线、激活态上与 DSH 保持一致。
  return <div className="dvw-terminal-root">
    <div className="dvw-terminal-bar">
      <div className="dvw-terminal-tab-list" role="tablist" aria-label="终端会话">
        {snapshot.terminals.map(value => renaming?.id === value.id
          ? <div key={value.id} className="dvw-terminal-tab" data-active="true">
            <Icon name="terminal"/>
            <input className="dvw-terminal-rename" value={renaming.value} autoFocus aria-label="终端名称"
              onChange={event => setRenaming({ id: value.id, value: event.target.value })}
              onKeyDown={event => { if (event.key === 'Enter') saveRename(value.id); if (event.key === 'Escape') setRenaming(undefined) }}
              onBlur={() => saveRename(value.id)}/>
          </div>
          : <div key={value.id} className="dvw-terminal-tab" data-active={active === value.id} data-split-member={shown.includes(value.id) || undefined} role="tab" aria-selected={active === value.id}>
            <button className="dvw-terminal-tab-label" title={value.title}
              onClick={() => selectTerminal(value.id)}
              onDoubleClick={() => setRenaming({ id: value.id, value: value.title })}
              onContextMenu={event => { event.preventDefault(); selectTerminal(value.id); setContext({ id: value.id, x: event.clientX, y: event.clientY }) }}>
              <Icon name="terminal"/><span className="dvw-terminal-tab-name">{value.title}</span>
            </button>
            <button className="dvw-terminal-tab-close" title="终止终端" aria-label={`终止 ${value.title}`} onClick={() => closeTerminal(value.id)}><Icon name="close"/></button>
          </div>)}
      </div>
      <div className="dvw-terminal-actions">
        <button className="dvw-terminal-button" title="新建终端" aria-label="新建终端" onClick={() => splitTerminal()}><Icon name="add"/></button>
        <button className="dvw-terminal-button" title="拆分终端" aria-label="拆分终端" disabled={active === undefined} onClick={() => splitTerminal()}><Icon name="split-horizontal"/></button>
        <button className="dvw-terminal-button" title="终止终端" aria-label="终止终端" disabled={active === undefined} onClick={() => { if (active !== undefined) closeTerminal(active) }}><Icon name="trash"/></button>
      </div>
    </div>
    {snapshot.error !== undefined && <div className="dvw-terminal-error">{snapshot.error}</div>}
    <div className="dvw-terminal-panes" data-split={shown.length > 1 || undefined}>{shown.map(id => <XtermView key={id} workspace={workspace} id={id} colorScheme={colorScheme} />)}</div>
    {context !== undefined && <div className="dvw-terminal-menu" role="menu" style={{ left: context.x, top: context.y }} onPointerDown={event => event.stopPropagation()}><button role="menuitem" onClick={() => { const terminal = snapshot.terminals.find(value => value.id === context.id); setContext(undefined); if (terminal !== undefined) setRenaming({ id: terminal.id, value: terminal.title }) }}>重命名</button><button role="menuitem" onClick={() => splitTerminal(context.id)}>拆分终端</button><button className="dvw-terminal-menu-danger" role="menuitem" onClick={() => closeTerminal(context.id)}>终止终端</button></div>}
  </div>
}
