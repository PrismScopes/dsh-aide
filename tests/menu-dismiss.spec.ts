import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MENU_GRACE_MS, shouldDismissMenu } from '../src/client/ContextMenu.tsx'

/**
 * 右键菜单「一闪就没」的回归测试。
 *
 * 症状：在代码编辑区右键，菜单刚出现就消失。根因在关闭策略：菜单用 window 捕获阶段的
 * `scroll` 监听来关闭自己，而工作台里 DSH 对话栏的流式回答会自动滚动、Monaco 自己的滚动条也会
 * 冒 scroll 事件 —— 任何一处滚动都会把刚打开的菜单带走。另外右键到菜单挂上监听之间，
 * 各平台派发顺序不同，同一交互的余波事件也可能把它关掉。
 *
 * 修法：不再监听 scroll（用户滚轮 wheel 仍然关闭），并给所有自动关闭加一段静默期。
 * 这里把两条都钉住，防止以后有人「顺手」把 scroll 加回来。
 */
describe('context menu dismissal policy', () => {
  it('ignores same-interaction leftovers during the grace period', () => {
    for (const kind of ['pointerdown', 'wheel', 'blur', 'resize'] as const) {
      expect(shouldDismissMenu(kind, { elapsedMs: 0, insideMenu: false })).toBe(false)
      expect(shouldDismissMenu(kind, { elapsedMs: MENU_GRACE_MS - 1, insideMenu: false })).toBe(false)
      expect(shouldDismissMenu(kind, { elapsedMs: MENU_GRACE_MS, insideMenu: false })).toBe(true)
    }
  })

  it('never dismisses for events inside the menu itself', () => {
    for (const kind of ['pointerdown', 'wheel', 'blur', 'resize'] as const) {
      expect(shouldDismissMenu(kind, { elapsedMs: MENU_GRACE_MS * 10, insideMenu: true })).toBe(false)
    }
  })

  it('honors Escape immediately, even inside the menu or right after opening', () => {
    expect(shouldDismissMenu('escape', { elapsedMs: 0, insideMenu: true })).toBe(true)
    expect(shouldDismissMenu('escape', { elapsedMs: 0, insideMenu: false })).toBe(true)
  })

  it('does not close the menu from captured scroll events any more', () => {
    // 静态检查：ContextMenu 里不能再出现 scroll 监听，关闭只由 pointerdown/wheel/blur/resize/Esc 决定。
    const source = readFileSync(new URL('../src/client/ContextMenu.tsx', import.meta.url), 'utf8')
    expect(source).not.toMatch(/addEventListener\('scroll'/)
    expect(source).toMatch(/addEventListener\('wheel'/)
    expect(source).toMatch(/MENU_GRACE_MS/)
  })

  it('keeps the submenu inside the same dismissal policy', () => {
    const source = readFileSync(new URL('../src/client/ContextMenu.tsx', import.meta.url), 'utf8')
    // 点在子菜单里也不算「点在外面」：父菜单与子菜单两个容器都要参与判定，否则点叶子项会先关菜单、再执行一次空动作。
    expect(source).toMatch(/submenuRoot\.current\?\.contains\(target as Node\)/)
    // Esc 逐层关闭：子菜单开着时先收子菜单，不能直接关整张菜单。
    expect(source).toMatch(/submenuIndexRef\.current !== undefined/)
    // 展开子菜单没有另起一套关闭逻辑，仍然交给 shouldDismissMenu 的静默期判定。
    expect(source).toMatch(/shouldDismissMenu\(kind, \{ elapsedMs: performance\.now\(\) - openedAt\.current, insideMenu \}\)/)
    // 子菜单的展开也不许靠 scroll 事件来收起（同一个「一闪就没」的坑）。
    expect(source).not.toMatch(/addEventListener\('scroll'/)
  })
})
