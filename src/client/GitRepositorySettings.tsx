import { useState } from 'react'
import type { GitRemote } from '../types.ts'
import type { GitGraphViewSettings } from './gitView.ts'
import type { IssueLinkConfig, IssueProvider } from './gitText.ts'
import { Icon } from './Icon.tsx'

/**
 * 仓库设置（对齐 Git Graph 的 Repository Settings Widget 的常用部分）：
 *
 * - 远程：改 URL、抓取、修剪（prune）、删除、添加；
 * - Issue 链接：托管方与仓库地址（默认按远程自动推断，可手动覆盖）；
 * - 拉取请求：目标分支可固定，之后从菜单一键打开创建页；
 * - 视图：把当前的列显示/列宽/emoji 设置导出成 JSON（可提交进仓库或分享）。
 */
export function GitRepositorySettings(props: {
  busy: boolean
  remotes: readonly GitRemote[]
  view: GitGraphViewSettings
  issue: IssueLinkConfig
  /** 从远程/配置解析出的托管方（只用于展示检测结果）。 */
  provider: IssueProvider
  /** 创建拉取请求时的目标分支；空表示每次询问。 */
  pullBase: string
  onClose(): void
  onSaveRemote(name: string, url: string): void
  onRemoveRemote(name: string): void
  onFetchRemote(name: string): void
  onPruneRemote(name: string): void
  onSaveIssue(config: IssueLinkConfig): void
  onSavePullBase(value: string): void
  onCreatePullRequest(): void
  onExport(): void
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [issueProvider, setIssueProvider] = useState<IssueLinkConfig['provider']>(props.issue.provider)
  const [issueRepo, setIssueRepo] = useState(props.issue.repoUrl)
  const [pullBase, setPullBase] = useState(props.pullBase)
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
      <div className="dvw-git-dialog-section">Issue 链接</div>
      <div className="dvw-git-dialog-note">提交说明里的 #123 会变成这里配置的 issue 链接；「自动识别」按远程地址推断（当前：{props.provider === 'none' ? '未识别' : props.provider}）。</div>
      <div className="dvw-git-dialog-row">
        <select className="dvw-input" value={issueProvider} aria-label="Issue 托管方" onChange={event => setIssueProvider(event.target.value as IssueLinkConfig['provider'])}>
          <option value="auto">自动识别</option>
          <option value="github">GitHub</option>
          <option value="gitlab">GitLab</option>
          <option value="bitbucket">Bitbucket</option>
          <option value="none">不生成链接</option>
        </select>
        <input className="dvw-input" value={issueRepo} placeholder="仓库地址，例如 https://github.com/owner/repo" aria-label="Issue 仓库地址" onChange={event => setIssueRepo(event.target.value)}/>
        <button className="dvw-icon" title="保存 Issue 设置" aria-label="保存 Issue 设置" disabled={props.busy} onClick={() => props.onSaveIssue({ provider: issueProvider, repoUrl: issueRepo.trim() })}><Icon name="check"/></button>
      </div>
      <div className="dvw-git-dialog-section">拉取请求</div>
      <div className="dvw-git-dialog-row">
        <span className="dvw-git-dialog-name">目标分支</span>
        <input className="dvw-input" value={pullBase} placeholder="留空则每次选择（例如 main）" aria-label="拉取请求目标分支" onChange={event => setPullBase(event.target.value)}/>
        <button className="dvw-icon" title="保存目标分支" aria-label="保存目标分支" disabled={props.busy} onClick={() => props.onSavePullBase(pullBase.trim())}><Icon name="check"/></button>
        <button className="dvw-mode-button" disabled={props.busy || props.provider === 'none'} onClick={props.onCreatePullRequest}><Icon name="git-branch"/> 创建拉取请求</button>
      </div>
      <div className="dvw-git-dialog-section">视图</div>
      <div className="dvw-git-dialog-note">列显示与列宽跟随「视图」菜单；这里可以导出成 JSON 保存或分享。</div>
      <div className="dvw-git-dialog-row"><button className="dvw-mode-button" onClick={props.onExport}><Icon name="cloud-upload"/> 导出视图配置</button></div>
    </div>
  </div>
}
