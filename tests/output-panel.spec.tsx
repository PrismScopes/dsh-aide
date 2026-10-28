import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  OUTPUT_LINE_HEIGHT,
  OutputPanel,
  parseOutputLinks,
  resolveOutputPath,
  visibleLineRange,
} from '../src/client/OutputPanel.tsx'
import {
  DEFAULT_OUTPUT_LEVEL_FILTERS,
  OUTPUT_CHANNEL_KEY,
  OUTPUT_LIMIT,
  OUTPUT_LEVELS,
  appendOutput,
  clearOutput,
  countOutputLevels,
  filterOutputLines,
  normalizeLevel,
  outputLines,
  readOutputChannel,
  resetOutput,
  saveOutputChannel,
  type OutputLevel,
} from '../src/client/output.ts'

/**
 * 「输出」面板测试。
 *
 * 分四层（只做纯数据/静态渲染，交互由导出的纯函数与接线断言兜住）：
 *   1. store：环形缓冲、多行拆分、级别归一化（含旧值别名）、按通道清空；
 *   2. 过滤：五级开关/文本过滤是隐藏而非删除，计数与快照引用；
 *   3. 链接与虚拟化：`path:line(:col)` 解析（Windows 盘符、/ 与 \）、相对路径解析、可视窗口夹取；
 *   4. 面板 SSR：空态/五级按钮计数/级别着色/文件链接/虚拟化只渲染可视区 + 静态接线。
 */

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')
}

function render(): string {
  return renderToStaticMarkup(<OutputPanel sessionId="s" cwd="/ws" visible colorScheme="dark" header={null} activePath="src/a.ts"/>)
}

function renderedLineCount(html: string): number {
  return (html.match(/class="dvw-output-line"/g) ?? []).length
}

/** 内存版 localStorage：模拟浏览器持久化，不碰真实存储。 */
function fakeStorage(initial: Record<string, string> = {}): { values: Map<string, string>; storage: { getItem(key: string): string | null; setItem(key: string, value: string): void } } {
  const values = new Map(Object.entries(initial))
  return {
    values,
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetOutput()
})

describe('output store', () => {
  beforeEach(() => resetOutput())

  it('keeps the newest lines and drops the oldest beyond the limit', () => {
    for (let index = 0; index < OUTPUT_LIMIT + 5; index++) appendOutput('language', `line ${index}`)
    const lines = outputLines('language')
    expect(lines).toHaveLength(OUTPUT_LIMIT)
    expect(lines[0]?.text).toBe('line 5')
    expect(lines.at(-1)?.text).toBe(`line ${OUTPUT_LIMIT + 4}`)
    // 几千行而不是几百：五级日志（trace/debug）比原来的三级啰嗦。
    expect(OUTPUT_LIMIT).toBeGreaterThanOrEqual(3000)
    expect(OUTPUT_LIMIT).toBeLessThanOrEqual(5000)
  })

  it('clears one channel without touching the other', () => {
    appendOutput('language', 'LSP 已就绪')
    appendOutput('git', 'git status')
    clearOutput('language')
    expect(outputLines('language')).toHaveLength(0)
    expect(outputLines('git').map(line => line.text)).toEqual(['git status'])
  })

  it('returns a stable snapshot until the channel changes', () => {
    appendOutput('language', 'a')
    expect(outputLines('language')).toBe(outputLines('language'))
    const before = outputLines('language')
    appendOutput('language', 'b')
    expect(outputLines('language')).not.toBe(before)
  })

  it('splits multi-line appends into fixed-height rows', () => {
    appendOutput('language', '第一行\n第二行\r\n第三行')
    expect(outputLines('language').map(line => line.text)).toEqual(['第一行', '第二行', '第三行'])
    appendOutput('language', '末尾换行\n')
    expect(outputLines('language').map(line => line.text)).toEqual(['第一行', '第二行', '第三行', '末尾换行'])
  })

  it('normalizes the five levels and keeps old level values working', () => {
    const cases: ReadonlyArray<readonly [unknown, OutputLevel]> = [
      ['trace', 'trace'],
      ['verbose', 'trace'],
      ['debug', 'debug'],
      ['DEBUG', 'debug'],
      ['info', 'info'],
      ['log', 'info'],
      ['warn', 'warn'],
      ['warning', 'warn'],
      ['error', 'error'],
      ['fatal', 'error'],
      [42, 'info'],
      [undefined, 'info'],
      [null, 'info'],
      ['wat', 'info'],
    ]
    for (const [input, expected] of cases) expect(normalizeLevel(input)).toBe(expected)

    // 旧调用方（或外部插件）仍可能传三级的旧写法：运行时归一，不丢行。
    appendOutput('language', '旧值级别', 'warning' as unknown as OutputLevel)
    expect(outputLines('language')[0]?.level).toBe('warn')
  })
})

describe('output filtering', () => {
  beforeEach(() => resetOutput())

  function seedFiveLevels(): void {
    appendOutput('language', 'trace 细节', 'trace')
    appendOutput('language', 'debug 细节', 'debug')
    appendOutput('language', 'info 普通', 'info')
    appendOutput('language', 'warn 警告', 'warn')
    appendOutput('language', 'error 失败', 'error')
  }

  it('counts every level of the whole channel', () => {
    seedFiveLevels()
    expect(countOutputLevels(outputLines('language'))).toEqual({ trace: 1, debug: 1, info: 1, warn: 1, error: 1 })
  })

  it('hides lines by level without deleting them', () => {
    seedFiveLevels()
    const before = outputLines('language')
    const visible = filterOutputLines(before, { ...DEFAULT_OUTPUT_LEVEL_FILTERS, trace: false, debug: false }, '')
    expect(visible.map(line => line.level)).toEqual(['info', 'warn', 'error'])
    // 关掉级别不清 store：重新打开立即恢复（隐藏不是删除）。
    expect(outputLines('language')).toBe(before)
    const restored = filterOutputLines(before, DEFAULT_OUTPUT_LEVEL_FILTERS, '')
    expect(restored).toBe(before)
    expect(restored).toHaveLength(5)
  })

  it('filters by text case-insensitively and returns the original array when idle', () => {
    appendOutput('language', 'SQLITE_BUSY: database is locked', 'warn')
    appendOutput('language', '连接已建立', 'info')
    const lines = outputLines('language')
    expect(filterOutputLines(lines, DEFAULT_OUTPUT_LEVEL_FILTERS, '')).toBe(lines)
    expect(filterOutputLines(lines, DEFAULT_OUTPUT_LEVEL_FILTERS, '  ')).toBe(lines)
    expect(filterOutputLines(lines, DEFAULT_OUTPUT_LEVEL_FILTERS, 'sqlite_busy')).toHaveLength(1)
    expect(filterOutputLines(lines, DEFAULT_OUTPUT_LEVEL_FILTERS, '连接')).toHaveLength(1)
    expect(filterOutputLines(lines, { ...DEFAULT_OUTPUT_LEVEL_FILTERS, warn: false }, 'sqlite')).toHaveLength(0)
  })
})

describe('output channel persistence', () => {
  it('round-trips the active channel and falls back to language for invalid values', () => {
    const { values, storage } = fakeStorage()
    vi.stubGlobal('localStorage', storage)

    expect(readOutputChannel()).toBe('language')
    saveOutputChannel('git')
    expect(values.get(OUTPUT_CHANNEL_KEY)).toBe('git')
    expect(readOutputChannel()).toBe('git')

    values.set(OUTPUT_CHANNEL_KEY, 'nonsense')
    expect(readOutputChannel()).toBe('language')
  })

  it('falls back to language when storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(readOutputChannel()).toBe('language')
    expect(() => saveOutputChannel('git')).not.toThrow()
  })
})

describe('file links', () => {
  it('parses path:line:col and path:line for Windows, / and \\ forms', () => {
    const text = '打开 src/a.ts:12:3 与 C:\\ws\\b.ts:7 和 /ws/c.ts:2 结束'
    const segments = parseOutputLinks(text, '/ws')
    // 片段拼回去必须等于原文（不能吞掉或重复字符）。
    expect(segments.map(segment => segment.text).join('')).toBe(text)
    const links = segments.filter(segment => segment.kind === 'link')
    expect(links.map(segment => segment.kind === 'link'
      ? [segment.link.path, segment.link.line, segment.link.column, segment.link.absolutePath]
      : null)).toEqual([
      ['src/a.ts', 12, 3, '/ws/src/a.ts'],
      ['C:\\ws\\b.ts', 7, undefined, 'C:\\ws\\b.ts'],
      ['/ws/c.ts', 2, undefined, '/ws/c.ts'],
    ])
  })

  it('resolves relative paths against the workspace root and keeps absolute paths intact', () => {
    expect(resolveOutputPath('/ws', 'src/a.ts')).toBe('/ws/src/a.ts')
    // 输出里常见反斜杠相对路径；按工作区分隔符归一。
    expect(resolveOutputPath('/ws', 'src\\a.ts')).toBe('/ws/src/a.ts')
    expect(resolveOutputPath('C:\\ws', 'src/a.ts')).toBe('C:\\ws\\src\\a.ts')
    expect(resolveOutputPath('/ws', '/abs/x.ts')).toBe('/abs/x.ts')
    expect(resolveOutputPath('/ws', 'C:\\other\\x.ts')).toBe('C:\\other\\x.ts')
  })

  it('keeps timestamps, URLs and bare words as plain text', () => {
    for (const text of ['时间 12:30:45 与 http://example.com:8080', 'foo:12', '没有链接', 'a.ts:0', 'a.ts:12:0']) {
      const segments = parseOutputLinks(text, '/ws')
      expect(segments).toHaveLength(1)
      expect(segments[0]).toEqual({ kind: 'text', text })
    }
  })

  it('treats a bare file name with line as a workspace-relative link', () => {
    const segments = parseOutputLinks('main.ts:5', '/ws')
    expect(segments[0]).toMatchObject({ kind: 'link', link: { path: 'main.ts', line: 5, absolutePath: '/ws/main.ts' } })
  })
})

describe('virtualization window', () => {
  it('maps scroll position to a clamped row window with overscan', () => {
    expect(visibleLineRange(0, 0, 540)).toEqual({ start: 0, end: 0 })
    // 视口 180px = 10 行，overscan 5。
    expect(visibleLineRange(100, 0, 180, 5)).toEqual({ start: 0, end: 15 })
    expect(visibleLineRange(100, 20 * OUTPUT_LINE_HEIGHT, 180, 5)).toEqual({ start: 15, end: 35 })
    expect(visibleLineRange(100, -100, 180, 5)).toEqual({ start: 0, end: 15 })
    // 滚动越界时夹到最后一行，不能越界切片。
    const tail = visibleLineRange(100, 1_000_000, 180, 5)
    expect(tail.end).toBe(100)
    expect(tail.start).toBe(100 - 1 - 5)
  })
})

describe('OutputPanel (SSR)', () => {
  beforeEach(() => resetOutput())

  it('renders the channel picker, five level filters and the language empty state', () => {
    const html = render()
    expect(html).toContain('class="dvw-output"')
    expect(html).toContain('aria-label="输出通道"')
    expect(html).toContain('语言服务')
    expect(html).toContain('Git')
    expect(html).toContain('还没有语言服务输出')
    expect(html).toContain('role="log"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('placeholder="按内容过滤"')
    // 五级按钮：默认全开，标签中文，计数 0。
    for (const level of OUTPUT_LEVELS) expect(html).toContain(`data-level="${level}"`)
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(5)
    for (const [level, label] of [['trace', '跟踪'], ['debug', '调试'], ['info', '信息'], ['warn', '警告'], ['error', '错误']] as const) {
      expect(html).toContain(`aria-label="${label}（0）"`)
      expect(html).toContain(`data-level="${level}"`)
    }
    // 空通道：清空/复制/加入对话都禁用。
    expect(html.match(/disabled=""/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  it('renders lines with time, level coloring and per-level counts', () => {
    appendOutput('language', '启动语言服务器 pyright')
    appendOutput('language', '启动失败：missing binary', 'error')
    appendOutput('language', '连接已断开', 'warn')
    const html = render()
    expect(html).toContain('启动语言服务器 pyright')
    expect(html).toContain('启动失败：missing binary')
    expect(html).toContain('data-level="error"')
    expect(html).toContain('data-level="warn"')
    expect(html).toContain('class="dvw-output-time"')
    expect(html).toContain('aria-label="错误（1）"')
    expect(html).toContain('aria-label="警告（1）"')
    expect(html).toContain('aria-label="信息（1）"')
    // 有内容后清空按钮可用。
    expect(html).not.toMatch(/class="dvw-output-clear" disabled=""/)
  })

  it('renders a file link as a clickable button while keeping plain text plain', () => {
    appendOutput('language', '错误位置 /ws/src/a.ts:12:3 请查看', 'error')
    appendOutput('language', '时间 12:30:45 不是链接')
    const html = render()
    expect(html).toContain('class="dvw-output-link"')
    expect(html).toContain('title="打开 /ws/src/a.ts:12:3"')
    // 时间戳仍是纯文本（整行只有一个链接按钮：文件位置那个）。
    expect(html).toContain('时间 12:30:45 不是链接')
    expect(html.match(/class="dvw-output-link"/g)).toHaveLength(1)
  })

  it('keeps only the visible window of a long log', () => {
    for (let index = 0; index < 200; index++) appendOutput('language', `line ${index}`)
    const html = render()
    const rendered = renderedLineCount(html)
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(200)
    expect(html).toContain('line 0')
    expect(html).not.toContain('line 199')
    expect(html).toContain('class="dvw-output-spacer"')
    expect(html).toContain('class="dvw-output-rows"')
  })

  it('restores the persisted channel and renders its own empty state', () => {
    vi.stubGlobal('localStorage', fakeStorage({ [OUTPUT_CHANNEL_KEY]: 'git' }).storage)
    expect(render()).toContain('还没有 Git 输出')
  })

  it('renders the Git channel lines from the same store', () => {
    vi.stubGlobal('localStorage', fakeStorage({ [OUTPUT_CHANNEL_KEY]: 'git' }).storage)
    appendOutput('git', 'git status 执行失败', 'warn')
    const html = render()
    expect(html).toContain('git status 执行失败')
    expect(html).toContain('data-level="warn"')
    expect(html).not.toContain('还没有 Git 输出')
  })
})

describe('output wiring', () => {
  const component = read('src/client/OutputPanel.tsx')
  const store = read('src/client/output.ts')
  const panelStyles = read('src/client/outputStyles.ts')
  const sharedStyles = read('src/client/styles.ts')
  const clientIndex = read('src/client/index.tsx')
  const languageClient = read('src/client/language/client.ts')
  const gitOutput = read('src/client/gitOutput.ts')

  it('jumps through the shared location picker and offers conversation/copy actions', () => {
    expect(component).not.toContain('window.prompt')
    expect(component).toContain('openLocationAt(')
    expect(component).toContain('requestContextCard(')
    expect(component).toContain('copyText(')
    expect(component).toContain('role="log"')
  })

  it('persists the channel and keeps the five-level store contract', () => {
    expect(store).toContain(`OUTPUT_CHANNEL_KEY = '${OUTPUT_CHANNEL_KEY}'`)
    expect(store).toContain('localStorage')
    for (const level of OUTPUT_LEVELS) expect(store).toContain(`'${level}'`)
    expect(component).toContain('readOutputChannel(')
    expect(component).toContain('saveOutputChannel(')
  })

  it('reads the level counts and filter from pure functions instead of duplicating logic', () => {
    expect(component).toContain('countOutputLevels(')
    expect(component).toContain('filterOutputLines(')
    expect(component).toContain('OUTPUT_LINE_HEIGHT')
  })

  it('ships virtualized styles through outputStyles.ts interpolated by styles.ts', () => {
    expect(panelStyles).toContain('.dvw-output-level')
    expect(panelStyles).toContain('.dvw-output-link')
    expect(panelStyles).toContain('.dvw-output-spacer')
    expect(panelStyles).toContain('.dvw-output-rows')
    expect(panelStyles).toContain('height:18px')
    // 样式由 Lead 抽到 outputStyles.ts，styles.ts 只做插值。
    expect(sharedStyles).toContain('OUTPUT_STYLES')
    expect(sharedStyles).toContain('${OUTPUT_STYLES}')
  })

  it('keeps the panel wired to its sources and registration', () => {
    expect(clientIndex).toContain("id: 'output'")
    expect(clientIndex).toContain("title: '输出'")
    expect(clientIndex).toContain('OutputPanel')
    expect(languageClient).toContain("appendOutput('language'")
    expect(gitOutput).toContain("appendOutput('git'")
  })
})
