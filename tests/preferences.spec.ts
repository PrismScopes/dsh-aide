import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PREFERENCES,
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

  it('clamps the editor font size into the supported range', () => {
    const { min, max } = PREFERENCE_LIMITS.editorFontSize
    expect(normalizePreferences({ editorFontSize: 5 }).editorFontSize).toBe(min)
    expect(normalizePreferences({ editorFontSize: 99 }).editorFontSize).toBe(max)
    // 小数按像素取整：步进器只会给整数，但存储里可能有手写值。
    expect(normalizePreferences({ editorFontSize: 15.6 }).editorFontSize).toBe(16)
    expect(normalizePreferences({ editorFontSize: 'big' }).editorFontSize).toBe(DEFAULT_PREFERENCES.editorFontSize)
  })

  it('keeps the valid fields when one field is broken', () => {
    // 一项写坏只让那一项回默认值，不要整页偏好一起清空。
    expect(normalizePreferences({ completionEnabled: false, editorFontSize: null, editorWordWrap: true })).toEqual({
      ...DEFAULT_PREFERENCES,
      completionEnabled: false,
      editorWordWrap: true,
    })
    expect(normalizePreferences('nonsense')).toEqual(DEFAULT_PREFERENCES)
    expect(normalizePreferences([])).toEqual(DEFAULT_PREFERENCES)
  })

  it('persists changes under a versioned key and notifies subscribers', () => {
    const { values, storage } = memoryStorage()
    const store = new PreferencesStore(storage)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    expect(store.set({ editorFontSize: 16 })).toEqual({ ...DEFAULT_PREFERENCES, editorFontSize: 16 })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(JSON.parse(values.get(PREFERENCES_KEY) ?? '{}')).toEqual({ ...DEFAULT_PREFERENCES, editorFontSize: 16 })
    // 新实例从同一份存储里读回来：刷新页面后偏好仍在。
    expect(new PreferencesStore(storage).get().editorFontSize).toBe(16)
    unsubscribe()
    store.set({ editorFontSize: 12 })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('ignores a corrupted stored value instead of throwing', () => {
    const { values, storage } = memoryStorage()
    values.set(PREFERENCES_KEY, '{not json')
    expect(new PreferencesStore(storage).get()).toEqual(DEFAULT_PREFERENCES)
  })
})
