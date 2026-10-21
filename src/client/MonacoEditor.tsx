import { useEffect, useRef, useState } from 'react'
import darkPlus from '@shikijs/themes/dark-plus'
import lightPlus from '@shikijs/themes/light-plus'
import { installTextMate, textMateSize } from './textmateHighlight.ts'
import { attachInlineCompletion } from './inlineCompletion.ts'
import { getPreferences, usePreferences } from './preferences.ts'
import { bindingMatches, bindingOf } from './keybindings.ts'
import { editorChrome, editorModelOptions, editorOptions, highlightThemeColors, SCROLLBAR_SLIDER_ALPHA, withAlpha } from './editorOptions.ts'
import { ContextMenu, separator, type MenuEntry } from './ContextMenu.tsx'
import { copyText, readClipboard } from './clipboard.ts'
import { contributionEntries, type EditorMenuTarget } from './editorMenuRegistry.ts'
import {
  copyFallbackText,
  diffMenuItems,
  editorMenuItems,
  menuPositionAtCursor,
  pasteFallbackText,
  type DiffMenuActions,
  type EditorMenuContext,
  type SelectionSnapshot,
} from './editorMenus.ts'

type Monaco = typeof import('monaco-editor')
declare global { interface Window { require?: { (ids: string[], done: () => void): void; config(value: unknown): void }; monaco?: Monaco } }
let loading: Promise<Monaco> | undefined

/** 读 DSH 主题令牌（渲染期从 body 上的 CSS 变量取值；无 document 时回落）。 */
function tokenOf(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.body).getPropertyValue(name).trim()
  return value || fallback
}

/**
 * 归一化为 Monaco 接受的颜色格式。
 * DSH 令牌大量使用 3/4 位简写 hex（例如 --dsw-alias-bg-base 在浅色下就是 #fff），
 * 而 monaco.editor.defineTheme 只认 6/8 位 hex 或 rgb()/rgba()，遇到简写会抛
 * "Illegal value for token color"；该异常冒到 slot 层会让整个工作台无法渲染。
 */
function monacoColor(value: string, fallback: string): string {
  const v = value.trim()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v)
  if (short) return `#${short[1]!}${short[1]!}${short[2]!}${short[2]!}${short[3]!}${short[3]!}`
  const shortAlpha = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v)
  if (shortAlpha) return `#${shortAlpha[1]!.repeat(2)}${shortAlpha[2]!.repeat(2)}${shortAlpha[3]!.repeat(2)}${shortAlpha[4]!.repeat(2)}`
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v)) return v
  if (/^(rgb|rgba|hsl|hsla)\(/i.test(v)) return v
  return fallback
}

/**
 * 语义 token 的颜色。TextMate 只做词法分析，函数与变量的区分要靠语言服务；VS Code 用语义
 * 高亮补这一层，Monaco 内置的 TS worker 同样提供（需显式开启，见 enableSemanticHighlighting）。
 * 命名沿用 VS Code / LSP 的语义 token 类型，取值对齐 VS Code Dark+ / Light+。
 * 官方主题自带的 semanticTokenColors 只有 customLiteral / newOperator / numberLiteral /
 * stringLiteral 四条，函数、变量这些主要靠这里。
 */
const SEMANTIC_DARK: Record<string, string> = {
  namespace: '4ec9b0', class: '4ec9b0', interface: '4ec9b0', enum: '4ec9b0', type: '4ec9b0',
  typeParameter: '4ec9b0', struct: '4ec9b0',
  function: 'dcdcaa', method: 'dcdcaa',
  variable: '9cdcfe', parameter: '9cdcfe', property: '9cdcfe', macro: '9cdcfe',
  enumMember: '4fc1ff',
  keyword: '569cd6', comment: '6a9955', string: 'ce9178', number: 'b5cea8', regexp: 'd16969', operator: 'd4d4d4'
}
const SEMANTIC_LIGHT: Record<string, string> = {
  namespace: '267f99', class: '267f99', interface: '267f99', enum: '267f99', type: '267f99',
  typeParameter: '267f99', struct: '267f99',
  function: '795e26', method: '795e26',
  variable: '001080', parameter: '001080', property: '001080', macro: '001080',
  enumMember: '0070c1',
  keyword: '0000ff', comment: '008000', string: 'a31515', number: '098658', regexp: '811f3f', operator: '000000'
}

/**
 * 把 VS Code 官方主题的 tokenColors 原样转成 Monaco 的 rules。
 * 两者都按 TextMate scope 命名，所以不需要映射表 —— 前提是分词器也换成 TextMate
 * （见 textmateHighlight.ts），否则 Monaco 内置分词产出的 token 名与这些 scope 对不上。
 */
interface ThemeTokenColor { scope?: string | string[]; settings?: { foreground?: string; fontStyle?: string } }
function themeRules(theme: { tokenColors?: ThemeTokenColor[] }): { token: string; foreground: string }[] {
  const rules: { token: string; foreground: string }[] = []
  for (const entry of theme.tokenColors ?? []) {
    const foreground = entry.settings?.foreground
    if (foreground === undefined) continue
    const scopes = entry.scope === undefined ? [] : Array.isArray(entry.scope) ? entry.scope : [entry.scope]
    for (const scope of scopes) {
      // VS Code 的 scope 允许写成空格分隔的多级限定（如 "source.js meta.function"），取首段。
      const token = scope.trim().split(/\s+/)[0] ?? ''
      if (token !== '') rules.push({ token, foreground: foreground.replace(/^#/, '') })
    }
  }
  return rules
}

/**
 * 注册跟随 DSH 主题的 Monaco 主题并返回主题名。
 * Monaco 内置的 vs / vs-dark 用的是固定底色（#fffffe / #1e1e1e），与 DSH 的
 * --dsw-alias-bg-layer-1 不一致，暗色下编辑区会比周边暗一档；这里把底色、
 * 行号、选区、光标、控件与滚动条统一接到 DSH 令牌上，语法色直接用 VS Code 官方主题。
 * 注册失败时回落到内置主题，绝不让异常冒到 slot 层。
 */
export function dshMonacoTheme(monaco: Monaco, theme: 'dark' | 'light'): string {
  const dark = theme === 'dark'
  const name = dark ? 'dsh-dark' : 'dsh-light'
  const color = (token: string, fallback: string): string =>
    // 空 token 表示这条配色没有对应的 DSH 令牌（高亮色需要保持 VS Code 的半透明蓝），直接走兜底。
    token === '' ? monacoColor(fallback, fallback) : monacoColor(tokenOf(token, fallback), fallback)
  try {
    // semanticHighlighting 是运行时支持的字段（editor.semanticHighlighting.enabled 的取值
    // configuredByTheme 就是读它），但没进 IStandaloneThemeData 的类型声明，用交叉类型补上，
    // 这样其余字段仍然受类型检查。
    const theme: import('monaco-editor').editor.IStandaloneThemeData & { semanticHighlighting: boolean } = {
      base: dark ? 'vs-dark' : 'vs',
      inherit: true,
      // 语义高亮的开关属于主题：Monaco 的 editor.semanticHighlighting.enabled 默认为
      // configuredByTheme，所以必须在这里声明，否则 TS / JS 只拿得到 TextMate 的词法结果，
      // 函数与变量区分不出来。
      semanticHighlighting: true,
      rules: [
        ...themeRules(dark ? darkPlus : lightPlus),
        // 语义 token 规则放在后面：同一 token 名以最后一条为准，语义高亮的结果优先于词法。
        ...Object.entries(dark ? SEMANTIC_DARK : SEMANTIC_LIGHT).map(([token, foreground]) => ({ token, foreground }))
      ],
      colors: {
        'editor.background': color('--dvw-base', dark ? '#151517' : '#ffffff'),
        'editor.foreground': color('--dsw-alias-label-primary', dark ? '#f9fafb' : '#0f1115'),
        'editorGutter.background': color('--dvw-base', dark ? '#151517' : '#ffffff'),
        'editorLineNumber.foreground': color('--dsw-alias-label-tertiary', dark ? '#adb2b8' : '#81858c'),
        'editorLineNumber.activeForeground': color('--dsw-alias-label-primary', dark ? '#f9fafb' : '#0f1115'),
        'editor.lineHighlightBackground': color('--dsw-alias-interactive-bg-hover', dark ? '#ffffff14' : '#2631480f'),
        'editor.selectionBackground': color('--dsw-alias-interactive-bg-active', dark ? '#ffffff24' : '#2631481a'),
        'editorCursor.foreground': color('--dsw-alias-label-primary', dark ? '#f9fafb' : '#0f1115'),
        'editorWidget.background': color('--dsw-alias-bg-layer-2', dark ? '#2c2c2e' : '#ffffff'),
        'editorWidget.border': color('--dsw-alias-border-l2', dark ? '#ffffff1f' : '#0000001a'),
        // 滑块必须带透明度：它画在概览标尺之上，DSH 的滚动条令牌是不透明色块，会把标尺上的
        // 选区/同类词标记整块盖住（表现为「高亮算出来了但滑条那里看不见」）。颜色仍是 DSH 令牌
        // 的原色，只追加 alpha —— 三个态沿用 VS Code 的观感（默认最淡、悬停加深、拖动最实）。
        'scrollbarSlider.background': withAlpha(color('--dsw-alias-scrollbar-bg-l1', dark ? '#3c3c3d' : '#e5e5e5'), SCROLLBAR_SLIDER_ALPHA.background),
        'scrollbarSlider.hoverBackground': withAlpha(color('--dsw-alias-scrollbar-bg-l2', dark ? '#545557' : '#e5e5e5'), SCROLLBAR_SLIDER_ALPHA.hover),
        'scrollbarSlider.activeBackground': withAlpha(color('--dsw-alias-scrollbar-bg-l2', dark ? '#545557' : '#e5e5e5'), SCROLLBAR_SLIDER_ALPHA.active),
        // 划词高亮与概览标尺的标记色。没有这几项时，选中一个词后其余同类词虽然被 Monaco
        // 算出来了却没有可见颜色（等于没高亮），概览标尺上也不会出现选区/同类词的标记。
        // 配色是纯数据（editorOptions.ts 的 EDITOR_HIGHLIGHT_COLORS），单测可断言。
        ...highlightThemeColors(dark, color)
      }
    }
    monaco.editor.defineTheme(name, theme)
  } catch (error) {
    console.warn('dsh monaco theme registration failed, falling back to builtin theme', error)
    return dark ? 'vs-dark' : 'vs'
  }
  return name
}

/**
 * 让 Monaco 的语言 worker 能解析自己的地址。
 * Monaco 默认在 blob worker 内以相对路径加载语言 worker，而 blob 上下文没有可用的
 * base URL，会抛 "Failed to parse URL from /dsh-vscode/monaco/vs/language/json/jsonWorker.js"，
 * 使 JSON 等语言的校验与补全失效。这里显式给出绝对 baseUrl。
 */
function installWorkerEnvironment(): void {
  const win = window as typeof window & { MonacoEnvironment?: unknown }
  if (win.MonacoEnvironment !== undefined) return
  const base = new URL('/dsh-vscode/monaco/vs', location.href).href
  // worker 里的模块名以 `vs/` 开头（如 vs/language/json/jsonWorker），所以 baseUrl 必须是 `vs` 的
  // **上一级**；写成 `vs/` 会拼出 `vs/vs/...`，请求必然 404 —— 表现为编辑器空白、控制台只有一句 Not Found。
  const moduleRoot = base.replace(/\/vs\/?$/, '')
  win.MonacoEnvironment = {
    getWorkerUrl: () => URL.createObjectURL(new Blob(
      [`self.MonacoEnvironment={baseUrl:'${moduleRoot}/'};importScripts('${base}/base/worker/workerMain.js');`],
      { type: 'text/javascript' }
    ))
  }
}

/**
 * 屏蔽「模块解析」这一类诊断。
 *
 * 工作台的 TS 服务运行在虚拟文件系统里，看不到磁盘上的 node_modules，因此裸包名（如
 * @deepseek-ai/...）一定解析不到 —— moduleResolution 设成什么都不管用。这类报错是环境的
 * 必然结果，不是代码问题，读代码时纯属噪声。只屏蔽解析类代码，其余诊断照常显示。
 */
const UNRESOLVABLE_MODULE_CODES = [2307, 2792, 7016, 2688]

function configureTypeScriptDiagnostics(monaco: Monaco): void {
  const typescript = monaco.languages.typescript
  if (typescript === undefined) return
  for (const defaults of [typescript.typescriptDefaults, typescript.javascriptDefaults]) {
    try {
      defaults.setDiagnosticsOptions({
        ...defaults.getDiagnosticsOptions(),
        diagnosticCodesToIgnore: UNRESOLVABLE_MODULE_CODES,
      })
    } catch (error) {
      console.warn('[dvw] 诊断过滤设置失败，编辑器照常可用：', error)
    }
  }
}

export function loadMonaco(): Promise<Monaco> {
  loading ??= new Promise((resolve, reject) => {
    const start = () => {
      const loader = window.require
      if (loader === undefined) return reject(new Error('Monaco AMD loader unavailable'))
      installWorkerEnvironment()
      loader.config({ paths: { vs: '/dsh-vscode/monaco/vs' } })
      loader(['vs/editor/editor.main'], () => {
        if (window.monaco === undefined) { reject(new Error('Monaco failed to initialize')); return }
        configureTypeScriptDiagnostics(window.monaco)
        resolve(window.monaco)
      })
    }
    if (window.require !== undefined) { start(); return }
    const script = document.createElement('script'); script.src = '/dsh-vscode/monaco/vs/loader.js'; script.onload = start; script.onerror = () => reject(new Error('failed to load Monaco')); document.head.append(script)
  })
  return loading
}

type MonacoEditorInstance = import('monaco-editor').editor.IStandaloneCodeEditor
type MonacoDiffInstance = import('monaco-editor').editor.IStandaloneDiffEditor
type MonacoMouseEvent = import('monaco-editor').editor.IEditorMouseEvent

/**
 * 菜单里的动作优先交给 Monaco 的命令执行：撤销栈、多光标、格式化确认这些语义都在编辑器内部，
 * 绕过它直接改模型会留下不一致的状态。命令不存在时 trigger 会抛错，吞掉并记日志即可。
 */
function runCommand(instance: MonacoEditorInstance, commandId: string): void {
  try {
    instance.trigger('dsh-menu', commandId, null)
  } catch (failure) {
    console.warn(`[dvw] 编辑器命令 ${commandId} 执行失败：`, failure)
  }
}

/**
 * 尝试执行 Monaco 的剪贴板动作，返回「是否已经由 Monaco 处理」。
 *
 * 为什么要回退：Monaco 的 clipboard 贡献在模块装载时就按环境能力决定这些动作**是否注册**
 * （见 monaco 的 clipboard.js：`document.queryCommandSupported('copy')`、navigator.clipboard
 * 是否存在）。桌面端 dsh-app:// 自定义协议下可能被判定为非安全上下文，动作直接不存在，
 * 或者 run 时抛权限错误；这时用工作台的 copyText/readClipboard 自己读写剪贴板。
 */
async function runClipboardAction(instance: MonacoEditorInstance, actionId: string): Promise<boolean> {
  const action = instance.getAction(actionId)
  if (action === null || !action.isSupported()) return false
  try {
    await action.run()
    return true
  } catch (failure) {
    console.warn(`[dvw] 剪贴板动作 ${actionId} 不可用，改用 AIDE 回退：`, failure)
    return false
  }
}

/** 主选区快照；复制/剪切回退只认它（判定逻辑放在 editorMenus.ts，便于单测）。 */
function selectionSnapshot(instance: MonacoEditorInstance): SelectionSnapshot {
  const model = instance.getModel()
  const selection = instance.getSelection()
  if (model === null || selection === null) return { hasSelection: false, text: '' }
  return { hasSelection: !selection.isEmpty(), text: model.getValueInRange(selection) }
}

/** 键盘打开菜单时的落点：光标处；取不到光标（滚出视口）时回退到编辑器中心。 */
function cursorMenuPosition(instance: MonacoEditorInstance): { x: number; y: number } {
  const position = instance.getPosition()
  const visible = position === null ? null : instance.getScrolledVisiblePosition(position)
  const rect = instance.getContainerDomNode().getBoundingClientRect()
  return menuPositionAtCursor(visible, { left: rect.left, top: rect.top, width: rect.width, height: rect.height })
}

/**
 * 剪切：Monaco 动作优先。动作不存在时先回退复制，**复制成功才删选区** ——
 * 否则会出现「剪贴板没内容但文本已经没了」。
 */
async function cutSelection(instance: MonacoEditorInstance): Promise<void> {
  if (await runClipboardAction(instance, 'editor.action.clipboardCutAction')) return
  const selection = instance.getSelection()
  const text = copyFallbackText(selectionSnapshot(instance))
  if (selection === null || text === undefined) return
  if (!(await copyText(text))) return
  instance.pushUndoStop()
  instance.executeEdits('dsh-menu', [{ range: selection, text: '' }])
  instance.pushUndoStop()
}

/** 复制：Monaco 动作优先；动作不可用时直接读模型选区（差异编辑器的只读模型也适用）。 */
async function copySelection(instance: MonacoEditorInstance): Promise<void> {
  if (await runClipboardAction(instance, 'editor.action.clipboardCopyAction')) return
  const text = copyFallbackText(selectionSnapshot(instance))
  if (text !== undefined) await copyText(text)
}

/** 粘贴：Monaco 动作不可用时读剪贴板，再以一次可撤销的编辑插到主选区。 */
async function pasteInto(instance: MonacoEditorInstance): Promise<void> {
  if (await runClipboardAction(instance, 'editor.action.clipboardPasteAction')) return
  const text = pasteFallbackText(await readClipboard())
  const selection = instance.getSelection()
  if (text === undefined || selection === null) return
  instance.pushUndoStop()
  instance.executeEdits('dsh-menu', [{ range: selection, text }])
  instance.pushUndoStop()
}

/**
 * Monaco 里有些命令是 Action2（registerAction2）：它们不在 `editor.getAction()` 的注册表里，
 * 只按 `getAction()?.isSupported()` 判断会永远禁用。这些命令用 `trigger` 能执行，内部
 * precondition 不满足时安全 no-op，所以这里只要求「有模型」就算可用。
 */
const ACTION2_COMMANDS = new Set(['editor.action.revealDefinition', 'editor.action.referenceSearch.trigger'])

/** 把编辑器实例翻译成菜单上下文：菜单数据本身不 import monaco，判定逻辑才好单测。 */
function editorMenuContext(instance: MonacoEditorInstance, save: () => void): EditorMenuContext {
  return {
    readOnly: instance.getRawOptions().readOnly === true,
    hasSelection: selectionSnapshot(instance).hasSelection,
    // 有没有可用的格式化器只能问 Monaco：TS worker / 已注册的 DocumentFormattingEditProvider。
    canFormat: instance.getAction('editor.action.formatDocument')?.isSupported() === true,
    isSupported: (commandId: string): boolean => {
      const action = instance.getAction(commandId)
      if (action !== null) return action.isSupported()
      return ACTION2_COMMANDS.has(commandId) && instance.getModel() !== null
    },
    actions: {
      undo: () => { runCommand(instance, 'undo') },
      redo: () => { runCommand(instance, 'redo') },
      cut: () => { void cutSelection(instance) },
      copy: () => { void copySelection(instance) },
      paste: () => { void pasteInto(instance) },
      selectAll: () => { runCommand(instance, 'editor.action.selectAll') },
      find: () => { runCommand(instance, 'actions.find') },
      replace: () => { runCommand(instance, 'editor.action.startFindReplaceAction') },
      gotoLine: () => { runCommand(instance, 'editor.action.gotoLine') },
      commentLine: () => { runCommand(instance, 'editor.action.commentLine') },
      format: () => { runCommand(instance, 'editor.action.formatDocument') },
      fold: () => { runCommand(instance, 'editor.fold') },
      unfold: () => { runCommand(instance, 'editor.unfold') },
      save,
      /**
       * 菜单统一执行入口。剪贴板三个动作在不同环境里可能根本没注册（依赖
       * navigator.clipboard / queryCommandSupported），所以仍然走带回退的实现；
       * 其余命令 trigger 即可（Action2 与命令型 undo/redo 都覆盖得到）。
       */
      run: (commandId: string) => {
        if (commandId === 'editor.action.clipboardCopyAction') { void copySelection(instance); return }
        if (commandId === 'editor.action.clipboardCutAction') { void cutSelection(instance); return }
        if (commandId === 'editor.action.clipboardPasteAction') { void pasteInto(instance); return }
        runCommand(instance, commandId)
      },
    },
  }
}

/** 打开菜单那一刻的编辑器状态：选区文本、文件路径、语言与行区间，贡献者据此决定菜单项。 */
function editorMenuTarget(instance: MonacoEditorInstance): EditorMenuTarget {
  const model = instance.getModel()
  const selection = instance.getSelection()
  const position = instance.getPosition()
  const hasSelection = model !== null && selection !== null && !selection.isEmpty()
  const filePath = model?.uri.path.replace(/^\/+/, '')
  const currentLine = position?.lineNumber ?? 1
  return {
    ...(filePath === undefined || filePath === '' ? {} : { filePath }),
    language: model?.getLanguageId() ?? 'plaintext',
    hasSelection,
    selectionText: hasSelection && model !== null && selection !== null ? model.getValueInRange(selection) : '',
    lineStart: hasSelection && selection !== null ? selection.startLineNumber : currentLine,
    lineEnd: hasSelection && selection !== null ? selection.endLineNumber : currentLine,
  }
}

/**
 * 组装右键菜单：**置顶贡献**（DeepSeek Harness 子菜单）→ 标准编辑项 → 追加贡献。
 * 分隔线只在段与段之间补，避免空贡献也留下一条孤线。
 */
function buildEditorMenuEntries(instance: MonacoEditorInstance, save: () => void): MenuEntry[] {
  const target = editorMenuTarget(instance)
  const top = contributionEntries(target, 'top')
  const bottom = contributionEntries(target, 'bottom')
  const entries: MenuEntry[] = []
  if (top.length > 0) entries.push(...top, separator())
  entries.push(...editorMenuItems(editorMenuContext(instance, save)))
  if (bottom.length > 0) entries.push(separator(), ...bottom)
  return entries
}

/** 差异编辑器里右键落在哪一侧；复制/全选只作用于该侧的只读模型。 */
type DiffSide = 'original' | 'modified'

function diffActions(instance: MonacoDiffInstance, side: DiffSide, toggleDisplay: () => void): DiffMenuActions {
  const inner = side === 'original' ? instance.getOriginalEditor() : instance.getModifiedEditor()
  return {
    copy: () => { void copySelection(inner) },
    selectAll: () => { runCommand(inner, 'editor.action.selectAll') },
    toggleDisplay,
  }
}

/**
 * 差异编辑器本身没有 onContextMenu，菜单挂到它的两个子编辑器上。
 * contextmenu:false 之后 Monaco 不再 preventDefault，浏览器原生（英文）菜单会冒出来，所以这里
 * 自己拦住；overlay widget（如查找输入框）保留浏览器原生菜单，否则输入框里的复制粘贴就没了。
 *
 * 键盘入口也一并补上：`contextmenu:false` 同时让 Monaco 不再处理 Shift+F10 / ContextMenu 键，
 * addCommand 的动态键位优先级高于内置的 editor.action.showContextMenu（后者现在不弹菜单）。
 * 键盘打开时落在 modified 侧，位置取该侧的光标。
 */
function bindDiffContextMenu(monaco: Monaco, instance: MonacoDiffInstance, open: (side: DiffSide, x: number, y: number, keyboard: boolean) => void): void {
  for (const side of ['original', 'modified'] as const) {
    const inner = side === 'original' ? instance.getOriginalEditor() : instance.getModifiedEditor()
    inner.onContextMenu((event: MonacoMouseEvent) => {
      if (event.target.type === monaco.editor.MouseTargetType.OVERLAY_WIDGET) return
      event.event.preventDefault()
      event.event.stopPropagation()
      open(side, event.event.browserEvent.clientX, event.event.browserEvent.clientY, false)
    })
  }
  const modified = instance.getModifiedEditor()
  const openAtCursor = () => {
    // 动态键位是全局的（不随编辑器销毁），用焦点判断保证只有当前差异编辑器响应。
    if (!instance.hasTextFocus()) return
    const point = cursorMenuPosition(modified)
    open('modified', point.x, point.y, true)
  }
  modified.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F10, openAtCursor)
  modified.addCommand(monaco.KeyCode.ContextMenu, openAtCursor)
}

export function MonacoDiffEditor(props: { uri: string; original: string; modified: string; mode: 'inline' | 'split'; theme: 'dark' | 'light' }) {
  const root = useRef<HTMLDivElement>(null)
  const editor = useRef<MonacoDiffInstance>()
  const models = useRef<{ original: import('monaco-editor').editor.ITextModel; modified: import('monaco-editor').editor.ITextModel }>()
  const [error, setError] = useState<string>()
  // 右键位置与它落在哪一侧；keyboard 标记用于关闭后把焦点还给编辑器（键盘用户不能丢焦点）。
  const [menu, setMenu] = useState<{ x: number; y: number; side: DiffSide; keyboard: boolean } | undefined>(undefined)
  // 显示方式的临时覆盖：菜单里的「切换并排/行内」只影响本组件，工作台的 mode 变化时再以它为准。
  const [modeOverride, setModeOverride] = useState<'inline' | 'split' | undefined>(undefined)
  const displayMode = modeOverride ?? props.mode
  const preferences = usePreferences()
  useEffect(() => {
    let disposed = false
    setMenu(undefined)
    void loadMonaco().then(async (monaco) => {
      if (disposed || root.current === null) return
      const safe = props.uri.replace(/^\/+/, '')
      const original = monaco.editor.createModel(props.original, undefined, monaco.Uri.parse(`dvw-diff-original:///${safe}`))
      const modified = monaco.editor.createModel(props.modified, undefined, monaco.Uri.parse(`dvw-diff-modified:///${safe}`))
      models.current = { original, modified }
      // 换成 TextMate 分词器，让高亮与 VS Code 同源；失败则继续用 Monaco 内置分词。
      // 带上模型规模：超过阈值的文件不注入（否则从头分词可达数百 ms），回退内置分词。
      await installTextMate(monaco, [original.getLanguageId()], textMateSize(original)).catch(() => undefined)
      if (disposed || root.current === null) return
      // 偏好取当前值而不是本次渲染的闭包值：这个 effect 只依赖 uri，不随偏好重跑（重跑会重建编辑器）。
      // 差异编辑器的创建选项不接受 tabSize/insertSpaces（它们属于模型），所以先拆出来。
      const editorPreferences = getPreferences()
      const { tabSize: _tabSize, insertSpaces: _insertSpaces, ...editorLayerOptions } = editorOptions(editorPreferences)
      const instance = monaco.editor.createDiffEditor(root.current, {
        automaticLayout: true,
        readOnly: true,
        renderSideBySide: props.mode === 'split',
        theme: dshMonacoTheme(monaco, props.theme),
        ...editorChrome(editorPreferences),
        ...editorLayerOptions,
        // 关掉 Monaco 内置的英文右键菜单，改用工作台统一的中文 ContextMenu（原因见 editorMenus.ts）。
        contextmenu: false,
        originalEditable: false,
        ignoreTrimWhitespace: false,
      })
      instance.setModel({ original, modified })
      const modelOptions = editorModelOptions(editorPreferences)
      original.updateOptions(modelOptions)
      modified.updateOptions(modelOptions)
      editor.current = instance
      bindDiffContextMenu(monaco, instance, (side, x, y, keyboard) => { if (!disposed) setMenu({ x, y, side, keyboard }) })
    }).catch(error => setError(error instanceof Error ? error.message : String(error)))
    return () => {
      disposed = true
      editor.current?.dispose()
      editor.current = undefined
      models.current?.original.dispose()
      models.current?.modified.dispose()
      models.current = undefined
    }
  }, [props.uri])
  useEffect(() => {
    const value = models.current
    if (value === undefined) return
    if (value.original.getValue() !== props.original) value.original.setValue(props.original)
    if (value.modified.getValue() !== props.modified) value.modified.setValue(props.modified)
  }, [props.original, props.modified])
  // 菜单临时切过显示方式后，工作台自己的 mode 变化要以 props.mode 为准，清掉覆盖。
  useEffect(() => { setModeOverride(undefined) }, [props.mode])
  useEffect(() => { editor.current?.updateOptions({ renderSideBySide: displayMode === 'split' }) }, [displayMode])
  useEffect(() => { if (window.monaco !== undefined) window.monaco.editor.setTheme(dshMonacoTheme(window.monaco, props.theme)) }, [props.theme])
  // 偏好变了就地同步：差异视图跟着设置页一起变，不必关掉再打开。
  // 外框（概览标尺开关）与编辑器选项都要重算；tabSize/insertSpaces 走模型的 updateOptions。
  useEffect(() => {
    const instance = editor.current
    if (instance === undefined) return
    instance.updateOptions({ ...editorChrome(preferences), ...editorOptions(preferences) })
    const modelOptions = editorModelOptions(preferences)
    models.current?.original.updateOptions(modelOptions)
    models.current?.modified.updateOptions(modelOptions)
  }, [preferences])
  const entries = menu === undefined || editor.current === undefined ? undefined : diffMenuItems({
    hasSelection: selectionSnapshot(menu.side === 'original' ? editor.current.getOriginalEditor() : editor.current.getModifiedEditor()).hasSelection,
    mode: displayMode,
    actions: diffActions(editor.current, menu.side, () => setModeOverride(displayMode === 'split' ? 'inline' : 'split')),
  })
  // 键盘打开的菜单关闭后把焦点还给编辑器；鼠标打开的不要抢 —— 用户可能是点在别处关闭的。
  const closeMenu = () => {
    setMenu(undefined)
    if (menu?.keyboard === true) editor.current?.getModifiedEditor().focus()
  }
  return error === undefined
    ? <>
        <div className="dvw-diff dvw-monaco-diff" data-mode={displayMode} data-render-side-by-side={displayMode === 'split'} ref={root}/>
        {menu !== undefined && entries !== undefined && <ContextMenu position={{ x: menu.x, y: menu.y }} label="差异编辑器操作" entries={entries} onClose={closeMenu}/>}
      </>
    : <div className="dvw-error">{error}</div>
}

/** 同时缓存多少个「当前没在用」的 Monaco 模型。 */
export const MODEL_CACHE_LIMIT = 12

/** 回收函数需要的最小模型接口（单测注入假模型，不碰真 Monaco）。 */
interface CachedModelHandle { uri: string; dispose(): void }
interface PruneModelsOptions {
  /** 正在使用 + 仍打开的标签（URI 形式）。 */
  keep: ReadonlySet<string>
  /** 脏文件：无论上限如何都保留（调用方通常已把它们并进 keep，这里再兜一层）。 */
  dirty?: ReadonlySet<string>
  /** 最近使用在前（LRU 顺序）。 */
  recentOrder: readonly string[]
  /** 允许保留的「未使用」模型数量，默认 MODEL_CACHE_LIMIT。 */
  limit?: number
}

/**
 * 纯函数：按 LRU 回收不再需要的 Monaco 模型，返回被 dispose 的 URI。
 *
 * 规则：
 * - `keep` / `dirty` 里的模型**永远不回收**（当前编辑器在用的那一个必须由调用方放进 keep，
 *   否则编辑器会拿到已 dispose 的模型）；
 * - 其余模型按 `recentOrder`（最近使用在前）保留最新的 `limit` 个，更旧的 dispose；
 *   `recentOrder` 里没有的按「最旧」处理；
 * - 被回收文件的 undo 栈会丢 —— 与 VS Code 里关掉标签再打开一致（文件内容还在磁盘/标签里，
 *   只是撤销历史不保留）。仍打开或脏的标签不会被回收，所以不会丢未保存内容。
 */
export function pruneModels(models: readonly CachedModelHandle[], options: PruneModelsOptions): string[] {
  const limit = Math.max(0, options.limit ?? MODEL_CACHE_LIMIT)
  const retained = new Set<string>([...options.keep, ...(options.dirty ?? [])])
  const rank = new Map<string, number>()
  options.recentOrder.forEach((uri, index) => { if (!rank.has(uri)) rank.set(uri, index) })
  const evictable = models
    .filter(model => !retained.has(model.uri))
    .sort((left, right) => (rank.get(left.uri) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.uri) ?? Number.MAX_SAFE_INTEGER))
  const evicted = evictable.slice(limit)
  for (const model of evicted) model.dispose()
  return evicted.map(model => model.uri)
}

/**
 * 本组件创建的 file:/// 模型。只回收自己造的 —— Monaco 里可能还有别的插件或差异编辑器的模型
 * （`dvw-diff-*` 由 MonacoDiffEditor 自己 dispose），不能按「所有模型」一刀切。
 *
 * 模型生命周期是编辑器自己的知识（Workbench 只知道「哪些标签开着」），所以这份簿记放模块级；
 * 「哪些不能回收」由 Workbench 通过 props 传入，不在这里做全局单例。
 */
const ownedModels = new Set<string>()
/** 最近使用在前的 LRU 顺序（组件在切标签时可能重建，所以同样放模块级）。 */
const modelRecency: string[] = []
function touchModel(uri: string): void {
  const index = modelRecency.indexOf(uri)
  if (index !== -1) modelRecency.splice(index, 1)
  modelRecency.unshift(uri)
}
/** 把「打开的标签路径」归一成模型 URI（与创建模型时同一套拼法，两边才比得上）。 */
function modelUri(monaco: Monaco, path: string): string {
  return monaco.Uri.parse(`file:///${path.replace(/^\/+/, '')}`).toString()
}
/**
 * 回收一次：当前模型 + 仍打开/脏的标签保留，其余按 LRU 只留 MODEL_CACHE_LIMIT 个。
 * 触发点是「编辑器挂载」（切文件、新建模型），不在每次 keystroke 上跑。
 */
function evictModels(monaco: Monaco, currentUri: string, keepPaths: readonly string[], dirtyPaths: readonly string[]): string[] {
  const keep = new Set<string>([currentUri, ...keepPaths.map(path => modelUri(monaco, path))])
  const dirty = new Set<string>(dirtyPaths.map(path => modelUri(monaco, path)))
  const owned: CachedModelHandle[] = monaco.editor.getModels()
    .filter(model => ownedModels.has(model.uri.toString()))
    .map(model => ({ uri: model.uri.toString(), dispose: () => model.dispose() }))
  const evicted = pruneModels(owned, { keep, dirty, recentOrder: modelRecency })
  for (const uri of evicted) ownedModels.delete(uri)
  // 顺序表只留最近一小段：被回收/关闭的模型不必继续占位（更旧的会按「最旧」处理，结果不变）。
  if (modelRecency.length > MODEL_CACHE_LIMIT * 4) modelRecency.length = MODEL_CACHE_LIMIT * 4
  return evicted
}

export function MonacoEditor(props: { uri: string; value: string; theme: 'dark' | 'light'; line?: number; column?: number; sessionId?: string; keepModelPaths?: readonly string[]; dirtyModelPaths?: readonly string[]; onChange(value: string): void; onSave(): void }) {
  const root = useRef<HTMLDivElement>(null)
  const editor = useRef<MonacoEditorInstance>()
  const callbacks = useRef({ onChange: props.onChange, onSave: props.onSave })
  callbacks.current = { onChange: props.onChange, onSave: props.onSave }
  const preferences = usePreferences()
  // 挂载 effect 只依赖 uri，闭包里的 props.value 是挂载那一刻的值；内容往往之后才到，
  // 因此这里另存一份最新值，在模型建立后用它写入。
  const valueRef = useRef(props.value)
  valueRef.current = props.value
  // 「打开 / 脏」集合只在挂载 effect 里读一次（用 ref 持有最新值）：它们变化不该重建编辑器。
  // undefined 表示调用方还不知道工作区（拿不到 cwd）：这时不做回收判定，宁可不回收也别误伤。
  const keepPathsRef = useRef<readonly string[] | undefined>(props.keepModelPaths)
  keepPathsRef.current = props.keepModelPaths
  const dirtyPathsRef = useRef<readonly string[] | undefined>(props.dirtyModelPaths)
  dirtyPathsRef.current = props.dirtyModelPaths
  const [error, setError] = useState<string>()
  // 右键菜单的位置；keyboard 标记用于关闭后把焦点还给编辑器（键盘用户不能丢焦点）。
  // 菜单项在渲染时按当时的选区现算。
  const [menu, setMenu] = useState<{ x: number; y: number; keyboard: boolean } | undefined>(undefined)
  useEffect(() => {
    let disposed = false; let model: import('monaco-editor').editor.ITextModel | undefined
    setMenu(undefined)
    void loadMonaco().then(async (monaco) => {
      if (disposed || root.current === null) return
      const uri = monaco.Uri.parse(`file:///${props.uri.replace(/^\/+/, '')}`)
      const uriText = uri.toString()
      model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(props.value, undefined, uri)
      if (!ownedModels.has(uriText)) ownedModels.add(uriText)
      touchModel(uriText)
      // 切文件/新建模型之后回收一次：保留当前模型 + Workbench 传来的打开/脏标签（见 pruneModels 注释），
      // 其余按 LRU 只留 MODEL_CACHE_LIMIT 个。放在挂载路径里，不在每次 keystroke 上跑。
      // keepModelPaths 缺席（工作区还没解析出来）时跳过判定，避免把打开中的标签误回收。
      if (keepPathsRef.current !== undefined) evictModels(monaco, uriText, keepPathsRef.current, dirtyPathsRef.current ?? [])
      if (model.getValue() !== props.value) model.setValue(props.value)
      // 换成 TextMate 分词器，让高亮与 VS Code 同源；失败则继续用 Monaco 内置分词。
      // 带上模型规模：超过阈值的文件不注入（否则从头分词可达数百 ms），回退内置分词。
      await installTextMate(monaco, [model.getLanguageId()], textMateSize(model)).catch((failure) => {
        console.warn('[dvw] TextMate 分词器装载失败，该文件回退 Monaco 内置分词：', failure)
      })
      if (disposed || root.current === null) return
      if (model.getValue() !== valueRef.current) model.setValue(valueRef.current)
      // 偏好取当前值而不是本次渲染的闭包值：这个 effect 不随偏好重跑（重跑会重建编辑器）。
      const editorPreferences = getPreferences()
      const instance = monaco.editor.create(root.current, {
        ...editorChrome(editorPreferences),
        ...editorOptions(editorPreferences),
        model,
        automaticLayout: true,
        theme: dshMonacoTheme(monaco, props.theme),
        // 关掉 Monaco 内置的英文右键菜单，改用工作台统一的中文 ContextMenu（原因见 editorMenus.ts）。
        contextmenu: false,
      })
      // tabSize / insertSpaces 是模型级选项：创建参数里的值不保证落到已有模型上，显式写一次。
      model.updateOptions(editorModelOptions(editorPreferences))
      editor.current = instance
      const change = instance.onDidChangeModelContent(() => callbacks.current.onChange(instance.getValue()))
      // 保存键位来自设置页可改的键位表。用 DOM 捕获阶段监听而不是 addCommand：addCommand 的键位在
      // 注册时就固定了，改键之后旧键仍然有效；这里每次按键实时读，改完立刻生效。
      const dom = instance.getDomNode()
      const saveKeydown = (event: KeyboardEvent) => {
        const binding = bindingOf('editor.save')
        if (binding === null || !bindingMatches(event, binding)) return
        event.preventDefault()
        event.stopPropagation()
        callbacks.current.onSave()
      }
      dom?.addEventListener('keydown', saveKeydown, true)
      // contextmenu:false 之后 Monaco 不再 preventDefault，浏览器原生菜单会冒出来，这里自己拦住；
      // overlay widget（查找框等）保留原生菜单，否则里面的输入框没有复制粘贴。
      instance.onContextMenu((event: MonacoMouseEvent) => {
        if (event.target.type === monaco.editor.MouseTargetType.OVERLAY_WIDGET) return
        event.event.preventDefault()
        event.event.stopPropagation()
        if (!disposed) setMenu({ x: event.event.browserEvent.clientX, y: event.event.browserEvent.clientY, keyboard: false })
      })
      // 键盘入口：contextmenu:false 同时让 Monaco 不再处理 Shift+F10 / ContextMenu 键，所以自己注册。
      // addCommand 的动态键位优先级高于内置的 editor.action.showContextMenu（后者现在不弹菜单）；
      // 动态键位是全局的（不随编辑器销毁），用 disposed + 焦点判断保证只有当前编辑器响应。
      const openMenuAtCursor = () => {
        if (disposed || !instance.hasTextFocus()) return
        setMenu({ ...cursorMenuPosition(instance), keyboard: true })
      }
      instance.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F10, openMenuAtCursor)
      instance.addCommand(monaco.KeyCode.ContextMenu, openMenuAtCursor)
      if (props.line !== undefined) { instance.setPosition({ lineNumber: props.line, column: props.column ?? 1 }); instance.revealLineInCenter(props.line); instance.focus() }
      // 行内补全跟着编辑器实例走：没有 sessionId（比如预览场景）就不接。
      const detachCompletion = props.sessionId === undefined ? undefined : attachInlineCompletion(monaco, instance, { sessionId: props.sessionId })
      return () => { detachCompletion?.(); change.dispose(); dom?.removeEventListener('keydown', saveKeydown, true) }
    }).catch(error => setError(error instanceof Error ? error.message : String(error)))
    return () => { disposed = true; editor.current?.dispose(); editor.current = undefined }
  }, [props.uri])
  useEffect(() => {
    const model = editor.current?.getModel(); if (model !== null && model !== undefined && model.getValue() !== props.value) model.setValue(props.value)
  }, [props.value])
  useEffect(() => { if (window.monaco !== undefined) window.monaco.editor.setTheme(dshMonacoTheme(window.monaco, props.theme)) }, [props.theme])
  // 搜索结果/大纲跳转：文件已经打开时再跳到另一行，编辑器实例不会重建（创建 effect 的依赖是 props.uri），
  // 所以定位必须在 props.line / column 变化时单独做一次 —— 否则点第二条命中没有任何反应。
  useEffect(() => {
    const instance = editor.current
    const model = instance?.getModel()
    if (instance === undefined || model === null || model === undefined || props.line === undefined) return
    const lineNumber = Math.min(Math.max(1, props.line), model.getLineCount())
    const column = Math.min(Math.max(1, props.column ?? 1), model.getLineMaxColumn(lineNumber))
    instance.setPosition({ lineNumber, column })
    instance.revealLineInCenter(lineNumber)
  }, [props.line, props.column])
  // 偏好变了就地同步，改设置不影响编辑器里已有的滚动位置与选择。
  // 外框（概览标尺开关）与编辑器选项都重算；创建与更新共用同一套映射，两条路径不会漂。
  // tabSize/insertSpaces 是模型级选项，走 model.updateOptions。
  useEffect(() => {
    const instance = editor.current
    if (instance === undefined) return
    instance.updateOptions({ ...editorChrome(preferences), ...editorOptions(preferences) })
    instance.getModel()?.updateOptions(editorModelOptions(preferences))
  }, [preferences])
  const entries = menu === undefined || editor.current === undefined
    ? undefined
    : buildEditorMenuEntries(editor.current, () => callbacks.current.onSave())
  // 键盘打开的菜单关闭后把焦点还给编辑器；鼠标打开的不要抢 —— 用户可能是点在别处关闭的。
  const closeMenu = () => {
    setMenu(undefined)
    if (menu?.keyboard === true) editor.current?.focus()
  }
  return error === undefined
    ? <>
        <div ref={root} style={{ position: 'absolute', inset: 0 }} />
        {menu !== undefined && entries !== undefined && <ContextMenu position={{ x: menu.x, y: menu.y }} label="编辑器操作" entries={entries} onClose={closeMenu}/>}
      </>
    : <div className="dvw-error">{error}</div>
}
