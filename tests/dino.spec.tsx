import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DinoGame } from '../src/client/DinoGame.tsx'
import { collides, dinoHighScoreKey, formatScore, nextHighScore, speedFor } from '../src/client/dino.ts'

describe('小恐龙游戏逻辑', () => {
  it('detects overlapping boxes but not edge-touching ones', () => {
    expect(collides({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true)
    expect(collides({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false)
    expect(collides({ x: 0, y: 0, w: 10, h: 10 }, { x: 2, y: 20, w: 10, h: 10 })).toBe(false)
  })

  it('speeds up with the score but caps at 9.5', () => {
    expect(speedFor(0)).toBe(5)
    expect(speedFor(120)).toBeGreaterThan(speedFor(0))
    expect(speedFor(100000)).toBe(9.5)
  })

  it('keeps a monotonic high score and pads the score to five digits', () => {
    expect(nextHighScore(0, 12.7)).toBe(12)
    expect(nextHighScore(30, 12.7)).toBe(30)
    expect(formatScore(7)).toBe('00007')
    expect(formatScore(1234)).toBe('01234')
    expect(dinoHighScoreKey()).toBe('dvw:dino:highscore')
  })
})

describe('小恐龙组件', () => {
  it('renders the canvas, hint and exit button', () => {
    const html = renderToStaticMarkup(<DinoGame theme="dark" onExit={() => {}}/>)
    expect(html).toContain('dvw-dino-canvas')
    expect(html).toContain('aria-label="小恐龙游戏画面，按空格跳跃"')
    expect(html).toContain('空格 / ↑ / 点击画面跳跃')
    expect(html).toContain('aria-label="退出小游戏"')
  })

  it('is wired into the empty editor state with the teaser line', () => {
    const source = readFileSync(new URL('../src/client/Workbench.tsx', import.meta.url), 'utf8')
    expect(source).toContain('或者，你想试试玩谷歌小恐龙吗？')
    expect(source).toContain('<DinoGame')
    expect(source).toContain('dvw-empty-dino')
    // 点击空白区域才加载游戏，默认仍然是空状态。
    expect(source).toContain('onClick={()=>setDino(true)}')
    expect(source).toContain('onExit={()=>setDino(false)}')
  })
})
