/**
 * 把编辑器里的选中代码交给 DSH 对话栏。
 *
 * 只有一条链路：把文本**插入**右侧对话栏的 composer（Lexical），由用户自己决定何时发送。
 * 不再直接调用 connection/conversation 服务发送消息 —— 用户明确要求「不要直接发送，
 * 直接添加到对话栏就可以了」：插入后用户还能补一句自己的问题、改改指令再发。
 *
 * 写 composer 必须走 DOM 插入（focus + execCommand insertText）：DSH 的草稿由 Lexical 自己
 * 持久化到 localStorage，绕过编辑器写入会和已挂载的编辑器不同步，下一次输入就把内容覆盖掉。
 * 因此这里也**不写** localStorage 草稿，插入失败时宁可退回剪贴板。
 *
 * 平台依赖：插入只在有 `document` 的浏览器环境里成立；`dshChatStatus()` 据此判断可用性。
 * 找不到 composer 或写入失败时会复制到剪贴板并返回一句可读提示，绝不抛错到 UI。
 */
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

/** 生成交给对话栏的完整 prompt：一句中文指令 + 空行 + 引用代码块。 */
export function promptFor(kind: DshAskKind, selection: DshSelection, extra?: string): string {
  const instruction = kind === 'ask' ? customQuestion(extra) : PROMPT_INSTRUCTIONS[kind]
  return `${instruction}\n\n${formatSnippetQuote(selection)}`
}

/** 自定义提问；没写问题时退回一句通用请求，而不是给一个只有代码块的哑 prompt。 */
function customQuestion(extra?: string): string {
  const question = extra === undefined ? '' : extra.trim()
  return question === '' ? '请分析这段代码。' : question
}

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

/**
 * 对话栏是否可用：与 DSH 服务无关，只取决于当前是不是有 DOM 的浏览器环境。
 *
 * composer 是页面上已挂载的 Lexical 编辑器，插入是纯前端行为；找不到输入框或写入失败时，
 * 动作会退回剪贴板并给提示（见 `insertIntoComposer`）。旧版/缺服务的 DSH 组合因此不再禁用菜单。
 */
export function dshChatStatus(): { available: boolean; reason?: string } {
  if (typeof document !== 'undefined') return { available: true }
  return { available: false, reason: '当前环境没有可写入的对话输入框' }
}

//#region 插入 composer（不发送）

/**
 * 把选区以引用形式插入 DSH 对话的输入框（不发送）。
 *
 * 降级链：先展开右侧对话栏 → focus 并定位到末尾 → execCommand insertText → 派发 paste 事件 →
 * 复制到剪贴板（返回可读提示，由调用方提示用户）。
 */
export async function addSelectionToConversation(selection: DshSelection, deps?: DshChatDeps): Promise<DshActionResult> {
  return insertIntoComposer(formatSnippetQuote(selection), deps)
}

/**
 * 按类型生成「指令 + 引用」文本并插入对话栏（不发送）。
 *
 * 先展开对话栏再插入：否则用户只看到代码被选中，却找不到文本写到了哪里。
 */
export async function askDsh(kind: DshAskKind, selection: DshSelection, extra?: string, deps?: DshChatDeps): Promise<DshActionResult> {
  return insertIntoComposer(promptFor(kind, selection, extra), deps)
}

/**
 * 把文本插入 DSH 对话输入框；插入不了就复制到剪贴板并返回可读提示。
 *
 * 只插入、不发送：发送时机交给用户。失败路径全部返回 `{ok:false, message}`，不抛错。
 */
async function insertIntoComposer(text: string, deps?: DshChatDeps): Promise<DshActionResult> {
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

/** 最后兜底：复制文本到剪贴板，并返回一句明确的操作提示（ok 仍是 false，界面据此提示用户）。 */
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

//#region 平台小工具

/** 派发展开对话栏事件（Workbench 监听后把右侧对话栏显示出来）。失败不影响后续动作。 */
function revealChat(deps?: DshChatDeps): void {
  try {
    const win = currentWindow(deps)
    if (win === undefined) return
    const event = typeof CustomEvent === 'function' ? new CustomEvent(REVEAL_CHAT_EVENT) : new Event(REVEAL_CHAT_EVENT)
    win.dispatchEvent(event)
  } catch { /* 展开对话栏只是体验增强：失败时照常插入。 */ }
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

//#endregion
