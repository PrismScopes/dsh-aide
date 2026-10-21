/**
 * Git 输出记录（侧栏面板与提交图标签页共用）。
 *
 * VS Code 的「显示 Git 输出」会打开输出通道；这里没有输出通道，就把工作台自己发起的每条
 * git 动作记在内存环形缓冲里，并在编辑器里开一个只读标签页展示。它解决的是「刚才那条命令
 * 为什么失败」——错误条只显示最后一条，而且很快会被下一次操作覆盖。
 *
 * 同一条记录还会追加到「输出」面板的 Git 通道（见 output.ts），两条路径共享同一份格式化逻辑。
 */
import { appendOutput } from './output.ts'

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
  const value: GitOutputEntry = { ...entry, at: Date.now() }
  entries = [value, ...entries].slice(0, LIMIT)
  appendOutput('git', gitOutputText(value), value.ok ? 'info' : 'warn')
  emit()
}

export function gitOutputEntries(): readonly GitOutputEntry[] { return entries }

export function clearGitOutput(): void { entries = []; emit() }

export function subscribeGitOutput(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 一行输出文本（不含时间）：`git status` / 失败时附错误信息。 */
export function gitOutputText(entry: GitOutputEntry): string {
  const target = entry.path === undefined ? '' : ` ${entry.path}`
  const value = entry.value === undefined ? '' : ` ${entry.value}`
  return `git ${entry.action}${target}${value}${entry.ok ? '' : `  ✗ ${entry.message ?? '失败'}`}`
}

/** 编辑器「Git 输出」标签页用的整行文本：带上时间。 */
export function formatGitOutput(entry: GitOutputEntry): string {
  return `${new Date(entry.at).toLocaleTimeString()}  ${gitOutputText(entry)}`
}
