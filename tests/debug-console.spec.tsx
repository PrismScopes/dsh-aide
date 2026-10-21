import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DebugConsolePanel } from '../src/client/DebugConsolePanel.tsx'
import { panelMoreMenuItems } from '../src/client/menus.ts'

/**
 * 「调试控制台」面板与终端面板头「更多操作」入口的测试。
 *
 * 面板本身目前是空状态（还没有接入调试器），用 SSR 钉住文案与结构；
 * 入口跨「菜单数据 → Workbench 头部按钮 → 注册底部面板」三处，用静态断言保证每一段都接上了，
 * 避免出现「菜单画出来了、点开却没有面板」这种半截实现。
 */

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')
}

describe('DebugConsolePanel', () => {
  it('renders the Debug Console empty state', () => {
    const html = renderToStaticMarkup(<DebugConsolePanel sessionId="s" cwd="/ws" visible colorScheme="dark" header={null}/>)
    expect(html).toContain('class="dvw-debug"')
    expect(html).toContain('role="log"')
    expect(html).toContain('调试控制台')
    expect(html).toContain('没有活动的调试会话')
    expect(html).toContain('调试器接入后')
  })

  it('is read-only: no input or fake REPL prompt without a session', () => {
    const html = renderToStaticMarkup(<DebugConsolePanel sessionId="s" cwd="/ws" visible colorScheme="dark" header={null}/>)
    expect(html).not.toContain('<input')
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('role="textbox"')
  })
})

describe('panel more actions menu', () => {
  it('offers 调试控制台 only, and forwards the selection', () => {
    const openDebugConsole = vi.fn()
    const entries = panelMoreMenuItems({ openDebugConsole })
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry?.kind).toBe('item')
    if (entry === undefined || entry.kind !== 'item') throw new Error('菜单项缺失')
    expect(entry.id).toBe('debug-console')
    expect(entry.label).toBe('调试控制台')
    entry.onSelect()
    expect(openDebugConsole).toHaveBeenCalledTimes(1)
  })
})

describe('debug console wiring', () => {
  const workbench = read('src/client/Workbench.tsx')
  const clientIndex = read('src/client/index.tsx')
  const styles = read('src/client/styles.ts')
  const contextMenu = read('src/client/ContextMenu.tsx')

  it('registers the debug console as a bottom panel', () => {
    expect(clientIndex).toContain("id: 'debug'")
    expect(clientIndex).toContain("title: '调试控制台'")
    expect(clientIndex).toContain('DebugConsolePanel')
  })

  it('puts the ⋯ button in the panel title bar, left of the + / ▾ split button', () => {
    const more = workbench.indexOf('dvw-bottom-more')
    const split = workbench.indexOf('<TerminalNewButton')
    expect(more).toBeGreaterThan(-1)
    expect(split).toBeGreaterThan(-1)
    expect(more).toBeLessThan(split)
    expect(workbench).toContain('title="更多操作"')
    expect(workbench).toContain('aria-haspopup="menu"')
  })

  it('opens the debug console from the menu without closing an already-open one', () => {
    expect(workbench).toContain('panelMoreMenuItems')
    expect(workbench).toContain("service.getSnapshot().bottomPanel!=='debug'")
    expect(workbench).toContain("service.toggleBottomPanel('debug')")
    expect(workbench).toContain('ignorePointerDown={panelMenuButton}')
  })

  it('lets the anchor button close the menu (ContextMenu ignores its pointerdown)', () => {
    expect(contextMenu).toContain('ignorePointerDown?: RefObject<HTMLElement>')
    expect(contextMenu).toContain('ignorePointerDown?.current?.contains')
  })

  it('ships the empty-state styles with the existing tokens', () => {
    expect(styles).toContain('.dvw-debug-empty')
    expect(styles).toContain('--dvw-text-3')
  })
})
