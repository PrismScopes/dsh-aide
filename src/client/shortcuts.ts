import { bindingMatches, bindingOf } from './keybindings.ts'
import type { VscodeWorkbench } from './service.ts'

/** Reveal the terminal panel supplied by a terminal adapter without toggling it closed. */
export function openTerminal(workbench: VscodeWorkbench): boolean {
  if (!workbench.getPanels().some(panel => panel.id === 'terminal')) return false
  workbench.show()
  if (workbench.getSnapshot().bottomPanel !== 'terminal') workbench.toggleBottomPanel('terminal')
  return true
}

/** Toggle the terminal panel from the activity bar. */
export function toggleTerminal(workbench: VscodeWorkbench): boolean {
  if (!workbench.getPanels().some(panel => panel.id === 'terminal')) return false
  workbench.show()
  workbench.toggleBottomPanel('terminal')
  return true
}

/**
 * Handle terminal shortcuts through contributions registered by a terminal adapter.
 *
 * 键位来自设置页可改的注册表（`terminal.toggle` / `terminal.new`），每次按键实时读取，
 * 所以在设置页改完不用重新打开工作台。
 */
export function handleTerminalShortcut(event: KeyboardEvent, workbench: VscodeWorkbench): boolean {
  if (event.isComposing) return false
  const create = bindingOf('terminal.new')
  const toggle = bindingOf('terminal.toggle')
  const wantsNew = create !== null && bindingMatches(event, create)
  const wantsToggle = !wantsNew && toggle !== null && bindingMatches(event, toggle)
  if (!wantsNew && !wantsToggle) return false
  if (!workbench.getPanels().some(panel => panel.id === 'terminal')) return false
  event.preventDefault()
  event.stopImmediatePropagation()
  workbench.show()
  if (wantsNew) {
    openTerminal(workbench)
    queueMicrotask(() => workbench.runCommand('terminal.new'))
  } else {
    workbench.toggleBottomPanel('terminal')
  }
  return true
}
