/**
 * 把语言服务接到 Monaco 的语言特性上。
 *
 * 关键决定：**关掉 Monaco 自带的 TypeScript 语言特性**，只留分词、格式化、折叠与同类词高亮。
 * 原因有两个：
 *   1. 自带服务的 TS worker 运行在虚拟文件系统里，看不到工作区其它文件与 node_modules，跨文件
 *      定义/引用/悬停本来就不可靠；开着它只会和宿主服务给出两套不一致的结果。
 *   2. 同一份能力注册两个 provider 时，Monaco 会把悬停内容拼接、把引用列表重复，观感很差。
 * 用 `setModeConfiguration` 精确关掉这些能力（分词不受影响），再由下面注册的 provider 接管。
 *
 * 这里只接 **由 Monaco 自己弹 UI** 的能力（悬停、补全、签名帮助）。定义/引用/重命名/符号/快速修复
 * 由 actions.ts 用工作台自己的 QuickPick 与跳转逻辑实现 —— 跨文件跳转要靠标签系统，Monaco 的
 * 内置 peek 在独立版里打不开别的工作区文件。
 */
import type * as Monaco from 'monaco-editor'
import { getPreferences } from '../preferences.ts'
import { activeLanguageWorkspace } from './client.ts'
import { installMarkerHost } from './diagnostics.ts'
import { absolutePathForModel, languagePosition, monacoRange } from './models.ts'
import type { LanguageSymbolKind } from '../../language/protocol.ts'

/** 注册语言特性的语言集合。没有对应服务器的语言，provider 会在第一行返回空，不会产生请求。 */
const SUPPORTED_LANGUAGES = [
  'typescript', 'javascript', 'python', 'rust', 'go', 'c', 'cpp', 'yaml', 'shellscript',
  'lua', 'php', 'ruby', 'dockerfile', 'makefile', 'java', 'kotlin', 'csharp', 'swift', 'sql',
] as const

let installed = false

/** TypeScript/JavaScript 自带能力里要关掉的部分；未列出的保持默认（格式化、折叠、同类词高亮等）。 */
const BUILTIN_TS_MODES_OFF = {
  completionItems: false,
  hovers: false,
  documentSymbols: false,
  definitions: false,
  references: false,
  rename: false,
  diagnostics: false,
  signatureHelp: false,
  codeActions: false,
  // 这些保留：它们只影响本文件内的显示与编辑体验，没有跨文件语义。
  documentHighlights: true,
  documentRangeFormattingEdits: true,
  onTypeFormattingEdits: true,
  inlayHints: true,
} as const

/** 关掉 Monaco 自带 TS/JS 的「语言服务类」能力；分词与格式化不受影响。 */
export function disableBuiltinTypeScriptLanguageFeatures(monaco: typeof import('monaco-editor')): void {
  const typescript = monaco.languages.typescript
  if (typescript === undefined) return
  for (const defaults of [typescript.typescriptDefaults, typescript.javascriptDefaults]) {
    try {
      // setModeConfiguration 是整体替换而不是合并：少写一个字段等于把它关掉，所以这里列全。
      defaults.setModeConfiguration({ ...BUILTIN_TS_MODES_OFF })
    } catch (error) {
      console.warn('[dvw] 关闭 Monaco 内置 TS 语言特性失败（语言服务仍可用）：', error)
    }
  }
}

/** 悬停/补全这类请求要能被 Monaco 取消：取消时把 AbortSignal 传给 fetch，宿主也就能停。 */
function abortSignalOf(token: Monaco.CancellationToken): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const subscription = token.onCancellationRequested(() => controller.abort())
  return { signal: controller.signal, dispose: () => subscription.dispose() }
}

/** provider 的公共前置判断：有工作区、能解析路径、该语言受支持。 */
function contextOf(model: Monaco.editor.ITextModel): { workspace: NonNullable<ReturnType<typeof activeLanguageWorkspace>>; path: string } | undefined {
  const workspace = activeLanguageWorkspace()
  if (workspace === undefined) return undefined
  const path = absolutePathForModel(model)
  if (path === undefined) return undefined
  if (!workspace.supportsLanguage(model.getLanguageId())) return undefined
  return { workspace, path }
}

/** 符号种类 → Monaco 补全种类。用枚举名而不是数字，避免 Monaco 调整枚举值后悄悄错位。 */
export function completionKind(monaco: typeof import('monaco-editor'), kind: LanguageSymbolKind | undefined): Monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind
  switch (kind) {
    case 'method': return K.Method
    case 'function': return K.Function
    case 'constructor': return K.Constructor
    case 'field': return K.Field
    case 'variable': return K.Variable
    case 'class': return K.Class
    case 'struct': return K.Struct
    case 'interface': return K.Interface
    case 'module': case 'namespace': case 'package': return K.Module
    case 'property': return K.Property
    case 'event': return K.Event
    case 'operator': return K.Operator
    case 'constant': return K.Constant
    case 'enum': return K.Enum
    case 'enumMember': return K.EnumMember
    case 'file': return K.File
    case 'typeParameter': return K.TypeParameter
    case 'string': case 'number': case 'boolean': case 'array': case 'object': case 'null': case 'key': return K.Value
    default: return K.Text
  }
}

function hoverMarkdown(contents: string): Monaco.IMarkdownString[] {
  // 语言服务返回的已经是 markdown（代码块 + 文档注释）；isTrusted 关掉，避免把任意 HTML 注入页面。
  return [{ value: contents, isTrusted: false }]
}

/** 悬停：宿主语言服务（含跨文件类型信息）。 */
function registerHover(monaco: typeof import('monaco-editor')): void {
  const provider: Monaco.languages.HoverProvider = {
    async provideHover(model, position, token) {
      const context = contextOf(model)
      if (context === undefined || !getPreferences().languageHover) return null
      const controller = abortSignalOf(token)
      try {
        const hover = await context.workspace.hover(context.path, languagePosition(position), controller.signal)
        if (hover === null || hover.contents.trim() === '') return null
        return {
          contents: hoverMarkdown(hover.contents),
          ...(hover.range === undefined ? {} : { range: monacoRange(hover.range) }),
        }
      } finally { controller.dispose() }
    },
  }
  monaco.languages.registerHoverProvider([...SUPPORTED_LANGUAGES], provider)
}

/** 补全：宿主语言服务结果映射到 Monaco 列表；取消时中止请求。 */
function registerCompletion(monaco: typeof import('monaco-editor')): void {
  const provider: Monaco.languages.CompletionItemProvider = {
    triggerCharacters: ['.', '"', "'", '/', '@', ':', '<'],
    async provideCompletionItems(model, position, context, token) {
      const resolved = contextOf(model)
      if (resolved === undefined || !getPreferences().languageCompletion) return { suggestions: [] }
      const controller = abortSignalOf(token)
      try {
        const list = await resolved.workspace.completion(resolved.path, languagePosition(position), context.triggerCharacter, controller.signal)
        if (list === null) return { suggestions: [] }
        const word = model.getWordUntilPosition(position)
        const defaultRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
        const suggestions: Monaco.languages.CompletionItem[] = []
        for (const item of list.items) {
          // additionalEdits 按协议就是当前文件内的编辑（跨文件自动 import 不在补全里做）。
          const localEdits = item.additionalEdits
          suggestions.push({
            label: item.label,
            kind: completionKind(monaco, item.kind),
            insertText: item.insertText ?? item.label,
            ...(item.detail === undefined ? {} : { detail: item.detail }),
            ...(item.documentation === undefined ? {} : { documentation: item.documentation }),
            ...(item.sortText === undefined ? {} : { sortText: item.sortText }),
            ...(item.filterText === undefined ? {} : { filterText: item.filterText }),
            range: item.replaceRange === undefined ? defaultRange : monacoRange(item.replaceRange),
            ...(localEdits === undefined ? {} : { additionalTextEdits: localEdits.map(edit => ({ range: monacoRange(edit.range), text: edit.newText })) }),
          })
        }
        return { suggestions, incomplete: list.incomplete === true }
      } finally { controller.dispose() }
    },
  }
  monaco.languages.registerCompletionItemProvider([...SUPPORTED_LANGUAGES], provider)
}

/** 签名帮助：Monaco 负责 UI，宿主给签名与当前参数下标。 */
function registerSignatureHelp(monaco: typeof import('monaco-editor')): void {
  const provider: Monaco.languages.SignatureHelpProvider = {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [','],
    async provideSignatureHelp(model, position, token) {
      const resolved = contextOf(model)
      if (resolved === undefined || !getPreferences().languageCompletion) return null
      const controller = abortSignalOf(token)
      try {
        const help = await resolved.workspace.signatureHelp(resolved.path, languagePosition(position), controller.signal)
        if (help === null) return null
        // Monaco 的 SignatureHelp 把 activeSignature/activeParameter 定为必填数字（缺省用 0）。
        return {
          value: {
            signatures: help.signatures.map(signature => ({
              label: signature.label,
              ...(signature.documentation === undefined ? {} : { documentation: signature.documentation }),
              parameters: signature.parameters.map(parameter => ({
                label: parameter.label,
                ...(parameter.documentation === undefined ? {} : { documentation: parameter.documentation }),
              })),
              ...(signature.activeParameter === undefined ? {} : { activeParameter: signature.activeParameter }),
            })),
            activeSignature: help.activeSignature ?? 0,
            activeParameter: help.activeParameter ?? 0,
          },
          dispose() { /* 没有需要释放的资源 */ },
        }
      } finally { controller.dispose() }
    },
  }
  monaco.languages.registerSignatureHelpProvider([...SUPPORTED_LANGUAGES], provider)
}

/** 安装语言特性（幂等）；由工作台在 Monaco 加载完成后调用一次。 */
export function installLanguageMonaco(monaco: typeof import('monaco-editor')): void {
  if (installed) return
  installed = true
  installMarkerHost(monaco)
  disableBuiltinTypeScriptLanguageFeatures(monaco)
  registerHover(monaco)
  registerCompletion(monaco)
  registerSignatureHelp(monaco)
}

/** 测试用：允许在另一份假 monaco 上重新安装。 */
export function resetLanguageMonacoForTests(): void { installed = false }
