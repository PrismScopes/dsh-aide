import { useEffect } from 'react'
import { Dino, disposeDinoRunner, type DinoRunner } from './dinoComponent.ts'
import { Icon } from './Icon.tsx'

/**
 * 编辑器空状态里的 Chrome 小恐龙。
 *
 * 直接复用 npm 上的 [`react-chrome-dino`](https://www.npmjs.com/package/react-chrome-dino)（**MIT**，0.1.3）：
 * 它内置了 Chrome 官方离线页的小恐龙实现（精灵图、音效、夜间模式、原版物理），
 * 这里只负责把它嵌进编辑器面板、加一个退出按钮，不自己写游戏逻辑、也不 vendored 资源。
 * 组件是纯客户端（componentDidMount 里注入页面），所以 DSH 页面里只在空状态打开时挂载。
 *
 * 组件从 `./dinoComponent.ts` 取：那是 CJS→ESM 的互操作边界，产物里默认导出会被包成
 * `{ default: 组件 }`，直接 `import Dino from 'react-chrome-dino'` 渲染会抛
 * "Element type is invalid"（v0.4.3 打不开小恐龙的原因）。
 */
export function DinoGame({ onExit }: { onExit(): void }) {
  // 退出/切走标签页时收掉上游组件自己不会收的残留（动画循环 + document 上的按键监听）。
  useEffect(() => () => { disposeDinoRunner((window as unknown as { Runner?: DinoRunner }).Runner) }, [])

  return <div className="dvw-dino">
    <div className="dvw-dino-bar">
      <span className="dvw-dino-title"><Icon name="graph"/> 小恐龙</span>
      <button className="dvw-mode-button" title="退出小游戏" aria-label="退出小游戏" onClick={onExit}><Icon name="close"/> 退出</button>
    </div>
    <div className="dvw-dino-stage" data-testid="dino-stage">
      {Dino === undefined
        ? <p className="dvw-dino-failed">小恐龙组件未能加载，请刷新页面重试</p>
        : <Dino/>}
    </div>
  </div>
}
