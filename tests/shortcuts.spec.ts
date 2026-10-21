import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchController } from '../src/client/service.ts'
import { handleTerminalShortcut, openTerminal, toggleTerminal } from '../src/client/shortcuts.ts'
import { keybindings } from '../src/client/keybindings.ts'
import { readFileSync } from 'node:fs'

function keyboard(shiftKey = false): KeyboardEvent {
  return { code: 'Backquote', ctrlKey: true, altKey: false, shiftKey, isComposing: false, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() } as unknown as KeyboardEvent
}

/** 用设置页的键位表改一个组合键（与设置页写入的是同一个 store）。 */
function press(code: string, modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean }): KeyboardEvent {
  return { code, ctrlKey: modifiers.ctrl ?? false, altKey: modifiers.alt ?? false, shiftKey: modifiers.shift ?? false, metaKey: false, isComposing: false, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() } as unknown as KeyboardEvent
}

describe('terminal shortcuts', () => {
  afterEach(() => { keybindings.resetAll() })
  it('renders the activity-bar terminal glyph', () => {
    const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')
    expect(styles).toContain('.codicon-terminal:before{content:"\\ea85"}')
  })

  it('does nothing without a contributed terminal panel', () => {
    expect(handleTerminalShortcut(keyboard(), new WorkbenchController(undefined))).toBe(false)
  })

  it('toggles the contributed terminal panel', () => {
    const service = new WorkbenchController(undefined)
    service.registerBottomPanel({ id: 'terminal', title: 'Terminal', component: () => null })
    const event = keyboard()
    expect(handleTerminalShortcut(event, service)).toBe(true)
    expect(service.getSnapshot()).toMatchObject({ visible: true, bottomPanel: 'terminal' })
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('reveals the contributed terminal panel without closing an open one', () => {
    const service = new WorkbenchController(undefined)
    service.registerBottomPanel({ id: 'terminal', title: 'Terminal', component: () => null })
    expect(openTerminal(service)).toBe(true)
    expect(service.getSnapshot()).toMatchObject({ visible: true, bottomPanel: 'terminal' })
    expect(openTerminal(service)).toBe(true)
    expect(service.getSnapshot().bottomPanel).toBe('terminal')
  })

  it('toggles the terminal from the activity bar', () => {
    const service = new WorkbenchController(undefined)
    service.registerBottomPanel({ id: 'terminal', title: 'Terminal', component: () => null })
    expect(toggleTerminal(service)).toBe(true)
    expect(service.getSnapshot().bottomPanel).toBe('terminal')
    expect(toggleTerminal(service)).toBe(true)
    expect(service.getSnapshot().bottomPanel).toBeUndefined()
  })

  it('opens the panel and runs the new-terminal command', async () => {
    const service = new WorkbenchController(undefined)
    const run = vi.fn()
    service.registerBottomPanel({ id: 'terminal', title: 'Terminal', component: () => null })
    service.registerCommand({ id: 'terminal.new', run })
    expect(handleTerminalShortcut(keyboard(true), service)).toBe(true)
    await Promise.resolve()
    expect(run).toHaveBeenCalledOnce()
  })

  it('follows remapped keys from the settings page', () => {
    const service = new WorkbenchController(undefined)
    service.registerBottomPanel({ id: 'terminal', title: 'Terminal', component: () => null })
    // 设置页把「显示或隐藏终端」改到 Ctrl+M：旧键位失效，新键位立刻可用（同一个 store）。
    keybindings.set('terminal.toggle', { code: 'KeyM', ctrl: true })
    expect(handleTerminalShortcut(keyboard(), service)).toBe(false)
    expect(handleTerminalShortcut(press('KeyM', { ctrl: true }), service)).toBe(true)
    expect(service.getSnapshot()).toMatchObject({ visible: true, bottomPanel: 'terminal' })
    // 解绑之后两个都不响应。
    keybindings.set('terminal.toggle', null)
    expect(handleTerminalShortcut(press('KeyM', { ctrl: true }), service)).toBe(false)
  })
})
