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

describe('提交图标签页的 Git Graph 对齐项', () => {
  const html = renderToStaticMarkup(<GitGraphTab sessionId="session" onOpenDiff={() => {}} />)
  const source = readFileSync(new URL('../src/client/GitGraphTab.tsx', import.meta.url), 'utf8')

  it('has find and branch-filter entries on the toolbar', () => {
    expect(html).toContain('aria-label="查找提交"')
    expect(html).toContain('aria-label="分支过滤"')
    expect(html).toContain('aria-label="提交列表"')
  })

  it('loads commit details and comparisons from the new host actions', () => {
    expect(source).toContain("action: 'commit.detail'")
    expect(source).toContain("action: 'compare.files'")
    expect(source).toContain("action: 'range.file.diff'")
    expect(source).toContain('dvw-gitgraph-detail')
  })

  it('shows uncommitted changes and stashes as graph rows', () => {
    expect(source).toContain('未提交的更改')
    expect(source).toContain('stash.list')
    expect(source).toContain('dvw-stash-row')
  })

  it('binds the Git Graph keyboard shortcuts', () => {
    expect(source).toContain("key === 'f'")
    expect(source).toContain("key === 'r'")
    expect(source).toContain("key === 'h'")
    expect(source).toContain("event.key === 'ArrowDown'")
    expect(source).toContain('Ctrl+F')
  })
})
describe('提交图的 Git Graph 剩余项', () => {
  const source = readFileSync(new URL('../src/client/GitGraphTab.tsx', import.meta.url), 'utf8')
  const settings = readFileSync(new URL('../src/client/GitRepositorySettings.tsx', import.meta.url), 'utf8')

  it('renders configurable columns and resizable headers', () => {
    expect(source).toContain('dvw-graph-header')
    expect(source).toContain('dvw-col-resize')
    expect(source).toContain('parseGitViewSettings')
    expect(source).toContain('gitViewStorageKey')
  })

  it('persists code-review marks and shows progress', () => {
    expect(source).toContain('dvw-review-toggle')
    expect(source).toContain('reviewScopeKey')
    expect(source).toContain('reviewProgress')
  })

  it('creates pull requests and stores the issue link config per repository', () => {
    expect(source).toContain('pullRequestUrl')
    expect(source).toContain("window.open(url, '_blank'")
    expect(source).toContain('issueLinkStorageKey')
    expect(source).toContain('resolveIssueLinks')
    expect(source).toContain('dvw:git-pr-base:v1:')
    expect(settings).toContain('拉取请求')
    expect(settings).toContain('Issue 链接')
  })
  it('loads tag details, remotes and the repository settings dialog', () => {
    expect(source).toContain("action: 'tag.detail'")
    expect(source).toContain("action: 'remote.list'")
    expect(source).toContain('GitRepositorySettings')
    expect(settings).toContain('onFetchRemote')
    expect(settings).toContain('onPruneRemote')
    expect(settings).toContain('导出视图配置')
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
