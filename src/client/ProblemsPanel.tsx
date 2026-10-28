/**
 * 「问题」底部面板：把工作区诊断按文件分组（或平铺）列出来（VS Code Problems 的风格）。
 *
 * 数据来自客户端诊断 store（`language/diagnostics.ts`），**本组件不保存诊断**：一次工作区扫描会
 * 连着推几百条，状态放在组件里会与编辑器标记、状态栏计数各存一份，互相追不上。这里只订阅快照、
 * 做过滤（纯函数）并渲染。
 *
 * 与工作台的分工：
 * - 跳转不在这里实现，统一调 `openLocationAt`（picker.ts 是唯一的跳转出口，Workbench 决定是切
 *   标签还是开只读的外部文件）；
 * - 扫描只是触发宿主的语言服务（`workspace.scan()`），进度与结果仍走 WebSocket → store → 快照；
 * - 「交给 AI」只发一个类型化请求（`requestContextCard`），卡片内容在发送时才由 DSH 侧现读，避免
 *   把上千条诊断的快照塞进消息（方案文档 2.8 / 5.2）；
 * - 整个面板内容都由本组件绘制（BottomPanelProps 的 header 容器留给终端面板那种自己画标签的）。
 *
 * 视图模型在 `problemView.ts`：过滤后的条目 → 展开后的行（文件头/诊断行）→ 虚拟化窗口。
 * 本文件只做「状态 + 事件 + 渲染」，因此过滤/排序/分组/行高/窗口计算都能脱离 React 单测。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, UIEvent as ReactUIEvent } from 'react'
import { ContextMenu, separator, type MenuEntry } from './ContextMenu.tsx'
import { Icon } from './Icon.tsx'
import { copyText } from './clipboard.ts'
import { requestContextCard } from './contextRequest.ts'
import type { BottomPanelProps } from './service.ts'
import { useDiagnostics } from './language/diagnostics.ts'
import type { DiagnosticsFile } from './language/diagnostics.ts'
import { activeLanguageWorkspace } from './language/client.ts'
import { notifyLanguage, openLocationAt } from './language/picker.ts'
import { quickFix } from './language/actions.ts'
import { baseName, parentPath, workspaceRelativeOf } from './language/paths.ts'
import { displayPosition, severityRank } from '../language/protocol.ts'
import type { LanguageBuiltinInfo, LanguageDiagnostic, LanguageServerState, LanguageSeverity } from '../language/protocol.ts'
import {
  buildProblemRows,
  contextMenuSpecs,
  ensureRowVisible,
  fileRowKey,
  filterByCurrentFile,
  formatProblemLocation,
  PROBLEM_MULTILINE_ROW_HEIGHT,
  rowIndexForKey,
  rowOffsets,
  stepRowIndex,
  toggleTargetOf,
  virtualWindow,
  type ProblemMenuAction,
  type ProblemRow,
  type ProblemViewMode,
  type RowWindow,
} from './problemView.ts'

/* ────────────────────────────── 纯数据与纯函数 ────────────────────────────── */

/** 过滤按钮只分三档：hint 归到「信息」一档（VS Code 的 Infos 过滤同样包含 hint）。 */
export type ProblemSeverityFilter = 'error' | 'warning' | 'info'

/** 三档严重级别的开关；默认全开。 */
export interface SeverityFilterState {
  error: boolean
  warning: boolean
  info: boolean
}

export const DEFAULT_SEVERITY_FILTERS: SeverityFilterState = { error: true, warning: true, info: true }

/** 「交给 AI」成功后的反馈时长：勾选状态约 3 秒后复原，避免用户重复点击。 */
export const AI_FEEDBACK_MS = 3000

/** 严重级别 → 过滤档位。 */
const FILTER_OF: Readonly<Record<LanguageSeverity, ProblemSeverityFilter>> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
  hint: 'info',
}

/** 文本符号而不是 codicon：共享图标表已经收窄（A-5/B 档不再扩），四种字形足够区分严重级别。 */
const GLYPH_OF: Readonly<Record<LanguageSeverity, string>> = { error: '✕', warning: '!', info: 'i', hint: '·' }

const LABEL_OF: Readonly<Record<LanguageSeverity, string>> = { error: '错误', warning: '警告', info: '信息', hint: '提示' }

const SERVER_STATE_LABEL: Readonly<Record<LanguageServerState, string>> = {
  builtin: '内置',
  running: '运行中',
  starting: '启动中',
  idle: '未启动',
  missing: '未安装',
  failed: '失败',
  disabled: '未启用',
}

const BUILTIN_STATE_LABEL: Readonly<Record<LanguageBuiltinInfo['state'], string>> = {
  // ready 只表示「可用」：内置服务是懒加载的，没打开 TS/JS 文件前并没有真正启动。
  ready: '可用',
  loading: '加载中',
  disabled: '未启用',
  failed: '失败',
}

/** `useLayoutEffect` 在服务端渲染时不存在；换成 `useEffect` 避免 React 的 SSR 警告。 */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** 一条待渲染的诊断；路径信息在**文件**这一级算一次，同文件的几百条共用。 */
export interface ProblemEntry {
  /** 绝对路径（跳转用）。 */
  path: string
  /** 工作区相对路径（不在工作区内时回落到绝对路径）。 */
  relativePath: string
  /** 文件名（加粗显示）。 */
  name: string
  /** 相对目录（灰色显示；根目录为空串）。 */
  directory: string
  diagnostic: LanguageDiagnostic
}

/** 按文件聚合后的一组问题。 */
export interface ProblemGroup {
  path: string
  relativePath: string
  name: string
  directory: string
  /** 已按「严重级别 → 行列」排序。 */
  items: readonly ProblemEntry[]
  errors: number
  warnings: number
}

/** 同一文件内的顺序：严重级别优先，再按行列，最后按消息兜底保证稳定。 */
function compareEntries(left: ProblemEntry, right: ProblemEntry): number {
  const bySeverity = severityRank(left.diagnostic.severity) - severityRank(right.diagnostic.severity)
  if (bySeverity !== 0) return bySeverity
  const a = left.diagnostic.range.start
  const b = right.diagnostic.range.start
  if (a.line !== b.line) return a.line - b.line
  if (a.character !== b.character) return a.character - b.character
  return left.diagnostic.message.localeCompare(right.diagnostic.message)
}

/**
 * 按严重级别与文本过滤，并展开成「一条一行」的扁平列表。
 *
 * 路径只按文件计算一次（relativePath/name/directory 被同文件的所有诊断共用），
 * 这是几百条诊断下不重复做字符串运算的关键。签名保持兼容：调用方（含既有单测）按四参数使用；
 * 「仅当前文件」在 `problemView.filterByCurrentFile` 里做，不改变严重级别过滤的计数口径。
 */
export function filterProblems(
  files: readonly DiagnosticsFile[],
  filters: SeverityFilterState,
  query: string,
  cwd: string,
): ProblemEntry[] {
  const needle = query.trim().toLowerCase()
  const entries: ProblemEntry[] = []
  for (const file of files) {
    const relativePath = workspaceRelativeOf(cwd, file.path) ?? file.path
    const name = baseName(file.path)
    const directory = parentPath(relativePath)
    for (const diagnostic of file.diagnostics) {
      if (!filters[FILTER_OF[diagnostic.severity]]) continue
      // 「按文件或描述过滤」：相对路径与消息都参与匹配，大小写不敏感。
      if (needle !== '' && !relativePath.toLowerCase().includes(needle) && !diagnostic.message.toLowerCase().includes(needle)) continue
      entries.push({ path: file.path, relativePath, name, directory, diagnostic })
    }
  }
  return entries
}

/**
 * 按文件分组：组间按相对路径排序，组内按严重级别与行列排序。
 * 计数统计的是**过滤后可见**的问题，与文件行显示的徽标一致。
 */
export function groupProblems(entries: readonly ProblemEntry[]): ProblemGroup[] {
  const pending = new Map<string, { relativePath: string; name: string; directory: string; items: ProblemEntry[]; errors: number; warnings: number }>()
  for (const entry of entries) {
    let group = pending.get(entry.path)
    if (group === undefined) {
      group = { relativePath: entry.relativePath, name: entry.name, directory: entry.directory, items: [], errors: 0, warnings: 0 }
      pending.set(entry.path, group)
    }
    group.items.push(entry)
    if (entry.diagnostic.severity === 'error') group.errors++
    else if (entry.diagnostic.severity === 'warning') group.warnings++
  }
  const groups: ProblemGroup[] = []
  for (const [path, group] of pending) {
    groups.push({
      path,
      relativePath: group.relativePath,
      name: group.name,
      directory: group.directory,
      items: [...group.items].sort(compareEntries),
      errors: group.errors,
      warnings: group.warnings,
    })
  }
  groups.sort((left, right) => left.relativePath.localeCompare(right.relativePath) || left.path.localeCompare(right.path))
  return groups
}

/* ────────────────────────────── 行渲染 ────────────────────────────── */

/** 诊断行的附加信息：`source:code`，缺一个就只显示有的那个。 */
function metaOf(diagnostic: LanguageDiagnostic): string {
  return diagnostic.source !== undefined && diagnostic.code !== undefined
    ? `${diagnostic.source}:${diagnostic.code}`
    : diagnostic.source ?? diagnostic.code ?? ''
}

export interface ProblemRowsProps {
  rows: readonly ProblemRow[]
  /** 与 rows 对应的累计偏移（rowOffsets 的结果）。 */
  offsets: readonly number[]
  /** 虚拟化窗口。 */
  window: RowWindow
  /** 当前高亮行的下标；-1 表示没有高亮。 */
  highlightedIndex: number
  onActivate(row: ProblemRow): void
  onContextMenu(row: ProblemRow, position: { x: number; y: number }): void
}

/**
 * 虚拟化行列表（纯展示）：只渲染窗口内的行。
 *
 * 行用绝对定位放在一个总高度为 `totalHeight` 的容器里，滚动的仍是外层容器 —— 这样浏览器原生滚动条、
 * 惯性滚动与「滚动位置保持」都不需要自己实现。行高来自视图模型（固定值），因此不需要测量 DOM。
 */
export function ProblemRows({ rows, offsets, window: visibleWindow, highlightedIndex, onActivate, onContextMenu }: ProblemRowsProps) {
  const rendered: ReactNode[] = []
  for (let index = visibleWindow.start; index < visibleWindow.end; index++) {
    const row = rows[index]
    if (row === undefined) continue
    const top = offsets[index] ?? 0
    const selected = index === highlightedIndex
    if (row.kind === 'file') {
      rendered.push(<div
        key={row.key}
        id={`dvw-problems-row-${index}`}
        role="option"
        aria-selected={selected}
        aria-expanded={row.expanded}
        aria-label={`${row.expanded ? '收起' : '展开'} ${row.relativePath}`}
        className="dvw-problems-row dvw-problems-file"
        data-row-kind="file"
        data-row-index={index}
        data-path={row.path}
        title={row.relativePath}
        style={{ top, height: row.height }}
        onClick={() => onActivate(row)}
        onContextMenu={event => { event.preventDefault(); onContextMenu(row, { x: event.clientX, y: event.clientY }) }}
      >
        <Icon name={row.expanded ? 'chevron-down' : 'chevron-right'} className="dvw-problems-chevron"/>
        <span className="dvw-problems-file-name">{row.name}</span>
        {row.directory === '' ? null : <span className="dvw-problems-file-dir">{row.directory}</span>}
        {row.errors === 0 && row.warnings === 0 ? null : <span className="dvw-problems-file-counts">
          {row.errors === 0 ? null : <span className="dvw-problems-file-count" data-severity="error">✕ {row.errors}</span>}
          {row.warnings === 0 ? null : <span className="dvw-problems-file-count" data-severity="warning">! {row.warnings}</span>}
        </span>}
      </div>)
      continue
    }
    const { diagnostic } = row.entry
    const position = displayPosition(diagnostic.range.start)
    const meta = metaOf(diagnostic)
    const multiline = row.height === PROBLEM_MULTILINE_ROW_HEIGHT
    rendered.push(<div
      key={row.key}
      id={`dvw-problems-row-${index}`}
      role="option"
      aria-selected={selected}
      aria-label={`${LABEL_OF[diagnostic.severity]}：${diagnostic.message}（${position}）`}
      className="dvw-problems-row dvw-problems-item"
      data-row-kind="problem"
      data-row-index={index}
      data-severity={diagnostic.severity}
      data-multiline={multiline ? 'true' : undefined}
      title={`${row.entry.relativePath}:${position}  ${diagnostic.message}`}
      style={{ top, height: row.height }}
      onClick={() => onActivate(row)}
      onContextMenu={event => { event.preventDefault(); onContextMenu(row, { x: event.clientX, y: event.clientY }) }}
    >
      <span className="dvw-problems-glyph" aria-hidden="true">{GLYPH_OF[diagnostic.severity]}</span>
      <span className="dvw-problems-message">{diagnostic.message}</span>
      {meta === '' ? null : <span className="dvw-problems-meta">{meta}</span>}
      <span className="dvw-problems-meta">{position}</span>
    </div>)
  }
  return <div className="dvw-problems-rows" style={{ height: visibleWindow.totalHeight }} role="presentation">{rendered}</div>
}

const SEVERITY_FILTERS: ReadonlyArray<{ key: ProblemSeverityFilter; label: string; glyph: string }> = [
  { key: 'error', label: '错误', glyph: GLYPH_OF.error },
  { key: 'warning', label: '警告', glyph: GLYPH_OF.warning },
  { key: 'info', label: '信息', glyph: GLYPH_OF.info },
]

/** 语言服务器状态摘要：服务器名 + 中文状态；内置 TypeScript 额外带版本号。 */
function ServerSummary({ builtin, servers }: { builtin: LanguageBuiltinInfo; servers: readonly { id: string; name: string; state: LanguageServerState }[] }) {
  return <div className="dvw-problems-servers" aria-label="语言服务状态">
    <span className="dvw-problems-server" data-state={builtin.state}>
      内置 TypeScript{builtin.version === undefined || builtin.version === '' ? '' : ` ${builtin.version}`}（{BUILTIN_STATE_LABEL[builtin.state]}）
    </span>
    {servers.map(server => <span className="dvw-problems-server" data-state={server.state} key={server.id}>
      {server.name}（{SERVER_STATE_LABEL[server.state]}）
    </span>)}
  </div>
}

/* ────────────────────────────── 组件 ────────────────────────────── */

/**
 * 问题面板。
 *
 * 只有 `cwd` 与 `activePath` 参与业务：后者是当前编辑器标签的工作区相对路径，「仅当前文件」与
 * 「交给 AI」的文件范围都以它为准；`sessionId` / `colorScheme` / `header` 当前用不到（扫描走已绑定的
 * 语言服务工作区，颜色全部由 DSH 主题令牌决定，头部容器留给别的面板）。
 */
export function ProblemsPanel({ cwd, activePath }: BottomPanelProps) {
  const snapshot = useDiagnostics(cwd)
  const [filters, setFilters] = useState<SeverityFilterState>(DEFAULT_SEVERITY_FILTERS)
  const [query, setQuery] = useState('')
  /** 视图模式：默认按文件分组（与 VS Code 一致）。 */
  const [viewMode, setViewMode] = useState<ProblemViewMode>('grouped')
  /** 仅当前文件：没有 activePath 时禁用（状态保留，重新打开文件后继续生效）。 */
  const [currentFileOnly, setCurrentFileOnly] = useState(false)
  /** 多行消息：默认单行截断（底部面板高度有限，单行能在一屏里看到更多问题）。 */
  const [multiLine, setMultiLine] = useState(false)
  /** 折叠的文件（绝对路径集合）；默认全部展开。 */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>())
  /** 高亮行：键用于过滤/折叠重建后找回，path 用于行消失时回落到文件头。 */
  const [highlight, setHighlight] = useState<{ key: string; path: string }>()
  /** 右键菜单：位置 + 目标行。 */
  const [menu, setMenu] = useState<{ x: number; y: number; row: ProblemRow }>()
  /** 「交给 AI」的短暂完成态（✓ 约 3 秒）。 */
  const [aiDone, setAiDone] = useState(false)
  const aiTimer = useRef<ReturnType<typeof setTimeout>>()

  const listRef = useRef<HTMLDivElement>(null)
  /** 滚动位置：过滤/排序/分组重建后要恢复到这个像素位置，而不是跳回顶部。 */
  const savedScrollTop = useRef(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  const canUseCurrentFile = activePath !== undefined && activePath !== ''

  const problems = useMemo(() => filterProblems(snapshot.files, filters, query, cwd), [snapshot.files, filters, query, cwd])
  // 只有开关打开且确实有活动文件时才过滤；标签关闭后开关状态保留但不生效（按钮同时被禁用）。
  const visible = useMemo(
    () => filterByCurrentFile(problems, currentFileOnly && canUseCurrentFile ? activePath : undefined),
    [problems, currentFileOnly, canUseCurrentFile, activePath],
  )
  const groups = useMemo(() => groupProblems(visible), [visible])
  const rows = useMemo(
    () => buildProblemRows(groups, visible, { mode: viewMode, collapsed, multiLine }),
    [groups, visible, viewMode, collapsed, multiLine],
  )
  const offsets = useMemo(() => rowOffsets(rows), [rows])
  const visibleWindow = useMemo(
    () => virtualWindow(offsets, viewportHeight, scrollTop),
    [offsets, viewportHeight, scrollTop],
  )
  const highlightedIndex = useMemo(() => rowIndexForKey(rows, highlight?.key), [rows, highlight])

  const scan = snapshot.scan
  const scanning = scan?.running === true
  // 「信息」一档包含 hint：与 filterProblems 的 FILTER_OF 保持一致，过滤与计数不能两套口径。
  const counts: Record<ProblemSeverityFilter, number> = {
    error: snapshot.errors,
    warning: snapshot.warnings,
    info: snapshot.infos + snapshot.hints,
  }

  const toggleSeverity = (kind: ProblemSeverityFilter): void => {
    setFilters(current => ({ ...current, [kind]: !current[kind] }))
  }

  const toggleFile = useCallback((path: string): void => {
    setCollapsed(current => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  /** 明确设置某个文件的展开状态（左右键用：ArrowRight 只展开，不会反手收起）。 */
  const setGroupExpanded = useCallback((path: string, expanded: boolean): void => {
    setCollapsed(current => {
      const isCollapsed = current.has(path)
      if (expanded !== isCollapsed) return current
      const next = new Set(current)
      if (expanded) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  /* 行重建（过滤/排序/分组/折叠/多行）后保持滚动位置：像素位置最接近用户的阅读位置。 */
  useIsomorphicLayoutEffect(() => {
    const element = listRef.current
    if (element === null) return
    if (element.scrollTop !== savedScrollTop.current) element.scrollTop = savedScrollTop.current
  }, [rows])

  /* 面板高度变化（拖动底部分隔条、窗口缩放）时重新计算可视窗口：ResizeObserver 比 window.resize 准。 */
  useEffect(() => {
    const element = listRef.current
    if (element === null) return
    const update = (): void => { setViewportHeight(element.clientHeight) }
    update()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /* 卸载时清掉「交给 AI」的复原计时器。 */
  useEffect(() => () => { if (aiTimer.current !== undefined) clearTimeout(aiTimer.current) }, [])

  /* 行被折叠/过滤掉后，高亮回落到它所属的文件头（文件头也不在了才清空）。 */
  useEffect(() => {
    if (highlight === undefined || highlightedIndex >= 0) return
    const fallback = fileRowKey(highlight.path)
    setHighlight(rowIndexForKey(rows, fallback) >= 0 ? { key: fallback, path: highlight.path } : undefined)
  }, [rows, highlight, highlightedIndex])

  const onScroll = (event: ReactUIEvent<HTMLDivElement>): void => {
    const element = event.currentTarget
    savedScrollTop.current = element.scrollTop
    setScrollTop(element.scrollTop)
    if (element.clientHeight !== viewportHeight) setViewportHeight(element.clientHeight)
  }

  const highlightRow = useCallback((index: number): void => {
    const row = rows[index]
    if (row === undefined) return
    setHighlight({ key: row.key, path: row.kind === 'file' ? row.path : row.filePath })
    const element = listRef.current
    if (element === null) return
    const next = ensureRowVisible(offsets, index, element.clientHeight, element.scrollTop)
    if (next === element.scrollTop) return
    element.scrollTop = next
    savedScrollTop.current = next
    setScrollTop(next)
  }, [rows, offsets])

  const activateEntry = useCallback((entry: ProblemEntry): void => {
    openLocationAt(entry.path, entry.diagnostic.range.start.line, entry.diagnostic.range.start.character)
  }, [])

  const activateRow = (row: ProblemRow): void => {
    setHighlight({ key: row.key, path: row.kind === 'file' ? row.path : row.filePath })
    if (row.kind === 'file') { toggleFile(row.path); return }
    activateEntry(row.entry)
  }

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (rows.length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      highlightRow(stepRowIndex(rows, highlightedIndex, event.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      highlightRow(event.key === 'Home' ? 0 : rows.length - 1)
      return
    }
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const path = toggleTargetOf(rows, highlightedIndex)
      if (path === undefined) return
      event.preventDefault()
      setGroupExpanded(path, event.key === 'ArrowRight')
      return
    }
    if (event.key !== 'Enter') return
    const row = rows[highlightedIndex]
    if (row === undefined) return
    event.preventDefault()
    if (row.kind === 'file') toggleFile(row.path)
    else activateEntry(row.entry)
  }

  const copyToClipboard = (value: string, what: string): void => {
    void copyText(value).then(ok => { if (!ok) notifyLanguage(`复制${what}失败`, 'warn') })
  }

  const showQuickFix = (entry: ProblemEntry): void => {
    const start = entry.diagnostic.range.start
    // 先跳到问题位置：actions.quickFix() 读的是当前聚焦编辑器的光标/选区。
    openLocationAt(entry.path, start.line, start.character)
    // 切标签、Monaco 挂载与聚焦都发生在下一帧之后；立即调用会拿不到活动编辑器。
    window.setTimeout(() => {
      void quickFix().catch(() => notifyLanguage('无法打开快速修复', 'warn'))
    }, 180)
  }

  const addProblemsToChat = useCallback(async (): Promise<void> => {
    // 看得见什么就交什么：开了「仅当前文件」且确实有活动文件时传 file，否则传整个工作区。
    const scope = currentFileOnly && canUseCurrentFile ? 'file' : 'workspace'
    let ok = false
    try { ok = await requestContextCard({ kind: 'problems', scope }) } catch { ok = false }
    if (!ok) {
      notifyLanguage('添加到对话失败：当前没有可用的 DSH 对话输入框', 'warn')
      return
    }
    setAiDone(true)
    if (aiTimer.current !== undefined) clearTimeout(aiTimer.current)
    aiTimer.current = setTimeout(() => { aiTimer.current = undefined; setAiDone(false) }, AI_FEEDBACK_MS)
  }, [currentFileOnly, canUseCurrentFile])

  const runMenuAction = (action: ProblemMenuAction, row: ProblemRow): void => {
    if (action === 'addToChat') { void addProblemsToChat(); return }
    if (action === 'toggleFile') { if (row.kind === 'file') toggleFile(row.path); return }
    if (action === 'copyPath') { copyToClipboard(row.kind === 'file' ? row.relativePath : row.entry.relativePath, '路径'); return }
    if (row.kind !== 'problem') return
    const { diagnostic, relativePath } = row.entry
    switch (action) {
      case 'open': activateEntry(row.entry); return
      case 'copyMessage': copyToClipboard(diagnostic.message, '消息'); return
      case 'copyPosition': copyToClipboard(formatProblemLocation(relativePath, diagnostic.range.start), '位置'); return
      case 'showQuickFix': showQuickFix(row.entry); return
    }
  }

  const menuEntries = (row: ProblemRow): MenuEntry[] => contextMenuSpecs(row).map(spec => spec.kind === 'separator'
    ? separator()
    : { kind: 'item', id: spec.id, label: spec.label, onSelect: () => runMenuAction(spec.id, row) })

  /** 扫描进度与结果由宿主推送（store → snapshot），这里只负责发起。 */
  const scanWorkspace = (): void => {
    const workspace = activeLanguageWorkspace()
    if (workspace === undefined) {
      notifyLanguage('当前没有可扫描的语言服务', 'warn')
      return
    }
    void workspace.scan().then(result => {
      if (!result.supported) notifyLanguage('当前没有可扫描的语言服务', 'warn')
    }).catch(() => notifyLanguage('扫描工作区失败', 'error'))
  }

  const emptyState = visible.length === 0
    ? (scanning
      ? null
      : (snapshot.files.length === 0
        ? <div className="dvw-problems-empty">
          <p className="dvw-problems-empty-title">没有发现问题</p>
          <p className="dvw-problems-empty-note">打开文件后语言服务会自动诊断；也可以点「扫描工作区」检查整个工作区。</p>
        </div>
        : <div className="dvw-problems-empty">
          <p className="dvw-problems-empty-title">没有匹配的问题</p>
          <p className="dvw-problems-empty-note">{currentFileOnly && canUseCurrentFile
            ? '当前文件没有匹配的问题；关闭「仅当前文件」可以查看整个工作区。'
            : '调整严重级别过滤，或清空搜索框试试。'}</p>
        </div>))
    : null

  return <div className="dvw-problems" data-view-mode={viewMode} data-multiline={multiLine ? 'true' : undefined} data-current-file={currentFileOnly && canUseCurrentFile ? 'true' : undefined}>
    <div className="dvw-problems-toolbar">
      <div className="dvw-problems-filters" role="group" aria-label="按严重级别过滤">
        {SEVERITY_FILTERS.map(filter => <button
          key={filter.key}
          type="button"
          className="dvw-problems-filter"
          data-severity={filter.key}
          aria-pressed={filters[filter.key]}
          aria-label={`${filter.label}（${counts[filter.key]}）`}
          onClick={() => toggleSeverity(filter.key)}
        >
          <span className="dvw-problems-glyph" aria-hidden="true">{filter.glyph}</span>
          <span>{filter.label}</span>
          <span className="dvw-problems-count">{counts[filter.key]}</span>
        </button>)}
      </div>
      <input
        className="dvw-problems-query"
        type="search"
        value={query}
        placeholder="按文件或描述过滤"
        aria-label="按文件或描述过滤"
        onChange={event => setQuery(event.target.value)}
      />
      <div className="dvw-problems-modes" role="group" aria-label="视图模式">
        <button type="button" className="dvw-problems-mode" data-view="grouped" aria-pressed={viewMode === 'grouped'} onClick={() => setViewMode('grouped')}>按文件</button>
        <button type="button" className="dvw-problems-mode" data-view="flat" aria-pressed={viewMode === 'flat'} onClick={() => setViewMode('flat')}>平铺</button>
      </div>
      <button
        type="button"
        className="dvw-problems-toggle"
        data-action="current-file"
        aria-pressed={currentFileOnly && canUseCurrentFile}
        disabled={!canUseCurrentFile}
        title={canUseCurrentFile ? '只显示当前编辑器文件的问题' : '当前没有打开的文件'}
        onClick={() => setCurrentFileOnly(value => !value)}
      >仅当前文件</button>
      <button
        type="button"
        className="dvw-problems-toggle"
        data-action="multiline"
        aria-pressed={multiLine}
        title={multiLine ? '恢复单行截断' : '多行显示问题消息'}
        onClick={() => setMultiLine(value => !value)}
      >多行</button>
      <button
        type="button"
        className="dvw-problems-ai"
        data-action="add-to-chat"
        data-done={aiDone ? 'true' : undefined}
        disabled={aiDone}
        title="把当前问题作为上下文卡片加入 DSH 对话输入框"
        onClick={() => { void addProblemsToChat() }}
      >{aiDone ? '✓ 已添加' : '交给 AI'}</button>
      <button type="button" className="dvw-problems-scan" disabled={scanning} onClick={scanWorkspace}>
        {scanning ? '扫描中…' : '扫描工作区'}
      </button>
    </div>

    {scanning && <div className="dvw-problems-progress" role="status">
      正在扫描工作区 {(scan?.checked ?? 0)}/{(scan?.total ?? 0)}
    </div>}

    <div
      className="dvw-problems-list"
      ref={listRef}
      onScroll={onScroll}
      role={rows.length === 0 ? undefined : 'listbox'}
      tabIndex={rows.length === 0 ? undefined : 0}
      aria-label={rows.length === 0 ? undefined : '问题列表'}
      aria-activedescendant={highlightedIndex >= 0 ? `dvw-problems-row-${highlightedIndex}` : undefined}
      onKeyDown={onListKeyDown}
    >
      {rows.length === 0
        ? emptyState
        : <ProblemRows
          rows={rows}
          offsets={offsets}
          window={visibleWindow}
          highlightedIndex={highlightedIndex}
          onActivate={activateRow}
          onContextMenu={(row, position) => {
            setHighlight({ key: row.key, path: row.kind === 'file' ? row.path : row.filePath })
            setMenu({ x: position.x, y: position.y, row })
          }}
        />}
    </div>

    {snapshot.status === undefined ? null : <ServerSummary builtin={snapshot.status.builtin} servers={snapshot.status.servers}/>}

    {menu !== undefined && <ContextMenu
      position={{ x: menu.x, y: menu.y }}
      label="问题操作"
      entries={menuEntries(menu.row)}
      onClose={() => setMenu(undefined)}
    />}
  </div>
}
