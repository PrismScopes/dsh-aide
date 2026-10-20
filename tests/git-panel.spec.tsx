import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Git } from '../src/client/GitPanel.tsx'

/**
 * 源代码管理面板的静态渲染：SSR 里 useEffect 不执行，所以只会画出标题栏，
 * 但足以证明组件本身能渲染（hooks 用错、模块依赖缺失都会在这里炸）。
 * 菜单内容与顺序由 git-menus.spec.ts 断言，提交图算法由 graph.spec.ts 断言。
 */
const html = renderToStaticMarkup(<Git sessionId="session" onDiff={() => {}} onOpenGraph={() => {}} onOpenOutput={() => {}} />)
const source = readFileSync(new URL('../src/client/GitPanel.tsx', import.meta.url), 'utf8')
const commands = readFileSync(new URL('../src/client/gitCommands.tsx', import.meta.url), 'utf8')

describe('源代码管理面板', () => {
  it('draws the title bar with the graph shortcut, refresh and the more-actions menu', () => {
    expect(html).toContain('源代码管理')
    expect(html).toContain('aria-label="打开提交图"')
    expect(html).toContain('aria-label="刷新"')
    expect(html).toContain('aria-label="更多操作"')
    expect(html).toContain('aria-haspopup="menu"')
  })

  it('selects branches through the quick pick instead of window.prompt', () => {
    // 原来的 window.prompt 不能搜索、不能键盘操作，且会阻塞渲染进程。
    expect(commands).toContain('QuickPick')
    expect(source).toContain('useGitCommands')
    expect(source).not.toMatch(/[^.\w]prompt\(/)
    expect(commands).not.toMatch(/window\.prompt\(/)
  })

  it('loads branch and stash lists lazily when a picker opens', () => {
    expect(commands).toContain("action: 'branch.list'")
    expect(commands).toContain("action: 'stash.list'")
    expect(commands).toContain("action: 'tag.list'")
  })

  it('keeps the graph memoised and wires commit actions through the shared menus', () => {
    expect(source).toContain('memo(CommitGraph)')
    expect(source).toContain("'log.all'")
    expect(source).toContain('commands.commitMenu(')
  })
})
