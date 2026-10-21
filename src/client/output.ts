import { useSyncExternalStore } from 'react'

/**
 * 「输出」面板的日志存储。
 *
 * 为什么要单独一层：输出是**跨模块追加、面板单点消费**的数据 —— 语言服务的 LSP 日志、Git 命令记录、
 * 以后可能还有补全/终端事件，都会往这里追加；而面板可能没挂载（切到问题/终端时），
 * 追加不能依赖组件存在。做成模块级 store 后，面板挂载时能直接读回最近的历史。
 *
 * 语义照 VS Code 的 Output 视图：
 * - 按**通道**分组，同一时刻只显示一个通道；
 * - 每个通道是环形缓冲（超过上限丢最旧的），避免长期运行把内存吃满；
 * - 只追加纯文本 + 级别，时间戳由面板统一格式化 —— 存储层不碰 DOM、不做本地化。
 */
export type OutputChannel = 'language' | 'git'
export type OutputLevel = 'info' | 'warn' | 'error'

export interface OutputLine {
  at: number
  level: OutputLevel
  text: string
}

/** 每个通道保留的行数。语言服务出错时可能连续输出，500 行足够定位最近一次问题。 */
export const OUTPUT_LIMIT = 500

const EMPTY: readonly OutputLine[] = []
const EMPTY_CHANNELS: Record<OutputChannel, readonly OutputLine[]> = { language: EMPTY, git: EMPTY }

let channels: Record<OutputChannel, readonly OutputLine[]> = EMPTY_CHANNELS
const listeners = new Set<() => void>()

function emit(): void { for (const listener of [...listeners]) listener() }

/** 追加一行。`text` 里的换行原样保留，面板用 pre-wrap 渲染多行错误。 */
export function appendOutput(channel: OutputChannel, text: string, level: OutputLevel = 'info'): void {
  const previous = channels[channel]
  const next = [...previous, { at: Date.now(), level, text }]
  channels = {
    ...channels,
    [channel]: next.length > OUTPUT_LIMIT ? next.slice(next.length - OUTPUT_LIMIT) : next,
  }
  emit()
}

/** 清空一个通道（面板的「清空」按钮；只影响当前通道）。 */
export function clearOutput(channel: OutputChannel): void {
  if (channels[channel].length === 0) return
  channels = { ...channels, [channel]: EMPTY }
  emit()
}

/** 通道当前快照；没有变化时返回同一个引用，useSyncExternalStore 不会重复渲染。 */
export function outputLines(channel: OutputChannel): readonly OutputLine[] { return channels[channel] }

export function subscribeOutput(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 面板读取一个通道；同一时刻只有一个输出面板，所以不需要按工作区区分。 */
export function useOutputLines(channel: OutputChannel): readonly OutputLine[] {
  return useSyncExternalStore(subscribeOutput, () => outputLines(channel), () => outputLines(channel))
}

/** 测试用：清空全部通道并恢复初始快照。 */
export function resetOutput(): void {
  channels = EMPTY_CHANNELS
  emit()
}
