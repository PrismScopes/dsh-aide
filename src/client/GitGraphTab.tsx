import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitCommit, GitCommitFile, GitDiff, GitStatus } from '../types.ts'
import { ApiError, api } from './api.ts'
import { CommitGraph } from './GitPanel.tsx'
import { ContextMenu, type MenuEntry } from './ContextMenu.tsx'
import { copyText } from './clipboard.ts'
import { useGitCommands } from './gitCommands.tsx'
import { commitFileMenuItems } from './gitMenus.ts'
import { recordGitCommand } from './gitOutput.ts'
import { Icon } from './Icon.tsx'
import { useDebouncedCallback } from './hooks.ts'

/** 编辑器里提交图标签页的内部路径。 */
export const GIT_GRAPH_PATH = 'git:graph'

/**
 * 提交图标签页。
 *
 * 与侧栏里那块紧凑的「图表」分组不同，这里是 VS Code Git Graph 扩展那种整页视图：
 * 顶部工具条（分支、ahead/behind、提交范围、刷新、`...` 菜单），下面是可展开的提交列表。
 * 数据自己取（`git.action=log` + `git.status`），动作统一走 useGitCommands ——
 * 与侧栏共用同一套菜单结构与二次确认，不会出现「侧栏能拣选、标签页不能」这类分叉。
 */
export function GitGraphTab({ sessionId, initialAllBranches = false, onOpenDiff }: { sessionId: string; initialAllBranches?: boolean; onOpenDiff(key: string, diff: GitDiff, title?: string, sourcePath?: string): void }) {
  const [status, setStatus] = useState<GitStatus>()
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [remotes, setRemotes] = useState<string[]>([])
  const [allCommits, setAllCommits] = useState(initialAllBranches)
  const [logLimit, setLogLimit] = useState(200)
  const [expandedCommit, setExpandedCommit] = useState<string>()
  const [files, setFiles] = useState<Map<string, GitCommitFile[]>>(new Map())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [menu, setMenu] = useState<
    | { kind: 'toolbar'; x: number; y: number }
    | { kind: 'commit'; x: number; y: number; commit: GitCommit }
    | { kind: 'commit-file'; x: number; y: number; commit: GitCommit; file: GitCommitFile }
  >()
  const onOpenDiffRef = useRef(onOpenDiff); onOpenDiffRef.current = onOpenDiff
  const loadLog = useCallback(() => api<GitCommit[]>('git.action', { sessionId, action: allCommits ? 'log.all' : 'log', value: String(logLimit) }), [sessionId, allCommits, logLimit])
  const refresh = useCallback(() => {
    void Promise.all([api<GitStatus>('git.status', { sessionId }), loadLog()]).then(([nextStatus, nextCommits]) => {
      setStatus(nextStatus); setCommits(nextCommits); setError(undefined)
    }).catch(cause => {
      setError(cause instanceof ApiError && cause.code === 'not-repository' ? '当前工作区不是 Git 仓库' : String(cause))
    })
  }, [sessionId, loadLog])
  useEffect(refresh, [refresh])
  useEffect(() => { void api<string[]>('git.action', { sessionId, action: 'remotes' }).then(setRemotes).catch(() => setRemotes([])) }, [sessionId])
  // 文件变化（保存、外部改动、agent 写文件）后刷新：`.git` 不在 watcher 的忽略列表里，
  // 但 `dvw-files-changed` 只针对工作区文件，提交图仍需要跟上最新的工作区状态。
  const refreshDebounced = useDebouncedCallback(() => void refresh(), 600)
  useEffect(() => { window.addEventListener('dvw-files-changed', refreshDebounced); return () => window.removeEventListener('dvw-files-changed', refreshDebounced) }, [refreshDebounced])

  /** 执行一个 git 动作：失败也刷新（例如 pull 冲突时工作区已经变了）。 */
  const run = async (name: string, path?: string, value?: string) => {
    setBusy(true); setError(undefined)
    try {
      const result = await api<unknown>('git.action', { sessionId, action: name, path, value })
      recordGitCommand({ action: name, path, value, ok: true })
      if (result !== null && typeof result === 'object' && Array.isArray((result as GitStatus).changes)) setStatus(result as GitStatus)
      if (name.startsWith('remote.') || name === 'clone') { void api<string[]>('git.action', { sessionId, action: 'remotes' }).then(setRemotes).catch(() => undefined) }
      void loadLog().then(setCommits).catch(() => undefined)
    } catch (cause) {
      recordGitCommand({ action: name, path, value, ok: false, message: String(cause) })
      setError(String(cause))
      void loadLog().then(setCommits).catch(() => undefined)
    } finally { setBusy(false) }
  }

  const toggleCommit = useCallback(async (commit: GitCommit) => {
    if (expandedCommit === commit.hash) { setExpandedCommit(undefined); return }
    setExpandedCommit(commit.hash)
    if (files.has(commit.hash)) return
    setBusy(true)
    try {
      const list = await api<GitCommitFile[]>('git.action', { sessionId, action: 'commit.files', value: commit.hash })
      setFiles(current => new Map(current).set(commit.hash, list))
    } catch (cause) { setError(String(cause)) } finally { setBusy(false) }
  }, [expandedCommit, files, sessionId])
  const openCommitFile = useCallback(async (commit: GitCommit, file: GitCommitFile) => {
    setBusy(true)
    try {
      const result = await api<GitDiff>('git.action', { sessionId, action: 'commit.file.diff', path: file.path, value: commit.hash })
      onOpenDiffRef.current(`commit:${commit.hash}:${file.path}`, result, file.path.split('/').at(-1) ?? file.path, file.path)
    } catch (cause) { setError(String(cause)) } finally { setBusy(false) }
  }, [sessionId])
  const toggleCommitRef = useCallback((commit: GitCommit) => void toggleCommit(commit), [toggleCommit])
  const openCommitFileRef = useCallback((commit: GitCommit, file: GitCommitFile) => void openCommitFile(commit, file), [openCommitFile])

  const commands = useGitCommands({
    sessionId, busy, status, remotes,
    run: (action, path, value) => run(action, path, value),
    refresh: () => void refresh(),
    openGraph: all => setAllCommits(all),
    openOutput: () => { /* 由 Workbench 通过 onOpenOutput 注入时才有意义；图表页里保持空操作。 */ },
    onError: message => setError(message),
    onCopy: text => { void copyText(text) },
    loadMore: () => setLogLimit(value => Math.min(1000, value + 200)),
  })

  const menuEntries = (): MenuEntry[] => {
    if (menu === undefined) return []
    if (menu.kind === 'toolbar') return commands.graphMenu({ allCommits, canLoadMore: logLimit < 1000 })
    if (menu.kind === 'commit') {
      return commands.commitMenu(menu.commit, expandedCommit === menu.commit.hash, {
        copyHash: () => { void copyText(menu.commit.hash) },
        copyMessage: () => { void copyText(menu.commit.subject) },
        toggleFiles: () => void toggleCommit(menu.commit),
      })
    }
    return commitFileMenuItems({ path: menu.file.path, actions: {
      openDiff: () => void openCommitFile(menu.commit, menu.file),
      copyPath: () => { void copyText(menu.file.path) },
    } })
  }
  const menuLabel = menu === undefined ? '' : menu.kind === 'toolbar' ? '提交图操作' : menu.kind === 'commit' ? '提交操作' : '提交文件操作'

  return <div className="dvw-gittab">
    <div className="dvw-gittab-toolbar">
      <Icon name="git-branch"/>
      <span className="dvw-gittab-branch">{status?.branch ?? '…'}</span>
      <span className="dvw-gittab-meta">↑{status?.ahead ?? 0} ↓{status?.behind ?? 0} · {commits.length} 个提交</span>
      <div className="dvw-gittab-actions">
        <button className="dvw-icon" data-active={allCommits || undefined} title={allCommits ? '仅显示当前分支' : '显示全部分支'} aria-label={allCommits ? '仅显示当前分支' : '显示全部分支'} aria-pressed={allCommits} onClick={() => setAllCommits(value => !value)}><Icon name="graph"/></button>
        <button className="dvw-icon" title="刷新提交图" aria-label="刷新提交图" disabled={busy} onClick={() => void refresh()}><Icon name="refresh"/></button>
        <button className="dvw-icon" title="更多操作" aria-label="更多操作" aria-haspopup="menu" onClick={event => setMenu({ kind: 'toolbar', x: event.clientX, y: event.clientY })}><Icon name="ellipsis"/></button>
      </div>
    </div>
    {error !== undefined && <div className="dvw-error"><button className="dvw-icon" onClick={() => setError(undefined)}><Icon name="close"/></button>{error}</div>}
    {busy && <div className="dvw-search-progress" role="progressbar" aria-label="正在执行 git 操作"/>}
    <div className="dvw-gittab-body">
      {commits.length === 0
        ? <div className="dvw-gittab-empty">还没有提交{allCommits ? '' : '（当前分支）'}</div>
        : <CommitGraph commits={commits} expanded={expandedCommit} files={files} remotes={remotes}
            onToggle={toggleCommitRef} onOpenFile={openCommitFileRef}
            onMenu={(commit, position) => setMenu({ kind: 'commit', commit, x: position.x, y: position.y })}
            onFileMenu={(commit, file, position) => setMenu({ kind: 'commit-file', commit, file, x: position.x, y: position.y })}/>}
    </div>
    {menu !== undefined && <ContextMenu position={{ x: menu.x, y: menu.y }} label={menuLabel} entries={menuEntries()} onClose={() => setMenu(undefined)}/>}
    {commands.pickerElement}
  </div>
}
