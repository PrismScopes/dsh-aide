import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type { GitBranchList, GitChange, GitCommit, GitCommitFile, GitDiff, GitStatus } from '../types.ts'
import { ApiError, api } from './api.ts'
import { ContextMenu, type MenuEntry } from './ContextMenu.tsx'
import { copyText } from './clipboard.ts'
import { changeMenuItems, commitFileMenuItems, commitMenuItems, groupMenuItems, scmMenuItems, type GitGroup } from './gitMenus.ts'
import { graphSubtitle, refKind, refLabel, shortHash } from './gitGraph.ts'
import { fileIcon, Icon } from './Icon.tsx'
import { useDebouncedCallback } from './hooks.ts'

/**
 * 源代码管理面板：工作区改动分组、提交、以及提交图表（Graph）。
 * 从 Workbench.tsx 拆出，其中 graphRows / graphTrackPath 是纯函数、有单测覆盖，
 * 由 Workbench.tsx 重新导出以保持既有引用不变。
 *
 * 本轮按 VS Code 的源代码管理视图补齐：
 * - 面板标题、三个分组标题都有 `...` 菜单（scmMenuItems / groupMenuItems）；
 * - 分支按钮打开可搜索的分支选择器（替代原来的 window.prompt）；
 * - 提交图支持「全部提交 / 仅当前分支」与分批加载，提交行按 VS Code Git Graph 扩展的方式分类引用、上色。
 */
export interface GraphTrack { hash: string; color: number }
export interface GraphRow { commit: GitCommit; lane: number; before: GraphTrack[]; after: GraphTrack[]; parentLanes: number[] }
export function graphRows(commits: GitCommit[]): GraphRow[] {
  const visible = new Set(commits.map(commit => commit.hash))
  let nextColor = 0
  let lanes: GraphTrack[] = commits[0] ? [{ hash: commits[0].hash, color: nextColor++ }] : []
  return commits.map(commit => {
    let lane = lanes.findIndex(track => track.hash === commit.hash)
    if (lane < 0) { lanes = [{ hash: commit.hash, color: nextColor++ }, ...lanes]; lane = 0 }
    const before = [...lanes]
    const current = before[lane]!
    const after = before.filter(track => track.hash !== commit.hash)
    const parents = commit.parents.filter(parent => visible.has(parent))
    parents.forEach((parent, index) => {
      if (after.some(track => track.hash === parent)) return
      const color = index === 0 ? current.color : nextColor++
      after.splice(Math.min(lane + index, after.length), 0, { hash: parent, color })
    })
    const parentLanes = parents.map(parent => after.findIndex(track => track.hash === parent)).filter(index => index >= 0)
    lanes = after
    return { commit, lane, before, after, parentLanes }
  })
}

const GRAPH_COLORS = ['#4c8dff','#d94f9f','#4fc1b0','#d9a441','#9b7bea']
function graphColor(color:number):string{return GRAPH_COLORS[color%GRAPH_COLORS.length]!}
function graphWidth(row:GraphRow):number{return Math.max(row.before.length,row.after.length,row.lane+1,1)*14+8}

/** Draw a fixed-radius, orthogonal transition between two graph lanes. */
export function graphTrackPath(from: number, to: number, startY: number, endY: number, bendY: number): string {
  if (from === to) return `M ${from} ${startY} V ${endY}`
  const direction = Math.sign(to - from)
  const radius = Math.min(5, Math.abs(to - from) / 2, Math.abs(bendY - startY), Math.abs(endY - bendY))
  return `M ${from} ${startY} V ${bendY - radius} Q ${from} ${bendY} ${from + direction * radius} ${bendY} H ${to - direction * radius} Q ${to} ${bendY} ${to} ${bendY + radius} V ${endY}`
}

function GraphTracksBase({row}:{row:GraphRow}) {
  const width=graphWidth(row);const x=row.lane*14+8;const current=row.before[row.lane]!
  return <svg className="dvw-graph-svg" width={width} height="38" viewBox={`0 0 ${width} 38`} aria-hidden="true">
    {row.before.map((track,lane)=>{if(track.hash===row.commit.hash)return null;const target=row.after.findIndex(next=>next.hash===track.hash);const nextLane=target>=0?target:lane;return <path key={`continue-${track.hash}`} d={graphTrackPath(lane*14+8,nextLane*14+8,0,38,19)} fill="none" stroke={graphColor(track.color)} strokeWidth="2" vectorEffect="non-scaling-stroke"/>})}
    <path d={`M ${x} 0 V 19`} fill="none" stroke={graphColor(current.color)} strokeWidth="2" vectorEffect="non-scaling-stroke"/>
    {row.parentLanes.map((parent,index)=>{const target=parent*14+8;const track=row.after[parent]!;return <path key={`parent-${track.hash}-${index}`} d={graphTrackPath(x,target,19,38,29)} fill="none" stroke={graphColor(track.color)} strokeWidth="2" vectorEffect="non-scaling-stroke"/>})}
    <circle cx={x} cy="19" r="5" fill="var(--dvw-surface-1)" stroke={graphColor(current.color)} strokeWidth="2" vectorEffect="non-scaling-stroke"/>
  </svg>
}
/** 行级 SVG 只在 row 变化时重画：展开/收起某个提交时其余 99 行不用重算路径。 */
const GraphTracks = memo(GraphTracksBase)

function GraphContinuationBase({row}:{row:GraphRow}) {
  const width=graphWidth(row)
  return <svg className="dvw-graph-continuation" width={width} height="100%" viewBox={`0 0 ${width} 100`} preserveAspectRatio="none" aria-hidden="true">{row.after.map((track,lane)=><line key={track.hash} x1={lane*14+8} y1="0" x2={lane*14+8} y2="100" stroke={graphColor(track.color)} strokeWidth="2" vectorEffect="non-scaling-stroke"/>)}</svg>
}
const GraphContinuation = memo(GraphContinuationBase)

/**
 * 提交图表。
 *
 * onMenu / onFileMenu 都是可选的：右键菜单点开后「做什么」属于面板层（Git）的事，这里只上报
 * 指针位置和命中的提交/文件，组件本身仍然只是画图 + 派发点击，Workbench 的重新导出也不受影响。
 */
export const CommitGraph = memo(function CommitGraph({ commits, expanded, files, remotes, onToggle, onOpenFile, onMenu, onFileMenu }: { commits: GitCommit[]; expanded?: string; files: Map<string,GitCommitFile[]>; remotes?: readonly string[]; onToggle(commit:GitCommit):void; onOpenFile(commit:GitCommit,file:GitCommitFile):void; onMenu?(commit:GitCommit,position:{x:number;y:number}):void; onFileMenu?(commit:GitCommit,file:GitCommitFile,position:{x:number;y:number}):void }) {
  // graphRows 是 O(提交数×泳道数) 的纯计算（实测 100 提交 90µs、1000 提交 1.39ms）：只在 commits 变化时重算，
  // 不跟着面板自身的重渲染（右键菜单开合、busy 翻转、提交内文件展开）白跑一遍。
  const rows = useMemo(() => graphRows(commits), [commits])
  return <div className="dvw-graph-list">{rows.map(row => {
    const opened=expanded===row.commit.hash
    const head=row.commit.refs.some(ref=>refKind(ref,remotes)==='head')
    return <div className="dvw-graph-entry" data-expanded={opened} key={row.commit.hash}>
      <button className="dvw-graph-row" data-head={head||undefined} aria-expanded={opened} onContextMenu={onMenu===undefined?undefined:event=>{event.preventDefault();event.stopPropagation();onMenu(row.commit,{x:event.clientX,y:event.clientY})}} onClick={()=>onToggle(row.commit)} title={`${row.commit.hash}\n${row.commit.author}`}><GraphTracks row={row}/><span className="dvw-graph-copy"><span className="dvw-graph-subject">{row.commit.subject}</span><span className="dvw-graph-meta">{graphSubtitle(row.commit)} · {new Date(row.commit.date).toLocaleDateString()}</span></span>{row.commit.refs.slice(0,3).map(ref=><span className="dvw-ref" data-kind={refKind(ref,remotes)} key={ref}>{refLabel(ref)}</span>)}<Icon name={opened?'chevron-down':'chevron-right'}/></button>
      {opened&&<div className="dvw-commit-files" style={{paddingLeft:graphWidth(row)+7}}><GraphContinuation row={row}/><div className="dvw-commit-file-list">{(files.get(row.commit.hash)??[]).map(file=><button className="dvw-commit-file" key={`${file.status}:${file.path}`} onContextMenu={onFileMenu===undefined?undefined:event=>{event.preventDefault();event.stopPropagation();onFileMenu(row.commit,file,{x:event.clientX,y:event.clientY})}} onClick={()=>onOpenFile(row.commit,file)}><Icon name={fileIcon(file.path)} className="dvw-file-icon"/><span className="dvw-commit-file-name">{file.path.split('/').at(-1)}</span><span className="dvw-commit-file-dir">{file.path.split('/').slice(0,-1).join('/')}</span><span className="dvw-badge">{file.status}</span></button>)}</div></div>}
    </div>
  })}</div>
})

function GitGroupHeader({ title, count, expanded, onToggle, onMenu, children }: { title: string; count: number; expanded: boolean; onToggle(): void; onMenu(event: { clientX: number; clientY: number }): void; children?: ReactNode }) {
  return <div className="dvw-group-head"><button className="dvw-group-toggle" aria-expanded={expanded} onClick={onToggle}><Icon name={expanded?'chevron-down':'chevron-right'}/><span>{title}</span><span className="dvw-count">{count}</span></button><div className="dvw-group-actions">{children}<button className="dvw-icon" title="更多操作" aria-label={`${title}的更多操作`} aria-haspopup="menu" onClick={event=>onMenu(event)}><Icon name="ellipsis"/></button></div></div>
}

/**
 * 面板里右键/`...` 菜单的状态：只记「指针落在哪一行」，菜单内容由 gitMenus.ts 现算。
 * 用可辨识联合而不是宽松对象，各种行各自需要的上下文才带得全。
 */
type GitMenuState =
  | { kind: 'change'; x: number; y: number; change: GitChange; group: 'staged' | 'worktree' }
  | { kind: 'commit'; x: number; y: number; commit: GitCommit }
  | { kind: 'commit-file'; x: number; y: number; commit: GitCommit; file: GitCommitFile }
  | { kind: 'scm'; x: number; y: number }
  | { kind: 'group'; y: number; x: number; group: GitGroup }

/** 分支选择器的模式：切换 / 新建（可基于某次提交）/ 删除。 */
interface BranchPickerState { mode: 'switch' | 'create' | 'delete'; base?: string }

const PICKER_TITLES: Record<BranchPickerState['mode'], string> = { switch: '检出到…', create: '新建分支…', delete: '删除分支…' }

/**
 * 分支选择器（VS Code 的 quick pick 样式：顶部居中、可输入过滤）。
 *
 * 打开前由面板先取回 `branch.list`，所以这里只负责渲染与键盘；真正的切换/新建/删除仍走面板的 action()，
 * 不在这里发请求 —— 动作失败时错误展示在面板顶部，和右键菜单里那些操作是同一条路径。
 */
function BranchPicker(props: { mode: BranchPickerState['mode']; base?: string; branches: GitBranchList; onClose(): void; onPick(name: string): void; onCreate(name: string): void }) {
  const { mode, branches } = props
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)
  const names = useMemo(() => mode === 'delete'
    ? branches.local.filter(name => name !== branches.current)
    : [...branches.local, ...branches.remote], [mode, branches])
  const options = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return (needle === '' ? names : names.filter(name => name.toLowerCase().includes(needle))).slice(0, 200)
  }, [names, filter])
  useEffect(() => setActive(0), [filter])
  const choose = (name: string) => { if (mode === 'create') props.onCreate(name); else props.onPick(name) }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); props.onClose(); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(value => event.key === 'ArrowDown' ? Math.min(value + 1, Math.max(0, options.length - 1)) : Math.max(value - 1, 0))
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (mode === 'create') { const name = filter.trim(); if (name !== '') props.onCreate(name); return }
    const name = options[active]
    if (name !== undefined) props.onPick(name)
  }
  return <div className="dvw-quickpick-backdrop" onMouseDown={props.onClose}>
    <div className="dvw-quickpick" role="dialog" aria-label={PICKER_TITLES[mode]} onMouseDown={event => event.stopPropagation()}>
      <div className="dvw-quickpick-head">{PICKER_TITLES[mode]}{props.base === undefined ? '' : `（基于 ${shortHash(props.base)}）`}</div>
      <input className="dvw-input" autoFocus value={filter} aria-label={PICKER_TITLES[mode]} placeholder={mode === 'create' ? '新分支名称' : mode === 'delete' ? '筛选要删除的分支' : '搜索分支'} onChange={event => setFilter(event.target.value)} onKeyDown={onKeyDown}/>
      {mode === 'create' && filter.trim() !== '' && <button className="dvw-quickpick-item dvw-quickpick-create" onClick={() => props.onCreate(filter.trim())}><Icon name="add"/><span>创建分支 “{filter.trim()}”</span></button>}
      <div className="dvw-quickpick-list">
        {options.map((name, index) => <button className="dvw-quickpick-item" key={name} data-active={index === active || undefined} onMouseDown={event => event.preventDefault()} onClick={() => choose(name)}>
          {name === branches.current ? <Icon name="check"/> : <span className="dvw-quickpick-blank" aria-hidden="true"/>}
          <span className="dvw-quickpick-name">{name}</span>
          {branches.remote.includes(name) && <span className="dvw-quickpick-meta">远程</span>}
        </button>)}
        {options.length === 0 && <div className="dvw-quickpick-empty">{mode === 'create' ? '直接输入名称后回车创建' : '没有匹配的分支'}</div>}
      </div>
    </div>
  </div>
}

/**
 * 提交信息输入框 + 提交按钮。
 *
 * 单独成组件是为了把「输入中」的局部状态关在这里：原来 message 是 Git 面板的 state，敲一个字符就重渲染
 * 整个面板（100 行提交图的 SVG + 全部改动行）。现在键入只重渲染这一个 div。
 * 清空输入框的时机与原实现一致：action() 内部 catch 掉错误、永不 reject，所以等价于提交返回后清空。
 */
function CommitBox({ busy, branch, onCommit }: { busy: boolean; branch: string; onCommit(message: string): Promise<unknown> }) {
  const [message, setMessage] = useState('')
  const submit = () => {
    if (message.trim() === '') return
    void onCommit(message).then(() => setMessage(''))
  }
  return <div className="dvw-commit"><input className="dvw-input" value={message} onChange={event => setMessage(event.target.value)} onKeyDown={event => { if (event.ctrlKey && event.key === 'Enter') submit() }} placeholder={`消息 (Ctrl+Enter 在“${branch}”提交)`}/><button className="dvw-commit-button" disabled={busy || !message.trim()} onClick={submit}><Icon name="check"/> 提交</button></div>
}

/** 提交之后需要重取提交图/分支信息的动作：不重取的话新状态要等下一次文件变更事件。 */
const RELOG_ACTIONS = new Set(['commit', 'branch.switch', 'branch.create', 'branch.delete', 'commit.checkout', 'commit.branch', 'commit.cherrypick', 'commit.revert', 'pull', 'push', 'sync', 'fetch'])
/** 远程动作：成功后给一条短提示，避免「点了没反应」的错觉（失败会走错误条）。 */
const REMOTE_NOTICES: Record<string, string> = { fetch: '已获取远程更新', pull: '已拉取', push: '已推送', sync: '已同步' }

export function Git(props: { sessionId: string; /** 工作区绝对根（Workbench 传 workspace.cwd）；拿不到时「复制绝对路径」禁用。 */ absoluteRoot?: string; onDiff(key:string, diff:GitDiff, title?:string, sourcePath?:string): void }) {
  const [status, setStatus] = useState<GitStatus>(); const [commits,setCommits]=useState<GitCommit[]>([]); const [error, setError] = useState<string>(); const [busy,setBusy]=useState(false); const [expanded,setExpanded]=useState({staged:true,changes:true,graph:true});const [expandedCommit,setExpandedCommit]=useState<string>();const [commitFileMap,setCommitFileMap]=useState<Map<string,GitCommitFile[]>>(new Map())
  const [menu,setMenu]=useState<GitMenuState>()
  // 分支选择器与远程列表：远程列表只在面板挂载时取一次（每次刷新都跑 `git remote` 会多一个进程）。
  const [remotes,setRemotes]=useState<string[]>([]); const [branches,setBranches]=useState<GitBranchList>(); const [picker,setPicker]=useState<BranchPickerState>()
  // 提交图范围：默认只画当前分支的 100 条，`...` 菜单里可以切到全部分支、分批加载。
  const [allCommits,setAllCommits]=useState(false); const [logLimit,setLogLimit]=useState(100)
  const [notice,setNotice]=useState<string>()
  const loadLog = useCallback(() => api<GitCommit[]>('git.action',{sessionId:props.sessionId,action:allCommits?'log.all':'log',value:String(logLimit)}), [props.sessionId,allCommits,logLimit])
  const refresh = useCallback(() => { void Promise.all([api<GitStatus>('git.status',{sessionId:props.sessionId}),loadLog()]).then(([nextStatus,nextCommits])=>{setStatus(nextStatus);setCommits(nextCommits);setError(undefined)}).catch(error=>{setStatus(undefined);setCommits([]);setError(error instanceof ApiError&&error.code==='not-repository'?undefined:String(error))}) }, [props.sessionId, loadLog])
  /** 只刷新提交图（`git.action=log`）。 */
  const refreshLog = useCallback(() => { void loadLog().then(next=>{setCommits(next);setNotice(undefined)}).catch(error=>setError(String(error))) }, [loadLog])
  /** 出错后静默重取状态：例如 pull 冲突时命令返回非零，但工作区已经变了，界面必须跟着更新（不清掉错误提示）。 */
  const refreshQuiet = useCallback(() => { void api<GitStatus>('git.status',{sessionId:props.sessionId}).then(setStatus).catch(()=>undefined); void loadLog().then(setCommits).catch(()=>undefined) }, [props.sessionId,loadLog])
  const refreshDebounced = useDebouncedCallback(refresh, 500)
  useEffect(refresh,[refresh]); useEffect(()=>{const fn=()=>refreshDebounced();window.addEventListener('dvw-files-changed',fn);return()=>window.removeEventListener('dvw-files-changed',fn)},[refreshDebounced])
  useEffect(() => { void api<string[]>('git.action',{sessionId:props.sessionId,action:'remotes'}).then(names=>setRemotes(names)).catch(()=>setRemotes([])) }, [props.sessionId])
  const action = async (name: string, path?: string, value?: string) => { setBusy(true);setNotice(undefined);try { const result = await api<GitStatus | GitDiff>('git.action',{sessionId:props.sessionId,action:name,path,value}); if(name==='diff'&&'diff'in result){const key=path??'';props.onDiff(key,result,key.split('/').at(-1)??key,key)} else {setStatus(result as GitStatus);if(RELOG_ACTIONS.has(name))refreshLog();if(REMOTE_NOTICES[name]!==undefined)setNotice(REMOTE_NOTICES[name])} } catch(error){setError(String(error));refreshQuiet()}finally{setBusy(false)} }
  /** 打开分支选择器：先把分支清单取回来，再显示 quick pick。 */
  const openPicker = async (mode: BranchPickerState['mode'], base?: string) => { setBusy(true);try { const list = await api<GitBranchList>('git.action',{sessionId:props.sessionId,action:'branch.list'});setBranches(list);setPicker({mode,base}) } catch(error){setError(String(error))} finally { setBusy(false) } }
  const pickBranch = (name: string) => { const mode = picker?.mode; setPicker(undefined); if (mode === 'delete') { if (confirm(`删除分支 ${name}？未合并的分支会被 git 拒绝。`)) void action('branch.delete', undefined, name); return } void action('branch.switch', undefined, name) }
  const createBranch = (name: string) => { const base = picker?.base; setPicker(undefined); if (base === undefined) void action('branch.create', undefined, name); else void action('commit.branch', name, base) }
  // 两个被提交图用到的动作都要有稳定标识，否则 memo(CommitGraph) 等于没做：
  // 依赖写全（expandedCommit / commitFileMap 都是它真正读到的状态），不会读到过期闭包。
  // onDiff 用 ref 持有：它是 Workbench 每次渲染新建的箭头函数，放进依赖会让本面板每次跟着重渲染，
  // 提交图的 memo 随之失效（读的永远是当次渲染的最新值，语义不变）。
  const onDiffRef=useRef(props.onDiff);onDiffRef.current=props.onDiff
  const toggleCommit=useCallback(async(commit:GitCommit)=>{if(expandedCommit===commit.hash){setExpandedCommit(undefined);return}setExpandedCommit(commit.hash);if(commitFileMap.has(commit.hash))return;setBusy(true);try{const files=await api<GitCommitFile[]>('git.action',{sessionId:props.sessionId,action:'commit.files',value:commit.hash});setCommitFileMap(current=>new Map(current).set(commit.hash,files))}catch(error){setError(String(error))}finally{setBusy(false)}},[expandedCommit,commitFileMap,props.sessionId])
  const openCommitFile=useCallback(async(commit:GitCommit,file:GitCommitFile)=>{setBusy(true);try{const result=await api<GitDiff>('git.action',{sessionId:props.sessionId,action:'commit.file.diff',path:file.path,value:commit.hash});onDiffRef.current(`commit:${commit.hash}:${file.path}`,result,file.path.split('/').at(-1)??file.path,file.path)}catch(error){setError(String(error))}finally{setBusy(false)}},[props.sessionId])
  // 提交图的回调：setMenu 的函数式更新不需要任何依赖，onToggle/onOpenFile 只是包一层 void。
  const graphOnToggle=useCallback((commit:GitCommit)=>{void toggleCommit(commit)},[toggleCommit])
  const graphOnOpenFile=useCallback((commit:GitCommit,file:GitCommitFile)=>{void openCommitFile(commit,file)},[openCommitFile])
  const graphOnMenu=useCallback((commit:GitCommit,position:{x:number;y:number})=>setMenu({kind:'commit',x:position.x,y:position.y,commit}),[])
  const graphOnFileMenu=useCallback((commit:GitCommit,file:GitCommitFile,position:{x:number;y:number})=>setMenu({kind:'commit-file',x:position.x,y:position.y,commit,file}),[])
  const staged=status?.changes.filter(change=>change.index!=='.'&&change.index!=='?')??[]
  const changed=status?.changes.filter(change=>change.worktree!=='.'||change.untracked)??[]
  const confirmDiscardAll = () => { if (confirm('放弃所有已跟踪和未跟踪的更改？此操作无法撤销。')) void action('discard.all') }
  const groupActions = {
    stageAll: () => void action('stage.all'), unstageAll: () => void action('unstage.all'), discardAll: confirmDiscardAll,
    refreshGraph: () => void refreshLog(), toggleAllCommits: () => setAllCommits(value => !value),
    loadMore: () => setLogLimit(value => Math.min(1000, value + 100)), collapseCommit: () => setExpandedCommit(undefined),
  }
  // 菜单内容由 gitMenus.ts 的纯函数生成，这里只把「点了做什么」接到面板已有动作上：
  // 复制走 clipboard.copyText，其余复用 action / toggleCommit / openCommitFile，避免出现第二套行为。
  const menuEntries = (): MenuEntry[] => {
    if (menu === undefined) return []
    if (menu.kind === 'scm') {
      return scmMenuItems({ busy, remote: remotes.length > 0, stagedCount: staged.length, changeCount: changed.length, actions: {
        refresh: () => void refresh(),
        fetch: () => void action('fetch'), pull: () => void action('pull'), push: () => void action('push'), sync: () => void action('sync'),
        stageAll: () => void action('stage.all'), unstageAll: () => void action('unstage.all'), discardAll: confirmDiscardAll,
        checkout: () => void openPicker('switch'), createBranch: () => void openPicker('create'), deleteBranch: () => void openPicker('delete'),
      } })
    }
    if (menu.kind === 'group') {
      const count = menu.group === 'staged' ? staged.length : menu.group === 'changes' ? changed.length : commits.length
      return groupMenuItems({ group: menu.group, busy, count, allCommits, canLoadMore: logLimit < 1000, expandedCommit: expandedCommit !== undefined, actions: groupActions })
    }
    if (menu.kind === 'change') {
      const { change, group } = menu
      const value = change.untracked ? 'untracked' : undefined
      return changeMenuItems({ path: change.path, group, untracked: change.untracked, absoluteRoot: props.absoluteRoot, actions: {
        open: () => void action('diff', change.path, change.untracked ? 'untracked' : group),
        stage: () => void action('stage', change.path, value),
        unstage: () => void action('unstage', change.path, value),
        // 与行内按钮一致：放弃不可撤销，保留 confirm 二次确认。
        discard: () => { if (confirm(`放弃 ${change.path} 的更改？此操作无法撤销。`)) void action('discard', change.path, value) },
        copyPath: absolute => void copyText(absolute && props.absoluteRoot !== undefined ? `${props.absoluteRoot}/${change.path}` : change.path),
      } })
    }
    if (menu.kind === 'commit') {
      const commit = menu.commit
      return commitMenuItems({ commit, expanded: expandedCommit === commit.hash, actions: {
        copyHash: () => void copyText(commit.hash),
        toggleFiles: () => void toggleCommit(commit),
        copyMessage: () => void copyText(commit.subject),
        checkout: () => void action('commit.checkout', undefined, commit.hash),
        createBranch: () => void openPicker('create', commit.hash),
        cherryPick: () => void action('commit.cherrypick', undefined, commit.hash),
        revert: () => { if (confirm(`还原提交 ${shortHash(commit.hash)}？这会新增一个反向提交。`)) void action('commit.revert', undefined, commit.hash) },
      } })
    }
    const { commit, file } = menu
    return commitFileMenuItems({ path: file.path, actions: {
      openDiff: () => void openCommitFile(commit, file),
      copyPath: () => void copyText(file.path),
    } })
  }
  const menuLabel = menu===undefined?'':menu.kind==='change'?'更改操作':menu.kind==='commit'?'提交操作':menu.kind==='commit-file'?'提交文件操作':menu.kind==='scm'?'源代码管理操作':'分组操作'
  const renderChange=(change:GitStatus['changes'][number],group:'staged'|'worktree')=><div className="dvw-change" key={`${group}:${change.path}`} onClick={()=>void action('diff',change.path,change.untracked?'untracked':group)} onContextMenu={event=>{event.preventDefault();event.stopPropagation();setMenu({kind:'change',x:event.clientX,y:event.clientY,change,group})}}><Icon name={change.untracked?'new-file':'diff'} className="dvw-file-icon"/><span className="dvw-change-path">{change.path}</span><span className="dvw-badge">{change.untracked?'U':group==='staged'?change.index:change.worktree}</span><button className="dvw-icon" title={group==='staged'?'取消暂存':'暂存更改'} onClick={event=>{event.stopPropagation();void action(group==='staged'?'unstage':'stage',change.path)}}><Icon name={group==='staged'?'remove':'add'}/></button>{group==='worktree'&&<button className="dvw-icon" title="放弃更改" onClick={event=>{event.stopPropagation();if(confirm(`放弃 ${change.path} 的更改？此操作无法撤销。`))void action('discard',change.path,change.untracked?'untracked':undefined)}}><Icon name="discard"/></button>}</div>
  return <><div className="dvw-side-head">源代码管理<div className="dvw-toolbar"><button className="dvw-icon" title="刷新" aria-label="刷新" disabled={busy} onClick={refresh}><Icon name="refresh"/></button><button className="dvw-icon" title="更多操作" aria-label="更多操作" aria-haspopup="menu" onClick={event=>setMenu({kind:'scm',x:event.clientX,y:event.clientY})}><Icon name="ellipsis"/></button></div></div>{error&&<div className="dvw-error">{error}</div>}{notice!==undefined&&<div className="dvw-git-notice" role="status">{notice}</div>}{status&&<><div className="dvw-git-head"><button className="dvw-branch" title="检出到…" onClick={()=>void openPicker('switch')}><Icon name="git-branch"/> {status.branch}</button><span>↑{status.ahead} ↓{status.behind}</span></div><CommitBox busy={busy} branch={status.branch} onCommit={message=>action('commit',undefined,message)}/><div className="dvw-git">{staged.length>0&&<section><GitGroupHeader title="暂存的更改" count={staged.length} expanded={expanded.staged} onToggle={()=>setExpanded(value=>({...value,staged:!value.staged}))} onMenu={event=>setMenu({kind:'group',group:'staged',x:event.clientX,y:event.clientY})}><button className="dvw-icon" title="取消暂存所有更改" onClick={()=>void action('unstage.all')}><Icon name="remove"/></button></GitGroupHeader>{expanded.staged&&staged.map(change=>renderChange(change,'staged'))}</section>}<section><GitGroupHeader title="更改" count={changed.length} expanded={expanded.changes} onToggle={()=>setExpanded(value=>({...value,changes:!value.changes}))} onMenu={event=>setMenu({kind:'group',group:'changes',x:event.clientX,y:event.clientY})}><button className="dvw-icon" title="放弃所有更改" onClick={confirmDiscardAll}><Icon name="discard"/></button><button className="dvw-icon" title="暂存所有更改" onClick={()=>void action('stage.all')}><Icon name="add"/></button></GitGroupHeader>{expanded.changes&&changed.map(change=>renderChange(change,'worktree'))}</section><section className="dvw-graph"><GitGroupHeader title="图表" count={commits.length} expanded={expanded.graph} onToggle={()=>setExpanded(value=>({...value,graph:!value.graph}))} onMenu={event=>setMenu({kind:'group',group:'graph',x:event.clientX,y:event.clientY})}><button className="dvw-icon" title="刷新提交图表" onClick={refreshLog}><Icon name="refresh"/></button></GitGroupHeader>{expanded.graph&&(commits.length===0?<div className="dvw-graph-empty">还没有提交</div>:<CommitGraph commits={commits} expanded={expandedCommit} files={commitFileMap} remotes={remotes} onToggle={graphOnToggle} onOpenFile={graphOnOpenFile} onMenu={graphOnMenu} onFileMenu={graphOnFileMenu}/>)}</section></div></>}{menu!==undefined&&<ContextMenu position={{x:menu.x,y:menu.y}} label={menuLabel} entries={menuEntries()} onClose={()=>setMenu(undefined)}/>}{picker!==undefined&&branches!==undefined&&<BranchPicker mode={picker.mode} base={picker.base} branches={branches} onClose={()=>setPicker(undefined)} onPick={pickBranch} onCreate={createBranch}/>}</>
}
