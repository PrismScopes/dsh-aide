import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { GitGraphTab, GIT_GRAPH_PATH } from '../src/client/GitGraphTab.tsx'
import { GitOutputTab, GIT_OUTPUT_PATH } from '../src/client/GitOutputTab.tsx'
import { clearGitOutput, formatGitOutput, gitOutputEntries, recordGitCommand, subscribeGitOutput } from '../src/client/gitOutput.ts'
import { filterQuickPickItems, type QuickPickItem } from '../src/client/quickPick.tsx'
import { cloneTargetName } from '../src/client/gitCommands.tsx'

const workbench = readFileSync(new URL('../src/client/Workbench.tsx', import.meta.url), 'utf8')

describe('提交图标签页', () => {
  const html = renderToStaticMarkup(<GitGraphTab sessionId="session" initialAllBranches onOpenDiff={() => {}} />)

  it('renders the graph toolbar with scope, refresh and more-actions', () => {
    expect(html).toContain('dvw-gittab')
    expect(html).toContain('aria-label="仅显示当前分支"')
    expect(html).toContain('aria-label="刷新提交图"')
    expect(html).toContain('aria-label="更多操作"')
  })

  it('starts in the all-branches scope when asked to', () => {
    expect(html).toContain('aria-pressed="true"')
    expect(renderToStaticMarkup(<GitGraphTab sessionId="session" onOpenDiff={() => {}} />)).toContain('aria-label="显示全部分支"')
  })

  it('is opened from Workbench as a virtual editor tab, not as a side view', () => {
    expect(workbench).toContain('GIT_GRAPH_PATH')
    expect(workbench).toContain("title:'提交图'")
    expect(workbench).toContain('activeTab.path===GIT_GRAPH_PATH')
    // 入口在 Git 侧边面板里（用户明确要求），活动栏不再多一个图标按钮。
    expect(workbench).not.toContain('data-active={active===GIT_GRAPH_PATH')
    const panel = readFileSync(new URL('../src/client/GitPanel.tsx', import.meta.url), 'utf8')
    expect(panel).toContain('dvw-graph-open')
    expect(GIT_GRAPH_PATH).toBe('git:graph')
  })
})

describe('Git 输出标签页', () => {
  beforeEach(() => clearGitOutput())

  it('shows an empty state before any git command ran', () => {
    const html = renderToStaticMarkup(<GitOutputTab/>)
    expect(html).toContain('Git 输出')
    expect(html).toContain('还没有执行过 git 操作')
    expect(html).toContain('aria-label="清空输出"')
    expect(GIT_OUTPUT_PATH).toBe('git:output')
  })

  it('records commands in a bounded ring and notifies subscribers', () => {
    let changes = 0
    const unsubscribe = subscribeGitOutput(() => { changes++ })
    recordGitCommand({ action: 'status', ok: true })
    recordGitCommand({ action: 'push', ok: false, message: '认证失败' })
    expect(changes).toBe(2)
    expect(gitOutputEntries()).toHaveLength(2)
    expect(gitOutputEntries()[0]).toMatchObject({ action: 'push', ok: false, message: '认证失败' })
    expect(formatGitOutput(gitOutputEntries()[1]!)).toContain('git status')
    expect(formatGitOutput(gitOutputEntries()[0]!)).toContain('✗ 认证失败')
    for (let index = 0; index < 250; index++) recordGitCommand({ action: 'fetch', ok: true })
    expect(gitOutputEntries()).toHaveLength(200)
    unsubscribe()
    clearGitOutput()
    expect(gitOutputEntries()).toHaveLength(0)
  })
})

describe('快速选择框', () => {
  const items: QuickPickItem[] = [
    { id: 'main', label: 'main', current: true },
    { id: 'feature/x', label: 'feature/x', detail: '远程' },
    { id: 'v0.3.1', label: 'v0.3.1' },
  ]

  it('filters by label and detail, case-insensitively, keeping order', () => {
    expect(filterQuickPickItems(items, '')).toEqual(items)
    expect(filterQuickPickItems(items, 'MAI').map(item => item.id)).toEqual(['main'])
    expect(filterQuickPickItems(items, '远程').map(item => item.id)).toEqual(['feature/x'])
    expect(filterQuickPickItems(items, 'zzz')).toEqual([])
  })

  it('derives a clone target directory from the repository URL', () => {
    expect(cloneTargetName('https://github.com/PrismScopes/dsh-aide.git')).toBe('dsh-aide')
    expect(cloneTargetName('git@github.com:owner/repo.git')).toBe('repo')
    expect(cloneTargetName('https://example.com/team/repo/')).toBe('repo')
    expect(cloneTargetName('')).toBe('repository')
  })
})
