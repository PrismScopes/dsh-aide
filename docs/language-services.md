# 语言服务（LSP / 诊断 / 跳转）

AIDE 0.7 起内置语言服务：诊断（squiggle + 问题面板）、跳转、悬停、引用、重命名、符号、补全、签名帮助与快速修复。实现分成两条通路，对编辑器是同一套能力：

| 通路 | 负责 | 何时加载 |
| --- | --- | --- |
| 内置 TypeScript/JavaScript 语言服务 | `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`，读 `tsconfig.json`、解析工作区 `node_modules` 类型 | 第一次打开 TS/JS 文件时懒加载 `typescript` |
| 外部 LSP 服务器 | Python / Rust / Go / C/C++ / YAML / Shell / Lua / PHP / Ruby / Dockerfile / Makefile，以及用户自定义服务器 | 第一次打开对应语言文件且找到可执行文件时启动 |

普通文本、JSON、CSS、HTML 仍由 Monaco 自带能力提供（JSON/CSS/HTML 的 worker 与校验保留；TS/JS 的自带语言特性被显式关闭，避免和宿主服务给出两套结果 —— 语法高亮、格式化、折叠与同类词高亮不受影响）。

## 功能

| 能力 | 入口 |
| --- | --- |
| 转到定义 | `F12` 或按住 `Ctrl`/`⌘` 点击标识符 |
| 查找所有引用 | `Shift+F12` |
| 重命名符号 | `F2`（跨文件编辑：已打开文件走编辑器、未打开文件由宿主原子写盘） |
| 文件中的符号 | `Ctrl+Shift+O` |
| 工作区符号 | `Ctrl+T` |
| 快速修复 / 代码操作 | `Ctrl+.`（含「整理导入」） |
| 悬停 | 鼠标停留（跟随 DSH 主题） |
| 补全 / 签名帮助 | 输入 `.`、`(` 等触发；Monaco 补全列表与签名 UI |
| 问题面板 | 活动栏「问题」图标、状态栏错误/警告计数、`Ctrl+Shift+M` |
| 下一个 / 上一个问题 | `F8` / `Shift+F8` |
| 工作区扫描 | 问题面板右上角「扫描工作区」（内置 TS 对整个程序检查一次，在 worker 中执行，不阻塞宿主） |

快捷键全部走 AIDE 的快捷键注册表（设置页可改、可解绑、参与冲突检测），默认值对齐 VS Code。

诊断推送是增量、防抖的：客户端停止输入约 260ms 后把正文推给宿主，宿主合并计算后经专用 WebSocket 推回；同一 tick 的诊断在客户端合并刷新（80ms 窗口），几百条诊断不会把问题面板刷成重渲染风暴。问题面板按文件分组、可折叠、可按严重级别与文本过滤，点击直接跳到对应行列。

跳到工作区外的文件（`node_modules` 里的声明、TypeScript 的 `lib.*.d.ts`）会开一个**只读标签**：内容由语言服务接口提供（内置 TS 只交出自己程序里的 `SourceFile`），不能编辑、没有保存语义，但可以在里面继续悬停与跳转。

## 配置

设置页「DSH 设置 → AIDE → 语言服务」：

- **启用语言服务**：总开关（宿主写入 `%DSH_HOME%/language.settings.json`，立即生效；关闭后不再诊断/跳转/补全）。
- **内置 TypeScript**：只影响内置 TS/JS 服务，外部服务器不受它影响。
- **悬停提示 / 语言补全**：纯客户端偏好（`localStorage`，`dvw:workbench:prefs:v1`），只影响 Monaco 里弹不弹这两类 UI。
- 服务器状态列表：内置 / 已发现 / 启动中 / 运行中 / 启动失败 / 未安装 / 已关闭。
- 设置文件路径与环境变量覆盖提示。

`%DSH_HOME%/language.settings.json` 形如：

```json
{
  "enabled": true,
  "builtinTypescript": true,
  "servers": [
    {
      "id": "my-python",
      "name": "Pyright",
      "command": "pyright-langserver",
      "args": ["--stdio"],
      "languages": ["python"],
      "extensions": ["py"]
    }
  ]
}
```

`servers` 是自定义服务器；只写 `extensions` 时按扩展名反推语言 id。已知目录无需配置：`pyright-langserver`/`pylsp`、`rust-analyzer`、`gopls`、`clangd`、`yaml-language-server`、`bash-language-server`、`lua-language-server`、`intelephense`、`solargraph`、`docker-langserver`、`make-language-server`。服务器从 `PATH`（Windows 含 `PATHEXT`）发现，找不到就显示「未安装」，不会报错。

环境变量（排查/临时验证用，优先级最高）：

- `DSH_AIDE_LANGUAGE=0`：关闭全部语言服务；`1` 强制打开。
- `DSH_AIDE_LANGUAGE_BUILTIN=0`：只关内置 TS/JS。
- `DSH_AIDE_LANGUAGE_SERVERS='[{"command":"gopls","languages":["go"]}]'`：内联自定义服务器数组。

## 协议与实现

宿主侧：

- `src/language/protocol.ts`：两端共用的纯类型（0 基位置/范围、诊断、编辑、符号、补全、签名、代码操作）。
- `src/language/typescript.ts`：基于 TypeScript 编译器 API 的语言服务（`LanguageServiceHost` 支持客户端内存正文、磁盘 mtime 版本、tsconfig include/exclude、程序内只读文件读取）。
- `src/language/lsp/{transport,client,external}.ts`：真正的 LSP 客户端 —— stdio 子进程、`Content-Length` 帧、JSON-RPC 2.0（超时/取消/服务端请求）、`initialize` 能力协商、`publishDiagnostics` 转公共诊断；外部服务器实现同一 `LanguageProvider` 接口。
- `src/language/manager.ts`：按工作区挑 provider、维护文档版本、诊断防抖与扫描、请求路由、跨文件编辑写盘。
- `src/language/host.ts` + `routes.ts`：每个工作区一份管理器；HTTP 请求（`/dsh-vscode/api/language.*`）与专用 WebSocket（`/dsh-vscode/ws/language`）推送。

客户端：

- `src/client/language/client.ts`：HTTP + WebSocket 客户端、文档同步（串行队列 + 合并窗口）、编辑应用（打开的文件改模型、其余写盘）。
- `src/client/language/diagnostics.ts`：按工作区的诊断 store（问题面板/状态栏/标记共同读一份）。
- `src/client/language/monaco.ts`：关闭 Monaco 自带 TS 语言特性，注册悬停/补全/签名 provider。
- `src/client/language/actions.ts`：跳转/引用/重命名/符号/快速修复/问题导航；键盘走 window 捕获阶段、Ctrl+点击直接接管，跨文件跳转交给工作台标签系统。
- `src/client/ProblemsPanel.tsx`：问题面板；`src/client/problemStyles.ts`：面板样式。

## 限制（有意为之）

- 问题面板显示「已打开文件」的诊断；未打开文件的错误用「扫描工作区」主动检查（仅内置 TS）。
  扫描用 `program.getSemanticDiagnostics()` 对整个程序检查一次，再按文件分组回推；计算在
  `lib/scan-worker.js` 的 worker 里执行，宿主事件循环不会被 TypeScript 语义检查占住（补全、Git、
  终端、保存等操作在扫描期间仍可响应）。源码/测试环境没有 worker 产物时回退到同一实现的进程内扫描。
- 外部 LSP 服务器不支持工作区全量扫描：LSP 没有「把所有文件诊断给我」的标准请求，按 VS Code 的行为只显示服务器报告过的文件。
- 补全不逐条请求 `completionItem/resolve`（避免每次补全几十个 HTTP 往返），因此没有逐条详情；snippet 以字面量插入。
- 格式化仍由 Monaco/服务器自己的格式化能力负责（内置 TS 的格式化保留）；重命名不处理 `prefixText/suffixText`。
- 外部服务器崩溃后不自动重启（避免崩溃循环）；改设置会重建语言服务，相当于一次恢复。
- 语言服务不监听文件系统：磁盘上的外部改动会在下次打开/同步时被 mtime 感知，会话期间**新建**的文件需要打开一次才进入内置 TS 程序。
- 单文件超过 60 万字符不参与语言服务（请求体上限 2 MiB 的保护）：该文件仍有语法高亮与编辑能力，只是没有诊断/跳转/补全。
