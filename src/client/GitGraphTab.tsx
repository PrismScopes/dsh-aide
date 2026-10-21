import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitBranchList, GitChange, GitCommit, GitCommitDetail, GitCommitFileDetail, GitDiff, GitRemote, GitStash, GitStatus, GitTag, GitTagDetail } from '../types.ts'
import { ApiError, api } from './api.ts'
import { GraphTracks, graphRows } from './GitPanel.tsx'
import { GitRepositorySettings } from './GitRepositorySettings.tsx'
import { ContextMenu, type MenuEntry } from './ContextMenu.tsx'
import { copyText } from './clipboard.ts'
import { useGitCommands } from './gitCommands.tsx'
import { buildGraphList, branchTips, detailViewState, filterCommits, graphSubtitle, reachableCommits, refKind, refLabel, shortHash } from './gitGraph.ts'
import { groupMenuItems, stashMenuItems } from './gitMenus.ts'
import { recordGitCommand } from './gitOutput.ts'
import { gitViewStorageKey, parseGitViewSettings, type GitGraphViewSettings } from './gitView.ts'
import { issueSegments, issueLinkStorageKey, parseIssueLinkConfig, pullRequestUrl, replaceEmojiShortcodes, resolveIssueLinks, type IssueLinkConfig, type IssueProvider } from './gitText.ts'
import { isReviewed, markReviewed, parseReviewStore, pruneReviewStore, reviewProgress, reviewScopeKey, reviewStorageKey, type ReviewStore } from './gitReview.ts'
import { QuickPick, type QuickPickItem } from './quickPick.tsx'
import { Icon } from './Icon.tsx'
import { useDebouncedCallback } from './hooks.ts'

/** 编辑器里提交图标签页的内部路径。 */
export const GIT_GRAPH_PATH = 'git:graph'

function readStorage(key: string): string | null { try { return localStorage.getItem(key) } catch { return null } }
function writeStorage(key: string, value: string | null): void { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value) } catch { /* 隐私模式下内存状态仍然可用 */ } }

/**
 * 提交图标签页。
 *
 * 按 VS Code Git Graph 扩展的整页视图组织：顶部工具条（分支、ahead/behind、范围、查找、分支过滤、仓库设置、刷新、`...`），
 * 中间是提交列表（未提交更改 / 贮藏 / 提交；作者/日期/哈希列可显示隐藏并拖动列宽），
 * 右侧是「提交详情 / 提交对比」面板（带代码审查的已读标记）。
 * 交互对齐原版：单击提交看详情、Ctrl(⌘)+单击另一个提交对比、Ctrl+F 查找、Ctrl+H 回到 HEAD、
 * Ctrl+R 刷新、↑/↓ 移动、Esc 关闭；图内快捷键在输入框里不拦截。
 */
export function GitGraphTab({ sessionId, initialAllBranches = false, onOpenDiff }: { sessionId: string; initialAllBranches?: boolean; onOpenDiff(key: string, diff: GitDiff, title?: string, sourcePath?: string): void }) {
  const [status, setStatus] = useState<GitStatus>()
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [stashes, setStashes] = useState<GitStash[]>([])
  const [remotes, setRemotes] = useState<string[]>([])
  const [remoteList, setRemoteList] = useState<GitRemote[]>([])
  const [allCommits, setAllCommits] = useState(initialAllBranches)
  const [logLimit, setLogLimit] = useState(200)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [menu, setMenu] = useState<
    | { kind: 'toolbar'; x: number; y: number }
    | { kind: 'commit'; x: number; y: number; commit: GitCommit }
    | { kind: 'stash'; x: number; y: number; stash: GitStash }
    | { kind: 'uncommitted'; x: number; y: number }
  >()
  // 查找（Ctrl+F）与分支过滤：两者都只作用于已经加载的提交窗口。
  const [findOpen, setFindOpen] = useState(false)
  const [find, setFind] = useState('')
  const [branches, setBranches] = useState<GitBranchList>()
  const [branchFilter, setBranchFilter] = useState<ReadonlySet<string>>(() => new Set())
  const [filterPicker, setFilterPicker] = useState(false)
  // 右侧面板：提交详情 或 两个提交的对比。
  const [selected, setSelected] = useState<{ kind: 'commit'; hash: string } | { kind: 'compare'; from: string; to: string }>()
  const [detail, setDetail] = useState<GitCommitDetail>()
  const [compare, setCompare] = useState<GitCommitFileDetail[]>()
  const [uncommittedOpen, setUncommittedOpen] = useState(false)
  const [activeHash, setActiveHash] = useState<string>()
  // 视图设置 / 代码审查 / 标签详情 / 仓库设置。
  const [view, setView] = useState<GitGraphViewSettings>(() => parseGitViewSettings(null))
  const [reviews, setReviews] = useState<ReviewStore>({})
  const [tagPicker, setTagPicker] = useState<GitTag[]>()
  const [tagDetail, setTagDetail] = useState<GitTagDetail>()
  const [repoSettings, setRepoSettings] = useState(false)
  // Issue 链接配置与拉取请求目标分支：按仓库保存，空/坏数据走默认值。
  const [issueConfig, setIssueConfig] = useState<IssueLinkConfig>({ provider: 'auto', repoUrl: '' })
  const [pullBase, setPullBase] = useState('')
  const [pullPicker, setPullPicker] = useState<GitBranchList>()
  const drag = useRef<{ column: 'authorWidth' | 'dateWidth' | 'hashWidth'; startX: number; startWidth: number }>()
  const findInput = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const onOpenDiffRef = useRef(onOpenDiff); onOpenDiffRef.current = onOpenDiff
  const repository = status?.repository ?? ''

  const loadLog = useCallback(() => api<GitCommit[]>('git.action', { sessionId, action: allCommits ? 'log.all' : 'log', value: String(logLimit) }), [sessionId, allCommits, logLimit])
  const loadStashes = useCallback(() => api<GitStash[]>('git.action', { sessionId, action: 'stash.list' }).catch(() => [] as GitStash[]), [sessionId])
  const loadRemotes = useCallback(() => api<GitRemote[]>('git.action', { sessionId, action: 'remote.list' }).then(list => { setRemoteList(list); setRemotes(list.map(remote => remote.name)) }).catch(() => { setRemoteList([]); setRemotes([]) }), [sessionId])
  const refresh = useCallback(() => {
    void Promise.all([api<GitStatus>('git.status', { sessionId }), loadLog(), loadStashes()]).then(([nextStatus, nextCommits, nextStashes]) => {
      setStatus(nextStatus); setCommits(nextCommits); setStashes(nextStashes); setError(undefined)
      void loadRemotes()
    }).catch(cause => {
      setError(cause instanceof ApiError && cause.code === 'not-repository' ? '当前工作区不是 Git 仓库' : String(cause))
    })
  }, [sessionId, loadLog, loadStashes, loadRemotes])
  useEffect(refresh, [refresh])
  // 视图设置与审查记录按仓库持久化：仓库一变就重读，换仓库不会串。
  useEffect(() => {
    if (repository === '') return
    setView(parseGitViewSettings(readStorage(gitViewStorageKey(repository))))
    setReviews(pruneReviewStore(parseReviewStore(readStorage(reviewStorageKey(repository))), Date.now()))
  }, [repository])
  useEffect(() => { if (repository !== '') writeStorage(gitViewStorageKey(repository), JSON.stringify(view)) }, [repository, view])
  useEffect(() => { if (repository !== '') writeStorage(reviewStorageKey(repository), Object.keys(reviews).length === 0 ? null : JSON.stringify(reviews)) }, [repository, reviews])
  // 文件变化（保存、外部改动、agent 写文件）后刷新；`.git` 不在 watcher 的忽略列表里。
  useEffect(() => {
    if (repository === '') return
    setIssueConfig(parseIssueLinkConfig(readStorage(issueLinkStorageKey(repository))))
    setPullBase(readStorage('dvw:git-pr-base:v1:' + repository) ?? '')
  }, [repository])
  useEffect(() => { if (repository !== '') writeStorage(issueLinkStorageKey(repository), JSON.stringify(issueConfig)) }, [repository, issueConfig])
  useEffect(() => { if (repository !== '') writeStorage('dvw:git-pr-base:v1:' + repository, pullBase === '' ? null : pullBase) }, [repository, pullBase])
  const refreshDebounced = useDebouncedCallback(() => void refresh(), 600)
  useEffect(() => { window.addEventListener('dvw-files-changed', refreshDebounced); return () => window.removeEventListener('dvw-files-changed', refreshDebounced) }, [refreshDebounced])
  // 列宽拖动：pointermove 只改状态，松手后由持久化 effect 写回。
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const state = drag.current
      if (state === undefined) return
      const next = Math.max(40, Math.min(320, Math.round(state.startWidth + event.clientX - state.startX)))
      setView(current => ({ ...current, [state.column]: next }))
    }
    const up = () => { drag.current = undefined }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up) }
  }, [])

  /** 执行一个 git 动作：失败也刷新（例如 pull 冲突时工作区已经变了）。 */
  const run = async (name: string, path?: string, value?: string) => {
    setBusy(true); setError(undefined)
    try {
      const result = await api<unknown>('git.action', { sessionId, action: name, path, value })
      recordGitCommand({ action: name, path, value, ok: true })
      if (result !== null && typeof result === 'object' && Array.isArray((result as GitStatus).changes)) setStatus(result as GitStatus)
      if (name.startsWith('remote.') || name === 'clone') void loadRemotes()
      void loadLog().then(setCommits).catch(() => undefined)
      void loadStashes().then(setStashes).catch(() => undefined)
    } catch (cause) {
      recordGitCommand({ action: name, path, value, ok: false, message: String(cause) })
      setError(String(cause))
      void loadLog().then(setCommits).catch(() => undefined)
    } finally { setBusy(false) }
  }

  /** 打开提交详情 / 提交对比：单击看详情，Ctrl(⌘)+单击在「先选中的提交」与「这次点击的提交」之间对比。 */
  const selectCommit = useCallback(async (hash: string, mode: 'detail' | 'compare') => {
    if (mode === 'compare' && selected?.kind === 'commit' && selected.hash !== hash) {
      const from = selected.hash
      setSelected({ kind: 'compare', from, to: hash }); setDetail(undefined); setCompare(undefined); setBusy(true)
      try { setCompare(await api<GitCommitFileDetail[]>('git.action', { sessionId, action: 'compare.files', path: from, value: hash })) }
      catch (cause) { setError(String(cause)) } finally { setBusy(false) }
      return
    }
    setSelected({ kind: 'commit', hash }); setCompare(undefined); setActiveHash(hash); setDetail(undefined); setBusy(true)
    try { setDetail(await api<GitCommitDetail>('git.action', { sessionId, action: 'commit.detail', value: hash })) }
    catch (cause) { setError(String(cause)) } finally { setBusy(false) }
  }, [selected, sessionId])

  /** 关闭详情/对比：同时清掉已读取内容，避免下次打开前闪出旧数据。 */
  const closeDetail = useCallback(() => { setSelected(undefined); setDetail(undefined); setCompare(undefined) }, [])
  const scope = selected === undefined ? undefined : selected.kind === 'commit' ? reviewScopeKey({ kind: 'commit', hash: selected.hash }) : reviewScopeKey({ kind: 'compare', from: selected.from, to: selected.to })
  const reviewPaths = useMemo(() => (selected?.kind === 'commit' ? detail?.files ?? [] : compare ?? []).map(file => file.path), [selected, detail, compare])
  const progress = scope === undefined ? { reviewed: 0, total: 0 } : reviewProgress(reviews, scope, reviewPaths)
  const toggleReviewed = (path: string) => {
    if (scope === undefined) return
    setReviews(current => markReviewed(current, scope, path, !isReviewed(current, scope, path), Date.now()))
  }
  const openFileDiff = useCallback(async (file: GitCommitFileDetail, target: { kind: 'commit'; hash: string } | { kind: 'compare'; from: string; to: string }) => {
    setBusy(true)
    try {
      const result = target.kind === 'commit'
        ? await api<GitDiff>('git.action', { sessionId, action: 'commit.file.diff', path: file.path, value: target.hash })
        : await api<GitDiff>('git.action', { sessionId, action: 'range.file.diff', path: file.path, value: `${target.from}..${target.to}` })
      const key = target.kind === 'commit' ? `commit:${target.hash}:${file.path}` : `compare:${target.from}..${target.to}:${file.path}`
      // 打开 diff 即视为「已读」（与 Git Graph 的代码审查默认行为一致）。
      const fileScope = target.kind === 'commit' ? reviewScopeKey({ kind: 'commit', hash: target.hash }) : reviewScopeKey({ kind: 'compare', from: target.from, to: target.to })
      setReviews(current => markReviewed(current, fileScope, file.path, true, Date.now()))
      onOpenDiffRef.current(key, result, file.path.split('/').at(-1) ?? file.path, file.path)
    } catch (cause) { setError(String(cause)) } finally { setBusy(false) }
  }, [sessionId])

  // ---- 过滤（查找 + 分支）与图上条目 ----
  const visibleCommits = useMemo(() => {
    let list = filterCommits(commits, find)
    if (branchFilter.size > 0) {
      const known = new Set([...(branches?.local ?? []), ...(branches?.remote ?? [])])
      const selectedBranches = new Set([...branchFilter].filter(name => known.size === 0 || known.has(name)))
      const reachable = reachableCommits(commits, branchTips(commits, selectedBranches))
      list = list.filter(commit => reachable.has(commit.hash))
    }
    return list
  }, [commits, find, branchFilter, branches])
  const rows = useMemo(() => graphRows(visibleCommits), [visibleCommits])
  const rowIndex = useMemo(() => new Map(rows.map((row, index) => [row.commit.hash, index] as const)), [rows])
  const hasUncommitted = (status?.changes.length ?? 0) > 0
  const graphList = useMemo(() => buildGraphList({ commitCount: rows.length, stashCount: stashes.length, hasUncommitted }), [rows.length, stashes.length, hasUncommitted])
  const originRemote = remoteList.find(remote => remote.name === 'origin') ?? remoteList[0]
  const links = resolveIssueLinks(issueConfig, originRemote?.url)
  const provider: IssueProvider = links.provider
  const repoUrl = links.repoUrl

  const openFilterPicker = useCallback(async () => {
    if (branches === undefined) {
      try { setBranches(await api<GitBranchList>('git.action', { sessionId, action: 'branch.list' })) }
      catch (cause) { setError(String(cause)); return }
    }
    setFilterPicker(true)
  }, [branches, sessionId])
  const openTagPicker = useCallback(async () => {
    try { setTagPicker(await api<GitTag[]>('git.action', { sessionId, action: 'tag.list' })) }
    catch (cause) { setError(String(cause)) }
  }, [sessionId])
  const launchPullRequest = useCallback((base: string) => {
    const source = status?.branch ?? ''
    const url = pullRequestUrl(links.provider, links.repoUrl, source, base)
    if (url === undefined) { setError('无法创建拉取请求：请先在「仓库设置」里配置远程仓库地址，并确认当前不在目标分支上'); return }
    setError(undefined)
    window.open(url, '_blank', 'noopener,noreferrer')
  }, [links.provider, links.repoUrl, status?.branch])
  /** 目标分支固定在仓库设置里就直接开；否则列本地分支让用户选一次并记住。 */
  const createPullRequest = useCallback(async () => {
    const source = status?.branch ?? ''
    if (pullBase.trim() !== '') { launchPullRequest(pullBase.trim()); return }
    try {
      const list = await api<GitBranchList>('git.action', { sessionId, action: 'branch.list' })
      const candidates = list.local.filter(name => name !== source && name !== 'HEAD')
      if (candidates.length === 1) { setPullBase(candidates[0]!); launchPullRequest(candidates[0]!); return }
      setPullPicker(list)
    } catch (cause) { setError(String(cause)) }
  }, [status?.branch, pullBase, launchPullRequest, sessionId])
  const commands = useGitCommands({
    sessionId, busy, status, remotes,
    run: (action, path, value) => run(action, path, value),
    refresh: () => void refresh(),
    openGraph: all => setAllCommits(all),
    openOutput: () => { /* 图表页没有输出入口，保持空操作 */ },
    onError: message => setError(message),
    onCopy: text => { void copyText(text) },
    loadMore: () => setLogLimit(value => Math.min(1000, value + 200)),
    openFind: () => { setFindOpen(true); window.setTimeout(() => findInput.current?.focus(), 0) },
    openBranchFilter: () => { void openFilterPicker() },
    clearBranchFilter: () => setBranchFilter(new Set()),
    filteredBranches: [...branchFilter],
    view, updateView: patch => setView(current => ({ ...current, ...patch })),
    showTagDetail: () => void openTagPicker(),
    clearReviews: () => setReviews({}),
    openRepoSettings: () => setRepoSettings(true),
    createPullRequest: () => void createPullRequest(),
  })
  const filterItems: QuickPickItem[] = useMemo(() => {
    const names = [...(branches?.local ?? []), ...(branches?.remote ?? [])]
    return names.map(name => ({ id: name, label: name, ...(branches?.remote.includes(name) === true ? { detail: '远程' } : {}) }))
  }, [branches])

  // ---- 键盘：Ctrl+F 查找、Ctrl+H 回到 HEAD、Ctrl+R 刷新、↑↓ 移动、Esc 关闭 ----
  const scrollToHash = useCallback((hash: string | undefined) => {
    if (hash === undefined) return
    window.setTimeout(() => listRef.current?.querySelector(`[data-graph-hash="${hash}"]`)?.scrollIntoView({ block: 'center' }), 0)
  }, [])
  const moveSelection = useCallback((direction: 1 | -1) => {
    if (rows.length === 0) return
    const current = activeHash === undefined ? (direction === 1 ? -1 : 0) : (rowIndex.get(activeHash) ?? -1)
    const next = (current + direction + rows.length) % rows.length
    const row = rows[next]
    if (row === undefined) return
    setActiveHash(row.commit.hash)
    scrollToHash(row.commit.hash)
    void selectCommit(row.commit.hash, 'detail')
  }, [rows, activeHash, rowIndex, selectCommit, scrollToHash])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (typing) { if (event.key === 'Escape') { (target as HTMLElement).blur(); setFindOpen(false) } return }
      if (event.ctrlKey || event.metaKey) {
        const key = event.key.toLowerCase()
        if (key === 'f') { event.preventDefault(); setFindOpen(true); window.setTimeout(() => findInput.current?.focus(), 0); return }
        if (key === 'r') { event.preventDefault(); void refresh(); return }
        if (key === 'h') { event.preventDefault(); scrollToHash(commits.find(commit => commit.refs.some(ref => refKind(ref, remotes) === 'head'))?.hash); return }
      }
      if (event.key === 'Escape') { closeDetail(); setFindOpen(false); return }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); moveSelection(event.key === 'ArrowDown' ? 1 : -1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [commits, remotes, refresh, scrollToHash, moveSelection, closeDetail])

  const stashLabel = (stash: GitStash) => `stash@{${stash.index}}: ${stash.message}`
  const menuEntries = (): MenuEntry[] => {
    if (menu === undefined) return []
    if (menu.kind === 'toolbar') return commands.graphMenu({ allCommits, canLoadMore: logLimit < 1000 })
    if (menu.kind === 'commit') {
      return commands.commitMenu(menu.commit, selected?.kind === 'commit' && selected.hash === menu.commit.hash, {
        copyHash: () => { void copyText(menu.commit.hash) },
        copyMessage: () => { void copyText(menu.commit.subject) },
        toggleFiles: () => void selectCommit(menu.commit.hash, 'detail'),
      })
    }
    if (menu.kind === 'stash') {
      const stash = menu.stash
      return stashMenuItems({ label: stashLabel(stash), actions: {
        apply: () => run('stash.apply', undefined, String(stash.index)),
        pop: () => run('stash.pop', undefined, String(stash.index)),
        drop: () => { if (confirm(`删除 ${stashLabel(stash)}？`)) void run('stash.drop', undefined, String(stash.index)) },
        copyName: () => { void copyText(`stash@{${stash.index}}`) },
      } })
    }
    return groupMenuItems({ group: 'changes', busy, count: status?.changes.length ?? 0, allCommits, canLoadMore: logLimit < 1000, expandedCommit: false, actions: {
      stageAll: () => void run('stage.all'), unstageAll: () => void run('unstage.all'),
      discardAll: () => { if (confirm('放弃所有已跟踪和未跟踪的更改？此操作无法撤销。')) void run('discard.all') },
      refreshGraph: () => void refresh(), toggleAllCommits: () => setAllCommits(value => !value),
      loadMore: () => setLogLimit(value => Math.min(1000, value + 200)), collapseCommit: closeDetail,
    } })
  }
  const menuLabel = menu === undefined ? '' : menu.kind === 'toolbar' ? '提交图操作' : menu.kind === 'commit' ? '提交操作' : menu.kind === 'stash' ? '贮藏操作' : '未提交更改操作'

  /** 提交说明：可选的 emoji 替换 + Issue 链接（托管方由远程 URL 自动推断）。 */
  const renderMessage = (text: string, emoji: boolean) => {
    const segments = issueSegments(emoji ? replaceEmojiShortcodes(text) : text, provider, repoUrl)
    return segments.map((segment, index) => segment.url === undefined
      ? <span key={index}>{segment.text}</span>
      : <a className="dvw-git-issue-link" key={index} href={segment.url} target="_blank" rel="noreferrer" onClick={event => event.stopPropagation()}>{segment.text}</a>)
  }

  const renderUncommitted = () => <div className="dvw-git-uncommitted" key="uncommitted">
    <button className="dvw-graph-row dvw-uncommitted-row" aria-expanded={uncommittedOpen} onClick={() => setUncommittedOpen(value => !value)}
      onContextMenu={event => { event.preventDefault(); setMenu({ kind: 'uncommitted', x: event.clientX, y: event.clientY }) }}>
      <span className="dvw-uncommitted-dot" aria-hidden="true"/>
      <span className="dvw-graph-copy"><span className="dvw-graph-subject">未提交的更改</span><span className="dvw-graph-meta">{status?.changes.length ?? 0} 个文件</span></span>
      <Icon name={uncommittedOpen ? 'chevron-down' : 'chevron-right'}/>
    </button>
    {uncommittedOpen && <div className="dvw-uncommitted-files">{(status?.changes ?? []).map((change: GitChange) => <div className="dvw-uncommitted-file" key={change.path}>
      <Icon name={change.untracked ? 'new-file' : 'diff'}/><span className="dvw-change-path">{change.path}</span>
      <span className="dvw-badge">{change.untracked ? 'U' : change.worktree !== '.' ? change.worktree : change.index}</span>
    </div>)}</div>}
  </div>

  const renderStash = (stash: GitStash) => <button className="dvw-graph-row dvw-stash-row" key={`stash:${stash.index}`} title={stashLabel(stash)}
    onClick={event => setMenu({ kind: 'stash', x: event.clientX, y: event.clientY, stash })}
    onContextMenu={event => { event.preventDefault(); setMenu({ kind: 'stash', x: event.clientX, y: event.clientY, stash }) }}>
    <span className="dvw-stash-dot" aria-hidden="true"/>
    <span className="dvw-graph-copy"><span className="dvw-graph-subject">{stash.message}</span><span className="dvw-graph-meta">{`stash@{${stash.index}}`}</span></span>
    <Icon name="archive"/>
  </button>

  const renderCommit = (row: (typeof rows)[number]) => {
    const isSelected = selected?.kind === 'commit' && selected.hash === row.commit.hash
    const isCompareEnd = selected?.kind === 'compare' && (selected.from === row.commit.hash || selected.to === row.commit.hash)
    return <button className="dvw-graph-row" key={row.commit.hash} data-graph-hash={row.commit.hash}
      data-active={isSelected || isCompareEnd || undefined}
      title={`${row.commit.hash}\n${row.commit.author}`}
      onClick={event => { setMenu(undefined); void selectCommit(row.commit.hash, event.ctrlKey || event.metaKey ? 'compare' : 'detail') }}
      onContextMenu={event => { event.preventDefault(); setMenu({ kind: 'commit', x: event.clientX, y: event.clientY, commit: row.commit }) }}>
      <GraphTracks row={row}/>
      <span className="dvw-graph-copy"><span className="dvw-graph-subject">{renderMessage(row.commit.subject, view.emoji)}</span><span className="dvw-graph-meta">{graphSubtitle(row.commit)}</span></span>
      {row.commit.refs.slice(0, 3).map(ref => <span className="dvw-ref" data-kind={refKind(ref, remotes)} key={ref}>{refLabel(ref)}</span>)}
      {view.showAuthor && <span className="dvw-graph-col" style={{ width: view.authorWidth }} title={row.commit.author}>{row.commit.author}</span>}
      {view.showDate && <span className="dvw-graph-col" style={{ width: view.dateWidth }} title={row.commit.date}>{new Date(row.commit.date).toLocaleDateString()}</span>}
      {view.showHash && <span className="dvw-graph-col dvw-graph-hash" style={{ width: view.hashWidth }} title={row.commit.hash}>{shortHash(row.commit.hash)}</span>}
    </button>
  }

  const reviewBadge = progress.total === 0 ? undefined : <span className="dvw-review-progress">已读 {progress.reviewed}/{progress.total}</span>
  const fileRow = (file: GitCommitFileDetail, target: { kind: 'commit'; hash: string } | { kind: 'compare'; from: string; to: string }) => {
    const reviewed = scope !== undefined && isReviewed(reviews, scope, file.path)
    return <div className="dvw-git-detail-file" key={file.path}>
      <button className="dvw-review-toggle" title={reviewed ? '标记为未读' : '标记为已读'} aria-label={reviewed ? '标记为未读' : '标记为已读'} aria-pressed={reviewed} onClick={() => toggleReviewed(file.path)}><Icon name={reviewed ? 'check' : 'preview'}/></button>
      <button className="dvw-git-detail-open" onClick={() => void openFileDiff(file, target)}>
        <span className="dvw-badge">{file.status}</span><span className="dvw-graph-subject">{file.path}</span>
        <span className="dvw-file-stat">{file.binary ? <span className="dvw-stat-add">二进制</span> : <><span className="dvw-stat-add">+{file.additions}</span><span className="dvw-stat-del">−{file.deletions}</span></>}</span>
      </button>
    </div>
  }

  const detailView = detailViewState(selected, detail !== undefined, compare !== undefined)
  const loadedDetail = detailView === 'commit' ? detail : undefined
  const loadedCompare = detailView === 'compare' ? compare : undefined
  const compareTarget = selected?.kind === 'compare' ? selected : undefined
  const details = detailView === 'none'
    ? undefined
    : loadedCompare !== undefined && compareTarget !== undefined
      ? <div className="dvw-git-detail">
          <div className="dvw-git-detail-head"><span className="dvw-git-detail-title">比较 <code>{shortHash(compareTarget.from)}</code> → <code>{shortHash(compareTarget.to)}</code></span>{reviewBadge}<button className="dvw-icon" title="关闭详情" aria-label="关闭详情" onClick={closeDetail}><Icon name="close"/></button></div>
          <div className="dvw-git-detail-meta">{loadedCompare.length} 个文件发生变化</div>
          <div className="dvw-git-detail-files">{loadedCompare.length === 0 && <div className="dvw-git-detail-empty">两个提交之间没有文件差异</div>}{loadedCompare.map(file => fileRow(file, compareTarget))}</div>
        </div>
      : loadedDetail !== undefined
        ? <div className="dvw-git-detail">
            <div className="dvw-git-detail-head"><span className="dvw-git-detail-title">{renderMessage(loadedDetail.subject, view.emoji)}</span>{reviewBadge}<button className="dvw-icon" title="更多操作" aria-label="更多操作" onClick={event => { const row = rows.find(entry => entry.commit.hash === loadedDetail.hash); if (row !== undefined) setMenu({ kind: 'commit', x: event.clientX, y: event.clientY, commit: row.commit }) }}><Icon name="ellipsis"/></button><button className="dvw-icon" title="关闭详情" aria-label="关闭详情" onClick={closeDetail}><Icon name="close"/></button></div>
            <div className="dvw-git-detail-meta"><code title={loadedDetail.hash}>{shortHash(loadedDetail.hash)}</code> · {loadedDetail.author} &lt;{loadedDetail.email}&gt; · {new Date(loadedDetail.date).toLocaleString()}</div>
            {loadedDetail.body !== '' && <pre className="dvw-git-detail-body">{renderMessage(loadedDetail.body, view.emoji)}</pre>}
            <div className="dvw-git-detail-files">{loadedDetail.files.length === 0 && <div className="dvw-git-detail-empty">这次提交没有文件变化</div>}{loadedDetail.files.map(file => fileRow(file, { kind: 'commit', hash: loadedDetail.hash }))}</div>
          </div>
        : <div className="dvw-git-detail">
            <div className="dvw-git-detail-head"><span className="dvw-git-detail-title">读取中…</span><button className="dvw-icon" title="关闭详情" aria-label="关闭详情" onClick={closeDetail}><Icon name="close"/></button></div>
          </div>
  return <div className="dvw-gittab">
    <div className="dvw-gittab-toolbar">
      <Icon name="git-branch"/>
      <span className="dvw-gittab-branch">{status?.branch ?? '…'}</span>
      <span className="dvw-gittab-meta">↑{status?.ahead ?? 0} ↓{status?.behind ?? 0} · {visibleCommits.length} 个提交</span>
      <div className="dvw-gittab-actions">
        {findOpen && <input ref={findInput} className="dvw-input dvw-gittab-find" value={find} placeholder="查找提交（消息 / 作者 / 哈希 / 引用）" aria-label="查找提交" onChange={event => setFind(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { setFindOpen(false); setFind(''); (event.target as HTMLInputElement).blur() } }}/>}
        <button className="dvw-icon" data-active={findOpen || undefined} title="查找提交 (Ctrl+F)" aria-label="查找提交" onClick={() => { setFindOpen(value => !value); window.setTimeout(() => findInput.current?.focus(), 0) }}><Icon name="search"/></button>
        <button className="dvw-icon" data-active={branchFilter.size > 0 || undefined} title={branchFilter.size > 0 ? `分支过滤（已选 ${branchFilter.size} 个）` : '分支过滤'} aria-label="分支过滤" onClick={() => void openFilterPicker()}><Icon name="git-branch"/></button>
        <button className="dvw-icon" data-active={allCommits || undefined} title={allCommits ? '仅显示当前分支' : '显示全部分支'} aria-label={allCommits ? '仅显示当前分支' : '显示全部分支'} aria-pressed={allCommits} onClick={() => setAllCommits(value => !value)}><Icon name="graph"/></button>
        <button className="dvw-icon" title="仓库设置" aria-label="仓库设置" onClick={() => setRepoSettings(true)}><Icon name="settings"/></button>
        <button className="dvw-icon" title="刷新提交图" aria-label="刷新提交图" disabled={busy} onClick={() => void refresh()}><Icon name="refresh"/></button>
        <button className="dvw-icon" title="更多操作" aria-label="更多操作" aria-haspopup="menu" onClick={event => setMenu({ kind: 'toolbar', x: event.clientX, y: event.clientY })}><Icon name="ellipsis"/></button>
      </div>
    </div>
    {error !== undefined && <div className="dvw-error"><button className="dvw-icon" onClick={() => setError(undefined)}><Icon name="close"/></button>{error}</div>}
    {busy && <div className="dvw-search-progress" role="progressbar" aria-label="正在执行 git 操作"/>}
    <div className="dvw-gitgraph-body">
      <div className="dvw-gitgraph-list dvw-graph-list" ref={listRef} aria-label="提交列表">
        <div className="dvw-graph-header">
          <span className="dvw-graph-header-subject">提交</span>
          {view.showAuthor && <span className="dvw-graph-header-col" style={{ width: view.authorWidth }}>作者<span className="dvw-col-resize" title="拖动调整列宽" onPointerDown={event => { event.preventDefault(); drag.current = { column: 'authorWidth', startX: event.clientX, startWidth: view.authorWidth } }}/></span>}
          {view.showDate && <span className="dvw-graph-header-col" style={{ width: view.dateWidth }}>日期<span className="dvw-col-resize" title="拖动调整列宽" onPointerDown={event => { event.preventDefault(); drag.current = { column: 'dateWidth', startX: event.clientX, startWidth: view.dateWidth } }}/></span>}
          {view.showHash && <span className="dvw-graph-header-col dvw-graph-hash" style={{ width: view.hashWidth }}>哈希<span className="dvw-col-resize" title="拖动调整列宽" onPointerDown={event => { event.preventDefault(); drag.current = { column: 'hashWidth', startX: event.clientX, startWidth: view.hashWidth } }}/></span>}
        </div>
        {graphList.length === 0 ? <div className="dvw-gittab-empty">{commits.length === 0 ? '还没有提交' : '没有匹配的提交'}</div> : graphList.map(entry => {
          if (entry.kind === 'uncommitted') return renderUncommitted()
          if (entry.kind === 'stash') { const stash = stashes[entry.index]; return stash === undefined ? null : renderStash(stash) }
          const row = rows[entry.index]; return row === undefined ? null : renderCommit(row)
        })}
      </div>
      {details !== undefined && <aside className="dvw-gitgraph-detail" aria-label="提交详情">{details}</aside>}
    </div>
    {menu !== undefined && <ContextMenu position={{ x: menu.x, y: menu.y }} label={menuLabel} entries={menuEntries()} onClose={() => setMenu(undefined)}/>}
    {commands.pickerElement}
    {filterPicker && <QuickPick title="分支过滤" placeholder="搜索分支（点一行勾选/取消）" items={filterItems}
      selectedIds={[...branchFilter]} onToggle={item => setBranchFilter(current => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next })}
      emptyText="没有分支" onClose={() => setFilterPicker(false)}/>}
    {tagPicker !== undefined && <QuickPick title="标签详情" placeholder="搜索标签" items={tagPicker.map(tag => ({ id: tag.name, label: tag.name, detail: tag.hash }))} emptyText="没有标签"
      onPick={item => { setTagPicker(undefined); void api<GitTagDetail>('git.action', { sessionId, action: 'tag.detail', value: item.id }).then(setTagDetail).catch(cause => setError(String(cause))) }} onClose={() => setTagPicker(undefined)}/>}
    {tagDetail !== undefined && <div className="dvw-quickpick-backdrop" onMouseDown={() => setTagDetail(undefined)}>
      <div className="dvw-quickpick dvw-git-dialog" role="dialog" aria-label="标签详情" onMouseDown={event => event.stopPropagation()}>
        <div className="dvw-git-dialog-head"><span>标签 {tagDetail.name}</span><button className="dvw-icon" title="关闭" aria-label="关闭" onClick={() => setTagDetail(undefined)}><Icon name="close"/></button></div>
        <div className="dvw-git-dialog-section">{tagDetail.objectType === 'tag' ? '附注标签' : '轻量标签'}</div>
        {tagDetail.tagger !== undefined && <div className="dvw-git-dialog-row"><span className="dvw-git-dialog-name">打标签人</span><span>{tagDetail.tagger}{tagDetail.email === undefined ? '' : ` <${tagDetail.email}>`}</span></div>}
        {tagDetail.date !== undefined && <div className="dvw-git-dialog-row"><span className="dvw-git-dialog-name">日期</span><span>{new Date(tagDetail.date).toLocaleString()}</span></div>}
        <div className="dvw-git-dialog-row"><span className="dvw-git-dialog-name">提交</span><span><code>{shortHash(tagDetail.commit)}</code></span></div>
        <pre className="dvw-git-detail-body">{tagDetail.message === '' ? '（没有说明）' : renderMessage(tagDetail.message, false)}</pre>
      </div>
    </div>}
    {pullPicker !== undefined && <QuickPick title="拉取请求的目标分支" placeholder="搜索分支" items={pullPicker.local.filter(name => name !== (status?.branch ?? '')).map(name => ({ id: name, label: name }))} emptyText="没有可用的目标分支"
      onPick={item => { setPullPicker(undefined); setPullBase(item.id); launchPullRequest(item.id) }} onClose={() => setPullPicker(undefined)}/>}
    {repoSettings && <GitRepositorySettings busy={busy} remotes={remoteList} view={view} issue={issueConfig} provider={links.provider} pullBase={pullBase} onClose={() => setRepoSettings(false)}
      onSaveIssue={config => setIssueConfig(config)}
      onSavePullBase={value => setPullBase(value)}
      onCreatePullRequest={() => void createPullRequest()}
      onSaveRemote={(name, url) => void run('remote.set', name, url)}
      onRemoveRemote={name => void run('remote.remove', undefined, name)}
      onFetchRemote={name => void run('remote.fetch', name)}
      onPruneRemote={name => void run('remote.prune', name)}
      onExport={() => { void copyText(JSON.stringify(view)); setRepoSettings(false) }}/>}
  </div>
}
