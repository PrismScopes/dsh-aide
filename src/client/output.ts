import { useSyncExternalStore } from 'react'

/**
 * 「输出」面板的日志存储。
 *
 * 为什么要单独一层：输出是**跨模块追加、面板单点消费**的数据 —— 语言服务的 LSP 日志、Git 命令记录、
 * 以后可能还有补全/终端事件，都会往这里追加；而面板可能没挂载（切到问题/终端时），
 * 追加不能依赖组件存在。做成模块级 store 后，面板挂载时能直接读回最近的历史。
 *
 * 语义照 VS Code 的 Output 视图：
 * - 按**通道**分组，同一时刻只显示一个通道；通道选择由面板持久化（见 readOutputChannel / saveOutputChannel）；
 * - 每个通道是环形缓冲（超过上限丢最旧的），避免长期运行把内存吃满；
 * - 只追加纯文本 + 级别，时间戳由面板统一格式化 —— 存储层不碰 DOM、不做本地化。
 *
 * 级别从最初的三级（info/warn/error）扩到五级（trace/debug/info/warn/error）：
 * 旧调用方传的 info/warn/error 仍然是合法值，运行时还兼容 warning/log/verbose 这类别名
 * （normalizeLevel），不会因为日志来源写得随意就丢行。
 *
 * 过滤是**视图层**的事：这里只提供纯函数（filterOutputLines / countOutputLevels），
 * 被过滤掉的行仍留在 store 里 → 重新打开某级别立即恢复，不需要重新采集。
 */

export type OutputChannel = 'language' | 'git'

/** 通道枚举：持久化校验与测试共用，避免各处再拼一遍字面量。 */
export const OUTPUT_CHANNELS: readonly OutputChannel[] = ['language', 'git']

/** 五级日志级别，从最啰嗦到最严重。 */
export type OutputLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

/** 展示顺序（过滤按钮也按这个顺序）。 */
export const OUTPUT_LEVELS: readonly OutputLevel[] = ['trace', 'debug', 'info', 'warn', 'error']

/** 级别中文名（全中文 UI；存储层只放文案，不做本地化框架）。 */
export const OUTPUT_LEVEL_LABEL: Readonly<Record<OutputLevel, string>> = {
  trace: '跟踪',
  debug: '调试',
  info: '信息',
  warn: '警告',
  error: '错误',
}

export interface OutputLine {
  at: number
  level: OutputLevel
  text: string
}

/** 每个通道保留的行数。五级输出（尤其 trace/debug）比原来啰嗦，给到 4000 行仍只占几 MB。 */
export const OUTPUT_LIMIT = 4000

/** 活动通道的持久化键；面板切换通道时写入，下次打开恢复。 */
export const OUTPUT_CHANNEL_KEY = 'dvw:output:channel'

export function isOutputChannel(value: unknown): value is OutputChannel {
  return typeof value === 'string' && (OUTPUT_CHANNELS as readonly string[]).includes(value)
}

/**
 * 级别归一化：新五级 + 旧值/常见别名。
 * 未知值回落 info（宁可少标一个级别，也不丢一行输出）。
 */
export function normalizeLevel(value: unknown): OutputLevel {
  if (typeof value !== 'string') return 'info'
  switch (value.trim().toLowerCase()) {
    case 'trace':
    case 'verbose':
      return 'trace'
    case 'debug':
      return 'debug'
    case 'info':
    case 'log':
    case 'notice':
      return 'info'
    case 'warn':
    case 'warning':
      return 'warn'
    case 'error':
    case 'err':
    case 'fatal':
      return 'error'
    default:
      return 'info'
  }
}

const EMPTY: readonly OutputLine[] = []
const EMPTY_CHANNELS: Record<OutputChannel, readonly OutputLine[]> = { language: EMPTY, git: EMPTY }

let channels: Record<OutputChannel, readonly OutputLine[]> = EMPTY_CHANNELS
const listeners = new Set<() => void>()

function emit(): void { for (const listener of [...listeners]) listener() }

/**
 * 把一段文本拆成行：`append` 的多行错误在虚拟化里必须是固定高度的独立行，
 * 所以存储层就把换行拆开（`\r\n` / `\r` / `\n` 都算）；末尾换行不产生空行。
 */
function splitText(text: string): string[] {
  const parts = text.split(/\r\n|\r|\n/)
  if (parts.length > 1 && parts.at(-1) === '') parts.pop()
  return parts
}

/** 追加一行（或多行文本）。`text` 里的换行会被拆成多行，级别沿用同一次调用的值。 */
export function appendOutput(channel: OutputChannel, text: string, level: OutputLevel = 'info'): void {
  const previous = channels[channel]
  const at = Date.now()
  const normalized = normalizeLevel(level)
  const next = [...previous, ...splitText(text).map(part => ({ at, level: normalized, text: part }))]
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

/* ────────────────────────────── 视图层纯函数（过滤/计数） ────────────────────────────── */

/** 五级过滤开关；默认全开（关闭只是隐藏，不删数据）。 */
export interface OutputLevelFilters {
  trace: boolean
  debug: boolean
  info: boolean
  warn: boolean
  error: boolean
}

export const DEFAULT_OUTPUT_LEVEL_FILTERS: OutputLevelFilters = { trace: true, debug: true, info: true, warn: true, error: true }

/** 各级别行数：过滤按钮上的计数来自**整条通道**（与当前展示是否被过滤无关）。 */
export function countOutputLevels(lines: readonly OutputLine[]): Record<OutputLevel, number> {
  const counts: Record<OutputLevel, number> = { trace: 0, debug: 0, info: 0, warn: 0, error: 0 }
  for (const line of lines) counts[line.level]++
  return counts
}

/**
 * 级别 + 文本过滤。没有任何过滤条件时直接返回原数组（快照引用不变，面板不白重算）。
 * 文本匹配大小写不敏感，只匹配消息正文（时间戳不参与）。
 */
export function filterOutputLines(lines: readonly OutputLine[], filters: OutputLevelFilters, query: string): readonly OutputLine[] {
  const needle = query.trim().toLowerCase()
  if (needle === '' && OUTPUT_LEVELS.every(level => filters[level])) return lines
  return lines.filter(line => filters[line.level] && (needle === '' || line.text.toLowerCase().includes(needle)))
}

/* ────────────────────────────── 活动通道持久化 ────────────────────────────── */

function channelStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try { return typeof globalThis.localStorage === 'undefined' ? undefined : globalThis.localStorage } catch { return undefined }
}

/** 读上次的活动通道；没有/非法/存储被拒时回落 language。 */
export function readOutputChannel(): OutputChannel {
  try {
    const raw = channelStorage()?.getItem(OUTPUT_CHANNEL_KEY)
    return isOutputChannel(raw) ? raw : 'language'
  } catch {
    return 'language'
  }
}

/** 记住当前活动通道；隐私模式下写入可能被拒，忽略即可（本次会话仍然可用）。 */
export function saveOutputChannel(channel: OutputChannel): void {
  try { channelStorage()?.setItem(OUTPUT_CHANNEL_KEY, channel) } catch { /* 存储不可用时只保留组件内状态 */ }
}

/** 测试用：清空全部通道并恢复初始快照。 */
export function resetOutput(): void {
  channels = EMPTY_CHANNELS
  emit()
}
