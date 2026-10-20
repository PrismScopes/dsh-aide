import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { GitChange, GitCommit, GitCommitFile, GitDiff, GitStatus } from '../types.ts'
import { ApiError, api } from './api.ts'
import { ContextMenu, type MenuEntry } from './ContextMenu.tsx'
import { copyText } from './clipboard.ts'
import { changeMenuItems, commitFileMenuItems, commitMenuItems } from './gitMenus.ts'
import { fileIcon, Icon } from './Icon.tsx'
import { useDebouncedCallback } from './hooks.ts'

/**
 * 源代码管理面板：工作区改动分组、提交、以及提交图表（Graph）。
 * 从 Workbench.tsx 拆出，其中 graphRows / graphTrackPath 是纯函数、有单测覆盖，
 * 由 Workbench.tsx 重新导出以保持既有引用不变。
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

function GraphTracks({row}:{row:GraphRow}) {
  const width=graphWidth(row);const x=row.lane*14+8;const current=row.before[row.lane]!
  return <svg className="dvw-graph-svg" width={width} height="38" viewBox={`0 0 ${width} 38`} aria-hidden="true">
    {row.before.map((track,lane)=>{if(track.hash===row.commit.hash)return null;const target=row.after.findIndex(next=>next.hash===track.hash);const nextLane=target>=0?target:lane;return <path key={`continue-${track.hash}`} d={graphTrackPath(lane*14+8,nextLane*14+8,0,38,19)} fill="none" stroke={graphColor(track.color)} strokeWidth="2" vectorEffect="non-scaling-stroke"/>})}
    <path d={`M ${x} 0 V 19`} fill="none" stroke={graphColor(current.color)} strokeWidth="2" vectorEffect="non-scaling-stroke"/>
    {row.parentLanes.map((parent,index)=>{const target=parent*14+8;const track=row.after[parent]!;return <path key={`parent-${track.hash}-${index}`} d={graphTrackPath(x,target,19,38,29)} fill="none" stroke={graphColor(track.color)} strokeWidth="2" vectorEffect="non-scaling-stroke"/>})}
    <circle cx={x} cy="19" r="5" fill="var(--dvw-surface-1)" stroke={graphColor(current.color)} strokeWidth="2" vectorEffect="non-scaling-stroke"/>
  </svg>
}

function GraphContinuation({row}:{row:GraphRow}) {
  const width=graphWidth(row)
  return <svg className="dvw-graph-continuation" width={width} height="100%" viewBox={`0 0 ${width} 100`} preserveAspectRatio="none" aria-hidden="true">{row.after.map((track,lane)=><line key={track.hash} x1={lane*14+8} y1="0" x2={lane*14+8} y2="100" stroke={graphColor(track.color)} strokeWidth="2" vectorEffect="non-scaling-stroke"/>)}</svg>
}

/**
 * 提交图表。
 *
 * onMenu / onFileMenu 都是可选的：右键菜单点开后「做什么」属于面板层（Git）的事，这里只上报
 * 指针位置和命中的提交/文件，组件本身仍然只是画图 + 派发点击，Workbench 的重新导出也不受影响。
 */
export function CommitGraph({ commits, expanded, files, onToggle, onOpenFile, onMenu, onFileMenu }: { commits: GitCommit[]; expanded?: string; files: Map<string,GitCommitFile[]>; onToggle(commit:GitCommit):void; onOpenFile(commit:GitCommit,file:GitCommitFile):void; onMenu?(commit:GitCommit,position:{x:number;y:number}):void; onFileMenu?(commit:GitCommit,file:GitCommitFile,position:{x:number;y:number}):void }) {
  return <div className="dvw-graph-list">{graphRows(commits).map(row => {
    const opened=expanded===row.commit.hash
    return <div className="dvw-graph-entry" data-expanded={opened} key={row.commit.hash}>
      <button className="dvw-graph-row" aria-expanded={opened} onContextMenu={onMenu===undefined?undefined:event=>{event.preventDefault();event.stopPropagation();onMenu(row.commit,{x:event.clientX,y:event.clientY})}} onClick={()=>onToggle(row.commit)} title={`${row.commit.hash}\n${row.commit.author}`}><GraphTracks row={row}/><span className="dvw-graph-copy"><span className="dvw-graph-subject">{row.commit.subject}</span><span className="dvw-graph-meta">{row.commit.author} · {new Date(row.commit.date).toLocaleDateString()}</span></span>{row.commit.refs.slice(0,2).map(ref=><span className="dvw-ref" key={ref}>{ref}</span>)}<Icon name={opened?'chevron-down':'chevron-right'}/></button>
      {opened&&<div className="dvw-commit-files" style={{paddingLeft:graphWidth(row)+7}}><GraphContinuation row={row}/><div className="dvw-commit-file-list">{(files.get(row.commit.hash)??[]).map(file=><button className="dvw-commit-file" key={`${file.status}:${file.path}`} onContextMenu={onFileMenu===undefined?undefined:event=>{event.preventDefault();event.stopPropagation();onFileMenu(row.commit,file,{x:event.clientX,y:event.clientY})}} onClick={()=>onOpenFile(row.commit,file)}><Icon name={fileIcon(file.path)} className="dvw-file-icon"/><span className="dvw-commit-file-name">{file.path.split('/').at(-1)}</span><span className="dvw-commit-file-dir">{file.path.split('/').slice(0,-1).join('/')}</span><span className="dvw-badge">{file.status}</span></button>)}</div></div>}
    </div>
  })}</div>
}

function GitGroupHeader({ title, count, expanded, onToggle, children }: { title: string; count: number; expanded: boolean; onToggle(): void; children?: ReactNode }) {
  return <div className="dvw-group-head"><button className="dvw-group-toggle" aria-expanded={expanded} onClick={onToggle}><Icon name={expanded?'chevron-down':'chevron-right'}/><span>{title}</span><span className="dvw-count">{count}</span></button>{children}</div>
}

/**
 * 面板里右键菜单的状态：只记「指针落在哪一行」，菜单内容由 gitMenus.ts 现算。
 * 用可辨识联合而不是宽松对象，三种行各自需要的上下文（改动项 / 提交 / 提交内文件）才带得全。
 */
type GitMenuState =
  | { kind: 'change'; x: number; y: number; change: GitChange; group: 'staged' | 'worktree' }
  | { kind: 'commit'; x: number; y: number; commit: GitCommit }
  | { kind: 'commit-file'; x: number; y: number; commit: GitCommit; file: GitCommitFile }

export function Git(props: { sessionId: string; /** 工作区绝对根（Workbench 传 workspace.cwd）；拿不到时「复制绝对路径」禁用。 */ absoluteRoot?: string; onDiff(key:string, diff:GitDiff, title?:string, sourcePath?:string): void }) {
  const [status, setStatus] = useState<GitStatus>(); const [commits,setCommits]=useState<GitCommit[]>([]); const [message, setMessage] = useState(''); const [error, setError] = useState<string>(); const [busy,setBusy]=useState(false); const [expanded,setExpanded]=useState({staged:true,changes:true,graph:true});const [expandedCommit,setExpandedCommit]=useState<string>();const [commitFileMap,setCommitFileMap]=useState<Map<string,GitCommitFile[]>>(new Map())
  const [menu,setMenu]=useState<GitMenuState>()
  const refresh = useCallback(() => { void Promise.all([api<GitStatus>('git.status',{sessionId:props.sessionId}),api<GitCommit[]>('git.action',{sessionId:props.sessionId,action:'log'})]).then(([nextStatus,nextCommits])=>{setStatus(nextStatus);setCommits(nextCommits);setError(undefined)}).catch(error=>{setStatus(undefined);setCommits([]);setError(error instanceof ApiError&&error.code==='not-repository'?undefined:String(error))}) }, [props.sessionId])
  const refreshDebounced = useDebouncedCallback(refresh, 500)
  useEffect(refresh,[refresh]); useEffect(()=>{const fn=()=>refreshDebounced();window.addEventListener('dvw-files-changed',fn);return()=>window.removeEventListener('dvw-files-changed',fn)},[refreshDebounced])
  const action = async (name: string, path?: string, value?: string) => { setBusy(true);try { const result = await api<GitStatus | GitDiff>('git.action',{sessionId:props.sessionId,action:name,path,value}); if(name==='diff'&&'diff'in result){const key=path??'';props.onDiff(key,result,key.split('/').at(-1)??key,key)} else {setStatus(result as GitStatus);if(name==='commit')refresh()} } catch(error){setError(String(error))}finally{setBusy(false)} }
  const branch = async () => { const branches=await api<string[]>('git.action',{sessionId:props.sessionId,action:'branches'}); const choice=prompt(`切换分支，或输入 +新分支\n${branches.join('\n')}`); if(!choice)return; await action(choice.startsWith('+')?'branch.create':'branch.switch',undefined,choice.replace(/^\+/,'')) }
  const toggleCommit=async(commit:GitCommit)=>{if(expandedCommit===commit.hash){setExpandedCommit(undefined);return}setExpandedCommit(commit.hash);if(commitFileMap.has(commit.hash))return;setBusy(true);try{const files=await api<GitCommitFile[]>('git.action',{sessionId:props.sessionId,action:'commit.files',value:commit.hash});setCommitFileMap(current=>new Map(current).set(commit.hash,files))}catch(error){setError(String(error))}finally{setBusy(false)}}
  const openCommitFile=async(commit:GitCommit,file:GitCommitFile)=>{setBusy(true);try{const result=await api<GitDiff>('git.action',{sessionId:props.sessionId,action:'commit.file.diff',path:file.path,value:commit.hash});props.onDiff(`commit:${commit.hash}:${file.path}`,result,file.path.split('/').at(-1)??file.path,file.path)}catch(error){setError(String(error))}finally{setBusy(false)}}
  // 菜单内容由 gitMenus.ts 的纯函数生成，这里只把「点了做什么」接到面板已有动作上：
  // 复制走 clipboard.copyText，其余复用 action / toggleCommit / openCommitFile，避免出现第二套行为。
  const menuEntries = (): MenuEntry[] => {
    if (menu === undefined) return []
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
      } })
    }
    const { commit, file } = menu
    return commitFileMenuItems({ path: file.path, actions: {
      openDiff: () => void openCommitFile(commit, file),
      copyPath: () => void copyText(file.path),
    } })
  }
  const menuLabel = menu===undefined?'':menu.kind==='change'?'更改操作':menu.kind==='commit'?'提交操作':'提交文件操作'
  const staged=status?.changes.filter(change=>change.index!=='.'&&change.index!=='?')??[]
  const changed=status?.changes.filter(change=>change.worktree!=='.'||change.untracked)??[]
  const renderChange=(change:GitStatus['changes'][number],group:'staged'|'worktree')=><div className="dvw-change" key={`${group}:${change.path}`} onClick={()=>void action('diff',change.path,change.untracked?'untracked':group)} onContextMenu={event=>{event.preventDefault();event.stopPropagation();setMenu({kind:'change',x:event.clientX,y:event.clientY,change,group})}}><Icon name={change.untracked?'new-file':'diff'} className="dvw-file-icon"/><span className="dvw-change-path">{change.path}</span><span className="dvw-badge">{change.untracked?'U':group==='staged'?change.index:change.worktree}</span><button className="dvw-icon" title={group==='staged'?'取消暂存':'暂存更改'} onClick={event=>{event.stopPropagation();void action(group==='staged'?'unstage':'stage',change.path)}}><Icon name={group==='staged'?'remove':'add'}/></button>{group==='worktree'&&<button className="dvw-icon" title="放弃更改" onClick={event=>{event.stopPropagation();if(confirm(`放弃 ${change.path} 的更改？此操作无法撤销。`))void action('discard',change.path,change.untracked?'untracked':undefined)}}><Icon name="discard"/></button>}</div>
  return <><div className="dvw-side-head">源代码管理<div className="dvw-toolbar"><button className="dvw-icon" title="刷新" disabled={busy} onClick={refresh}><Icon name="refresh"/></button></div></div>{error&&<div className="dvw-error">{error}</div>}{status&&<><div className="dvw-git-head"><button className="dvw-branch" onClick={()=>void branch()}><Icon name="git-branch"/> {status.branch}</button><span>↑{status.ahead} ↓{status.behind}</span></div><div className="dvw-commit"><input className="dvw-input" value={message} onChange={event=>setMessage(event.target.value)} onKeyDown={event=>{if(event.ctrlKey&&event.key==='Enter'&&message.trim())void action('commit',undefined,message).then(()=>setMessage(''))}} placeholder={`消息 (Ctrl+Enter 在“${status.branch}”提交)`}/><button className="dvw-commit-button" disabled={busy||!message.trim()} onClick={()=>void action('commit',undefined,message).then(()=>setMessage(''))}><Icon name="check"/> 提交</button></div><div className="dvw-git">{staged.length>0&&<section><GitGroupHeader title="暂存的更改" count={staged.length} expanded={expanded.staged} onToggle={()=>setExpanded(value=>({...value,staged:!value.staged}))}><button className="dvw-icon" title="取消暂存所有更改" onClick={()=>void action('unstage.all')}><Icon name="remove"/></button></GitGroupHeader>{expanded.staged&&staged.map(change=>renderChange(change,'staged'))}</section>}<section><GitGroupHeader title="更改" count={changed.length} expanded={expanded.changes} onToggle={()=>setExpanded(value=>({...value,changes:!value.changes}))}><button className="dvw-icon" title="放弃所有更改" onClick={()=>{if(confirm('放弃所有已跟踪和未跟踪的更改？此操作无法撤销。'))void action('discard.all')}}><Icon name="discard"/></button><button className="dvw-icon" title="暂存所有更改" onClick={()=>void action('stage.all')}><Icon name="add"/></button></GitGroupHeader>{expanded.changes&&changed.map(change=>renderChange(change,'worktree'))}</section><section className="dvw-graph"><GitGroupHeader title="图表" count={commits.length} expanded={expanded.graph} onToggle={()=>setExpanded(value=>({...value,graph:!value.graph}))}><button className="dvw-icon" title="刷新提交图表" onClick={refresh}><Icon name="refresh"/></button></GitGroupHeader>{expanded.graph&&<CommitGraph commits={commits} expanded={expandedCommit} files={commitFileMap} onToggle={commit=>void toggleCommit(commit)} onOpenFile={(commit,file)=>void openCommitFile(commit,file)} onMenu={(commit,position)=>setMenu({kind:'commit',x:position.x,y:position.y,commit})} onFileMenu={(commit,file,position)=>setMenu({kind:'commit-file',x:position.x,y:position.y,commit,file})}/>}</section></div></>}{menu!==undefined&&<ContextMenu position={{x:menu.x,y:menu.y}} entries={menuEntries()} label={menuLabel} onClose={()=>setMenu(undefined)}/>}</>
}
