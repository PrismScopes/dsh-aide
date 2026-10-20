import { separator, type MenuEntry, type MenuItem } from './ContextMenu.tsx'

/**
 * 编辑器右键菜单的**内容**（纯数据）与可单测的判定逻辑。
 *
 * 为什么要自建菜单：Monaco 独立版（monaco-editor）内置的右键菜单由 VS Code 的 nls 本地化机制
 * 出文案，而我们用 AMD loader 直接加载 editor.main，没有装载任何中文语言包 —— 运行时只能拿到
 * 英文。Monaco 也没有公开「覆盖菜单文案」的 API（菜单项来自内部 MenuRegistry），所以唯一干净的
 * 做法是关掉它（创建选项 `contextmenu: false`），复用工作台统一的 ContextMenu.tsx，
 * 把菜单项收进这份数据里。这样编辑器菜单与资源管理器/标签页/终端菜单同为中文、同一样式。
 *
 * 这里不碰 DOM，也不 import monaco：调用方（MonacoEditor.tsx）只负责把编辑器实例翻译成下面这些
 * context/actions，于是「有哪些项、何时禁用、点了调哪个动作」可以在 node 环境直接单测。
 */

const item = (value: Omit<MenuItem, 'kind'>): MenuItem => ({ kind: 'item', ...value })

/** 源码编辑器菜单里每个动作的落点；具体实现由 MonacoEditor.tsx 用 Monaco 命令/动作提供。 */
export interface EditorMenuActions {
  undo(): void
  redo(): void
  cut(): void
  copy(): void
  paste(): void
  selectAll(): void
  find(): void
  replace(): void
  gotoLine(): void
  commentLine(): void
  format(): void
  fold(): void
  unfold(): void
  save(): void
}

export interface EditorMenuContext {
  /** 只读模型上编辑类动作不会生效，菜单里要禁掉，免得点了没反应。 */
  readOnly: boolean
  /** 没有选中文本时「剪切/复制」无从下手。 */
  hasSelection: boolean
  /** 由调用方用 editor.getAction('editor.action.formatDocument')?.isSupported() 判断。 */
  canFormat: boolean
  actions: EditorMenuActions
}

/**
 * 源码编辑器菜单。分组顺序对齐 VS Code 的编辑区右键菜单：
 * 撤销/重做 · 剪切/复制/粘贴 · 全选 · 查找/替换/转到行 · 注释/格式化 · 折叠/展开 · 保存。
 */
export function editorMenuItems(context: EditorMenuContext): MenuEntry[] {
  const { readOnly, hasSelection, canFormat, actions } = context
  return [
    item({ id: 'editor-undo', label: '撤销', shortcut: 'Ctrl+Z', disabled: readOnly, onSelect: actions.undo }),
    item({ id: 'editor-redo', label: '重做', shortcut: 'Ctrl+Shift+Z', disabled: readOnly, onSelect: actions.redo }),
    separator(),
    item({ id: 'editor-cut', label: '剪切', shortcut: 'Ctrl+X', disabled: readOnly || !hasSelection, onSelect: actions.cut }),
    item({ id: 'editor-copy', label: '复制', icon: 'copy', shortcut: 'Ctrl+C', disabled: !hasSelection, onSelect: actions.copy }),
    item({ id: 'editor-paste', label: '粘贴', shortcut: 'Ctrl+V', disabled: readOnly, onSelect: actions.paste }),
    separator(),
    item({ id: 'editor-select-all', label: '全选', shortcut: 'Ctrl+A', onSelect: actions.selectAll }),
    separator(),
    item({ id: 'editor-find', label: '查找', icon: 'search', shortcut: 'Ctrl+F', onSelect: actions.find }),
    item({ id: 'editor-replace', label: '替换', shortcut: 'Ctrl+H', onSelect: actions.replace }),
    item({ id: 'editor-goto-line', label: '转到行', shortcut: 'Ctrl+G', onSelect: actions.gotoLine }),
    separator(),
    item({ id: 'editor-comment-line', label: '注释行', shortcut: 'Ctrl+/', disabled: readOnly, onSelect: actions.commentLine }),
    item({ id: 'editor-format', label: '格式化文档', icon: 'sparkle', shortcut: 'Shift+Alt+F', disabled: readOnly || !canFormat, onSelect: actions.format }),
    separator(),
    item({ id: 'editor-fold', label: '折叠', shortcut: 'Ctrl+Shift+[', onSelect: actions.fold }),
    item({ id: 'editor-unfold', label: '展开', shortcut: 'Ctrl+Shift+]', onSelect: actions.unfold }),
    separator(),
    item({ id: 'editor-save', label: '保存', shortcut: 'Ctrl+S', onSelect: actions.save }),
  ]
}

export interface DiffMenuActions {
  copy(): void
  selectAll(): void
  /** 在并排 / 行内两种显示方式之间切换。 */
  toggleDisplay(): void
}

export interface DiffMenuContext {
  hasSelection: boolean
  /** 当前显示方式；菜单项给的是「切到另一种」的文案与图标。 */
  mode: 'inline' | 'split'
  actions: DiffMenuActions
}

/**
 * 差异对比菜单。差异视图两侧都是只读模型，所以没有剪切/粘贴/格式化的位置，只保留复制、全选，
 * 再加上 VS Code 差异视图里的「切换并排/行内」—— 工作台把这项能力放在菜单里，因此不必去找工具栏。
 */
export function diffMenuItems(context: DiffMenuContext): MenuEntry[] {
  const { hasSelection, mode, actions } = context
  return [
    item({ id: 'diff-copy', label: '复制', icon: 'copy', shortcut: 'Ctrl+C', disabled: !hasSelection, onSelect: actions.copy }),
    item({ id: 'diff-select-all', label: '全选', shortcut: 'Ctrl+A', onSelect: actions.selectAll }),
    separator(),
    item({
      id: 'diff-toggle-display',
      label: mode === 'split' ? '切换到行内显示' : '切换到并排显示',
      icon: mode === 'split' ? 'diff-single' : 'diff-sidebyside',
      onSelect: actions.toggleDisplay,
    }),
  ]
}

/** 编辑器容器的视口矩形（`getBoundingClientRect()` 的子集，纯函数里不依赖 DOMRect）。 */
export interface EditorContainerRect {
  left: number
  top: number
  width: number
  height: number
}

/** 光标相对编辑器容器左上角的可见位置（`getScrolledVisiblePosition()` 结果的子集）。 */
export interface CursorOffset {
  left: number
  top: number
  height?: number
}

/**
 * 键盘打开右键菜单时的落点。
 *
 * 键盘（Shift+F10 / ContextMenu 键）没有指针坐标，只能落在光标上：把「相对编辑器容器的坐标」
 * 加上容器的视口偏移，就得到 ContextMenu 需要的 clientX/clientY。光标已滚出视口
 * （getScrolledVisiblePosition 返回 null）或容器还没布局时回退到容器中心 —— 菜单至少要出现在
 * 编辑器附近，不能因为取不到坐标就静默不弹。
 */
export function menuPositionAtCursor(cursor: CursorOffset | null | undefined, container: EditorContainerRect): { x: number; y: number } {
  if (cursor === null || cursor === undefined) {
    return { x: container.left + container.width / 2, y: container.top + container.height / 2 }
  }
  return { x: container.left + cursor.left, y: container.top + cursor.top + (cursor.height ?? 0) }
}

/** 主选区快照：复制/剪切回退只需要「有没有选中」和「选中了什么」。 */
export interface SelectionSnapshot {
  hasSelection: boolean
  text: string
}

/**
 * 复制回退的决策。
 *
 * Monaco 的剪贴板动作在桌面端可能压根没注册（见 clipboard.ts 对非安全上下文的说明），这时要自己
 * 读模型选区。没有选区或选区为空时返回 undefined —— 不能拿空串去写剪贴板，否则会把用户原本的
 * 剪贴板内容清掉。
 */
export function copyFallbackText(selection: SelectionSnapshot): string | undefined {
  return selection.hasSelection && selection.text !== '' ? selection.text : undefined
}

/**
 * 粘贴回退的决策。剪贴板读不到（undefined）或为空串时什么都不插入 —— 桌面端没有剪贴板权限是常态，
 * 此时插入空串毫无意义，还会在撤销栈里留一步空操作。
 */
export function pasteFallbackText(clipboard: string | undefined): string | undefined {
  return clipboard === undefined || clipboard === '' ? undefined : clipboard
}
