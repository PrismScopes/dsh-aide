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
