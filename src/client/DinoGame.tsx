import Dino from 'react-chrome-dino'
import { Icon } from './Icon.tsx'

/**
 * 编辑器空状态里的 Chrome 小恐龙。
 *
 * 直接复用 npm 上的 [`react-chrome-dino`](https://www.npmjs.com/package/react-chrome-dino)（**MIT**，0.1.3）：
 * 它内置了 Chrome 官方离线页的小恐龙实现（精灵图、音效、夜间模式、原版物理），
 * 这里只负责把它嵌进编辑器面板、加一个退出按钮，不自己写游戏逻辑、也不 vendored 资源。
 * 组件是纯客户端（componentDidMount 里注入页面），所以 DSH 页面里只在空状态打开时挂载。
 */
export function DinoGame({ onExit }: { onExit(): void }) {
  return <div className="dvw-dino">
    <div className="dvw-dino-bar">
      <span className="dvw-dino-title"><Icon name="graph"/> 小恐龙</span>
      <button className="dvw-mode-button" title="退出小游戏" aria-label="退出小游戏" onClick={onExit}><Icon name="close"/> 退出</button>
    </div>
    <div className="dvw-dino-stage" data-testid="dino-stage"><Dino/></div>
  </div>
}
