import { useEffect, useRef, useState } from 'react'
import type { TerminalProfile } from '../terminal.ts'
import { requestTerminalPrewarm, terminalProfiles } from './terminal.ts'

/**
 * 终端面板头部的「新建终端」分体按钮。
 *
 * 形态照 VS Code 的终端 + 控件：左边一个加号直接建默认终端，右边一个小箭头展开可选 shell，
 * 两半共用一圈边框、中间一条分隔线。菜单本身复用既有的 .dvw-terminal-menu（终端列表右键菜单
 * 用的就是它），只多一条定位规则，避免为同一个东西养两套样式。
 *
 * shell 列表由宿主探测（见 src/terminal.ts 的 terminalProfiles），首次展开时才去取。
 * 取不到时左半边的加号照常可用 —— 拿不到列表不等于不能建终端。
 *
 * 悬停/聚焦（鼠标移上来、Tab 聚焦）视为「马上要新建」的意图：派发 `dvw-terminal-prewarm`，
 * 让终端面板去预热默认 shell。这样**已经开着终端**的常见场景也能在点击前把 shell 起好
 * （pwsh 初始化约 530ms，悬停到点击通常有 200ms–1s，能盖掉大部分等待）。
 * 去重放在面板/宿主侧（150ms 合并 + 1s 冷却 + 宿主 90s TTL 复用），按钮本身无状态、不做节流。
 */
export function TerminalNewButton({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false)
  const [profiles, setProfiles] = useState<readonly TerminalProfile[]>()
  const [error, setError] = useState<string>()
  const root = useRef<HTMLDivElement>(null)
  const more = useRef<HTMLButtonElement>(null)

  /** 悬停/聚焦两半按钮都算意图：左半直接建默认终端，右半先开 shell 菜单，最终都会新建。 */
  const signalPrewarm = () => requestTerminalPrewarm()

  /** profile 缺省即平台默认 shell（Windows 上是 COMSPEC 原样启动）。 */
  const create = (profile?: string) => {
    setOpen(false)
    window.dispatchEvent(new CustomEvent('dvw-terminal-new', { detail: { profile } }))
  }

  useEffect(() => {
    if (!open || profiles !== undefined) return
    let cancelled = false
    void terminalProfiles(sessionId)
      .then(value => { if (!cancelled) setProfiles(value) })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [open, profiles, sessionId])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); more.current?.focus() } }
    window.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape) }
  }, [open])

  return <div className="dvw-terminal-new" ref={root}>
    <button className="dvw-terminal-new-main" type="button" title="新建终端" aria-label="新建终端" onPointerEnter={signalPrewarm} onFocus={signalPrewarm} onClick={() => create()}><svg className="dvw-terminal-new-plus" viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><path d="M4 0.5V7.5M0.5 4H7.5" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/></svg></button>
    <button className="dvw-terminal-new-more" ref={more} type="button" title="新建终端（选择 shell）" aria-label="新建终端（选择 shell）" aria-haspopup="menu" aria-expanded={open} onPointerEnter={signalPrewarm} onFocus={signalPrewarm} onClick={() => setOpen(current => !current)}><svg className="dvw-terminal-new-chevron" viewBox="0 0 8 5" width="8" height="5" aria-hidden="true"><path d="M1 1L4 4L7 1" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg></button>
    {open && <div className="dvw-terminal-menu dvw-terminal-new-menu" role="menu" aria-label="新建终端">
      <button type="button" role="menuitem" onClick={() => create()}>新建终端</button>
      <div className="dvw-terminal-menu-sep" role="separator"/>
      {error !== undefined && <button type="button" role="menuitem" disabled title={error}>无法获取 shell 列表</button>}
      {error === undefined && profiles === undefined && <button type="button" role="menuitem" disabled>正在检测 shell…</button>}
      {(profiles ?? []).map(profile => <button key={profile.id} type="button" role="menuitem" onClick={() => create(profile.id)}>{profile.label}</button>)}
    </div>}
  </div>
}
