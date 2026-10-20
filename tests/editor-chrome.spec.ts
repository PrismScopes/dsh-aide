import { describe, expect, it } from 'vitest'
import { WORKBENCH_EDITOR_CHROME } from '../src/client/MonacoEditor.tsx'

describe('workbench editor chrome', () => {
  it('keeps a narrow scrollbar without an overview ruler, leaving the minimap to the user preference', () => {
    expect(WORKBENCH_EDITOR_CHROME).toMatchObject({
      renderOverviewRuler: false,
      overviewRulerLanes: 0,
      scrollbar: { verticalScrollbarSize: 10 },
    })
    // 缩略图与字号是设置页里的偏好（见 preferences.ts），不再写死在固定外框里 ——
    // 否则用户在设置页打开缩略图也不会有任何效果。
    expect('minimap' in WORKBENCH_EDITOR_CHROME).toBe(false)
    expect('fontSize' in WORKBENCH_EDITOR_CHROME).toBe(false)
  })
})
