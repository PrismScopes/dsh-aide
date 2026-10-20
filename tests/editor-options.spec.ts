import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EDITOR_OPTION_PREFERENCES,
  EDITOR_HIGHLIGHT_COLORS,
  WORKBENCH_SCROLLBAR,
  editorChrome,
  editorModelOptions,
  editorOptions,
  highlightThemeColors,
  type EditorOptionPreferences,
} from '../src/client/editorOptions.ts'

/**
 * 这些用例只碰纯数据与纯函数：不加载 Monaco（AMD loader 只存在于浏览器）、
 * 不渲染 React。编辑器是否真的用上这些选项由 MonacoEditor.tsx 的接线保证，
 * 而映射本身的正确性（尤其是「划词高亮」「概览标尺」两组）在这里逐字段钉死。
 */

/** 构造一份偏好；坏值测试故意绕过类型（设置存储里可能出现任意 JSON）。 */
function preferences(patch: Record<string, unknown> = {}): EditorOptionPreferences {
  return { ...DEFAULT_EDITOR_OPTION_PREFERENCES, ...patch } as EditorOptionPreferences
}

describe('editorOptions', () => {
  it('maps every editor preference onto the matching Monaco option', () => {
    const options = editorOptions(preferences({
      editorFontSize: 16,
      editorLineHeight: 22,
      editorTabSize: 2,
      editorInsertSpaces: false,
      editorWordWrap: 'on',
      editorWordWrapColumn: 120,
      editorMinimap: true,
      editorRenderWhitespace: 'all',
      editorCursorStyle: 'block',
      editorSmoothScrolling: true,
      editorStickyScroll: true,
    }))
    expect(options).toMatchObject({
      fontSize: 16,
      lineHeight: 22,
      tabSize: 2,
      insertSpaces: false,
      wordWrap: 'on',
      wordWrapColumn: 120,
      minimap: { enabled: true },
      renderWhitespace: 'all',
      cursorStyle: 'block',
      smoothScrolling: true,
      stickyScroll: { enabled: true },
    })
  })

  it('passes the word wrap column only as data, keeping bounded mode intact', () => {
    const options = editorOptions(preferences({ editorWordWrap: 'bounded', editorWordWrapColumn: 100 }))
    expect(options.wordWrap).toBe('bounded')
    expect(options.wordWrapColumn).toBe(100)
    // off / on 也带着 column：对象形状稳定，切回 bounded 时不会残留上一次的列宽。
    expect(editorOptions(preferences({ editorWordWrap: 'off' })).wordWrap).toBe('off')
    expect(editorOptions(preferences({ editorWordWrap: 'on' })).wordWrap).toBe('on')
  })

  it('keeps lineHeight 0 as automatic instead of clamping it like a size', () => {
    expect(editorOptions(preferences({ editorLineHeight: 0 })).lineHeight).toBe(0)
    // 与 preferences.ts 的 normalizeLineHeight 一致：负数也归为「自动」。
    expect(editorOptions(preferences({ editorLineHeight: -5 })).lineHeight).toBe(0)
    // 1–15 是无效区，向上夹到 16。
    expect(editorOptions(preferences({ editorLineHeight: 1 })).lineHeight).toBe(16)
    expect(editorOptions(preferences({ editorLineHeight: 22 })).lineHeight).toBe(22)
  })

  it('drives occurrencesHighlight and selectionHighlight from the same preference', () => {
    // 「划词整体文档高亮」= 同一开关控制两层高亮：
    //   occurrencesHighlight（Monaco 0.52 起是枚举，布尔 false 会被丢弃并回落默认值）配合
    //   selectionHighlight（选中文本的其余出现），两者都开才有 VS Code 的观感。
    const on = editorOptions(preferences({ editorOccurrencesHighlight: true }))
    expect(on.occurrencesHighlight).toBe('singleFile')
    expect(on.selectionHighlight).toBe(true)
    const off = editorOptions(preferences({ editorOccurrencesHighlight: false }))
    expect(off.occurrencesHighlight).toBe('off')
    expect(off.selectionHighlight).toBe(false)
  })

  it('always enables bracket pair colorization (VS Code default, not a preference)', () => {
    expect(editorOptions(preferences()).bracketPairColorization).toEqual({ enabled: true })
  })

  it('exposes model-level tab options separately from editor options', () => {
    // tabSize / insertSpaces 必须走 model.updateOptions：差异编辑器的创建选项甚至不接受它们。
    expect(editorModelOptions(preferences({ editorTabSize: 3, editorInsertSpaces: false }))).toEqual({ tabSize: 3, insertSpaces: false })
    expect(Object.keys(editorOptions(preferences()))).toContain('tabSize')
  })

  it('clamps numbers into the supported ranges and falls back on unknown values', () => {
    const clamped = editorOptions(preferences({
      editorFontSize: 99,
      editorTabSize: 0,
      editorWordWrapColumn: 999,
      editorLineHeight: 5,
    }))
    expect(clamped.fontSize).toBe(24)
    expect(clamped.tabSize).toBe(1)
    expect(clamped.wordWrapColumn).toBe(200)
    expect(clamped.lineHeight).toBe(16)
    expect(editorOptions(preferences({ editorLineHeight: 99 })).lineHeight).toBe(40)
    expect(editorOptions(preferences({ editorFontSize: 5 })).fontSize).toBe(11)

    // 非数字 / 未知枚举：回落默认值，绝不把非法值喂给 Monaco（会被它静默丢弃，表现为「改了没生效」）。
    const broken = editorOptions(preferences({
      editorFontSize: 'big',
      editorWordWrap: 'wrap',
      editorRenderWhitespace: 'boundary',
      editorCursorStyle: 'line-thin',
      editorMinimap: 'yes',
      editorSmoothScrolling: null,
    }))
    expect(broken.fontSize).toBe(DEFAULT_EDITOR_OPTION_PREFERENCES.editorFontSize)
    expect(broken.wordWrap).toBe(DEFAULT_EDITOR_OPTION_PREFERENCES.editorWordWrap)
    expect(broken.renderWhitespace).toBe(DEFAULT_EDITOR_OPTION_PREFERENCES.editorRenderWhitespace)
    expect(broken.cursorStyle).toBe(DEFAULT_EDITOR_OPTION_PREFERENCES.editorCursorStyle)
    expect(broken.minimap).toEqual({ enabled: DEFAULT_EDITOR_OPTION_PREFERENCES.editorMinimap })
    expect(broken.smoothScrolling).toBe(DEFAULT_EDITOR_OPTION_PREFERENCES.editorSmoothScrolling)
  })

  it('falls back to the full default set for an empty or malformed preference object', () => {
    const defaults = editorOptions(preferences())
    expect(editorOptions({} as EditorOptionPreferences)).toEqual(defaults)
    expect(editorOptions(undefined as unknown as EditorOptionPreferences)).toEqual(defaults)
  })
})

describe('editorChrome', () => {
  it('shows a three lane overview ruler when the preference is on', () => {
    expect(editorChrome({ editorOverviewRuler: true })).toEqual({
      renderOverviewRuler: true,
      overviewRulerLanes: 3,
      hideCursorInOverviewRuler: false,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    })
  })

  it('collapses the overview ruler when the preference is off', () => {
    expect(editorChrome({ editorOverviewRuler: false })).toEqual({
      renderOverviewRuler: false,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    })
  })

  it('keeps the narrow scrollbar in both states and falls back to the default for garbage', () => {
    expect(editorChrome({ editorOverviewRuler: true }).scrollbar).toEqual(WORKBENCH_SCROLLBAR)
    expect(editorChrome({ editorOverviewRuler: false }).scrollbar).toEqual(WORKBENCH_SCROLLBAR)
    // 未知值按默认（开）处理：概览标尺是 VS Code 的默认观感。
    expect(editorChrome({ editorOverviewRuler: 'yes' as unknown as boolean }).renderOverviewRuler).toBe(true)
  })

  it('defaults to the overview ruler being visible', () => {
    expect(DEFAULT_EDITOR_OPTION_PREFERENCES.editorOverviewRuler).toBe(true)
    expect(editorChrome(DEFAULT_EDITOR_OPTION_PREFERENCES).renderOverviewRuler).toBe(true)
  })
})

describe('highlight theme colors', () => {
  const ids = EDITOR_HIGHLIGHT_COLORS.map(spec => spec.id)

  it('defines the four highlight groups VS Code uses after selecting a word', () => {
    // 选区高亮（选中文本的其余出现）
    expect(ids).toContain('editor.selectionHighlightBackground')
    expect(ids).toContain('editor.selectionHighlightBorder')
    // 同类词高亮（光标所在词的 occurrences）
    expect(ids).toContain('editor.wordHighlightBackground')
    expect(ids).toContain('editor.wordHighlightStrongBackground')
    // 查找匹配高亮
    expect(ids).toContain('editor.findMatchHighlightBackground')
  })

  it('defines the overview ruler markers that make the highlighted words visible on the ruler', () => {
    expect(ids).toContain('editorOverviewRuler.selectionHighlightForeground')
    expect(ids).toContain('editorOverviewRuler.wordHighlightForeground')
    expect(ids).toContain('editorOverviewRuler.currentContentForeground')
    expect(ids).toContain('editorOverviewRuler.border')
  })

  it('uses VS Code Dark+ / Light+ values for the inline highlights', () => {
    const dark = highlightThemeColors(true)
    const light = highlightThemeColors(false)
    expect(dark['editor.selectionHighlightBackground']).toBe('#ADD6FF26')
    expect(light['editor.selectionHighlightBackground']).toBe('#ADD6FF80')
    expect(dark['editor.wordHighlightBackground']).toBe('#575757B8')
    expect(light['editor.wordHighlightBackground']).toBe('#57575740')
    expect(dark['editor.selectionHighlightBorder']).toBe('#00000000')
  })

  it('only emits colors Monaco accepts: 6/8 digit hex', () => {
    for (const dark of [true, false]) {
      for (const value of Object.values(highlightThemeColors(dark))) {
        // Monaco 的 defineTheme 遇到 3/4 位简写或未知格式会抛错，进而让整个工作台渲染失败。
        expect(value).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i)
      }
    }
  })

  it('prefers DSH tokens over the fallback, and keeps the fallback when no token applies', () => {
    const resolved = highlightThemeColors(true, (token, fallback) => token === '' ? fallback : '#123456')
    expect(resolved['editor.selectionHighlightBackground']).toBe('#ADD6FF26')
    expect(resolved['editorOverviewRuler.selectionHighlightForeground']).toBe('#123456')
    expect(resolved['editorOverviewRuler.wordHighlightForeground']).toBe('#123456')
    // 令牌缺失时由调用方的 monacoColor 回落兜底色；空 token 的条目直接就是兜底色。
    const noTokens = highlightThemeColors(false, (_token, fallback) => fallback)
    expect(noTokens['editorOverviewRuler.currentContentForeground']).toBe('#A0A0A0CC')
    expect(noTokens['editorOverviewRuler.border']).toBe('#0000001a')
  })

  it('keeps token names as data so the DSH theme stays the source of truth', () => {
    const withToken = EDITOR_HIGHLIGHT_COLORS.filter(spec => spec.token !== '')
    expect(withToken.map(spec => spec.token)).toEqual(expect.arrayContaining([
      '--dsw-alias-state-business-primary',
      '--dsw-alias-label-tertiary',
      '--dsw-alias-border-l2',
    ]))
  })
})
