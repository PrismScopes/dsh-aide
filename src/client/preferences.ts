/**
 * 工作台的界面偏好。
 *
 * 这里只放**只影响浏览器呈现**的选项：编辑器排版（字号、行高、制表符、换行、缩略图……）、
 * 行内补全的总开关与触发节奏、终端字号。它们存 localStorage —— 换台机器、换个浏览器就该是
 * 各自的样子；而补全用哪条模型路由、失败要不要回落本地兜底属于「宿主怎么执行」，存在数据目录的
 * 设置文件里（见 completion/settings.ts）。两类偏好都在设置页里改，但落点不同，所以分成两个模块
 * 而不是塞进一个 preferences。
 *
 * 注意：字段名与语义是对外契约（Workbench / MonacoEditor / ClosePrompt / TerminalPanel 都按它读），
 * 加字段可以，改名或改变量的含义会悄悄改变这些组件的行为。
 */
import { useSyncExternalStore } from 'react'

/** 自动换行：off 不折行；on 按可视宽度折行；bounded 在 editorWordWrapColumn 处折行。 */
export type WordWrapMode = 'off' | 'on' | 'bounded'
/** 空白字符的显示范围：none 不显示；selection 仅在选区；all 全部（空格画点、制表符画箭头）。 */
export type RenderWhitespace = 'none' | 'selection' | 'all'
/** 光标形状。 */
export type CursorStyle = 'line' | 'block' | 'underline'
/** 自动保存：off 关闭；afterDelay 在最后一次改动静默若干毫秒后保存。 */
export type AutoSaveMode = 'off' | 'afterDelay'

export interface WorkbenchPreferences {
  /** 关闭后编辑器不再请求补全：一次模型调用都不会发出，也不再有幻影文本。 */
  completionEnabled: boolean
  /** 补全触发延迟（ms）：停止输入多久后才向模型发请求。太短会把每次停顿都变成一次调用。 */
  completionDebounceMs: number
  /** 编辑器字号（px）。 */
  editorFontSize: number
  /** 编辑器行高（px）。0 = 交给 Monaco 按字号自动计算。 */
  editorLineHeight: number
  /** 一个制表位等于几个空格列。 */
  editorTabSize: number
  /** 按 Tab 时插入空格而不是制表符；关闭后插入真正的 \t（影响保存到磁盘的内容）。 */
  editorInsertSpaces: boolean
  /** 自动换行模式。 */
  editorWordWrap: WordWrapMode
  /** 自动换行取 bounded 时的折行列号；其余模式忽略。 */
  editorWordWrapColumn: number
  /** 编辑器右侧的代码缩略图。关闭后只留滚动条。 */
  editorMinimap: boolean
  /** 滚动条右侧的概览标尺（VS Code 那条细长的全局预览）。 */
  editorOverviewRuler: boolean
  /** 划词后全文同类词高亮（Monaco 的 occurrencesHighlight / selectionHighlight）。 */
  editorOccurrencesHighlight: boolean
  /** 空白字符的显示范围。 */
  editorRenderWhitespace: RenderWhitespace
  /** 光标形状。 */
  editorCursorStyle: CursorStyle
  /** 平滑滚动。 */
  editorSmoothScrolling: boolean
  /** 粘性滚动：滚动时把当前作用域（函数/类）的头部行钉在顶部。 */
  editorStickyScroll: boolean
  /** 自动保存模式。 */
  editorAutoSave: AutoSaveMode
  /** 自动保存的静默延迟（ms），仅 editorAutoSave === 'afterDelay' 时生效。 */
  editorAutoSaveDelayMs: number
  /** 终端（xterm）字号（px）。只写偏好，由终端面板读取后应用。 */
  terminalFontSize: number
}

/**
 * 每个数值项的取值范围。设置页的步进器直接取这里的 min/max，越界输入在 normalizePreferences
 * 里夹取 —— 控件与校验共用一份数字，避免两处各写一套然后慢慢漂移。
 *
 * editorLineHeight 的取值域不连续：0 表示「自动」，其余合法值是 16–40（比字号还小的行高会把字
 * 压在一起）。所以 min 记 0、max 记 40，中间那段由 normalizePreferences 单独处理。
 */
export const PREFERENCE_LIMITS = {
  completionDebounceMs: { min: 40, max: 500 },
  editorFontSize: { min: 11, max: 24 },
  editorLineHeight: { min: 0, max: 40 },
  editorTabSize: { min: 1, max: 8 },
  editorWordWrapColumn: { min: 40, max: 200 },
  editorAutoSaveDelayMs: { min: 500, max: 10000 },
  terminalFontSize: { min: 10, max: 20 },
} as const

/** 行高的合法下限（0 之外）。见 PREFERENCE_LIMITS.editorLineHeight 的说明。 */
export const EDITOR_LINE_HEIGHT_MIN = 16

export const DEFAULT_PREFERENCES: WorkbenchPreferences = {
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
}

/** 键名带 v1：老版本存进去的就是这一份结构。新增字段从默认值补齐，不需要换 key。 */
export const PREFERENCES_KEY = 'dvw:workbench:prefs:v1'

interface PreferenceStorage { getItem(key: string): string | null; setItem(key: string, value: string): unknown }

function browserStorage(): PreferenceStorage | undefined {
  try { return globalThis.localStorage } catch { return undefined }
}

/** 取一个有限数值并夹到 [min,max]；类型不对或不是有限数时返回默认值。 */
function clampNumber(value: unknown, limits: { min: number; max: number }, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(limits.min, Math.min(limits.max, Math.round(value)))
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * 行高：0 是「自动」这个有意义的取值，不能简单夹到 16；1–15 之间是无效区，向上夹到 16，
 * 负数与 0 一起归为自动，超过 40 夹到 40。坏值（非数字）回落默认 0。
 */
function normalizeLineHeight(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_PREFERENCES.editorLineHeight
  const rounded = Math.round(value)
  if (rounded <= 0) return 0
  return Math.max(EDITOR_LINE_HEIGHT_MIN, Math.min(PREFERENCE_LIMITS.editorLineHeight.max, rounded))
}

/** 枚举字段：只接受已知字面量，其余（含旧版本写成布尔值的字段）回落默认值。 */
function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
}

/**
 * 逐字段校验并夹取范围：一份写坏的存储只让出错的那一项回到默认值，
 * 其余偏好仍然生效 —— 不要因为一个字段的类型不对把整页设置清空。
 *
 * 这是偏好归一化的唯一实现：editorOptions.ts 的映射入口也调用它（见其文件头），
 * 默认值、取值范围与 lineHeight 特殊规则都只在 preferences.ts 维护一份。
 */
export function normalizePreferences(value: unknown): WorkbenchPreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ...DEFAULT_PREFERENCES }
  const record = value as Record<string, unknown>
  // 老版本把自动换行存成布尔值：true 语义上等于「按窗口宽度折行」，迁移成新的枚举而不是丢掉。
  const legacyWordWrap = record['editorWordWrap']
  const wordWrap = typeof legacyWordWrap === 'boolean'
    ? (legacyWordWrap ? 'on' : 'off')
    : enumValue(legacyWordWrap, ['off', 'on', 'bounded'] as const, DEFAULT_PREFERENCES.editorWordWrap)
  return {
    completionEnabled: booleanValue(record['completionEnabled'], DEFAULT_PREFERENCES.completionEnabled),
    completionDebounceMs: clampNumber(record['completionDebounceMs'], PREFERENCE_LIMITS.completionDebounceMs, DEFAULT_PREFERENCES.completionDebounceMs),
    editorFontSize: clampNumber(record['editorFontSize'], PREFERENCE_LIMITS.editorFontSize, DEFAULT_PREFERENCES.editorFontSize),
    editorLineHeight: normalizeLineHeight(record['editorLineHeight']),
    editorTabSize: clampNumber(record['editorTabSize'], PREFERENCE_LIMITS.editorTabSize, DEFAULT_PREFERENCES.editorTabSize),
    editorInsertSpaces: booleanValue(record['editorInsertSpaces'], DEFAULT_PREFERENCES.editorInsertSpaces),
    editorWordWrap: wordWrap,
    editorWordWrapColumn: clampNumber(record['editorWordWrapColumn'], PREFERENCE_LIMITS.editorWordWrapColumn, DEFAULT_PREFERENCES.editorWordWrapColumn),
    editorMinimap: booleanValue(record['editorMinimap'], DEFAULT_PREFERENCES.editorMinimap),
    editorOverviewRuler: booleanValue(record['editorOverviewRuler'], DEFAULT_PREFERENCES.editorOverviewRuler),
    editorOccurrencesHighlight: booleanValue(record['editorOccurrencesHighlight'], DEFAULT_PREFERENCES.editorOccurrencesHighlight),
    editorRenderWhitespace: enumValue(record['editorRenderWhitespace'], ['none', 'selection', 'all'] as const, DEFAULT_PREFERENCES.editorRenderWhitespace),
    editorCursorStyle: enumValue(record['editorCursorStyle'], ['line', 'block', 'underline'] as const, DEFAULT_PREFERENCES.editorCursorStyle),
    editorSmoothScrolling: booleanValue(record['editorSmoothScrolling'], DEFAULT_PREFERENCES.editorSmoothScrolling),
    editorStickyScroll: booleanValue(record['editorStickyScroll'], DEFAULT_PREFERENCES.editorStickyScroll),
    editorAutoSave: enumValue(record['editorAutoSave'], ['off', 'afterDelay'] as const, DEFAULT_PREFERENCES.editorAutoSave),
    editorAutoSaveDelayMs: clampNumber(record['editorAutoSaveDelayMs'], PREFERENCE_LIMITS.editorAutoSaveDelayMs, DEFAULT_PREFERENCES.editorAutoSaveDelayMs),
    terminalFontSize: clampNumber(record['terminalFontSize'], PREFERENCE_LIMITS.terminalFontSize, DEFAULT_PREFERENCES.terminalFontSize),
  }
}

/**
 * 偏好存储。
 *
 * 做成一个可订阅的小 store 而不是 React 状态：设置页、工作台、每个编辑器实例都是独立的组件树
 * （设置页在 DSH 的设置面板里，工作台是另一层 overlay），改一处要立刻反映到所有实例。
 * `get` / `subscribe` 是箭头字段：useSyncExternalStore 要求它们的标识稳定。
 */
export class PreferencesStore {
  private current: WorkbenchPreferences
  private readonly listeners = new Set<() => void>()
  private readonly storage: PreferenceStorage | undefined

  constructor(storage: PreferenceStorage | undefined = browserStorage()) {
    this.storage = storage
    this.current = this.restore()
  }

  get = (): WorkbenchPreferences => this.current

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 合并一批改动并落盘；返回夹取之后的完整偏好。 */
  set(patch: Partial<WorkbenchPreferences>): WorkbenchPreferences {
    this.current = normalizePreferences({ ...this.current, ...patch })
    try { this.storage?.setItem(PREFERENCES_KEY, JSON.stringify(this.current)) } catch { /* 隐私模式下存储可能被拒，内存里的偏好仍然生效。 */ }
    for (const listener of [...this.listeners]) listener()
    return this.current
  }

  /** 恢复全部默认值。设置页的「恢复默认设置」走这里，免得调用方自己拼整份默认对象。 */
  reset(): WorkbenchPreferences { return this.set({ ...DEFAULT_PREFERENCES }) }

  private restore(): WorkbenchPreferences {
    try {
      const raw = this.storage?.getItem(PREFERENCES_KEY) ?? null
      return raw === null ? { ...DEFAULT_PREFERENCES } : normalizePreferences(JSON.parse(raw))
    } catch { return { ...DEFAULT_PREFERENCES } }
  }
}

/** 浏览器里唯一的偏好 store。 */
export const preferences = new PreferencesStore()

export function getPreferences(): WorkbenchPreferences { return preferences.get() }

export function updatePreferences(patch: Partial<WorkbenchPreferences>): WorkbenchPreferences { return preferences.set(patch) }

/** 恢复全部默认值（设置页「恢复默认设置」按钮的落点）。 */
export function resetPreferences(): WorkbenchPreferences { return preferences.reset() }

/** React 侧读取：偏好一变，用到它的组件立刻重渲染（字体大小不必刷新页面）。 */
export function usePreferences(): WorkbenchPreferences {
  return useSyncExternalStore(preferences.subscribe, preferences.get, preferences.get)
}
