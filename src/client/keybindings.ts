import { useSyncExternalStore } from 'react'

/**
 * 工作台快捷键的注册表、默认键位与本地存储。
 *
 * 与 VS Code / DSH 一样，快捷键分成两类：
 *   - **可改**（{@link BINDING_COMMANDS}）：工作台自己处理按键，改了立刻生效，保存在本机 localStorage；
 *   - **固定**（{@link FIXED_SHORTCUTS}）：由 Monaco 编辑器内置提供（查找、替换、注释…），只做展示，
 *     也参与冲突判定 —— 否则用户把「保存」改到 Ctrl+F 时不会有人拦他。
 *
 * 键位用 `KeyboardEvent.code` 而不是 `key`：code 是物理键位，不受输入法/大小写/键盘布局影响，
 * 与 DSH 自己的快捷键配置一致。`ctrl`/`alt`/`shift` 都是「精确匹配」：没写就是「必须没按」。
 */

/** 一条可改命令的键位。 */
export interface KeyBinding {
  /** `KeyboardEvent.code`，例如 `KeyS` / `F4` / `Backquote`。 */
  code: string
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
}

/** 可改命令的 id。 */
export type CommandId =
  | 'editor.save'
  | 'completion.acceptLine'
  | 'view.explorer'
  | 'view.search'
  | 'search.replace'
  | 'view.git'
  | 'search.next'
  | 'search.previous'
  | 'terminal.toggle'
  | 'terminal.new'
  | 'view.chat'
  | 'language.definition'
  | 'language.references'
  | 'language.rename'
  | 'language.documentSymbols'
  | 'language.workspaceSymbols'
  | 'language.quickFix'
  | 'view.problems'
  | 'problems.next'
  | 'problems.previous'

/** 一条可改命令。`defaultBinding` 为 `null` 表示默认不上绑（当前没有这种命令，留着便于以后加）。 */
export interface BindingCommand {
  id: CommandId
  label: string
  group: ShortcutGroup
  defaultBinding: KeyBinding
}

/** 分组标题（设置页里按它分段）。固定键位单列一组，和可改命令区分开。 */
export type ShortcutGroup = '编辑器' | '导航' | '终端' | 'DSH' | '语言服务' | '编辑器内置（不可改）'

/** 由编辑器内置提供、不可改的键位；只用于展示与冲突判定。 */
export interface FixedShortcut {
  id: string
  label: string
  binding: KeyBinding
}

/** 覆盖表：命令 id → 键位；`null` 表示用户解绑了它。没出现的命令用默认键位。 */
export type KeyBindingOverrides = Partial<Record<CommandId, KeyBinding | null>>

/** 存储键：结构变了就换后缀，旧数据自然失效。 */
export const KEYBINDINGS_KEY = 'dvw:keybindings:v1'

/**
 * 可改命令的默认键位。
 *
 * 顺序就是设置页里的展示顺序；labels 与工作台里各处的说法保持一致（「显示或隐藏终端」等），
 * 免得同一件事在两个地方叫两个名字。
 */
export const BINDING_COMMANDS: readonly BindingCommand[] = [
  { id: 'editor.save', label: '保存当前文件', group: '编辑器', defaultBinding: { code: 'KeyS', ctrl: true } },
  { id: 'completion.acceptLine', label: '只采纳补全的下一行', group: '编辑器', defaultBinding: { code: 'ArrowRight', ctrl: true, alt: true } },
  { id: 'view.explorer', label: '资源管理器', group: '导航', defaultBinding: { code: 'KeyE', ctrl: true, shift: true } },
  { id: 'view.search', label: '搜索并聚焦输入框', group: '导航', defaultBinding: { code: 'KeyF', ctrl: true, shift: true } },
  { id: 'search.replace', label: '替换文件', group: '导航', defaultBinding: { code: 'KeyH', ctrl: true, shift: true } },
  { id: 'view.git', label: '源代码管理', group: '导航', defaultBinding: { code: 'KeyG', ctrl: true, shift: true } },
  { id: 'search.next', label: '下一个搜索结果', group: '导航', defaultBinding: { code: 'F4' } },
  { id: 'search.previous', label: '上一个搜索结果', group: '导航', defaultBinding: { code: 'F4', shift: true } },
  { id: 'terminal.toggle', label: '显示或隐藏终端', group: '终端', defaultBinding: { code: 'Backquote', ctrl: true } },
  { id: 'terminal.new', label: '新建终端', group: '终端', defaultBinding: { code: 'Backquote', ctrl: true, shift: true } },
  { id: 'view.chat', label: '显示或隐藏右侧 DSH 对话栏', group: 'DSH', defaultBinding: { code: 'KeyB', ctrl: true, alt: true } },
  // 语言服务：默认键位对齐 VS Code，用户照样可以按自己的习惯改掉。
  { id: 'language.definition', label: '转到定义', group: '语言服务', defaultBinding: { code: 'F12' } },
  { id: 'language.references', label: '查找所有引用', group: '语言服务', defaultBinding: { code: 'F12', shift: true } },
  { id: 'language.rename', label: '重命名符号', group: '语言服务', defaultBinding: { code: 'F2' } },
  { id: 'language.documentSymbols', label: '转到文件中的符号', group: '语言服务', defaultBinding: { code: 'KeyO', ctrl: true, shift: true } },
  { id: 'language.workspaceSymbols', label: '转到工作区中的符号', group: '语言服务', defaultBinding: { code: 'KeyT', ctrl: true } },
  { id: 'language.quickFix', label: '快速修复', group: '语言服务', defaultBinding: { code: 'Period', ctrl: true } },
  { id: 'view.problems', label: '显示或隐藏问题面板', group: '语言服务', defaultBinding: { code: 'KeyM', ctrl: true, shift: true } },
  { id: 'problems.next', label: '下一个问题', group: '语言服务', defaultBinding: { code: 'F8' } },
  { id: 'problems.previous', label: '上一个问题', group: '语言服务', defaultBinding: { code: 'F8', shift: true } },
]

/** 编辑器内置、不可改的键位。 */
export const FIXED_SHORTCUTS: readonly FixedShortcut[] = [
  { id: 'fixed.acceptCompletion', label: '采纳整条补全建议', binding: { code: 'Tab' } },
  { id: 'fixed.acceptWord', label: '采纳补全的下一段', binding: { code: 'ArrowRight', ctrl: true } },
  { id: 'fixed.completion.previous', label: '上一条补全候选', binding: { code: 'BracketLeft', alt: true } },
  { id: 'fixed.completion.next', label: '下一条补全候选', binding: { code: 'BracketRight', alt: true } },
  { id: 'fixed.editor.find', label: '编辑器内查找', binding: { code: 'KeyF', ctrl: true } },
  { id: 'fixed.editor.replace', label: '编辑器内替换', binding: { code: 'KeyH', ctrl: true } },
  { id: 'fixed.editor.gotoLine', label: '转到行', binding: { code: 'KeyG', ctrl: true } },
  { id: 'fixed.editor.comment', label: '注释或取消注释当前行', binding: { code: 'Slash', ctrl: true } },
  { id: 'fixed.editor.format', label: '格式化文档', binding: { code: 'KeyF', shift: true, alt: true } },
  // 鼠标手势也列出来：它和 F12 是同一件事，用户在快捷键面板里查「转到定义」时应当看到。
  { id: 'fixed.language.ctrlClick', label: '按住 Ctrl 点击标识符转到定义', binding: { code: 'Mouse0', ctrl: true } },
]

/** 组合键前缀里各项的显示名。 */
const MODIFIER_LABELS = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' } as const

/** 特殊键位 → 键帽文字。表里没有的按 `KeyX` / `Digit1` / `F4` 规则推导。 */
const KEY_LABELS: Readonly<Record<string, string>> = {
  Backquote: '`', Slash: '/', Comma: ',', Period: '.', Semicolon: ';', Quote: "'", Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Space: '空格', Enter: 'Enter', Escape: 'Esc', Tab: 'Tab',
  Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', Mouse0: '点击',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
}

const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight', 'CapsLock',
])

/** `KeyboardEvent.code` → 键帽文字。 */
export function keyLabel(code: string): string {
  const named = KEY_LABELS[code]
  if (named !== undefined) return named
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^Numpad\d$/.test(code)) return `小键盘${code.slice(6)}`
  if (/^F\d{1,2}$/.test(code)) return code
  return code
}

/** 键位 → 键帽数组，例如 `['Ctrl', 'Shift', 'E']`。 */
export function formatBinding(binding: KeyBinding): string[] {
  const keys: string[] = []
  if (binding.ctrl === true) keys.push(MODIFIER_LABELS.ctrl)
  if (binding.alt === true) keys.push(MODIFIER_LABELS.alt)
  if (binding.shift === true) keys.push(MODIFIER_LABELS.shift)
  keys.push(keyLabel(binding.code))
  return keys
}

/** 两个键位是否完全相同（修饰键按「精确匹配」比较）。 */
export function bindingEquals(left: KeyBinding, right: KeyBinding): boolean {
  return left.code === right.code
    && (left.ctrl === true) === (right.ctrl === true)
    && (left.alt === true) === (right.alt === true)
    && (left.shift === true) === (right.shift === true)
}

/** 事件是否命中该键位：修饰键必须精确相等，多按 Alt/Meta 都不算命中。 */
export function bindingMatches(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>, binding: KeyBinding): boolean {
  return event.code === binding.code && event.metaKey !== true
    && event.ctrlKey === (binding.ctrl === true)
    && event.altKey === (binding.alt === true)
    && event.shiftKey === (binding.shift === true)
}

/**
 * 从一次 `keydown` 里取出键位；不构成键位的事件返回 `undefined`。
 *
 * 排除：输入法组合中、纯修饰键按下、`Meta`（交给宿主）、以及没有 `code` 的合成事件。
 */
export function bindingFromEvent(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'isComposing'>): KeyBinding | undefined {
  if (event.isComposing === true || event.metaKey === true) return undefined
  if (event.code === '' || MODIFIER_CODES.has(event.code)) return undefined
  const binding: KeyBinding = { code: event.code }
  if (event.ctrlKey) binding.ctrl = true
  if (event.altKey) binding.alt = true
  if (event.shiftKey) binding.shift = true
  return binding
}

/** 存储校验：只接受「合法的 code + 布尔修饰键」，其它字段一律丢掉。 */
function normalizeBinding(value: unknown): KeyBinding | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const code = record['code']
  if (typeof code !== 'string' || code === '' || code.length > 40) return undefined
  const binding: KeyBinding = { code }
  for (const flag of ['ctrl', 'alt', 'shift'] as const) {
    const flagValue = record[flag]
    if (flagValue === true) binding[flag] = true
    else if (flagValue !== undefined && flagValue !== false) return undefined
  }
  return binding
}

/** 归一化覆盖表：未知命令、坏键位、与默认值相同的覆盖全部丢弃（与默认值相同不算「已修改」）。 */
export function normalizeOverrides(value: unknown): KeyBindingOverrides {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const result: KeyBindingOverrides = {}
  for (const command of BINDING_COMMANDS) {
    if (!(command.id in record)) continue
    const raw = record[command.id]
    if (raw === null) { result[command.id] = null; continue }
    const binding = normalizeBinding(raw)
    if (binding === undefined || bindingEquals(binding, command.defaultBinding)) continue
    result[command.id] = binding
  }
  return result
}

/** 存储层抽象：测试里换成内存实现，浏览器里就是 localStorage。 */
interface BindingStorage { getItem(key: string): string | null; setItem(key: string, value: string): unknown }

function browserStorage(): BindingStorage | undefined {
  try { return globalThis.localStorage } catch { return undefined }
}

/** 覆盖表的可订阅 store；设置页与工作台各处的按键处理都读同一份。 */
export class KeybindingsStore {
  private current: KeyBindingOverrides
  private readonly listeners = new Set<() => void>()
  private readonly storage: BindingStorage | undefined

  constructor(storage: BindingStorage | undefined = browserStorage()) {
    this.storage = storage
    this.current = this.restore()
  }

  get = (): KeyBindingOverrides => this.current

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 某个命令当前生效的键位：覆盖优先，其次默认值；`null` 表示用户解绑。 */
  bindingOf(id: CommandId): KeyBinding | null {
    if (id in this.current) return this.current[id] ?? null
    return BINDING_COMMANDS.find(command => command.id === id)?.defaultBinding ?? null
  }

  /** 改一个命令的键位；传 `null` 解绑，与默认值相同时回到「未修改」。 */
  set(id: CommandId, binding: KeyBinding | null): KeyBindingOverrides {
    const next: KeyBindingOverrides = { ...this.current }
    const command = BINDING_COMMANDS.find(row => row.id === id)
    if (binding === null) next[id] = null
    else if (command !== undefined && bindingEquals(binding, command.defaultBinding)) delete next[id]
    else next[id] = binding
    return this.commit(next)
  }

  /** 单个命令恢复默认键位。 */
  reset(id: CommandId): KeyBindingOverrides {
    const next: KeyBindingOverrides = { ...this.current }
    delete next[id]
    return this.commit(next)
  }

  /** 全部恢复默认键位。 */
  resetAll(): KeyBindingOverrides { return this.commit({}) }

  private commit(next: KeyBindingOverrides): KeyBindingOverrides {
    this.current = next
    try { this.storage?.setItem(KEYBINDINGS_KEY, JSON.stringify(next)) } catch { /* 隐私模式下写不进去：本次会话内仍然生效。 */ }
    for (const listener of [...this.listeners]) listener()
    return next
  }

  private restore(): KeyBindingOverrides {
    try {
      const raw = this.storage?.getItem(KEYBINDINGS_KEY) ?? null
      return raw === null ? {} : normalizeOverrides(JSON.parse(raw))
    } catch { return {} }
  }
}

/** 浏览器里唯一的键位 store。 */
export const keybindings = new KeybindingsStore()

/** 某个命令当前生效的键位（供各处 keydown 处理实时读取）。 */
export function bindingOf(id: CommandId): KeyBinding | null { return keybindings.bindingOf(id) }

/** 修改一个命令的键位（设置页用）。 */
export function setKeyBinding(id: CommandId, binding: KeyBinding | null): KeyBindingOverrides { return keybindings.set(id, binding) }

/** 单个命令恢复默认键位（设置页用）。 */
export function resetKeyBinding(id: CommandId): KeyBindingOverrides { return keybindings.reset(id) }

/** 全部恢复默认键位（设置页用）。 */
export function resetAllKeyBindings(): KeyBindingOverrides { return keybindings.resetAll() }

/** 已修改的命令数量（解绑也算修改）。 */
export function modifiedShortcutCount(overrides: KeyBindingOverrides = keybindings.get()): number {
  return Object.keys(overrides).length
}

/** React 侧读取覆盖表：改完键位，设置页与工作台立刻反映。 */
export function useKeybindings(): KeyBindingOverrides {
  return useSyncExternalStore(keybindings.subscribe, keybindings.get, keybindings.get)
}

/**
 * 与其它命令冲突的键位。
 *
 * 可改命令用「当前生效」的键位比较（别人被改到同一个组合键也算冲突），固定键位也参与。
 * `selfId` 用来跳过正在编辑的那一条。
 */
export function bindingConflict(binding: KeyBinding, selfId: CommandId, overrides: KeyBindingOverrides = keybindings.get()): { id: string; label: string; fixed: boolean } | undefined {
  for (const command of BINDING_COMMANDS) {
    if (command.id === selfId) continue
    const effective = command.id in overrides ? overrides[command.id] ?? null : command.defaultBinding
    if (effective !== null && bindingEquals(effective, binding)) return { id: command.id, label: command.label, fixed: false }
  }
  for (const fixed of FIXED_SHORTCUTS) {
    if (bindingEquals(fixed.binding, binding)) return { id: fixed.id, label: fixed.label, fixed: true }
  }
  return undefined
}

/** 设置页列表里的一行（可改命令或固定键位）。 */
export interface ShortcutRow {
  id: string
  label: string
  group: ShortcutGroup
  /** 当前生效键位；`null` 表示未绑定（只有可改命令会这样）。 */
  binding: KeyBinding | null
  fixed: boolean
}

/** 全部行（按定义顺序），`overrides` 决定可改命令的当前键位。 */
export function shortcutRows(overrides: KeyBindingOverrides = keybindings.get()): ShortcutRow[] {
  const editable: ShortcutRow[] = BINDING_COMMANDS.map(command => ({
    id: command.id,
    label: command.label,
    group: command.group,
    binding: command.id in overrides ? overrides[command.id] ?? null : command.defaultBinding,
    fixed: false,
  }))
  const fixed: ShortcutRow[] = FIXED_SHORTCUTS.map(row => ({ id: row.id, label: row.label, group: '编辑器内置（不可改）' as const, binding: row.binding, fixed: true }))
  return [...editable, ...fixed]
}

/**
 * 搜索：命令名按子串匹配，键帽按**整词**匹配（`ctrl` / `shift` / `e`）。
 *
 * 键帽不能按子串匹配：`shift` 里含 `f`，按子串搜「ctrl shift f」会把所有带 Shift 的命令都命中。
 * 固定键位也参与搜索 —— 用户想确认「Ctrl+F 现在是什么」时，它们必须出现。
 */
export function searchShortcutRows(query: string, overrides: KeyBindingOverrides = keybindings.get()): ShortcutRow[] {
  const rows = shortcutRows(overrides)
  const needle = query.trim().toLowerCase()
  if (needle === '') return rows
  const terms = needle.split(/\s+/)
  return rows.filter(row => {
    const label = row.label.toLowerCase()
    const keyTokens = (row.binding === null ? ['未绑定'] : formatBinding(row.binding)).map(key => key.toLowerCase())
    return terms.every(term => label.includes(term) || keyTokens.includes(term))
  })
}
