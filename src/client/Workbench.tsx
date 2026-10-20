import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent } from 'react'
import type { FileDocument, FileEntry, GitChange, GitDiff, GitStatus, SearchReplaceResult, SearchResult } from '../types.ts'
import { api, currentHostBase, hostWebSocketUrl } from './api.ts'
import type { VscodeWorkbench, WorkbenchView } from './service.ts'
import { BOTTOM_HEIGHT, bottomHeightLimit, reclampBottomHeight } from './service.ts'
import { fileIcon, fileIconUrl, Icon } from './Icon.tsx'
import { TerminalNewButton } from './TerminalNewButton.tsx'
import { MarkdownPreview, markdownHeadings } from './MarkdownPreview.tsx'
import type { MarkdownHeading } from './MarkdownPreview.tsx'
import { MonacoDiffEditor, MonacoEditor } from './MonacoEditor.tsx'
import { DshConversationPanel } from './DshConversationPanel.tsx'
import { DshMark } from './DshMark.tsx'
import { DocumentPreview, documentPreviewKind, type DocumentPreviewKind } from './documentPreview.tsx'
import { toggleTerminal } from './shortcuts.ts'
import { resetWorkspaceDocuments, WorkspaceRequestScope } from './workspaceState.ts'
import { useDshDarkTheme } from './theme.ts'
import { Git } from './GitPanel.tsx'
import { GitGraphTab, GIT_GRAPH_PATH } from './GitGraphTab.tsx'
import { GitOutputTab, GIT_OUTPUT_PATH } from './GitOutputTab.tsx'
import { useDebouncedCallback } from './hooks.ts'
// 搜索面板的结果聚合/高亮/步进都是纯函数，拆在 searchView.ts 里以便直接用 node 断言。
import { flattenRows, groupMatches, highlightSegments, parseSearchState, regexProblem, stepIndex, type SearchFile, type SearchRow, type SearchState } from './searchView.ts'
import { usePreferences } from './preferences.ts'
import type { WorkbenchPreferences } from './preferences.ts'
import { ClosePrompt, dirtyCloseTabs, needsClosePrompt } from './ClosePrompt.tsx'
import { preloadTextMate } from './textmateHighlight.ts'
// 资源管理器与标签页共用同一套右键菜单：菜单内容在 menus.ts（纯数据，可单测），画法在 ContextMenu.tsx。
import { ContextMenu, type MenuEntry } from './ContextMenu.tsx'
import { explorerMenuItems, parentDirectory, tabMenuItems, workspaceAbsolutePath, type ExplorerMenuActions, type FileClipboard } from './menus.ts'
import { copyText } from './clipboard.ts'
import { requestTerminal } from './terminal.ts'
import { REVEAL_CHAT_EVENT } from './dshChat.ts'

// 从 GitPanel 拆出后重新导出，保持既有引用（含单测）不变。
export { graphRows, graphTrackPath } from './GitPanel.tsx'
export type { GraphRow, GraphTrack } from './GitPanel.tsx'

interface Tab extends FileDocument { dirty: boolean; draft: string; loaded?: boolean; line?: number; column?: number; external?: boolean; preview?: boolean; title?: string; diff?: GitDiff; diffMode?: 'inline' | 'split'; diffSourcePath?:string; imageUrl?:string; documentPreview?:DocumentPreviewKind; documentUrl?:string; pinned?: boolean; graphAll?: boolean }

/**
 * 把「磁盘上已变化」标到脏标签上。
 *
 * 为什么需要守卫：files.changed 在每次保存文件、每次构建、每次外部改动后都会来一条，而原来的写法是
 * 无条件 `current.map(...)` —— 即使没有任何标签需要变，也会产出一个新数组，于是整个工作台
 * （资源管理器、Git 面板的提交图、编辑器外壳、终端面板）跟着重渲染一次。
 *
 * 这里只改动 `external` 一个字段，所以「需不需要变」就等价于「有没有 dirty 且尚未标记的标签」；
 * 没有的话返回**原数组**，React 会直接 bail out。返回值的逐项字段（path/dirty/revision/external…）
 * 与输入相同，因此行为与无条件 map 完全一致。
 */
export function markTabsExternal<T extends { dirty?: boolean; external?: boolean }>(tabs: T[]): T[] {
  let changed = false
  const next = tabs.map(tab => {
    if (tab.dirty !== true || tab.external === true) return tab
    changed = true
    return { ...tab, external: true }
  })
  return changed ? next : tabs
}
/** 一次待确认的关闭：要关哪些标签、其中哪些真的脏，以及决定之后是关标签还是返回 DSH。 */
interface PendingClose { action: 'close' | 'hide'; paths: string[]; dirtyPaths: string[] }
// 工作台不提供配色选项，配色始终由 DSH 主题决定（见 useDshDarkTheme）。
interface TreeProps {
  sessionId: string
  path: string
  depth: number
  expanded: Set<string>
  selected?: string
  /** 右键或单击选中的行。与「编辑器里打开的标签」分开：右键一个文件不打开它，也要看得出选的是哪一行。 */
  focused?: string
  selectedDirectory: string
  statuses: Map<string, string>
  dirty: Set<string>
  creating?: CreatingEntry
  renaming?: RenamingEntry
  onToggle(path: string): void
  onSelectDirectory(path: string): void
  onSelectPath(path: string): void
  onOpen(path: string, pin?: boolean): void
  onUpload(directory: string, files: FileList): void
  /** 右键定位菜单。菜单内容与动作都在 Explorer：只有它知道剪贴板、工作区根与上传目标。 */
  onContextMenu(event: MouseEvent, entry: FileEntry | null): void
  onCreatingChange(value: string): void
  onCreatingCancel(): void
  onCreatingSubmit(): void
  onRenamingChange(value: string): void
  onRenamingCancel(): void
  onRenamingSubmit(): void
}
/** 行内重命名：定位到哪一行，value 是输入框当前内容（放在 Explorer 里，菜单里的「重命名」才能打开它）。 */
interface RenamingEntry { path: string; value: string }
/** 正在展开的右键菜单；entry 为 null 表示点在文件树空白处，动作作用在工作区根。 */
interface FileMenu { entry: FileEntry | null; x: number; y: number }
interface CreatingEntry { kind: 'file' | 'directory'; directory: string; value: string; error?: string }

type ResizeDirection = 1 | -1

/** Calculate a panel width from a horizontal pointer movement. */
export function resizedPanelWidth(startWidth: number, startX: number, nextX: number, direction: ResizeDirection, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(startWidth + (nextX - startX) * direction)))
}

/**
 * 分隔条。
 *
 * `onPreview` 是「拖动过程中的视觉跟随」：有它的时候，pointermove 只调 onPreview（只写 CSS 变量，
 * 不碰 store/state），pointerup/pointercancel/窗口失焦时统一用 onWidth 提交一次。没有它时退回
 * 旧行为（每次 pointermove 直接 onWidth）。键盘与双击恢复默认值永远走 onWidth（一次提交）。
 */
function PanelResizer({ className, label, width, min, max, defaultWidth, direction, onWidth, onPreview }: { className: string; label: string; width: number; min: number; max: number; defaultWidth: number; direction: ResizeDirection; onWidth(width: number): void; onPreview?(width: number): void }) {
  const [dragging, setDragging] = useState(false)
  const stopDragging = useRef<() => void>(() => {})
  useEffect(() => () => stopDragging.current(), [])
  const stop = () => stopDragging.current()
  return <div className={className} data-dragging={dragging || undefined} role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(width)} tabIndex={0} title={`${label}，双击恢复默认`} onDoubleClick={() => onWidth(defaultWidth)} onKeyDown={event => {
    if (event.key === 'Home') { event.preventDefault(); onWidth(defaultWidth); return }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const pointerDelta = event.key === 'ArrowRight' ? 10 : -10
    onWidth(Math.max(min, Math.min(max, Math.round(width + pointerDelta * direction))))
  }} onPointerDown={event => {
    if (event.button !== 0) return
    event.preventDefault()
    stop()
    const startX = event.clientX
    const startWidth = width
    const handle = event.currentTarget
    handle.setPointerCapture?.(event.pointerId)
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'
    setDragging(true)
    const widthAt = (nextX: number) => resizedPanelWidth(startWidth, startX, nextX, direction, min, max)
    // 最近一次的指针位置：pointercancel/失焦时也用它把已经拖到的宽度落库（视觉上已经在那了，
    // 不落库会让状态与画面不一致）。
    let lastX = startX
    const move = (next: PointerEvent) => { lastX = next.clientX; (onPreview ?? onWidth)(widthAt(lastX)) }
    const cleanup = (commit = false, nextX = lastX) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      setDragging(false)
      stopDragging.current = () => {}
      if (!commit) return
      onWidth(widthAt(nextX))
    }
    const up = (next: PointerEvent) => cleanup(true, next.clientX)
    // pointercancel / 窗口失焦：拖动中断但宽度已经视觉生效，按最后位置提交（没有移动则等于原值）。
    const cancel = () => cleanup(true)
    stopDragging.current = cancel
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
  }}/>
}

function unloadedTab(path:string):Tab{return {path,content:'',draft:'',revision:'',size:0,binary:false,tooLarge:false,dirty:false,loaded:false,preview:/\.md$/i.test(path)}}

/**
 * 资源管理器里的文件类型图标。优先用 material-icon-theme 的彩色 SVG（与 VS Code 一致），
 * 没有对应图标时回落到 codicon 单色字形；目录仍用 codicon 的 folder / folder-opened。
 */
function FileGlyph({ name, kind, expanded }: { name: string; kind: 'file' | 'directory'; expanded: boolean }) {
  if (kind === 'directory') return <Icon name={expanded ? 'folder-opened' : 'folder'} className="dvw-file-icon folder"/>
  const url = fileIconUrl(name)
  return url === undefined
    ? <Icon name={fileIcon(name)} className="dvw-file-icon"/>
    : <img className="dvw-file-icon-img" src={url} alt="" loading="lazy" decoding="async"/>
}

/** Restore tab headers without reading their file contents. */

/** Return whether file changes require reloading one visible directory. */
export function directoryAffected(directory:string,changedPaths:string[]):boolean{return changedPaths.some(changed=>{const normalized=changed.replace(/\\/g,'/');const parent=normalized.includes('/')?normalized.slice(0,normalized.lastIndexOf('/')):'';return normalized===directory||parent===directory})}

/** Return the basename shown in a tab while preserving its full internal path. */
export function tabLabel(tab:Pick<Tab,'path'|'title'|'diffSourcePath'>):string{const path=tab.title??tab.diffSourcePath??tab.path.replace(/^diff:/,'');return path.split(/[\\/]/).at(-1)??path}
/** 自动保存策略（纯函数）：设置页的 editorAutoSave 只在 afterDelay 时启用，延迟已由 preferences 夹到 500–10000。 */
interface AutoSaveSettings { enabled: boolean; delayMs: number }
export function autoSaveSettings(preferences: Pick<WorkbenchPreferences, 'editorAutoSave' | 'editorAutoSaveDelayMs'>): AutoSaveSettings {
  return { enabled: preferences.editorAutoSave === 'afterDelay', delayMs: preferences.editorAutoSaveDelayMs }
}
/**
 * 缩进参考线。
 *
 * 照 VS Code 的做法：每一层缩进画一条 1px 竖线，位置对齐祖先那一层展开箭头的中心
 * （箭头槽 16px，中心即槽位起点 + 8px）。用背景渐变画，背景只铺到缩进区宽度为止，
 * 不会盖到图标与文件名上。因此行的悬停/选中底色必须用 background-color 设置 —— 用
 * background 简写会把这条背景图一起清掉。
 */
const treeGuides = (depth: number): React.CSSProperties => depth <= 0 ? {} : {
  // 每层一条独立的 1px 渐变，位置精确 —— 用 repeating-linear-gradient 会在偏移后从左边
  // 漏出上一周期的线，多出一条竖线。
  backgroundImage: Array.from({ length: depth }, () => 'linear-gradient(to right,var(--dvw-border) 0 1px,transparent 1px)').join(','),
  backgroundSize: Array.from({ length: depth }, () => '1px 100%').join(','),
  // 纵向偏移 3px：第一行与父行的展开箭头之间因此留出缝隙，不再像从箭头里长出来；
  // 线跨过行底 3px，相邻行之间依旧连续，不会变成虚线。
  backgroundPosition: Array.from({ length: depth }, (_item, level) => `${14 + level * 13}px 3px`).join(','),
  backgroundRepeat: 'no-repeat',
}


/** 资源管理器的失败统一用 alert 提示：这里没有全局错误栏，上传/剪贴板这类操作必须当场告诉用户。 */
function reportError(error: unknown): void { alert(error instanceof Error ? error.message : String(error)) }

/**
 * 一层文件列表，递归渲染子目录。
 *
 * 这里只负责「画行 + 交互」（单击、双击、拖放、右键定位），菜单内容与动作都交给 Explorer：
 * 菜单项是 menus.ts 里的纯数据描述，动作则需要剪贴板、工作区根、上传目标这些**单份**状态，
 * 放进这个每层递归都会实例化的组件里会变成多份拷贝（粘贴目标、选中态马上不一致）。
 */
function Tree(props: TreeProps) {
  const { sessionId, path, depth, expanded, selected, focused, selectedDirectory, statuses, dirty, creating, renaming } = props
  const [rows, setRows] = useState<FileEntry[]>([])
  const [error, setError] = useState<string>()
  const [dropTarget, setDropTarget] = useState(false)
  const load = useCallback(() => { void api<FileEntry[]>('fs.list', { sessionId, path }).then(setRows).catch(reason => setError(String(reason))) }, [sessionId, path])
  useEffect(load, [load])
  useEffect(() => {
    const handler = (event: Event) => { const paths = (event as CustomEvent<string[]>).detail; if (paths === undefined || directoryAffected(path, paths)) load() }
    window.addEventListener('dvw-files-changed', handler)
    return () => window.removeEventListener('dvw-files-changed', handler)
  }, [load])
  const drop = (event: DragEvent, directory: string) => { event.preventDefault(); event.stopPropagation(); setDropTarget(false); if (event.dataTransfer.files.length > 0) props.onUpload(directory, event.dataTransfer.files) }
  return <>
    {error && <div className="dvw-error">{error}</div>}
    {creating?.directory === path && <>
      <div className="dvw-tree-row dvw-tree-create-row" style={{ paddingLeft: 6 + depth * 13, ...treeGuides(depth) }}>
        <span className="dvw-chevron"/>
        <Icon name={creating.kind === 'directory' ? 'folder' : 'new-file'} className={`dvw-file-icon ${creating.kind === 'directory' ? 'folder' : ''}`}/>
        <input className="dvw-tree-create-input" value={creating.value} autoFocus aria-label={creating.kind === 'directory' ? '新建文件夹名称' : '新建文件名称'} aria-invalid={creating.error !== undefined} placeholder={creating.kind === 'directory' ? '文件夹名称' : '文件名称'} onChange={event => props.onCreatingChange(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); props.onCreatingSubmit() } if (event.key === 'Escape') { event.preventDefault(); props.onCreatingCancel() } }} onBlur={props.onCreatingCancel}/>
      </div>
      {creating.error && <div className="dvw-tree-create-error" style={{ paddingLeft: 42 + depth * 13 }}>{creating.error}</div>}
    </>}
    {rows.map(row => <div key={row.path}>
      <div className="dvw-tree-row"
        data-dvw-upload-directory={row.kind === 'directory' ? row.path : undefined}
        data-selected={row.path === selected || row.path === selectedDirectory || row.path === focused}
        data-drop-target={dropTarget && row.kind === 'directory'}
        style={{ paddingLeft: 6 + depth * 13, ...treeGuides(depth) }}
        onClick={() => {
          props.onSelectPath(row.path)
          if (row.kind === 'directory') { props.onSelectDirectory(row.path); props.onToggle(row.path) }
          else props.onOpen(row.path, false)
        }}
        onDoubleClick={() => { if (row.kind === 'file') props.onOpen(row.path, true) }}
        // 阻止冒泡：否则会再触发文件树容器的「空白处」菜单，一个右键弹出两层。
        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); props.onContextMenu(event, row) }}
        onDragEnter={event => { if (row.kind === 'directory' && event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); setDropTarget(true) } }}
        onDragOver={event => { if (row.kind === 'directory' && event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); setDropTarget(true) } }}
        onDragLeave={() => setDropTarget(false)}
        onDrop={event => { if (row.kind === 'directory') drop(event, row.path) }}
      >
        <span className="dvw-chevron">{row.kind === 'directory' && <Icon name={expanded.has(row.path) ? 'chevron-down' : 'chevron-right'}/>}</span>
        <FileGlyph name={row.name} kind={row.kind} expanded={expanded.has(row.path)}/>
        {renaming?.path === row.path
          ? <input className="dvw-tree-rename" value={renaming.value} autoFocus onClick={event => event.stopPropagation()} onChange={event => props.onRenamingChange(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); props.onRenamingSubmit() } if (event.key === 'Escape') { event.preventDefault(); props.onRenamingCancel() } }} onBlur={props.onRenamingCancel}/>
          : <>{row.kind === 'file' && dirty.has(row.path) && <span className="dvw-tree-dirty" title="有未保存的更改"/>}<span className="dvw-tree-name">{row.name}</span></>}
        {row.kind === 'file' && statuses.has(row.path) && <span className="dvw-tree-status" data-status={statuses.get(row.path)} title={statuses.get(row.path)}/>}
      </div>
      {row.kind === 'directory' && expanded.has(row.path) && <Tree {...props} path={row.path} depth={depth + 1}/>}
    </div>)}
  </>
}

/**
 * 资源管理器：工具条 + 文件树 + 右键菜单 + 删除确认。
 *
 * 菜单用共享的 <ContextMenu/> 与 menus.ts 的纯数据渲染，文件、目录、空白三种上下文各一份。
 * 全部动作实现集中在这里，是为了让「剪贴板」只有一份：剪切/复制是组件内状态而不是系统剪贴板，
 * 粘贴时才知道该 copy 还是 move；它也不跨页面存活，换来的是行为可预期（刷新页面即清空）。
 */
function Explorer(props: { sessionId: string; cwd?: string; selected?: string; dirty: Set<string>; onOpen(path: string, pin?: boolean): void }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [revision, setRevision] = useState(0)
  const [statuses, setStatuses] = useState<Map<string, string>>(new Map())
  const [dropTarget, setDropTarget] = useState(false)
  const [selectedDirectory, setSelectedDirectory] = useState('')
  const [focused, setFocused] = useState<string>()
  const [creating, setCreating] = useState<CreatingEntry>()
  const [renaming, setRenaming] = useState<RenamingEntry>()
  const [pendingDelete, setPendingDelete] = useState<FileEntry>()
  const [fileClipboard, setFileClipboard] = useState<FileClipboard>()
  const [menu, setMenu] = useState<FileMenu>()
  const picker = useRef<HTMLInputElement>(null)
  // 菜单里的「上传文件…」先记下它指定的目标目录，再点开系统选择框；工具条按钮则记当前选中目录。
  const uploadDirectory = useRef('')
  useEffect(() => { if (props.cwd) { try { setExpanded(new Set(JSON.parse(localStorage.getItem(`dvw:tree:${props.cwd}`) ?? '[]') as string[])) } catch { setExpanded(new Set()) } } }, [props.cwd])
  useEffect(() => { if (props.cwd) localStorage.setItem(`dvw:tree:${props.cwd}`, JSON.stringify([...expanded])) }, [props.cwd, expanded])
  const refreshStatus = useCallback(() => {
    void api<GitStatus>('git.status', { sessionId: props.sessionId })
      .then(status => setStatuses(new Map(status.changes.map(change => [change.path, gitStatusCode(change)]))))
      .catch(() => setStatuses(new Map()))
  }, [props.sessionId])
  const refreshStatusDebounced = useDebouncedCallback(refreshStatus, 500)
  useEffect(() => { refreshStatus(); const handler = () => refreshStatusDebounced(); window.addEventListener('dvw-files-changed', handler); return () => window.removeEventListener('dvw-files-changed', handler) }, [refreshStatus, refreshStatusDebounced])
  /**
   * 刷新文件树：`revision` 变化会让树重新挂载并重新 list；事件则通知其它监听者（Git 面板、会话里的搜索等）。
   * 剪贴板操作成功后两件事都要做，否则只有自己这棵树是新的、其它面板还停在旧状态。
   */
  const refresh = useCallback(() => { setRevision(value => value + 1); window.dispatchEvent(new Event('dvw-files-changed')) }, [])
  /** 新建入口的目标目录由菜单/工具条显式给出，不再一律用 selectedDirectory（空白处右键应落在工作区根）。 */
  const startCreating = (kind: 'file' | 'directory', directory: string) => {
    if (directory !== '') setExpanded(current => new Set(current).add(directory))
    setCreating({ kind, directory, value: '' })
  }
  const submitCreating = async () => {
    if (creating === undefined) return
    const value = creating.value.trim()
    if (value === '') { setCreating(current => current && ({ ...current, error: '请输入名称' })); return }
    const path = createdEntryPath(creating.directory, value)
    try {
      await api('fs.create', { sessionId: props.sessionId, path, kind: creating.kind })
      setCreating(undefined)
      setSelectedDirectory(creating.kind === 'directory' ? path : creating.directory)
      refresh()
    } catch (error) { setCreating(current => current && ({ ...current, error: error instanceof Error ? error.message : String(error) })) }
  }
  const upload = useCallback(async (directory: string, files: FileList) => {
    try {
      await Promise.all([...files].map(async file => {
        const query = new URLSearchParams({ sessionId: props.sessionId, directory, name: file.name })
        const response = await fetch(`/dsh-vscode/upload?${query}`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file })
        const answer = await response.json() as { ok: boolean; error?: { message?: string } }
        if (!response.ok || !answer.ok) throw new Error(answer.error?.message ?? 'upload failed')
      }))
      refresh()
    } catch (error) { reportError(error) }
  }, [props.sessionId, refresh])
  useEffect(() => {
    let activeTarget: HTMLElement | undefined
    const filesDragged = (event: globalThis.DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')
    const targetDirectory = (event: globalThis.DragEvent) => event.target instanceof Element ? event.target.closest<HTMLElement>('[data-dvw-upload-directory]') : null
    const clearTarget = () => { activeTarget?.removeAttribute('data-dvw-native-drop-target'); activeTarget = undefined }
    const intercept = (event: globalThis.DragEvent) => {
      if (!filesDragged(event)) return
      const target = targetDirectory(event)
      if (!target) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.type === 'dragleave') { if (!(event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) clearTarget(); return }
      clearTarget(); activeTarget = target; target.dataset.dvwNativeDropTarget = 'true'
      if (event.type === 'drop' && event.dataTransfer?.files.length) {
        const files = event.dataTransfer.files
        clearTarget()
        window.dispatchEvent(new CustomEvent('dvw-upload-files', { detail: { directory: target.dataset.dvwUploadDirectory ?? '', files } }))
      }
    }
    document.addEventListener('dragenter', intercept, true)
    document.addEventListener('dragover', intercept, true)
    document.addEventListener('dragleave', intercept, true)
    document.addEventListener('drop', intercept, true)
    const uploadFiles = (event: Event) => { const detail = (event as CustomEvent<{ directory: string; files: FileList }>).detail; if (detail?.files?.length) void upload(detail.directory, detail.files) }
    window.addEventListener('dvw-upload-files', uploadFiles)
    return () => { clearTarget(); document.removeEventListener('dragenter', intercept, true); document.removeEventListener('dragover', intercept, true); document.removeEventListener('dragleave', intercept, true); document.removeEventListener('drop', intercept, true); window.removeEventListener('dvw-upload-files', uploadFiles) }
  }, [upload])
  const drop = (event: DragEvent) => { event.preventDefault(); setDropTarget(false); if (event.dataTransfer.files.length > 0) void upload('', event.dataTransfer.files) }
  const destination = uploadDestination(selectedDirectory)
  const treeDrag = (event: DragEvent) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); setDropTarget(true) } }
  /**
   * 粘贴。复制走 fs.copy（目标已存在会 409，不覆盖）；剪切走 fs.move（宿主用原子 rename）。
   * 剪切成功后清空剪贴板：同一份「剪切」粘两次，第二次必然撞上「目标已存在」，留着只会让用户困惑。
   */
  const paste = async (directory: string) => {
    if (fileClipboard === undefined) return
    try {
      if (fileClipboard.op === 'cut') {
        await api('fs.move', { sessionId: props.sessionId, path: fileClipboard.path, directory })
        setFileClipboard(undefined)
      } else {
        await api('fs.copy', { sessionId: props.sessionId, path: fileClipboard.path, directory })
      }
      if (directory !== '') setExpanded(current => new Set(current).add(directory))
      setSelectedDirectory(directory)
      refresh()
    } catch (error) { reportError(error) }
  }
  const submitRename = async () => {
    if (renaming === undefined) return
    const { path, value } = renaming
    setRenaming(undefined)
    const next = value.trim()
    // 名字没变就不发请求：有些文件系统把「rename 到自身」当成 target-exists 报错。
    if (next === '' || renamedPath(path, next) === path) return
    try { await api('fs.rename', { sessionId: props.sessionId, path, nextPath: renamedPath(path, next) }); refresh() } catch (error) { reportError(error) }
  }
  const remove = async () => {
    if (pendingDelete === undefined) return
    const entry = pendingDelete
    setPendingDelete(undefined)
    try { await api('fs.delete', { sessionId: props.sessionId, path: entry.path }); refresh() } catch (error) { reportError(error) }
  }
  const copyEntryPath = async (entry: FileEntry, absolute: boolean) => {
    const text = absolute && props.cwd !== undefined ? workspaceAbsolutePath(props.cwd, entry.path) : entry.path
    if (!await copyText(text)) reportError(new Error('无法写入剪贴板'))
  }
  const copyWorkspacePath = async () => {
    if (props.cwd === undefined) return
    if (!await copyText(props.cwd)) reportError(new Error('无法写入剪贴板'))
  }
  /** 右键：先同步选中（目录同时成为新建/上传的目标目录），再按 entry 出菜单。 */
  const openMenu = (event: MouseEvent, entry: FileEntry | null) => {
    if (entry !== null) {
      setFocused(entry.path)
      if (entry.kind === 'directory') setSelectedDirectory(entry.path)
    }
    setMenu({ entry, x: event.clientX, y: event.clientY })
  }
  const actions: ExplorerMenuActions = {
    open: entry => props.onOpen(entry.path, true),
    createFile: directory => startCreating('file', directory),
    createDirectory: directory => startCreating('directory', directory),
    upload: directory => { uploadDirectory.current = directory; picker.current?.click() },
    rename: entry => setRenaming({ path: entry.path, value: entry.name }),
    remove: entry => setPendingDelete(entry),
    copy: (entry, op) => setFileClipboard({ op, path: entry.path, kind: entry.kind }),
    paste: directory => void paste(directory),
    copyPath: (entry, absolute) => void copyEntryPath(entry, absolute),
    copyWorkspacePath: () => void copyWorkspacePath(),
    openTerminal: directory => requestTerminal({ directory }),
    refresh,
  }
  return <>
    <div className="dvw-side-head">资源管理器
      <div className="dvw-toolbar">
        <input ref={picker} className="dvw-file-picker" type="file" accept="*/*" multiple onChange={event => { if (event.currentTarget.files) void upload(uploadDirectory.current, event.currentTarget.files); event.currentTarget.value = '' }}/>
        <button className="dvw-icon" title={`上传文件到 ${destination || '工作区根目录'}`} onClick={() => { uploadDirectory.current = selectedDirectory; picker.current?.click() }}><Icon name="cloud-upload"/></button>
        <button className="dvw-icon" title="新建文件" onClick={() => startCreating('file', selectedDirectory)}><Icon name="new-file"/></button>
        <button className="dvw-icon" title="新建文件夹" onClick={() => startCreating('directory', selectedDirectory)}><Icon name="new-folder"/></button>
        <button className="dvw-icon" title="刷新" onClick={refresh}><Icon name="refresh"/></button>
      </div>
    </div>
    <div className="dvw-tree" data-dvw-upload-directory="" data-drop-target={dropTarget} key={revision} onDragEnter={treeDrag} onDragOver={treeDrag} onDragLeave={() => setDropTarget(false)} onDrop={drop} onContextMenu={event => { event.preventDefault(); openMenu(event, null) }}>
      <Tree sessionId={props.sessionId} path="" depth={0} expanded={expanded} selected={props.selected} focused={focused} selectedDirectory={selectedDirectory} statuses={statuses} dirty={props.dirty} creating={creating} renaming={renaming} onToggle={path => setExpanded(current => { const next = new Set(current); next.has(path) ? next.delete(path) : next.add(path); return next })} onSelectDirectory={setSelectedDirectory} onSelectPath={setFocused} onOpen={props.onOpen} onUpload={(directory, files) => void upload(directory, files)} onContextMenu={openMenu} onCreatingChange={value => setCreating(current => current && ({ ...current, value, error: undefined }))} onCreatingCancel={() => setCreating(undefined)} onCreatingSubmit={() => void submitCreating()} onRenamingChange={value => setRenaming(current => current && { ...current, value })} onRenamingCancel={() => setRenaming(undefined)} onRenamingSubmit={() => void submitRename()}/>
    </div>
    {menu !== undefined && <ContextMenu position={{ x: menu.x, y: menu.y }} label="文件操作" entries={explorerMenuItems({ entry: menu.entry, canPaste: fileClipboard !== undefined, ...(props.cwd === undefined ? {} : { absolute: props.cwd }), actions })} onClose={() => setMenu(undefined)}/>}
    {pendingDelete && <div className="dvw-confirm-backdrop" role="presentation"><section className="dvw-confirm" role="alertdialog" aria-modal="true" aria-labelledby="dvw-delete-title" aria-describedby="dvw-delete-message"><h2 id="dvw-delete-title">删除 {pendingDelete.kind === 'directory' ? '文件夹' : '文件'}</h2><p id="dvw-delete-message">是否删除“{pendingDelete.name}”？</p><p className="dvw-confirm-note">此操作无法撤销。</p><footer><button autoFocus onClick={() => setPendingDelete(undefined)}>取消</button><button className="dvw-danger-button" onClick={() => void remove()}>删除</button></footer></section></div>}
  </>
}

/** Return the workspace-relative directory used by the file picker. */
export function uploadDestination(selectedDirectory?: string): string { return selectedDirectory ?? '' }

/** Join an inline-created entry name to the currently selected Explorer directory. */
export function createdEntryPath(directory: string, name: string): string { return directory ? `${directory}/${name}` : name }

/** Replace the final path component while preserving its workspace-relative directory. */
export function renamedPath(path: string, name: string): string { return [...path.split('/').slice(0, -1), name].filter(Boolean).join('/') }

function gitStatusCode(change: GitChange): string {
  if (change.untracked) return 'A'
  const code = change.worktree !== '.' ? change.worktree : change.index
  return code === '?' ? 'A' : code
}

function MarkdownOutline({headings,onClose,onHeading}:{headings:MarkdownHeading[];onClose():void;onHeading(index:number):void}) {
  return <aside className="dvw-outline dvw-editor-outline"><div className="dvw-outline-head"><span><Icon name="list-tree"/> 大纲</span><button className="dvw-icon" title="关闭大纲" onClick={onClose}><Icon name="close"/></button></div><div className="dvw-outline-list">{headings.map(heading=><button className="dvw-outline-item" key={heading.index} style={{paddingLeft:8+(heading.depth-1)*13}} onClick={()=>onHeading(heading.index)}>{heading.text}</button>)}</div></aside>
}

/** 搜索面板的选项开关：字形与 VS Code 查找控件一致（Aa / ab / .*）。 */
const SEARCH_FLAGS = [
  ['caseSensitive', 'case-sensitive', '区分大小写'],
  ['wholeWord', 'whole-word', '全字匹配'],
  ['regex', 'regex', '使用正则表达式'],
] as const

/** 搜索面板的持久化键：与 VS Code 一样跨会话保留上一次搜索（含替换串与选项）。 */
const SEARCH_STORAGE_KEY = 'dvw:search:v1'

/** 上次搜索的恢复：隐私模式读不到、内容坏掉都回落到默认值，不让面板起不来。 */
function readSearchState(): SearchState {
  try { return parseSearchState(localStorage.getItem(SEARCH_STORAGE_KEY)) } catch { return parseSearchState(null) }
}

/** 一条结果行对应的命中文本（右键「复制匹配内容」用）。 */
function matchTextOf(row: SearchRow): string {
  const hit = row.hits.find(candidate => candidate.start === row.column - 1)
  return hit === undefined ? row.preview.slice(row.column - 1) : row.preview.slice(hit.start, hit.start + hit.length)
}

/**
 * 搜索面板。
 *
 * 与 VS Code 的搜索视图对齐：Aa / ab / .* 开关、可展开的替换行（Ctrl+Shift+H）、
 * 包含/排除文件、按文件分组的结果（每处命中一行、行内全部命中高亮）、
 * F4 / Shift+F4 逐条跳转、输入即搜索（300ms 防抖）、「上一次搜索」跨会话保留。
 * 结果聚合与高亮的纯逻辑在 searchView.ts（那部分能在 node 里直接断言）。
 */
export function Search(props: { sessionId: string; service: VscodeWorkbench; onOpen(path: string, line: number, column: number, pin?: boolean): void }) {
  const [state, setState] = useState<SearchState>(readSearchState)
  const { query, include, exclude, replace, caseSensitive, wholeWord, regex, preserveCase } = state
  const patch = (value: Partial<SearchState>) => setState(current => ({ ...current, ...value }))
  /** 四个布尔开关走同一个写入口：计算属性名在展开对象里不好落在 Partial<SearchState> 上。 */
  const toggleFlag = (key: 'caseSensitive' | 'wholeWord' | 'regex' | 'preserveCase') => setState(current => {
    const next = { ...current }
    next[key] = !current[key]
    return next
  })
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [files, setFiles] = useState<readonly SearchFile[]>([])
  const [truncated, setTruncated] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [message, setMessage] = useState<string>()
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [activeRow, setActiveRow] = useState(0)
  const [menu, setMenu] = useState<{ row: SearchRow; x: number; y: number }>()
  const pending = useRef<AbortController>()
  const filesRef = useRef<readonly SearchFile[]>([])
  const activeRef = useRef(0)
  const queryInput = useRef<HTMLInputElement>(null)
  const replaceInput = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  // onOpen 来自 Workbench 的内联箭头函数，每次渲染都会换身份；用 ref 持有最新实现，
  // 这样 F4 的命令注册（以及 step 的 useCallback）只做一次。
  const onOpenRef = useRef(props.onOpen); onOpenRef.current = props.onOpen
  const requestRef = useRef({ query, include, exclude, caseSensitive, wholeWord, regex })
  requestRef.current = { query, include, exclude, caseSensitive, wholeWord, regex }
  const rows = useMemo(() => flattenRows(files), [files])
  const rowsRef = useRef(rows); rowsRef.current = rows
  const rowIndex = useMemo(() => new Map(rows.map((row, index) => [row, index] as const)), [rows])
  const invalidRegex = regexProblem(query, { regex, wholeWord })
  const allCollapsed = files.length > 0 && files.every(file => collapsed.has(file.path))

  useEffect(() => {
    try { localStorage.setItem(SEARCH_STORAGE_KEY, JSON.stringify(state)) } catch { /* 隐私模式下存储可能被拒；内存中的状态仍然可用。 */ }
  }, [state])
  useEffect(() => () => pending.current?.abort(), [])

  const runSearch = useCallback(async () => {
    const body = requestRef.current
    pending.current?.abort()
    if (body.query === '') {
      filesRef.current = []; setFiles([]); setTruncated(false); setError(undefined); setMessage(undefined); setBusy(false)
      return
    }
    const controller = new AbortController(); pending.current = controller
    setBusy(true); setError(undefined); setMessage(undefined)
    try {
      const result = await api<SearchResult>('search', { sessionId: props.sessionId, ...body }, controller.signal)
      if (controller.signal.aborted) return
      const next = groupMatches(result.matches)
      filesRef.current = next
      setFiles(next); setCollapsed(new Set()); setActiveRow(0); activeRef.current = 0
      setTruncated(result.truncated === true || result.limited === true)
    } catch (cause) {
      if (!controller.signal.aborted) { filesRef.current = []; setFiles([]); setError(String(cause)) }
    } finally {
      if (pending.current === controller) setBusy(false)
    }
  }, [props.sessionId])

  // 输入即搜索：VS Code 默认就这么干（search.searchOnType），300ms 防抖；
  // 正则写错时不发请求，只把错误显示在输入框下面。
  const scheduleSearch = useDebouncedCallback(() => { void runSearch() }, 300)
  useEffect(() => {
    if (invalidRegex !== undefined) return
    if (query === '') {
      filesRef.current = []; setFiles([]); setTruncated(false); setError(undefined); setMessage(undefined); setBusy(false)
      return
    }
    scheduleSearch()
  }, [query, include, exclude, caseSensitive, wholeWord, regex, invalidRegex, scheduleSearch, runSearch])

  /** 打开结果行：双击（pin=true）升级成固定标签，与 VS Code 的预览标签语义一致。 */
  const openRow = (index: number, pin?: boolean) => {
    const row = rowsRef.current[index]
    if (row === undefined) return
    activeRef.current = index; setActiveRow(index)
    onOpenRef.current(row.path, row.line, row.column, pin)
  }

  /** F4 / Shift+F4：在匹配序列上步进并直接打开，越界时环绕。 */
  const step = useCallback((direction: 1 | -1) => {
    const list = rowsRef.current
    const next = stepIndex(activeRef.current, list.length, direction)
    if (next < 0) return
    activeRef.current = next; setActiveRow(next)
    const row = list[next]
    if (row === undefined) return
    onOpenRef.current(row.path, row.line, row.column)
    // 结果可能是刚渲染出来的，等这次提交之后再滚动。
    window.setTimeout(() => { resultsRef.current?.querySelector(`[data-row-index="${next}"]`)?.scrollIntoView({ block: 'nearest' }) }, 0)
  }, [])

  useEffect(() => {
    const disposers = [
      props.service.registerCommand({ id: 'search.next', run: () => step(1) }),
      props.service.registerCommand({ id: 'search.previous', run: () => step(-1) }),
      props.service.registerCommand({ id: 'search.replace', run: () => { setReplaceOpen(true); window.setTimeout(() => replaceInput.current?.focus(), 0) } }),
      props.service.registerCommand({ id: 'search.focus', run: () => { queryInput.current?.focus(); queryInput.current?.select() } }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, [props.service, step])

  /**
   * 替换：`only` 有值就只改那一处，否则改范围内全部命中。
   * 替换后立刻重跑一次搜索，面板里看到的就是替换后的结果（也顺带验证真的写进去了）。
   */
  const submitReplace = async (only?: { path: string; line: number; column: number }) => {
    const body = requestRef.current
    if (body.query === '' || busy) return
    setBusy(true); setError(undefined); setMessage(undefined)
    try {
      const result = await api<SearchReplaceResult>('search.replace', {
        sessionId: props.sessionId, ...body, replace, preserveCase, ...(only === undefined ? {} : { only }),
      })
      const text = only === undefined
        ? (result.replacements === 0 ? '没有可替换的命中' : `已替换 ${result.replacements} 处，涉及 ${result.files.length} 个文件`)
        : (result.replacements === 0 ? '这一处已不在原位置（文件已变化），请重新搜索' : '已替换 1 处')
      await runSearch()
      setMessage(text)
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  const toggleCollapsed = (path: string) => setCollapsed(current => {
    const next = new Set(current)
    if (next.has(path)) next.delete(path); else next.add(path)
    return next
  })
  const toggleCollapseAll = () => setCollapsed(allCollapsed ? new Set() : new Set(files.map(file => file.path)))
  const clearResults = () => {
    pending.current?.abort()
    filesRef.current = []; setFiles([]); setTruncated(false); setError(undefined); setMessage(undefined); setActiveRow(0); activeRef.current = 0
  }
  const onResultsKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return
    event.preventDefault()
    if (event.key === 'Enter') { openRow(activeRef.current); return }
    const next = stepIndex(activeRef.current, rowsRef.current.length, event.key === 'ArrowDown' ? 1 : -1)
    if (next >= 0) { activeRef.current = next; setActiveRow(next) }
  }
  const resultMenu = (row: SearchRow): MenuEntry[] => [
    { kind: 'item', id: 'search.open', label: '在编辑器中打开', onSelect: () => onOpenRef.current(row.path, row.line, row.column) },
    { kind: 'item', id: 'search.open-pinned', label: '固定打开', onSelect: () => onOpenRef.current(row.path, row.line, row.column, true) },
    { kind: 'item', id: 'search.copy-path', label: '复制路径', onSelect: () => { void copyText(`${row.path}:${row.line}:${row.column}`) } },
    { kind: 'item', id: 'search.copy-match', label: '复制匹配内容', onSelect: () => { void copyText(matchTextOf(row)) } },
  ]

  return <>
    <div className="dvw-side-head">搜索
      <div className="dvw-toolbar">
        <button className="dvw-icon" title="刷新搜索结果" aria-label="刷新搜索结果" disabled={busy || query === ''} onClick={() => void runSearch()}><Icon name="refresh"/></button>
        <button className="dvw-icon" title={allCollapsed ? '全部展开' : '全部折叠'} aria-label={allCollapsed ? '全部展开' : '全部折叠'} disabled={files.length === 0} onClick={toggleCollapseAll}><Icon name={allCollapsed ? 'expand-all' : 'collapse-all'}/></button>
        <button className="dvw-icon" title="清除搜索结果" aria-label="清除搜索结果" disabled={files.length === 0} onClick={clearResults}><Icon name="close"/></button>
      </div>
    </div>
    <form className="dvw-search-form" onSubmit={event => { event.preventDefault(); void runSearch() }}>
      <div className="dvw-search-row">
        <button type="button" className="dvw-icon dvw-search-toggle" data-active={replaceOpen || undefined} aria-expanded={replaceOpen} aria-label={replaceOpen ? '隐藏替换' : '显示替换'} title={replaceOpen ? '隐藏替换' : '显示替换 (Ctrl+Shift+H)'} onClick={() => setReplaceOpen(value => !value)}><Icon name={replaceOpen ? 'chevron-down' : 'chevron-right'}/></button>
        <div className="dvw-search-input">
          <input ref={queryInput} className="dvw-input" value={query} placeholder="搜索" autoFocus aria-invalid={invalidRegex !== undefined} aria-label="搜索" onChange={event => patch({ query: event.target.value })}/>
          {query !== '' && <button type="button" className="dvw-icon dvw-search-clear" title="清除搜索" aria-label="清除搜索" onClick={() => { patch({ query: '' }); queryInput.current?.focus() }}><Icon name="close"/></button>}
        </div>
        <div className="dvw-search-flags">
          {SEARCH_FLAGS.map(([key, icon, label]) => <button key={key} type="button" className="dvw-flag" data-active={state[key] || undefined} aria-pressed={state[key]} aria-label={label} title={label} onClick={() => toggleFlag(key)}><Icon name={icon}/></button>)}
        </div>
        <button type="button" className="dvw-icon" data-active={optionsOpen || undefined} aria-expanded={optionsOpen} title="包含/排除文件" aria-label="包含/排除文件" onClick={() => setOptionsOpen(value => !value)}><Icon name="ellipsis"/></button>
      </div>
      {replaceOpen && <div className="dvw-search-row">
        <span className="dvw-search-toggle-spacer" aria-hidden="true"/>
        <div className="dvw-search-input">
          <input ref={replaceInput} className="dvw-input" value={replace} placeholder="替换" aria-label="替换" onChange={event => patch({ replace: event.target.value })}/>
        </div>
        <div className="dvw-search-flags">
          <button type="button" className="dvw-flag" data-active={preserveCase || undefined} aria-pressed={preserveCase} title="保留大小写" aria-label="保留大小写" onClick={() => toggleFlag('preserveCase')}><Icon name="preserve-case"/></button>
          <button type="button" className="dvw-flag" title="全部替换" aria-label="全部替换" disabled={busy || query === '' || rows.length === 0 || invalidRegex !== undefined} onClick={() => void submitReplace()}><Icon name="replace-all"/></button>
        </div>
      </div>}
      {optionsOpen && <div className="dvw-search-options">
        <input className="dvw-input" value={include} placeholder="要包含的文件，例如 src/**/*.ts" aria-label="要包含的文件" onChange={event => patch({ include: event.target.value })}/>
        <input className="dvw-input" value={exclude} placeholder="要排除的文件，例如 **/*.test.ts" aria-label="要排除的文件" onChange={event => patch({ exclude: event.target.value })}/>
      </div>}
    </form>
    {invalidRegex !== undefined && <div className="dvw-search-hint" data-tone="error" role="alert">{invalidRegex}</div>}
    {error !== undefined && <div className="dvw-error">{error}</div>}
    {busy && <div className="dvw-search-progress" role="progressbar" aria-label="搜索中"/>}
    {message !== undefined && <div className="dvw-search-hint" role="status">{message}</div>}
    {rows.length > 0 && <div className="dvw-search-summary" role="status">{rows.length} 个结果，{files.length} 个文件</div>}
    {truncated && <div className="dvw-search-hint" data-tone="warn">结果已截断，请缩小范围或用更精确的查询</div>}
    {query !== '' && invalidRegex === undefined && !busy && rows.length === 0 && error === undefined && <div className="dvw-search-hint">未找到结果</div>}
    <div className="dvw-results" ref={resultsRef} tabIndex={0} aria-label="搜索结果" onKeyDown={onResultsKeyDown}>
      {files.map(file => {
        const icon = fileIconUrl(file.name)
        const folded = collapsed.has(file.path)
        return <div className="dvw-result-group" key={file.path}>
          <button type="button" className="dvw-result-file" aria-expanded={!folded} onClick={() => toggleCollapsed(file.path)}>
            <Icon name={folded ? 'chevron-right' : 'chevron-down'}/>
            {icon === undefined ? <Icon name={fileIcon(file.name)}/> : <img className="dvw-file-icon-img" src={icon} alt=""/>}
            <span className="dvw-result-name">{file.name}</span>
            <span className="dvw-result-dir">{file.directory}</span>
            <span className="dvw-count">{file.rows.length}</span>
          </button>
          {!folded && file.rows.map(row => {
            const index = rowIndex.get(row) ?? 0
            return <div className="dvw-result" key={`${row.line}:${row.column}`} tabIndex={-1} data-row-index={index} data-active={index === activeRow || undefined} title={`${row.path}:${row.line}:${row.column}`}
              onClick={() => openRow(index)} onDoubleClick={() => openRow(index, true)} onContextMenu={event => { event.preventDefault(); setMenu({ row, x: event.clientX, y: event.clientY }) }}>
              <span className="dvw-line">{row.line}</span>
              <span className="dvw-preview">{highlightSegments(row.preview, row.hits).map((segment, position) => segment.hit
                ? <mark key={position} data-current={segment.start === row.column - 1 ? true : undefined}>{segment.text}</mark>
                : <span key={position}>{segment.text}</span>)}</span>
              {replaceOpen && <button type="button" className="dvw-icon dvw-search-replace-one" title="替换这一处" aria-label="替换这一处" disabled={busy} onClick={event => { event.stopPropagation(); void submitReplace({ path: row.path, line: row.line, column: row.column }) }}><Icon name="replace"/></button>}
            </div>
          })}
        </div>
      })}
    </div>
    {menu !== undefined && <ContextMenu position={{ x: menu.x, y: menu.y }} label="搜索结果" entries={resultMenu(menu.row)} onClose={() => setMenu(undefined)}/>}
  </>
}

export function Workbench({ service, sessionId, cwd }: { service: VscodeWorkbench; sessionId?: string; cwd?: string }) {
  const [snapshot, setSnapshot] = useState(() => service.getSnapshot()); const [panels, setPanels] = useState(() => service.getPanels())
  const [layout, setLayout] = useState(() => service.getLayout())
  useEffect(() => service.subscribe(() => { setSnapshot(service.getSnapshot()); setPanels(service.getPanels()); setLayout(service.getLayout()) }), [service])
  // 布局偏好存在 service 上（拖分隔条、点标签栏按钮都改它），这里给出与旧 useState 同形的局部访问器，
  // 下面各处调用点不必改动。状态栏不再可隐藏：它只有 24px、承载工作区路径与返回入口，
  // 而工作台里没有就地开关可以把它叫回来，所以固定常显。
  const { primarySideVisible, chatVisible, sideWidth, chatWidth, bottomHeight } = layout
  const setPrimarySideVisible = (value: boolean) => service.setLayout({ primarySideVisible: value })
  const setChatVisible = (value: boolean | ((current: boolean) => boolean)) => service.setLayout({ chatVisible: typeof value === 'function' ? value(service.getLayout().chatVisible) : value })
  const setSideWidth = (value: number) => service.setLayout({ sideWidth: value })
  const setChatWidth = (value: number) => service.setLayout({ chatWidth: value })
  // 底部面板高度也在 layout 里（持久化）；拖动期间只写 CSS 变量，松手才走这里落库一次。
  const setBottomHeight = (value: number) => service.setLayout({ bottomHeight: value })
  /**
   * 窗口在运行中缩小时，持久化的底部高度可能超出新视口。
   *
   * 恢复持久化值时已经按视口夹过一次，但之后 resize 不会走 setLayout；这里监听 resize，
   * 停止 200ms 后用同一个 `reclampBottomHeight` 算一次：只有合法值真的变化才 setLayout
   * （否则每次 resize 都会写 localStorage + 广播 + 整棵树重渲染）。拖拽语义不变。
   */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onResize = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const next = reclampBottomHeight(service.getLayout())
        if (next !== undefined) service.setLayout({ bottomHeight: next })
      }, 200)
    }
    window.addEventListener('resize', onResize)
    return () => { clearTimeout(timer); window.removeEventListener('resize', onResize) }
  }, [service])
  /**
   * 拖动分隔条期间的视觉跟随。
   *
   * 每个 pointermove 都 `setLayout` 会走 service.emit + 同步 localStorage.setItem + 整棵树重渲染
   * （实测拖一次侧边栏就是 60–120 次），而拖动只影响两列的宽度。这里改为只写 overlay 上的
   * `--dvw-side-width` / `--dvw-chat-width`（样式表里 grid、状态栏 padding 与对话栏缩放条都读它），
   * 松手时再由 PanelResizer 调一次 onWidth 落库。
   *
   * 内嵌的 DSH 对话栏是 `position:fixed`、不在 overlay 子树里，宽度写在它自己的 inline style 上
   * （DshConversationPanel 通过 [data-dvw-conversation-panel] 写入），所以拖动对话栏时要同步写一次，
   * 否则对话内容要等松手才跟着变宽。
   */
  const overlayRef=useRef<HTMLDivElement>(null)
  const previewPanelWidth=(name:'sideWidth'|'chatWidth')=>{
    const cssName=name==='sideWidth'?'--dvw-side-width':'--dvw-chat-width'
    return (value:number)=>{
      overlayRef.current?.style.setProperty(cssName,`${value}px`)
      if(name==='chatWidth')document.querySelector<HTMLElement>('[data-dvw-conversation-panel]')?.style.setProperty(cssName,`${value}px`)
    }
  }
  /**
   * 拖底部面板的上边缘调高度。
   *
   * 与两个横向分隔条同一套路：拖动期间**只写** overlay 上的 `--dvw-bottom-height`（`.dvw-bottom`
   * 的 height 读这个变量），pointerup / pointercancel / 窗口失焦才 setBottomHeight 一次
   * （→ service.setLayout 持久化）。原先每次 pointermove 都 setState：一次拖动 60–120 次
   * 整棵树重渲染（资源管理器、提交图、编辑器外壳、终端面板都跟着），而实际只变了一行的高度。
   *
   * 夹取规则与旧实现逐字一致：BOTTOM_HEIGHT.min .. bottomHeightLimit()（= innerHeight-160）。
   */
  const dragBottomPanel=(event:{button:number;clientY:number})=>{
    if(event.button!==0)return
    const startY=event.clientY,startHeight=bottomHeight
    const heightAt=(nextY:number)=>Math.max(BOTTOM_HEIGHT.min,Math.min(bottomHeightLimit(),startHeight+startY-nextY))
    let lastY=startY
    const move=(next:PointerEvent)=>{lastY=next.clientY;overlayRef.current?.style.setProperty('--dvw-bottom-height',`${heightAt(lastY)}px`)}
    const cleanup=(commit:boolean)=>{
      window.removeEventListener('pointermove',move)
      window.removeEventListener('pointerup',up)
      window.removeEventListener('pointercancel',cancel)
      window.removeEventListener('blur',cancel)
      if(commit)setBottomHeight(heightAt(lastY))
    }
    const up=()=>cleanup(true)
    // 拖动中断（pointercancel / 失焦）时高度已经视觉生效，按最后位置落库。
    const cancel=()=>cleanup(true)
    window.addEventListener('pointermove',move)
    window.addEventListener('pointerup',up)
    window.addEventListener('pointercancel',cancel)
    window.addEventListener('blur',cancel)
  }
  // 会话与工作目录由 Overlay 统一从主视图会话解析后传入（0.2.1 不再提供 state.current）。
  const [workspace,setWorkspace]=useState<{cwd:string;name:string}>(); const [tabs,setTabs]=useState<Tab[]>([]); const [active,setActive]=useState<string>(); const [error,setError]=useState<string>(); const [outlineVisible,setOutlineVisible]=useState(()=>localStorage.getItem('dvw:outline')!=='closed');const [headerHost,setHeaderHost]=useState<HTMLDivElement|null>(null);const [tabMenu,setTabMenu]=useState<{path:string;x:number;y:number}>()
  /**
   * 最近一次打开的底部面板。
   *
   * 底部面板收起后**不卸载**，只用 display:none 藏起来：终端面板的 xterm 实例与 WebSocket
   * 都挂在挂载期，卸载一次就要重建实例、重新回放 scrollback，收起再打开会有明显的停顿。
   * 记住它，重新打开时直接显示。
   */
  const bottomPanelRef=useRef<string|undefined>(undefined)
  /** 关闭确认框：标签路径算好之后再弹，决定交给 resolvePendingClose。 */
  const [pendingClose,setPendingClose]=useState<PendingClose>()
  // 自动保存读的是可订阅的偏好：设置页一改，这里立刻重排/清理定时器，不用刷新页面。
  const preferences=usePreferences()
  const tabsRef=useRef(tabs);tabsRef.current=tabs
  const workspaceRequests=useRef(new WorkspaceRequestScope());const loadingTabs=useRef(new Set<string>())
  const dshDark = useDshDarkTheme()
  // 不再有手动配色：工作台与内嵌编辑器的深/浅色一律取自 DSH 当前主题。
  const colorScheme: 'dark' | 'light' = dshDark ? 'dark' : 'light'
  // 只有大纲的显隐还留在 localStorage 里：它属于单次阅读状态，不走布局偏好。
  // 早前这里还有四条 `dvw:dsh-chat-visible` / `dvw:primary-side-visible` 之类的写入：布局改由
  // service 统一持久化之后，那几个键已经没有任何读取方，删掉它们（否则每次改宽度都白写一遍）。
  useEffect(()=>localStorage.setItem('dvw:outline',outlineVisible?'open':'closed'),[outlineVisible])
  useEffect(()=>{if(!snapshot.visible)return;const onKey=(event:KeyboardEvent)=>{if(event.isComposing||!event.ctrlKey||!event.altKey||event.shiftKey||event.code!=='KeyB')return;event.preventDefault();setChatVisible(value=>!value)};window.addEventListener('keydown',onKey,true);return()=>window.removeEventListener('keydown',onKey,true)},[snapshot.visible])
  /**
   * 「添加至对话 / 询问 DSH」由 dshChat 派发 dvw-reveal-chat：先把右侧 DSH 对话栏展开，
   * 用户才看得到刚插入的引用或刚发出的提问。直接写 service 的布局状态，不依赖未 memo 的 setter。
   */
  useEffect(() => {
    const reveal = () => service.setLayout({ chatVisible: true })
    window.addEventListener(REVEAL_CHAT_EVENT, reveal)
    return () => window.removeEventListener(REVEAL_CHAT_EVENT, reveal)
  }, [service])
  /**
   * 「在终端中打开」由 requestTerminal 派发 dvw-terminal-show；把底部面板切到终端这件事归工作台，
   * 因为只有它持有 overlay 与底部面板状态。已经停在终端时**不能**再 toggle —— 那会把它关掉，
   * 用户点菜单反而看到终端消失。
   */
  useEffect(() => {
    const show = () => {
      if (!service.getPanels().some(panel => panel.id === 'terminal')) return
      service.show()
      if (service.getSnapshot().bottomPanel !== 'terminal') service.toggleBottomPanel('terminal')
    }
    window.addEventListener('dvw-terminal-show', show)
    return () => window.removeEventListener('dvw-terminal-show', show)
  }, [service])
  // 打开工作台时预热 TextMate：首次装分词器约 100ms（WASM 加载 + 语法编译），
  // 放在这里就挪到用户不敏感的时刻，点开文件时不再卡那一下。
  useEffect(() => { if (snapshot.visible) preloadTextMate(['typescript','javascript','json','markdown']) }, [snapshot.visible])
  /**
   * 打开文件，按 VS Code 的标签语义：未固定的标签是“预览标签”，只会占用同一个槽位——
   * 再点别的文件时把它替换掉，而不是每次都新开一个。双击（pin=true）或在编辑器里改动过
   * （见 dirty 的写入点）才升级为固定标签。恢复上次会话时恢复出来的标签一律固定。
   */
  const openForWorkspace=(path:string,line?:number,column?:number,pin?:boolean)=>{
    const existing=tabsRef.current.find(tab=>tab.path===path)
    if(existing!==undefined){
      // 已打开的标签被再次点击：若它还是预览标签且这次是双击，就地固定下来。
      setTabs(rows=>rows.map(tab=>tab.path===path?{...tab,line,column,pinned:tab.pinned||pin===true||undefined}:tab))
    }else{
      setTabs(rows=>{
        const kept=pin===true?rows:rows.filter(tab=>tab.pinned===true||tab.path.startsWith('diff:'))
        return [...kept,{...unloadedTab(path),line,column,pinned:pin===true||undefined}]
      })
    }
    setActive(path)
  }
  useEffect(()=>{if(!snapshot.visible||sessionId===undefined)return;const epoch=workspaceRequests.current.begin();const cleared=resetWorkspaceDocuments<Tab>();loadingTabs.current.clear();setWorkspace(undefined);setTabs(cleared.tabs);tabsRef.current=cleared.tabs;setActive(cleared.active);setError(cleared.error);const controller=new AbortController();void api<{cwd:string;name:string}>('workspace',{sessionId},controller.signal).then(value=>{if(!workspaceRequests.current.isCurrent(epoch))return;setWorkspace(value);}).catch(error=>{if(!controller.signal.aborted&&workspaceRequests.current.isCurrent(epoch))setError(String(error))});return()=>{controller.abort();loadingTabs.current.clear();workspaceRequests.current.invalidate(epoch)}},[snapshot.visible,sessionId])
  // 文件变更监听。地址必须用宿主的绝对地址：桌面端页面在 dsh-app://app/ 下，location.host 是
  // "app"，按它拼出来的 ws://app/… 连不上（实测 close 1006）——同一处坑，终端那边也踩过。
  // 宿主地址随 API 响应写进 api.ts 的模块状态，所以这里等它到位再连；拿不到就不连（Web 端会
  // 立刻拿到，桌面端要等第一次 API 返回）。
  useEffect(() => {
    if (!snapshot.visible || sessionId === undefined) return
    let ws: WebSocket | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let closed = false
    const connect = () => {
      if (closed || currentHostBase() === undefined) return
      ws = new WebSocket(hostWebSocketUrl('/dsh-vscode/ws/files', { sessionId }))
      ws.onmessage = event => {
        let paths: string[] = []
        let reload = false
        try {
          const message = JSON.parse(String(event.data)) as { paths?: string[]; reload?: boolean }
          paths = message.paths ?? []
          reload = message.reload === true
        } catch { /* 忽略格式不对的消息 */ }
        // reload（watcher 溢出，事件可能丢）：detail 必须是 undefined —— Tree 用
        // `paths === undefined` 判断「整体重扫」。CustomEvent 的 detail 即使显式传 undefined 也会被
        // WebIDL 转成 null，所以这里先不带 detail 构造，再 defineProperty 覆盖成真正的 undefined。
        // 普通事件仍传相对路径数组，只刷新受影响的目录。
        const changed = reload ? new CustomEvent('dvw-files-changed') : new CustomEvent('dvw-files-changed', { detail: paths })
        if (reload) Object.defineProperty(changed, 'detail', { value: undefined, configurable: true })
        window.dispatchEvent(changed)
        // 守卫在 markTabsExternal 里：没有需要标记的脏标签时返回原数组，不触发整棵树重渲染。
        setTabs(markTabsExternal)
      }
    }
    // 宿主地址可能还没到（第一次 API 尚未返回），稍后重试一次。
    if (currentHostBase() === undefined) timer = setTimeout(connect, 1500)
    else connect()
    return () => { closed = true; clearTimeout(timer); ws?.close() }
  }, [snapshot.visible, sessionId])
  useEffect(()=>{if(sessionId===undefined||active===undefined)return;const tab=tabsRef.current.find(row=>row.path===active);if(tab===undefined||tab.loaded!==false||loadingTabs.current.has(active))return;const epoch=workspaceRequests.current.current();loadingTabs.current.add(active);const documentPreview=documentPreviewKind(active);if(documentPreview!==undefined){const documentUrl=`/dsh-vscode/file?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(active)}`;setTabs(rows=>rows.map(row=>row.path===active?{...row,loaded:true,documentPreview,documentUrl}:row));loadingTabs.current.delete(active);return}if(/\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i.test(active)){const imageUrl=`/dsh-vscode/file?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(active)}`;setTabs(rows=>rows.map(row=>row.path===active?{...row,loaded:true,imageUrl}:row));loadingTabs.current.delete(active);return}void api<FileDocument>('fs.read',{sessionId,path:active}).then(doc=>{if(!workspaceRequests.current.isCurrent(epoch))return;if(doc.binary){setTabs(rows=>rows.filter(row=>row.path!==active));setActive(current=>current===active?undefined:current);setError('二进制文件不能在文本编辑器中打开');return}if(doc.tooLarge){setTabs(rows=>rows.map(row=>row.path===active?{...row,tooLarge:true,size:doc.size,loaded:true}:row));return}setTabs(rows=>rows.map(row=>row.path===active?{...row,...doc,draft:doc.content,loaded:true}:row))}).catch(error=>{if(workspaceRequests.current.isCurrent(epoch))setError(String(error))}).finally(()=>loadingTabs.current.delete(active))},[active,sessionId,tabs])
  const open=(path:string,line?:number,column?:number,pin?:boolean)=>{if(sessionId!==undefined)openForWorkspace(path,line,column,pin)}
  /**
   * 打开提交图 / Git 输出标签页。
   *
   * 它们是「虚拟标签」：不读磁盘文件（loaded:true），内容由组件自己取数；再次打开时复用同一个标签，
   * 只更新范围（graphAll）——与 VS Code Git Graph 扩展的标签行为一致。
   */
  const openGitGraph=(all:boolean)=>{const key=GIT_GRAPH_PATH;setTabs(rows=>rows.some(row=>row.path===key)?rows.map(row=>row.path===key?{...row,graphAll:all,pinned:true}:row):[...rows,{...unloadedTab(key),title:'提交图',pinned:true,loaded:true,graphAll:all}]);setActive(key)}
  const openGitOutput=()=>{const key=GIT_OUTPUT_PATH;setTabs(rows=>rows.some(row=>row.path===key)?rows:[...rows,{...unloadedTab(key),title:'Git 输出',pinned:true,loaded:true}]);setActive(key)}
  /** 提交差异在编辑器里开一个虚拟 diff 标签（Git 面板与提交图标签页的「打开差异」都走这里）。 */
  const openDiffTab=(path:string,diff:GitDiff,title?:string,sourcePath?:string)=>{const key=`diff:${path}`;setTabs(rows=>[...rows.filter(row=>row.path!==key),{path:key,title,content:diff.diff,draft:diff.diff,revision:'',size:diff.diff.length,binary:false,tooLarge:false,dirty:false,pinned:true,diff,diffMode:'inline',diffSourcePath:sourcePath}]);setActive(key)}
  useEffect(()=>{const listener=(event:Event)=>void open((event as CustomEvent<string>).detail);window.addEventListener('dvw-open-workspace-path',listener);return()=>window.removeEventListener('dvw-open-workspace-path',listener)},[sessionId,tabs])
  /**
   * 保存一个脏标签，返回是否成功。
   *
   * 关闭确认框需要知道「保存成功才关标签」，所以这里把结果返回给调用方；失败原因仍然走原有
   * 的错误栏（例如磁盘上的 revision 已变，宿主拒绝覆盖，草稿与 revision 都保持原样）。
   */
  const save=async(tab:Tab):Promise<boolean>=>{if(sessionId===undefined||!tab.dirty)return true;try{const doc=await api<FileDocument>('fs.save',{sessionId,path:tab.path,content:tab.draft,revision:tab.revision});setTabs(rows=>rows.map(row=>row.path===tab.path?{...row,...doc,draft:doc.content,dirty:false,external:false}:row));return true}catch(error){setError(String(error));return false}}
  /**
   * 自动保存（设置页的 editorAutoSave === 'afterDelay'）。
   *
   * 定时器按标签路径记录「排程时的草稿」：同一个标签继续输入就清掉旧定时器重新计时 —— 这正是
   * 「最后一次改动静默 N 毫秒」的语义。标签变干净、被关掉、偏好被关掉或工作台隐藏时都清理：
   * 隐藏后仍写盘会把用户明确选择的「不保存」偷偷保存掉。真正的写盘仍然走上面的 save()。
   */
  const saveRef=useRef(save);saveRef.current=save
  const autoSaveTimers=useRef(new Map<string,{timer:ReturnType<typeof setTimeout>;draft:string;delayMs:number}>())
  const autoSave=autoSaveSettings(preferences)
  useEffect(()=>{
    const timers=autoSaveTimers.current
    const stopAll=()=>{for(const entry of timers.values())clearTimeout(entry.timer);timers.clear()}
    if(!snapshot.visible||!autoSave.enabled){stopAll();return}
    const dirty=new Map(dirtyCloseTabs(tabs).map(tab=>[tab.path,tab]))
    for(const [path,entry] of [...timers]){
      const tab=dirty.get(path)
      if(tab!==undefined&&tab.draft===entry.draft&&entry.delayMs===autoSave.delayMs)continue
      clearTimeout(entry.timer);timers.delete(path)
    }
    for(const [path,tab] of dirty){
      if(timers.has(path))continue
      const timer=setTimeout(()=>{timers.delete(path);const latest=tabsRef.current.find(row=>row.path===path);if(latest!==undefined&&latest.dirty)void saveRef.current(latest)},autoSave.delayMs)
      timers.set(path,{timer,draft:tab.draft,delayMs:autoSave.delayMs})
    }
  },[autoSave.enabled,autoSave.delayMs,snapshot.visible,tabs])
  // 卸载时清掉未触发的自动保存，避免组件消失后还去写盘。
  useEffect(()=>()=>{for(const entry of autoSaveTimers.current.values())clearTimeout(entry.timer);autoSaveTimers.current.clear()},[])
  // 超过宿主上限的文件默认不读；用户在编辑器里确认后带上 force 再读一次。
  const forceLoad=async(path:string)=>{if(sessionId===undefined)return;try{const doc=await api<FileDocument>('fs.read',{sessionId,path,force:true});setTabs(rows=>rows.map(row=>row.path===path?{...row,...doc,draft:doc.content,tooLarge:false,loaded:true}:row))}catch(error){setError(String(error))}}
  /**
   * 关闭一批标签。
   *
   * 所有关闭入口（× 按钮、右键菜单的关闭/关闭其他/关闭右侧/关闭已保存、全部关闭）都先算出
   * 「实际要关哪些标签」，再交给这里：没有脏文件就直接关；有脏文件则统一弹同一个 ClosePrompt
   * —— 单个显示 保存/不保存/取消，多个显示 全部保存/不保存全部/取消。保存仍走上面的 save()。
   *
   * 菜单动作全部从 tabsRef 读当前标签：菜单打开后被别处的异步操作改过标签列表时，状态闭包会过期。
   */
  const applyClose=(paths:readonly string[])=>{
    const closing=new Set(paths)
    const current=tabsRef.current
    setTabs(rows=>rows.filter(tab=>!closing.has(tab.path)))
    // 关掉的是当前标签时，优先激活左侧最近的一个，其次右侧，都没有则回到空编辑器。
    setActive(currentActive=>{
      if(currentActive===undefined||!closing.has(currentActive))return currentActive
      const index=current.findIndex(tab=>tab.path===currentActive)
      for(let cursor=index-1;cursor>=0;cursor--){const tab=current[cursor];if(tab!==undefined&&!closing.has(tab.path))return tab.path}
      for(let cursor=index+1;cursor<current.length;cursor++){const tab=current[cursor];if(tab!==undefined&&!closing.has(tab.path))return tab.path}
      return undefined
    })
  }
  const requestCloseTabs=(paths:readonly string[])=>{
    const requested=new Set(paths)
    const targets=tabsRef.current.filter(tab=>requested.has(tab.path))
    if(targets.length===0)return
    if(!needsClosePrompt(targets)){applyClose(targets.map(tab=>tab.path));return}
    setPendingClose({action:'close',paths:targets.map(tab=>tab.path),dirtyPaths:dirtyCloseTabs(targets).map(tab=>tab.path)})
  }
  /** 返回 DSH：有脏文件先弹确认；全部保存成功才真的 hide，取消则留在工作台。 */
  const hideWorkbench=()=>{
    const dirtyPaths=dirtyCloseTabs(tabsRef.current).map(tab=>tab.path)
    if(dirtyPaths.length===0){service.hide();return}
    setPendingClose({action:'hide',paths:tabsRef.current.map(tab=>tab.path),dirtyPaths})
  }
  /**
   * 对话框的决定。
   *
   * 保存失败（如磁盘冲突）时标签留在原地、错误走原有错误栏；批量关闭只关保存成功的那些，
   * 失败的继续开着；返回 DSH 时只要有失败就不隐藏 —— 宁可留在工作台，也不要静默丢掉改动。
   */
  const resolvingClose=useRef(false)
  const resolvePendingClose=async(decision:'save'|'discard')=>{
    // 保存多个文件要逐个 await：期间对话框已经卸载，但连点仍可能进第二次，这里挡一下。
    if(resolvingClose.current)return
    const pending=pendingClose
    if(pending===undefined)return
    resolvingClose.current=true
    setPendingClose(undefined)
    try{
      if(decision==='discard'){if(pending.action==='hide')service.hide();else applyClose(pending.paths);return}
      // 保存时重新读当前标签：对话框开着的时候自动保存可能已经把某些标签保存干净了。
      const mustSave=new Set(pending.dirtyPaths)
      const failed=new Set<string>()
      for(const tab of tabsRef.current.filter(row=>row.dirty&&mustSave.has(row.path))){if(!await save(tab))failed.add(tab.path)}
      if(pending.action==='hide'){if(failed.size===0)service.hide();return}
      applyClose(pending.paths.filter(path=>!failed.has(path)))
    }finally{resolvingClose.current=false}
  }
  const closeAll=()=>requestCloseTabs(tabsRef.current.map(tab=>tab.path))
  const closeOtherTabs=(path:string)=>requestCloseTabs(tabsRef.current.filter(tab=>tab.path!==path).map(tab=>tab.path))
  const closeRightTabs=(path:string)=>{const index=tabsRef.current.findIndex(tab=>tab.path===path);if(index<0)return;requestCloseTabs(tabsRef.current.slice(index+1).map(tab=>tab.path))}
  const closeSavedTabs=()=>requestCloseTabs(tabsRef.current.filter(tab=>!tab.dirty).map(tab=>tab.path))
  const togglePinTab=(path:string)=>setTabs(rows=>rows.map(tab=>tab.path===path?{...tab,pinned:tab.pinned===true?undefined:true}:tab))
  /** 复制标签路径。diff: 标签没有真实文件路径（菜单已把路径项禁用），这里再兜一层。 */
  const copyTabPath=(path:string,absolute:boolean)=>{if(path.startsWith('diff:'))return;const text=absolute&&workspace!==undefined?workspaceAbsolutePath(workspace.cwd,path):path;void copyText(text).then(ok=>{if(!ok)setError('无法写入剪贴板')})}
  /** 按当前标签集合生成菜单项：关闭类项是否禁用取决于「其他/右侧/已保存」有没有东西可关。 */
  const tabMenuEntries=(menu:{path:string}):MenuEntry[]=>{const tab=tabs.find(row=>row.path===menu.path);const index=tabs.findIndex(row=>row.path===menu.path);return tabMenuItems({path:menu.path,pinned:tab?.pinned===true,dirty:tab?.dirty===true,others:tabs.length>1,right:index>=0&&index<tabs.length-1,saved:tabs.some(row=>row.path!==menu.path&&!row.dirty),...(workspace===undefined?{}:{absolute:workspace.cwd}),actions:{close:()=>requestCloseTabs([menu.path]),closeOthers:()=>closeOtherTabs(menu.path),closeRight:()=>closeRightTabs(menu.path),closeSaved:closeSavedTabs,togglePin:()=>togglePinTab(menu.path),copyPath:absolute=>copyTabPath(menu.path,absolute),openTerminal:()=>requestTerminal({directory:parentDirectory(menu.path)})}})}
  const activeTab=tabs.find(tab=>tab.path===active); if(snapshot.bottomPanel!==undefined)bottomPanelRef.current=snapshot.bottomPanel; const bottomPanelId=snapshot.bottomPanel??bottomPanelRef.current; const Panel=panels.find(panel=>panel.id===bottomPanelId)?.component; const terminalAvailable=panels.some(panel=>panel.id==='terminal')
  /**
   * Monaco 模型回收用的「打开 / 脏」文件集合。
   *
   * 只从工作台按当前标签算出来传给编辑器 —— 编辑器不知道自己打开过哪些文件，全局单例又会把
   * 多工作区/重开的情况搅在一起。URI 写法与 MonacoEditor 的 uri prop 完全同一套
   * （`${cwd}/${path}` 再拼 file:///），两边才对得上。
   * diff: 标签是虚拟差异视图（走 MonacoDiffEditor，模型由它自己 dispose），不参与回收判定。
   */
  const modelUriOf=(path:string)=>`${workspace?.cwd??''}/${path}`
  // 工作区还没解析出来（cwd 未知）时传 undefined：编辑器据此跳过回收判定，别把打开中的标签误回收。
  const keepModelPaths=workspace===undefined?undefined:tabs.filter(tab=>!tab.path.startsWith('diff:')).map(tab=>modelUriOf(tab.path))
  const dirtyModelPaths=workspace===undefined?undefined:tabs.filter(tab=>tab.dirty&&!tab.path.startsWith('diff:')).map(tab=>modelUriOf(tab.path))
  const selectView=(view:WorkbenchView)=>{if(snapshot.view===view&&primarySideVisible){setPrimarySideVisible(false);return}setPrimarySideVisible(true);service.show(view)}
  const selectHeading=(index:number)=>{if(activeTab===undefined)return;setTabs(rows=>rows.map(tab=>tab.path===activeTab.path?{...tab,preview:true}:tab));window.setTimeout(()=>window.dispatchEvent(new CustomEvent('dvw-markdown-heading',{detail:index})),50)}
  const suppressAttachmentDrop=(event:DragEvent)=>{if(!event.dataTransfer.types.includes('Files'))return;const target=event.target;const insideTree=target instanceof Element&&target.closest('.dvw-tree')!==null;if(!insideTree){event.preventDefault();event.stopPropagation()}}
  // 编辑器身份与大纲都在提前返回之前算：hooks 不能放在条件分支之后。
  const markdown=activeTab!==undefined&&!activeTab.path.startsWith('diff:')&&/\.md$/i.test(activeTab.path)
  const diffMarkdown=activeTab?.diff!==undefined&&/\.md$/i.test(activeTab.diffSourcePath??'')
  const markdownPreview=markdown||(diffMarkdown&&activeTab?.preview===true)
  /**
   * 大纲标题。提取是全文 split+逐行正则（实测 300KB 文档 416µs/次），原来每次渲染都跑；
   * 而它会跟着「保存文件 / 拖动分隔条 / 右键菜单」这类与文档无关的重渲染一起触发，必须 memo。
   * 依赖只有源文本：预览开关切换（preview=true）时源文本不变，也不需要重算。
   */
  const markdownSource=markdownPreview&&activeTab!==undefined?(activeTab.diff?.modified??activeTab.draft):undefined
  const headings=useMemo(()=>markdownSource===undefined?[]:markdownHeadings(markdownSource),[markdownSource])
  if(!snapshot.visible)return null
  if(sessionId===undefined)return <div className="dvw-overlay"><div className="dvw-empty" style={{gridColumn:'1/4'}}><div>请先选择或创建一个 DSH 会话。<br/><button onClick={()=>hideWorkbench()}>返回 DSH</button></div></div></div>
  return <div ref={overlayRef} className="dvw-overlay" data-dvw-chat={chatVisible||undefined} data-dvw-primary-side={primarySideVisible||undefined} style={{'--dvw-side-width':`${sideWidth}px`,'--dvw-chat-width':`${chatWidth}px`,'--dvw-bottom-height':`${bottomHeight}px`} as CSSProperties} role="dialog" aria-label="AIDE" onDragEnterCapture={suppressAttachmentDrop} onDragOverCapture={suppressAttachmentDrop} onDropCapture={suppressAttachmentDrop}>
    <DshConversationPanel visible={chatVisible} width={chatWidth}/>
    {chatVisible&&<aside className="dvw-chat"><PanelResizer className="dvw-chat-resizer" label="拖动调整 DSH 对话栏宽度" width={chatWidth} min={400} max={720} defaultWidth={420} direction={-1} onWidth={setChatWidth} onPreview={previewPanelWidth('chatWidth')}/><header className="dvw-chat-head"><span><DshMark/> DSH</span><button className="dvw-icon" title="关闭 DSH 对话栏" onClick={()=>setChatVisible(false)}><Icon name="close"/></button></header><div className="dvw-chat-body"/></aside>}
    <nav className="dvw-activity"><button className="dvw-act" data-active={primarySideVisible&&snapshot.view==='explorer'} title="资源管理器" onClick={()=>selectView('explorer')}><Icon name="files"/></button><button className="dvw-act" data-active={primarySideVisible&&snapshot.view==='search'} title="搜索" onClick={()=>selectView('search')}><Icon name="search"/></button><button className="dvw-act" data-active={primarySideVisible&&snapshot.view==='git'} title="源代码管理" onClick={()=>selectView('git')}><Icon name="source-control"/></button><button className="dvw-act" data-active={active===GIT_GRAPH_PATH||undefined} title="提交图" onClick={()=>openGitGraph(false)}><Icon name="graph"/></button><button className="dvw-act" data-active={snapshot.bottomPanel==='terminal'} disabled={!terminalAvailable} title={terminalAvailable?(snapshot.bottomPanel==='terminal'?'隐藏终端':'显示终端'):'终端适配器未安装'} onClick={()=>toggleTerminal(service)}><Icon name="terminal"/></button><button className="dvw-act dsh" title="返回 DSH" onClick={()=>hideWorkbench()}><Icon name="home"/></button><button className="dvw-act" title="在 DSH 设置中管理 AIDE 选项" onClick={()=>service.openDshSettings()}><Icon name="settings"/></button></nav>
    <aside className="dvw-side" data-side-width={sideWidth}>{snapshot.view==='explorer'&&<Explorer sessionId={sessionId} cwd={workspace?.cwd} selected={active} dirty={new Set(tabs.filter(tab=>tab.dirty).map(tab=>tab.path))} onOpen={(path,pin)=>void open(path,undefined,undefined,pin)}/>} {snapshot.view==='search'&&<Search sessionId={sessionId} service={service} onOpen={(path,line,column,pin)=>void open(path,line,column,pin)}/>} {snapshot.view==='git'&&<Git sessionId={sessionId} absoluteRoot={workspace?.cwd} onDiff={openDiffTab} onOpenGraph={openGitGraph} onOpenOutput={openGitOutput}/>}</aside>
    <PanelResizer className="dvw-side-resizer" label="拖动调整源码管理侧边栏宽度" width={sideWidth} min={210} max={640} defaultWidth={210} direction={1} onWidth={setSideWidth} onPreview={previewPanelWidth('sideWidth')}/>
    <main className="dvw-main"><div className="dvw-tabs"><div className="dvw-tab-list">{tabs.map(tab=><button className="dvw-tab" data-active={tab.path===active} data-pinned={tab.pinned===true||undefined} key={tab.path} title={tab.diffSourcePath??tab.path} onClick={()=>setActive(tab.path)} onContextMenu={event=>{event.preventDefault();event.stopPropagation();setTabMenu({path:tab.path,x:event.clientX,y:event.clientY})}}><span className="dvw-tab-name">{tab.dirty?'● ':''}{tabLabel(tab)}</span><span onClick={event=>{event.stopPropagation();requestCloseTabs([tab.path])}}><Icon name="close"/></span></button>)}</div>{tabMenu!==undefined&&<ContextMenu position={{x:tabMenu.x,y:tabMenu.y}} label="标签页操作" entries={tabMenuEntries(tabMenu)} onClose={()=>setTabMenu(undefined)}/>}<div className="dvw-tab-actions">{tabs.length>0&&<button className="dvw-icon dvw-close-all" title="全部关闭" onClick={closeAll}><Icon name="close-all"/></button>}<button className="dvw-icon dvw-chat-action" data-active={chatVisible||undefined} title={chatVisible?'隐藏 DSH 对话栏 (Ctrl+Alt+B)':'显示 DSH 对话栏 (Ctrl+Alt+B)'} aria-pressed={chatVisible} onClick={()=>setChatVisible(value=>!value)}><Icon name={chatVisible?'layout-sidebar-right':'layout-sidebar-right-off'}/></button></div></div><div className="dvw-editor" data-outline={markdownPreview&&outlineVisible&&headings.length>0}>{error&&<div className="dvw-error"><button className="dvw-icon" onClick={()=>setError(undefined)}><Icon name="close"/></button>{error}</div>}{markdownPreview&&outlineVisible&&headings.length>0&&<MarkdownOutline headings={headings} onClose={()=>setOutlineVisible(false)} onHeading={selectHeading}/>} {markdown&&activeTab&&<div className="dvw-editor-toolbar"><button className="dvw-icon dvw-outline-toggle" data-active={outlineVisible} title={outlineVisible?'关闭 Markdown 大纲':'显示 Markdown 大纲'} onClick={()=>setOutlineVisible(value=>!value)}><Icon name="list-tree"/></button><button className="dvw-mode-button" data-active={!activeTab.preview} onClick={()=>setTabs(rows=>rows.map(tab=>tab.path===activeTab.path?{...tab,preview:false}:tab))}><Icon name="code"/> 源码</button><button className="dvw-mode-button" data-active={activeTab.preview} onClick={()=>setTabs(rows=>rows.map(tab=>tab.path===activeTab.path?{...tab,preview:true}:tab))}><Icon name="preview"/> 预览</button></div>}{activeTab?.diff&&<div className="dvw-editor-toolbar dvw-diff-toolbar">{diffMarkdown&&<div className="dvw-diff-preview-switch"><button className="dvw-mode-button" data-diff-view="diff" data-active={!activeTab.preview} onClick={()=>setTabs(rows=>rows.map(tab=>tab.path===activeTab.path?{...tab,preview:false}:tab))}><Icon name="diff"/> 差异</button><button className="dvw-mode-button" data-diff-view="preview" data-active={activeTab.preview} onClick={()=>setTabs(rows=>rows.map(tab=>tab.path===activeTab.path?{...tab,preview:true}:tab))}><Icon name="preview"/> 预览</button></div>}{!activeTab.preview&&<><button className="dvw-mode-button" data-mode="inline" data-active={activeTab.diffMode!=='split'} title="内联视图" onClick={()=>setTabs(rows=>rows.map(tab=>tab.path===activeTab.path?{...tab,diffMode:'inline'}:tab))}><Icon name="diff-single"/> 内联</button><button className="dvw-mode-button" data-mode="split" data-active={activeTab.diffMode==='split'} title="并排视图" onClick={()=>setTabs(rows=>rows.map(tab=>tab.path===activeTab.path?{...tab,diffMode:'split'}:tab))}><Icon name="diff-sidebyside"/> 并排</button></>}</div>}<div className="dvw-editor-body" data-toolbar={markdown||activeTab?.diff!==undefined}>{activeTab?.tooLarge===true?<div className="dvw-editor-prompt"><strong>文件超过 5 MiB，是否加载此文件？</strong><span>{activeTab.path}（{Math.round(activeTab.size/1048576)} MiB）</span><span className="dvw-editor-prompt-note">大文件会让编辑器变慢，也会占用较多内存。</span><button type="button" className="dvw-mode-button" onClick={()=>void forceLoad(activeTab.path)}>加载此文件</button></div>:activeTab===undefined?<div className="dvw-empty"><div><strong>DSH AIDE</strong><br/>从资源管理器或搜索结果打开文件</div></div>:activeTab.path===GIT_GRAPH_PATH?<GitGraphTab key={activeTab.graphAll===true?'all':'current'} sessionId={sessionId} initialAllBranches={activeTab.graphAll===true} onOpenDiff={openDiffTab}/>:activeTab.path===GIT_OUTPUT_PATH?<GitOutputTab/>:activeTab.diff?diffMarkdown&&activeTab.preview?<MarkdownPreview source={activeTab.diff.modified} sessionId={sessionId} path={activeTab.diffSourcePath??''}/>:<MonacoDiffEditor uri={`${workspace?.cwd??''}/${activeTab.path}`} original={activeTab.diff.original} modified={activeTab.diff.modified} mode={activeTab.diffMode??'inline'} theme={colorScheme}/>:activeTab.imageUrl?<div className="dvw-image-preview"><img src={activeTab.imageUrl} alt={activeTab.path}/><span>{activeTab.path}</span></div>:activeTab.documentPreview&&activeTab.documentUrl?<DocumentPreview kind={activeTab.documentPreview} src={activeTab.documentUrl} path={activeTab.path}/>:markdown&&activeTab.preview?<MarkdownPreview source={activeTab.draft} sessionId={sessionId} path={activeTab.path}/>:<MonacoEditor uri={`${workspace?.cwd??''}/${activeTab.path}`} value={activeTab.draft} theme={colorScheme} sessionId={sessionId} line={activeTab.line} column={activeTab.column} keepModelPaths={keepModelPaths} dirtyModelPaths={dirtyModelPaths} onChange={draft=>setTabs(rows=>rows.map(tab=>tab.path===activeTab.path?{...tab,draft,dirty:draft!==tab.content}:tab))} onSave={()=>void save(activeTab)}/>}</div></div></main>
    {bottomPanelId!==undefined&&<section className="dvw-bottom" style={{height:`var(--dvw-bottom-height, ${BOTTOM_HEIGHT.default}px)`,...(snapshot.bottomPanel===undefined?{display:'none'}:{})}}><div style={{height:4,cursor:'ns-resize'}} onPointerDown={dragBottomPanel}/><div className="dvw-bottom-head"><div className="dvw-bottom-headslot" ref={setHeaderHost}/>{snapshot.bottomPanel==='terminal'&&sessionId!==undefined&&<TerminalNewButton sessionId={sessionId}/>}<button className="dvw-icon" style={{marginLeft:'auto'}} onClick={()=>service.toggleBottomPanel(snapshot.bottomPanel!)}><Icon name="close"/></button></div><div className="dvw-bottom-body">{Panel&&cwd&&<Panel sessionId={sessionId} cwd={cwd} visible={snapshot.bottomPanel!==undefined} colorScheme={colorScheme} header={headerHost}/>}</div></section>}
    <footer className="dvw-status"><span><Icon name="git-branch"/> 工作区</span><span>{workspace?.cwd??cwd??''}</span>{activeTab?.external&&<span>磁盘文件已变化</span>}<button className="dvw-icon" style={{color:'white',marginLeft:'auto'}} onClick={()=>hideWorkbench()}>返回 DSH</button></footer>
    {pendingClose!==undefined&&<ClosePrompt paths={pendingClose.dirtyPaths} onSave={()=>void resolvePendingClose('save')} onDiscard={()=>void resolvePendingClose('discard')} onCancel={()=>setPendingClose(undefined)}/>}
  </div>
}
