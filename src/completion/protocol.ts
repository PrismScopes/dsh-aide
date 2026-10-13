/**
 * 补全的请求体、流式事件与 SSE 编解码。
 *
 * 这一层只描述「两端之间传什么」，不含任何一端的行为，因此宿主与客户端都直接引用它，
 * 字段名只在这里出现一次。
 */
import type { CompletionParams } from './params.ts'

/** 一次编辑的前后文本与时间戳。 */
export interface EditHistoryEntry { before: string; after: string; timestamp: number }

/** 光标处的编辑对象：文件、最近一次编辑、重写位置与（裁剪后的）文档内容。 */
export interface CursorEdit {
  filePath: string
  lastEdit?: { before: string; after: string }
  /** 重写位置：行号 1 起、列 0 起（与 LSP 一致）。 */
  rewriteAt: { line: number; column: number }
  document: string
}

/** 语言服务给出的诊断信息，可为空。 */
export interface DiagnosticEntry { severity: 'error' | 'warning' | 'info' | 'hint'; message: string; line: number }

/** 环境元数据：服务端据此做灰度与问题定位。 */
export interface CompletionEnvironment {
  ideVersion: string
  extensionVersion: string
  region: string
  channel: string
  repository: string
  experiment?: string
}

/** 多租户场景下由客户端下发的过滤规则，条件性附加。 */
export interface CompletionSecurityRules { rules: Array<{ id: string; name: string; action: 'block' | 'mask' }> }

export interface CompletionRequest {
  /** 服务端用它关联同一编辑会话的连续请求。 */
  sessionId: string
  environment: CompletionEnvironment
  language: string
  /** 触发模式：行内补全 / 其它补全场景。 */
  trigger: 'inline' | 'other'
  edits: EditHistoryEntry[]
  cursor: CursorEdit
  diagnostics: DiagnosticEntry[]
  /** 客户端对用户意图的初步判断，可为空。 */
  intent?: string
  /** 特定实验或模式下要求服务端忽略缓存。 */
  forceRewrite: boolean
  security?: CompletionSecurityRules
}

/** 流式返回的一个候选。序号用于在客户端对应槽位。 */
export interface CompletionCandidate { index: number; text: string; finishReason: string; elapsedMs: number }

export type CompletionEvent =
  | { type: 'meta'; model: string; experiment?: string }
  | { type: 'output'; candidates: CompletionCandidate[] }
  | { type: 'error'; code: string; message: string }
  | { type: 'content_security'; action: 'block' | 'mask'; ruleId: string; ruleName: string }
  | { type: 'done' }

/** 把事件编码成一条 SSE 记录。 */
export function encodeSseEvent(event: CompletionEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

export interface ParsedSse { events: CompletionEvent[]; rest: string }

/**
 * 增量解析 SSE。
 *
 * 返回「已完整收到的记录」与「剩下的半条」。调用方把上次返回的 rest 与本次新到的文本接起来再传进来，
 * 因此跨网络分块的记录不会被丢掉。无法解析的记录直接跳过 —— 流里出现非本协议的注释行是正常的。
 */
export function parseSse(input: string, previousRest = ''): ParsedSse {
  const text = previousRest + input
  const events: CompletionEvent[] = []
  let cursor = 0
  while (true) {
    const next = text.indexOf('\n\n', cursor)
    if (next === -1) break
    const record = text.slice(cursor, next)
    cursor = next + 2
    const data = record
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
    if (data === '') continue
    try {
      const parsed: unknown = JSON.parse(data)
      if (isCompletionEvent(parsed)) events.push(parsed)
    } catch { /* 非 JSON 的记录（心跳、注释）忽略 */ }
  }
  return { events, rest: text.slice(cursor) }
}

function isCompletionEvent(value: unknown): value is CompletionEvent {
  if (typeof value !== 'object' || value === null) return false
  const type = (value as { type?: unknown }).type
  return type === 'meta' || type === 'output' || type === 'error' || type === 'content_security' || type === 'done'
}
