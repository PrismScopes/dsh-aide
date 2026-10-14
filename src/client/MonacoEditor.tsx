import { useEffect, useRef, useState } from 'react'
import darkPlus from '@shikijs/themes/dark-plus'
import lightPlus from '@shikijs/themes/light-plus'
import { installTextMate } from './textmateHighlight.ts'
import { attachInlineCompletion } from './inlineCompletion.ts'

type Monaco = typeof import('monaco-editor')
declare global { interface Window { require?: { (ids: string[], done: () => void): void; config(value: unknown): void }; monaco?: Monaco } }
let loading: Promise<Monaco> | undefined
/** Monaco chrome used by both editors so only the narrow native scrollbar remains. */
export const WORKBENCH_EDITOR_CHROME = {
  minimap: { enabled: false },
  renderOverviewRuler: false,
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
} as const

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
  const color = (token: string, fallback: string): string => monacoColor(tokenOf(token, fallback), fallback)
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
        'scrollbarSlider.background': color('--dsw-alias-scrollbar-bg-l1', dark ? '#3c3c3d' : '#e5e5e5'),
        'scrollbarSlider.hoverBackground': color('--dsw-alias-scrollbar-bg-l2', dark ? '#545557' : '#e5e5e5')
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

export function loadMonaco(): Promise<Monaco> {
  loading ??= new Promise((resolve, reject) => {
    const start = () => {
      const loader = window.require
      if (loader === undefined) return reject(new Error('Monaco AMD loader unavailable'))
      installWorkerEnvironment()
      loader.config({ paths: { vs: '/dsh-vscode/monaco/vs' } })
      loader(['vs/editor/editor.main'], () => window.monaco === undefined ? reject(new Error('Monaco failed to initialize')) : resolve(window.monaco))
    }
    if (window.require !== undefined) { start(); return }
    const script = document.createElement('script'); script.src = '/dsh-vscode/monaco/vs/loader.js'; script.onload = start; script.onerror = () => reject(new Error('failed to load Monaco')); document.head.append(script)
  })
  return loading
}

export function MonacoDiffEditor(props: { uri: string; original: string; modified: string; mode: 'inline' | 'split'; theme: 'dark' | 'light' }) {
  const root=useRef<HTMLDivElement>(null);const editor=useRef<import('monaco-editor').editor.IStandaloneDiffEditor>();const models=useRef<{original:import('monaco-editor').editor.ITextModel;modified:import('monaco-editor').editor.ITextModel}>();const [error,setError]=useState<string>()
  useEffect(()=>{let disposed=false;void loadMonaco().then(async monaco=>{if(disposed||root.current===null)return;const safe=props.uri.replace(/^\/+/, '');const original=monaco.editor.createModel(props.original,undefined,monaco.Uri.parse(`dvw-diff-original:///${safe}`));const modified=monaco.editor.createModel(props.modified,undefined,monaco.Uri.parse(`dvw-diff-modified:///${safe}`));models.current={original,modified};await installTextMate(monaco,[original.getLanguageId()]).catch(()=>undefined);if(disposed||root.current===null)return;const instance=monaco.editor.createDiffEditor(root.current,{automaticLayout:true,readOnly:true,renderSideBySide:props.mode==='split',theme:dshMonacoTheme(monaco,props.theme),fontSize:14,...WORKBENCH_EDITOR_CHROME,originalEditable:false,ignoreTrimWhitespace:false});instance.setModel({original,modified});editor.current=instance}).catch(error=>setError(error instanceof Error?error.message:String(error)));return()=>{disposed=true;editor.current?.dispose();editor.current=undefined;models.current?.original.dispose();models.current?.modified.dispose();models.current=undefined}},[props.uri])
  useEffect(()=>{const value=models.current;if(value===undefined)return;if(value.original.getValue()!==props.original)value.original.setValue(props.original);if(value.modified.getValue()!==props.modified)value.modified.setValue(props.modified)},[props.original,props.modified])
  useEffect(()=>{editor.current?.updateOptions({renderSideBySide:props.mode==='split'})},[props.mode])
  useEffect(()=>{if(window.monaco!==undefined)window.monaco.editor.setTheme(dshMonacoTheme(window.monaco,props.theme))},[props.theme])
  return error===undefined?<div className="dvw-diff dvw-monaco-diff" data-mode={props.mode} data-render-side-by-side={props.mode==='split'} ref={root}/>:<div className="dvw-error">{error}</div>
}

export function MonacoEditor(props: { uri: string; value: string; theme: 'dark' | 'light'; line?: number; column?: number; sessionId?: string; onChange(value: string): void; onSave(): void }) {
  const root = useRef<HTMLDivElement>(null)
  const editor = useRef<import('monaco-editor').editor.IStandaloneCodeEditor>()
  const callbacks = useRef({ onChange: props.onChange, onSave: props.onSave })
  callbacks.current = { onChange: props.onChange, onSave: props.onSave }
  // 挂载 effect 只依赖 uri，闭包里的 props.value 是挂载那一刻的值；内容往往之后才到，
  // 因此这里另存一份最新值，在模型建立后用它写入。
  const valueRef = useRef(props.value)
  valueRef.current = props.value
  const [error, setError] = useState<string>()
  useEffect(() => {
    let disposed = false; let model: import('monaco-editor').editor.ITextModel | undefined
    void loadMonaco().then(async (monaco) => {
      if (disposed || root.current === null) return
      const uri = monaco.Uri.parse(`file:///${props.uri.replace(/^\/+/, '')}`)
      model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(props.value, undefined, uri)
      if (model.getValue() !== props.value) model.setValue(props.value)
      // 换成 TextMate 分词器，让高亮与 VS Code 同源；失败则继续用 Monaco 内置分词。
      await installTextMate(monaco, [model.getLanguageId()]).catch((failure) => {
        console.warn('[dvw] TextMate 分词器装载失败，该文件回退 Monaco 内置分词：', failure)
      })
      if (disposed || root.current === null) return
      if (model.getValue() !== valueRef.current) model.setValue(valueRef.current)
      const instance = monaco.editor.create(root.current, { model, automaticLayout: true, theme: dshMonacoTheme(monaco, props.theme), fontSize: 14, ...WORKBENCH_EDITOR_CHROME, wordWrap: 'off' })
      editor.current = instance
      const change = instance.onDidChangeModelContent(() => callbacks.current.onChange(instance.getValue()))
      instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacks.current.onSave())
      if (props.line !== undefined) { instance.setPosition({ lineNumber: props.line, column: props.column ?? 1 }); instance.revealLineInCenter(props.line); instance.focus() }
      // 行内补全跟着编辑器实例走：没有 sessionId（比如预览场景）就不接。
      const detachCompletion = props.sessionId === undefined ? undefined : attachInlineCompletion(monaco, instance, { sessionId: props.sessionId })
      return () => { detachCompletion?.(); change.dispose() }
    }).catch(error => setError(error instanceof Error ? error.message : String(error)))
    return () => { disposed = true; editor.current?.dispose(); editor.current = undefined }
  }, [props.uri])
  useEffect(() => {
    const model = editor.current?.getModel(); if (model !== null && model !== undefined && model.getValue() !== props.value) model.setValue(props.value)
  }, [props.value])
  useEffect(() => { if (window.monaco !== undefined) window.monaco.editor.setTheme(dshMonacoTheme(window.monaco, props.theme)) }, [props.theme])
  return error === undefined ? <div ref={root} style={{ position: 'absolute', inset: 0 }} /> : <div className="dvw-error">{error}</div>
}
