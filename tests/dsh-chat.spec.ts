import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addSelectionToConversation,
  askDsh,
  dshChatStatus,
  formatSnippetQuote,
  promptFor,
  REVEAL_CHAT_EVENT,
  type DshChatDeps,
  type DshSelection,
} from '../src/client/dshChat.ts'

const SELECTION: DshSelection = {
  text: 'const a = 1\nconst b = 2',
  filePath: 'src/a.ts',
  language: 'ts',
  lineStart: 3,
  lineEnd: 5,
}
const QUOTE = '引用自 `src/a.ts:3-5`：\n\n```ts\nconst a = 1\nconst b = 2\n```'

/** 与动作实现同源的源码：用来钉住「发送路径已经彻底删掉」。 */
const SOURCE = readFileSync(fileURLToPath(new URL('../src/client/dshChat.ts', import.meta.url)), 'utf8')

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

//#region 假 DOM

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

/** 一次「成功插入」的接线：假 document + 记录 execCommand 收到的文本。 */
function insertFixture(): {
  deps: DshChatDeps
  composer: FakeComposer
  inserted: Array<{ command: string; value?: string }>
  events: Event[]
} {
  const composer = fakeComposer()
  const { document } = fakeDocument([composer])
  const inserted: Array<{ command: string; value?: string }> = []
  const win = fakeWindow()
  return {
    composer,
    inserted,
    events: win.events,
    deps: {
      document,
      window: win.window,
      execCommand: (command, _showUI, value) => { inserted.push({ command, value }); return true },
    },
  }
}

//#endregion

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('chat status', () => {
  it('is available as soon as the browser has a document', () => {
    vi.stubGlobal('document', {})
    expect(dshChatStatus()).toEqual({ available: true })
  })

  it('reports an unreadable reason when there is no document at all', () => {
    // 插入是纯前端行为，不依赖 DSH 服务；这里只缺浏览器环境。
    expect(dshChatStatus().available).toBe(false)
    expect(dshChatStatus().reason).toContain('对话输入框')
  })
})

describe('add selection to conversation', () => {
  it('inserts the quote into the visible composer and reveals the chat column', async () => {
    const { composer, inserted, events, deps } = insertFixture()

    const result = await addSelectionToConversation(SELECTION, deps)

    expect(result).toEqual({ ok: true })
    expect(composer.focused).toBe(1)
    expect(inserted).toEqual([{ command: 'insertText', value: QUOTE }])
    expect(events.map(event => event.type)).toEqual([REVEAL_CHAT_EVENT])
  })

  it('prefers a visible composer and falls back to the first one', async () => {
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
    const { document } = fakeDocument([])

    const result = await addSelectionToConversation(SELECTION, {
      document,
      copyText: async () => false,
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('请手动复制引用')
  })

  it('turns a throwing execCommand into a clipboard fallback instead of an error', async () => {
    const { document } = fakeDocument([fakeComposer()])
    const copied: string[] = []

    const result = await addSelectionToConversation(SELECTION, {
      document,
      execCommand: () => { throw new Error('execCommand blocked') },
      copyText: async text => { copied.push(text); return true },
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('已复制到剪贴板')
    expect(copied).toEqual([QUOTE])
  })
})

describe('ask dsh', () => {
  it('only inserts the prompt and never sends a message', async () => {
    const { composer, inserted, events, deps } = insertFixture()

    const result = await askDsh('fix', SELECTION, undefined, deps)

    expect(result).toEqual({ ok: true })
    // 插入内容就是 promptFor 的完整输出：没有额外的发送动作、没有截断或改写。
    expect(inserted).toEqual([{ command: 'insertText', value: promptFor('fix', SELECTION) }])
    expect(inserted[0]?.value).toContain(QUOTE)
    expect(composer.focused).toBe(1)
    expect(events.map(event => event.type)).toEqual([REVEAL_CHAT_EVENT])
  })

  it('inserts the custom question for ask', async () => {
    const { inserted, deps } = insertFixture()

    await askDsh('ask', SELECTION, '  这段代码的时间复杂度是多少？ ', deps)

    expect(inserted).toEqual([{ command: 'insertText', value: promptFor('ask', SELECTION, '这段代码的时间复杂度是多少？') }])
    expect(inserted[0]?.value?.startsWith('这段代码的时间复杂度是多少？\n\n')).toBe(true)
  })

  it('falls back to the paste event when execCommand refuses the insert', async () => {
    const composer = fakeComposer({ dispatchResult: false })
    const { document } = fakeDocument([composer])

    const result = await askDsh('explain', SELECTION, undefined, {
      document,
      execCommand: () => false,
      clipboardEvent: FakeClipboardEvent as unknown as typeof ClipboardEvent,
      dataTransfer: FakeDataTransfer as unknown as typeof DataTransfer,
    })

    expect(result).toEqual({ ok: true })
    const pasted = composer.received[0] as unknown as FakeClipboardEvent
    expect(pasted.clipboardData?.getData('text/plain')).toBe(promptFor('explain', SELECTION))
  })

  it('copies the prompt and explains it when insertion fails completely', async () => {
    const { document } = fakeDocument([fakeComposer()])
    const copied: string[] = []

    const result = await askDsh('review', SELECTION, undefined, {
      document,
      execCommand: () => false,
      copyText: async text => { copied.push(text); return true },
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('已复制到剪贴板')
    expect(copied).toEqual([promptFor('review', SELECTION)])
  })

  it('asks the user to paste manually when there is no composer', async () => {
    const { document } = fakeDocument([])
    const copied: string[] = []

    const result = await askDsh('tests', SELECTION, undefined, {
      document,
      copyText: async text => { copied.push(text); return true },
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('未找到 DSH 对话输入框')
    expect(copied).toEqual([promptFor('tests', SELECTION)])
  })

  it('never throws when the environment has no document', async () => {
    // `currentDocument` 退回全局 document；node 测试环境没有它。
    const result = await askDsh('explain', SELECTION, undefined, {
      copyText: async () => false,
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('当前环境没有可写入的对话输入框')
    expect(result.message).toContain('请手动复制引用')
  })
})

describe('removed send path', () => {
  it('does not mention the DSH send adapters anywhere in the module source', () => {
    // 用户要求「只插入、不发送」：发送相关标识符连注释都不该再出现，避免以后被接回来。
    for (const token of ['sendSession', 'sessions.binding', 'attachDshChat', 'setActiveSession', 'DshConversationService', 'DshSessionsService', 'DshSessionFace']) {
      expect(SOURCE, `dshChat.ts 里仍有发送路径残留：${token}`).not.toContain(token)
    }
  })

  it('keeps only insert-oriented exports', () => {
    // 回归护栏：模块不再导出 send / attach / session 入口，避免发送路径被悄悄接回来。
    const exported = [...SOURCE.matchAll(/export (?:async )?function (\w+)/g)].map(match => match[1] ?? '')
    expect(exported.filter(name => /send|attach|session/i.test(name))).toEqual([])
    expect(exported).toEqual(expect.arrayContaining(['formatSnippetQuote', 'promptFor', 'dshChatStatus', 'addSelectionToConversation', 'askDsh']))
  })
})
