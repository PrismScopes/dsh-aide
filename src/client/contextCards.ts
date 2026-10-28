/**
 * DSH 对话输入框的「上下文卡片」。
 *
 * 卡片复用 DSH 原生的**引用 chip**（composer 里 22px 的圆角胶囊，图标 + 标题，发送时由
 * 输入触发源自己的 codec 序列化）。这样不用改 DSH 的 composer 内部，也能让卡片随会话持久化、
 * 随发送进入消息，并且天然支持删除/撤销/复制。
 *
 * 两种添加方式：
 * 1. 在对话输入框里输入 `@`，候选里出现「AIDE 上下文」的文件/问题项；
 * 2. AIDE 面板/菜单调用 `addContextCard`：通过 `sessions.scope(sessionId)` 拿到会话 scope，
 *    再经 `conversation.input.for(actx)` 的 `insertReference` 把 chip 追加到草稿末尾。
 *
 * 载荷只带定位信息与类型（问题面板传 scope、文件传路径），内容在**发送时**由 codec 现读；
 * 这样高频更新的诊断不会因为「加卡片那一刻的快照」而过期。
 *
 * 没有 DSH composer 服务时（旧版本/测试环境）全部路径安全退化为旧的文本插入（dshChat.ts）。
 */
import { baseName, samePath, workspaceRelativeOf, absolutePathOf } from './language/paths.ts'
import { diagnosticsStoreFor } from './language/diagnostics.ts'
import { formatSnippetQuote } from './dshChat.ts'
import { insertTextIntoComposer, focusDshComposer } from './dshChat.ts'
import { REVEAL_CHAT_EVENT } from './dshChat.ts'
import type { ContextCardKind, ContextCardRequest } from './contextRequest.ts'

/** 注册到 DSH 输入触发管线的 source 名（也就是 chip 的 codec 路由键）。 */
export const CONTEXT_SOURCE = 'aide-context'
/** `@` 菜单里的分组名。 */
export const CONTEXT_SOURCE_NAME = 'AIDE 上下文'

/** 单条上下文载荷：只带定位/类型，不带问题列表这类易变快照。 */
interface ContextPayload {
  kind: ContextCardKind
  label: string
  clipboardText: string
  appearance?: 'file' | 'folder' | 'session'
  sessionId?: string
  cwd: string
  path?: string
  scope?: 'file' | 'workspace'
  lineStart?: number
  lineEnd?: number
  /** 单条诊断的 1 基位置与消息。 */
  line?: number
  column?: number
  message?: string
  text?: string
  language?: string
}

/* ────────────────────────────── DSH 服务结构面 ────────────────────────────── */

interface RefSnapshot {
  draft: string
  draftRev: number
  occurrences?: readonly { length: number }[]
}
interface ReferenceInsertLike {
  source: string
  ref: string
  label: string
  appearance?: 'file' | 'folder' | 'session'
  clipboardText: string
}
interface InputFacade {
  state: { getSnapshot(): RefSnapshot }
  insertReference(reference: ReferenceInsertLike, span: { start: number; end: number; draftRev: number }): boolean
}
interface SessionsService { scope(id: string): unknown | undefined }
interface ConversationService { input: { for(actx: unknown): InputFacade } }
interface TriggerService { registerSource(source: unknown): () => void }
interface ReflectLike { get(name: string, strict?: boolean): unknown }

interface PluginCtxLike {
  reflect?: ReflectLike
  effect?(callback: () => (() => void) | void, label?: string): unknown
}

let pluginCtx: PluginCtxLike | undefined
let sourceDispose: (() => void) | undefined
let sourceRetry: ReturnType<typeof setTimeout> | undefined
let sourceRetries = 0

/** 当前工作台会话/工作区快照，供 `@` 候选与 codec 现读。 */
let scope: { sessionId?: string; cwd?: string; activePath?: string } = {}

function service<T>(name: string): T | undefined {
  const reflect = pluginCtx?.reflect
  if (reflect === undefined) return undefined
  try { return reflect.get(name, false) as T | undefined } catch { return undefined }
}

/** Workbench 每次切换会话/文件时更新；codec 与 `@` 候选都依赖它。 */
export function setContextCardScope(next: { sessionId?: string; cwd?: string; activePath?: string }): void {
  scope = { ...next }
}

/** 插件 apply 时调用：在 DSH 输入触发管线注册 `@` 候选源（服务未就绪时等第一次请求再补）。 */
export function installContextCards(ctx: PluginCtxLike): void {
  pluginCtx = ctx
  ctx.effect?.(() => {
    retrySource()
    return () => {
      if (sourceRetry !== undefined) { clearTimeout(sourceRetry); sourceRetry = undefined }
      sourceDispose?.(); sourceDispose = undefined
    }
  }, 'dsh-aide: context card source')
}

/** 输入触发服务可能比插件晚就绪：短轮询到它出现或超时，避免 `@` 源永久缺失。 */
function retrySource(): void {
  if (sourceDispose !== undefined || sourceRetries >= 40) return
  sourceRetries++
  if (ensureContextSource()) return
  sourceRetry = setTimeout(retrySource, 250)
  if (typeof sourceRetry === 'object' && typeof (sourceRetry as { unref?: () => void }).unref === 'function') (sourceRetry as { unref(): void }).unref()
}

function ensureContextSource(): boolean {
  if (sourceDispose !== undefined) return true
  const triggers = service<TriggerService>('inputTriggers')
  if (triggers === undefined) return false
  try { sourceDispose = triggers.registerSource(contextSource) } catch { sourceDispose = undefined }
  return sourceDispose !== undefined
}

/* ────────────────────────────── 载荷与序列化 ────────────────────────────── */

function payloadOf(ref: string): ContextPayload | undefined {
  try {
    const parsed = JSON.parse(ref) as Partial<ContextPayload>
    return typeof parsed?.kind === 'string' && typeof parsed?.label === 'string' && typeof parsed?.cwd === 'string'
      ? parsed as ContextPayload
      : undefined
  } catch { return undefined }
}

function refOf(payload: ContextPayload): string { return JSON.stringify(payload) }

/** 文件引用：交给宿主的 `@path` 文法（含空格时加引号）。 */
function fileReference(cwd: string, path: string): string {
  const relative = workspaceRelativeOf(cwd, path) ?? path
  return relative.includes(' ') ? `@"${relative}"` : `@${relative}`
}

/** 问题序列化：**发送时**读 store，scope=file 时只取当前文件。 */
export function serializeProblems(payload: Pick<ContextPayload, 'cwd' | 'scope' | 'path'>): string {
  const snapshot = diagnosticsStoreFor(payload.cwd).getSnapshot()
  const limit = 200
  const rows: string[] = []
  let truncated = false
  for (const file of snapshot.files) {
    if (payload.scope === 'file' && payload.path !== undefined && !samePath(file.path, payload.path)) continue
    for (const diagnostic of file.diagnostics) {
      if (rows.length >= limit) { truncated = true; break }
      const at = `${file.path}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`
      const source = diagnostic.source === undefined ? '' : ` (${diagnostic.source}${diagnostic.code === undefined ? '' : `:${diagnostic.code}`})`
      rows.push(`- ${at} [${diagnostic.severity}] ${diagnostic.message}${source}`)
    }
    if (truncated) break
  }
  const where = payload.scope === 'file' ? '当前文件' : '工作区'
  const header = `${where}诊断（${rows.length}${truncated ? '+' : ''} 条）`
  return rows.length === 0 ? `${header}：没有发现问题。` : `${header}：\n${rows.join('\n')}`
}

/** 发送时的模型文本（codec.serialize）。文件类返回 @path，交给宿主文件引用解析。 */
export async function serializeContextPayload(payload: ContextPayload): Promise<string> {
  if (payload.kind === 'file' && payload.path !== undefined) return fileReference(payload.cwd, payload.path)
  if (payload.kind === 'selection') {
    return formatSnippetQuote({
      text: payload.text ?? '',
      ...(payload.path === undefined ? {} : { filePath: payload.path }),
      ...(payload.language === undefined ? {} : { language: payload.language }),
      ...(payload.lineStart === undefined ? {} : { lineStart: payload.lineStart }),
      ...(payload.lineEnd === undefined ? {} : { lineEnd: payload.lineEnd }),
    })
  }
  if (payload.kind === 'problems') return serializeProblems(payload)
  if (payload.kind === 'problem') {
    const at = payload.path === undefined ? '' : `${payload.path}${payload.line === undefined ? '' : `:${payload.line}${payload.column === undefined ? '' : `:${payload.column}`}`}`
    return `问题：${at}${payload.message === undefined ? '' : ` ${payload.message}`}`.trim()
  }
  if (payload.kind === 'terminal') return payload.text ?? '（终端输出上下文）'
  if (payload.kind === 'subagent') return payload.text ?? '（子代理上下文）'
  return payload.label
}

/* ────────────────────────────── 载荷构造 ────────────────────────────── */

function problemPayload(scopeValue: 'file' | 'workspace'): ContextPayload | undefined {
  const cwd = scope.cwd
  if (cwd === undefined) return undefined
  const activePath = scope.activePath
  if (scopeValue === 'file' && activePath === undefined) return undefined
  const absolute = activePath === undefined ? undefined : absoluteOf(cwd, activePath)
  const snapshot = diagnosticsStoreFor(cwd).getSnapshot()
  const count = scopeValue === 'file'
    ? (snapshot.files.find(file => absolute !== undefined && samePath(file.path, absolute))?.diagnostics.length ?? 0)
    : snapshot.errors + snapshot.warnings + snapshot.infos + snapshot.hints
  return {
    kind: 'problems',
    cwd,
    scope: scopeValue,
    ...(absolute === undefined ? {} : { path: absolute }),
    ...(scope.sessionId === undefined ? {} : { sessionId: scope.sessionId }),
    label: scopeValue === 'file' ? `当前文件问题（${count}）` : `工作区问题（${count}）`,
    clipboardText: scopeValue === 'file' ? '当前文件问题' : '工作区问题',
    appearance: 'file',
  }
}

function filePayload(path: string): ContextPayload | undefined {
  const cwd = scope.cwd
  if (cwd === undefined || path === '') return undefined
  const absolute = absoluteOf(cwd, path)
  return {
    kind: 'file',
    cwd,
    path: absolute,
    ...(scope.sessionId === undefined ? {} : { sessionId: scope.sessionId }),
    label: `文件 · ${baseName(path)}`,
    clipboardText: fileReference(cwd, absolute),
    appearance: 'file',
  }
}

/**
 * 把 AIDE 的请求转成输入框 chip。
 *
 * @returns true = 已作为 chip 插入；false = 当前没有 DSH composer，调用方可回落到文本插入。
 */
export async function addContextCard(request: ContextCardRequest, sessionId?: string): Promise<boolean> {
  ensureContextSource()
  const cwd = scope.cwd
  if (cwd === undefined) return false
  const id = sessionId ?? scope.sessionId
  let payload: ContextPayload | undefined
  if (request.kind === 'problems') payload = problemPayload(request.scope ?? 'workspace')
  else if (request.kind === 'problem' && request.path !== undefined) {
    payload = {
      kind: 'problem',
      cwd,
      ...(id === undefined ? {} : { sessionId: id }),
      path: absoluteOf(cwd, request.path),
      ...(request.line === undefined ? {} : { line: request.line }),
      ...(request.column === undefined ? {} : { column: request.column }),
      ...(request.message === undefined ? {} : { message: request.message }),
      label: `问题 · ${baseName(request.path)}${request.line === undefined ? '' : `:${request.line}`}`,
      clipboardText: `问题 ${request.path}${request.line === undefined ? '' : `:${request.line}`}`,
      appearance: 'file',
    }
  }
  else if (request.kind === 'file' && request.path !== undefined) payload = filePayload(request.path)
  else if (request.kind === 'selection') {
    // 编辑器菜单给的是 Monaco 的绝对 URI 路径；卡片按工作区相对路径展示/序列化，和文件卡片一致。
    const path = request.path === undefined ? undefined : (workspaceRelativeOf(cwd, request.path) ?? request.path)
    payload = {
      kind: 'selection',
      cwd,
      ...(id === undefined ? {} : { sessionId: id }),
      ...(path === undefined ? {} : { path }),
      ...(request.lineStart === undefined ? {} : { lineStart: request.lineStart }),
      ...(request.lineEnd === undefined ? {} : { lineEnd: request.lineEnd }),
      ...(request.text === undefined ? {} : { text: request.text }),
      ...(request.language === undefined ? {} : { language: request.language }),
      label: `选区 · ${request.title ?? baseName(path ?? '选区')}`,
      clipboardText: `选区 ${path ?? ''}`,
      appearance: 'file',
    }
  } else if (request.kind === 'terminal') {
    payload = { kind: 'terminal', cwd, text: request.text, label: request.title ?? '终端输出', clipboardText: request.title ?? '终端输出', ...(id === undefined ? {} : { sessionId: id }) }
  } else if (request.kind === 'subagent') {
    payload = { kind: 'subagent', cwd, text: request.text, label: request.title ?? '子代理', clipboardText: request.title ?? '子代理', ...(id === undefined ? {} : { sessionId: id }), appearance: 'session' }
  }
  if (payload === undefined) return false

  // chip 路径：需要会话 scope 与 conversation input facade。
  if (id !== undefined) {
    const inserted = tryInsertChip(payload, id)
    if (inserted) { focusDshComposer(); return true }
  }
  // 回落：文本插入（旧路径；保证按钮永远有反馈）。
  const text = await serializeContextPayload(payload)
  const result = await insertTextIntoComposer(text)
  return result.ok
}

function tryInsertChip(payload: ContextPayload, sessionId: string): boolean {
  const sessions = service<SessionsService>('sessions')
  const conversation = service<ConversationService>('conversation')
  if (sessions === undefined || conversation === undefined) return false
  const actx = sessions.scope(sessionId)
  if (actx === undefined) return false
  let facade: InputFacade
  try { facade = conversation.input.for(actx) } catch { return false }
  try {
    const state = facade.state.getSnapshot()
    const chipOverhead = (state.occurrences ?? []).reduce((sum, occurrence) => sum + Math.max(0, occurrence.length - 1), 0)
    const at = Math.max(0, state.draft.length - chipOverhead)
    // 展开右侧对话栏，否则用户看不到插入结果；chip 插入本身不依赖可见性。
    try { window.dispatchEvent(new CustomEvent(REVEAL_CHAT_EVENT)) } catch { /* 非浏览器环境 */ }
    return facade.insertReference({
      source: CONTEXT_SOURCE,
      ref: refOf(payload),
      label: payload.label,
      clipboardText: payload.clipboardText,
      ...(payload.appearance === undefined ? {} : { appearance: payload.appearance }),
    }, { start: at, end: at, draftRev: state.draftRev })
  } catch { return false }
}

/** 工作区相对路径 → 绝对路径；已经是绝对路径（外部只读标签/Monaco URI 路径）则原样返回。 */
function absoluteOf(cwd: string, path: string): string {
  if (/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(path)) return path
  return absolutePathOf(cwd, path)
}

/* ────────────────────────────── `@` 候选源 ────────────────────────────── */

const contextSource = {
  trigger: '@' as const,
  name: CONTEXT_SOURCE_NAME,
  showGroupTitle: false,
  async candidates() {
    const items: { name: string; description?: string; icon?: 'file' | 'folder' | 'session'; value?: string }[] = []
    const problems = problemPayload('workspace')
    const current = problemPayload('file')
    const file = scope.activePath === undefined ? undefined : filePayload(scope.activePath)
    for (const payload of [file, current, problems]) {
      if (payload === undefined) continue
      items.push({
        name: payload.label,
        description: payload.kind === 'problems' ? (payload.scope === 'file' ? '当前文件的诊断' : '整个工作区的诊断') : (scope.activePath ?? ''),
        icon: 'file',
        value: refOf(payload),
      })
    }
    return items
  },
  onPick(pick: { candidate: { value?: string } }) {
    const value = pick.candidate.value
    if (value === undefined || value === '') return undefined
    const payload = payloadOf(value)
    if (payload === undefined) return undefined
    return {
      insert: {
        source: CONTEXT_SOURCE,
        ref: value,
        label: payload.label,
        clipboardText: payload.clipboardText,
        ...(payload.appearance === undefined ? {} : { appearance: payload.appearance }),
      },
    }
  },
  codec: {
    clipboardText(ref: string): string { return payloadOf(ref)?.clipboardText ?? 'AIDE 上下文' },
    async serialize(ref: string, _signal: AbortSignal): Promise<string> {
      const payload = payloadOf(ref)
      return payload === undefined ? 'AIDE 上下文' : serializeContextPayload(payload)
    },
  },
}

/** Workbench 的事件转发：收到 CONTEXT_CARD_EVENT 时调用这里。 */
export async function handleContextCardRequest(detail: ContextCardRequest & { resolve(ok: boolean): void }, sessionId?: string): Promise<void> {
  let ok = false
  try { ok = await addContextCard(detail, sessionId) } catch { ok = false }
  detail.resolve(ok)
}

/** 测试用：清掉已注册的 source（不触碰 DSH 服务）。 */
export function resetContextCardsForTests(): void {
  if (sourceRetry !== undefined) { clearTimeout(sourceRetry); sourceRetry = undefined }
  sourceRetries = 0
  sourceDispose?.()
  sourceDispose = undefined
  pluginCtx = undefined
  scope = {}
}
