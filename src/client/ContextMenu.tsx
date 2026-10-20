import { createPortal } from 'react-dom'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as MenuKeyEvent } from 'react'
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
 *   - 方向键移动、Home/End 跳首尾、Enter/Space 执行、Tab 关闭，焦点在菜单容器上（roving 由 data-active 标记）；
 *   - 带 `submenu` 的项展开第二级菜单（悬停、点击、ArrowRight），ArrowLeft/Esc 逐层收起。
 */

/** 一条可点的菜单项。 */
export interface MenuItem {
  kind: 'item'
  /** 稳定标识，供测试与埋点断言「这一项在不在」。 */
  id: string
  label: string
  /** 右侧的快捷键提示（纯展示，不注册键位）。 */
  shortcut?: string
  disabled?: boolean
  /** 破坏性操作（删除、终止终端）用警示色。 */
  danger?: boolean
  /**
   * 子菜单内容；存在时该项不执行 onSelect，而是展开子菜单。
   *
   * 只支持两级：子菜单条目里再出现 `submenu` 会被忽略（当普通叶子项处理），
   * 因为两级已经覆盖当前所有调用方，再深的层级会让定位/键盘状态成倍复杂。
   */
  submenu?: readonly MenuEntry[]
  onSelect(): void
}

/** 分隔线。 */
export interface MenuSeparator { kind: 'separator' }

export type MenuEntry = MenuItem | MenuSeparator

export const separator = (): MenuSeparator => ({ kind: 'separator' })

interface MenuSize { width: number; height: number }
interface MenuViewport { width: number; height: number }
interface MenuPlacement { left: number; top: number; flippedX: boolean; flippedY: boolean }

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

/**
 * 子菜单落点：贴在父项右侧；右侧放不下就翻到父项左侧（同样是「宁翻不夹」）。
 *
 * 垂直方向只做夹取：子菜单默认与父项顶部对齐（VS Code 也是这样，指向关系最清楚），
 * 但靠近视口底部时整体上移；再放不下就靠 CSS 的 max-height 滚动，而不是把菜单压到视口外。
 */
export function clampSubmenuPosition(anchor: { left: number; top: number; width: number; height: number }, size: MenuSize, viewport: MenuViewport, margin = 8): { left: number; top: number; flippedX: boolean } {
  const right = anchor.left + anchor.width
  const flippedX = right + size.width > viewport.width - margin
  const left = flippedX
    ? Math.max(margin, anchor.left - size.width)
    : Math.min(right, Math.max(margin, viewport.width - size.width - margin))
  const top = Math.min(Math.max(margin, anchor.top), Math.max(margin, viewport.height - size.height - margin))
  return { left, top, flippedX }
}

/** 菜单项的可聚焦序列：跳过分隔线与禁用项。带子菜单的父项与普通项一样可聚焦（只是回车改成展开）。 */
export function enabledIndexes(entries: readonly MenuEntry[]): number[] {
  return entries.flatMap((entry, index) => entry.kind === 'item' && entry.disabled !== true ? [index] : [])
}

/** 悬停展开子菜单的延迟：指针扫过菜单时不该把沿途每个子菜单都弹一遍。 */
export const SUBMENU_HOVER_MS = 120

/**
 * 打开后的静默期。
 *
 * 右键从按下到菜单真正挂上监听之间，不同平台/Electron 的派发顺序并不一致（有的先 pointerdown、
 * 有的先 contextmenu，还有的会补一个 wheel/blur）。这些事件在用户眼里都属于「刚才那次右键」，
 * 拿它们关掉刚打开的菜单，表现就是「右键一闪就没了」。静默期内一律忽略。
 */
export const MENU_GRACE_MS = 250

type MenuDismissKind = 'pointerdown' | 'wheel' | 'blur' | 'resize' | 'escape'

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

/** 取某一项的子菜单（分隔线没有）。第二级不递归渲染，所以这里只用于父菜单。 */
function itemSubmenu(entry: MenuEntry | undefined): readonly MenuEntry[] | undefined {
  return entry?.kind === 'item' ? entry.submenu : undefined
}

/** 在 entries 里移动「高亮下标」，跳过禁用项与分隔线；循环。 */
function moveIndex(entries: readonly MenuEntry[], current: number, direction: 1 | -1): number | undefined {
  const available = enabledIndexes(entries)
  if (available.length === 0) return undefined
  const at = available.indexOf(current)
  return at === -1
    ? (direction === 1 ? available[0] : available.at(-1))
    : available[(at + direction + available.length) % available.length]
}

interface ContextMenuProps {
  /** 指针位置（clientX/clientY）。 */
  position: { x: number; y: number }
  entries: readonly MenuEntry[]
  /** 无障碍名称，例如「文件操作」「标签页操作」。 */
  label: string
  onClose(): void
}

export function ContextMenu({ position, entries, label, onClose }: ContextMenuProps) {
  const root = useRef<HTMLDivElement>(null)
  /** 子菜单是父菜单的**兄弟**节点（role=menu 里不能再嵌套 role=menu），所以单独拿一个 ref 做「点在菜单内」判定。 */
  const submenuRoot = useRef<HTMLDivElement>(null)
  /** 每个父项按钮的 DOM：键盘展开子菜单时没有指针坐标，只能量父项位置来定位。 */
  const itemElements = useRef(new Map<number, HTMLButtonElement>())
  const [placed, setPlaced] = useState<MenuPlacement>({ left: position.x, top: position.y, flippedX: false, flippedY: false })
  const [active, setActive] = useState<number>(-1)
  /** 展开中的子菜单属于哪一项；undefined 表示没有子菜单（只支持两级，一个编号就够）。 */
  const [submenuIndex, setSubmenuIndex] = useState<number | undefined>(undefined)
  const [submenuActive, setSubmenuActive] = useState<number>(-1)
  const [submenuPlaced, setSubmenuPlaced] = useState<{ index: number; left: number; top: number; flippedX: boolean }>()
  /** 打开时刻：用来识别「同一次右键的余波」，见 MENU_GRACE_MS。 */
  const openedAt = useRef(performance.now())
  /** 悬停展开计时器；指针移到别的项时要取消，否则会在错误的项上弹出子菜单。 */
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>()
  /**
   * 给 window 捕获阶段的 Esc 监听读的状态。
   *
   * 那个监听比 React 的 onKeyDown 更早执行，拿不到最新的 state，所以把「子菜单开着吗」
   * 同步写进 ref —— Esc 才能做到「先收子菜单，再按一次才关整个菜单」。
   */
  const submenuIndexRef = useRef<number | undefined>(submenuIndex)
  submenuIndexRef.current = submenuIndex
  const submenuEntries = submenuIndex === undefined ? undefined : itemSubmenu(entries[submenuIndex])

  const clearHover = useCallback(() => {
    if (hoverTimer.current === undefined) return
    clearTimeout(hoverTimer.current)
    hoverTimer.current = undefined
  }, [])

  // 组件卸载（整张菜单关掉）时别留下计时器：它会在已卸载的组件上 setState。
  useEffect(() => clearHover, [clearHover])

  const closeSubmenu = useCallback(() => { setSubmenuIndex(undefined); setSubmenuActive(-1) }, [])

  const openSubmenu = useCallback((index: number) => {
    clearHover()
    setActive(index)
    setSubmenuActive(-1)
    setSubmenuIndex(index)
  }, [clearHover])

  // 先渲染到指针处，量出真实尺寸后再摆正：提前算宽度要靠猜，而猜错会闪一下。
  useLayoutEffect(() => {
    const element = root.current
    if (element === null) return
    const rect = element.getBoundingClientRect()
    setPlaced(clampMenuPosition(position, { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight }))
  }, [position.x, position.y, entries.length])

  // 子菜单同理：先按父项位置挂出来，量到自身尺寸后再按「右侧优先、放不下翻左」摆正。
  useLayoutEffect(() => {
    const element = submenuRoot.current
    const index = submenuIndex
    if (element === null || index === undefined) return
    const anchor = itemElements.current.get(index)
    if (anchor === undefined) return
    const rect = anchor.getBoundingClientRect()
    const next = clampSubmenuPosition({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }, { width: element.offsetWidth, height: element.offsetHeight }, { width: window.innerWidth, height: window.innerHeight })
    setSubmenuPlaced({ index, ...next })
  }, [submenuIndex, submenuEntries?.length])

  useEffect(() => { root.current?.focus() }, [])

  // 关闭条件集中在 shouldDismissMenu 里判定；事件监听只是把「发生了什么」报给它。
  // 用捕获阶段：菜单里的按钮自己 stopPropagation 也不会漏。
  useEffect(() => {
    const inside = (target: EventTarget | null) => root.current?.contains(target as Node) === true || submenuRoot.current?.contains(target as Node) === true
    const closeIf = (kind: MenuDismissKind, insideMenu = false) => {
      if (!shouldDismissMenu(kind, { elapsedMs: performance.now() - openedAt.current, insideMenu })) return
      onClose()
    }
    const pointer = (event: PointerEvent) => closeIf('pointerdown', inside(event.target))
    const wheel = (event: WheelEvent) => closeIf('wheel', inside(event.target))
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      // 逐层关闭：子菜单开着时 Esc 只收子菜单，再按一次才关整个菜单（与 VS Code 一致）。
      if (submenuIndexRef.current !== undefined) { closeSubmenu(); return }
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
  }, [onClose, closeSubmenu])

  const run = useCallback((entry: MenuItem) => {
    if (entry.disabled === true) return
    onClose()
    entry.onSelect()
  }, [onClose])

  const move = (direction: 1 | -1) => {
    const next = moveIndex(entries, active, direction)
    if (next !== undefined) setActive(next)
  }

  const moveSubmenu = (direction: 1 | -1) => {
    if (submenuEntries === undefined) return
    const next = moveIndex(submenuEntries, submenuActive, direction)
    if (next !== undefined) setSubmenuActive(next)
  }

  /**
   * 悬停项。
   *
   * 普通项：立刻把子菜单收掉，否则指针已经移开、子菜单还挂着，看着像卡住了。
   * 父项：延迟 SUBMENU_HOVER_MS 再展开，避免指针扫过时沿途的父项都弹一次。
   */
  const hover = (index: number, entry: MenuItem) => {
    if (entry.disabled === true) return
    setActive(index)
    if (entry.submenu === undefined) { clearHover(); closeSubmenu(); return }
    if (submenuIndex === index) return
    clearHover()
    closeSubmenu()
    hoverTimer.current = setTimeout(() => { hoverTimer.current = undefined; openSubmenu(index) }, SUBMENU_HOVER_MS)
  }

  /**
   * 键盘处理。同一个函数挂在父菜单与子菜单两个容器上：
   * 焦点可能落在其中任意一个（点击子菜单项后焦点会移到子菜单），但两者的规则一致 ——
   * 子菜单开着时方向键归子菜单，关着时归父菜单。
   */
  const keyDown = (event: MenuKeyEvent) => {
    if (submenuEntries !== undefined) {
      if (event.key === 'ArrowDown') { event.preventDefault(); moveSubmenu(1); return }
      if (event.key === 'ArrowUp') { event.preventDefault(); moveSubmenu(-1); return }
      if (event.key === 'Home') { event.preventDefault(); setSubmenuActive(enabledIndexes(submenuEntries)[0] ?? -1); return }
      if (event.key === 'End') { event.preventDefault(); setSubmenuActive(enabledIndexes(submenuEntries).at(-1) ?? -1); return }
      // ArrowLeft 只收子菜单并把高亮还给父项；整张菜单还留着，可以继续选别的项。
      if (event.key === 'ArrowLeft') { event.preventDefault(); closeSubmenu(); root.current?.focus(); return }
      if (event.key === 'Tab') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Enter' && event.key !== ' ') return
      const entry = submenuEntries[submenuActive]
      if (entry === undefined || entry.kind !== 'item') return
      event.preventDefault()
      // 子菜单里的项按叶子处理：虽然不递归渲染 submenu，但 onSelect 仍然执行（由调用方决定是否无操作）。
      run(entry)
      return
    }
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); return }
    if (event.key === 'Home') { event.preventDefault(); setActive(enabledIndexes(entries)[0] ?? -1); return }
    if (event.key === 'End') { event.preventDefault(); setActive(enabledIndexes(entries).at(-1) ?? -1); return }
    if (event.key === 'ArrowRight') {
      const entry = entries[active]
      if (entry?.kind !== 'item' || entry.submenu === undefined || entry.disabled === true) return
      event.preventDefault()
      openSubmenu(active)
      return
    }
    if (event.key === 'Tab') { event.preventDefault(); onClose(); return }
    if (event.key !== 'Enter' && event.key !== ' ') return
    const entry = entries[active]
    if (entry === undefined || entry.kind !== 'item' || entry.disabled === true) return
    event.preventDefault()
    // Enter 在父项上是「展开」而不是「执行」：带 submenu 的项没有有意义的 onSelect。
    if (entry.submenu !== undefined) { openSubmenu(active); return }
    run(entry)
  }

  /** 父菜单与子菜单共用的按钮外观；行为（悬停/点击）由 context 区分。 */
  const button = (entry: MenuItem, index: number, context: 'root' | 'submenu') => <button
    key={entry.id}
    ref={context === 'root' ? element => { if (element === null) itemElements.current.delete(index); else itemElements.current.set(index, element) } : undefined}
    type="button"
    role="menuitem"
    tabIndex={-1}
    className="dvw-menu-item"
    data-active={(context === 'root' ? active : submenuActive) === index || undefined}
    data-danger={entry.danger === true || undefined}
    aria-disabled={entry.disabled === true || undefined}
    aria-haspopup={context === 'root' && entry.submenu !== undefined ? 'menu' : undefined}
    aria-expanded={context === 'root' && entry.submenu !== undefined ? submenuIndex === index : undefined}
    title={entry.label}
    onPointerEnter={() => context === 'root' ? hover(index, entry) : (entry.disabled !== true && setSubmenuActive(index))}
    onClick={() => {
      if (entry.disabled === true) return
      // 父项点击是「展开」，不是「执行」；第二级里的项一律当叶子执行。
      if (context === 'root' && entry.submenu !== undefined) { openSubmenu(index); return }
      run(entry)
    }}
  >
    <span className="dvw-menu-label">{entry.label}</span>
    {entry.shortcut !== undefined && <span className="dvw-menu-shortcut">{entry.shortcut}</span>}
    {context === 'root' && entry.submenu !== undefined && <span className="dvw-menu-arrow"><Icon name="chevron-right"/></span>}
  </button>

  const parentItem = submenuIndex === undefined ? undefined : entries[submenuIndex]
  const submenuLabel = parentItem?.kind === 'item' ? `${parentItem.label} 子菜单` : '子菜单'
  const submenuPosition = submenuPlaced?.index === submenuIndex ? submenuPlaced : undefined

  return createPortal(<>
    <div
      ref={root}
      className="dvw-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{ left: placed.left, top: placed.top, ...(placed.flippedX ? { transformOrigin: 'right top' } : {}), ...(placed.flippedY ? { transformOrigin: 'right bottom' } : {}) }}
      onContextMenu={event => event.preventDefault()}
      // 指针离开整张菜单时取消还没到点的悬停展开：否则指针早已移开，子菜单却自己弹出来。
      onPointerLeave={clearHover}
      onKeyDown={keyDown}
    >
      {entries.map((entry, index) => entry.kind === 'separator'
        ? <div key={`separator-${index}`} className="dvw-menu-separator" role="separator"/>
        : button(entry, index, 'root'))}
    </div>
    {submenuEntries !== undefined && <>
      <div
        ref={submenuRoot}
        className="dvw-menu dvw-submenu"
        role="menu"
        aria-label={submenuLabel}
        tabIndex={-1}
        // 量尺寸前先藏起来：否则会在左上角闪一下再跳到父项旁边。
        style={{ left: submenuPosition?.left ?? 0, top: submenuPosition?.top ?? 0, visibility: submenuPosition === undefined ? 'hidden' : undefined, ...(submenuPosition?.flippedX === true ? { transformOrigin: 'right top' } : {}) }}
        onContextMenu={event => event.preventDefault()}
        onKeyDown={keyDown}
      >
        {submenuEntries.map((entry, index) => entry.kind === 'separator'
          ? <div key={`submenu-separator-${index}`} className="dvw-menu-separator" role="separator"/>
          : button(entry, index, 'submenu'))}
      </div>
    </>}
  </>, document.body)
}
