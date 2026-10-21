import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolveDinoComponent, disposeDinoRunner } from '../src/client/dinoComponent.ts'

/** 断言只读源码/包清单与纯解析函数；不 import 组件本身：react-chrome-dino 是纯浏览器组件（挂载时才碰 window）。 */
const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

const FakeDino = () => null

describe('小恐龙彩蛋（复用 react-chrome-dino）', () => {
  it('depends on the MIT package instead of carrying a vendored implementation', () => {
    const pkg = JSON.parse(read('../package.json')) as { dependencies: Record<string, string> }
    expect(pkg.dependencies['react-chrome-dino']).toBe('0.1.3')
    // 之前的自绘/vendored 实现已经清掉。
    expect(() => read('../dino/index.html')).toThrow()
    expect(() => read('../src/client/dino.ts')).toThrow()
  })

  it('resolves both interop shapes: browser bundle object and ESM function', () => {
    // Vite/vitest（ESM）：default 就是组件。
    expect(resolveDinoComponent({ default: FakeDino, __esModule: true })).toBe(FakeDino)
    // rolldown 产物（CJS→ESM, isNodeMode）：default 是整个 module.exports，组件在再下一层。
    // 这是 v0.4.3「小恐龙打不开」真正的形状：React 收到对象会抛 Element type is invalid。
    expect(resolveDinoComponent({ default: { default: FakeDino, __esModule: true } })).toBe(FakeDino)
    // 命名空间本身就是组件也认。
    expect(resolveDinoComponent(FakeDino)).toBe(FakeDino)
  })

  it('returns undefined instead of a bogus element type when the export is unrecognisable', () => {
    expect(resolveDinoComponent(undefined)).toBeUndefined()
    expect(resolveDinoComponent({})).toBeUndefined()
    expect(resolveDinoComponent({ default: 42 })).toBeUndefined()
    expect(resolveDinoComponent({ default: { default: { default: { default: 1 } } } })).toBeUndefined()
  })

  it('disposes the orphaned loop and key listeners when the easter egg is closed', () => {
    const raq = (): void => { throw new Error('不应该再排帧了') }
    const handleEvent = (): void => { throw new Error('不应该再响应按键了') }
    const runner = { prototype: { raq: raq as () => void, handleEvent: handleEvent as (event: Event) => void } }
    disposeDinoRunner(runner)
    expect(runner.prototype.raq).not.toBe(raq)
    expect(runner.prototype.handleEvent).not.toBe(handleEvent)
    expect(() => runner.prototype.raq()).not.toThrow()
    // 没打开过游戏（window.Runner 不存在）时是安全的空操作。
    expect(() => disposeDinoRunner(undefined)).not.toThrow()
    expect(() => disposeDinoRunner({})).not.toThrow()
  })

  it('lays the stage out as a block so the upstream canvas keeps a width', () => {
    // 上游根节点是自动宽度的块，里面有 width:100% 的 .interstitial-wrapper；
    // 父级一旦 display:flex，两者互相依赖会塌成 0 宽（画布宽度 0 = 游戏看不见）。
    const styles = read('../src/client/styles.ts')
    const rule = /\.dvw-dino-stage\{([^}]*)\}/.exec(styles)
    expect(rule).not.toBeNull()
    expect(rule?.[1]).not.toContain('display:flex')
  })

  it('renders the upstream component inside the whole editor panel', () => {
    const source = read('../src/client/DinoGame.tsx')
    expect(source).toContain("from './dinoComponent.ts'")
    expect(source).toContain('<Dino/>')
    expect(source).toContain('dvw-dino-stage')
    expect(source).toContain('aria-label="退出小游戏"')
    // 卸载时清理：否则离场后循环还在跑、编辑器里的空格还会打到残留实例上。
    expect(source).toContain('disposeDinoRunner(')
  })

  it('is triggered by hovering the teaser line only, not by clicking the whole empty state', () => {
    const source = read('../src/client/Workbench.tsx')
    expect(source).toContain('或者，你想试试玩谷歌小恐龙吗？')
    expect(source).toContain('<DinoGame onExit')
    expect(source).toContain('className="dvw-dino-teaser" onClick={()=>setDino(true)}')
    expect(source).not.toContain('onClick={()=>setDino(true)} onKeyDown=')
  })
})
