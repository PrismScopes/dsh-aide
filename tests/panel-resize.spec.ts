import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resizedPanelWidth } from '../src/client/Workbench.tsx'
import { BOTTOM_HEIGHT, bottomHeightLimit, clampBottomHeight, DEFAULT_LAYOUT, WorkbenchController } from '../src/client/service.ts'

const LAYOUT_KEY = 'dvw:workbench:layout:v1'

/** 内存版 localStorage：同一份实例可喂给两个 controller，验证「刷新后仍在」。 */
function memoryStorage(seed?: Record<string, string>) {
  const values = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    values,
    storage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } },
  }
}

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

describe('底部面板高度持久化（底部面板高度纳入 WorkbenchLayout）', () => {
  it('默认高度是 260（与 .dvw-bottom 的 CSS 兜底值一致）', () => {
    expect(BOTTOM_HEIGHT.default).toBe(260)
    expect(DEFAULT_LAYOUT.bottomHeight).toBe(BOTTOM_HEIGHT.default)
  })

  it('setLayout 持久化底部高度，重新载入（新 controller）后仍在', () => {
    const { storage } = memoryStorage()
    const first = new WorkbenchController(storage)
    first.setLayout({ bottomHeight: 340 })
    expect(first.getLayout().bottomHeight).toBe(340)
    // 「刷新页面」：同一份 storage 新建 controller。
    expect(new WorkbenchController(storage).getLayout().bottomHeight).toBe(340)
    // 同时落盘的 JSON 里确实有 bottomHeight 字段。
    expect(JSON.parse((storage.getItem(LAYOUT_KEY) ?? '{}')) as { bottomHeight?: number }).toMatchObject({ bottomHeight: 340 })
  })

  it('坏值（非数字）回落默认值，越界值夹到 min', () => {
    const broken = memoryStorage({ [LAYOUT_KEY]: JSON.stringify({ bottomHeight: 'tall' }) })
    expect(new WorkbenchController(broken.storage).getLayout().bottomHeight).toBe(BOTTOM_HEIGHT.default)
    const negative = memoryStorage({ [LAYOUT_KEY]: JSON.stringify({ bottomHeight: -50 }) })
    expect(new WorkbenchController(negative.storage).getLayout().bottomHeight).toBe(BOTTOM_HEIGHT.min)
    // 坏数据只影响该字段，其它布局字段照常恢复。
    const mixed = memoryStorage({ [LAYOUT_KEY]: JSON.stringify({ sideWidth: 300, bottomHeight: null }) })
    expect(new WorkbenchController(mixed.storage).getLayout()).toMatchObject({ sideWidth: 300, bottomHeight: BOTTOM_HEIGHT.default })
  })

  it('恢复时按当前视口夹取：旧像素高度可能比新窗口还高', () => {
    // 纯函数用显式视口高度验证（node 环境没有 innerHeight，走 fallbackMax）。
    expect(bottomHeightLimit(600)).toBe(440)          // 600 - 160
    expect(bottomHeightLimit(240)).toBe(BOTTOM_HEIGHT.min) // 上限不能低于 min
    expect(bottomHeightLimit(1200)).toBe(1040)
    expect(clampBottomHeight(5000, 800)).toBe(800)
    expect(clampBottomHeight(300, 800)).toBe(300)
    expect(clampBottomHeight(10, 800)).toBe(BOTTOM_HEIGHT.min)
  })

  it('setLayout 也夹取（不低于 min，不高于视口上限）', () => {
    const { storage } = memoryStorage()
    const service = new WorkbenchController(storage)
    service.setLayout({ bottomHeight: 10 })
    expect(service.getLayout().bottomHeight).toBe(BOTTOM_HEIGHT.min)
    service.setLayout({ bottomHeight: BOTTOM_HEIGHT.fallbackMax + 500 })
    expect(service.getLayout().bottomHeight).toBe(bottomHeightLimit())
    // 只改别的字段时底部高度保持不变。
    service.setLayout({ bottomHeight: 300 })
    service.setLayout({ chatVisible: false })
    expect(service.getLayout().bottomHeight).toBe(300)
  })
})
