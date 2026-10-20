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

/**
 * 源码编辑器菜单里每个动作的落点；具体实现由 MonacoEditor.tsx 提供。
 *
 * 为什么既有具名 action 又有 `run`：具名字段是上一版接线（MonacoEditor.tsx）的兼容面，保留它们
 * 不会让现有调用点报错；新菜单项则统一走 `run(commandId)`，新增一项只要给一个 Monaco 命令 id，
 * 不必在接口上再加一个方法。`save` 不是 Monaco 命令（走工作台自己的保存回调），继续用具名字段。
 */
interface EditorMenuActions {
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
  /**
   * 统一执行 Monaco 命令。调用方用 `editor.trigger('dsh-menu', commandId, null)` 或
   * `editor.getAction(commandId)?.run()`；剪贴板命令（editor.action.clipboard*）仍需在组件里
   * 走 copyText/readClipboard 回退（见 MonacoEditor.tsx 的 runClipboardAction）。
   */
  run(commandId: string): void
}

export interface EditorMenuContext {
  /** 只读模型上编辑类动作不会生效，菜单里要禁掉，免得点了没反应。 */
  readOnly: boolean
  /** 没有选中文本时「剪切/复制/转为大写」之类无从下手。 */
  hasSelection: boolean
  /** 由调用方用 editor.getAction('editor.action.formatDocument')?.isSupported() 判断。 */
  canFormat: boolean
  /**
   * `editor.getAction(commandId)?.isSupported?.() === true`；动作不存在时按 false 处理。
   * 纯文本文件没有语言服务，转到定义/查找引用/重命名符号因此禁用。
   */
  isSupported(commandId: string): boolean
  actions: EditorMenuActions
}

/**
 * 源码编辑器菜单：顶层保持精简（撤销/重做/剪切/复制/粘贴 · 六个分组子菜单 · 保存）。
 *
 * 为什么改成子菜单：30 项平铺会把菜单撑得很长、也很难扫读；按 VS Code 的「选择/转到/行操作」
 * 思路把同类命令收进二级菜单后，顶层只剩 12 项，用户找一组同类操作时不用从头读到尾。
 * 两级是 ContextMenu 支持的范围（子菜单里不再嵌套子菜单）。
 *
 * 每一项都只描述「文案 + 禁用条件 + 要执行的 Monaco 命令」，不碰 editor 实例；
 * 这样禁用矩阵、commandId 与两级结构都能在 node 环境单测（见 tests/editor-menus.spec.ts）。
 *
 * 图标策略：只有六个子菜单父项各带一枚互不重复的图标，叶子项一律不带 —— 用户反馈
 * 「右键菜单 SVG 太多重复的」，而 VS Code 的右键菜单本身也几乎不用图标。
 */
export function editorMenuItems(context: EditorMenuContext): MenuEntry[] {
  const { readOnly, hasSelection, canFormat, isSupported, actions } = context

  /**
   * 一条「执行 Monaco 命令」的菜单项：id 稳定，label 中文，shortcut 仅展示。
   *
   * 菜单项一律不带图标：右键菜单纯文字更清爽（VS Code 的右键菜单也几乎不用图标），
   * 之前满屏重复字形反而看不出这一组动作的重点。
   */
  const command = (options: {
    id: string
    commandId: string
    label: string
    shortcut?: string
    disabled?: boolean
  }): MenuItem => item({
    id: options.id,
    label: options.label,
    shortcut: options.shortcut,
    disabled: options.disabled,
    onSelect: () => actions.run(options.commandId),
  })

  /**
   * 子菜单父项。`onSelect` 是接口必需字段，但 ContextMenu 对带 `submenu` 的项只会展开、不会执行它；
   * 父项在所有叶子都禁用时也禁用 —— 否则用户点开的是一个全灰的子菜单，等于多一步空操作。
   *
   * 父项也不带图标（用户要求整体去掉右键菜单图标）；`chevron-right` 由菜单壳统一画，表示可展开。
   *
   * 父项 id 统一带 `-menu` 后缀（叶子 id 保持既有约定不变），这样整张菜单的 id 全局唯一：
   * 埋点/测试按 id 定位时不必再关心它是父项还是叶子，也避免以后新增同名项时撞 id。
   */
  const group = (options: { id: string; label: string; entries: MenuEntry[] }): MenuItem => item({
    id: options.id,
    label: options.label,
    disabled: options.entries.every(entry => entry.kind === 'separator' || entry.disabled === true),
    submenu: options.entries,
    onSelect: () => {},
  })

  return [
    command({ id: 'editor-undo', commandId: 'undo', label: '撤销', shortcut: 'Ctrl+Z', disabled: readOnly }),
    command({ id: 'editor-redo', commandId: 'redo', label: '重做', shortcut: 'Ctrl+Shift+Z', disabled: readOnly }),
    command({ id: 'editor-cut', commandId: 'editor.action.clipboardCutAction', label: '剪切', shortcut: 'Ctrl+X', disabled: readOnly || !hasSelection }),
    command({ id: 'editor-copy', commandId: 'editor.action.clipboardCopyAction', label: '复制', shortcut: 'Ctrl+C', disabled: !hasSelection }),
    command({ id: 'editor-paste', commandId: 'editor.action.clipboardPasteAction', label: '粘贴', shortcut: 'Ctrl+V', disabled: readOnly }),
    separator(),
    group({
      id: 'editor-select-menu',
      label: '选择',
      entries: [
        command({ id: 'editor-select-all', commandId: 'editor.action.selectAll', label: '全选', shortcut: 'Ctrl+A' }),
        command({ id: 'editor-select-highlights', commandId: 'editor.action.selectHighlights', label: '选择所有出现', shortcut: 'Ctrl+Shift+L', disabled: !hasSelection || !isSupported('editor.action.selectHighlights') }),
        separator(),
        command({ id: 'editor-cursor-above', commandId: 'editor.action.insertCursorAbove', label: '在上方添加光标', shortcut: 'Ctrl+Alt+↑' }),
        command({ id: 'editor-cursor-below', commandId: 'editor.action.insertCursorBelow', label: '在下方添加光标', shortcut: 'Ctrl+Alt+↓' }),
      ],
    }),
    group({
      id: 'editor-find-menu',
      label: '查找',
      entries: [
        command({ id: 'editor-find', commandId: 'actions.find', label: '查找', shortcut: 'Ctrl+F' }),
        command({ id: 'editor-replace', commandId: 'editor.action.startFindReplaceAction', label: '替换', shortcut: 'Ctrl+H' }),
        command({ id: 'editor-goto-line', commandId: 'editor.action.gotoLine', label: '转到行', shortcut: 'Ctrl+G' }),
      ],
    }),
    group({
      id: 'editor-goto-menu',
      label: '转到',
      entries: [
        command({ id: 'editor-reveal-definition', commandId: 'editor.action.revealDefinition', label: '转到定义', shortcut: 'F12', disabled: !isSupported('editor.action.revealDefinition') }),
        command({ id: 'editor-find-references', commandId: 'editor.action.referenceSearch.trigger', label: '查找引用', shortcut: 'Shift+F12', disabled: !isSupported('editor.action.referenceSearch.trigger') }),
        command({ id: 'editor-rename-symbol', commandId: 'editor.action.rename', label: '重命名符号', shortcut: 'F2', disabled: !isSupported('editor.action.rename') }),
      ],
    }),
    group({
      id: 'editor-lines-menu',
      label: '行操作',
      entries: [
        command({ id: 'editor-move-line-up', commandId: 'editor.action.moveLinesUpAction', label: '上移行', shortcut: 'Alt+↑', disabled: readOnly }),
        command({ id: 'editor-move-line-down', commandId: 'editor.action.moveLinesDownAction', label: '下移行', shortcut: 'Alt+↓', disabled: readOnly }),
        command({ id: 'editor-copy-line-down', commandId: 'editor.action.copyLinesDownAction', label: '复制行', shortcut: 'Shift+Alt+↓', disabled: readOnly }),
        command({ id: 'editor-delete-line', commandId: 'editor.action.deleteLines', label: '删除行', shortcut: 'Ctrl+Shift+K', disabled: readOnly }),
        separator(),
        command({ id: 'editor-indent-lines', commandId: 'editor.action.indentLines', label: '增加缩进', shortcut: 'Ctrl+]', disabled: readOnly }),
        command({ id: 'editor-outdent-lines', commandId: 'editor.action.outdentLines', label: '减少缩进', shortcut: 'Ctrl+[', disabled: readOnly }),
      ],
    }),
    group({
      id: 'editor-convert-menu',
      label: '转换',
      entries: [
        command({ id: 'editor-transform-uppercase', commandId: 'editor.action.transformToUppercase', label: '转为大写', disabled: readOnly || !hasSelection }),
        command({ id: 'editor-transform-lowercase', commandId: 'editor.action.transformToLowercase', label: '转为小写', disabled: readOnly || !hasSelection }),
        separator(),
        command({ id: 'editor-comment-line', commandId: 'editor.action.commentLine', label: '切换行注释', shortcut: 'Ctrl+/', disabled: readOnly }),
        command({ id: 'editor-block-comment', commandId: 'editor.action.blockComment', label: '切换块注释', shortcut: 'Shift+Alt+A', disabled: readOnly }),
      ],
    }),
    group({
      id: 'editor-format-menu',
      label: '格式化',
      entries: [
        command({ id: 'editor-format', commandId: 'editor.action.formatDocument', label: '格式化文档', shortcut: 'Shift+Alt+F', disabled: readOnly || !canFormat }),
        command({ id: 'editor-format-selection', commandId: 'editor.action.formatSelection', label: '格式化选中内容', shortcut: 'Ctrl+K Ctrl+F', disabled: readOnly || !canFormat || !hasSelection }),
        separator(),
        // 折叠/展开不修改文本，只读与没有 formatter 时也能用；它们让「格式化 ▸」几乎总是可展开。
        command({ id: 'editor-fold', commandId: 'editor.fold', label: '折叠', shortcut: 'Ctrl+Shift+[' }),
        command({ id: 'editor-unfold', commandId: 'editor.unfold', label: '展开', shortcut: 'Ctrl+Shift+]' }),
      ],
    }),
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

interface DiffMenuContext {
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
    item({ id: 'diff-copy', label: '复制', shortcut: 'Ctrl+C', disabled: !hasSelection, onSelect: actions.copy }),
    item({ id: 'diff-select-all', label: '全选', shortcut: 'Ctrl+A', onSelect: actions.selectAll }),
    separator(),
    item({
      id: 'diff-toggle-display',
      label: mode === 'split' ? '切换到行内显示' : '切换到并排显示',
      onSelect: actions.toggleDisplay,
    }),
  ]
}

/** 编辑器容器的视口矩形（`getBoundingClientRect()` 的子集，纯函数里不依赖 DOMRect）。 */
interface EditorContainerRect {
  left: number
  top: number
  width: number
  height: number
}

/** 光标相对编辑器容器左上角的可见位置（`getScrolledVisiblePosition()` 结果的子集）。 */
interface CursorOffset {
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
