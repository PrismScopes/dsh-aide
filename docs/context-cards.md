# 输入框上下文卡片

AIDE 把编辑器的结构化上下文（当前文件、诊断）加进 DSH 对话输入框，用的是 DSH 原生**引用 chip**：
输入框草稿里的一枚圆角胶囊（图标 + 标题），发送时由 AIDE 注册的 codec 序列化成模型文本。

## 怎么用

有三条入口，最终都落到同一个 composer chip：

1. **在输入框里输入 `@`**：候选列表会多出「AIDE 上下文」一组，包含
   - `文件 · a.ts`（当前编辑器标签）
   - `当前文件问题（N）`
   - `工作区问题（N）`
2. **问题面板 →「交给 AI」**：把当前范围（开了「仅当前文件」就是当前文件，否则整个工作区）
   作为问题卡片加入草稿；按钮成功后显示 ✓ 约 3 秒。
3. **资源管理器 →「添加到对话」** / **编辑器 DSH 子菜单 →「添加为上下文卡片」**：
   分别加入文件引用、选区引用。

## 设计要点

- **传类型，不传快照**：卡片的 ref 只存 `{ kind, cwd, path/scope }`。问题列表在**发送时**由 codec 读
  诊断 store 现拼；所以高频诊断不会用加入卡片那一刻的过期快照。
- **chip 是 DSH 原生机制**：复用 `sessions.scope(sessionId)` → `conversation.input.for(actx)` 的
  `insertReference` 与 `ctx.inputTriggers.registerSource`，不另建一套附件模型，也不改 DSH composer 内部。
- **插入位置在草稿末尾**：程序化插入时按 `draft.length - Σ(chip.length - 1)` 把 clipboard 偏移换成
  detect 偏移，再以 `draftRev` 做 CAS；编辑器在 chip 后自动补一个空格。
- **安全退化**：没有 DSH composer 服务（旧版本/测试环境）时，自动回退到原来的文本插入
  （`dshChat.insertTextIntoComposer`），按钮永远有反馈。

## 实现位置

| 文件 | 职责 |
| --- | --- |
| `src/client/contextRequest.ts` | 面板/菜单 → Workbench 的事件总线（`requestContextCard`） |
| `src/client/contextCards.ts` | `@` 候选源、chip 插入、发送时序列化、无服务回落 |
| `src/client/Workbench.tsx` | 提供当前 `sessionId`/`cwd`/`activePath`，监听请求并交给 contextCards |
| `src/client/index.tsx` | 插件 apply 时 `installContextCards(ctx)`；编辑器菜单入口 |
| `src/client/ProblemsPanel.tsx` / `OutputPanel.tsx` | 「交给 AI」/「加入对话」按钮 |

## 已知限制

- chip 的显示只是紧凑胶囊（图标 + 标题），没有缩略图或摘要正文；完整内容在发送时展开。
- 文件卡片序列化为 `@相对路径`，文件内容由宿主的文件引用机制在 pre-step 解析；如果宿主没有该能力，
  模型只看到路径。
- 诊断卡片上限 200 条（超出以 `+` 标记），避免一次塞爆上下文。
- 选择器候选目前只有当前文件与问题两类；符号、终端输出等来源可以后续往同一个 source 里加。
