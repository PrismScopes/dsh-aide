import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 工作台顶部工作栏与资源管理器外壳的接线测试。
 *
 * 这里只钉住「结构存在且关键行为被接上」：命令入口打开搜索并聚焦、顶部三段的
 * 顺序/响应式属性、动作区的双击隔离、资源管理器的定位/折叠/空状态和 Git 徽标。
 * 视觉与真实点击在浏览器 harness 里验收。
 */
function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')
}

const workbench = read('src/client/Workbench.tsx')
const styles = read('src/client/styles.ts')

describe('workbench top bar', () => {
  it('keeps a three-section bar: command entry, editor tabs, layout actions', () => {
    const start = workbench.indexOf('<header className="dvw-topbar"')
    const end = workbench.indexOf('</header>', start)
    const header = workbench.slice(start, end)
    expect(start).toBeGreaterThan(-1)
    expect(header).toContain('className="dvw-topbar-left"')
    expect(header).toContain('className="dvw-tab-list" role="tablist"')
    expect(header).toContain('className="dvw-topbar-actions"')
    expect(header.indexOf('dvw-topbar-left')).toBeLessThan(header.indexOf('dvw-tab-list'))
    expect(header.indexOf('dvw-tab-list')).toBeLessThan(header.indexOf('dvw-topbar-actions'))
    expect(header).toContain('onDoubleClick={event=>event.preventDefault()}')
    expect(header).toContain('role="tab"')
    expect(header).toContain('aria-selected={tab.path===active}')
  })

  it('opens search from the command entry and adapts to its own width', () => {
    expect(workbench).toContain('const openSearch = (): void =>')
    expect(workbench).toContain("window.dispatchEvent(new Event('dvw-focus-search'))")
    expect(workbench).toContain('new ResizeObserver(update)')
    expect(workbench).toContain('data-compact={topbarCompact||undefined}')
    expect(workbench).toContain('topbarCompact')
    // 搜索视图已经挂载时，autoFocus 不会重跑；必须由事件把焦点拉回输入框。
    expect(workbench).toContain("window.addEventListener('dvw-focus-search', focus)")
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
    for (const selector of ['.dvw-topbar{', '.dvw-command-center{', '.dvw-topbar-actions{', '.dvw-side-title{', '.dvw-explorer-empty{', '.dvw-tree-status{']) {
      expect(styles).toContain(selector)
    }
    expect(styles).toContain('.dvw-topbar[data-compact=true]')
    expect(styles).toContain('.dvw-topbar[data-compact=true] .dvw-command-center>span')
  })
})
