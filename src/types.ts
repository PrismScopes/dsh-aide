/** One directory entry returned by the workbench host. */
export interface FileEntry { name: string; path: string; kind: 'file' | 'directory'; size?: number; mtimeMs?: number }
/** A text file together with its optimistic-concurrency revision. */
export interface FileDocument { path: string; content: string; revision: string; size: number; binary: boolean; tooLarge: boolean }
/** One ripgrep match. */
export interface SearchMatch { path: string; line: number; column: number; preview: string; match: string }
/**
 * Search request flags.
 *
 * 三个上限都是可选覆盖：不传时用 host.ts 的默认值（单次搜索最多 2000 条匹配 / rg stdout 2 MiB /
 * 单文件 2 MiB）。客户端目前不传，保留字段主要是给测试与将来「更严格的搜索」用。
 */
export interface SearchRequest {
  query: string
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
  include?: string
  exclude?: string
  /** 全局匹配条数上限（不是每文件）。 */
  maxMatches?: number
  /** ripgrep stdout 字节上限；达到后 kill rg 并丢弃剩余输出。 */
  maxOutputBytes?: number
  /** 单文件大小上限（字节）；超过的文件在 rg 侧跳过。 */
  maxFileSize?: number
}
/**
 * Search results with an explicit truncation flag.
 *
 * `limited` 是旧字段（客户端用它显示「结果已截断到 2000 条」），本轮保持语义不变；
 * `truncated` 是新增的稳定语义字段，两者当前同值（匹配条数上限或 stdout 字节上限触发时为 true）。
 */
export interface SearchResult { matches: SearchMatch[]; limited: boolean; truncated: boolean }
/**
 * 替换请求：在搜索请求之上加「替换成什么」。
 *
 * 与 VS Code 一致，替换按**行内**语义执行（ripgrep 默认也是行内匹配）：
 * `regex` 为 false 时查询串按字面量处理，为 true 时支持 `$1`/`$&` 这类 JS 替换模式。
 */
export interface SearchReplaceRequest extends SearchRequest {
  /** 替换文本；允许空串（即删除命中）。 */
  replace: string
  /** 保留大小写：命中全大写/全小写/首字母大写时，替换结果跟随同样形态。 */
  preserveCase?: boolean
  /** 只替换这一处（行列与某条搜索命中一致）；缺省替换范围内的全部命中。 */
  only?: { path: string; line: number; column: number }
}

/** 替换结果：被改写的文件与替换总处数（没有命中时两者都为空/0）。 */
export interface SearchReplaceResult { files: string[]; replacements: number }
/** One working tree change. */
export interface GitChange { path: string; originalPath?: string; index: string; worktree: string; staged: boolean; untracked: boolean }
/**
 * 提交详情里单个文件的统计（提交详情面板用）。
 *
 * 与 GitCommitFile 的区别是带上了 +/− 行数：diff-tree/diff 的 --numstat 输出。
 */
export interface GitCommitFileDetail { path: string; previousPath?: string; status: string; additions: number; deletions: number; binary: boolean }
/** 一次提交的完整信息：作者、日期、完整说明正文，以及带增删行数的文件列表。 */
export interface GitCommitDetail { hash: string; parents: string[]; author: string; email: string; date: string; subject: string; body: string; files: GitCommitFileDetail[] }

/** 标签详情（附注标签才有 tagger 与 message；轻量标签只有 commit 与 objectType）。 */
export interface GitTagDetail { name: string; objectType: string; commit: string; tagger?: string; email?: string; date?: string; message: string }
/** 一个远程（`git remote -v` 的 fetch 行）。 */
export interface GitRemote { name: string; url: string }

/** Local repository state. */
export interface GitStatus { repository: string; branch: string; ahead: number; behind: number; changes: GitChange[]; /** 是否有变基正在进行（决定「中止变基」是否可点）。 */ rebase: boolean }
/**
 * 分支清单（分支选择器用）。
 *
 * `remote` 里的名字是 `origin/main` 这种完整短名：签出远程分支时宿主会退回
 * `switch --track`，客户端不用自己拼本地分支名。
 */
export interface GitBranchList { current: string; local: string[]; remote: string[] }
/** One commit displayed by the source-control graph. */
export interface GitCommit { hash: string; parents: string[]; author: string; date: string; subject: string; refs: string[] }
/** One path changed by a local commit. */
export interface GitCommitFile { path: string; previousPath?: string; status: string }
/** Unified patch and full texts used by the Monaco diff editor. */
export interface GitDiff { diff: string; original: string; modified: string }
/** 一条贮藏记录（`git stash list`）。 */
export interface GitStash { index: number; message: string; date: string }
/** 一个标签（`git for-each-ref refs/tags`）。 */
export interface GitTag { name: string; hash: string; subject: string }
