import { createPortal } from 'react-dom'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CodiconName } from './Icon.tsx'
import { Icon } from './Icon.tsx'

/**
 * 工作台统一的右键菜单。
 *
 * 为什么要有这一层：原先资源管理器的菜单是手写的一小块 `<div><button>…`，只有重命名与删除两项，
 * 终端列表又是另一套样式，编辑器则只有 Monaco 自带的英文菜单。同一个交互分散成三份、样式还不同，
 * 加一项功能就得改一处且容易漏。这里把它们收成一个组件 + 一份纯数据的菜单描述（见 menus.ts），
 * 于是「有哪些项」可以单测，「怎么画」只有一处。
 *
 * 行为按 VS Code 的菜单：
 *   - 贴着指针展开，贴到视口右侧/底部时翻到指针左侧/上方；
 *   - 点外面、Esc、窗口失焦、滚动都关闭；
 *   - 方向键移动、Home/End 跳首尾、Enter/Space 执行、Tab 关闭，焦点在菜单容器上（roving 由 data-active 标记）。
 */

/** 一条可点的菜单项。 */
export interface MenuItem {
  kind: 'item'
  /** 稳定标识，供测试与埋点断言「这一项在不在」。 */
  id: string
  label: string
  icon?: CodiconName
  /** 右侧的快捷键提示（纯展示，不注册键位）。 */
  shortcut?: string
  disabled?: boolean
  /** 破坏性操作（删除、终止终端）用警示色。 */
  danger?: boolean
  onSelect(): void
}

/** 分隔线。 */
export interface MenuSeparator { kind: 'separator' }

export type MenuEntry = MenuItem | MenuSeparator

export const separator = (): MenuSeparator => ({ kind: 'separator' })

export interface MenuSize { width: number; height: number }
export interface MenuViewport { width: number; height: number }
export interface MenuPlacement { left: number; top: number; flippedX: boolean; flippedY: boolean }

/**
 * 计算菜单的落点。
 *
 * 菜单比剩余空间大时**翻到指针的另一侧**而不是压扁在屏幕里 —— 后者会让菜单离指针很远，
 * 用户找不到自己点的是哪一项。两侧都放不下时再夹回视口内（由调用方给 max-height 兜底滚动）。
 */
export function clampMenuPosition(position: { x: number; y: number }, size: MenuSize, viewport: MenuViewport, margin = 8): MenuPlacement {
  const flippedX = position.x + size.width > viewport.width - margin
  const flippedY = position.y + size.height > viewport.height - margin
  const left = flippedX ? Math.max(margin, position.x - size.width) : Math.min(Math.max(margin, position.x), Math.max(margin, viewport.width - size.width - margin))
  const top = flippedY ? Math.max(margin, position.y - size.height) : Math.min(Math.max(margin, position.y), Math.max(margin, viewport.height - size.height - margin))
  return { left, top, flippedX, flippedY }
}

/** 菜单项的可聚焦序列：跳过分隔线与禁用项。 */
export function enabledIndexes(entries: readonly MenuEntry[]): number[] {
  return entries.flatMap((entry, index) => entry.kind === 'item' && entry.disabled !== true ? [index] : [])
}

/**
 * 打开后的静默期。
 *
 * 右键从按下到菜单真正挂上监听之间，不同平台/Electron 的派发顺序并不一致（有的先 pointerdown、
 * 有的先 contextmenu，还有的会补一个 wheel/blur）。这些事件在用户眼里都属于「刚才那次右键」，
 * 拿它们关掉刚打开的菜单，表现就是「右键一闪就没了」。静默期内一律忽略。
 */
export const MENU_GRACE_MS = 250

export type MenuDismissKind = 'pointerdown' | 'wheel' | 'blur' | 'resize' | 'escape'

/**
 * 关闭判定（纯函数，便于单测）。
 *
 * - Esc 是明确的关闭意图，任何时候都生效；
 * - 事件落在菜单内部不关闭（点菜单项由 onClick 自己处理）；
 * - 其余事件要等过静默期才关。
 */
export function shouldDismissMenu(kind: MenuDismissKind, input: { elapsedMs: number; insideMenu: boolean }): boolean {
  if (kind === 'escape') return true
  if (input.insideMenu) return false
  return input.elapsedMs >= MENU_GRACE_MS
}

export interface ContextMenuProps {
  /** 指针位置（clientX/clientY）。 */
  position: { x: number; y: number }
  entries: readonly MenuEntry[]
  /** 无障碍名称，例如「文件操作」「标签页操作」。 */
  label: string
  onClose(): void
}

export function ContextMenu({ position, entries, label, onClose }: ContextMenuProps) {
  const root = useRef<HTMLDivElement>(null)
  const [placed, setPlaced] = useState<MenuPlacement>({ left: position.x, top: position.y, flippedX: false, flippedY: false })
  const [active, setActive] = useState<number>(-1)
  /** 打开时刻：用来识别「同一次右键的余波」，见 MENU_GRACE_MS。 */
  const openedAt = useRef(performance.now())

  // 先渲染到指针处，量出真实尺寸后再摆正：提前算宽度要靠猜，而猜错会闪一下。
  useLayoutEffect(() => {
    const element = root.current
    if (element === null) return
    const rect = element.getBoundingClientRect()
    setPlaced(clampMenuPosition(position, { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight }))
  }, [position.x, position.y, entries.length])

  useEffect(() => { root.current?.focus() }, [])

  // 关闭条件集中在 shouldDismissMenu 里判定；事件监听只是把「发生了什么」报给它。
  // 用捕获阶段：菜单里的按钮自己 stopPropagation 也不会漏。
  useEffect(() => {
    const closeIf = (kind: MenuDismissKind, insideMenu = false) => {
      if (!shouldDismissMenu(kind, { elapsedMs: performance.now() - openedAt.current, insideMenu })) return
      onClose()
    }
    const pointer = (event: PointerEvent) => closeIf('pointerdown', root.current?.contains(event.target as Node) === true)
    const wheel = (event: WheelEvent) => closeIf('wheel', root.current?.contains(event.target as Node) === true)
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeIf('escape')
    }
    const blur = () => closeIf('blur')
    const resize = () => closeIf('resize')
    window.addEventListener('pointerdown', pointer, true)
    // 滚轮算用户主动滚动，要关菜单。
    window.addEventListener('wheel', wheel, { capture: true, passive: true })
    window.addEventListener('keydown', escape, true)
    window.addEventListener('blur', blur)
    window.addEventListener('resize', resize)
    // **刻意不监听 scroll**。工作台里有多个互相独立的滚动容器：DSH 对话栏的流式回答会自动滚动、
    // 文件树、终端、Monaco 自己的滚动条；window 捕获阶段的 scroll 会收到其中任何一个，
    // 于是菜单经常在刚打开的瞬间被「别人的滚动」带走 —— 这就是右键一闪就没的来源。
    // 需要「滚动即关闭」时由用户自己的滚轮（wheel）来触发，而不是任何一次程序化滚动。
    return () => {
      window.removeEventListener('pointerdown', pointer, true)
      window.removeEventListener('wheel', wheel, true)
      window.removeEventListener('keydown', escape, true)
      window.removeEventListener('blur', blur)
      window.removeEventListener('resize', resize)
    }
  }, [onClose])

  const run = useCallback((entry: MenuItem) => {
    if (entry.disabled === true) return
    onClose()
    entry.onSelect()
  }, [onClose])

  const move = (direction: 1 | -1) => {
    const available = enabledIndexes(entries)
    if (available.length === 0) return
    const current = available.indexOf(active)
    const next = current === -1
      ? (direction === 1 ? available[0] : available.at(-1))
      : available[(current + direction + available.length) % available.length]
    if (next !== undefined) setActive(next)
  }

  return createPortal(<div
    ref={root}
    className="dvw-menu"
    role="menu"
    aria-label={label}
    tabIndex={-1}
    style={{ left: placed.left, top: placed.top, ...(placed.flippedX ? { transformOrigin: 'right top' } : {}), ...(placed.flippedY ? { transformOrigin: 'right bottom' } : {}) }}
    onContextMenu={event => event.preventDefault()}
    onKeyDown={event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); move(1); return }
      if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); return }
      if (event.key === 'Home') { event.preventDefault(); setActive(enabledIndexes(entries)[0] ?? -1); return }
      if (event.key === 'End') { event.preventDefault(); setActive(enabledIndexes(entries).at(-1) ?? -1); return }
      if (event.key === 'Tab') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Enter' && event.key !== ' ') return
      const entry = entries[active]
      if (entry === undefined || entry.kind !== 'item') return
      event.preventDefault()
      run(entry)
    }}
  >
    {entries.map((entry, index) => entry.kind === 'separator'
      ? <div key={`separator-${index}`} className="dvw-menu-separator" role="separator"/>
      : <button
          key={entry.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className="dvw-menu-item"
          data-active={active === index || undefined}
          data-danger={entry.danger === true || undefined}
          aria-disabled={entry.disabled === true || undefined}
          title={entry.label}
          onPointerEnter={() => { if (entry.disabled !== true) setActive(index) }}
          onClick={() => run(entry)}
        >
          <span className="dvw-menu-icon">{entry.icon === undefined ? null : <Icon name={entry.icon}/>}</span>
          <span className="dvw-menu-label">{entry.label}</span>
          {entry.shortcut !== undefined && <span className="dvw-menu-shortcut">{entry.shortcut}</span>}
        </button>)}
  </div>, document.body)
}
