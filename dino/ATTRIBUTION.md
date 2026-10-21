# 第三方代码归属

`dino/` 目录是「Chrome 小恐龙」的开源实现，**原样 vendored**（未修改），用于编辑器空状态里的彩蛋。

- 来源：https://github.com/CloudCannon/Dinosaur-Chrome-Game
- 许可证：MIT（见同目录 `LICENSE`）
- 版权：Copyright (c) 2015 CloudCannon
- 使用方式：宿主通过 `/dsh-vscode/dino/*` 提供这些静态文件，客户端用 iframe 加载 `index.html`；
  上游代码、HTML、CSS 均未改动（`js/vendor/` 下的 jQuery 未在页面中引用，已在 vendoring 时移除）。

如果将来替换成别的实现，请同步更新本文件、`LICENSE` 与 `src/client/DinoGame.tsx` 里的说明。
