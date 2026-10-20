/**
 * 工作台的界面偏好。
 *
 * 这里只放**只影响浏览器呈现**的选项：编辑器字号、自动换行、缩略图、以及行内补全的总开关。
 * 它们存 localStorage —— 换台机器、换个浏览器就该是各自的样子；而补全用哪条模型路由、失败要不要
 * 回落本地兜底属于「宿主怎么执行」，存在数据目录的设置文件里（见 completion/settings.ts）。
 * 两类偏好都在设置页里改，但落点不同，所以分成两个模块而不是塞进一个 preferences。
 */
import { useSyncExternalStore } from 'react'

export interface WorkbenchPreferences {
  /** 关闭后编辑器不再请求补全：一次模型调用都不会发出，也不再有幻影文本。 */
  completionEnabled: boolean
  /** 编辑器字号（px）。改之前是写死的 14。 */
  editorFontSize: number
  editorWordWrap: boolean
  editorMinimap: boolean
}

export const PREFERENCE_LIMITS = { editorFontSize: { min: 11, max: 20 } } as const

export const DEFAULT_PREFERENCES: WorkbenchPreferences = {
  completionEnabled: true,
  editorFontSize: 14,
  editorWordWrap: false,
  editorMinimap: false,
}

export const PREFERENCES_KEY = 'dvw:workbench:prefs:v1'

interface PreferenceStorage { getItem(key: string): string | null; setItem(key: string, value: string): unknown }

function browserStorage(): PreferenceStorage | undefined {
  try { return globalThis.localStorage } catch { return undefined }
}

/**
 * 逐字段校验并夹取范围：一份写坏的存储只让出错的那一项回到默认值，
 * 其余偏好仍然生效 —— 不要因为一个字段的类型不对把整页设置清空。
 */
export function normalizePreferences(value: unknown): WorkbenchPreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ...DEFAULT_PREFERENCES }
  const record = value as Record<string, unknown>
  const { min, max } = PREFERENCE_LIMITS.editorFontSize
  const size = record['editorFontSize']
  const fontSize = typeof size === 'number' && Number.isFinite(size)
    ? Math.max(min, Math.min(max, Math.round(size)))
    : DEFAULT_PREFERENCES.editorFontSize
  const flag = (key: 'completionEnabled' | 'editorWordWrap' | 'editorMinimap'): boolean =>
    typeof record[key] === 'boolean' ? record[key] === true : DEFAULT_PREFERENCES[key]
  return {
    completionEnabled: flag('completionEnabled'),
    editorFontSize: fontSize,
    editorWordWrap: flag('editorWordWrap'),
    editorMinimap: flag('editorMinimap'),
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

/** 订阅偏好变化（给编辑器与设置页共用）。 */
export function subscribePreferences(listener: () => void): () => void { return preferences.subscribe(listener) }

/** React 侧读取：偏好一变，用到它的组件立刻重渲染（字体大小不必刷新页面）。 */
export function usePreferences(): WorkbenchPreferences {
  return useSyncExternalStore(preferences.subscribe, preferences.get, preferences.get)
}
