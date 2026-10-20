/**
 * 「DeepSeek Harness」子菜单的数据（纯数据，不含 DOM / 传输层）。
 *
 * 编辑器右键菜单用一个 `submenu` 父项承载它（见 ContextMenu.tsx 的子菜单支持）：
 * 顶部是「添加至对话」，中间是按问题类型分好的询问动作，最后是把选区复制成 Markdown 引用。
 *
 * 这里只依赖调用方传进来的 actions 接口：菜单项「有哪些、何时禁用、点了调谁」可以单测，
 * 真正的插入由 dshChat.ts 实现，由 MonacoEditor / Workbench 接线后注入。
 */
import type { MenuEntry, MenuItem, MenuSeparator } from './ContextMenu.tsx'
import type { DshAskKind } from './dshChat.ts'

const item = (value: Omit<MenuItem, 'kind'>): MenuItem => ({ kind: 'item', ...value })
const line = (): MenuSeparator => ({ kind: 'separator' })

export interface DshMenuActions {
  /** 把当前选区以引用形式写进对话输入框（不发送）。 */
  addToConversation(): void
  /** 按类型询问 DSH；`ask` 表示「询问 DSH…」（由调用方弹框收集自定义问题）。 */
  ask(kind: DshAskKind): void
  /** 只把选区复制成 Markdown 引用，不碰 DSH。 */
  copyQuote(): void
}

export interface DshMenuContext {
  /** 编辑器里当前有没有选中文本；没有选区时所有使用选区的项都禁用。 */
  hasSelection: boolean
  /** 对话栏是否可用（浏览器里有 `document`；插入失败会退回剪贴板）。不可用时只留「复制为引用」。 */
  available: boolean
  actions: DshMenuActions
}

/**
 * 「DeepSeek Harness」子菜单的内容，按展示顺序返回。
 *
 * 图标按语义各配一枚、互不重复（旧版是 sparkle×3 / edit×3 / check×2，看起来像没做完）；
 * 父项「DeepSeek Harness」仍用 sparkle，不在这里。
 *
 * 禁用规则：
 * - 所有需要把选区交给对话栏的项（添加 / 询问 / 解释…审查）都要「有选区 + 对话栏可用」；
 * - 「复制为引用」只依赖选区，对话栏不可用时仍可用（它不碰 DSH）。
 */
export function dshMenuEntries(context: DshMenuContext): readonly MenuEntry[] {
  const { hasSelection, available, actions } = context
  const canAsk = hasSelection && available
  return [
    item({ id: 'dsh-add', label: '添加至对话', icon: 'comment-discussion', disabled: !canAsk, onSelect: actions.addToConversation }),
    line(),
    item({ id: 'dsh-ask', label: '询问 DSH…', icon: 'comment', disabled: !canAsk, onSelect: () => actions.ask('ask') }),
    item({ id: 'dsh-explain', label: '解释这段代码', icon: 'book', disabled: !canAsk, onSelect: () => actions.ask('explain') }),
    item({ id: 'dsh-fix', label: '修复这段代码', icon: 'wrench', disabled: !canAsk, onSelect: () => actions.ask('fix') }),
    item({ id: 'dsh-refactor', label: '重构这段代码', icon: 'tools', disabled: !canAsk, onSelect: () => actions.ask('refactor') }),
    item({ id: 'dsh-tests', label: '生成单元测试', icon: 'beaker', disabled: !canAsk, onSelect: () => actions.ask('tests') }),
    item({ id: 'dsh-comment', label: '添加注释', icon: 'note', disabled: !canAsk, onSelect: () => actions.ask('comment') }),
    item({ id: 'dsh-review', label: '审查这段代码', icon: 'checklist', disabled: !canAsk, onSelect: () => actions.ask('review') }),
    line(),
    item({ id: 'dsh-copy-quote', label: '复制为引用', icon: 'quote', disabled: !hasSelection, onSelect: actions.copyQuote }),
  ]
}
