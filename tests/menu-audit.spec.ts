import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 右键菜单的「体检」测试。
 *
 * 用户对上一版的直接抱怨是「代码界面的右键菜单甚至是英文」，所以这里把两件容易回退的事钉死：
 *   1. **菜单文案必须含中文** —— 扫描三个菜单数据模块里所有 `label: '...'` 字面量，不含 CJK 就算失败；
 *      纯静态扫描而不是逐个构造上下文，是因为菜单项数量多、构造条件杂，漏一个就可能漏一句英文。
 *   2. **portal 菜单的样式前提** —— 菜单渲染到 document.body，拿不到 `.dvw-overlay` 作用域里的自定义
 *      属性；令牌必须定义在 body 上、z-index 必须高于 overlay（100），否则菜单会透明并且被工作台盖住。
 */

const read = (path: string): string => readFileSync(new URL(`../src/client/${path}`, import.meta.url), 'utf8')
const CJK = /[\u4e00-\u9fff]/

/** 抓出所有 `label: '...'` 字面量；类型声明里的 `label: string` 没有引号，不会被误抓。 */
function labels(source: string): string[] {
  const found: string[] = []
  const pattern = /label:\s*'([^']*)'/g
  for (const match of source.matchAll(pattern)) found.push(match[1] ?? '')
  return found
}

describe('right-click menus stay Chinese', () => {
  for (const file of ['menus.ts', 'editorMenus.ts', 'gitMenus.ts'] as const) {
    it(`${file} 的每个菜单标签都含中文`, () => {
      const found = labels(read(file))
      // 菜单模块必须真的有标签：正则写坏了会静默通过，所以先要求数量。
      expect(found.length).toBeGreaterThan(5)
      const english = found.filter(label => !CJK.test(label))
      expect(english).toEqual([])
    })
  }

  it('ContextMenu 自身没有硬编码的英文文案', () => {
    // 菜单壳里只有 aria-label 由调用方给，出现英文 label 说明有人把文案写进了壳。
    expect(labels(read('ContextMenu.tsx'))).toEqual([])
  })
})

describe('portal menu can be styled outside the overlay', () => {
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')

  it('把 --dvw-* 令牌定义在 body 上（菜单 portal 到 body）', () => {
    const bodyRule = /body\{[^}]*--dvw-base:/.exec(styles)
    expect(bodyRule).not.toBeNull()
    // 令牌不能再只挂在 .dvw-overlay 里。
    expect(/\.dvw-overlay\{[^}]*--dvw-base:/.test(styles)).toBe(false)
  })

  it('菜单层级高于工作台 overlay（100）、低于 DSH 设置面板（1000）', () => {
    const match = /\.dvw-menu\{[^}]*z-index:(\d+)/.exec(styles)
    expect(match).not.toBeNull()
    const zIndex = Number(match?.[1])
    expect(zIndex).toBeGreaterThan(100)
    expect(zIndex).toBeLessThan(1000)
  })
})
