/**
 * 「DeepSeek Harness」子菜单的数据（纯数据，不含 DOM / 传输层）。
 *
 * 编辑器右键菜单用一个 `submenu` 父项承载它（见 ContextMenu.tsx 的子菜单支持）：
 * 顶部是「添加至对话」，中间是按问题类型分好的询问动作，最后是把选区复制成 Markdown 引用。
 *
 * 这里只依赖调用方传进来的 actions 接口：菜单项「有哪些、何时禁用、点了调谁」可以单测，
 * 真正的插入/发送由 dshChat.ts 实现，由 MonacoEditor / Workbench 接线后注入。
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
  /** DSH 对话服务是否可用；不可用时只留「复制为引用」。 */
  available: boolean
  actions: DshMenuActions
}

/**
 * 「DeepSeek Harness」子菜单的内容，按展示顺序返回。
 *
 * 禁用规则：
 * - 所有需要把选区交给对话的项（添加 / 询问 / 解释…审查）都要「有选区 + 服务可用」；
 * - 「复制为引用」只依赖选区，服务不可用时仍可用（它不碰 DSH）。
 */
export function dshMenuEntries(context: DshMenuContext): readonly MenuEntry[] {
  const { hasSelection, available, actions } = context
  const canAsk = hasSelection && available
  return [
    item({ id: 'dsh-add', label: '添加至对话', icon: 'sparkle', disabled: !canAsk, onSelect: actions.addToConversation }),
    line(),
    item({ id: 'dsh-ask', label: '询问 DSH…', icon: 'sparkle', disabled: !canAsk, onSelect: () => actions.ask('ask') }),
    item({ id: 'dsh-explain', label: '解释这段代码', icon: 'sparkle', disabled: !canAsk, onSelect: () => actions.ask('explain') }),
    item({ id: 'dsh-fix', label: '修复这段代码', icon: 'edit', disabled: !canAsk, onSelect: () => actions.ask('fix') }),
    item({ id: 'dsh-refactor', label: '重构这段代码', icon: 'edit', disabled: !canAsk, onSelect: () => actions.ask('refactor') }),
    item({ id: 'dsh-tests', label: '生成单元测试', icon: 'check', disabled: !canAsk, onSelect: () => actions.ask('tests') }),
    item({ id: 'dsh-comment', label: '添加注释', icon: 'edit', disabled: !canAsk, onSelect: () => actions.ask('comment') }),
    item({ id: 'dsh-review', label: '审查这段代码', icon: 'check', disabled: !canAsk, onSelect: () => actions.ask('review') }),
    line(),
    item({ id: 'dsh-copy-quote', label: '复制为引用', icon: 'copy', disabled: !hasSelection, onSelect: actions.copyQuote }),
  ]
}
