import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 工作台顶部工作栏与资源管理器外壳的接线测试。
 *
 * 这里只钉住「结构存在且关键行为被接上」：标签页与布局动作的顺序/语义、标签图标、
 * 动作区的双击隔离、资源管理器的定位/折叠/空状态和 Git 徽标。
 * 视觉与真实点击在浏览器 harness 里验收。
 */
function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')
}

const workbench = read('src/client/Workbench.tsx')
const styles = read('src/client/styles.ts')

describe('workbench top bar', () => {
  it('keeps tabs and layout actions in one compact bar', () => {
    const start = workbench.indexOf('<header className="dvw-topbar"')
    const end = workbench.indexOf('</header>', start)
    const header = workbench.slice(start, end)
    expect(start).toBeGreaterThan(-1)
    expect(header).toContain('className="dvw-tab-list" role="tablist"')
    expect(header).toContain('className="dvw-topbar-actions"')
    expect(header.indexOf('dvw-tab-list')).toBeLessThan(header.indexOf('dvw-topbar-actions'))
    expect(header).toContain('onDoubleClick={event=>event.preventDefault()}')
    expect(header).toContain('role="tab"')
    expect(header).toContain('aria-selected={tab.path===active}')
    // 搜索入口已移除；每个标签页必须带文件图标。
    expect(header).not.toContain('dvw-command-center')
    expect(header).toContain('<TabGlyph tab={tab}/>')
  })

  it('renders a file or virtual-tab glyph before the tab name', () => {
    expect(workbench).toContain('function TabGlyph({ tab }: { tab: Tab })')
    expect(workbench).toContain('if (tab.path === GIT_GRAPH_PATH) return <Icon name="graph" className="dvw-tab-icon"/>')
    expect(workbench).toContain('if (tab.diff !== undefined) return <Icon name="diff" className="dvw-tab-icon"/>')
    expect(workbench).toContain('const url = fileIconUrl(name)')
  })
})

describe('explorer shell', () => {
  it('shows the workspace identity and view actions', () => {
    expect(workbench).toContain('className="dvw-side-title"')
    expect(workbench).toContain('className="dvw-side-title-text"')
    expect(workbench).toContain('title="在资源管理器中定位当前文件"')
    expect(workbench).toContain('title="全部折叠"')
    expect(workbench).toContain('onClick={revealActive}')
    expect(workbench).toContain('setExpanded(new Set())')
  })

  it('has a guided empty state and letter badges instead of bare dots', () => {
    expect(workbench).toContain('className="dvw-explorer-empty"')
    expect(workbench).toContain('工作区还没有文件')
    expect(workbench).toContain('className="dvw-explorer-empty-actions"')
    expect(workbench).toContain('aria-label={statusLabel(statuses.get(row.path))}')
    expect(workbench).toContain('data-tree-path={row.path}')
  })

  it('keeps the layout styles for the new shell', () => {
    for (const selector of ['.dvw-topbar{', '.dvw-tab-icon{', '.dvw-topbar-actions{', '.dvw-side-title{', '.dvw-explorer-empty{', '.dvw-tree-status{']) {
      expect(styles).toContain(selector)
    }
    expect(styles).not.toContain('.dvw-command-center')
    expect(styles).toContain('.dvw-topbar[data-compact=true] .dvw-tab')
  })
})
