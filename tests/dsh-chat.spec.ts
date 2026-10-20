import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  addSelectionToConversation,
  askDsh,
  attachDshChat,
  dshChatStatus,
  formatSnippetQuote,
  promptFor,
  REVEAL_CHAT_EVENT,
  setActiveSession,
  type DshConversationService,
  type DshSelection,
  type DshSessionBinding,
  type DshSessionFace,
  type DshSessionsService,
} from '../src/client/dshChat.ts'

const SELECTION: DshSelection = {
  text: 'const a = 1\nconst b = 2',
  filePath: 'src/a.ts',
  language: 'ts',
  lineStart: 3,
  lineEnd: 5,
}
const QUOTE = '引用自 `src/a.ts:3-5`：\n\n```ts\nconst a = 1\nconst b = 2\n```'

describe('snippet quote', () => {
  it('renders path, line range, language and code as a markdown quote', () => {
    expect(formatSnippetQuote(SELECTION)).toBe(QUOTE)
  })

  it('omits the reference line when there is no file path', () => {
    expect(formatSnippetQuote({ text: 'print(1)', language: 'py' })).toBe('```py\nprint(1)\n```')
  })

  it('uses an empty fence language when none is known', () => {
    expect(formatSnippetQuote({ text: 'x', filePath: 'src/a.ts' })).toBe('引用自 `src/a.ts`：\n\n```\nx\n```')
  })

  it('collapses line ranges the way editors label selections', () => {
    const quote = (extra: Partial<DshSelection>): string => formatSnippetQuote({ text: 'x', filePath: 'a.ts', ...extra })
    expect(quote({ lineStart: 12 })).toContain('`a.ts:12`')
    expect(quote({ lineStart: 12, lineEnd: 12 })).toContain('`a.ts:12`')
    // 只有起点 + 行数时推出区间终点（工作台取 Monaco 选区时会落到这种形状）。
    expect(quote({ lineStart: 12, lineCount: 3 })).toContain('`a.ts:12-14`')
    expect(quote({ lineStart: 12, lineEnd: 20 })).toContain('`a.ts:12-20`')
  })
})

describe('prompt for each ask kind', () => {
  const cases: Array<[Parameters<typeof promptFor>[0], string]> = [
    ['explain', '请解释这段代码'],
    ['fix', '请找出这段代码里的问题'],
    ['refactor', '请重构这段代码'],
    ['tests', '请为这段代码生成单元测试'],
    ['comment', '请为这段代码添加注释'],
    ['review', '请审查这段代码'],
  ]

  it('puts a Chinese instruction before the quoted snippet', () => {
    for (const [kind, instruction] of cases) {
      const prompt = promptFor(kind, SELECTION)
      expect(prompt.startsWith(`${instruction}`)).toBe(true)
      expect(prompt).toContain(`\n\n${QUOTE}`)
    }
  })

  it('uses the custom question for ask and trims it', () => {
    const prompt = promptFor('ask', SELECTION, '  这段代码有什么风险？ ')
    expect(prompt.startsWith('这段代码有什么风险？\n\n')).toBe(true)
    expect(prompt).toContain(QUOTE)
  })

  it('falls back to a generic question when ask has no text', () => {
    expect(promptFor('ask', SELECTION).startsWith('请分析这段代码。')).toBe(true)
    expect(promptFor('ask', SELECTION, '   ').startsWith('请分析这段代码。')).toBe(true)
  })
})

//#region 假 ctx / 假服务 / 假 DOM

type ServiceMap = Record<string, unknown>

/** 假 cordis ctx：`inject` 立即把子 ctx 交给回调（等价于服务已就绪）。 */
function fakeContext(services: ServiceMap, deliverInject = true): ClientContext {
  const child = { get: (name: string) => services[name] }
  const ctx = {
    get: (name: string) => services[name],
    inject: (_deps: string[], callback: (ctx: unknown) => unknown) => {
      if (deliverInject) callback(child)
      return undefined
    },
  }
  return ctx as unknown as ClientContext
}

interface SendCall { session: unknown; text: string; attachmentIds: readonly string[]; mode: string }

function fakeConversation(outcome: 'success' | 'error' | Error = 'success'): { calls: SendCall[]; service: DshConversationService } {
  const calls: SendCall[] = []
  const service: DshConversationService = {
    async sendSession(session, text, attachmentIds, mode) {
      calls.push({ session, text, attachmentIds, mode })
      if (outcome instanceof Error) throw outcome
      return { kind: outcome }
    },
  }
  return { calls, service }
}

function fakeSession(): DshSessionFace {
  return {
    beginSubmission: () => ({}),
    prompt: async () => ({ ok: true }),
  }
}

function fakeSessions(binding: DshSessionBinding | undefined): { asked: string[]; service: DshSessionsService } {
  const asked: string[] = []
  const service: DshSessionsService = { binding: id => { asked.push(id); return binding } }
  return { asked, service }
}

/** 收到事件（含 Lexical 粘贴）的假 composer 根节点。 */
interface FakeComposer {
  focused: number
  textContent: string
  visible: boolean
  dispatchResult: boolean
  received: Event[]
  focus(): void
  getBoundingClientRect(): { width: number; height: number }
  dispatchEvent(event: Event): boolean
}

function fakeComposer(options: { visible?: boolean; dispatchResult?: boolean } = {}): FakeComposer {
  const element: FakeComposer = {
    focused: 0,
    textContent: '',
    visible: options.visible ?? true,
    dispatchResult: options.dispatchResult ?? false,
    received: [],
    focus() { element.focused += 1 },
    getBoundingClientRect() { return element.visible ? { width: 320, height: 40 } : { width: 0, height: 0 } },
    dispatchEvent(event) { element.received.push(event); return element.dispatchResult },
  }
  return element
}

function fakeDocument(roots: FakeComposer[]): { document: Document; execCommands: Array<{ command: string; showUI?: boolean; value?: string }> } {
  const execCommands: Array<{ command: string; showUI?: boolean; value?: string }> = []
  const doc = {
    querySelectorAll: (selector: string) => selector === '[data-lexical-editor="true"]' ? roots : [],
    createRange: () => ({ selectNodeContents: () => undefined, collapse: () => undefined }),
    getSelection: () => ({ removeAllRanges: () => undefined, addRange: () => undefined }),
    execCommand: (command: string, showUI?: boolean, value?: string) => {
      execCommands.push({ command, showUI, value })
      return true
    },
  }
  return { document: doc as unknown as Document, execCommands }
}

function fakeWindow(): { window: Window; events: Event[] } {
  const events: Event[] = []
  const target = { dispatchEvent: (event: Event) => { events.push(event); return true } }
  return { window: target as unknown as Window, events }
}

/** node 没有 ClipboardEvent / DataTransfer：两个最小替身，用来断言粘贴降级路径。 */
class FakeDataTransfer {
  private readonly values = new Map<string, string>()
  setData(type: string, value: string): void { this.values.set(type, value) }
  getData(type: string): string { return this.values.get(type) ?? '' }
}

class FakeClipboardEvent {
  readonly type: string
  readonly clipboardData: FakeDataTransfer | undefined
  constructor(type: string, init?: { clipboardData?: FakeDataTransfer; bubbles?: boolean; cancelable?: boolean }) {
    this.type = type
    this.clipboardData = init?.clipboardData
  }
}

/** 每个用例先附加一次假服务（同时把模块单例状态重置掉）。 */
function attachChat(services: ServiceMap): void {
  attachDshChat(fakeContext(services))
}

function attachAvailable(): { conversation: ReturnType<typeof fakeConversation>; sessions: ReturnType<typeof fakeSessions>; session: DshSessionFace } {
  const session = fakeSession()
  const conversation = fakeConversation('success')
  const sessions = fakeSessions({ sessionId: 's1', session })
  attachChat({ conversation: conversation.service, sessions: sessions.service })
  return { conversation, sessions, session }
}

//#endregion

describe('add selection to conversation', () => {
  it('inserts the quote into the visible composer and reveals the chat column', async () => {
    attachChat({})
    const composer = fakeComposer()
    const { document } = fakeDocument([composer])
    const win = fakeWindow()
    const inserted: Array<{ command: string; value?: string }> = []

    const result = await addSelectionToConversation(SELECTION, {
      document,
      window: win.window,
      execCommand: (command, _showUI, value) => { inserted.push({ command, value }); return true },
    })

    expect(result).toEqual({ ok: true })
    expect(composer.focused).toBe(1)
    expect(inserted).toEqual([{ command: 'insertText', value: QUOTE }])
    expect(win.events.map(event => event.type)).toEqual([REVEAL_CHAT_EVENT])
  })

  it('prefers a visible composer and falls back to the first one', async () => {
    attachChat({})
    const hidden = fakeComposer({ visible: false })
    const visible = fakeComposer()
    const { document } = fakeDocument([hidden, visible])
    const inserted: Array<{ command: string; value?: string }> = []

    await addSelectionToConversation(SELECTION, {
      document,
      execCommand: (command, _showUI, value) => { inserted.push({ command, value }); return true },
    })

    expect(visible.focused).toBe(1)
    expect(hidden.focused).toBe(0)
  })

  it('dispatches a paste event with the quote when execCommand fails', async () => {
    attachChat({})
    const composer = fakeComposer({ dispatchResult: false })
    const { document } = fakeDocument([composer])
    let copied = false

    const result = await addSelectionToConversation(SELECTION, {
      document,
      execCommand: () => false,
      clipboardEvent: FakeClipboardEvent as unknown as typeof ClipboardEvent,
      dataTransfer: FakeDataTransfer as unknown as typeof DataTransfer,
      copyText: async () => { copied = true; return true },
    })

    expect(result).toEqual({ ok: true })
    expect(copied).toBe(false)
    const pasted = composer.received[0] as unknown as FakeClipboardEvent
    expect(pasted.type).toBe('paste')
    expect(pasted.clipboardData?.getData('text/plain')).toBe(QUOTE)
  })

  it('copies the quote to the clipboard and explains it when insertion fails completely', async () => {
    attachChat({})
    const { document } = fakeDocument([fakeComposer()])
    const copied: string[] = []

    const result = await addSelectionToConversation(SELECTION, {
      document,
      execCommand: () => false,
      // node 没有 ClipboardEvent，粘贴事件这条路走不通 → 只能复制。
      copyText: async text => { copied.push(text); return true },
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('已复制到剪贴板')
    expect(copied).toEqual([QUOTE])
  })

  it('explains how to recover when there is no composer at all', async () => {
    attachChat({})
    const { document } = fakeDocument([])

    const result = await addSelectionToConversation(SELECTION, {
      document,
      copyText: async () => true,
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('未找到 DSH 对话输入框')
    expect(result.message).toContain('已复制到剪贴板')
  })

  it('tells the user to copy manually when the clipboard also fails', async () => {
    attachChat({})
    const { document } = fakeDocument([])

    const result = await addSelectionToConversation(SELECTION, {
      document,
      copyText: async () => false,
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('请手动复制引用')
  })

  it('keeps working when the DSH conversation service is missing', async () => {
    // 「添加至对话」只写 composer：服务不可用时它仍是可用路径（菜单禁用由菜单层决定）。
    attachChat({})
    const composer = fakeComposer()
    const { document } = fakeDocument([composer])

    const result = await addSelectionToConversation(SELECTION, { document, execCommand: () => true })

    expect(result.ok).toBe(true)
    expect(composer.focused).toBe(1)
  })
})

describe('ask dsh', () => {
  it('reports unavailable and refuses to send when the services are missing', async () => {
    attachChat({})
    setActiveSession('s1')

    expect(dshChatStatus().available).toBe(false)
    const result = await askDsh('explain', SELECTION)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('对话服务')
  })

  it('becomes available once both services are injected', () => {
    attachAvailable()
    expect(dshChatStatus()).toEqual({ available: true })
  })

  it('sends the prompt through conversation.sendSession and reveals the chat column', async () => {
    const { conversation, sessions, session } = attachAvailable()
    setActiveSession('s1')
    const win = fakeWindow()

    const result = await askDsh('fix', SELECTION, undefined, { window: win.window })

    expect(result).toEqual({ ok: true })
    expect(sessions.asked).toEqual(['s1'])
    expect(conversation.calls).toEqual([{
      session,
      text: expect.stringContaining('请找出这段代码里的问题'),
      attachmentIds: [],
      mode: 'queue',
    }])
    expect((conversation.calls[0]?.text ?? '').endsWith(QUOTE)).toBe(true)
    expect(win.events.map(event => event.type)).toEqual([REVEAL_CHAT_EVENT])
  })

  it('passes the custom question for ask', async () => {
    const { conversation } = attachAvailable()
    setActiveSession('s1')

    await askDsh('ask', SELECTION, '这段代码的时间复杂度是多少？')

    expect(conversation.calls[0]?.text.startsWith('这段代码的时间复杂度是多少？')).toBe(true)
  })

  it('reports the host error outcome instead of throwing', async () => {
    const conversation = fakeConversation('error')
    attachChat({ conversation: conversation.service, sessions: fakeSessions({ session: fakeSession() }).service })
    setActiveSession('s1')

    const result = await askDsh('explain', SELECTION)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('没有接受')
  })

  it('turns a thrown transport failure into a readable message', async () => {
    const conversation = fakeConversation(new Error('offline'))
    attachChat({ conversation: conversation.service, sessions: fakeSessions({ session: fakeSession() }).service })
    setActiveSession('s1')

    const result = await askDsh('explain', SELECTION)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('发送到 DSH 对话失败')
    expect(result.message).toContain('offline')
  })

  it('asks the user to open a session when none is active', async () => {
    attachAvailable()
    setActiveSession(undefined)

    const result = await askDsh('explain', SELECTION)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('会话')
  })

  it('reports an unready session when the binding is gone', async () => {
    attachChat({ conversation: fakeConversation('success').service, sessions: fakeSessions(undefined).service })
    setActiveSession('s1')

    const result = await askDsh('explain', SELECTION)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('尚未就绪')
  })
})
