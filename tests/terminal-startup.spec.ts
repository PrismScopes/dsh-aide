import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalWorkspaceController } from '../src/client/terminal.ts'
import type { TerminalInfo } from '../src/terminal.ts'

/**
 * 终端启动路径的回归测试。
 *
 * 两件事在「点新建 → 看到提示符」之间曾经各占一段时间，且都不该再回来：
 *   1. 新建/关闭/重命名之后客户端又发一次 list（多一个串行往返才开始渲染窗格）；
 *   2. 面板收起、切标签时卸载 xterm 实例（回来要重建并重新解析回放）。
 * 组件在没有 jsdom 的环境里渲染不了，所以第 2 条用源码静态断言钉住接线。
 */
const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../src/client/${path}`, import.meta.url)), 'utf8')

interface FetchCall { url: string; body?: Record<string, unknown> }

/** 按方法名排队给应答的假 fetch；返回调用记录，用来断言「只发了一次请求」。 */
function stubFetch(answers: Record<string, readonly unknown[]>): FetchCall[] {
  const calls: FetchCall[] = []
  const queue = new Map(Object.entries(answers).map(([method, values]) => [method, [...values]]))
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push(body === undefined ? { url } : { url, body })
    const method = url.slice(url.lastIndexOf('/') + 1)
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, wsBase: 'http://127.0.0.1:9', value: (queue.get(method) ?? []).shift() }) } as unknown as Response
  }
  vi.stubGlobal('fetch', fake)
  return calls
}

const first: TerminalInfo = { id: 't-1', title: 'pwsh', cwd: 'H:/workspace', running: true, sequence: 0 }
const second: TerminalInfo = { id: 't-2', title: 'pwsh (1)', cwd: 'H:/workspace', running: true, sequence: 0 }

afterEach(() => vi.unstubAllGlobals())

describe('terminal workspace controller', () => {
  it('creates a terminal in one round trip and appends it to the snapshot', async () => {
    const calls = stubFetch({ create: [first] })
    const workspace = new TerminalWorkspaceController('session-1')
    await expect(workspace.create()).resolves.toEqual(first)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('/dsh-vscode-terminal/api/create')
    expect(calls[0]?.body).toEqual({ sessionId: 'session-1' })
    expect(workspace.getSnapshot().terminals).toEqual([first])
  })

  it('adopts the list the host returns when closing, without a follow-up list request', async () => {
    const calls = stubFetch({ create: [first], close: [[]] })
    const workspace = new TerminalWorkspaceController('session-1')
    await workspace.create()
    await workspace.close('t-1')
    expect(calls.map(call => call.url)).toEqual(['/dsh-vscode-terminal/api/create', '/dsh-vscode-terminal/api/close'])
    expect(workspace.getSnapshot().terminals).toEqual([])
  })

  it('replaces the renamed entry in place', async () => {
    const renamed: TerminalInfo = { ...first, title: '构建' }
    const calls = stubFetch({ create: [first], rename: [renamed] })
    const workspace = new TerminalWorkspaceController('session-1')
    await workspace.create()
    await workspace.rename('t-1', '构建')
    expect(calls.map(call => call.url)).toEqual(['/dsh-vscode-terminal/api/create', '/dsh-vscode-terminal/api/rename'])
    expect(workspace.getSnapshot().terminals).toEqual([renamed])
  })

  it('keeps the second terminal appended in host order', async () => {
    const calls = stubFetch({ create: [first, second] })
    const workspace = new TerminalWorkspaceController('session-1')
    await workspace.create()
    await workspace.create()
    expect(calls).toHaveLength(2)
    expect(workspace.getSnapshot().terminals.map(value => value.id)).toEqual(['t-1', 't-2'])
  })
})

describe('terminal startup wiring', () => {
  it('keeps hidden xterm instances mounted so switching back does not rebuild or replay', () => {
    const panel = read('TerminalPanel.tsx')
    // 隐藏的窗格留在 DOM 里，只加 hidden 属性；不再按 shown 列表决定是否挂载。
    expect(panel).toContain('hidden={hidden}')
    expect(panel).toContain('hidden={!shown.includes(id)}')
    expect(panel).toContain('const [opened, setOpened] = useState<readonly string[]>([])')
    // 新建请求发出后先显示占位，不让点击看起来没反应。
    expect(panel).toContain('setPending(value => value + 1)')
    expect(panel).toContain('正在启动终端…')
  })

  it('keeps the bottom panel mounted (display:none) after it is collapsed', () => {
    const workbench = read('Workbench.tsx')
    expect(workbench).toContain('const bottomPanelRef=useRef<string|undefined>(undefined)')
    expect(workbench).toContain('const bottomPanelId=snapshot.bottomPanel??bottomPanelRef.current')
    expect(workbench).toContain("display:'none'")
    expect(workbench).toContain('visible={snapshot.bottomPanel!==undefined}')
  })
})
