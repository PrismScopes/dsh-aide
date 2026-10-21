import type { GitCommit } from '../types.ts'

/**
 * 提交图的展示规则（纯函数）。
 *
 * `git log --decorate=short` 给出的引用串是混合格式：
 * `HEAD -> main` / `tag: v0.3.1` / `origin/main` / `main`。面板需要把它们分成
 * HEAD、标签、远程分支、本地分支四类来上色 —— 与 VS Code Git Graph 扩展的观感一致。
 */

export type GitRefKind = 'head' | 'tag' | 'remote' | 'branch'

/**
 * 判类。远程分支必须靠远程名判断：本地分支也可以带 `/`（`feature/x`），
 * 直接用「含斜杠」当远程会在 feature 分支上标错。
 */
export function refKind(ref: string, remotes: readonly string[] = []): GitRefKind {
  if (ref === 'HEAD' || ref.startsWith('HEAD -> ')) return 'head'
  if (ref.startsWith('tag: ')) return 'tag'
  return remotes.some(remote => ref.startsWith(`${remote}/`)) ? 'remote' : 'branch'
}

/** 展示名：去掉 `HEAD -> ` 与 `tag: ` 前缀；远程分支保留 `origin/x` 以便区分同名本地分支。 */
export function refLabel(ref: string): string {
  if (ref.startsWith('HEAD -> ')) return ref.slice('HEAD -> '.length)
  if (ref.startsWith('tag: ')) return ref.slice('tag: '.length)
  return ref
}

/** 提交图里的短哈希（与 `git log --oneline` 一样取 7 位）。 */
export function shortHash(hash: string): string { return hash.slice(0, 7) }

/**
 * 提交行的副标题：作者 · 短哈希。
 *
 * 日期不包含在里面：它由调用方按本地格式渲染（测试里不锁 locale），
 * 这里只拼与语言无关的部分。
 */
export function graphSubtitle(commit: Pick<GitCommit, 'author' | 'hash'>): string {
  return `${commit.author} · ${shortHash(commit.hash)}`
}

/**
 * 提交搜索：空格分隔的多个关键词必须全部命中（说明 / 作者 / 哈希 / 引用名）。
 * 与原版 Git Graph 的 Find Widget 一样，大小写不敏感。
 */
export function matchCommit(commit: Pick<GitCommit, 'subject' | 'author' | 'hash' | 'refs'>, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = `${commit.subject} ${commit.author} ${commit.hash} ${commit.refs.join(' ')}`.toLowerCase()
  return words.every(word => haystack.includes(word))
}

/** 按关键词过滤提交（保持原顺序）；空查询返回原数组。 */
export function filterCommits<T extends Pick<GitCommit, 'subject' | 'author' | 'hash' | 'refs'>>(commits: readonly T[], query: string): T[] {
  if (query.trim() === '') return [...commits]
  return commits.filter(commit => matchCommit(commit, query))
}

/**
 * 从给定 tip 哈希沿父提交链向上走，返回**加载窗口内**可达的提交集合。
 *
 * 这是分支过滤的近似：原版 Git Graph 让 host 用 `git log <branches>` 取数，我们已有全部分支的窗口，
 * 就地在窗口内算可达集合，避免为每次勾选再跑一次 git；超出窗口的提交本来也看不到。
 */
export function reachableCommits(commits: readonly Pick<GitCommit, 'hash' | 'parents'>[], tips: readonly string[]): Set<string> {
  const byHash = new Map(commits.map(commit => [commit.hash, commit]))
  const seen = new Set<string>()
  const stack = [...tips]
  while (stack.length > 0) {
    const hash = stack.pop()!
    if (seen.has(hash)) continue
    const commit = byHash.get(hash)
    if (commit === undefined) continue
    seen.add(hash)
    for (const parent of commit.parents) if (!seen.has(parent)) stack.push(parent)
  }
  return seen
}

/** 选中分支名对应的 tip 哈希：引用标签等于分支名，或 `远程名/分支名` 的后半段等于它。 */
export function branchTips(commits: readonly Pick<GitCommit, 'hash' | 'refs'>[], branches: ReadonlySet<string>): string[] {
  if (branches.size === 0) return []
  return commits.filter(commit => commit.refs.some(ref => {
    if (ref.startsWith('tag: ')) return false // 标签不是分支过滤的对象
    const label = refLabel(ref)
    return branches.has(label) || branches.has(label.replace(/^[^/]+\//, ''))
  })).map(commit => commit.hash)
}

/** 提交图列表的条目类型：未提交更改 / 贮藏 / 提交（顺序与原版一致：未提交在最上，然后贮藏，再提交）。 */
export type GraphListKind = 'uncommitted' | 'stash' | 'commit'
export interface GraphListEntry { kind: GraphListKind; index: number }

/** 构造提交图列表条目；`index` 对 stash 是贮藏序号、对 commit 是提交下标（未提交为 -1）。 */
export function buildGraphList(options: { commitCount: number; stashCount: number; hasUncommitted: boolean }): GraphListEntry[] {
  const entries: GraphListEntry[] = []
  if (options.hasUncommitted) entries.push({ kind: 'uncommitted', index: -1 })
  for (let index = 0; index < options.stashCount; index++) entries.push({ kind: 'stash', index })
  for (let index = 0; index < options.commitCount; index++) entries.push({ kind: 'commit', index })
  return entries
}

/**
 * 详情面板该显示什么。
 *
 * 关闭详情时只把 selected 置空、detail 仍然缓存着（下次打开不用重取），如果渲染只看 detail，
 * 就会出现「点了关闭、面板还在」——这就是「关闭详情无效」的根因。视图状态必须同时看 selected。
 */
export type DetailView = 'none' | 'commit-loading' | 'commit' | 'compare-loading' | 'compare'
export function detailViewState(selected: { kind: string } | undefined, hasDetail: boolean, hasCompare: boolean): DetailView {
  if (selected === undefined) return 'none'
  if (selected.kind === 'compare') return hasCompare ? 'compare' : 'compare-loading'
  return hasDetail ? 'commit' : 'commit-loading'
}
