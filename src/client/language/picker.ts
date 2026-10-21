/**
 * 语言服务与工作台之间的「弹出层」契约。
 *
 * 动作（转到定义、引用列表、符号搜索、重命名输入框）是在编辑器事件/键盘处理里触发的，
 * 不在 React 树里，没法直接渲染 QuickPick。让 Workbench 统一渲染最省事：
 * 动作派发一个请求事件，Workbench 用现有的 QuickPick 组件显示并回调。
 * 这样弹层层级、样式、键盘行为都只有一份实现。
 */
import type { QuickPickItem } from '../quickPick.tsx'

/** QuickPick 的一行；id 由动作自己定义（通常是目标下标）。 */
export interface LanguagePickerItem extends QuickPickItem {}

export interface LanguagePickerRequest {
  title: string
  placeholder?: string
  items?: readonly LanguagePickerItem[]
  /**
   * 动态搜索：输入变化时调用。`update` 用于回填结果；Workbench 负责防抖与丢弃过期结果。
   * 提供它时 items 初始可以为空。
   */
  search?(query: string, update: (items: readonly LanguagePickerItem[]) => void): void
  /** 输入模式（重命名等）：回车提交输入文本。 */
  submitLabel?(value: string): string
  allowEmpty?: boolean
  onSubmit?(value: string): void
  onPick?(id: string): void
}

/** 请求 Workbench 渲染一个语言服务弹层。 */
export function openLanguagePicker(request: LanguagePickerRequest): void {
  window.dispatchEvent(new CustomEvent(LANGUAGE_PICKER_EVENT, { detail: request }))
}

export const LANGUAGE_PICKER_EVENT = 'dvw-language-picker'

/** 跳到某个绝对路径的位置：由 Workbench 决定是切标签还是开只读的外部文件。 */
export interface OpenLocationDetail { path: string; line?: number; column?: number }

export function openLocationAt(path: string, line?: number, column?: number): void {
  window.dispatchEvent(new CustomEvent(OPEN_LOCATION_EVENT, { detail: { path, line, column } }))
}

export const OPEN_LOCATION_EVENT = 'dvw-open-location'

/** 语言服务给用户的一句提示（找不到定义、重命名失败等）。 */
export interface LanguageMessageDetail { text: string; tone: 'info' | 'warn' | 'error' }

export function notifyLanguage(text: string, tone: LanguageMessageDetail['tone'] = 'info'): void {
  window.dispatchEvent(new CustomEvent(LANGUAGE_MESSAGE_EVENT, { detail: { text, tone } }))
}

export const LANGUAGE_MESSAGE_EVENT = 'dvw-language-message'

/** 让 Workbench 切换问题面板。 */
export function toggleProblemsPanel(): void {
  window.dispatchEvent(new Event(PROBLEMS_TOGGLE_EVENT))
}

export const PROBLEMS_TOGGLE_EVENT = 'dvw-problems-toggle'
