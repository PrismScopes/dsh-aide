import { describe, expect, it } from 'vitest'
import { editorChrome } from '../src/client/editorOptions.ts'

/**
 * 两个编辑器共用的外框。
 *
 * 早前这里断言「固定没有概览标尺」（WORKBENCH_EDITOR_CHROME 写死关闭）。现在标尺改成
 * 用户偏好：设置页打开就出现 VS Code 那条右侧标记带，关闭则完全收起。这个文件守住
 * 「由偏好决定」这件事，避免有人再把开关写死在组件里。
 */
describe('workbench editor chrome', () => {
  it('shows the overview ruler with three lanes when the preference is on', () => {
    expect(editorChrome({ editorOverviewRuler: true })).toMatchObject({
      renderOverviewRuler: true,
      overviewRulerLanes: 3,
      hideCursorInOverviewRuler: false,
    })
  })

  it('hides the overview ruler completely when the preference is off', () => {
    expect(editorChrome({ editorOverviewRuler: false })).toMatchObject({
      renderOverviewRuler: false,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
    })
  })

  it('keeps the narrow scrollbar, leaving the minimap and font size to the other preferences', () => {
    for (const preferences of [{ editorOverviewRuler: true }, { editorOverviewRuler: false }]) {
      const chrome = editorChrome(preferences)
      expect(chrome.scrollbar).toEqual({ verticalScrollbarSize: 10, horizontalScrollbarSize: 10 })
      // 缩略图、字号、换行这些随偏好变化的东西不进固定外框：否则用户在设置页改了也没有效果。
      expect('minimap' in chrome).toBe(false)
      expect('fontSize' in chrome).toBe(false)
      expect('wordWrap' in chrome).toBe(false)
    }
  })
})
