<h1 align="center">DSH AIDE</h1>

<p align="center">
  <img src="https://raw.githubusercontent.com/PrismScopes/dsh-aide/main/assets/dsh-aide-logo.svg" width="220" alt="DSH AIDE Logo">
</p>

<p align="center"><b>AIDE = AI + IDE</b>：在 DeepSeek Harness 中叠加 VS Code 风格的本地开发环境。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-aide"><img src="https://img.shields.io/npm/v/dsh-aide?logo=npm&label=npm" alt="npm 版本"></a>
  <a href="https://www.npmjs.com/package/dsh-aide"><img src="https://img.shields.io/npm/dm/dsh-aide?label=downloads" alt="npm 月下载量"></a>
  <a href="https://github.com/PrismScopes/dsh-aide/stargazers"><img src="https://img.shields.io/github/stars/PrismScopes/dsh-aide?logo=github&label=Stars" alt="GitHub Stars"></a>
  <a href="https://github.com/PrismScopes/dsh-aide/commits/main"><img src="https://img.shields.io/github/last-commit/PrismScopes/dsh-aide?label=last%20commit" alt="最近提交"></a>
  <a href="https://github.com/PrismScopes/dsh-aide/blob/main/LICENSE"><img src="https://img.shields.io/github/license/PrismScopes/dsh-aide?label=license" alt="MIT 许可证"></a>
</p>

<p align="center">
  <a href="https://github.com/topics/dsh-plugin"><img alt="topic: dsh-plugin" src="https://img.shields.io/badge/topic-dsh--plugin-2ea44f?style=flat-square"></a>
  <a href="https://github.com/topics/deepseek-harness"><img alt="topic: deepseek-harness" src="https://img.shields.io/badge/topic-deepseek--harness-6f42c1?style=flat-square"></a>
  <a href="https://github.com/topics/dsh"><img alt="topic: dsh" src="https://img.shields.io/badge/topic-dsh-0969da?style=flat-square"></a>
  <a href="https://github.com/topics/ai"><img alt="topic: ai" src="https://img.shields.io/badge/topic-ai-8250df?style=flat-square"></a>
  <a href="https://github.com/topics/ide"><img alt="topic: ide" src="https://img.shields.io/badge/topic-ide-1f883d?style=flat-square"></a>
  <a href="https://github.com/topics/monaco-editor"><img alt="topic: monaco-editor" src="https://img.shields.io/badge/topic-monaco--editor-f9a825?style=flat-square"></a>
  <a href="https://github.com/topics/vscode-workbench"><img alt="topic: vscode-workbench" src="https://img.shields.io/badge/topic-vscode--workbench-007acc?style=flat-square"></a>
</p>

<p align="center"><b>中文</b> · <a href="README.en.md">English</a></p>

## 亮点

- **一体化 AIDE**：资源管理器、Monaco 编辑器、搜索、Git、终端和 DSH 对话集中在一个 VS Code 风格界面。
- **完整文件体验**：文本、Markdown、图片、PDF 和 Word 文档均可直接打开；目录支持拖放上传和常用文件操作。
- **可靠且实时**：原子保存与版本校验避免静默覆盖，WebSocket 会及时标记工作区的外部变更。
- **可视化 Git 工作流**：覆盖状态、暂存、提交、分支、差异、提交文件与泳道式提交图。
- **可持续的工作上下文**：按工作区恢复目录、视图、面板与栏宽；终端支持多会话、分屏与重命名。
- **语言服务**：内置 TypeScript/JavaScript 语言服务 + 可接任意外部 LSP 服务器；诊断、悬停、跳转、引用、重命名、符号与补全全部可用。
- **贴合 DSH**：右侧直接复用 DSH 对话能力，配色随 DSH 主题切换，不额外提供一套配色设置。

## 功能

- **文件与编辑器**：懒加载目录树、创建、上传、拖放、重命名、删除和 Git 状态；Monaco 多标签编辑支持脏状态、原子保存与冲突提示。
- **彩蛋**：编辑器空状态里点「或者，你想试试玩谷歌小恐龙吗？」会像普通文件一样**在编辑器区开一个「小恐龙」标签页**
  （不是浮窗，切走/关标签即退出），游戏铺满编辑器面板，**深浅色跟随 DSH 主题**（深色下把画布反相，深灰精灵变浅灰）。
  直接用 npm 包 `react-chrome-dino`（MIT），内置 Chrome 官方离线页的小恐龙（精灵图/音效），没有自写逻辑、也没有 vendored 资源。
- **预览**：Markdown 支持源码、大纲、相对链接和图片；内置 PDF 翻页缩放与 DOCX 渲染，DOC/ODT 可直接下载打开。
- **搜索与替换**：`@vscode/ripgrep` 支持大小写、全词、正则和路径筛选；结果按文件分组、命中处高亮，支持单条替换、
  全部替换与保留大小写，`F4` / `Shift+F4` 逐条跳转，上一次搜索（含替换串与选项）跨会话保留。
- **源代码管理**：暂存、撤销、丢弃、提交、分支、差异与提交文件；提交子菜单有 提交/提交已暂存文件/全部提交/撤销上次提交/中止变基/修正/签名 三档。面板标题的 `...` 菜单照 VS Code 分了一级
  子菜单：查看和排序 / 提交 / 更改 / 拉取，推送 / 分支 / 远程 / 存储 / 标记，各子菜单里的动作都直接可用
  （拉取·推送·同步·抓取·克隆、整批暂存或放弃、检出到 / 新建 / 重命名 / 删除 / 合并 / 变基、远程增删、
  贮藏增删改用、标签增删推送、撤销上次提交）。分支与贮藏、标签都走可搜索的快速选择器；
  **提交图是独立的编辑器标签**（源代码管理面板标题栏的提交图图标按钮打开，图标沿用 Git Graph 扩展自己的 SVG），按 VS Code Git Graph 扩展上色：
  图上有未提交更改与贮藏节点，单击提交在右侧看「提交详情」（作者、完整说明、文件 +/− 行数，点文件看差异），
  Ctrl(⌘)+单击另一个提交进入「提交对比」，支持查找（Ctrl+F，匹配消息/作者/哈希/引用）与分支过滤（多选），
  可在提交行上检出、创建分支/标签/重置/丢弃、拣选、还原；作者/日期/哈希列可显示隐藏并拖动列宽，
  提交说明支持 emoji 短代码与 Issue 链接（按远程地址自动识别 GitHub/GitLab/Bitbucket），
  「仓库设置」里可改远程、抓取、修剪、配置 Issue 链接与拉取请求目标分支、导出视图配置，
  「...」菜单可一键打开拉取请求创建页（GitHub/GitLab/Bitbucket 各自的 compare/merge_requests 模板）；
  「视图」子菜单可清除代码审查记录；
  提交详情里的文件带「已读」勾选（点开 diff 自动标记，跨会话保留 90 天）；
  图内快捷键：
  `Ctrl+F` 查找、`Ctrl+H` 回到 HEAD、`Ctrl+R` 刷新、`↑`/`↓` 切换提交、`Esc` 关闭详情。
  「显示 Git 输出」会在编辑器里打开工作台执行过的 git 操作记录。
- **终端**：基于 `node-pty` 与 xterm，支持最多 8 个会话、会话重命名、右侧切换、分屏、ANSI 输出和 Ctrl+C。
  打开终端面板时宿主会先预热默认 shell，点「新建终端」时提示符通常已经在回放缓冲里；面板收起或切标签时
  不重建 xterm、不重放输出，回来即用。终端会话标签在终端视图顶部；整个底部面板的标题栏左侧是
  问题 / 输出 / 终端 三个独立圆角按钮（不是页签条），`⋯` 菜单目前提供「调试控制台」面板（调试器接入前显示空状态）。
- **输出**：与 VS Code 的 Output 视图同构，按通道显示日志 —— 语言服务通道收 LSP 服务器输出、连接与扫描事件，
  Git 通道记录工作台发起的每条 Git 命令。五级级别过滤（跟踪 / 调试 / 信息 / 警告 / 错误，隐藏而非删除）、
  文本过滤、滚动锁定与自动跟随、`path:line:col` 文件链接、复制 / 加入对话 / 清空、虚拟化长日志；
  活动通道会记住，下次打开恢复。
- **输入框上下文卡片**：在 DSH 对话输入框里输入 `@` 会多出「AIDE 上下文」一项，可把当前文件、当前文件问题、
  工作区问题作为**结构化引用 chip** 加入草稿；问题面板的「交给 AI」、资源管理器「添加到对话」、编辑器
  DSH 子菜单的「添加为上下文卡片」走同一条链路。chip 只存类型与定位，内容在发送时现读（诊断不会用过期快照），
  没有 composer 服务时自动回落到旧文本插入。见 [docs/context-cards.md](docs/context-cards.md)。
- **布局与 DSH**：左侧视图、终端面板和右侧 DSH 对话栏可独立显示和调整；宽度直接拖分隔条改、双击恢复默认，
  这些都在界面里就地完成，不再重复成设置项。
- **设置页**：DSH 设置里的「AIDE」一页，单列滚动、按分组（编辑器 / AI 补全 / 语言服务 / 终端 / 快捷键 /
  关于与诊断）分段，字号与 DSH 设置页统一（行标题 14/20、说明 12/18、控件 14/32px）。编辑器：字号、行高、
  制表符宽度与空格缩进、自动换行（关/按宽度/按列）、
  缩略图、概览标尺、选中内容同类词高亮、空白字符、光标样式、平滑滚动、粘性滚动、自动保存与延迟；
  AI 补全：总开关、触发延迟、模型路由（**直接列出 DSH 已配置的模型**，可手填）、失败回落，并显示当前生效
  模型与最近一次失败；语言服务：总开关、内置 TypeScript 开关、悬停/补全开关、已发现服务器状态与设置文件路径；
  另有终端字号、**快捷键面板**（设置页里只占一行「查看」入口，点开是可搜索、可改键的面板：
  点键帽就地录制、冲突提示、单条/全部恢复默认；编辑器内置键位只读）、恢复默认设置。
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
- **编辑器右键增强**：标准编辑项收进**分组子菜单**（选择 / 查找 / 转到 / 行操作 / 转换 / 格式化），
  顶层只留 12 行 —— 撤销重做、剪切复制粘贴、六个分组、保存，不再把 30 项平铺堆在一起。子菜单里是
  VS Code 常用操作：选择所有出现、转到定义/查找引用/重命名符号、上移下移/复制/删除行、缩进、大小写转换、
  上下多光标、行/块注释、格式化文档与选中内容、折叠展开。
  **选中文本时菜单最顶部出现「DeepSeek Harness」子菜单**：添加至对话、询问 DSH…、解释/修复/重构这段代码、
  生成单元测试、添加注释、审查这段代码、复制为引用 —— 除「复制为引用」走剪贴板外，**其余都只把引用或
  指令文本插入 DSH 对话输入框，不会替你直接发送**，你可以在输入框里补充后再自己发出。
  菜单支持两级子菜单（悬停/方向键展开、Esc 逐层关闭），并开放
  `registerEditorMenuContribution` 扩展点供其它插件往菜单里追加项。右键菜单是**纯文字**的（不带图标），
  只有可展开的子菜单在行尾有一个小箭头。
- **行内补全**：光标处给出幻影文本建议，可由真实模型或本地兜底提供；多候选可切换，按整条、按行、
  按词三种粒度采纳。上下文来自当前文件与本地检索索引（索引只落在工作区本地目录）。
  实现与验证情况见 [docs/inline-completion.md](docs/inline-completion.md)。
  注意：宿主侧代码只在进程启动时加载，改过之后需要**重启应用**才生效（客户端部分刷新页面即可）。
- **语言服务（LSP / 诊断 / 跳转）**：内置 TypeScript/JavaScript 服务（读 `tsconfig.json`、解析工作区 `node_modules` 类型），
  并自动发现 `PATH` 上的外部 LSP 服务器（pyright/pylsp、rust-analyzer、gopls、clangd、yaml-language-server、
  bash-language-server、lua-language-server、intelephense、solargraph 等），也可以用设置文件加自定义服务器。
  编辑器里 `F12` / `Ctrl+点击` 转到定义、`Shift+F12` 引用、`F2` 重命名（跨文件）、`Ctrl+Shift+O` 文件符号、
  `Ctrl+T` 工作区符号、`Ctrl+.` 快速修复（含整理导入），悬停显示跨文件类型信息，补全与签名帮助由语言服务提供。
  诊断实时画在编辑器里（防抖 260ms），活动栏「问题」、状态栏计数与「问题」面板按文件分组、可过滤、点击跳转，
  `F8` / `Shift+F8` 逐个问题跳；面板里的「扫描工作区」会检查内置 TS 项目的全部文件。
  问题面板还支持按文件 / 平铺两种视图、「仅当前文件」、单行 / 多行消息、↑↓/←→/Enter 键盘导航、
  右键复制/快速修复/添加到对话，以及上千条诊断的虚拟化渲染和「交给 AI」。
  跳到 `node_modules` 或 TypeScript `lib.*.d.ts` 会开只读标签，仍可继续悬停与跳转。
  设置页可总开关、单独关内置 TS、关悬停/补全；外部服务器与自定义配置见 [docs/language-services.md](docs/language-services.md)。
- **同步与恢复**：工作区文件变化实时推送；刷新后恢复活动视图、目录展开、面板与布局，以及**上一个会话打开的文件标签**
  （按工作区根目录存在本地：返回 DSH 主页面再进来、刷新页面、重启应用都会把标签栏恢复回来；正文在切到标签时重读磁盘，
  未保存的草稿不会跨会话恢复。回到工作台时还会把隐藏期间在磁盘上变过的文件重新读一遍）。

AIDE 通过 DSH 的 `shell.overlay`、`main`、`sidebar.panellist` 与 `settings.section` 扩展点挂载
（`main` 与 `sidebar.panellist` 成对注册、互相切换，兼容侧栏面板被收起的情况），不替换或卸载 `ui-layout`。

## 性能

- **终端启动**：打开终端面板时宿主先预热默认 shell（`TerminalManager.prewarm`，90 秒没人认领就回收）；
  点「新建终端」时它直接提上来，回放缓冲里已经有提示符。实测本机 `pwsh` 从 spawn 到可接命令约 530ms，
  预热后新建的宿主侧只剩约 2ms；新建/关闭/重命名各只发一次请求，面板与已打开的 xterm 实例常驻。
  不想多一个后台 shell 的部署可以用环境变量 `DWV_TERMINAL_PREWARM=0` 关掉预热（新建照常可用）。
- **渲染与 IO**：文件变更推送只在真的影响标签状态时更新；拖动分隔条期间只改 CSS 变量，松开才写入布局偏好并持久化；
  Markdown 大纲与 Git 提交图按内容 memo，不在每次输入时重算；Monaco 模型按 LRU 回收（保留打开/脏文件，上限 12），
  TextMate 语法按语言只安装一次、超过 3000 行或 200KB 的文件回退内置分词。
- **冷启动分包**：PDF 与 Word 的渲染栈只在打开对应文件时才需要，已拆成 DSH 客户端的按需 chunk
  （`lib/client.pdf.js` 487 KB、`lib/client.docx.js` 243 KB，首次预览时同源加载）。主包从 2.65 MB 降到 **1.75 MB**
  （gzip 584 KB → 375 KB），V8 编译 28 ms → 18 ms；不打开 PDF/Word 就完全不下载这两块。
- **语言服务**：完全懒加载 —— 不打开对应语言的文件就不加载 TypeScript、也不启动外部服务器；诊断在停手 260ms 后计算、客户端 80ms 合并刷新，打开大量文件时问题面板不会逐条重渲染。
- **补全**：请求体只带光标附近的窗口（1MB 文档约 20KB，prompt 与全量发送逐字节相同）；响应头不再等检索索引，
  片段按命中行范围读取，同一文件的多条命中一次扫描。
- **Git**：`gitRoot` 与 rev-parse 结果缓存，Git 面板刷新从 5 个 `git.exe` 降到热路径 2 个；提交后复用宿主返回的状态，
  只重取提交日志。
- **可复现基准**：`pnpm perf` 覆盖终端启动（三种 shell 的 spawn / 首字节 / 可交互时间，以及「预热就绪 / 认领预热 /
  不预热干等」）、客户端包体积与解析成本（含按需 chunk）、宿主入口加载成本，结果写到
  `perf-results/baseline.json`（已 gitignore）。本机实测预热认领约 2 ms、不预热点新建到提示符约 100–160 ms
  （shell 冷启动成本被面板打开/悬停的空档吸收）。当前包基线：主包 `lib/client.js` 1.75 MB
  （gzip 约 375 KB，V8 编译约 18 ms），宿主入口 import 约 37 ms。
- **没有引入 native/Rust 扩展**：宿主热点主要是 Windows 进程创建（每次 `git.exe` / shell 约 44ms 的下限）与协议开销，
  不是 JS 计算；这部分纯 JS 优化即可拿到大部分收益，而 native addon 需要同时覆盖 Electron 与 Node 两套 ABI、
  每个平台各带预编译产物，安装体积与分发成本不划算。

## 演示

<p align="center">
  <img src="https://raw.githubusercontent.com/PrismScopes/dsh-aide/main/assets/screenshots/explorer.png" width="800" alt="资源管理器与 Monaco 编辑器">
  <br><em>资源管理器与 Monaco 编辑器</em>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/PrismScopes/dsh-aide/main/assets/screenshots/source-control.png" width="800" alt="源代码管理与提交图表">
  <br><em>源代码管理与提交图表</em>
</p>

<p align="center">
  <img src="https://pic1.imgdb.cn/i/034GkZFU8ULHsWgFio93Lw.png" width="800" alt="终端">
  <br><em>终端</em>
</p>


## 安装

```bash
dsh plugin --profile web add dsh-aide
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

### 版本要求

PDF / Word 预览的渲染栈通过 DSH 客户端模块系统的按需 chunk（`require.async`）加载，要求 DSH `0.2.1-rc.2` 及以上（插件 `package.json` 的 `dsh.compatibility` 已声明）。更老的宿主上这两个预览会提示“当前 DSH 版本不支持按需加载”，其余功能不受影响。

## 收录与推广

AIDE 面向 DSH 社区发布，收录状态会持续更新：

- **GitHub**：[PrismScopes/dsh-aide](https://github.com/PrismScopes/dsh-aide) —— 仓库已带 `dsh-plugin` / `deepseek-harness` topics，多个插件目录会自动索引。
- **DSH Market**：[已收录](https://dsh.market/?plugin=PrismScopes%2Fdsh-aide) —— dsh.market（dshmarket）每日扫描 `dsh-plugin` topic 与社区精选列表。
- **DSH Plugin Hub**：[已收录](https://dsh-plugin.org/zh/plugins/prismscopes/dsh-aide) —— dsh-plugin.org 社区插件市场，按 topic 自动收录，含中文条目。
- **DSH Profile Hub**：[已收录](https://dshpluginhub.ai/zh/plugins/dsh-aide) —— dshpluginhub.ai，按 npm 小时级同步，也可浏览 / 分享 Profile。
- **npm**：`dsh-aide` —— 尚未发布到 npm；发布后进入各索引源（`package.json` 已声明 `dsh.bundle` 清单、精确 SemVer 与 `cordis.patch.yml`）。
- **dsh.so 插件市场**：[提交入口](https://www.dsh.so/zh/submit/) —— 粘贴仓库或包名，做 schema 校验与安全扫描后进入市场。
- **awesome-dsh-plugin**：[community catalog](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) —— 一个插件一个 `data/plugins/<owner>__<repo>.yml`，满足 `dsh.bundle` + topic 后提交 PR。

已提交的收录（审核 / 同步中）：[awesome-dsh-plugin #8551](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8551) · [awesome-dsh-plugins #145](https://github.com/kejixiaoliang/awesome-dsh-plugins/pull/145) · [dshopen.org #17](https://github.com/polang233/dsh-plugin-index/issues/17)。

> 支持自定义插件索引的客户端，可以直接添加 `https://github.com/PrismScopes/dsh-aide`。

## 快捷键

下表是**默认键位**：在「DSH 设置 → AIDE → 快捷键」点「查看」打开快捷键面板，可按命令名或键帽搜索，
点右侧键帽就地录制新的组合键（与其它命令或编辑器内置键位冲突会提示），也可以单条恢复默认或一键恢复全部。
编辑器内置的查找/替换/转到行/注释/格式化由 Monaco 提供，只展示、不可改。

| 快捷键 | 操作 |
| --- | --- |
| `Ctrl+Shift+E` | 打开资源管理器 |
| `Ctrl+Shift+F` | 打开搜索并聚焦输入框 |
| `Ctrl+Shift+H` | 打开搜索并展开替换 |
| `F4` / `Shift+F4` | 下一个 / 上一个搜索结果 |
| `Ctrl+Shift+G` | 打开源代码管理 |
| `Ctrl+S` | 保存当前文件 |
| `Ctrl+Alt+B` | 显示或隐藏 DSH 对话栏 |
| `Ctrl+\`` | 显示或隐藏终端 |
| `Ctrl+Shift+\`` | 新建终端 |
| `Tab` | 采纳整条补全建议 |
| `Ctrl+方向键右` | 采纳建议的下一段 |
| `Ctrl+Alt+方向键右` | 采纳建议的下一行 |
| `Alt+[` / `Alt+]` | 上一条 / 下一条候选 |
| `F12` / `Ctrl+点击` | 转到定义 |
| `Shift+F12` | 查找所有引用 |
| `F2` | 重命名符号 |
| `Ctrl+Shift+O` | 转到文件中的符号 |
| `Ctrl+T` | 转到工作区中的符号 |
| `Ctrl+.` | 快速修复 / 代码操作 |
| `Ctrl+Shift+M` | 显示或隐藏问题面板 |
| `F8` / `Shift+F8` | 下一个 / 上一个问题 |

左侧活动栏的终端按钮可切换显示或隐藏终端面板；「问题」按钮显示错误/警告角标并打开问题面板。

## 安全

Host 只接受当前 DSH 会话工作目录内的相对路径，并阻止目录穿越与符号链接越界。保存使用版本校验与原子替换；Git 与 ripgrep 使用参数数组启动，不拼接 Shell 命令。终端只接受同源 loopback 请求，固定在会话工作目录启动，并移除 API key、token、secret 等敏感环境变量。语言服务只从 `PATH` 已发现或用户显式配置的可执行文件启动外部服务器（参数数组、不经过 shell）；工作区外文件只有语言服务自己程序内的 `SourceFile` 能被读出（用于只读跳转标签），不能借此任意读盘。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm perf    # 性能基线（终端启动 / 客户端包 / 宿主入口）
```

需要 Node.js `^22.19 || >=24`、pnpm 11.7、系统 Git，以及 `node-pty` 所需的本机构建环境（预编译产物不可用时）。

## Contributors

- **作者 / 维护者**：[PrismScopes](https://github.com/PrismScopes)
- **来源**：AIDE 最初基于 [tingfeng347/dsh-vscode-workbench](https://github.com/tingfeng347/dsh-vscode-workbench)（MIT）演进而来，感谢原作者的基础工作；本仓库保留 MIT 许可与完整提交历史。

欢迎提交 Issue / PR 一起把 AIDE 做得更好。

## 许可证

[MIT](LICENSE)
