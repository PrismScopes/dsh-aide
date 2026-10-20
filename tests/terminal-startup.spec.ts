import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IPty } from 'node-pty'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { TerminalWorkspaceController } from '../src/client/terminal.ts'
import { TerminalManager, terminalPrewarmEnabled } from '../src/terminal.ts'
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

  it('prewarms with one request without touching the terminal list', async () => {
    const calls = stubFetch({ prewarm: [[]] })
    const workspace = new TerminalWorkspaceController('session-1')
    await workspace.prewarm()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('/dsh-vscode-terminal/api/prewarm')
    expect(workspace.getSnapshot().terminals).toEqual([])
  })
})

/** 假 pty：只记录输出订阅者与 kill 次数，用来观察 manager 是否真的认领了预热 shell。 */
interface FakePty { child: IPty; emit(data: string): void; killed(): number }

function fakePty(): FakePty {
  const listeners: Array<(data: string) => void> = []
  let killed = 0
  const child = {
    pid: 1,
    kill: () => { killed++ },
    onData: (handler: (data: string) => void) => { listeners.push(handler) },
    onExit: () => { /* 这个假 pty 永不退出，除非测试显式需要。 */ },
    write: () => {},
    resize: () => {},
  } as unknown as IPty
  return { child, emit: data => { for (const handler of listeners) handler(data) }, killed: () => killed }
}

describe('terminal prewarm', () => {
  let root = ''
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'dvw-prewarm-')) })
  afterAll(() => { rmSync(root, { recursive: true, force: true }) })

  function setup(): { created: FakePty[]; manager: TerminalManager } {
    const created: FakePty[] = []
    const manager = new TerminalManager(() => { const pty = fakePty(); created.push(pty); return pty.child })
    return { created, manager }
  }

  it('hands the prewarmed shell to the next default terminal instead of spawning twice', () => {
    const { created, manager } = setup()
    manager.prewarm(root)
    expect(created).toHaveLength(1)
    // 预热期间 shell 已经吐出了提示符：这份输出要进回放缓冲，用户点新建时直接看到。
    created[0]?.emit('PS H:\\> ')
    const info = manager.create(root)
    expect(created).toHaveLength(1)
    expect(info.id).not.toBe('')
    expect(info.title).not.toBe('')
    expect(manager.list(root)).toHaveLength(1)
    manager.dispose()
  })

  it('prewarms only once per workspace', () => {
    const { created, manager } = setup()
    manager.prewarm(root)
    manager.prewarm(root)
    expect(created).toHaveLength(1)
    manager.dispose()
  })

  it('opens a directory terminal on a fresh shell, leaving the warm one for the next default', () => {
    mkdirSync(join(root, 'sub'), { recursive: true })
    const { created, manager } = setup()
    manager.prewarm(root)
    manager.create(root, undefined, undefined, 'sub')
    expect(created).toHaveLength(2)
    // 子目录那次不该消耗预热：下一次默认新建仍然认领第一次起的那个 shell。
    manager.create(root)
    expect(created).toHaveLength(2)
    manager.dispose()
  })

  it('kills the prewarmed shell when nobody claims it in time', () => {
    vi.useFakeTimers()
    try {
      const created: FakePty[] = []
      const manager = new TerminalManager(() => { const pty = fakePty(); created.push(pty); return pty.child }, 1000)
      manager.prewarm(root)
      vi.advanceTimersByTime(1000)
      expect(created[0]?.killed()).toBe(1)
      // 定时器到点后预热槽已清空：再新建必须现起一个。
      manager.create(root)
      expect(created).toHaveLength(2)
      manager.dispose()
    } finally { vi.useRealTimers() }
  })

  it('kills the prewarmed shell when the plugin is disposed', () => {
    const { created, manager } = setup()
    manager.prewarm(root)
    manager.dispose()
    expect(created[0]?.killed()).toBe(1)
  })

  it('reads the deployment switch that turns prewarming off', () => {
    expect(terminalPrewarmEnabled({})).toBe(true)
    expect(terminalPrewarmEnabled({ DWV_TERMINAL_PREWARM: '1' })).toBe(true)
    expect(terminalPrewarmEnabled({ DWV_TERMINAL_PREWARM: 'on' })).toBe(true)
    expect(terminalPrewarmEnabled({ DWV_TERMINAL_PREWARM: '0' })).toBe(false)
    expect(terminalPrewarmEnabled({ DWV_TERMINAL_PREWARM: 'false' })).toBe(false)
    expect(terminalPrewarmEnabled({ DWV_TERMINAL_PREWARM: ' OFF ' })).toBe(false)
  })

  it('becomes a no-op when prewarming is disabled, while normal creation still works', () => {
    const created: FakePty[] = []
    const manager = new TerminalManager(() => { const pty = fakePty(); created.push(pty); return pty.child }, 90_000, () => false)
    manager.prewarm(root)
    expect(created).toHaveLength(0)
    // 预热关掉不影响正常新建：点击「新建终端」时照常现起一个 shell。
    expect(manager.create(root).id).not.toBe('')
    expect(created).toHaveLength(1)
    manager.dispose()
  })
})

/**
 * 预热收益的真机测量（默认跳过：要起真的 shell，CI 上慢且依赖本机 shell）。
 *
 * 跑法：`DWV_PREWARM_BENCH=1 pnpm vitest run tests/terminal-startup.spec.ts`
 * 断言的是「认领预热 create 立刻返回，且回放缓冲里已经有提示符」——这就是终端启动收益的证据。
 */
describe.skipIf(process.env.DWV_PREWARM_BENCH !== '1')('terminal prewarm benchmark (real pty)', () => {
  it('adopts a warm shell that already printed its prompt', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const workspace = mkdtempSync(join(tmpdir(), 'dvw-prewarm-bench-'))
    const manager = new TerminalManager()
    try {
      const warmStarted = performance.now()
      manager.prewarm(workspace)
      // 等预热 shell 吐出提示符（最多 8 秒；pwsh 实测 ~530ms）。
      let warmReplay = ''
      while (performance.now() - warmStarted < 8000) {
        const handle = (manager as unknown as { warm?: { handle: { replay: { tail(): string } } } }).warm
        warmReplay = handle?.handle.replay.tail() ?? ''
        if (warmReplay !== '') break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(warmReplay.length).toBeGreaterThan(0)
      console.log(`[prewarm] warm shell ready after ${(performance.now() - warmStarted).toFixed(0)}ms, replay=${warmReplay.length}B`)

      const adoptedAt = performance.now()
      const info = manager.create(workspace)
      const adoptMs = performance.now() - adoptedAt
      const handle = manager.get(workspace, info.id)
      const replay = handle?.replay.tail() ?? ''
      console.log(`[prewarm] create() adopted warm shell in ${adoptMs.toFixed(1)}ms, replay=${replay.length}B`)
      expect(replay.length).toBeGreaterThan(0)
      expect(adoptMs).toBeLessThan(50)
    } finally {
      manager.dispose()
      try { rmSync(workspace, { recursive: true, force: true }) } catch { /* Windows 上刚退出的 shell 可能还占着目录。 */ }
    }
  }, 30_000)
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
    // 面板可见且没有终端时预热默认 shell；预热失败不影响正常新建。
    expect(panel).toContain('if (!visible || snapshot.terminals.length > 0) return')
    expect(panel).toContain('workspace.prewarm()')
  })

  it('keeps the bottom panel mounted (display:none) after it is collapsed', () => {
    const workbench = read('Workbench.tsx')
    expect(workbench).toContain('const bottomPanelRef=useRef<string|undefined>(undefined)')
    expect(workbench).toContain('const bottomPanelId=snapshot.bottomPanel??bottomPanelRef.current')
    expect(workbench).toContain("display:'none'")
    expect(workbench).toContain('visible={snapshot.bottomPanel!==undefined}')
  })
})
