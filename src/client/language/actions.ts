/**
 * 语言服务的「动作层」：跳转、引用、重命名、符号、快速修复、问题导航。
 *
 * 为什么不用 Monaco 自带的 peek/命令：跨文件跳转要经过工作台的标签系统（可能是只读的外部文件），
 * 独立版 Monaco 的 peek 打不开不在当前模型表里的文件；而 Ctrl+点击与 F12 又必须压过 Monaco 的
 * 内置命令（否则会弹出「找不到定义」）。这里统一在 window 捕获阶段处理按键与鼠标手势，
 * 结果用工作台自己的 QuickPick 显示、用标签系统打开。
 *
 * 编辑器实例通过 registerLanguageEditor 登记；键盘动作只认当前聚焦的那个，鼠标手势按事件目标
 * 找到所在编辑器 —— 多标签同时挂载时不会张冠李戴。
 */
import type { editor, IPosition } from 'monaco-editor'
import { bindingMatches, bindingOf, type CommandId } from '../keybindings.ts'
import { activeLanguageWorkspace, type LanguageWorkspace } from './client.ts'
import { diagnosticsStoreFor } from './diagnostics.ts'
import { languagePosition, monacoPosition } from './models.ts'
import { baseName, samePath, workspaceRelativeOf } from './paths.ts'
import { notifyLanguage, openLanguagePicker, openLocationAt, toggleProblemsPanel, type LanguagePickerItem } from './picker.ts'
import type { LanguageDiagnostic, LanguageDocumentSymbol, LanguageLocation } from '../../language/protocol.ts'

type MonacoEditor = editor.IStandaloneCodeEditor

interface RegisteredEditor { editor: MonacoEditor; path: string }
const editors = new Set<RegisteredEditor>()
let active: RegisteredEditor | undefined

/** 编辑器挂载时登记；返回注销函数。 */
export function registerLanguageEditor(editorInstance: MonacoEditor, path: string): () => void {
  const entry: RegisteredEditor = { editor: editorInstance, path }
  editors.add(entry)
  if (editorInstance.hasTextFocus()) active = entry
  const focus = editorInstance.onDidFocusEditorText(() => { active = entry })
  const blur = editorInstance.onDidBlurEditorText(() => { if (active === entry) active = undefined })
  return () => {
    focus.dispose(); blur.dispose(); editors.delete(entry)
    if (active === entry) active = undefined
  }
}

/** 当前聚焦/最近聚焦的编辑器。 */
export function activeLanguageEditor(): { editor: MonacoEditor; path: string } | undefined {
  if (active !== undefined && editors.has(active)) return active
  for (const entry of editors) if (entry.editor.hasTextFocus()) return entry
  return undefined
}

function positionOf(editorInstance: MonacoEditor): IPosition {
  return editorInstance.getPosition() ?? { lineNumber: 1, column: 1 }
}

function labelOf(location: LanguageLocation, workspace: LanguageWorkspace): LanguagePickerItem {
  const relative = workspaceRelativeOf(workspace.cwd, location.path)
  return {
    id: `${location.path}\0${location.range.start.line}\0${location.range.start.character}`,
    label: `${baseName(location.path)}:${location.range.start.line + 1}:${location.range.start.character + 1}`,
    detail: relative ?? location.path,
  }
}

function locationOf(item: LanguagePickerItem): LanguageLocation {
  const [path = '', line = '0', character = '0'] = item.id.split('\0')
  return { path, range: { start: { line: Number(line), character: Number(character) }, end: { line: Number(line), character: Number(character) } } }
}

/** 跳到目标：同文件就地移动，跨文件交给 Workbench 开标签（可能打开只读外部文件）。 */
function openLocation(workspace: LanguageWorkspace, location: LanguageLocation, current?: { editor: MonacoEditor; path: string }): void {
  if (current !== undefined && samePath(current.path, location.path)) {
    current.editor.setPosition(monacoPosition(location.range.start))
    current.editor.revealPositionInCenter(monacoPosition(location.range.start), 0)
    current.editor.focus()
    return
  }
  openLocationAt(location.path, location.range.start.line, location.range.start.character)
}

/** 去重（外部服务器可能把同一目标报两次）并按路径/位置排序。 */
function uniqueLocations(locations: readonly LanguageLocation[]): LanguageLocation[] {
  const seen = new Set<string>()
  const result: LanguageLocation[] = []
  for (const location of locations) {
    const key = `${location.path}\0${location.range.start.line}:${location.range.start.character}:${location.range.end.line}:${location.range.end.character}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(location)
  }
  return result.sort((left, right) => left.path.localeCompare(right.path)
    || left.range.start.line - right.range.start.line
    || left.range.start.character - right.range.start.character)
}

/** 转到定义；没有结果时给一句提示而不是静默。 */
export async function gotoDefinition(editorInstance?: MonacoEditor): Promise<void> {
  const workspace = activeLanguageWorkspace()
  const entry = editorInstance === undefined ? activeLanguageEditor() : editorsFor(editorInstance)
  if (workspace === undefined || entry === undefined) return
  const position = languagePosition(positionOf(entry.editor))
  const locations = uniqueLocations(await workspace.definition(entry.path, position))
  if (locations.length === 0) { notifyLanguage('未找到定义', 'info'); return }
  if (locations.length === 1) { openLocation(workspace, locations[0]!, entry); return }
  openLanguagePicker({
    title: '选择定义',
    placeholder: '过滤定义位置',
    items: locations.map(location => labelOf(location, workspace)),
    onPick(id) {
      const location = locations.find(item => labelOf(item, workspace).id === id)
      if (location !== undefined) openLocation(workspace, location, entry)
    },
  })
}

function editorsFor(editorInstance: MonacoEditor): RegisteredEditor | undefined {
  for (const entry of editors) if (entry.editor === editorInstance) return entry
  return { editor: editorInstance, path: active?.path ?? '' }
}

/** 查找所有引用：按文件分组展示，选中即跳过去。 */
export async function findReferences(editorInstance?: MonacoEditor): Promise<void> {
  const workspace = activeLanguageWorkspace()
  if (workspace === undefined) return
  const entry = editorInstance === undefined ? activeLanguageEditor() : editorsFor(editorInstance)
  if (entry === undefined) return
  const position = languagePosition(positionOf(entry.editor))
  const locations = uniqueLocations(await workspace.references(entry.path, position))
  if (locations.length === 0) { notifyLanguage('没有找到引用', 'info'); return }
  openLanguagePicker({
    title: `引用（${locations.length} 处）`,
    placeholder: '过滤文件或位置',
    items: locations.map(location => labelOf(location, workspace)),
    onPick(id) {
      const location = locations.find(item => labelOf(item, workspace).id === id)
      if (location !== undefined) openLocation(workspace, location, entry)
    },
  })
}

/** 重命名：输入新名字 → 宿主给出跨文件编辑 → 编辑器里改模型、其余文件写盘。 */
export async function renameSymbol(editorInstance?: MonacoEditor): Promise<void> {
  const workspace = activeLanguageWorkspace()
  if (workspace === undefined) return
  const entry = editorInstance === undefined ? activeLanguageEditor() : editorsFor(editorInstance)
  if (entry === undefined) return
  const position = positionOf(entry.editor)
  openLanguagePicker({
    title: '重命名符号',
    placeholder: '输入新名称后回车',
    items: [],
    allowEmpty: false,
    submitLabel: value => `重命名为「${value}」`,
    async onSubmit(newName) {
      const result = await workspace.rename(entry.path, languagePosition(position), newName)
      if (!result.canRename || result.edit === undefined) {
        notifyLanguage(result.message ?? '当前符号不能重命名', 'warn')
        return
      }
      const edited = await workspace.applyEdit(result.edit)
      const count = result.edit.changes.reduce((total, change) => total + change.edits.length, 0)
      notifyLanguage(`已重命名 ${count} 处${edited.written.length > 0 ? `（${edited.written.length} 个文件已保存）` : ''}`, 'info')
    },
  })
}

/** 文件中的符号（Ctrl+Shift+O）：拍平层级后用缩进表达嵌套。 */
export async function documentSymbols(editorInstance?: MonacoEditor): Promise<void> {
  const workspace = activeLanguageWorkspace()
  if (workspace === undefined) return
  const entry = editorInstance === undefined ? activeLanguageEditor() : editorsFor(editorInstance)
  if (entry === undefined) return
  const symbols = await workspace.documentSymbols(entry.path)
  if (symbols.length === 0) { notifyLanguage('当前文件没有可用的符号', 'info'); return }
  const items: { item: LanguagePickerItem; location: LanguageLocation }[] = []
  const flatten = (rows: readonly LanguageDocumentSymbol[], depth: number): void => {
    for (const symbol of rows) {
      items.push({
        item: {
          id: `${items.length}`,
          label: `${'  '.repeat(depth)}${symbol.name}`,
          ...(symbol.detail === undefined ? {} : { detail: symbol.detail }),
        },
        location: { path: entry.path, range: symbol.selectionRange },
      })
      if (symbol.children !== undefined) flatten(symbol.children, depth + 1)
    }
  }
  flatten(symbols, 0)
  openLanguagePicker({
    title: '文件中的符号',
    placeholder: '输入以过滤符号',
    items: items.map(entryItem => entryItem.item),
    onPick(id) {
      const found = items[Number(id)]
      if (found !== undefined) openLocation(workspace, found.location, entry)
    },
  })
}

/** 工作区符号（Ctrl+T）：输入即搜索，结果来自内置 TS 服务与已启动的外部服务器。 */
export function workspaceSymbols(): void {
  const workspace = activeLanguageWorkspace()
  if (workspace === undefined) return
  openLanguagePicker({
    title: '工作区符号',
    placeholder: '输入要查找的符号名',
    items: [],
    search(query, update) {
      if (query.trim() === '') { update([]); return }
      void workspace.workspaceSymbols(query).then(symbols => update(symbols.map(symbol => ({
        id: `${symbol.path}\0${symbol.range.start.line}\0${symbol.range.start.character}`,
        label: symbol.name,
        detail: `${symbol.containerName === undefined ? '' : `${symbol.containerName} · `}${workspaceRelativeOf(workspace.cwd, symbol.path) ?? symbol.path}`,
      }))))
    },
    onPick(id) {
      const [path = '', line = '0', character = '0'] = id.split('\0')
      openLocationAt(path, Number(line), Number(character))
    },
  })
}

/** 快速修复（Ctrl+.）：取光标/选区内的诊断，列出可应用的修复。 */
export async function quickFix(editorInstance?: MonacoEditor): Promise<void> {
  const workspace = activeLanguageWorkspace()
  if (workspace === undefined) return
  const entry = editorInstance === undefined ? activeLanguageEditor() : editorsFor(editorInstance)
  if (entry === undefined) return
  const selection = entry.editor.getSelection()
  const position = positionOf(entry.editor)
  const range = selection === null
    ? { start: languagePosition(position), end: languagePosition(position) }
    : { start: languagePosition({ lineNumber: selection.startLineNumber, column: selection.startColumn }), end: languagePosition({ lineNumber: selection.endLineNumber, column: selection.endColumn }) }
  const actions = await workspace.codeActions(entry.path, range)
  if (actions.length === 0) { notifyLanguage('这里没有可用的代码操作', 'info'); return }
  openLanguagePicker({
    title: '代码操作',
    items: actions.map((action, index) => ({
      id: String(index),
      label: action.title,
      ...(action.kind === undefined ? {} : { detail: action.kind }),
      ...(action.isPreferred === true ? { current: true } : {}),
    })),
    onPick(id) {
      const action = actions[Number(id)]
      if (action?.edit !== undefined) void workspace.applyEdit(action.edit)
    },
  })
}

/** 打平问题列表：问题导航（F8 / Shift+F8）与面板共用同一种排序。 */
export interface ProblemEntry { path: string; diagnostic: LanguageDiagnostic }

export function problemEntries(cwd: string | undefined): ProblemEntry[] {
  if (cwd === undefined) return []
  const snapshot = diagnosticsStoreFor(cwd).getSnapshot()
  const entries: ProblemEntry[] = []
  for (const file of snapshot.files) {
    for (const diagnostic of [...file.diagnostics].sort((left, right) =>
      left.range.start.line - right.range.start.line || left.range.start.character - right.range.start.character)) {
      entries.push({ path: file.path, diagnostic })
    }
  }
  return entries
}

let problemCursor = 0

/** F8 风格的问题跳转：优先从光标位置往后找，找不到就绕回开头。 */
export function stepProblem(cwd: string | undefined, direction: 1 | -1): void {
  const entries = problemEntries(cwd)
  if (entries.length === 0) { notifyLanguage('没有问题', 'info'); return }
  const workspace = activeLanguageWorkspace()
  const entry = activeLanguageEditor()
  let index = -1
  if (entry !== undefined) {
    const position = languagePosition(positionOf(entry.editor))
    index = entries.findIndex(problem => problem.path === entry.path
      && compareToCursor(problem.diagnostic, position, direction) > 0)
    if (index < 0) {
      // 同一文件没有了：按文件顺序找下一个/上一个文件。
      const currentIndex = entries.findIndex(problem => problem.path === entry.path)
      const sameFile = entries.filter(problem => problem.path === entry.path).length
      if (currentIndex >= 0) index = direction === 1
        ? (currentIndex + sameFile - 1 + 1) % entries.length
        : (currentIndex - 1 + entries.length) % entries.length
    }
  } else {
    problemCursor = (problemCursor + direction + entries.length) % entries.length
    index = problemCursor
    if (index < 0) index = 0
  }
  if (index < 0) index = 0
  const target = entries[index]
  if (target === undefined) return
  problemCursor = index
  openLocationAt(target.path, target.diagnostic.range.start.line, target.diagnostic.range.start.character)
}

function compareToCursor(diagnostic: LanguageDiagnostic, position: { line: number; character: number }, direction: 1 | -1): number {
  const lineDelta = diagnostic.range.start.line - position.line
  if (lineDelta !== 0) return direction === 1 ? lineDelta : -lineDelta
  const characterDelta = diagnostic.range.start.character - position.character
  return direction === 1 ? characterDelta : -characterDelta
}

/* ────────────────────────────── 全局手势 ────────────────────────────── */

interface KeyAction { id: CommandId; needsEditor: boolean; run(): void }

const KEY_ACTIONS: readonly KeyAction[] = [
  { id: 'language.definition', needsEditor: true, run: () => { void gotoDefinition() } },
  { id: 'language.references', needsEditor: true, run: () => { void findReferences() } },
  { id: 'language.rename', needsEditor: true, run: () => { void renameSymbol() } },
  { id: 'language.documentSymbols', needsEditor: true, run: () => { void documentSymbols() } },
  // 工作区符号不依赖当前文件（VS Code 里在侧栏聚焦时也能用），所以不要求编辑器焦点。
  { id: 'language.workspaceSymbols', needsEditor: false, run: () => workspaceSymbols() },
  { id: 'language.quickFix', needsEditor: true, run: () => { void quickFix() } },
  { id: 'view.problems', needsEditor: false, run: () => toggleProblemsPanel() },
  { id: 'problems.next', needsEditor: false, run: () => stepProblem(activeLanguageWorkspace()?.cwd, 1) },
  { id: 'problems.previous', needsEditor: false, run: () => stepProblem(activeLanguageWorkspace()?.cwd, -1) },
]

/** Ctrl+点击：在捕获阶段吃掉 Monaco 的内置「转到定义」，换成工作台的跨文件跳转。 */
function onMouseDown(event: MouseEvent): void {
  if (event.button !== 0 || event.altKey || event.shiftKey) return
  if (!event.ctrlKey && !event.metaKey) return
  const workspace = activeLanguageWorkspace()
  if (workspace === undefined) return
  const target = event.target
  if (!(target instanceof Node)) return
  for (const entry of editors) {
    const container = entry.editor.getContainerDomNode()
    if (!container.contains(target)) continue
    const hit = entry.editor.getTargetAtClientPoint(event.clientX, event.clientY)
    const position = hit?.position
    if (position === null || position === undefined) return
    event.preventDefault()
    event.stopPropagation()
    void gotoDefinitionAt(entry, position)
    return
  }
}

async function gotoDefinitionAt(entry: RegisteredEditor, position: IPosition): Promise<void> {
  const workspace = activeLanguageWorkspace()
  if (workspace === undefined) return
  const locations = uniqueLocations(await workspace.definition(entry.path, languagePosition(position)))
  if (locations.length === 0) { notifyLanguage('未找到定义', 'info'); return }
  if (locations.length === 1) { openLocation(workspace, locations[0]!, entry); return }
  openLanguagePicker({
    title: '选择定义',
    items: locations.map(location => labelOf(location, workspace)),
    onPick(id) {
      const location = locations.find(item => labelOf(item, workspace).id === id)
      if (location !== undefined) openLocation(workspace, location, entry)
    },
  })
}

/** 忽略焦点在输入框/终端里的按键：那不是编辑器动作。 */
function typingInField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.isComposing || event.metaKey) return
  if (activeLanguageWorkspace() === undefined) return
  if (typingInField(event.target)) return
  for (const action of KEY_ACTIONS) {
    const binding = bindingOf(action.id)
    if (binding === null || !bindingMatches(event, binding)) continue
    if (action.needsEditor && activeLanguageEditor() === undefined) return
    event.preventDefault()
    event.stopPropagation()
    action.run()
    return
  }
}

let installedDispose: (() => void) | undefined

/** 安装全局按键/鼠标手势（幂等，返回卸载函数）。 */
export function installLanguageActions(): () => void {
  if (installedDispose !== undefined) return installedDispose
  const dispose = (): void => {
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('mousedown', onMouseDown, true)
    installedDispose = undefined
  }
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('mousedown', onMouseDown, true)
  installedDispose = dispose
  return dispose
}

/** 测试用：清空已登记的编辑器。 */
export function resetLanguageEditorsForTests(): void {
  editors.clear()
  active = undefined
  problemCursor = 0
}

// 供 Workbench 从问题面板的点击里构造位置（保持 picker 模块是唯一的跳转出口）。
export { openLocationAt }
