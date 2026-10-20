/**
 * 编辑器偏好 → Monaco 选项的纯映射，以及划词高亮/概览标尺的主题配色。
 *
 * 为什么要单独一个模块：同一个偏好要在三个地方生效 —— 编辑器创建参数、`updateOptions`、
 * 以及模型级的 `model.updateOptions`（tabSize / insertSpaces 属于模型选项，不是编辑器选项）。
 * 如果把这些映射散在组件里，创建与更新两条路径迟早会漂；而且 Monaco 只能在浏览器 AMD
 * loader 之后加载，node 单测里跑不起来。这里只做「偏好对象 → 普通对象」的映射，返回值的
 * 字段名与 Monaco 的选项一一对应（类型上直接交叉 Monaco 的 IEditorOptions /
 * IGlobalEditorOptions，写错字段名会编译失败），单测在 node 环境里断言这些对象即可。
 *
 * 偏好的类型、取值范围、默认值与清洗规则全部在 preferences.ts（单一事实源）；这里只做
 * 「WorkbenchPreferences 字段 → Monaco 选项名」的翻译，不再自带一份范围/默认值/清洗函数。
 * 映射入口仍过一遍 normalizePreferences：防的是手改 localStorage 的坏值 —— 未知值回落
 * 默认而不是喂给 Monaco（Monaco 的枚举校验会静默丢弃，表现为「设置页改了却没生效」）。
 * 这只是复用同一份规则，不是第二套实现。
 */
import type { editor as MonacoEditor } from 'monaco-editor'
import {
  normalizePreferences,
  type CursorStyle,
  type RenderWhitespace,
  type WordWrapMode,
  type WorkbenchPreferences,
} from './preferences.ts'

/**
 * 编辑器选项。交叉了 Monaco 的两个选项接口，所以字段名与取值都受 Monaco 类型检查 ——
 * 真正 spread 给 `monaco.editor.create` / `updateOptions` 时不需要再断言。
 *
 * 注意 `occurrencesHighlight`：Monaco 0.52 把它改成了枚举 `off | singleFile | multiFile`，
 * 不再是布尔。传 `false` 会被枚举校验丢弃并回落默认值 `singleFile`，也就是「关不掉」；
 * 所以这里把偏好显式翻译成 `off` / `singleFile`（单文件内高亮，正是 VS Code 的划词行为）。
 */
type EditorOptions = MonacoEditor.IEditorOptions & MonacoEditor.IGlobalEditorOptions & {
  fontSize: number
  lineHeight: number
  tabSize: number
  insertSpaces: boolean
  wordWrap: WordWrapMode
  wordWrapColumn: number
  minimap: { enabled: boolean }
  occurrencesHighlight: 'off' | 'singleFile' | 'multiFile'
  selectionHighlight: boolean
  renderWhitespace: RenderWhitespace
  cursorStyle: CursorStyle
  smoothScrolling: boolean
  stickyScroll: { enabled: boolean }
  bracketPairColorization: { enabled: boolean }
}

/**
 * 模型级选项。tabSize / insertSpaces 属于 `model.updateOptions`，不是编辑器选项：
 * 差异编辑器的创建选项甚至不接受它们，所以单独给一份，创建后与偏好变化时都喂给模型。
 */
interface EditorModelOptions {
  tabSize: number
  insertSpaces: boolean
}

export function editorModelOptions(preferences: WorkbenchPreferences): EditorModelOptions {
  const value = normalizePreferences(preferences)
  return { tabSize: value.editorTabSize, insertSpaces: value.editorInsertSpaces }
}

/** 偏好 → 编辑器选项。创建与后续 updateOptions 共用它，两条路径不会漂。 */
export function editorOptions(preferences: WorkbenchPreferences): EditorOptions {
  const value = normalizePreferences(preferences)
  return {
    fontSize: value.editorFontSize,
    lineHeight: value.editorLineHeight,
    tabSize: value.editorTabSize,
    insertSpaces: value.editorInsertSpaces,
    wordWrap: value.editorWordWrap,
    // 只有 bounded 读它，但始终带上：对象形状稳定，切换模式时不会残留上一次的值。
    wordWrapColumn: value.editorWordWrapColumn,
    minimap: { enabled: value.editorMinimap },
    // 「划词整体文档高亮」= 同一个偏好的两件事：
    //   occurrencesHighlight 高亮光标/选区处那个词的所有出现（语义高亮层）；
    //   selectionHighlight  高亮选中文本在文档中的其他出现（选区高亮层）。
    // VS Code 默认两者都开，叠加起来才是用户看到的「全文同类词都亮起来」。
    occurrencesHighlight: value.editorOccurrencesHighlight ? 'singleFile' : 'off',
    selectionHighlight: value.editorOccurrencesHighlight,
    renderWhitespace: value.editorRenderWhitespace,
    cursorStyle: value.editorCursorStyle,
    smoothScrolling: value.editorSmoothScrolling,
    stickyScroll: { enabled: value.editorStickyScroll },
    // VS Code 的默认行为，不设偏好：括号对着色始终开。
    bracketPairColorization: { enabled: true },
  }
}

/** 两个编辑器共用的外框：窄滚动条 + 由偏好决定的概览标尺。 */
interface EditorChrome {
  renderOverviewRuler: boolean
  overviewRulerLanes: number
  hideCursorInOverviewRuler: boolean
  scrollbar: { verticalScrollbarSize: number; horizontalScrollbarSize: number }
}

/** 工作台的既定滚动条尺寸：比 Monaco 默认（14）窄，贴合 DSH 的观感。 */
export const WORKBENCH_SCROLLBAR = { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 } as const

/**
 * 外框选项。
 *
 * 概览标尺开：`renderOverviewRuler: true` + `overviewRulerLanes: 3`（VS Code 默认的
 * 三条泳道：选区、同类词、查找各一条），并让光标在标尺上可见。
 * 概览标尺关：完全收起（0 条泳道），不占水平空间、不画光标标记。
 */
export function editorChrome(preferences: Pick<WorkbenchPreferences, 'editorOverviewRuler'>): EditorChrome {
  // 未知值按默认（开）处理：概览标尺是 VS Code 的默认观感；清洗规则与偏好存储是同一份。
  const overviewRuler = normalizePreferences(preferences).editorOverviewRuler
  return {
    renderOverviewRuler: overviewRuler,
    overviewRulerLanes: overviewRuler ? 3 : 0,
    hideCursorInOverviewRuler: !overviewRuler,
    // 滚动条尺寸不随标尺变化：标尺只是右侧同一块区域里的标记层，不额外占用编辑区宽度。
    scrollbar: { ...WORKBENCH_SCROLLBAR },
  }
}

/**
 * 主题里新增的高亮配色。
 *
 * 为什么要有这份纯数据：`dshMonacoTheme` 只在浏览器里注册主题，node 单测断言不到；
 * 把它拆成「键名 + 令牌 + 深浅色兜底」的纯数据后，测试可以直接断言关键四类颜色存在、
 * 且暗色/亮色取值正确。`token` 为空串表示 DSH 没有语义合适的令牌，直接用 VS Code
 * 官方主题的值；有令牌时优先令牌，令牌给不出合法颜色时由调用方的 monacoColor 回落兜底。
 */
interface HighlightColorSpec {
  /** Monaco 主题 colors 的键名。 */
  readonly id: string
  /** DSH 主题令牌（CSS 变量名）；空串 = 没有合适的令牌。 */
  readonly token: string
  readonly dark: string
  readonly light: string
}

export const EDITOR_HIGHLIGHT_COLORS: readonly HighlightColorSpec[] = [
  // 选区高亮：选中文本的其余出现。VS Code Dark+ / Light+ 的半透明蓝。
  // 这两个必须带 alpha，所以不接不透明的 DSH 令牌。
  { id: 'editor.selectionHighlightBackground', token: '', dark: '#ADD6FF26', light: '#ADD6FF80' },
  { id: 'editor.selectionHighlightBorder', token: '', dark: '#00000000', light: '#00000000' },
  // 同类词高亮：光标所在词的 occurrence 高亮。
  { id: 'editor.wordHighlightBackground', token: '', dark: '#575757B8', light: '#57575740' },
  { id: 'editor.wordHighlightStrongBackground', token: '', dark: '#004972B8', light: '#0E639C40' },
  { id: 'editor.findMatchHighlightBackground', token: '', dark: '#EA5C0055', light: '#EA5C0055' },
  // 概览标尺上的标记用**白色**（深色主题）而不是 DSH 的蓝色强调色：标尺与滚动条滑块挤在
  // 右侧同一条窄带里，蓝色跟选区/强调色糊在一起反而看不清；VS Code 的标尺标记也是中性色。
  // 接 --dsw-alias-label-primary：深色主题下它本身就是白色，浅色主题下是近黑（白标记在浅色
  // 灰底上不可见，所以这里跟随前景色而不是硬编码白）。透明度给足，避免和滑块叠成一块。
  { id: 'editorOverviewRuler.selectionHighlightForeground', token: '--dsw-alias-label-primary', dark: '#FFFFFFE6', light: '#1F1F1FCC' },
  { id: 'editorOverviewRuler.wordHighlightForeground', token: '--dsw-alias-label-primary', dark: '#FFFFFFE6', light: '#1F1F1FCC' },
  { id: 'editorOverviewRuler.wordHighlightStrongForeground', token: '--dsw-alias-label-primary', dark: '#FFFFFFE6', light: '#1F1F1FCC' },
  // 行内合并冲突的「当前内容」标尺标记与标尺边框：Monaco 的注册表里都有这两个键，
  // 一并接到 DSH 令牌上，免得冲突视图回落到内置主题的固定色。
  { id: 'editorOverviewRuler.currentContentForeground', token: '--dsw-alias-label-tertiary', dark: '#A0A0A0CC', light: '#A0A0A0CC' },
  // 标尺与编辑区之间的 1px 分隔线；透明会让标尺边界糊在一起，所以接边框令牌。
  { id: 'editorOverviewRuler.border', token: '--dsw-alias-border-l2', dark: '#ffffff1f', light: '#0000001a' },
]

/**
 * 滚动条滑块的不透明度。
 *
 * 滑块画在概览标尺**之上**：DSH 的滚动条令牌是不透明色块，滑块一出现就把标尺上的选区/同类词
 * 标记整块盖住 —— 表现就是「高亮明明算出来了，滑条那片什么也看不到」。这里给同一个颜色追加
 * alpha（只改透明度、不改 RGB），让底下的标尺透出来。
 * 三个态沿用 VS Code 的观感：默认最淡、悬停加深、拖动最实。
 */
export const SCROLLBAR_SLIDER_ALPHA = { background: '66', hover: '99', active: 'B3' } as const

/**
 * 给一个合法颜色追加/替换 alpha 通道。
 *
 * 只处理 Monaco 主题会遇到的写法（6/8 位 hex、rgb/rgba）；其它格式原样返回 —— 宁可保持不透明，
 * 也不要因为拼错格式让 `defineTheme` 抛错（那会让整个工作台渲染失败）。
 */
export function withAlpha(value: string, alphaHex: string): string {
  const alpha = alphaHex.replace(/^#/, '').toUpperCase()
  if (!/^[0-9A-F]{2}$/.test(alpha)) return value
  const hex6 = /^#([0-9a-f]{6})$/i.exec(value)
  if (hex6 !== null) return `#${hex6[1] ?? ''}${alpha}`
  const hex8 = /^#([0-9a-f]{8})$/i.exec(value)
  if (hex8 !== null) return `#${(hex8[1] ?? '').slice(0, 6)}${alpha}`
  const rgb = /^rgba?\(\s*([^)]+)\)$/i.exec(value)
  if (rgb !== null) {
    const parts = (rgb[1] ?? '').split(',').map(part => part.trim())
    if (parts.length >= 3) return `rgba(${parts[0] ?? '0'}, ${parts[1] ?? '0'}, ${parts[2] ?? '0'}, ${(Number.parseInt(alpha, 16) / 255).toFixed(3)})`
  }
  return value
}

/**
 * 把配色条目解析成 Monaco 主题的 colors 对象。
 *
 * `resolve` 由调用方提供（MonacoEditor 里是「读 DSH 令牌 → monacoColor 归一化」），
 * 默认实现直接返回兜底色 —— 单测用它断言 VS Code 的原值。空 token 也会经过 resolve，
 * 这样兜底色同样走一遍 monacoColor 的合法化，不会因为简写 hex 让 defineTheme 抛错。
 */
export function highlightThemeColors(
  dark: boolean,
  resolve: (token: string, fallback: string) => string = (_token, fallback) => fallback
): Record<string, string> {
  const colors: Record<string, string> = {}
  for (const spec of EDITOR_HIGHLIGHT_COLORS) {
    colors[spec.id] = resolve(spec.token, dark ? spec.dark : spec.light)
  }
  return colors
}
