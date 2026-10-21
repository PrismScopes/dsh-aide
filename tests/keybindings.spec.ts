import { describe, expect, it } from 'vitest'
import {
  BINDING_COMMANDS,
  FIXED_SHORTCUTS,
  KEYBINDINGS_KEY,
  KeybindingsStore,
  bindingConflict,
  bindingEquals,
  bindingFromEvent,
  bindingMatches,
  formatBinding,
  keyLabel,
  modifiedShortcutCount,
  normalizeOverrides,
  searchShortcutRows,
  shortcutRows,
} from '../src/client/keybindings.ts'

/** 内存版存储：与 preferences 的测试做法一致，不碰真实 localStorage。 */
function storage(initial?: string) {
  const map = new Map<string, string>()
  if (initial !== undefined) map.set(KEYBINDINGS_KEY, initial)
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    raw: () => map.get(KEYBINDINGS_KEY) ?? null,
  }
}

type KeyEvent = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'isComposing'>

function key(code: string, modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}): KeyEvent {
  return { code, ctrlKey: modifiers.ctrl ?? false, altKey: modifiers.alt ?? false, shiftKey: modifiers.shift ?? false, metaKey: modifiers.meta ?? false, isComposing: false }
}

describe('快捷键注册表', () => {
  it('ships the documented defaults for every editable command', () => {
    const store = new KeybindingsStore(storage())
    expect(store.bindingOf('editor.save')).toEqual({ code: 'KeyS', ctrl: true })
    expect(store.bindingOf('search.next')).toEqual({ code: 'F4' })
    expect(store.bindingOf('terminal.new')).toEqual({ code: 'Backquote', ctrl: true, shift: true })
    // 默认没改过：覆盖表是空的。
    expect(modifiedShortcutCount(store.get())).toBe(0)
  })

  it('formats keycaps the way the settings page shows them', () => {
    expect(formatBinding({ code: 'KeyE', ctrl: true, shift: true })).toEqual(['Ctrl', 'Shift', 'E'])
    expect(formatBinding({ code: 'Backquote', ctrl: true })).toEqual(['Ctrl', '`'])
    expect(formatBinding({ code: 'ArrowRight', ctrl: true, alt: true })).toEqual(['Ctrl', 'Alt', '→'])
    expect(formatBinding({ code: 'F4', shift: true })).toEqual(['Shift', 'F4'])
    expect(keyLabel('Digit1')).toBe('1')
    expect(keyLabel('Numpad4')).toBe('小键盘4')
  })

  it('matches a binding only when the modifiers are exactly right', () => {
    const saved = { code: 'KeyS', ctrl: true }
    expect(bindingMatches(key('KeyS', { ctrl: true }), saved)).toBe(true)
    expect(bindingMatches(key('KeyS', { ctrl: true, shift: true }), saved)).toBe(false)
    expect(bindingMatches(key('KeyS', { ctrl: true, meta: true }), saved)).toBe(false)
    expect(bindingMatches(key('KeyS'), saved)).toBe(false)
    // 纯 F4 与 Shift+F4 互不命中：这正是「下一个/上一个搜索结果」要区分的两种按键。
    expect(bindingMatches(key('F4'), { code: 'F4' })).toBe(true)
    expect(bindingMatches(key('F4', { shift: true }), { code: 'F4' })).toBe(false)
  })

  it('captures a binding from a keydown and ignores non-bindable events', () => {
    expect(bindingFromEvent(key('KeyE', { ctrl: true, shift: true }))).toEqual({ code: 'KeyE', ctrl: true, shift: true })
    expect(bindingFromEvent(key('F4'))).toEqual({ code: 'F4' })
    // 纯修饰键、输入法组合中、带 Meta 的事件都不构成键位。
    expect(bindingFromEvent(key('ControlLeft', { ctrl: true }))).toBeUndefined()
    expect(bindingFromEvent({ ...key('KeyE'), isComposing: true })).toBeUndefined()
    expect(bindingFromEvent(key('KeyE', { meta: true }))).toBeUndefined()
    expect(bindingFromEvent(key(''))).toBeUndefined()
  })

  it('normalizes stored overrides: unknown ids, broken values and defaults are dropped', () => {
    expect(normalizeOverrides(null)).toEqual({})
    expect(normalizeOverrides([])).toEqual({})
    expect(normalizeOverrides({
      'editor.save': { code: 'KeyQ', ctrl: true },
      'made.up': { code: 'KeyX' },
      'view.chat': { code: 42 },
      'search.next': null,
      'view.git': { code: 'KeyG', ctrl: true, shift: true }, // 与默认值相同 → 不算修改
    })).toEqual({ 'editor.save': { code: 'KeyQ', ctrl: true }, 'search.next': null })
  })

  it('persists edits per binding and restores them for a new store', () => {
    const memory = storage()
    const store = new KeybindingsStore(memory)
    store.set('editor.save', { code: 'KeyQ', ctrl: true })
    store.set('search.next', null)
    expect(modifiedShortcutCount(store.get())).toBe(2)
    expect(store.bindingOf('editor.save')).toEqual({ code: 'KeyQ', ctrl: true })
    expect(store.bindingOf('search.next')).toBeNull()

    const restored = new KeybindingsStore(memory)
    expect(restored.bindingOf('editor.save')).toEqual({ code: 'KeyQ', ctrl: true })
    expect(restored.bindingOf('search.next')).toBeNull()

    // 改成默认值等于撤销这条覆盖；单条恢复默认与全部恢复默认都落盘。
    restored.set('editor.save', { code: 'KeyS', ctrl: true })
    expect(modifiedShortcutCount(restored.get())).toBe(1)
    restored.reset('search.next')
    expect(modifiedShortcutCount(restored.get())).toBe(0)
    expect(new KeybindingsStore(memory).get()).toEqual({})
    store.set('view.chat', { code: 'KeyB', ctrl: true, alt: true })
    store.resetAll()
    expect(memory.raw()).toBe('{}')
  })

  it('reports conflicts against other editable commands and the fixed editor keys', () => {
    const store = new KeybindingsStore(storage())
    expect(bindingConflict({ code: 'KeyE', ctrl: true, shift: true }, 'editor.save', store.get()))
      .toEqual({ id: 'view.explorer', label: '资源管理器', fixed: false })
    // 固定键位（编辑器内置）也要拦住：Ctrl+F 是编辑器内查找。
    expect(bindingConflict({ code: 'KeyF', ctrl: true }, 'editor.save', store.get()))
      .toEqual({ id: 'fixed.editor.find', label: '编辑器内查找', fixed: true })
    // 自己不算冲突。
    expect(bindingConflict({ code: 'KeyS', ctrl: true }, 'editor.save', store.get())).toBeUndefined()
    // 别人被改到同一个键也算冲突。
    const overridden = { 'view.git': { code: 'KeyQ', ctrl: true } } as const
    expect(bindingConflict({ code: 'KeyQ', ctrl: true }, 'editor.save', overridden)).toMatchObject({ id: 'view.git' })
    expect(bindingEquals({ code: 'KeyS', ctrl: true }, { code: 'KeyS', ctrl: true })).toBe(true)
  })

  it('lists editable commands first, then the fixed editor keys', () => {
    const rows = shortcutRows({})
    expect(rows).toHaveLength(BINDING_COMMANDS.length + FIXED_SHORTCUTS.length)
    expect(rows[0]).toMatchObject({ id: 'editor.save', fixed: false, binding: { code: 'KeyS', ctrl: true } })
    expect(rows.at(-1)).toMatchObject({ fixed: true })
    // 分组顺序来自定义顺序：编辑器 → 导航 → 终端 → DSH → 语言服务。
    expect([...new Set(rows.filter(row => !row.fixed).map(row => row.group))]).toEqual(['编辑器', '导航', '终端', 'DSH', '语言服务'])
  })

  it('searches by command name or by the keys currently bound', () => {
    const rows = searchShortcutRows('终端')
    expect(rows.map(row => row.label)).toEqual(['显示或隐藏终端', '新建终端'])
    // 键帽按整词匹配：`ctrl shift e` 只命中 Ctrl+Shift+E，不会因为 `shift` 里含 `f` 把 Ctrl+Shift+F 也带出来。
    expect(searchShortcutRows('ctrl shift e').map(row => row.label)).toEqual(['资源管理器'])
    expect(searchShortcutRows('ctrl shift f').map(row => row.label)).toEqual(['搜索并聚焦输入框'])
    // 固定键位也能按键帽搜到（Ctrl+F 是编辑器内查找）；先命中可改命令，再列固定项。
    expect(searchShortcutRows('ctrl f').map(row => row.label)).toEqual(['搜索并聚焦输入框', '编辑器内查找'])
    // 「查找」同时命中语言服务的「查找所有引用」与编辑器内置查找；先可改命令、后固定键位。
    expect(searchShortcutRows('查找').map(row => row.label)).toEqual(['查找所有引用', '编辑器内查找'])
    // 未绑定的命令也能按「未绑定」搜到。
    const memory = storage()
    const store = new KeybindingsStore(memory)
    store.set('terminal.toggle', null)
    expect(searchShortcutRows('未绑定', store.get()).map(row => row.label)).toContain('显示或隐藏终端')
    expect(searchShortcutRows('不存在的命令')).toEqual([])
  })
})
