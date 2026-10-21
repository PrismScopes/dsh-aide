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

  it('disposes the orphaned loop and key listeners when the tab is closed', () => {
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

  it('renders the upstream component inside an editor tab, without its own window chrome', () => {
    const source = read('../src/client/DinoGame.tsx')
    expect(source).toContain("from './dinoComponent.ts'")
    expect(source).toContain('<Dino/>')
    expect(source).toContain('dvw-dino-stage')
    // 标签页由标签栏负责标题与关闭，组件里不再有标题栏 / 退出按钮。
    expect(source).not.toContain('dvw-dino-bar')
    expect(source).not.toContain('退出小游戏')
    // 卸载时清理：否则切走后循环还在跑、编辑器里的空格还会打到残留实例上。
    expect(source).toContain('disposeDinoRunner(')
    // 虚拟标签路径（不读磁盘文件）。
    expect(source).toContain("export const DINO_PATH = 'dino:game'")
  })

  it('opens as a virtual editor tab, not as a separate window over the empty state', () => {
    const workbench = read('../src/client/Workbench.tsx')
    // 空状态里只有那一行小字是入口，点击开标签页。
    expect(workbench).toContain('或者，你想试试玩谷歌小恐龙吗？')
    expect(workbench).toContain('className="dvw-dino-teaser" onClick={()=>openDino()}')
    // 虚拟标签：与提交图/Git 输出同一套语义。
    expect(workbench).toContain("title:'小恐龙'")
    expect(workbench).toContain('activeTab.path===DINO_PATH?<DinoGame/>')
    // 不再有「整块空状态换成游戏」的独立窗口分支。
    expect(workbench).not.toContain('setDino(')
    expect(workbench).not.toContain('<DinoGame onExit')
  })

  it('highlights only the text of the teaser line, never a background block', () => {
    const styles = read('../src/client/styles.ts')
    const hover = /\.dvw-dino-teaser:hover\{([^}]*)\}/.exec(styles)
    expect(hover).not.toBeNull()
    expect(hover?.[1]).toContain('color:var(--dvw-accent)')
    expect(hover?.[1]).not.toContain('background')
  })

  it('keeps the dino tab across hide/show and reload like the other virtual tabs', () => {
    const workbench = read('../src/client/Workbench.tsx')
    expect(workbench).toContain('[GIT_GRAPH_PATH,GIT_OUTPUT_PATH,DINO_PATH]')
    expect(workbench).toContain("if(tab.path===DINO_PATH)return {...unloadedTab(tab.path),title:'小恐龙'")
  })
})
