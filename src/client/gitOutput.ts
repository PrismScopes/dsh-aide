/**
 * Git 输出记录（侧栏面板与提交图标签页共用）。
 *
 * VS Code 的「显示 Git 输出」会打开输出通道；这里没有输出通道，就把工作台自己发起的每条
 * git 动作记在内存环形缓冲里，并在编辑器里开一个只读标签页展示。它解决的是「刚才那条命令
 * 为什么失败」——错误条只显示最后一条，而且很快会被下一次操作覆盖。
 */

export interface GitOutputEntry {
  at: number
  action: string
  path?: string
  value?: string
  ok: boolean
  message?: string
}

const LIMIT = 200
let entries: GitOutputEntry[] = []
const listeners = new Set<() => void>()

function emit(): void { for (const listener of listeners) listener() }

/** 记录一条 git 动作；超过上限丢弃最旧的。 */
export function recordGitCommand(entry: Omit<GitOutputEntry, 'at'>): void {
  entries = [{ ...entry, at: Date.now() }, ...entries].slice(0, LIMIT)
  emit()
}

export function gitOutputEntries(): readonly GitOutputEntry[] { return entries }

export function clearGitOutput(): void { entries = []; emit() }

export function subscribeGitOutput(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 一行输出文本：`12:03:44  git status` / 失败时附带错误信息。 */
export function formatGitOutput(entry: GitOutputEntry): string {
  const time = new Date(entry.at).toLocaleTimeString()
  const target = entry.path === undefined ? '' : ` ${entry.path}`
  const value = entry.value === undefined ? '' : ` ${entry.value}`
  return `${time}  git ${entry.action}${target}${value}${entry.ok ? '' : `  ✗ ${entry.message ?? '失败'}`}`
}
