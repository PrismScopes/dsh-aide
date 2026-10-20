import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PREFERENCES,
  EDITOR_LINE_HEIGHT_MIN,
  PREFERENCE_LIMITS,
  PREFERENCES_KEY,
  PreferencesStore,
  normalizePreferences,
} from '../src/client/preferences.ts'

/** 内存里的 localStorage 替身：测试不碰真实存储，也能看见写进去的是什么。 */
function memoryStorage(): { values: Map<string, string>; storage: { getItem(key: string): string | null; setItem(key: string, value: string): void } } {
  const values = new Map<string, string>()
  return {
    values,
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } },
  }
}

describe('workbench preferences', () => {
  it('starts from the defaults when nothing is stored', () => {
    expect(new PreferencesStore(undefined).get()).toEqual(DEFAULT_PREFERENCES)
    expect(new PreferencesStore(memoryStorage().storage).get()).toEqual(DEFAULT_PREFERENCES)
  })

  it('exposes the documented defaults for every field', () => {
    // 这些数字是设置页步进器与其他组件的共同约定，改动等于改变默认观感，必须显式钉住。
    expect(DEFAULT_PREFERENCES).toMatchObject({
      completionEnabled: true,
      completionDebounceMs: 90,
      editorFontSize: 14,
      editorLineHeight: 0,
      editorTabSize: 4,
      editorInsertSpaces: true,
      editorWordWrap: 'off',
      editorWordWrapColumn: 80,
      editorMinimap: false,
      editorOverviewRuler: true,
      editorOccurrencesHighlight: true,
      editorRenderWhitespace: 'none',
      editorCursorStyle: 'line',
      editorSmoothScrolling: false,
      editorStickyScroll: false,
      editorAutoSave: 'off',
      editorAutoSaveDelayMs: 1000,
      terminalFontSize: 13,
    })
  })

  it('declares limits for every numeric preference', () => {
    const numericKeys = [
      'completionDebounceMs',
      'editorFontSize',
      'editorLineHeight',
      'editorTabSize',
      'editorWordWrapColumn',
      'editorAutoSaveDelayMs',
      'terminalFontSize',
    ] as const
    for (const key of numericKeys) {
      const limits = PREFERENCE_LIMITS[key]
      expect(limits.min).toBeLessThan(limits.max)
      // 默认值本身必须落在合法区间里，否则「恢复默认」会写出一个越界值。
      expect(DEFAULT_PREFERENCES[key]).toBeGreaterThanOrEqual(limits.min)
      expect(DEFAULT_PREFERENCES[key]).toBeLessThanOrEqual(limits.max)
    }
  })

  it('clamps every numeric field at both boundaries', () => {
    const cases: ReadonlyArray<readonly [keyof typeof PREFERENCE_LIMITS, number, number]> = [
      ['completionDebounceMs', 5, PREFERENCE_LIMITS.completionDebounceMs.min],
      ['completionDebounceMs', 5000, PREFERENCE_LIMITS.completionDebounceMs.max],
      ['editorFontSize', 5, PREFERENCE_LIMITS.editorFontSize.min],
      ['editorFontSize', 99, PREFERENCE_LIMITS.editorFontSize.max],
      ['editorTabSize', 0, PREFERENCE_LIMITS.editorTabSize.min],
      ['editorTabSize', 99, PREFERENCE_LIMITS.editorTabSize.max],
      ['editorWordWrapColumn', 10, PREFERENCE_LIMITS.editorWordWrapColumn.min],
      ['editorWordWrapColumn', 999, PREFERENCE_LIMITS.editorWordWrapColumn.max],
      ['editorAutoSaveDelayMs', 1, PREFERENCE_LIMITS.editorAutoSaveDelayMs.min],
      ['editorAutoSaveDelayMs', 99999, PREFERENCE_LIMITS.editorAutoSaveDelayMs.max],
      ['terminalFontSize', 1, PREFERENCE_LIMITS.terminalFontSize.min],
      ['terminalFontSize', 99, PREFERENCE_LIMITS.terminalFontSize.max],
    ]
    for (const [key, input, expected] of cases) {
      expect(normalizePreferences({ [key]: input })[key]).toBe(expected)
    }
  })

  it('rounds fractional numbers instead of storing them', () => {
    expect(normalizePreferences({ editorFontSize: 15.6 }).editorFontSize).toBe(16)
    expect(normalizePreferences({ completionDebounceMs: 90.4 }).completionDebounceMs).toBe(90)
    expect(normalizePreferences({ editorTabSize: 3.5 }).editorTabSize).toBe(4)
  })

  it('treats line height 0 as automatic and rejects the 1–15 dead zone', () => {
    // 0 是「自动」的有意义取值，不能被夹成 16；1–15 会得到比字号还小的行高，向上夹到下限。
    expect(normalizePreferences({ editorLineHeight: 0 }).editorLineHeight).toBe(0)
    expect(normalizePreferences({ editorLineHeight: -5 }).editorLineHeight).toBe(0)
    expect(normalizePreferences({ editorLineHeight: 10 }).editorLineHeight).toBe(EDITOR_LINE_HEIGHT_MIN)
    expect(normalizePreferences({ editorLineHeight: 100 }).editorLineHeight).toBe(PREFERENCE_LIMITS.editorLineHeight.max)
    expect(normalizePreferences({ editorLineHeight: 22.4 }).editorLineHeight).toBe(22)
    expect(normalizePreferences({ editorLineHeight: 'tall' }).editorLineHeight).toBe(DEFAULT_PREFERENCES.editorLineHeight)
  })

  it('accepts the known enum values and falls back on anything else', () => {
    expect(normalizePreferences({ editorWordWrap: 'on' }).editorWordWrap).toBe('on')
    expect(normalizePreferences({ editorWordWrap: 'bounded' }).editorWordWrap).toBe('bounded')
    expect(normalizePreferences({ editorWordWrap: 'wrap' }).editorWordWrap).toBe('off')
    expect(normalizePreferences({ editorRenderWhitespace: 'all' }).editorRenderWhitespace).toBe('all')
    expect(normalizePreferences({ editorRenderWhitespace: true }).editorRenderWhitespace).toBe('none')
    expect(normalizePreferences({ editorCursorStyle: 'block' }).editorCursorStyle).toBe('block')
    expect(normalizePreferences({ editorCursorStyle: 'bar' }).editorCursorStyle).toBe('line')
    expect(normalizePreferences({ editorAutoSave: 'afterDelay' }).editorAutoSave).toBe('afterDelay')
    expect(normalizePreferences({ editorAutoSave: true }).editorAutoSave).toBe('off')
  })

  it('keeps the valid fields when one field is broken', () => {
    // 一项写坏只让那一项回默认值，不要整页偏好一起清空。
    expect(normalizePreferences({ completionEnabled: false, editorFontSize: null, editorWordWrap: 'bounded' })).toEqual({
      ...DEFAULT_PREFERENCES,
      completionEnabled: false,
      editorWordWrap: 'bounded',
    })
    expect(normalizePreferences({ editorMinimap: 'yes', editorStickyScroll: true, terminalFontSize: null })).toEqual({
      ...DEFAULT_PREFERENCES,
      editorStickyScroll: true,
    })
    expect(normalizePreferences('nonsense')).toEqual(DEFAULT_PREFERENCES)
    expect(normalizePreferences([])).toEqual(DEFAULT_PREFERENCES)
    expect(normalizePreferences(null)).toEqual(DEFAULT_PREFERENCES)
  })

  it('fills new fields with defaults when the stored value only has the old shape', () => {
    // v1 的键名没变：旧存储里只有最早那四个字段，读出来后新字段取默认值，而不是整份作废。
    const { values, storage } = memoryStorage()
    values.set(PREFERENCES_KEY, JSON.stringify({ completionEnabled: false, editorFontSize: 20, editorWordWrap: true, editorMinimap: true }))
    const restored = new PreferencesStore(storage).get()
    expect(restored.completionEnabled).toBe(false)
    expect(restored.editorFontSize).toBe(20)
    expect(restored.editorMinimap).toBe(true)
    // 旧版 editorWordWrap 是布尔值，迁移成语义等价的 'on'，不该被当成坏值丢掉。
    expect(restored.editorWordWrap).toBe('on')
    expect(restored.editorOverviewRuler).toBe(DEFAULT_PREFERENCES.editorOverviewRuler)
    expect(restored.editorTabSize).toBe(DEFAULT_PREFERENCES.editorTabSize)
    expect(restored.editorAutoSave).toBe(DEFAULT_PREFERENCES.editorAutoSave)
    expect(restored.terminalFontSize).toBe(DEFAULT_PREFERENCES.terminalFontSize)
    expect(restored.completionDebounceMs).toBe(DEFAULT_PREFERENCES.completionDebounceMs)
  })

  it('clamps an out-of-range value from an older store instead of rejecting it', () => {
    const { values, storage } = memoryStorage()
    // 旧版的字号上限是 20，新版放宽到 24：旧值原样沿用。
    values.set(PREFERENCES_KEY, JSON.stringify({ editorFontSize: 20 }))
    expect(new PreferencesStore(storage).get().editorFontSize).toBe(20)
    values.set(PREFERENCES_KEY, JSON.stringify({ editorFontSize: 21 }))
    expect(new PreferencesStore(storage).get().editorFontSize).toBe(21)
  })

  it('persists all fields under a versioned key and notifies subscribers', () => {
    const { values, storage } = memoryStorage()
    const store = new PreferencesStore(storage)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    expect(store.set({ editorFontSize: 16, editorWordWrap: 'bounded', terminalFontSize: 16 })).toEqual({
      ...DEFAULT_PREFERENCES,
      editorFontSize: 16,
      editorWordWrap: 'bounded',
      terminalFontSize: 16,
    })
    expect(listener).toHaveBeenCalledTimes(1)
    // 整份偏好（含新增字段）都要落盘：刷新后新字段不能丢。
    expect(JSON.parse(values.get(PREFERENCES_KEY) ?? '{}')).toEqual({
      ...DEFAULT_PREFERENCES,
      editorFontSize: 16,
      editorWordWrap: 'bounded',
      terminalFontSize: 16,
    })
    // 新实例从同一份存储里读回来：刷新页面后偏好仍在。
    const reloaded = new PreferencesStore(storage).get()
    expect(reloaded.editorFontSize).toBe(16)
    expect(reloaded.editorWordWrap).toBe('bounded')
    expect(reloaded.terminalFontSize).toBe(16)
    unsubscribe()
    store.set({ editorFontSize: 12 })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('resets every field back to the defaults', () => {
    const { values, storage } = memoryStorage()
    const store = new PreferencesStore(storage)
    store.set({ editorFontSize: 20, editorAutoSave: 'afterDelay', editorAutoSaveDelayMs: 5000, completionEnabled: false })
    expect(store.reset()).toEqual(DEFAULT_PREFERENCES)
    expect(new PreferencesStore(storage).get()).toEqual(DEFAULT_PREFERENCES)
  })

  it('ignores a corrupted stored value instead of throwing', () => {
    const { values, storage } = memoryStorage()
    values.set(PREFERENCES_KEY, '{not json')
    expect(new PreferencesStore(storage).get()).toEqual(DEFAULT_PREFERENCES)
  })

  it('matches the normalize output exactly to the stored shape', () => {
    // normalizePreferences 的返回值就是落盘的那一份：不能有字段只在默认值里有、normalize 却漏掉。
    expect(normalizePreferences(DEFAULT_PREFERENCES)).toEqual(DEFAULT_PREFERENCES)
    expect(Object.keys(normalizePreferences({})).sort()).toEqual(Object.keys(DEFAULT_PREFERENCES).sort())
  })
})
