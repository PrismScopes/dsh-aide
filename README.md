<h1 align="center">DSH VS Code Workbench</h1>

<p align="center">
  <img src="https://raw.githubusercontent.com/tingfeng347/dsh-vscode-workbench/main/assets/dsh-neon-workbench-core.svg" width="220" alt="DSH VS Code Workbench Logo">
</p>

<p align="center">在 DeepSeek Harness 中叠加 VS Code 风格的本地开发工作台。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-vscode-workbench"><img src="https://img.shields.io/npm/v/dsh-vscode-workbench?logo=npm&label=npm" alt="npm 版本"></a>
  <a href="https://www.npmjs.com/package/dsh-vscode-workbench"><img src="https://img.shields.io/npm/dm/dsh-vscode-workbench?label=downloads" alt="npm 月下载量"></a>
  <a href="https://github.com/tingfeng347/dsh-vscode-workbench/stargazers"><img src="https://img.shields.io/github/stars/tingfeng347/dsh-vscode-workbench?logo=github&label=Stars" alt="GitHub Stars"></a>
  <a href="https://github.com/tingfeng347/dsh-vscode-workbench/commits/main"><img src="https://img.shields.io/github/last-commit/tingfeng347/dsh-vscode-workbench?label=last%20commit" alt="最近提交"></a>
  <a href="https://github.com/tingfeng347/dsh-vscode-workbench/blob/main/LICENSE"><img src="https://img.shields.io/github/license/tingfeng347/dsh-vscode-workbench?label=license" alt="MIT 许可证"></a>
  <br>
  <a href="https://awesome-dsh-plugin.com/p/tingfeng347/dsh-vscode-workbench/"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome · DSH plugin"></a>
  <a href="https://dshpluginhub.ai/plugins/dsh-vscode-workbench"><img src="https://dshpluginhub.ai/badges/plugins/dsh-vscode-workbench.svg" alt="DSH Plugin Hub 已收录"></a>
  <a href="https://dshmarket.com/p/tingfeng347/dsh-vscode-workbench/"><img src="https://img.shields.io/badge/dsh--market-已收录-5b7cfa?style=flat" alt="dsh-market 已收录"></a>
  <a href="https://dshmk.com/plugins/1343926987"><img src="https://img.shields.io/badge/DSH%20插件市场-已收录-0ea5e9?style=flat" alt="DSH 插件市场已收录"></a>
  <a href="https://dsh-ai.org/p/tingfeng347/dsh-vscode-workbench"><img src="https://img.shields.io/badge/dsh--ai.org-已收录-8b5cf6?style=flat" alt="dsh-ai.org 已收录"></a>
  <a href="https://duink.com/plugins/1343926987/"><img src="https://img.shields.io/badge/DSH%20Universe-已收录-14b8a6?style=flat" alt="DSH Universe 已收录"></a>
  <a href="https://deepseekplugin.org/plugins/tingfeng347-dsh-vscode-workbench"><img src="https://img.shields.io/badge/DeepseekPlugin-已收录-2563eb?style=flat" alt="DeepseekPlugin 已收录"></a>
</p>

<p align="center"><b>中文</b> · <a href="README.en.md">English</a></p>

## 亮点

- **一体化本地工作台**：资源管理器、Monaco 编辑器、搜索、Git、终端和 DSH 对话集中在一个 VS Code 风格界面。
- **完整文件体验**：文本、Markdown、图片、PDF 和 Word 文档均可直接打开；目录支持拖放上传和常用文件操作。
- **可靠且实时**：原子保存与版本校验避免静默覆盖，WebSocket 会及时标记工作区的外部变更。
- **可视化 Git 工作流**：覆盖状态、暂存、提交、分支、差异、提交文件与泳道式提交图。
- **可持续的工作上下文**：按工作区恢复目录、视图、面板与栏宽；终端支持多会话、分屏与重命名。
- **贴合 DSH**：右侧直接复用 DSH 对话能力，配色随 DSH 主题切换，不额外提供一套配色设置。

## 功能

- **文件与编辑器**：懒加载目录树、创建、上传、拖放、重命名、删除和 Git 状态；Monaco 多标签编辑支持脏状态、原子保存与冲突提示。
- **预览**：Markdown 支持源码、大纲、相对链接和图片；内置 PDF 翻页缩放与 DOCX 渲染，DOC/ODT 可直接下载打开。
- **搜索与 Git**：`@vscode/ripgrep` 支持大小写、全词、正则和路径筛选；Git 提供暂存、撤销、丢弃、提交、分支、差异、提交文件和提交图表。
- **终端**：基于 `node-pty` 与 xterm，支持最多 8 个会话、会话重命名、右侧切换、分屏、ANSI 输出和 Ctrl+C。
- **布局与 DSH**：左侧视图、终端面板和右侧 DSH 对话栏可独立显示和调整；宽度直接拖分隔条改、双击恢复默认，
  这些都在界面里就地完成，不再重复成设置项。
- **设置页**：DSH 设置里的「VS Code 工作台」一页，单列滚动、按分组（编辑器 / AI 补全 / 终端 / 快捷键 /
  关于与诊断）分段，字号与 DSH 设置页统一（行标题 14/20、说明 12/18、控件 14/32px）。编辑器：字号、行高、
  制表符宽度与空格缩进、自动换行（关/按宽度/按列）、
  缩略图、概览标尺、选中内容同类词高亮、空白字符、光标样式、平滑滚动、粘性滚动、自动保存与延迟；
  AI 补全：总开关、触发延迟、模型路由（**直接列出 DSH 已配置的模型**，可手填）、失败回落，并显示当前生效
  模型与最近一次失败；另有终端字号、快捷键清单、恢复默认设置。
- **划词高亮与概览标尺**：双击/选中一个词后，文档内所有同类词按 VS Code 的方式高亮，右侧出现 3 泳道
  概览标尺（选区、同类词、查找匹配都画在滚动条那条带子里）；标记用前景色（深色主题即白色，不像早前用蓝色强调色），
  滚动条滑块带透明度，不会把标记盖住。
- **关闭确认与自动保存**：关闭标签、批量关闭（其他/右侧/已保存/全部）以及返回 DSH 时，有未保存改动会弹
  VS Code 同款对话框（单个：保存/不保存/取消；多个：全部保存/不保存全部/取消，并列出文件）；保存失败
  的文件留在原地并报错，返回 DSH 时只要有失败就不离开。另可开启「延迟自动保存」。
- **中文右键菜单**：文件树、标签页、代码编辑器、终端、源代码管理都有与 VS Code 对应的中文菜单 ——
  新建/上传/剪切/复制/粘贴/重命名/删除、复制相对与绝对路径、在终端中打开、标签的关闭其他/右侧/已保存、
  编辑器的撤销重做与查找替换、终端的复制粘贴与清屏、Git 的暂存/取消暂存/放弃/复制提交哈希。
  Monaco 自带的英文菜单已关闭（`contextmenu:false`）；菜单内容与动作是纯数据（可单测），壳层统一一份。
- **行内补全**：光标处给出幻影文本建议，可由真实模型或本地兜底提供；多候选可切换，按整条、按行、
  按词三种粒度采纳。上下文来自当前文件与本地检索索引（索引只落在工作区本地目录）。
  实现与验证情况见 [docs/inline-completion.md](docs/inline-completion.md)。
  注意：宿主侧代码只在进程启动时加载，改过之后需要**重启应用**才生效（客户端部分刷新页面即可）。
- **同步与恢复**：工作区文件变化实时推送；刷新后恢复活动视图、目录展开、面板与布局（文件标签不跨会话恢复）。

工作台通过官方 `sidebar.footer.action` 与 `shell.overlay` 扩展点挂载，不替换或卸载 `ui-layout`。

## 演示

<p align="center">
  <img src="https://raw.githubusercontent.com/tingfeng347/dsh-vscode-workbench/main/assets/screenshots/explorer.png" width="800" alt="资源管理器与 Monaco 编辑器">
  <br><em>资源管理器与 Monaco 编辑器</em>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/tingfeng347/dsh-vscode-workbench/main/assets/screenshots/source-control.png" width="800" alt="源代码管理与提交图表">
  <br><em>源代码管理与提交图表</em>
</p>

<p align="center">
  <img src="https://pic1.imgdb.cn/i/034GkZFU8ULHsWgFio93Lw.png" width="800" alt="终端">
  <br><em>终端</em>
</p>


## 安装

```bash
dsh plugin --profile web add dsh-vscode-workbench
```

### 首次安装终端支持

终端使用 `node-pty`。pnpm 11 首次安装时会拦截其构建脚本，`dsh plugin ... add` 可能显示 `Ignored build scripts` 并以失败结束；这是预期的安全检查，插件依赖已经写入 profile。在 DSH 所在机器执行：

```bash
cd ~/.dsh/profiles/web
pnpm approve-builds --all
```

该命令会批准 `node-pty` 的构建并重新完成安装；完成后重启 `dsh web`。若终端仍提示 `node-pty` 加载失败，可执行：

```bash
cd ~/.dsh/profiles/web
pnpm approve-builds --all && pnpm rebuild node-pty
```

刚发布不足 24 小时的版本可能被 pnpm 的安全等待期拦截。等待后重试即可；DSH 提供“立即更新”时可直接选择它。

## 快捷键

| 快捷键 | 操作 |
| --- | --- |
| `Ctrl+Shift+E` | 打开资源管理器 |
| `Ctrl+Shift+F` | 打开搜索 |
| `Ctrl+Shift+G` | 打开源代码管理 |
| `Ctrl+S` | 保存当前文件 |
| `Ctrl+Alt+B` | 显示或隐藏 DSH 对话栏 |
| `Ctrl+\`` | 显示或隐藏终端 |
| `Ctrl+Shift+\`` | 新建终端 |
| `Tab` | 采纳整条补全建议 |
| `Ctrl+方向键右` | 采纳建议的下一段 |
| `Ctrl+Alt+方向键右` | 采纳建议的下一行 |
| `Alt+[` / `Alt+]` | 上一条 / 下一条候选 |

左侧活动栏的终端按钮可切换显示或隐藏终端面板。

## 安全

Host 只接受当前 DSH 会话工作目录内的相对路径，并阻止目录穿越与符号链接越界。保存使用版本校验与原子替换；Git 与 ripgrep 使用参数数组启动，不拼接 Shell 命令。终端只接受同源 loopback 请求，固定在会话工作目录启动，并移除 API key、token、secret 等敏感环境变量。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

需要 Node.js `^22.19 || >=24`、pnpm 11.7、系统 Git，以及 `node-pty` 所需的本机构建环境（预编译产物不可用时）。

## 许可证

[MIT](LICENSE)
