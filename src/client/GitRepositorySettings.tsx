import { useState } from 'react'
import type { GitRemote } from '../types.ts'
import type { GitGraphViewSettings } from './gitView.ts'
import { Icon } from './Icon.tsx'

/**
 * 仓库设置（对齐 Git Graph 的 Repository Settings Widget 的常用部分）：
 *
 * - 远程：改 URL、抓取、修剪（prune）、删除、添加；
 * - 视图：把当前的列显示/列宽/emoji 设置导出成 JSON（可提交进仓库或分享）。
 *
 * 不做 Issue 链接/PR 模板的完整配置——那两项在菜单里用自动推断的托管方（GitHub/GitLab/Bitbucket）
 * 已经够用，再堆一层自定义 provider 的输入框只会让这个对话框变长。
 */
export function GitRepositorySettings(props: {
  busy: boolean
  remotes: readonly GitRemote[]
  view: GitGraphViewSettings
  onClose(): void
  onSaveRemote(name: string, url: string): void
  onRemoveRemote(name: string): void
  onFetchRemote(name: string): void
  onPruneRemote(name: string): void
  onExport(): void
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const draftFor = (remote: GitRemote): string => drafts[remote.name] ?? remote.url
  return <div className="dvw-quickpick-backdrop" onMouseDown={props.onClose}>
    <div className="dvw-quickpick dvw-git-dialog" role="dialog" aria-label="仓库设置" onMouseDown={event => event.stopPropagation()}>
      <div className="dvw-git-dialog-head"><span>仓库设置</span><button className="dvw-icon" title="关闭" aria-label="关闭" onClick={props.onClose}><Icon name="close"/></button></div>
      <div className="dvw-git-dialog-section">远程</div>
      {props.remotes.length === 0 && <div className="dvw-git-dialog-empty">还没有配置远程仓库</div>}
      {props.remotes.map(remote => <div className="dvw-git-dialog-row" key={remote.name}>
        <span className="dvw-git-dialog-name" title={remote.name}>{remote.name}</span>
        <input className="dvw-input" value={draftFor(remote)} aria-label={`${remote.name} 的地址`} onChange={event => setDrafts(current => ({ ...current, [remote.name]: event.target.value }))}/>
        <button className="dvw-icon" title="保存地址" aria-label="保存地址" disabled={props.busy || draftFor(remote) === remote.url || draftFor(remote).trim() === ''} onClick={() => props.onSaveRemote(remote.name, draftFor(remote).trim())}><Icon name="check"/></button>
        <button className="dvw-icon" title="抓取" aria-label="抓取" disabled={props.busy} onClick={() => props.onFetchRemote(remote.name)}><Icon name="repo"/></button>
        <button className="dvw-icon" title="修剪已删除的远程分支" aria-label="修剪" disabled={props.busy} onClick={() => props.onPruneRemote(remote.name)}><Icon name="trash"/></button>
        <button className="dvw-icon" title="删除远程" aria-label="删除远程" disabled={props.busy} onClick={() => { if (confirm(`移除远程 ${remote.name}？`)) props.onRemoveRemote(remote.name) }}><Icon name="remove"/></button>
      </div>)}
      <div className="dvw-git-dialog-row dvw-git-dialog-add">
        <input className="dvw-input" value={newName} placeholder="远程名（如 origin）" aria-label="新远程名" onChange={event => setNewName(event.target.value)}/>
        <input className="dvw-input" value={newUrl} placeholder="仓库 URL" aria-label="新远程地址" onChange={event => setNewUrl(event.target.value)}/>
        <button className="dvw-icon" title="添加远程" aria-label="添加远程" disabled={props.busy || newName.trim() === '' || newUrl.trim() === ''} onClick={() => { props.onSaveRemote(newName.trim(), newUrl.trim()); setNewName(''); setNewUrl('') }}><Icon name="add"/></button>
      </div>
      <div className="dvw-git-dialog-section">视图</div>
      <div className="dvw-git-dialog-note">列显示与列宽跟随「视图」菜单；这里可以导出成 JSON 保存或分享。</div>
      <div className="dvw-git-dialog-row"><button className="dvw-mode-button" onClick={props.onExport}><Icon name="cloud-upload"/> 导出视图配置</button></div>
    </div>
  </div>
}
