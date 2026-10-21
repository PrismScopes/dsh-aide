/**
 * 「问题」底部面板：把工作区诊断按文件分组列出来（VS Code Problems 的风格）。
 *
 * 数据来自客户端诊断 store（`language/diagnostics.ts`），**本组件不保存诊断**：一次工作区扫描会
 * 连着推几百条，状态放在组件里会与编辑器标记、状态栏计数各存一份，互相追不上。这里只订阅快照、
 * 做过滤/分组（纯函数）并渲染。
 *
 * 与工作台的分工：
 * - 跳转不在这里实现，统一调 `openLocationAt`（picker.ts 是唯一的跳转出口，Workbench 决定是切
 *   标签还是开只读的外部文件）；
 * - 扫描只是触发宿主的语言服务（`workspace.scan()`），进度与结果仍走 WebSocket → store → 快照，
 *   按钮的禁用状态只读 `snapshot.scan.running`，组件不自己轮询、不自己维护「扫描中」状态；
 * - 整个面板内容都由本组件绘制（BottomPanelProps 的 header 容器留给终端面板那种自己画标签的）。
 *
 * 过滤/分组是导出的纯函数：几百条诊断时路径只按文件算一次（不是每行算一次），并且可以脱离 React
 * 单测覆盖严重级别过滤、文本过滤与排序。
 */
import { useMemo, useState } from 'react'
import { Icon } from './Icon.tsx'
import type { BottomPanelProps } from './service.ts'
import { useDiagnostics } from './language/diagnostics.ts'
import type { DiagnosticsFile } from './language/diagnostics.ts'
import { activeLanguageWorkspace } from './language/client.ts'
import { notifyLanguage, openLocationAt } from './language/picker.ts'
import { baseName, parentPath, workspaceRelativeOf } from './language/paths.ts'
import { displayPosition, severityRank } from '../language/protocol.ts'
import type { LanguageBuiltinInfo, LanguageDiagnostic, LanguageServerState, LanguageSeverity } from '../language/protocol.ts'

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
 * 这是几百条诊断下不重复做字符串运算的关键。
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

/* ────────────────────────────── 组件 ────────────────────────────── */

const SEVERITY_FILTERS: ReadonlyArray<{ key: ProblemSeverityFilter; label: string; glyph: string }> = [
  { key: 'error', label: '错误', glyph: GLYPH_OF.error },
  { key: 'warning', label: '警告', glyph: GLYPH_OF.warning },
  { key: 'info', label: '信息', glyph: GLYPH_OF.info },
]

/** 一条诊断行：字形 + 消息 + `source:code` + 1 基行列号；点击跳到该位置。 */
function ProblemRow({ entry }: { entry: ProblemEntry }) {
  const { diagnostic } = entry
  const position = displayPosition(diagnostic.range.start)
  const meta = diagnostic.source !== undefined && diagnostic.code !== undefined
    ? `${diagnostic.source}:${diagnostic.code}`
    : diagnostic.source ?? diagnostic.code ?? ''
  const label = `${LABEL_OF[diagnostic.severity]}：${diagnostic.message}（${position}）`
  return <button
    type="button"
    className="dvw-problems-item"
    data-severity={diagnostic.severity}
    aria-label={label}
    title={`${entry.relativePath}:${position}  ${diagnostic.message}`}
    onClick={() => openLocationAt(entry.path, diagnostic.range.start.line, diagnostic.range.start.character)}
  >
    <span className="dvw-problems-glyph" aria-hidden="true">{GLYPH_OF[diagnostic.severity]}</span>
    <span className="dvw-problems-message">{diagnostic.message}</span>
    {meta === '' ? null : <span className="dvw-problems-meta">{meta}</span>}
    <span className="dvw-problems-meta">{position}</span>
  </button>
}

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

/**
 * 问题面板。
 *
 * 只有 `cwd` 参与数据订阅；`sessionId` / `colorScheme` / `header` 当前用不到：扫描走已绑定的
 * 语言服务工作区，颜色全部由 DSH 主题令牌决定，头部容器留给别的面板。
 */
export function ProblemsPanel({ cwd }: BottomPanelProps) {
  const snapshot = useDiagnostics(cwd)
  const [filters, setFilters] = useState<SeverityFilterState>(DEFAULT_SEVERITY_FILTERS)
  const [query, setQuery] = useState('')
  /** 折叠的文件（绝对路径集合）；默认全部展开。 */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>())

  const problems = useMemo(() => filterProblems(snapshot.files, filters, query, cwd), [snapshot.files, filters, query, cwd])
  const groups = useMemo(() => groupProblems(problems), [problems])

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

  const toggleFile = (path: string): void => {
    setCollapsed(current => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

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

  return <div className="dvw-problems">
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
      <button type="button" className="dvw-problems-scan" disabled={scanning} onClick={scanWorkspace}>
        {scanning ? '扫描中…' : '扫描工作区'}
      </button>
    </div>

    {scanning && <div className="dvw-problems-progress" role="status">
      正在扫描工作区 {(scan?.checked ?? 0)}/{(scan?.total ?? 0)}
    </div>}

    <div className="dvw-problems-list">
      {groups.length === 0
        ? (scanning
          ? null
          : (snapshot.files.length === 0
            ? <div className="dvw-problems-empty">
              <p className="dvw-problems-empty-title">没有发现问题</p>
              <p className="dvw-problems-empty-note">打开文件后语言服务会自动诊断；也可以点「扫描工作区」检查整个工作区。</p>
            </div>
            : <div className="dvw-problems-empty">
              <p className="dvw-problems-empty-title">没有匹配的问题</p>
              <p className="dvw-problems-empty-note">调整严重级别过滤，或清空搜索框试试。</p>
            </div>))
        : groups.map(group => {
          const expanded = !collapsed.has(group.path)
          return <div className="dvw-problems-group" key={group.path}>
            <button
              type="button"
              className="dvw-problems-file"
              aria-expanded={expanded}
              aria-label={`${expanded ? '收起' : '展开'} ${group.relativePath}`}
              title={group.relativePath}
              onClick={() => toggleFile(group.path)}
            >
              <Icon name={expanded ? 'chevron-down' : 'chevron-right'} className="dvw-problems-chevron"/>
              <span className="dvw-problems-file-name">{group.name}</span>
              {group.directory === '' ? null : <span className="dvw-problems-file-dir">{group.directory}</span>}
              {group.errors === 0 && group.warnings === 0 ? null : <span className="dvw-problems-file-counts">
                {group.errors === 0 ? null : <span className="dvw-problems-file-count" data-severity="error">✕ {group.errors}</span>}
                {group.warnings === 0 ? null : <span className="dvw-problems-file-count" data-severity="warning">! {group.warnings}</span>}
              </span>}
            </button>
            {expanded && group.items.map((entry, index) => <ProblemRow
              key={`${entry.diagnostic.range.start.line}:${entry.diagnostic.range.start.character}:${index}`}
              entry={entry}
            />)}
          </div>
        })}
    </div>

    {snapshot.status === undefined ? null : <ServerSummary builtin={snapshot.status.builtin} servers={snapshot.status.servers}/>}
  </div>
}
