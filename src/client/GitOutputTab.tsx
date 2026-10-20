import { useEffect, useState } from 'react'
import { Icon } from './Icon.tsx'
import { clearGitOutput, formatGitOutput, gitOutputEntries, subscribeGitOutput, type GitOutputEntry } from './gitOutput.ts'

/** 编辑器里「Git 输出」标签页的内部路径。 */
export const GIT_OUTPUT_PATH = 'git:output'

/**
 * 只读的 git 动作记录。
 *
 * 只显示本地工作台发起的动作（面板、提交图标签页），不包含 agent 在终端里跑的 git 命令 ——
 * 那是另一条通道，混进来反而会让「我刚才点了什么」更难找。
 */
export function GitOutputTab() {
  const [entries, setEntries] = useState<readonly GitOutputEntry[]>(() => gitOutputEntries())
  useEffect(() => subscribeGitOutput(() => setEntries(gitOutputEntries())), [])
  return <div className="dvw-gitout">
    <div className="dvw-gitout-toolbar">
      <Icon name="git-commit"/><span>Git 输出</span>
      <span className="dvw-gitout-count">{entries.length} 条</span>
      <button className="dvw-icon" title="清空输出" aria-label="清空输出" disabled={entries.length === 0} onClick={() => clearGitOutput()}><Icon name="trash"/></button>
    </div>
    <div className="dvw-gitout-list" role="log" aria-label="Git 输出">
      {entries.length === 0
        ? <div className="dvw-gitout-empty">还没有执行过 git 操作</div>
        : entries.map((entry, index) => <div className="dvw-gitout-row" data-error={entry.ok ? undefined : true} key={`${entry.at}-${index}`}>{formatGitOutput(entry)}</div>)}
    </div>
  </div>
}
