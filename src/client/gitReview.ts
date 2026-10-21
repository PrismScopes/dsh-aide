/**
 * 代码审查（哪些文件已经看过）的持久化。
 *
 * 原版 Git Graph 把「已读/未读」存进 VS Code 的 workspaceState 并 90 天自动关闭；
 * 这里按「仓库 + 审查范围」存 localStorage，同样 90 天没再动过的记录在读取时清掉。
 * 纯函数便于测试：存储读写由调用方注入（浏览器里是 localStorage）。
 */

/** 审查范围：某次提交、或两个提交的对比。 */
export type ReviewScope = { kind: 'commit'; hash: string } | { kind: 'compare'; from: string; to: string }

/** 一条审查记录：文件路径 → 标记已读的时间戳（ms）。 */
export type ReviewFiles = Record<string, number>
/** 全部审查记录：scope key → 文件记录。 */
export type ReviewStore = Record<string, ReviewFiles>

export const REVIEW_TTL_MS = 90 * 24 * 60 * 60 * 1000

export function reviewScopeKey(scope: ReviewScope): string {
  return scope.kind === 'commit' ? 'commit:' + scope.hash : 'compare:' + scope.from + '..' + scope.to
}

/** 解析持久化 JSON；坏数据回落空对象（不能因为一条脏记录让整个审查功能失效）。 */
export function parseReviewStore(raw: string | null): ReviewStore {
  if (raw === null || raw === '') return {}
  let value: unknown
  try { value = JSON.parse(raw) } catch { return {} }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const store: ReviewStore = {}
  for (const [scope, files] of Object.entries(value as Record<string, unknown>)) {
    if (files === null || typeof files !== 'object' || Array.isArray(files)) continue
    const record: ReviewFiles = {}
    for (const [path, at] of Object.entries(files as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at)) record[path] = at
    }
    if (Object.keys(record).length > 0) store[scope] = record
  }
  return store
}

/** 丢掉超过 TTL 的文件记录；整个范围都过期时连范围一起丢。 */
export function pruneReviewStore(store: ReviewStore, now: number): ReviewStore {
  const next: ReviewStore = {}
  for (const [scope, files] of Object.entries(store)) {
    const kept: ReviewFiles = {}
    for (const [path, at] of Object.entries(files)) if (now - at <= REVIEW_TTL_MS) kept[path] = at
    if (Object.keys(kept).length > 0) next[scope] = kept
  }
  return next
}

/** 标记一个文件已读/未读，返回新的 store（不修改入参，便于 React 状态更新）。 */
export function markReviewed(store: ReviewStore, scopeKey: string, path: string, reviewed: boolean, now: number): ReviewStore {
  const next: ReviewStore = { ...store }
  const files: ReviewFiles = { ...(next[scopeKey] ?? {}) }
  if (reviewed) files[path] = now
  else delete files[path]
  if (Object.keys(files).length === 0) delete next[scopeKey]
  else next[scopeKey] = files
  return next
}

export function isReviewed(store: ReviewStore, scopeKey: string, path: string): boolean {
  return store[scopeKey]?.[path] !== undefined
}

/** 已读进度：用于「已读 3/8」这样的提示。 */
export function reviewProgress(store: ReviewStore, scopeKey: string, paths: readonly string[]): { reviewed: number; total: number } {
  let reviewed = 0
  for (const path of paths) if (isReviewed(store, scopeKey, path)) reviewed++
  return { reviewed, total: paths.length }
}

/** 按仓库分别保存审查记录（不同仓库的提交哈希理论上可能碰撞）。 */
export function reviewStorageKey(repository: string): string {
  return 'dvw:git-review:v1:' + repository
}
