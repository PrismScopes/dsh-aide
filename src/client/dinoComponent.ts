import type { ComponentType } from 'react'
import * as dinoPackage from 'react-chrome-dino'

/**
 * `react-chrome-dino@0.1.3` 的组件导出解析（CJS 互操作边界）。
 *
 * 这个包是 2019 年用 webpack 打的 UMD（CJS），导出形如
 * `module.exports = { default: Dino, __esModule: true }`。本插件的客户端 bundle 由
 * tsdown/rolldown 打进 DSH 的 `window.__ModuleLoader__` 工厂里，CJS 互操作走 Node 语义
 * （`__toESM(module.exports, 1)`），会把 `default` 直接绑成**整个 module.exports** ——
 * 于是 `import Dino from 'react-chrome-dino'` 在**产物里**拿到的是那个对象而不是组件，
 * React 渲染它会抛 `Element type is invalid ... but got: object`，小恐龙就完全打不开
 * （v0.4.3 的「加载有问题」就是这个）。vitest 走的是 Vite 的 ESM 互操作，形状正常，
 * 所以单测不会暴露它 —— 这也是为什么这个解析必须单独测两种形状。
 *
 * 这里把「函数」和「带 default 的对象（可能嵌套多层）」两种形状归一成组件，
 * 让它在测试环境（Vite）和浏览器产物（rolldown）里都拿到同一个东西。
 */
export function resolveDinoComponent(mod: unknown): ComponentType | undefined {
  let value: unknown = mod
  // 最多剥 4 层 `{ default: ... }`，避免对畸形导出无限循环。
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof value === 'function') return value as ComponentType
    if (value === null || typeof value !== 'object' || !('default' in value)) return undefined
    value = (value as { default: unknown }).default
  }
  return undefined
}

/** 解析好的小恐龙组件；解析失败时为 `undefined`，由调用方降级展示，不炸掉整个工作台。 */
export const Dino = resolveDinoComponent(dinoPackage)

/** 上游脚本挂在 window 上的 Runner 类的可注入视图（只为调用 disposeDinoRunner 测试用）。 */
export interface DinoRunner {
  prototype?: { raq?: () => void; handleEvent?: (event: Event) => void }
}

/**
 * 退出小恐龙时把它留下的两处全局副作用收掉（上游组件没有把实例暴露出来）。
 *
 * `react-chrome-dino` 在 `new Runner('.interstitial-wrapper')` 之后就把实例丢弃了，于是
 *   1. Runner 每画完一帧都会经 `this.raq()` 再排一次 requestAnimationFrame，组件卸载后
 *      循环不会自己停，会一直以一个离屏画布空转重绘；
 *   2. Runner 以 `document.addEventListener(KEYDOWN, this)` 把**实例本身**注册成监听器
 *      （走 EventListener.handleEvent），卸载时没人调用 `stopListening()`，于是退出后
 *      在编辑器里敲空格/方向键还会打到那个残留实例上（会放跳跃音效）。
 *
 * 两处都只在原型上改成空操作：下一帧之后循环停止，残留实例也不再响应事件。下次打开时
 * 上游脚本会重新执行并重新定义 `window.Runner`，所以这不是永久改动，不影响下一次游戏。
 */
export function disposeDinoRunner(runner: DinoRunner | undefined): void {
  const prototype = runner?.prototype
  if (prototype === undefined) return
  prototype.raq = () => {}
  prototype.handleEvent = () => {}
}
