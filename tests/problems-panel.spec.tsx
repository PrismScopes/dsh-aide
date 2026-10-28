import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProblemsPanel, ProblemRows, AI_FEEDBACK_MS, filterProblems, groupProblems, DEFAULT_SEVERITY_FILTERS } from '../src/client/ProblemsPanel.tsx'
import {
  buildProblemRows,
  contextMenuSpecs,
  ensureRowVisible,
  fileRowKey,
  filterByCurrentFile,
  FILE_ROW_HEIGHT,
  formatProblemLocation,
  problemRowKey,
  PROBLEM_MULTILINE_ROW_HEIGHT,
  PROBLEM_ROW_HEIGHT,
  rowIndexForKey,
  rowOffsets,
  sortFlatEntries,
  stepRowIndex,
  toggleTargetOf,
  virtualWindow,
  type ProblemRow,
} from '../src/client/problemView.ts'
import { diagnosticsStoreFor, resetDiagnosticsStores } from '../src/client/language/diagnostics.ts'
import type { DiagnosticsFile } from '../src/client/language/diagnostics.ts'
import type { LanguageDiagnostic } from '../src/language/protocol.ts'

/**
 * 问题面板的测试。
 *
 * 分三层：
 *   1. 纯函数（problemView）：分组/平铺、当前文件过滤、行高与虚拟化窗口、键盘导航、菜单描述 ——
 *      这些是「上千条诊断也不卡」的核心，必须能脱离浏览器断言；
 *   2. 静态渲染：`renderToStaticMarkup` 钉住默认分组视图、工具栏、空态与服务器摘要；
 *   3. 源码不变量：跳转走 openLocationAt、扫描走 workspace.scan、右键复用 ContextMenu、
 *      「交给 AI」走 requestContextCard、样式只用主题令牌。
 *
 * 交互（点击/键盘）不直接模拟：仓库没有 jsdom，交互逻辑都下沉到导出的纯函数，渲染层只做映射。
 */

/** 造一条诊断；行列默认 0 基 0:0，方便断言 1 基显示。 */
function diagnostic(
  severity: LanguageDiagnostic['severity'],
  message: string,
  line = 0,
  character = 0,
  extra: { source?: string; code?: string } = {},
): LanguageDiagnostic {
  return {
    severity,
    message,
    range: { start: { line, character }, end: { line, character: character + 1 } },
    ...extra,
  }
}

/** 造一份 store 里的文件快照（errors/warnings 由 store 自己统计，这里保持同样口径）。 */
function file(path: string, diagnostics: LanguageDiagnostic[]): DiagnosticsFile {
  return {
    path,
    diagnostics,
    errors: diagnostics.filter(item => item.severity === 'error').length,
    warnings: diagnostics.filter(item => item.severity === 'warning').length,
  }
}

const A_PATH = '/ws/src/a.ts'
const B_PATH = '/ws/src/b.ts'

/** 预置 /ws 的诊断：a.ts 的警告故意排在错误前面，验证面板排序不依赖推入顺序。 */
function seedWorkspace(): void {
  const store = diagnosticsStoreFor('/ws')
  store.setDiagnostics(A_PATH, [
    diagnostic('warning', '变量已声明但从未读取', 4, 0, { source: 'ts', code: 'TS6133' }),
    diagnostic('error', '类型“string”不能赋给“number”', 2, 4, { source: 'ts', code: 'TS2322' }),
  ])
  store.setDiagnostics(B_PATH, [diagnostic('info', '建议使用 const', 1, 8, { source: 'ts' })])
  // 立刻刷新合并窗口，测试里不依赖 80ms 的通知定时器。
  store.flush()
}

function render(cwd = '/ws', activePath?: string): string {
  return renderToStaticMarkup(<ProblemsPanel sessionId="s" cwd={cwd} visible colorScheme="dark" header={null} activePath={activePath}/>)
}

/** 渲染虚拟化行列表（不经过面板的滚动/状态，只为钉住「窗口内渲染」）。 */
function renderRows(rows: readonly ProblemRow[], viewportHeight: number, scrollTop = 0, overscan = 0): string {
  const offsets = rowOffsets(rows)
  return renderToStaticMarkup(<ProblemRows
    rows={rows}
    offsets={offsets}
    window={virtualWindow(offsets, viewportHeight, scrollTop, overscan)}
    highlightedIndex={-1}
    onActivate={() => undefined}
    onContextMenu={() => undefined}
  />)
}

function rowCountOf(html: string): number {
  return (html.match(/data-row-index="/g) ?? []).length
}

describe('ProblemsPanel', () => {
  beforeEach(() => {
    resetDiagnosticsStores()
    seedWorkspace()
  })
  afterEach(() => { resetDiagnosticsStores() })

  it('groups by file and renders message, source:code and 1-based position', () => {
    const html = render()
    expect(html).toContain('a.ts')
    expect(html).toContain('b.ts')
    expect(html).toContain('类型“string”不能赋给“number”')
    expect(html).toContain('变量已声明但从未读取')
    expect(html).toContain('建议使用 const')
    // 文件名加粗、相对目录灰字分列。
    expect(html).toContain('class="dvw-problems-file-name">a.ts<')
    expect(html).toContain('class="dvw-problems-file-dir">src<')
    // `source:code` 与 1 基行列（协议里 0 基的 2:4 显示成 3:5）。
    expect(html).toContain('ts:TS2322')
    expect(html).toContain('3:5')
    // 文件行与诊断行都是 listbox 的 option（键盘导航需要可高亮的行）。
    expect(html).toContain('class="dvw-problems-row dvw-problems-file"')
    expect(html).toContain('class="dvw-problems-row dvw-problems-item"')
    expect(html).toContain('role="listbox"')
    // 同文件内错误排在警告前，与推入顺序无关。
    expect(html.indexOf('类型“string”不能赋给“number”')).toBeLessThan(html.indexOf('变量已声明但从未读取'))
  })

  it('shows severity filters with counts plus the view-mode and toggle controls', () => {
    const html = render()
    expect(html).toContain('placeholder="按文件或描述过滤"')
    expect(html).toContain('扫描工作区')
    // 视图模式默认按文件分组；多行默认关闭；「交给 AI」在工具栏。
    expect(html).toContain('data-view="grouped" aria-pressed="true"')
    expect(html).toContain('data-view="flat" aria-pressed="false"')
    expect(html).toContain('data-action="multiline" aria-pressed="false"')
    expect(html).toContain('交给 AI')
    // 只有三个严重级别按钮被按下（视图模式按钮也是 aria-pressed，分开数）。
    const pressedFilters = html.match(/class="dvw-problems-filter"[^>]*aria-pressed="true"/g) ?? []
    expect(pressedFilters).toHaveLength(3)
    for (const [severity, label, count] of [['error', '错误', '1'], ['warning', '警告', '1'], ['info', '信息', '1']] as const) {
      expect(html).toContain(`data-severity="${severity}"`)
      expect(html).toContain(`aria-label="${label}（${count}）"`)
    }
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(2)
    // 文件行的错误/警告徽标。
    expect(html).toContain('class="dvw-problems-file-count" data-severity="error">✕ 1<')
    expect(html).toContain('class="dvw-problems-file-count" data-severity="warning">! 1<')
  })

  it('disables the current-file toggle without an active file and enables it with one', () => {
    // 没有打开的文件：「仅当前文件」禁用（开关状态保留但不生效）。
    expect(render()).toMatch(/data-action="current-file" aria-pressed="false" disabled=""/)
    // 有活动文件：可点，仍然默认关闭。
    expect(render('/ws', 'src/a.ts')).toMatch(/data-action="current-file" aria-pressed="false" title="只显示当前编辑器文件的问题"/)
    expect(render('/ws', 'src/a.ts')).not.toMatch(/data-action="current-file"[^>]*disabled/)
  })

  it('renders the empty state for a workspace without diagnostics', () => {
    const html = render('/empty')
    expect(html).toContain('没有发现问题')
    expect(html).toContain('打开文件后语言服务会自动诊断')
    expect(html).not.toContain('dvw-problems-file')
    expect(html).not.toContain('dvw-problems-item')
    // 没有可渲染的行时列表不声明 listbox（空态不是选项列表）。
    expect(html).not.toContain('role="listbox"')
    // 语言服务状态还没推过来：不渲染摘要，也不炸。
    expect(html).not.toContain('dvw-problems-servers')
  })

  it('renders on the server without browser globals', () => {
    // renderToStaticMarkup 是测试主路径；这里显式钉住「没有 window 也能渲染」。
    expect(typeof window).toBe('undefined')
    expect(() => render()).not.toThrow()
  })

  it('shows scan progress, disables the scan button while running, and lists server states', () => {
    diagnosticsStoreFor('/ws').applyStatus({
      type: 'status',
      builtin: { enabled: true, state: 'ready', version: '5.6.3' },
      servers: [
        { id: 'pyright', name: 'Pyright', languages: ['python'], state: 'missing' },
        { id: 'rust-analyzer', name: 'rust-analyzer', languages: ['rust'], state: 'running' },
      ],
      scan: { running: true, checked: 3, total: 10, errors: 2, warnings: 1 },
    })
    const html = render()
    expect(html).toContain('取消扫描')
    expect(html).toContain('正在扫描工作区 3/10')
    expect(html).toContain('内置 TypeScript 5.6.3（可用）')
    expect(html).toContain('Pyright（未安装）')
    expect(html).toContain('rust-analyzer（运行中）')
  })
})

describe('filterProblems', () => {
  const files: DiagnosticsFile[] = [
    file('/ws/src/a.ts', [diagnostic('error', '类型错误', 2, 4), diagnostic('warning', '未使用变量', 4, 0)]),
    file('/ws/lib/b.ts', [diagnostic('info', '建议 const', 1, 8, { source: 'ts' }), diagnostic('hint', '可以简化', 3, 2)]),
    file('/elsewhere/outside.ts', [diagnostic('error', '外部文件错误', 0, 0)]),
  ]

  it('keeps only the enabled severities and puts hints in the info bucket', () => {
    expect(filterProblems(files, DEFAULT_SEVERITY_FILTERS, '', '/ws')).toHaveLength(5)
    // 「信息」一档包含 hint：与过滤按钮的计数口径一致。
    expect(filterProblems(files, { error: false, warning: false, info: true }, '', '/ws').map(entry => entry.diagnostic.message))
      .toEqual(['建议 const', '可以简化'])
    expect(filterProblems(files, { error: true, warning: false, info: false }, '', '/ws').map(entry => entry.path))
      .toEqual(['/ws/src/a.ts', '/elsewhere/outside.ts'])
    expect(filterProblems(files, { error: false, warning: true, info: false }, '', '/ws')).toHaveLength(1)
  })

  it('computes display paths once per file and falls back outside the workspace', () => {
    const entries = filterProblems(files, DEFAULT_SEVERITY_FILTERS, '', '/ws')
    const a = entries[0]!
    expect(a).toMatchObject({ path: '/ws/src/a.ts', relativePath: 'src/a.ts', name: 'a.ts', directory: 'src' })
    // 同一文件的所有诊断共享同一份路径字段（不是每行各算一次）。
    expect(entries[1]!.relativePath).toBe(a.relativePath)
    const outside = entries.find(entry => entry.path === '/elsewhere/outside.ts')!
    expect(outside.relativePath).toBe('/elsewhere/outside.ts')
    expect(outside.name).toBe('outside.ts')
    expect(outside.directory).toBe('elsewhere')
  })

  it('matches the query against relative path and message, case-insensitively', () => {
    expect(filterProblems(files, DEFAULT_SEVERITY_FILTERS, 'a.ts', '/ws')).toHaveLength(2)
    expect(filterProblems(files, DEFAULT_SEVERITY_FILTERS, 'LIB', '/ws').map(entry => entry.relativePath))
      .toEqual(['lib/b.ts', 'lib/b.ts'])
    expect(filterProblems(files, DEFAULT_SEVERITY_FILTERS, '未使用', '/ws')).toHaveLength(1)
    // 纯空白等于不过滤。
    expect(filterProblems(files, DEFAULT_SEVERITY_FILTERS, '   ', '/ws')).toHaveLength(5)
    expect(filterProblems(files, DEFAULT_SEVERITY_FILTERS, '不存在的内容', '/ws')).toHaveLength(0)
  })
})

describe('groupProblems', () => {
  it('sorts groups by relative path and items by severity then position', () => {
    const files = [
      file('/ws/src/a.ts', [
        diagnostic('warning', '警告一', 1, 0),
        diagnostic('error', '错误二', 5, 0),
        diagnostic('error', '错误一', 1, 4),
      ]),
      file('/ws/lib/b.ts', [diagnostic('hint', '提示', 0, 0)]),
    ]
    const groups = groupProblems(filterProblems(files, DEFAULT_SEVERITY_FILTERS, '', '/ws'))
    expect(groups.map(group => group.relativePath)).toEqual(['lib/b.ts', 'src/a.ts'])
    expect(groups[1]).toMatchObject({ name: 'a.ts', directory: 'src', errors: 2, warnings: 1 })
    expect(groups[1]!.items.map(entry => entry.diagnostic.message)).toEqual(['错误一', '错误二', '警告一'])
  })

  it('counts only the problems that survived filtering', () => {
    const files = [file('/ws/src/a.ts', [diagnostic('error', '错误', 0, 0), diagnostic('warning', '警告', 1, 0)])]
    // 三档全关：没有任何可见问题，分组为空（文件行也不会出现）。
    expect(groupProblems(filterProblems(files, { error: false, warning: false, info: false }, '', '/ws'))).toEqual([])
    // 只留错误：文件行的警告徽标不应出现。
    const groups = groupProblems(filterProblems(files, { error: true, warning: false, info: false }, '', '/ws'))
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ errors: 1, warnings: 0 })
  })
})

describe('problemView rows', () => {
  const files: DiagnosticsFile[] = [
    file('/ws/src/a.ts', [
      diagnostic('warning', '警告', 4, 0),
      diagnostic('error', '错误', 2, 4),
    ]),
    file('/ws/lib/b.ts', [diagnostic('info', '信息', 1, 8)]),
  ]

  function entriesOf(): ReturnType<typeof filterProblems> {
    return filterProblems(files, DEFAULT_SEVERITY_FILTERS, '', '/ws')
  }

  it('builds grouped rows with file headers and expands/collapses by collapsed set', () => {
    const entries = entriesOf()
    const groups = groupProblems(entries)
    const expanded = buildProblemRows(groups, entries, { mode: 'grouped' })
    // 组间按相对路径排序：lib/b.ts 在 src/a.ts 前面，所以行序是「b 文件头 + 1 条 + a 文件头 + 2 条」。
    expect(expanded.map(row => row.kind)).toEqual(['file', 'problem', 'file', 'problem', 'problem'])
    expect(expanded[0]).toMatchObject({ kind: 'file', relativePath: 'lib/b.ts', expanded: true, height: FILE_ROW_HEIGHT })
    expect(expanded[1]).toMatchObject({ kind: 'problem', height: PROBLEM_ROW_HEIGHT })
    // 同一输入重建两次：键必须稳定（高亮与滚动锚点靠它）。
    expect(buildProblemRows(groups, entries, { mode: 'grouped' }).map(row => row.key)).toEqual(expanded.map(row => row.key))

    const collapsed = buildProblemRows(groups, entries, { mode: 'grouped', collapsed: new Set(['/ws/src/a.ts']) })
    expect(collapsed.map(row => [row.kind, row.kind === 'file' ? row.path : ''])).toEqual([
      ['file', '/ws/lib/b.ts'],
      ['problem', ''],
      ['file', '/ws/src/a.ts'],
    ])
    expect(collapsed.at(-1)).toMatchObject({ kind: 'file', expanded: false })
  })

  it('builds a flat list sorted by severity, then path, then position', () => {
    const entries = entriesOf()
    const rows = buildProblemRows([], entries, { mode: 'flat' })
    expect(rows.every(row => row.kind === 'problem')).toBe(true)
    expect(rows.map(row => (row.kind === 'problem' ? row.entry.diagnostic.message : ''))).toEqual(['错误', '警告', '信息'])
    // sortFlatEntries 与行构造共用一套排序：直接断言导出的排序函数。
    expect(sortFlatEntries(entries).map(entry => entry.diagnostic.message)).toEqual(['错误', '警告', '信息'])
    // 平铺行不再有文件头行。
    expect(rows.some(row => row.kind === 'file')).toBe(false)

    // 同级严重度：先按路径，再按行列（而不是按文件/推入顺序）。
    const sameSeverity = filterProblems([
      file('/ws/src/b.ts', [diagnostic('error', 'b 文件', 0, 0)]),
      file('/ws/src/a.ts', [diagnostic('error', 'a 文件第 2 行', 1, 0), diagnostic('error', 'a 文件第 1 行第 3 列', 0, 2), diagnostic('error', 'a 文件第 1 行第 2 列', 0, 1)]),
    ], DEFAULT_SEVERITY_FILTERS, '', '/ws')
    expect(sortFlatEntries(sameSeverity).map(entry => entry.diagnostic.message))
      .toEqual(['a 文件第 1 行第 2 列', 'a 文件第 1 行第 3 列', 'a 文件第 2 行', 'b 文件'])
  })

  it('uses the tall row height in multi-line mode', () => {
    const entries = entriesOf()
    const rows = buildProblemRows(groupProblems(entries), entries, { mode: 'grouped', multiLine: true })
    const itemRows = rows.filter(row => row.kind === 'problem')
    expect(itemRows.length).toBe(3)
    expect(itemRows.every(row => row.height === PROBLEM_MULTILINE_ROW_HEIGHT)).toBe(true)
    // 文件头行高不受多行模式影响。
    expect(rows.find(row => row.kind === 'file')?.height).toBe(FILE_ROW_HEIGHT)
  })

  it('filters by the active file using relative or absolute paths', () => {
    const entries = entriesOf()
    expect(filterByCurrentFile(entries, undefined)).toHaveLength(3)
    // filterProblems 保持「文件迭代序 + 文件内推入序」，当前文件过滤不改变这个顺序。
    expect(filterByCurrentFile(entries, 'src/a.ts').map(entry => entry.diagnostic.message)).toEqual(['警告', '错误'])
    // 标签里也可能放绝对路径（外部只读文件）。
    expect(filterByCurrentFile(entries, '/ws/src/a.ts').map(entry => entry.diagnostic.message)).toEqual(['警告', '错误'])
    // 路径分隔符归一化。
    expect(filterByCurrentFile(entries, 'src\\a.ts')).toHaveLength(2)
    expect(filterByCurrentFile(entries, 'src/missing.ts')).toEqual([])
  })

  it('keeps file and problem row keys distinct and stable', () => {
    const entry = entriesOf()[0]!
    expect(fileRowKey(entry.path)).toBe(`file\u0000${entry.path}`)
    expect(problemRowKey(entry)).toBe(`problem\u0000${entry.path}\u0000${entry.diagnostic.range.start.line}\u0000${entry.diagnostic.range.start.character}\u0000${entry.diagnostic.message}`)
    expect(problemRowKey(entry)).not.toBe(fileRowKey(entry.path))
  })

  it('formats the copied location with 1-based line and column', () => {
    // 协议里是 0 基的 2:4，复制出来必须是 3:5（与显示、编辑器一致）。
    expect(formatProblemLocation('src/a.ts', { line: 2, character: 4 })).toBe('src/a.ts:3:5')
    expect(formatProblemLocation('src/a.ts', { line: 0, character: 0 })).toBe('src/a.ts:1:1')
  })
})

describe('AI feedback state', () => {
  it('restores the button after about three seconds', () => {
    expect(AI_FEEDBACK_MS).toBe(3000)
  })
})

describe('virtualisation', () => {
  function manyRows(count: number): ProblemRow[] {
    const files = [file('/ws/src/many.ts', Array.from({ length: count }, (_value, index) => diagnostic('error', `问题 ${index}`, index, 0)))]
    return buildProblemRows([], filterProblems(files, DEFAULT_SEVERITY_FILTERS, '', '/ws'), { mode: 'flat' })
  }

  it('accumulates row offsets and computes a bounded visible window', () => {
    // 混合行高：本组是 file(26) + problem(24) + file(26) + problem(24) + problem(24)。
    const groupedEntries = filterProblems([
      file('/ws/src/a.ts', [diagnostic('warning', '警告', 4, 0), diagnostic('error', '错误', 2, 4)]),
      file('/ws/lib/b.ts', [diagnostic('info', '信息', 1, 8)]),
    ], DEFAULT_SEVERITY_FILTERS, '', '/ws')
    const grouped = buildProblemRows(groupProblems(groupedEntries), groupedEntries, { mode: 'grouped' })
    const groupedOffsets = rowOffsets(grouped)
    expect(groupedOffsets.slice(0, 3)).toEqual([0, 26, 50])
    expect(groupedOffsets.at(-1)).toBe(grouped.reduce((sum, row) => sum + row.height, 0))

    const rows = manyRows(200)
    const offsets = rowOffsets(rows)
    expect(offsets).toHaveLength(rows.length + 1)
    expect(offsets[1]).toBe(PROBLEM_ROW_HEIGHT)
    expect(offsets.at(-1)).toBe(rows.length * PROBLEM_ROW_HEIGHT)

    // 视口 120px、不 overscan：只能看到 5 行（24px 一行）。
    const top = virtualWindow(offsets, 120, 0, 0)
    expect(top.start).toBe(0)
    expect(top.end).toBe(5)
    expect(top.totalHeight).toBe(rows.length * PROBLEM_ROW_HEIGHT)
    expect(top.top).toBe(0)

    // 滚到中间：窗口跟着移动，起点不再是 0。
    const middle = virtualWindow(offsets, 120, 1200, 0)
    expect(middle.start).toBeGreaterThan(0)
    expect(middle.start).toBeLessThan(middle.end)
    expect(middle.end).toBeLessThan(rows.length)

    // 越界滚动（内容变短时浏览器会给超出范围的 scrollTop）：夹到最后一屏，不返回空窗口。
    const bottom = virtualWindow(offsets, 120, 1_000_000, 0)
    expect(bottom.end).toBe(rows.length)
    expect(bottom.start).toBeGreaterThan(0)

    // overscan 只影响渲染范围，不影响总高度。
    const withOverscan = virtualWindow(offsets, 120, 1200, 3)
    expect(withOverscan.start).toBe(middle.start - 3)
    expect(withOverscan.end).toBe(middle.end + 3)

    // 空列表。
    expect(virtualWindow([0], 120, 0)).toEqual({ start: 0, end: 0, top: 0, totalHeight: 0 })
    // 首帧没有量到高度（0）时按回退值渲染，不能得到空窗口。
    expect(virtualWindow(offsets, 0, 0).end).toBeGreaterThan(0)
  })

  it('scrolls the minimum amount needed to keep the highlighted row visible', () => {
    const offsets = [0, 24, 48, 72, 96, 120, 144, 168, 192, 216, 240]
    // 已经可见：不动。
    expect(ensureRowVisible(offsets, 2, 48, 24)).toBe(24)
    // 在视口上方：滚到行顶。
    expect(ensureRowVisible(offsets, 1, 48, 100)).toBe(24)
    // 在视口下方：滚到「行底贴住视口底」。
    expect(ensureRowVisible(offsets, 6, 48, 0)).toBe(120)
    // 越界下标不动。
    expect(ensureRowVisible(offsets, 99, 48, 0)).toBe(0)
  })

  it('renders only the window rows with absolute offsets', () => {
    const rows = manyRows(300)
    const offsets = rowOffsets(rows)
    const window = virtualWindow(offsets, 240, 2400, 2)
    const html = renderRows(rows, 240, 2400, 2)
    const rendered = rowCountOf(html)
    expect(rendered).toBe(window.end - window.start)
    expect(rendered).toBeLessThan(rows.length)
    // 窗口第一行与最后一行确实渲染了，且容器的总高度覆盖全部行。
    expect(html).toContain(`data-row-index="${window.start}"`)
    expect(html).toContain(`data-row-index="${window.end - 1}"`)
    expect(html).toContain(`height:${offsets.at(-1)}px`)
    expect(html).toContain(`top:${offsets[window.start]}px`)
  })

  it('keeps the rendered row count bounded for thousands of diagnostics', () => {
    const rows = manyRows(2000)
    const offsets = rowOffsets(rows)
    const window = virtualWindow(offsets, 400, 24_000, 4)
    expect(window.end - window.start).toBeLessThan(40)
    const html = renderRows(rows, 400, 24_000, 4)
    expect(rowCountOf(html)).toBe(window.end - window.start)
    expect(rowCountOf(html)).toBeLessThan(40)
  })

  it('renders flat mode without file headers and tall rows in multi-line mode', () => {
    const files = [file('/ws/src/a.ts', [diagnostic('error', '错误', 0, 0), diagnostic('warning', '警告', 1, 0)])]
    const entries = filterProblems(files, DEFAULT_SEVERITY_FILTERS, '', '/ws')
    const flat = buildProblemRows([], entries, { mode: 'flat' })
    const flatHtml = renderRows(flat, 400)
    expect(flatHtml).not.toContain('data-row-kind="file"')
    expect(flatHtml).toContain('data-row-kind="problem"')
    expect(flatHtml.indexOf('错误')).toBeLessThan(flatHtml.indexOf('警告'))

    const multi = buildProblemRows(groupProblems(entries), entries, { mode: 'grouped', multiLine: true })
    const multiHtml = renderRows(multi, 400)
    expect(multiHtml).toContain('data-multiline="true"')
    expect(multiHtml).toContain(`height:${PROBLEM_MULTILINE_ROW_HEIGHT}px`)
    // 文件头仍是 26px。
    expect(multiHtml).toContain(`height:${FILE_ROW_HEIGHT}px`)
  })
})

describe('keyboard navigation helpers', () => {
  const files = [
    file('/ws/src/a.ts', [diagnostic('error', '错误一', 0, 0), diagnostic('error', '错误二', 2, 0)]),
    file('/ws/lib/b.ts', [diagnostic('warning', '警告', 1, 0)]),
  ]
  const rows = buildProblemRows(groupProblems(filterProblems(files, DEFAULT_SEVERITY_FILTERS, '', '/ws')), filterProblems(files, DEFAULT_SEVERITY_FILTERS, '', '/ws'), { mode: 'grouped' })

  it('moves the highlight linearly and clamps at both ends', () => {
    expect(stepRowIndex(rows, -1, 1)).toBe(0)
    expect(stepRowIndex(rows, -1, -1)).toBe(rows.length - 1)
    expect(stepRowIndex(rows, 0, 1)).toBe(1)
    expect(stepRowIndex(rows, 0, -1)).toBe(0)
    expect(stepRowIndex(rows, rows.length - 1, 1)).toBe(rows.length - 1)
    expect(stepRowIndex([], -1, 1)).toBe(-1)
  })

  it('maps a row to the file it should expand or collapse', () => {
    const firstRow = rows[0]
    expect(firstRow?.kind).toBe('file')
    if (firstRow?.kind === 'file') expect(toggleTargetOf(rows, 0)).toBe(firstRow.path)
    const problemIndex = rows.findIndex(row => row.kind === 'problem')
    expect(toggleTargetOf(rows, problemIndex)).toBe('/ws/lib/b.ts')
    expect(toggleTargetOf(rows, -1)).toBeUndefined()
    expect(toggleTargetOf(rows, rows.length)).toBeUndefined()
  })

  it('finds rows by key and tolerates keys that disappeared', () => {
    expect(rowIndexForKey(rows, rows[2]?.key)).toBe(2)
    expect(rowIndexForKey(rows, undefined)).toBe(-1)
    expect(rowIndexForKey(rows, 'missing')).toBe(-1)
  })
})

describe('context menu specs', () => {
  const entry = filterProblems([file('/ws/src/a.ts', [diagnostic('error', '错误', 3, 5)])], DEFAULT_SEVERITY_FILTERS, '', '/ws')[0]!
  const expandedFile = buildProblemRows(groupProblems([entry]), [entry], { mode: 'grouped' })[0]!
  const collapsedFile = buildProblemRows(groupProblems([entry]), [entry], { mode: 'grouped', collapsed: new Set(['/ws/src/a.ts']) })[0]!
  const problem = buildProblemRows(groupProblems([entry]), [entry], { mode: 'grouped' })[1]!

  /** 只取菜单项的 label；分隔线单独计数。 */
  function labels(specs: ReturnType<typeof contextMenuSpecs>): string[] {
    return specs.flatMap(spec => spec.kind === 'item' ? [spec.label] : [])
  }

  it('offers open/copy/chat/quick-fix on a problem row', () => {
    expect(labels(contextMenuSpecs(problem))).toEqual(['打开', '复制消息', '复制位置', '复制路径', '添加到对话', '显示快速修复'])
    expect(contextMenuSpecs(problem).filter(spec => spec.kind === 'separator')).toHaveLength(2)
  })

  it('offers only file-level actions on a file row, with a collapse/expand label', () => {
    expect(labels(contextMenuSpecs(expandedFile))).toEqual(['收起', '复制路径', '添加到对话'])
    expect(labels(contextMenuSpecs(collapsedFile))).toEqual(['展开', '复制路径', '添加到对话'])
    expect(contextMenuSpecs(undefined)).toEqual([])
  })
})

describe('panel source invariants', () => {
  const componentSource = readFileSync(fileURLToPath(new URL('../src/client/ProblemsPanel.tsx', import.meta.url)), 'utf8')
  const viewSource = readFileSync(fileURLToPath(new URL('../src/client/problemView.ts', import.meta.url)), 'utf8')
  const styleSource = readFileSync(fileURLToPath(new URL('../src/client/problemStyles.ts', import.meta.url)), 'utf8')

  it('jumps through the shared location picker instead of browser dialogs', () => {
    expect(componentSource).not.toContain('window.prompt')
    expect(componentSource).not.toContain('window.confirm')
    expect(componentSource).toContain('openLocationAt(')
    expect(componentSource).toContain('notifyLanguage(')
  })

  it('triggers hosted workspace scans and relies on the snapshot for running state', () => {
    expect(componentSource).toContain('activeLanguageWorkspace()')
    expect(componentSource).toContain('workspace.scan(')
    expect(componentSource).toContain('snapshot.scan')
    // 不自己轮询扫描进度；只允许「快速修复要等一帧」与「交给 AI 的 3 秒完成态」两个 setTimeout。
    expect(componentSource).not.toContain('setInterval')
    expect(componentSource).not.toContain('requestAnimationFrame')
  })

  it('wires the AI context card request, quick fix and the shared context menu', () => {
    // 工具栏/文件行走 kind:'problems' + scope；单条诊断行带行列消息走 kind:'problem'。
    expect(componentSource).toContain("kind: 'problems' as const")
    expect(componentSource).toContain("kind: 'problem' as const")
    expect(componentSource).toContain('requestContextCard(request)')
    expect(componentSource).toContain("from './language/actions.ts'")
    expect(componentSource).toContain('quickFix()')
    expect(componentSource).toContain("from './ContextMenu.tsx'")
    expect(componentSource).toContain('contextMenuSpecs(')
    expect(componentSource).toContain('formatProblemLocation(')
    expect(componentSource).toContain('AI_FEEDBACK_MS')
  })

  it('keeps the scroll position across rebuilds and virtualises the rows', () => {
    expect(componentSource).toContain('useIsomorphicLayoutEffect')
    expect(componentSource).toContain('savedScrollTop')
    expect(componentSource).toContain('virtualWindow(')
    expect(componentSource).toContain('rowOffsets(')
    expect(componentSource).toContain('filterByCurrentFile(')
    expect(componentSource).toContain('ProblemRows')
    // 视图模型保持纯：不 import React。
    expect(viewSource).not.toMatch(/from 'react'/)
  })

  it('uses text glyphs for severities instead of extending the shared codicon table', () => {
    expect(componentSource).toContain('✕')
    expect(componentSource).toContain('·')
    // 不自己拼 codicon 类名（文件行折叠箭头走现有 Icon 组件，图标表不扩）。
    expect(componentSource).not.toContain('codicon-')
  })

  it('exports the styles as one raw string using only existing theme variables', () => {
    expect(styleSource).toContain('export const PROBLEMS_STYLES = String.raw`')
    expect(styleSource).toContain('.dvw-problems')
    // 虚拟化与多行的类名必须存在，便于面板接线与排查。
    expect(styleSource).toContain('.dvw-problems-rows')
    expect(styleSource).toContain('.dvw-problems-row')
    expect(styleSource).toContain('data-multiline=true')
    // 不写死颜色：颜色一律走 DSH 主题令牌。
    expect(styleSource).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    // 不用不在约定清单里的变量（styles.ts 接入时不需要新增变量）。
    for (const forbidden of ['--dvw-surface-1', '--dvw-surface-3', '--dvw-border-soft', '--dvw-success', '--dvw-shadow', '--dvw-radius-md']) {
      expect(styleSource).not.toContain(forbidden)
    }
  })
})
