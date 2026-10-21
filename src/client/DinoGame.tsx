import { Icon } from './Icon.tsx'

/**
 * 编辑器空状态里的 Chrome 小恐龙。
 *
 * 游戏本体是 **vendored 的开源实现**（MIT，见仓库根目录 `dino/LICENSE` 与 `dino/ATTRIBUTION.md`，
 * 来源 https://github.com/CloudCannon/Dinosaur-Chrome-Game ），不是自己写的：
 * 宿主把 `dino/` 目录通过 `/dsh-vscode/dino/*` 原样提供，这里只用一个 iframe 把原版页面铺满编辑器面板，
 * 不改动上游任何代码。这样既满足「复用现成实现」，也避免把 96KB 的 jQuery/画布逻辑塞进客户端 bundle。
 */
export function DinoGame({ onExit }: { onExit(): void }) {
  return <div className="dvw-dino">
    <div className="dvw-dino-bar">
      <span className="dvw-dino-title"><Icon name="graph"/> 小恐龙（开源实现）</span>
      <button className="dvw-mode-button" title="退出小游戏" aria-label="退出小游戏" onClick={onExit}><Icon name="close"/> 退出</button>
    </div>
    <iframe className="dvw-dino-frame" title="小恐龙游戏" src="/dsh-vscode/dino/index.html" sandbox="allow-scripts"/>
  </div>
}
