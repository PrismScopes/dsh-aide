import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, ReactNode } from 'react'
import type { FileDocument, FileEntry, GitChange, GitCommit, GitCommitFile, GitDiff, GitStatus, SearchMatch } from '../types.ts'
import { ApiError, api, currentHostBase, hostWebSocketUrl } from './api.ts'
import type { VscodeWorkbench, WorkbenchView } from './service.ts'
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
import { useDebouncedCallback } from './hooks.ts'
import { preloadTextMate } from './textmateHighlight.ts'

// 从 GitPanel 拆出后重新导出，保持既有引用（含单测）不变。
export { graphRows, graphTrackPath } from './GitPanel.tsx'
export type { GraphRow, GraphTrack } from './GitPanel.tsx'

interface Tab extends FileDocument { dirty: boolean; draft: string; loaded?: boolean; line?: number; column?: number; external?: boolean; preview?: boolean; title?: string; diff?: GitDiff; diffMode?: 'inline' | 'split'; diffSourcePath?:string; imageUrl?:string; documentPreview?:DocumentPreviewKind; documentUrl?:string; pinned?: boolean }
// 工作台不提供配色选项，配色始终由 DSH 主题决定（见 useDshDarkTheme）。
interface TreeProps { sessionId: string; path: string; depth: number; expanded: Set<string>; selected?: string; selectedDirectory: string; statuses: Map<string, string>; onToggle(path: string): void; onSelectDirectory(path: string): void; onOpen(path: string, pin?: boolean): void; onChange(): void; onUpload(directory: string, files: FileList): void }
interface CreatingEntry { kind: 'file' | 'directory'; directory: string; value: string; error?: string }

type ResizeDirection = 1 | -1

/** Calculate a panel width from a horizontal pointer movement. */
export function resizedPanelWidth(startWidth: number, startX: number, nextX: number, direction: ResizeDirection, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(startWidth + (nextX - startX) * direction)))
}

function PanelResizer({ className, label, width, min, max, defaultWidth, direction, onWidth }: { className: string; label: string; width: number; min: number; max: number; defaultWidth: number; direction: ResizeDirection; onWidth(width: number): void }) {
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
    const move = (next: PointerEvent) => onWidth(resizedPanelWidth(startWidth, startX, next.clientX, direction, min, max))
    const cleanup = (commit = false, nextX = startX) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      setDragging(false)
      stopDragging.current = () => {}
      if (!commit) return
      onWidth(Math.max(min, Math.min(max, Math.round(startWidth + (nextX - startX) * direction))))
    }
    const up = (next: PointerEvent) => cleanup(true, next.clientX)
    const cancel = () => cleanup()
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
export function restoreTabPaths(paths:string[]):Tab[]{return [...new Set(paths)].map(unloadedTab)}

/** Return whether file changes require reloading one visible directory. */
export function directoryAffected(directory:string,changedPaths:string[]):boolean{return changedPaths.some(changed=>{const normalized=changed.replace(/\\/g,'/');const parent=normalized.includes('/')?normalized.slice(0,normalized.lastIndexOf('/')):'';return normalized===directory||parent===directory})}

/** Return the basename shown in a tab while preserving its full internal path. */
export function tabLabel(tab:Pick<Tab,'path'|'title'|'diffSourcePath'>):string{const path=tab.title??tab.diffSourcePath??tab.path.replace(/^diff:/,'');return path.split(/[\\/]/).at(-1)??path}

function Tree({ sessionId, path, depth, expanded, selected, selectedDirectory, statuses, onToggle, onSelectDirectory, onOpen, onChange, onUpload, creating, onCreatingChange, onCreatingCancel, onCreatingSubmit }: TreeProps & { creating?: CreatingEntry; onCreatingChange(value: string): void; onCreatingCancel(): void; onCreatingSubmit(): void }) {
  const [rows, setRows] = useState<FileEntry[]>([]); const [error, setError] = useState<string>(); const [dropTarget, setDropTarget] = useState(false); const [context, setContext] = useState<{ entry: FileEntry; x: number; y: number }>(); const [renaming, setRenaming] = useState<{ path: string; value: string }>(); const [pendingDelete, setPendingDelete] = useState<FileEntry>()
  const load = useCallback(() => { void api<FileEntry[]>('fs.list', { sessionId, path }).then(setRows).catch(error => setError(String(error))) }, [sessionId, path])
  useEffect(load, [load])
  useEffect(() => {
    const handler = (event:Event) => { const paths=(event as CustomEvent<string[]>).detail; if(paths===undefined||directoryAffected(path,paths))load() }; window.addEventListener('dvw-files-changed', handler); return () => window.removeEventListener('dvw-files-changed', handler)
  }, [load])
  useEffect(() => { if (context === undefined) return; const close = () => setContext(undefined); const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }; window.addEventListener('pointerdown', close); window.addEventListener('keydown', escape); return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape) } }, [context])
  useEffect(() => { if (pendingDelete === undefined) return; const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setPendingDelete(undefined) }; window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape) }, [pendingDelete])
  const rename = async (entry: FileEntry) => { const value = renaming?.path === entry.path ? renaming.value.trim() : ''; setRenaming(undefined); if (value === '' || value === entry.name) return; try { await api('fs.rename', { sessionId, path: entry.path, nextPath: renamedPath(entry.path, value) }); load(); onChange() } catch (error) { alert(error instanceof Error ? error.message : String(error)) } }
  const remove = async () => { if (pendingDelete === undefined) return; const entry = pendingDelete; setPendingDelete(undefined); try { await api('fs.delete', { sessionId, path: entry.path }); load(); onChange() } catch (error) { alert(error instanceof Error ? error.message : String(error)) } }
  const drop = (event: DragEvent, directory: string) => { event.preventDefault(); event.stopPropagation(); setDropTarget(false); if (event.dataTransfer.files.length > 0) onUpload(directory, event.dataTransfer.files) }
  return <>{error && <div className="dvw-error">{error}</div>}{creating?.directory === path && <><div className="dvw-tree-row dvw-tree-create-row" style={{ paddingLeft: 6 + depth * 13 }}><span className="dvw-chevron"/><Icon name={creating.kind === 'directory' ? 'folder' : 'new-file'} className={`dvw-file-icon ${creating.kind === 'directory' ? 'folder' : ''}`}/><input className="dvw-tree-create-input" value={creating.value} autoFocus aria-label={creating.kind === 'directory' ? '新建文件夹名称' : '新建文件名称'} aria-invalid={creating.error !== undefined} placeholder={creating.kind === 'directory' ? '文件夹名称' : '文件名称'} onChange={event => onCreatingChange(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onCreatingSubmit() } if (event.key === 'Escape') { event.preventDefault(); onCreatingCancel() } }} onBlur={onCreatingCancel}/></div>{creating.error && <div className="dvw-tree-create-error" style={{ paddingLeft: 42 + depth * 13 }}>{creating.error}</div>}</>}{rows.map(row => <div key={row.path}>
    <div className="dvw-tree-row" data-dvw-upload-directory={row.kind === 'directory' ? row.path : undefined} data-selected={selected === row.path || selectedDirectory === row.path} data-drop-target={dropTarget && row.kind === 'directory'} style={{ paddingLeft: 6 + depth * 13 }} onClick={() => row.kind === 'directory' ? (onSelectDirectory(row.path), onToggle(row.path)) : onOpen(row.path, false)} onDoubleClick={() => { if (row.kind === 'file') onOpen(row.path, true) }} onContextMenu={(event) => { event.preventDefault(); if (row.kind === 'directory') onSelectDirectory(row.path); setContext({ entry: row, x: event.clientX, y: event.clientY }) }} onDragEnter={event => { if (row.kind === 'directory' && event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); setDropTarget(true) } }} onDragOver={event => { if (row.kind === 'directory' && event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); setDropTarget(true) } }} onDragLeave={() => setDropTarget(false)} onDrop={event => row.kind === 'directory' && drop(event, row.path)}>
      <span className="dvw-chevron">{row.kind === 'directory' && <Icon name={expanded.has(row.path) ? 'chevron-down' : 'chevron-right'}/>}</span><FileGlyph name={row.name} kind={row.kind} expanded={expanded.has(row.path)}/>{renaming?.path === row.path ? <input className="dvw-tree-rename" value={renaming.value} autoFocus onClick={event => event.stopPropagation()} onChange={event => setRenaming({ path: row.path, value: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') void rename(row); if (event.key === 'Escape') setRenaming(undefined) }} onBlur={() => setRenaming(undefined)}/> : <span className="dvw-tree-name">{row.name}</span>}{row.kind === 'file' && statuses.has(row.path) && <span className="dvw-tree-status" data-status={statuses.get(row.path)}>{statuses.get(row.path)}</span>}
    </div>
    {row.kind === 'directory' && expanded.has(row.path) && <Tree {...{ sessionId, path: row.path, depth: depth + 1, expanded, selected, selectedDirectory, statuses, onToggle, onSelectDirectory, onOpen, onChange, onUpload, creating, onCreatingChange, onCreatingCancel, onCreatingSubmit }} />}
  </div>)}{context && <div className="dvw-context-menu" role="menu" style={{ left: context.x, top: context.y }} onPointerDown={event => event.stopPropagation()}><button role="menuitem" onClick={() => { setRenaming({ path: context.entry.path, value: context.entry.name }); setContext(undefined) }}><Icon name="edit"/>重命名</button><button className="dvw-context-delete" role="menuitem" onClick={() => { setPendingDelete(context.entry); setContext(undefined) }}><Icon name="trash"/>删除</button></div>}{pendingDelete && <div className="dvw-confirm-backdrop" role="presentation"><section className="dvw-confirm" role="alertdialog" aria-modal="true" aria-labelledby="dvw-delete-title" aria-describedby="dvw-delete-message"><h2 id="dvw-delete-title">删除 {pendingDelete.kind === 'directory' ? '文件夹' : '文件'}</h2><p id="dvw-delete-message">是否删除“{pendingDelete.name}”？</p><p className="dvw-confirm-note">此操作无法撤销。</p><footer><button autoFocus onClick={() => setPendingDelete(undefined)}>取消</button><button className="dvw-danger-button" onClick={() => void remove()}>删除</button></footer></section></div>}</>
}

function Explorer(props: { sessionId: string; cwd?: string; selected?: string; onOpen(path: string, pin?: boolean): void }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); const [revision, setRevision] = useState(0); const [statuses, setStatuses] = useState<Map<string, string>>(new Map()); const [dropTarget, setDropTarget] = useState(false); const [selectedDirectory, setSelectedDirectory] = useState(''); const [creating, setCreating] = useState<CreatingEntry>(); const picker = useRef<HTMLInputElement>(null)
  useEffect(() => { if (props.cwd) { try { setExpanded(new Set(JSON.parse(localStorage.getItem(`dvw:tree:${props.cwd}`) ?? '[]') as string[])) } catch { setExpanded(new Set()) } } }, [props.cwd])
  useEffect(() => { if (props.cwd) localStorage.setItem(`dvw:tree:${props.cwd}`, JSON.stringify([...expanded])) }, [props.cwd, expanded])
  const refreshStatus = useCallback(() => {
    void api<GitStatus>('git.status', { sessionId: props.sessionId })
      .then(status => setStatuses(new Map(status.changes.map(change => [change.path, gitStatusCode(change)]))))
      .catch(() => setStatuses(new Map()))
  }, [props.sessionId])
  const refreshStatusDebounced = useDebouncedCallback(refreshStatus, 500)
  useEffect(() => { refreshStatus(); const handler = () => refreshStatusDebounced(); window.addEventListener('dvw-files-changed', handler); return () => window.removeEventListener('dvw-files-changed', handler) }, [refreshStatus, refreshStatusDebounced])
  const startCreating = (kind: 'file' | 'directory') => { const directory = selectedDirectory; if (directory) setExpanded(current => new Set(current).add(directory)); setCreating({ kind, directory, value: '' }) }
  const submitCreating = async () => { if (creating === undefined) return; const value = creating.value.trim(); if (value === '') { setCreating(current => current && ({ ...current, error: '请输入名称' })); return } const path = createdEntryPath(creating.directory, value); try { await api('fs.create', { sessionId: props.sessionId, path, kind: creating.kind }); const created = path; setCreating(undefined); setSelectedDirectory(creating.kind === 'directory' ? created : creating.directory); setRevision(x => x + 1); window.dispatchEvent(new Event('dvw-files-changed')) } catch (error) { setCreating(current => current && ({ ...current, error: error instanceof Error ? error.message : String(error) })) } }
  const upload = useCallback(async (directory: string, files: FileList) => { try { await Promise.all([...files].map(async file => { const query = new URLSearchParams({ sessionId: props.sessionId, directory, name: file.name }); const response = await fetch(`/dsh-vscode/upload?${query}`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file }); const answer = await response.json() as { ok: boolean; error?: { message?: string } }; if (!response.ok || !answer.ok) throw new Error(answer.error?.message ?? 'upload failed') })); setRevision(value => value + 1); window.dispatchEvent(new Event('dvw-files-changed')) } catch (error) { alert(error instanceof Error ? error.message : String(error)) } }, [props.sessionId])
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
  return <><div className="dvw-side-head">资源管理器<div className="dvw-toolbar"><input ref={picker} className="dvw-file-picker" type="file" accept="*/*" multiple onChange={event => { if (event.currentTarget.files) void upload(destination, event.currentTarget.files); event.currentTarget.value = '' }}/><button className="dvw-icon" title={`上传文件到 ${destination || '工作区根目录'}`} onClick={() => picker.current?.click()}><Icon name="cloud-upload"/></button><button className="dvw-icon" title="新建文件" onClick={() => startCreating('file')}><Icon name="new-file"/></button><button className="dvw-icon" title="新建文件夹" onClick={() => startCreating('directory')}><Icon name="new-folder"/></button><button className="dvw-icon" title="刷新" onClick={() => { setRevision(x => x + 1); window.dispatchEvent(new Event('dvw-files-changed')) }}><Icon name="refresh"/></button></div></div><div className="dvw-tree" data-dvw-upload-directory="" data-drop-target={dropTarget} key={revision} onDragEnter={treeDrag} onDragOver={treeDrag} onDragLeave={() => setDropTarget(false)} onDrop={drop}><Tree sessionId={props.sessionId} path="" depth={0} expanded={expanded} selected={props.selected} selectedDirectory={selectedDirectory} statuses={statuses} onToggle={path => setExpanded(current => { const next = new Set(current); next.has(path) ? next.delete(path) : next.add(path); return next })} onSelectDirectory={setSelectedDirectory} onOpen={props.onOpen} onChange={() => setRevision(x => x + 1)} onUpload={(directory, files) => void upload(directory, files)} creating={creating} onCreatingChange={value => setCreating(current => current && ({ ...current, value, error: undefined }))} onCreatingCancel={() => setCreating(undefined)} onCreatingSubmit={() => void submitCreating()} /></div></>
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

function Search(props: { sessionId: string; onOpen(path: string, line: number, column: number): void }) {
  const [query, setQuery] = useState(''); const [include, setInclude] = useState(''); const [exclude, setExclude] = useState(''); const [flags, setFlags] = useState({ caseSensitive: false, wholeWord: false, regex: false }); const [matches, setMatches] = useState<SearchMatch[]>([]); const [limited, setLimited] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string>()
  const pending = useRef<AbortController>()
  useEffect(() => () => pending.current?.abort(), [])
  const search = async () => { pending.current?.abort(); const controller = new AbortController(); pending.current = controller; setBusy(true); setError(undefined); try { const result = await api<{ matches: SearchMatch[]; limited: boolean }>('search', { sessionId: props.sessionId, query, include, exclude, ...flags }, controller.signal); setMatches(result.matches); setLimited(result.limited) } catch (error) { if (!controller.signal.aborted) setError(String(error)) } finally { if (pending.current === controller) setBusy(false) } }
  const groups = useMemo(() => {
    const grouped = new Map<string, SearchMatch[]>()
    for (const match of matches) grouped.set(match.path, [...(grouped.get(match.path) ?? []), match])
    return grouped
  }, [matches])
  return <><div className="dvw-side-head">搜索</div><form className="dvw-search-form" onSubmit={event => { event.preventDefault(); void search() }}><input className="dvw-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索" autoFocus/><div className="dvw-options">{([['caseSensitive','Aa'],['wholeWord','Ab'],['regex','.*']] as const).map(([key,label]) => <label key={key}><input type="checkbox" checked={flags[key]} onChange={e => setFlags({ ...flags, [key]: e.target.checked })}/>{label}</label>)}<button className="dvw-icon" title="搜索" disabled={busy}><Icon name="search"/></button></div><input className="dvw-input" value={include} onChange={e=>setInclude(e.target.value)} placeholder="包含文件，例如 src/**"/><input className="dvw-input" value={exclude} onChange={e=>setExclude(e.target.value)} placeholder="排除文件，例如 **/*.test.ts"/></form>{error&&<div className="dvw-error">{error}</div>}{limited&&<div className="dvw-message">结果已截断到 2000 条</div>}<div className="dvw-results">{[...groups].map(([path, rows]) => <div key={path}><div className="dvw-result-file"><Icon name="chevron-down"/> {path} <span className="dvw-badge">{rows.length}</span></div>{rows.map((row,index)=><div className="dvw-result" key={`${row.line}:${row.column}:${index}`} onClick={()=>props.onOpen(path,row.line,row.column)}><span className="dvw-line">{row.line}</span><span className="dvw-preview">{row.preview}</span></div>)}</div>)}</div></>
}


export function Launcher({ service }: { service: VscodeWorkbench }) { return <button className="dvw-launch" title="打开 VS Code 工作台" onClick={()=>service.show()}>VS Code 工作台</button> }

export function Workbench({ service, useSessions }: { service: VscodeWorkbench; useSessions: (selector: (state: any) => any) => any }) {
  const [snapshot, setSnapshot] = useState(() => service.getSnapshot()); const [panels, setPanels] = useState(() => service.getPanels())
  const [layout, setLayout] = useState(() => service.getLayout())
  useEffect(() => service.subscribe(() => { setSnapshot(service.getSnapshot()); setPanels(service.getPanels()); setLayout(service.getLayout()) }), [service])
  // 布局偏好存在 service 上（设置面板也要读写同一份），这里给出与旧 useState 同形的局部访问器，
  // 下面各处调用点不必改动。
  const { primarySideVisible, chatVisible, statusVisible, sideWidth, chatWidth } = layout
  const setPrimarySideVisible = (value: boolean) => service.setLayout({ primarySideVisible: value })
  const setChatVisible = (value: boolean | ((current: boolean) => boolean)) => service.setLayout({ chatVisible: typeof value === 'function' ? value(service.getLayout().chatVisible) : value })
  const setStatusVisible = (value: boolean) => service.setLayout({ statusVisible: value })
  const setSideWidth = (value: number) => service.setLayout({ sideWidth: value })
  const setChatWidth = (value: number) => service.setLayout({ chatWidth: value })
  // 同 index.tsx：0.2.0 的 sessions store 无 state.current，改用 retainedBy.mainView 判定当前会话。
  const sessionId = useSessions((state:any)=>state.current??(Object.values(state.byId??{}) as any[]).find((session:any)=>(session.retainedBy?.mainView??0)>0)?.id) as string|undefined; const cwd = useSessions(state=>sessionId===undefined?undefined:state.byId[sessionId]?.cwd) as string|undefined
  const [workspace,setWorkspace]=useState<{cwd:string;name:string}>(); const [tabs,setTabs]=useState<Tab[]>([]); const [active,setActive]=useState<string>(); const [error,setError]=useState<string>(); const [panelHeight,setPanelHeight]=useState(260);const [outlineVisible,setOutlineVisible]=useState(()=>localStorage.getItem('dvw:outline')!=='closed');const [headerHost,setHeaderHost]=useState<HTMLDivElement|null>(null)
  const tabsRef=useRef(tabs);tabsRef.current=tabs
  const workspaceRequests=useRef(new WorkspaceRequestScope());const loadingTabs=useRef(new Set<string>())
  const dshDark = useDshDarkTheme()
  // 不再有手动配色：工作台与内嵌编辑器的深/浅色一律取自 DSH 当前主题。
  const colorScheme: 'dark' | 'light' = dshDark ? 'dark' : 'light'
  useEffect(()=>localStorage.setItem('dvw:outline',outlineVisible?'open':'closed'),[outlineVisible])
  useEffect(()=>localStorage.setItem('dvw:dsh-chat-visible',chatVisible?'open':'closed'),[chatVisible])
  useEffect(()=>localStorage.setItem('dvw:dsh-chat-width',String(Math.round(chatWidth))),[chatWidth])
  useEffect(()=>localStorage.setItem('dvw:primary-side-visible',primarySideVisible?'open':'closed'),[primarySideVisible])
  useEffect(()=>localStorage.setItem('dvw:status-visible',statusVisible?'open':'closed'),[statusVisible])
  useEffect(()=>{if(!snapshot.visible)return;const onKey=(event:KeyboardEvent)=>{if(event.isComposing||!event.ctrlKey||!event.altKey||event.shiftKey||event.code!=='KeyB')return;event.preventDefault();setChatVisible(value=>!value)};window.addEventListener('keydown',onKey,true);return()=>window.removeEventListener('keydown',onKey,true)},[snapshot.visible])
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
  useEffect(()=>{if(!snapshot.visible||sessionId===undefined)return;const epoch=workspaceRequests.current.begin();const cleared=resetWorkspaceDocuments<Tab>();loadingTabs.current.clear();setWorkspace(undefined);setTabs(cleared.tabs);tabsRef.current=cleared.tabs;setActive(cleared.active);setError(cleared.error);const controller=new AbortController();void api<{cwd:string;name:string}>('workspace',{sessionId},controller.signal).then(value=>{if(!workspaceRequests.current.isCurrent(epoch))return;setWorkspace(value);const saved=localStorage.getItem(`dvw:${value.cwd}`);if(saved){try{const parsed=JSON.parse(saved) as {view?:WorkbenchView;paths?:string[];active?:string;panelHeight?:number;sideWidth?:number};if(parsed.view)service.show(parsed.view);if(typeof parsed.panelHeight==='number')setPanelHeight(parsed.panelHeight);if(typeof parsed.sideWidth==='number')setSideWidth(Math.max(210,Math.min(640,Math.round(parsed.sideWidth))));const restored=restoreTabPaths(parsed.paths??[]);setTabs(restored);setActive(restored.some(tab=>tab.path===parsed.active)?parsed.active:restored.at(-1)?.path)}catch{}}}).catch(error=>{if(!controller.signal.aborted&&workspaceRequests.current.isCurrent(epoch))setError(String(error))});return()=>{controller.abort();loadingTabs.current.clear();workspaceRequests.current.invalidate(epoch)}},[snapshot.visible,sessionId])
  useEffect(()=>{if(workspace) localStorage.setItem(`dvw:${workspace.cwd}`,JSON.stringify({view:snapshot.view,paths:tabs.filter(t=>!t.path.startsWith('diff:')).map(t=>t.path),active,panelHeight,sideWidth}))},[workspace,snapshot.view,tabs,active,panelHeight,sideWidth])
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
        try { paths = (JSON.parse(String(event.data)) as { paths?: string[] }).paths ?? [] } catch { /* 忽略格式不对的消息 */ }
        window.dispatchEvent(new CustomEvent('dvw-files-changed', { detail: paths }))
        setTabs(current => current.map(tab => tab.dirty ? { ...tab, external: true } : tab))
      }
    }
    // 宿主地址可能还没到（第一次 API 尚未返回），稍后重试一次。
    if (currentHostBase() === undefined) timer = setTimeout(connect, 1500)
    else connect()
    return () => { closed = true; clearTimeout(timer); ws?.close() }
  }, [snapshot.visible, sessionId])
  useEffect(()=>{if(sessionId===undefined||active===undefined)return;const tab=tabsRef.current.find(row=>row.path===active);if(tab===undefined||tab.loaded!==false||loadingTabs.current.has(active))return;const epoch=workspaceRequests.current.current();loadingTabs.current.add(active);const documentPreview=documentPreviewKind(active);if(documentPreview!==undefined){const documentUrl=`/dsh-vscode/file?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(active)}`;setTabs(rows=>rows.map(row=>row.path===active?{...row,loaded:true,documentPreview,documentUrl}:row));loadingTabs.current.delete(active);return}if(/\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i.test(active)){const imageUrl=`/dsh-vscode/file?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(active)}`;setTabs(rows=>rows.map(row=>row.path===active?{...row,loaded:true,imageUrl}:row));loadingTabs.current.delete(active);return}void api<FileDocument>('fs.read',{sessionId,path:active}).then(doc=>{if(!workspaceRequests.current.isCurrent(epoch))return;if(doc.binary||doc.tooLarge){setTabs(rows=>rows.filter(row=>row.path!==active));setActive(current=>current===active?undefined:current);setError(doc.binary?'二进制文件不能在文本编辑器中打开':`文件超过 5 MiB：${active}`);return}setTabs(rows=>rows.map(row=>row.path===active?{...row,...doc,draft:doc.content,loaded:true}:row))}).catch(error=>{if(workspaceRequests.current.isCurrent(epoch))setError(String(error))}).finally(()=>loadingTabs.current.delete(active))},[active,sessionId,tabs])
  const open=(path:string,line?:number,column?:number,pin?:boolean)=>{if(sessionId!==undefined)openForWorkspace(path,line,column,pin)}
  useEffect(()=>{const listener=(event:Event)=>void open((event as CustomEvent<string>).detail);window.addEventListener('dvw-open-workspace-path',listener);return()=>window.removeEventListener('dvw-open-workspace-path',listener)},[sessionId,tabs])
  const save=async(tab:Tab)=>{if(sessionId===undefined||!tab.dirty)return;try{const doc=await api<FileDocument>('fs.save',{sessionId,path:tab.path,content:tab.draft,revision:tab.revision});setTabs(rows=>rows.map(row=>row.path===tab.path?{...row,...doc,draft:doc.content,dirty:false,external:false}:row))}catch(error){setError(String(error))}}
  const close=(tab:Tab)=>{if(tab.dirty&&!confirm(`${tab.path} 有未保存更改，确定关闭？`))return;setTabs(rows=>rows.filter(row=>row.path!==tab.path));if(active===tab.path)setActive(tabs.filter(row=>row.path!==tab.path).at(-1)?.path)}
  const closeAll=()=>{const dirty=tabs.filter(tab=>tab.dirty);if(dirty.length>0&&!confirm(`有 ${dirty.length} 个文件包含未保存更改，确定全部关闭？`))return;setTabs([]);setActive(undefined)}
  const activeTab=tabs.find(tab=>tab.path===active); const Panel=panels.find(panel=>panel.id===snapshot.bottomPanel)?.component; const terminalAvailable=panels.some(panel=>panel.id==='terminal')
  const selectView=(view:WorkbenchView)=>{if(snapshot.view===view&&primarySideVisible){setPrimarySideVisible(false);return}setPrimarySideVisible(true);service.show(view)}
  const selectHeading=(index:number)=>{if(activeTab===undefined)return;setTabs(rows=>rows.map(tab=>tab.path===activeTab.path?{...tab,preview:true}:tab));window.setTimeout(()=>window.dispatchEvent(new CustomEvent('dvw-markdown-heading',{detail:index})),50)}
  const suppressAttachmentDrop=(event:DragEvent)=>{if(!event.dataTransfer.types.includes('Files'))return;const target=event.target;const insideTree=target instanceof Element&&target.closest('.dvw-tree')!==null;if(!insideTree){event.preventDefault();event.stopPropagation()}}
  if(!snapshot.visible)return null
  if(sessionId===undefined)return <div className="dvw-overlay"><div className="dvw-empty" style={{gridColumn:'1/4'}}><div>请先选择或创建一个 DSH 会话。<br/><button onClick={()=>service.hide()}>返回 DSH</button></div></div></div>
  const markdown=activeTab!==undefined&&!activeTab.path.startsWith('diff:')&&/\.md$/i.test(activeTab.path)
  const diffMarkdown=activeTab?.diff!==undefined&&/\.md$/i.test(activeTab.diffSourcePath??'')
  const markdownPreview=markdown||(diffMarkdown&&activeTab?.preview===true)
  const headings=markdownPreview&&activeTab?markdownHeadings(activeTab.diff?.modified??activeTab.draft):[]
  return <div className="dvw-overlay" data-dvw-chat={chatVisible||undefined} data-dvw-primary-side={primarySideVisible||undefined} data-dvw-status={statusVisible||undefined} style={{'--dvw-side-width':`${sideWidth}px`,'--dvw-chat-width':`${chatWidth}px`} as CSSProperties} role="dialog" aria-label="VS Code 工作台" onDragEnterCapture={suppressAttachmentDrop} onDragOverCapture={suppressAttachmentDrop} onDropCapture={suppressAttachmentDrop}>
    <DshConversationPanel visible={chatVisible} width={chatWidth} statusHeight={statusVisible?24:0}/>
    {chatVisible&&<aside className="dvw-chat"><PanelResizer className="dvw-chat-resizer" label="拖动调整 DSH 对话栏宽度" width={chatWidth} min={400} max={720} defaultWidth={420} direction={-1} onWidth={setChatWidth}/><header className="dvw-chat-head"><span><DshMark/> DSH</span><button className="dvw-icon" title="关闭 DSH 对话栏" onClick={()=>setChatVisible(false)}><Icon name="close"/></button></header><div className="dvw-chat-body"/></aside>}
    <nav className="dvw-activity"><button className="dvw-act" data-active={primarySideVisible&&snapshot.view==='explorer'} title="资源管理器" onClick={()=>selectView('explorer')}><Icon name="files"/></button><button className="dvw-act" data-active={primarySideVisible&&snapshot.view==='search'} title="搜索" onClick={()=>selectView('search')}><Icon name="search"/></button><button className="dvw-act" data-active={primarySideVisible&&snapshot.view==='git'} title="源代码管理" onClick={()=>selectView('git')}><Icon name="source-control"/></button><button className="dvw-act" data-active={snapshot.bottomPanel==='terminal'} disabled={!terminalAvailable} title={terminalAvailable?(snapshot.bottomPanel==='terminal'?'隐藏终端':'显示终端'):'终端适配器未安装'} onClick={()=>toggleTerminal(service)}><Icon name="terminal"/></button><button className="dvw-act dsh" title="返回 DSH" onClick={()=>service.hide()}><Icon name="home"/></button><button className="dvw-act dvw-settings-button" title="在 DSH 设置中管理工作台选项" onClick={()=>service.openDshSettings()}><Icon name="settings"/></button></nav>
    <aside className="dvw-side" data-side-width={sideWidth}>{snapshot.view==='explorer'&&<Explorer sessionId={sessionId} cwd={workspace?.cwd} selected={active} onOpen={(path,pin)=>void open(path,undefined,undefined,pin)}/>} {snapshot.view==='search'&&<Search sessionId={sessionId} onOpen={(path,line,column)=>void open(path,line,column)}/>} {snapshot.view==='git'&&<Git sessionId={sessionId} onDiff={(path,diff,title,diffSourcePath)=>{const key=`diff:${path}`;setTabs(rows=>[...rows.filter(row=>row.path!==key),{path:key,title,content:diff.diff,draft:diff.diff,revision:'',size:diff.diff.length,binary:false,tooLarge:false,dirty:false,pinned:true,diff,diffMode:'inline',diffSourcePath}]);setActive(key)}}/>}</aside>
    <PanelResizer className="dvw-side-resizer" label="拖动调整源码管理侧边栏宽度" width={sideWidth} min={210} max={640} defaultWidth={210} direction={1} onWidth={setSideWidth}/>
    <main className="dvw-main"><div className="dvw-tabs"><div className="dvw-tab-list">{tabs.map(tab=><button className="dvw-tab" data-active={tab.path===active} data-pinned={tab.pinned===true||undefined} key={tab.path} title={tab.diffSourcePath??tab.path} onClick={()=>setActive(tab.path)}><span className="dvw-tab-name">{tab.dirty?'● ':''}{tabLabel(tab)}</span><span onClick={event=>{event.stopPropagation();close(tab)}}><Icon name="close"/></span></button>)}</div><div className="dvw-tab-actions">{tabs.length>0&&<button className="dvw-icon dvw-close-all" title="全部关闭" onClick={closeAll}><Icon name="close-all"/></button>}<button className="dvw-icon dvw-chat-action" data-active={chatVisible||undefined} title={chatVisible?'隐藏 DSH 对话栏 (Ctrl+Alt+B)':'显示 DSH 对话栏 (Ctrl+Alt+B)'} aria-pressed={chatVisible} onClick={()=>setChatVisible(value=>!value)}><Icon name={chatVisible?'layout-sidebar-right':'layout-sidebar-right-off'}/></button></div></div><div className="dvw-editor" data-outline={markdownPreview&&outlineVisible&&headings.length>0}>{error&&<div className="dvw-error"><button className="dvw-icon" onClick={()=>setError(undefined)}><Icon name="close"/></button>{error}</div>}{markdownPreview&&outlineVisible&&headings.length>0&&<MarkdownOutline headings={headings} onClose={()=>setOutlineVisible(false)} onHeading={selectHeading}/>} {markdown&&activeTab&&<div className="dvw-editor-toolbar"><button className="dvw-icon dvw-outline-toggle" data-active={outlineVisible} title={outlineVisible?'关闭 Markdown 大纲':'显示 Markdown 大纲'} onClick={()=>setOutlineVisible(value=>!value)}><Icon name="list-tree"/></button><button className="dvw-mode-button" data-active={!activeTab.preview} onClick={()=>setTabs(rows=>rows.map(tab=>tab.path===activeTab.path?{...tab,preview:false}:tab))}><Icon name="code"/> 源码</button><button className="dvw-mode-button" data-active={activeTab.preview} onClick={()=>setTabs(rows=>rows.map(tab=>tab.path===activeTab.path?{...tab,preview:true}:tab))}><Icon name="preview"/> 预览</button></div>}{activeTab?.diff&&<div className="dvw-editor-toolbar dvw-diff-toolbar">{diffMarkdown&&<div className="dvw-diff-preview-switch"><button className="dvw-mode-button" data-diff-view="diff" data-active={!activeTab.preview} onClick={()=>setTabs(rows=>rows.map(tab=>tab.path===activeTab.path?{...tab,preview:false}:tab))}><Icon name="diff"/> 差异</button><button className="dvw-mode-button" data-diff-view="preview" data-active={activeTab.preview} onClick={()=>setTabs(rows=>rows.map(tab=>tab.path===activeTab.path?{...tab,preview:true}:tab))}><Icon name="preview"/> 预览</button></div>}{!activeTab.preview&&<><button className="dvw-mode-button dvw-diff-mode-button" data-mode="inline" data-active={activeTab.diffMode!=='split'} title="内联视图" onClick={()=>setTabs(rows=>rows.map(tab=>tab.path===activeTab.path?{...tab,diffMode:'inline'}:tab))}><Icon name="diff-single"/> 内联</button><button className="dvw-mode-button dvw-diff-mode-button" data-mode="split" data-active={activeTab.diffMode==='split'} title="并排视图" onClick={()=>setTabs(rows=>rows.map(tab=>tab.path===activeTab.path?{...tab,diffMode:'split'}:tab))}><Icon name="diff-sidebyside"/> 并排</button></>}</div>}<div className="dvw-editor-body" data-toolbar={markdown||activeTab?.diff!==undefined}>{activeTab===undefined?<div className="dvw-empty"><div><strong>DSH Workbench</strong><br/>从资源管理器或搜索结果打开文件</div></div>:activeTab.diff?diffMarkdown&&activeTab.preview?<MarkdownPreview source={activeTab.diff.modified} sessionId={sessionId} path={activeTab.diffSourcePath??''}/>:<MonacoDiffEditor uri={`${workspace?.cwd??''}/${activeTab.path}`} original={activeTab.diff.original} modified={activeTab.diff.modified} mode={activeTab.diffMode??'inline'} theme={colorScheme}/>:activeTab.imageUrl?<div className="dvw-image-preview"><img src={activeTab.imageUrl} alt={activeTab.path}/><span>{activeTab.path}</span></div>:activeTab.documentPreview&&activeTab.documentUrl?<DocumentPreview kind={activeTab.documentPreview} src={activeTab.documentUrl} path={activeTab.path}/>:markdown&&activeTab.preview?<MarkdownPreview source={activeTab.draft} sessionId={sessionId} path={activeTab.path}/>:<MonacoEditor uri={`${workspace?.cwd??''}/${activeTab.path}`} value={activeTab.draft} theme={colorScheme} line={activeTab.line} column={activeTab.column} onChange={draft=>setTabs(rows=>rows.map(tab=>tab.path===activeTab.path?{...tab,draft,dirty:draft!==tab.content}:tab))} onSave={()=>void save(activeTab)}/>}</div></div></main>
    {snapshot.bottomPanel&&<section className="dvw-bottom" style={{height:panelHeight}}><div style={{height:4,cursor:'ns-resize'}} onPointerDown={event=>{const startY=event.clientY,startHeight=panelHeight;const move=(e:PointerEvent)=>setPanelHeight(Math.max(120,Math.min(window.innerHeight-160,startHeight+startY-e.clientY)));const up=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up)};window.addEventListener('pointermove',move);window.addEventListener('pointerup',up)}}/><div className="dvw-bottom-head"><div className="dvw-bottom-headslot" ref={setHeaderHost}/>{snapshot.bottomPanel==='terminal'&&sessionId!==undefined&&<TerminalNewButton sessionId={sessionId}/>}<button className="dvw-icon" style={{marginLeft:'auto'}} onClick={()=>service.toggleBottomPanel(snapshot.bottomPanel!)}><Icon name="close"/></button></div><div className="dvw-bottom-body">{Panel&&cwd&&<Panel sessionId={sessionId} cwd={cwd} visible colorScheme={colorScheme} header={headerHost}/>}</div></section>}
    <footer className="dvw-status"><span><Icon name="git-branch"/> 工作区</span><span>{workspace?.cwd??cwd??''}</span>{activeTab?.external&&<span>磁盘文件已变化</span>}<button className="dvw-icon" style={{color:'white',marginLeft:'auto'}} onClick={()=>service.hide()}>返回 DSH</button></footer>
  </div>
}
