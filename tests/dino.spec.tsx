import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 这些断言只读源码/包清单，不 import 组件：react-chrome-dino 是纯浏览器组件（挂载时才碰 window）。 */
const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

describe('小恐龙彩蛋（复用 react-chrome-dino）', () => {
  it('depends on the MIT package instead of carrying a vendored implementation', () => {
    const pkg = JSON.parse(read('../package.json')) as { dependencies: Record<string, string> }
    expect(pkg.dependencies['react-chrome-dino']).toBe('0.1.3')
    // 之前的自绘/vendored 实现已经清掉。
    expect(() => read('../dino/index.html')).toThrow()
    expect(() => read('../src/client/dino.ts')).toThrow()
  })

  it('renders the upstream component inside the whole editor panel', () => {
    const source = read('../src/client/DinoGame.tsx')
    expect(source).toContain("from 'react-chrome-dino'")
    expect(source).toContain('<Dino/>')
    expect(source).toContain('dvw-dino-stage')
    expect(source).toContain('aria-label="退出小游戏"')
  })

  it('is triggered by hovering the teaser line only, not by clicking the whole empty state', () => {
    const source = read('../src/client/Workbench.tsx')
    expect(source).toContain('或者，你想试试玩谷歌小恐龙吗？')
    expect(source).toContain('<DinoGame onExit')
    expect(source).toContain('className="dvw-dino-teaser" onClick={()=>setDino(true)}')
    expect(source).not.toContain('onClick={()=>setDino(true)} onKeyDown=')
  })
})
