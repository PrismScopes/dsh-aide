import { useEffect } from 'react'
import { Dino, disposeDinoRunner, type DinoRunner } from './dinoComponent.ts'

/** 小恐龙标签页的虚拟路径：不读磁盘，内容由本组件自己渲染。 */
export const DINO_PATH = 'dino:game'

/**
 * 编辑器里的小恐龙标签页（不是浮窗，也不是空状态里的整块替身）。
 *
 * 直接复用 npm 上的 [`react-chrome-dino`](https://www.npmjs.com/package/react-chrome-dino)（**MIT**，0.1.3）：
 * 它内置了 Chrome 官方离线页的小恐龙实现（精灵图、音效、夜间模式、原版物理），
 * 这里只负责把它铺进编辑器面板；不自己写游戏逻辑、也不 vendored 资源。
 * 组件是纯客户端（componentDidMount 里注入页面），所以只在这个标签被激活时挂载：
 * 切到别的标签就卸载，游戏也跟着停。
 *
 * 组件从 `./dinoComponent.ts` 取：那是 CJS→ESM 的互操作边界，产物里默认导出会被包成
 * `{ default: 组件 }`，直接 `import Dino from 'react-chrome-dino'` 渲染会抛
 * "Element type is invalid"（v0.4.3 打不开小恐龙的原因）。
 */
export function DinoGame() {
  // 切走/关掉标签时收掉上游组件自己不会收的残留（动画循环 + document 上的按键监听）。
  useEffect(() => () => { disposeDinoRunner((window as unknown as { Runner?: DinoRunner }).Runner) }, [])

  return <div className="dvw-dino">
    <div className="dvw-dino-stage" data-testid="dino-stage">
      {Dino === undefined
        ? <p className="dvw-dino-failed">小恐龙组件未能加载，请刷新页面重试</p>
        : <Dino/>}
    </div>
  </div>
}
