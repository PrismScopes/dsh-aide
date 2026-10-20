/**
 * 把编辑器里的选中代码交给 DSH 对话。
 *
 * 两条链路：
 * - 「添加至对话」：只写 composer（Lexical），不发送 —— 用户能先看到、接着编辑再发；
 * - 「询问 / 解释 / 修复 …」：直接经 DSH 的 conversation 服务发一条 prompt（mode queue）。
 *
 * 为什么不能两层都自己造：
 * - 发送必须走 `conversation.sendSession(...)`：它负责本地提交回显、附件登记与 Host 准入，
 *   直接发 RPC 会绕过这些状态，界面上表现为「发出去了但对话流里没有这条消息」。
 * - 写 composer 必须走 DOM 插入（focus + execCommand insertText）：DSH 的草稿由 Lexical 自己
 *   持久化到 localStorage，绕过编辑器写入会和已挂载的编辑器不同步，下一次输入就把内容覆盖掉。
 *
 * 服务可用性用 cordis 的可选注入检测（`ctx.inject(['conversation','sessions'], ...)`）：
 * 旧版/其它组合里没有这两个服务时，菜单项禁用、动作返回可读的失败原因，绝不抛错到 UI。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { copyText } from './clipboard.ts'

/** 编辑器选区快照：代码正文 + 定位信息（行号从 1 开始）。 */
export interface DshSelection {
  text: string
  filePath?: string
  language?: string
  lineStart?: number
  lineEnd?: number
  lineCount?: number
}

/** 动作结果：失败时带一句给用户看的中文说明（也可能同时已经复制到剪贴板）。 */
export interface DshActionResult { ok: boolean; message?: string }

/** 菜单里的「询问 DSH…」这一项发出的是哪一种问题。 */
export type DshAskKind = 'explain' | 'fix' | 'refactor' | 'tests' | 'comment' | 'review' | 'ask'

/** 请求 Lead 在 Workbench 里展开右侧 DSH 对话栏的事件名。 */
export const REVEAL_CHAT_EVENT = 'dvw-reveal-chat'

/** 代码围栏：三个反引号；单独拎出来避免模板字符串里再转义。 */
const FENCE = '```'

/** Markdown 引用文本：`引用自 \`src/a.ts:12-20\`：` + 代码块。filePath 缺失时省略引用行。 */
export function formatSnippetQuote(selection: DshSelection): string {
  const quoted = `${FENCE}${selection.language ?? ''}\n${selection.text}\n${FENCE}`
  const location = quoteLocation(selection)
  return location === undefined ? quoted : `引用自 \`${location}\`：\n\n${quoted}`
}

/** `路径:行` / `路径:起-止`；没有任何定位信息时只给路径。 */
function quoteLocation(selection: DshSelection): string | undefined {
  if (selection.filePath === undefined || selection.filePath.trim() === '') return undefined
  const range = lineRange(selection)
  return range === undefined ? selection.filePath : `${selection.filePath}:${range}`
}

/** 行号区间：起止相同给单行号；只给起点时用 lineCount 推终点。 */
function lineRange(selection: DshSelection): string | undefined {
  const start = selection.lineStart
  const end = selection.lineEnd ?? (start !== undefined && selection.lineCount !== undefined && selection.lineCount > 0 ? start + selection.lineCount - 1 : undefined)
  const first = start ?? end
  if (first === undefined) return undefined
  return end === undefined || end === first ? `${first}` : `${first}-${end}`
}

/** 各动作的中文指令；`ask` 单独取用户输入。 */
const PROMPT_INSTRUCTIONS: Record<Exclude<DshAskKind, 'ask'>, string> = {
  explain: '请解释这段代码的作用与关键逻辑。',
  fix: '请找出这段代码里的问题，并给出修复后的代码。',
  refactor: '请重构这段代码，让结构更清晰、可读性更好，保持行为不变。',
  tests: '请为这段代码生成单元测试，覆盖主要分支与边界情况。',
  comment: '请为这段代码添加注释，说明关键步骤与容易误解的地方。',
  review: '请审查这段代码，指出潜在问题、风险与改进点。',
}

/** 生成发送给对话的完整 prompt：一句中文指令 + 空行 + 引用代码块。 */
export function promptFor(kind: DshAskKind, selection: DshSelection, extra?: string): string {
  const instruction = kind === 'ask' ? customQuestion(extra) : PROMPT_INSTRUCTIONS[kind]
  return `${instruction}\n\n${formatSnippetQuote(selection)}`
}

/** 自定义提问；没写问题时退回一句通用请求，而不是发一个只有代码块的哑 prompt。 */
function customQuestion(extra?: string): string {
  const question = extra === undefined ? '' : extra.trim()
  return question === '' ? '请分析这段代码。' : question
}

//#region 传输适配（conversation / sessions 的最小结构面；不 import 官方客户端类型）

/** conversation.sendSession 收到的目标会话需要的能力（ISession 的子集）。 */
export interface DshSessionFace {
  beginSubmission(input: unknown): { abandon?(): void }
  prompt(content: Array<{ type: 'text'; text: string }>, mode: 'queue' | 'steer', signal?: AbortSignal, requestId?: unknown): Promise<{ ok: boolean; error?: { code?: string; message?: string } }>
}

/** sessions.binding(id) 的返回值子集。 */
export interface DshSessionBinding {
  sessionId?: string
  session?: DshSessionFace | null
}

export interface DshConversationService {
  sendSession(session: DshSessionFace, text: string, attachmentIds: readonly string[], mode: 'queue' | 'steer', signal?: AbortSignal): Promise<{ kind: 'success' | 'error' }>
}

export interface DshSessionsService {
  binding(id: string): DshSessionBinding | undefined
}

//#endregion

/** DOM / 平台依赖；设置页与测试都只在真正执行动作时传入（生产不传即用全局对象）。 */
export interface DshChatDeps {
  document?: Document
  window?: Window
  /** `Document.execCommand` 的替身：返回 false 表示插入失败，走粘贴事件降级。 */
  execCommand?: (commandId: string, showUI?: boolean, value?: string) => boolean
  copyText?: (text: string) => Promise<boolean>
  /** node 测试环境没有这两个构造器，可注入最小替身来断言降级路径。 */
  clipboardEvent?: typeof ClipboardEvent
  dataTransfer?: typeof DataTransfer
  requestAnimationFrame?: (callback: () => void) => number
}

let conversationService: DshConversationService | undefined
let sessionsService: DshSessionsService | undefined
let activeSessionId: string | undefined
let serviceReason: string | undefined = 'DSH 对话服务尚未就绪'

/** 已经声明过可选注入的上下文，避免重复调用 `ctx.inject` 留下多份 fiber。 */
const attachedContexts = new WeakSet<object>()

/**
 * 在 client 的 apply 里调用一次：绑定 DSH 的 conversation / sessions 服务。
 *
 * 用 `ctx.inject` 而不是把两个服务加进插件的 `inject` 数组：后者会让整个工作台在缺少
 * conversation 服务的部署里拒绝激活；这两个服务对本插件只是增强能力，缺了要能继续用。
 */
export function attachDshChat(ctx: ClientContext): void {
  // 每次附加都先清空：上一次附加的服务可能已经随插件卸载消失，状态不能跨代沿用。
  conversationService = undefined
  sessionsService = undefined
  serviceReason = 'DSH 对话服务尚未就绪'
  try {
    // 服务可能已经就绪（插件晚于 conversation 加载）：先同步绑一次，状态立即可用。
    bindServices(ctx as unknown as { get(name: string): unknown })
    if (typeof ctx?.inject !== 'function') {
      serviceReason = '当前 DSH 版本不支持可选服务注入'
      return
    }
    if (attachedContexts.has(ctx as unknown as object)) return
    attachedContexts.add(ctx as unknown as object)
    ctx.inject(['conversation', 'sessions'], child => {
      bindServices(child as unknown as { get(name: string): unknown })
      // 记下这一次注入绑定到的实例：只有仍是它时才清空，避免旧 fiber 卸载时把新附加的绑定一起抹掉。
      const boundConversation = conversationService
      const boundSessions = sessionsService
      return () => {
        if (conversationService !== boundConversation || sessionsService !== boundSessions) return
        conversationService = undefined
        sessionsService = undefined
        serviceReason = 'DSH 对话服务尚未就绪'
      }
    })
  } catch (error) {
    serviceReason = `无法检测 DSH 对话服务：${errorMessage(error)}`
  }
}

/** 读取并校验两个服务；两个都在才算可用。 */
function bindServices(source: { get(name: string): unknown } | undefined): boolean {
  try {
    const conversation = source?.get('conversation')
    const sessions = source?.get('sessions')
    if (!isConversationService(conversation) || !isSessionsService(sessions)) return false
    conversationService = conversation
    sessionsService = sessions
    serviceReason = undefined
    return true
  } catch {
    return false
  }
}

/** 服务是否可用（设置页/菜单据此决定禁用态）。 */
export function dshChatStatus(): { available: boolean; reason?: string } {
  if (conversationService !== undefined && sessionsService !== undefined) return { available: true }
  return { available: false, ...(serviceReason === undefined ? {} : { reason: serviceReason }) }
}

/**
 * 当前主视图会话 id。由 Lead 在 Workbench 里随选中会话调用（`setActiveSession(session?.id)`）。
 *
 * 不在本模块自己读 DSH 的会话状态：会话选择属于 UI 层，重复实现一套「谁是主视图」的判断
 * 很容易和宿主行为分叉。
 */
export function setActiveSession(sessionId: string | undefined): void {
  activeSessionId = typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId : undefined
}

//#region addSelectionToConversation：写 composer

/**
 * 把选区以引用形式插入 DSH 对话的输入框（不发送）。
 *
 * 降级链：先展开右侧对话栏 → focus 并定位到末尾 → execCommand insertText → 派发 paste 事件 →
 * 复制到剪贴板（返回可读提示，由调用方提示用户）。
 */
export async function addSelectionToConversation(selection: DshSelection, deps?: DshChatDeps): Promise<DshActionResult> {
  const text = formatSnippetQuote(selection)
  revealChat(deps)
  // 等一帧：让 Lead 的 reveal 监听先把对话栏显示/定位好，composer 才能在可见状态下接收文本。
  await afterReveal(deps)
  const doc = currentDocument(deps)
  if (doc === undefined) return copyFallback(text, deps, '当前环境没有可写入的对话输入框')
  const composer = findComposer(doc)
  if (composer === undefined) return copyFallback(text, deps, '未找到 DSH 对话输入框')
  try {
    focusComposer(composer, doc)
    if (insertWithExecCommand(doc, deps, text)) return { ok: true }
    if (await insertWithPaste(composer, text, deps)) return { ok: true }
  } catch { /* 落到剪贴板兜底：插入失败不该让菜单点了没反应。 */ }
  return copyFallback(text, deps, '无法直接写入 DSH 对话输入框')
}

/** 优先当前可见的 composer：DSH 会保留后台会话的输入框，写进隐藏那个用户完全看不到。 */
function findComposer(doc: Document): Element | undefined {
  const roots = Array.from(doc.querySelectorAll('[data-lexical-editor="true"]'))
  return roots.find(isVisibleComposer) ?? roots[0]
}

function isVisibleComposer(element: Element): boolean {
  try {
    const candidate = element as Element & { getBoundingClientRect?(): { width: number; height: number }; isConnected?: boolean }
    if (candidate.isConnected === false) return false
    const rect = candidate.getBoundingClientRect?.()
    return rect !== undefined && rect.width > 0 && rect.height > 0
  } catch {
    return false
  }
}

/** focus 并把光标收到末尾：否则插入位置是浏览器猜的（可能是开头或上一次的位置）。 */
function focusComposer(element: Element, doc: Document): void {
  try {
    const target = element as Element & { focus?(): void }
    target.focus?.()
    const range = doc.createRange()
    range.selectNodeContents(element)
    range.collapse(false)
    const selection = doc.getSelection?.()
    selection?.removeAllRanges()
    selection?.addRange(range)
  } catch { /* 定位失败时退回浏览器默认插入点，至少文本还在。 */ }
}

/** Lexical 的标准插入路径：execCommand('insertText') 会走 beforeinput/input，编辑器自己更新状态。 */
function insertWithExecCommand(doc: Document, deps: DshChatDeps | undefined, text: string): boolean {
  const run = deps?.execCommand ?? (typeof doc.execCommand === 'function' ? doc.execCommand.bind(doc) : undefined)
  if (run === undefined) return false
  try {
    return run('insertText', false, text) === true
  } catch {
    return false
  }
}

/**
 * 降级：派发一次带 text/plain 的 paste 事件，让 Lexical 自己走粘贴处理。
 *
 * 判定：`dispatchEvent` 返回 false 表示事件被 preventDefault —— Lexical 的 paste 处理一定会
 * preventDefault，这恰好说明它接住了这次粘贴；没被接住时再等一帧看输入框文本是否真的变了。
 */
async function insertWithPaste(element: Element, text: string, deps?: DshChatDeps): Promise<boolean> {
  const ClipboardEventCtor = deps?.clipboardEvent ?? (typeof ClipboardEvent === 'function' ? ClipboardEvent : undefined)
  if (ClipboardEventCtor === undefined) return false
  try {
    const DataTransferCtor = deps?.dataTransfer ?? (typeof DataTransfer === 'function' ? DataTransfer : undefined)
    const data = DataTransferCtor === undefined ? undefined : new DataTransferCtor()
    data?.setData('text/plain', text)
    const event = data === undefined
      ? new ClipboardEventCtor('paste', { bubbles: true, cancelable: true })
      : new ClipboardEventCtor('paste', { clipboardData: data, bubbles: true, cancelable: true })
    const before = textOf(element)
    const dispatched = element.dispatchEvent(event)
    if (dispatched === false) return true
    await afterReveal(deps)
    return textOf(element) !== before
  } catch {
    return false
  }
}

/** 最后兜底：复制引用到剪贴板，并返回一句明确的操作提示（ok 仍是 false，界面据此提示用户）。 */
async function copyFallback(text: string, deps: DshChatDeps | undefined, reason: string): Promise<DshActionResult> {
  const copy = deps?.copyText ?? copyText
  let copied = false
  try {
    copied = await copy(text)
  } catch {
    copied = false
  }
  return copied
    ? { ok: false, message: `${reason}，引用已复制到剪贴板，请手动粘贴到对话输入框。` }
    : { ok: false, message: `${reason}，请手动复制引用。` }
}

//#endregion

//#region askDsh：直接发送

/**
 * 用 DSH 的 conversation 服务把「指令 + 引用」发到当前会话。
 *
 * 先展开对话栏再发送：否则用户只看到代码被选中、对话已经跑起来，却找不到回答在哪。
 */
export async function askDsh(kind: DshAskKind, selection: DshSelection, extra?: string, deps?: DshChatDeps): Promise<DshActionResult> {
  const text = promptFor(kind, selection, extra)
  revealChat(deps)
  await afterReveal(deps)
  const conversation = conversationService
  const sessions = sessionsService
  if (conversation === undefined || sessions === undefined) return { ok: false, message: serviceReason ?? 'DSH 对话服务不可用' }
  const sessionId = activeSessionId
  if (sessionId === undefined) return { ok: false, message: '还没有可用的 DSH 会话，请先在 DSH 里打开一个会话。' }
  try {
    const binding = sessions.binding(sessionId)
    const session = binding?.session
    if (session === undefined || session === null || typeof session.beginSubmission !== 'function' || typeof session.prompt !== 'function') {
      return { ok: false, message: '当前 DSH 会话尚未就绪，请稍后重试。' }
    }
    const outcome = await conversation.sendSession(session, text, [], 'queue')
    return outcome?.kind === 'success'
      ? { ok: true }
      : { ok: false, message: 'DSH 没有接受这条消息，请稍后重试。' }
  } catch (error) {
    return { ok: false, message: `发送到 DSH 对话失败：${errorMessage(error)}` }
  }
}

//#endregion

//#region 平台小工具

/** 派发展开对话栏事件（Workbench 监听后把右侧对话栏显示出来）。失败不影响后续动作。 */
function revealChat(deps?: DshChatDeps): void {
  try {
    const win = currentWindow(deps)
    if (win === undefined) return
    const event = typeof CustomEvent === 'function' ? new CustomEvent(REVEAL_CHAT_EVENT) : new Event(REVEAL_CHAT_EVENT)
    win.dispatchEvent(event)
  } catch { /* 展开对话栏只是体验增强：失败时照常插入/发送。 */ }
}

/** 等一帧让 UI 落位；没有 rAF 的环境（node 测试）直接返回。 */
async function afterReveal(deps?: DshChatDeps): Promise<void> {
  const raf = deps?.requestAnimationFrame ?? (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined)
  if (raf === undefined) return
  await new Promise<void>(resolve => { raf(() => resolve()) })
}

function currentDocument(deps?: DshChatDeps): Document | undefined {
  if (deps?.document !== undefined) return deps.document
  return typeof document === 'undefined' ? undefined : document
}

function currentWindow(deps?: DshChatDeps): Window | undefined {
  if (deps?.window !== undefined) return deps.window
  return typeof window === 'undefined' ? undefined : window
}

function textOf(element: Element): string {
  const value = (element as Element & { textContent?: string | null }).textContent
  return typeof value === 'string' ? value : ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function isConversationService(value: unknown): value is DshConversationService {
  return isRecord(value) && typeof value.sendSession === 'function'
}

function isSessionsService(value: unknown): value is DshSessionsService {
  return isRecord(value) && typeof value.binding === 'function'
}

//#endregion
