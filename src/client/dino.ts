/**
 * 小恐龙游戏的纯逻辑：碰撞、速度、最高分。
 *
 * 说明：这是对 Chrome 离线小恐龙的**致敬实现**（自己画的像素图形，没有搬运 Google 的资源），
 * 只借用了玩法：按空格/↑ 跳跃、↓ 下蹲、撞到仙人掌结束。
 */

export interface Box { x: number; y: number; w: number; h: number }

/** 轴对齐矩形碰撞（游戏里所有物体都是矩形近似）。 */
export function collides(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/** 速度随分数缓慢上升，封顶 9.5（再快就没法反应了）。 */
export function speedFor(score: number): number {
  return Math.min(9.5, 5 + score / 120)
}

/** 最高分只增不减；返回整数分。 */
export function nextHighScore(current: number, score: number): number {
  return Math.max(current, Math.floor(score))
}

/** 分数显示成 5 位（与 Chrome 一样补零）。 */
export function formatScore(score: number): string {
  return String(Math.max(0, Math.floor(score))).padStart(5, '0')
}

/** 最高分的持久化键。 */
export function dinoHighScoreKey(): string {
  return 'dvw:dino:highscore'
}
