import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resizedPanelWidth } from '../src/client/Workbench.tsx'

describe('resizedPanelWidth', () => {
  it('grows the source control panel when its right edge moves right', () => {
    expect(resizedPanelWidth(210, 100, 175, 1, 210, 640)).toBe(285)
  })

  it('grows the DSH panel when its left edge moves left', () => {
    expect(resizedPanelWidth(420, 500, 450, -1, 400, 720)).toBe(470)
  })

  it('holds at either limit while the pointer continues past it', () => {
    expect(resizedPanelWidth(210, 100, 0, 1, 210, 640)).toBe(210)
    expect(resizedPanelWidth(420, 500, -500, -1, 400, 720)).toBe(720)
  })

  it('uses transparent drag targets with no visual feedback, leaving the divider to the panels', () => {
    const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')
    // 命中区做宽是为了好抓，但完全透明。
    expect(styles).toContain('.dvw-side-resizer,.dvw-chat-resizer{width:10px;cursor:ew-resize;touch-action:none;background:transparent}')
    // 两个缩放条的定位。
    expect(styles).toContain('.dvw-side-resizer{position:relative;grid-column:2;grid-row:1/3;justify-self:end;height:100%;z-index:22;transform:translateX(5px)}')
    expect(styles).toContain('.dvw-chat-resizer{position:fixed;top:36px;bottom:0;right:calc(var(--dvw-chat-width) - 5px);z-index:22}')
    // 与 DSH 一致：悬停、聚焦、拖动都不做视觉反馈 —— resizer 自己的规则里不应出现高亮色，
    // 也不该用 ::after 另画一根线。只挑出 resizer 的规则来判，避免顺带扫到别的组件。
    const resizerRules = styles.match(/[^{}]*resizer[^{]*\{[^}]*\}/g) ?? []
    expect(resizerRules.length).toBeGreaterThan(0)
    expect(resizerRules.filter((rule) => /accent|::after/.test(rule))).toEqual([])
    // 分隔线改由面板自身的边框提供，所以不能再把边框置为透明。
    expect(styles).not.toContain('.dvw-side{border-right-color:transparent}')
  })
})
