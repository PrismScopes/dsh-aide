import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProblemsPanel, filterProblems, groupProblems } from '../src/client/ProblemsPanel.tsx'
import { diagnosticsStoreFor, resetDiagnosticsStores } from '../src/client/language/diagnostics.ts'
import type { DiagnosticsFile } from '../src/client/language/diagnostics.ts'
import type { LanguageDiagnostic } from '../src/language/protocol.ts'

/**
 * 问题面板的结构测试。
 *
 * 不测交互（那要 jsdom + 真实点击）：交互部分（跳转、扫描、折叠）都落到导出的纯函数或
 * `window` 事件上，面板本身只用 `renderToStaticMarkup` 钉住「数据一进来就渲染成什么样」。
 * 重点守四件事：
 *   1. 按文件分组、同文件内按严重级别+行列排序，路径只按文件算一次；
 *   2. 过滤（严重级别三档 / 文本）与计数的口径一致（hint 归到信息一档）；
 *   3. 空态、扫描进度、语言服务器状态摘要；
 *   4. 源码不再引入浏览器对话框、跳转走 openLocationAt、扫描走 workspace.scan、
 *      样式以 PROBLEMS_STYLES 导出且只含 .dvw-problems-* 与既有 CSS 变量。
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

function render(cwd = '/ws'): string {
  return renderToStaticMarkup(<ProblemsPanel sessionId="s" cwd={cwd} visible colorScheme="dark" header={null}/>)
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
    // 文件行与诊断行都是 button。
    expect(html).toContain('class="dvw-problems-file"')
    expect(html).toContain('class="dvw-problems-item"')
    // 同文件内错误排在警告前，与推入顺序无关。
    expect(html.indexOf('类型“string”不能赋给“number”')).toBeLessThan(html.indexOf('变量已声明但从未读取'))
  })

  it('shows the three severity filters with counts, enabled and default-expanded', () => {
    const html = render()
    expect(html).toContain('placeholder="按文件或描述过滤"')
    expect(html).toContain('扫描工作区')
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(3)
    for (const [severity, label, count] of [['error', '错误', '1'], ['warning', '警告', '1'], ['info', '信息', '1']] as const) {
      expect(html).toContain(`data-severity="${severity}"`)
      expect(html).toContain(`aria-label="${label}（${count}）"`)
    }
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(2)
    // 文件行的错误/警告徽标。
    expect(html).toContain('class="dvw-problems-file-count" data-severity="error">✕ 1<')
    expect(html).toContain('class="dvw-problems-file-count" data-severity="warning">! 1<')
  })

  it('renders the empty state for a workspace without diagnostics', () => {
    const html = render('/empty')
    expect(html).toContain('没有发现问题')
    expect(html).toContain('打开文件后语言服务会自动诊断')
    expect(html).not.toContain('dvw-problems-group')
    expect(html).not.toContain('dvw-problems-item')
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
    expect(html).toContain('扫描中…')
    expect(html).toMatch(/class="dvw-problems-scan" disabled=""/)
    expect(html).toContain('正在扫描工作区 3/10')
    expect(html).toContain('内置 TypeScript 5.6.3（运行中）')
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
    expect(filterProblems(files, { error: true, warning: true, info: true }, '', '/ws')).toHaveLength(5)
    // 「信息」一档包含 hint：与过滤按钮的计数口径一致。
    expect(filterProblems(files, { error: false, warning: false, info: true }, '', '/ws').map(entry => entry.diagnostic.message))
      .toEqual(['建议 const', '可以简化'])
    expect(filterProblems(files, { error: true, warning: false, info: false }, '', '/ws').map(entry => entry.path))
      .toEqual(['/ws/src/a.ts', '/elsewhere/outside.ts'])
    expect(filterProblems(files, { error: false, warning: true, info: false }, '', '/ws')).toHaveLength(1)
  })

  it('computes display paths once per file and falls back outside the workspace', () => {
    const entries = filterProblems(files, { error: true, warning: true, info: true }, '', '/ws')
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
    expect(filterProblems(files, { error: true, warning: true, info: true }, 'a.ts', '/ws')).toHaveLength(2)
    expect(filterProblems(files, { error: true, warning: true, info: true }, 'LIB', '/ws').map(entry => entry.relativePath))
      .toEqual(['lib/b.ts', 'lib/b.ts'])
    expect(filterProblems(files, { error: true, warning: true, info: true }, '未使用', '/ws')).toHaveLength(1)
    // 纯空白等于不过滤。
    expect(filterProblems(files, { error: true, warning: true, info: true }, '   ', '/ws')).toHaveLength(5)
    expect(filterProblems(files, { error: true, warning: true, info: true }, '不存在的内容', '/ws')).toHaveLength(0)
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
    const groups = groupProblems(filterProblems(files, { error: true, warning: true, info: true }, '', '/ws'))
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

describe('panel source invariants', () => {
  const componentSource = readFileSync(fileURLToPath(new URL('../src/client/ProblemsPanel.tsx', import.meta.url)), 'utf8')
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
    // 不自己轮询扫描进度。
    expect(componentSource).not.toMatch(/setInterval|setTimeout/)
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
    // 不写死颜色：颜色一律走 DSH 主题令牌。
    expect(styleSource).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    // 不用不在约定清单里的变量（styles.ts 接入时不需要新增变量）。
    for (const forbidden of ['--dvw-surface-1', '--dvw-surface-3', '--dvw-border-soft', '--dvw-success', '--dvw-shadow', '--dvw-radius-md']) {
      expect(styleSource).not.toContain(forbidden)
    }
  })
})
