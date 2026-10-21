import { useEffect, useRef, useState } from 'react'
import { collides, dinoHighScoreKey, formatScore, nextHighScore, speedFor } from './dino.ts'
import { Icon } from './Icon.tsx'

/**
 * 编辑器空状态里的 Chrome 离线小恐龙致敬版。
 *
 * 纯 canvas + rAF，没有任何依赖：像素图形是这里自己用字符矩阵画的（没有搬运 Google 的资源），
 * 玩法与原版一致（空格/↑/点击跳跃、↓ 下蹲、撞到仙人掌结束、空格重开、Esc 退出）。
 * 颜色跟随工作台主题（深/浅），分数与最高分画在画布上，最高分写 localStorage。
 */

const W = 600
const H = 150
const GROUND = 118
const DINO_X = 42
const GRAVITY = 0.42
const JUMP_VELOCITY = -6.6

/** '#' 表示实心像素；每行一个字符串。 */
const DINO_STAND = [
  '     ##########',
  '     ##########',
  '     ###.######',
  '     ##########',
  '     ######',
  '     ########',
  '     ########',
  '##   ######',
  '##   #### ####',
  '##   ####  ###',
  ' ##### ##   ##',
  '  #####',
  '   ###',
]
const DINO_RUN_1 = [...DINO_STAND.slice(0, 10), ' ##### ##   ##', '  #####', '   ##  ###', '       ###']
const DINO_RUN_2 = [...DINO_STAND.slice(0, 10), ' ##### ##   ##', '  #####', '   ###  ##', '      ###']
const DINO_DUCK = [
  '             ##########',
  '             ##########',
  '             ###.######',
  '             ##########',
  ' ##########  ######',
  ' ##################',
  ' #################',
  ' ##############',
]
const CACTUS = [
  '  ##  ',
  '  ##  ',
  '  ##  ',
  '##### ',
  '##### ',
  '  ##  ',
  '  ##  ',
  '  ##  ',
  '  ##  ',
]
const CACTUS_WIDE = [
  ' ##   ## ',
  ' ##   ## ',
  ' ##   ## ',
  ' ##   ## ',
  '#########',
  '#########',
  ' ##   ## ',
  ' ##   ## ',
]

const PIXEL = 2

function drawSprite(ctx: CanvasRenderingContext2D, rows: readonly string[], x: number, y: number, color: string): void {
  ctx.fillStyle = color
  rows.forEach((row, rowIndex) => {
    for (let column = 0; column < row.length; column++) {
      if (row[column] !== '#') continue
      ctx.fillRect(x + column * PIXEL, y + rowIndex * PIXEL, PIXEL, PIXEL)
    }
  })
}

interface Obstacle { x: number; width: number; height: number; wide: boolean }

export function DinoGame({ theme, onExit }: { theme: 'dark' | 'light'; onExit(): void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const themeRef = useRef(theme); themeRef.current = theme
  const onExitRef = useRef(onExit); onExitRef.current = onExit
  const [gameOver, setGameOver] = useState(false)
  const [highScore, setHighScore] = useState(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = W * dpr
    canvas.height = H * dpr
    ctx.scale(dpr, dpr)

    let saved = 0
    try { saved = Number(localStorage.getItem(dinoHighScoreKey()) ?? '0') || 0 } catch { saved = 0 }
    let high = saved
    setHighScore(saved)

    let score = 0
    let speed = 5
    let dinoY = 0
    let velocity = 0
    let ducking = false
    let running = true
    let frame = 0
    let spawnIn = 520
    let obstacles: Obstacle[] = []
    let raf = 0
    let last = 0

    const restart = () => {
      score = 0; speed = 5; dinoY = 0; velocity = 0; ducking = false; running = true; frame = 0; spawnIn = 520; obstacles = []
      setGameOver(false)
    }
    const jump = () => {
      if (!running) { restart(); return }
      if (dinoY === 0) velocity = JUMP_VELOCITY
    }
    const colors = () => ({ fg: themeRef.current === 'dark' ? '#e6e6e6' : '#2b2b2b', dim: themeRef.current === 'dark' ? '#8a8a8a' : '#777777' })

    const draw = () => {
      const { fg, dim } = colors()
      ctx.clearRect(0, 0, W, H)
      // 地面：随分数滚动（用移动的短线表现速度）
      ctx.strokeStyle = dim
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, GROUND + 1)
      ctx.lineTo(W, GROUND + 1)
      ctx.stroke()
      const offset = (frame * speed) / 18 % 40
      ctx.beginPath()
      for (let x = -offset; x < W; x += 40) { ctx.moveTo(x, GROUND + 10); ctx.lineTo(x + 14, GROUND + 10) }
      ctx.stroke()

      // 障碍
      for (const obstacle of obstacles) {
        const rows = obstacle.wide ? CACTUS_WIDE : CACTUS
        drawSprite(ctx, rows, obstacle.x, GROUND - rows.length * PIXEL + 1, fg)
      }

      // 恐龙
      const rows = ducking && dinoY === 0 ? DINO_DUCK : running && dinoY === 0
        ? (Math.floor(frame / 90) % 2 === 0 ? DINO_RUN_1 : DINO_RUN_2)
        : DINO_STAND
      drawSprite(ctx, rows, DINO_X, GROUND - rows.length * PIXEL + dinoY, fg)

      // 分数
      ctx.fillStyle = dim
      ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
      ctx.textAlign = 'right'
      ctx.fillText('HI ' + formatScore(high) + '  ' + formatScore(score), W - 12, 20)
      ctx.textAlign = 'left'
      if (!running) {
        ctx.textAlign = 'center'
        ctx.fillStyle = fg
        ctx.font = '14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
        ctx.fillText('游戏结束 · 按空格重新开始，Esc 退出', W / 2, H / 2 - 8)
        ctx.textAlign = 'left'
      }
    }

    const step = (timestamp: number) => {
      const delta = last === 0 ? 16 : Math.min(50, timestamp - last)
      last = timestamp
      if (running) {
        frame += delta
        speed = speedFor(score)
        score += delta * 0.012 * speed
        if (velocity !== 0 || dinoY < 0) {
          velocity += GRAVITY
          dinoY += velocity
          if (dinoY >= 0) { dinoY = 0; velocity = 0 }
        }
        spawnIn -= (delta * speed) / 5
        if (spawnIn <= 0) {
          const wide = Math.random() < 0.35
          obstacles.push({ x: W + 12, width: (wide ? CACTUS_WIDE[0]!.length : CACTUS[0]!.length) * PIXEL, height: (wide ? CACTUS_WIDE.length : CACTUS.length) * PIXEL, wide })
          spawnIn = 280 + Math.random() * 420 - Math.min(120, score / 8)
          if (spawnIn < 180) spawnIn = 180
        }
        for (const obstacle of obstacles) obstacle.x -= (speed * delta) / 16
        obstacles = obstacles.filter(obstacle => obstacle.x + obstacle.width > -20)
        const dinoRows = ducking && dinoY === 0 ? DINO_DUCK : DINO_STAND
        const dinoHeight = dinoRows.length * PIXEL
        const dinoWidth = 13 * PIXEL
        const box = { x: DINO_X + 4, y: GROUND - dinoHeight + dinoY, w: dinoWidth - 8, h: dinoHeight }
        for (const obstacle of obstacles) {
          if (collides(box, { x: obstacle.x, y: GROUND - obstacle.height + 1, w: obstacle.width, h: obstacle.height })) {
            running = false
            high = nextHighScore(high, score)
            setHighScore(high)
            try { localStorage.setItem(dinoHighScoreKey(), String(high)) } catch { /* 隐私模式：只保留内存中的最高分 */ }
            setGameOver(true)
            break
          }
        }
      }
      draw()
      raf = window.requestAnimationFrame(step)
    }
    raf = window.requestAnimationFrame(step)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onExitRef.current(); return }
      if (event.key === ' ' || event.key === 'ArrowUp' || event.key === 'Enter') { event.preventDefault(); jump(); return }
      if (event.key === 'ArrowDown') { event.preventDefault(); ducking = true }
    }
    const onKeyUp = (event: KeyboardEvent) => { if (event.key === 'ArrowDown') ducking = false }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => { window.cancelAnimationFrame(raf); window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp) }
  }, [])

  return <div className="dvw-dino">
    <div className="dvw-dino-bar">
      <span className="dvw-dino-title"><Icon name="graph"/> 小恐龙 · 最高分 <b>{formatScore(highScore)}</b></span>
      <button className="dvw-mode-button" title="退出小游戏 (Esc)" aria-label="退出小游戏" onClick={() => onExitRef.current()}><Icon name="close"/> 退出</button>
    </div>
    <canvas ref={canvasRef} className="dvw-dino-canvas" role="img" aria-label={gameOver ? '小恐龙游戏已结束，按空格重新开始' : '小恐龙游戏画面，按空格跳跃'} onClick={() => { if (canvasRef.current !== null) window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' })) }}/>
    <div className="dvw-dino-hint">空格 / ↑ / 点击画面跳跃，↓ 下蹲，Esc 退出</div>
  </div>
}
