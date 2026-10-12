import { useEffect, useRef, useState } from 'react'

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
 * 注册跟随 DSH 主题的 Monaco 主题并返回主题名。
 * Monaco 内置的 vs / vs-dark 用的是固定底色（#fffffe / #1e1e1e），与 DSH 的
 * --dsw-alias-bg-layer-1 不一致，暗色下编辑区会比周边暗一档；这里把底色、
 * 行号、选区、光标、控件与滚动条统一接到 DSH 令牌上。
 */
export function dshMonacoTheme(monaco: Monaco, theme: 'dark' | 'light'): string {
  const dark = theme === 'dark'
  const name = dark ? 'dsh-dark' : 'dsh-light'
  monaco.editor.defineTheme(name, {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': tokenOf('--dsw-alias-bg-layer-1', dark ? '#232324' : '#ffffff'),
      'editor.foreground': tokenOf('--dsw-alias-label-primary', dark ? '#f9fafb' : '#0f1115'),
      'editorGutter.background': tokenOf('--dsw-alias-bg-layer-1', dark ? '#232324' : '#ffffff'),
      'editorLineNumber.foreground': tokenOf('--dsw-alias-label-tertiary', dark ? '#adb2b8' : '#81858c'),
      'editorLineNumber.activeForeground': tokenOf('--dsw-alias-label-primary', dark ? '#f9fafb' : '#0f1115'),
      'editor.lineHighlightBackground': tokenOf('--dsw-alias-interactive-bg-hover', dark ? '#ffffff14' : '#2631480f'),
      'editor.selectionBackground': tokenOf('--dsw-alias-interactive-bg-active', dark ? '#ffffff24' : '#2631481a'),
      'editorCursor.foreground': tokenOf('--dsw-alias-label-primary', dark ? '#f9fafb' : '#0f1115'),
      'editorWidget.background': tokenOf('--dsw-alias-bg-layer-2', dark ? '#2c2c2e' : '#ffffff'),
      'editorWidget.border': tokenOf('--dsw-alias-border-l2', dark ? '#ffffff1f' : '#0000001a'),
      'scrollbarSlider.background': tokenOf('--dsw-alias-scrollbar-bg-l1', dark ? '#3c3c3d' : '#e5e5e5'),
      'scrollbarSlider.hoverBackground': tokenOf('--dsw-alias-scrollbar-bg-l2', dark ? '#545557' : '#e5e5e5')
    }
  })
  return name
}

export function loadMonaco(): Promise<Monaco> {
  loading ??= new Promise((resolve, reject) => {
    const start = () => {
      const loader = window.require
      if (loader === undefined) return reject(new Error('Monaco AMD loader unavailable'))
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
  useEffect(()=>{let disposed=false;void loadMonaco().then(monaco=>{if(disposed||root.current===null)return;const safe=props.uri.replace(/^\/+/, '');const original=monaco.editor.createModel(props.original,undefined,monaco.Uri.parse(`dvw-diff-original:///${safe}`));const modified=monaco.editor.createModel(props.modified,undefined,monaco.Uri.parse(`dvw-diff-modified:///${safe}`));models.current={original,modified};const instance=monaco.editor.createDiffEditor(root.current,{automaticLayout:true,readOnly:true,renderSideBySide:props.mode==='split',theme:dshMonacoTheme(monaco,props.theme),fontSize:14,...WORKBENCH_EDITOR_CHROME,originalEditable:false,ignoreTrimWhitespace:false});instance.setModel({original,modified});editor.current=instance}).catch(error=>setError(error instanceof Error?error.message:String(error)));return()=>{disposed=true;editor.current?.dispose();editor.current=undefined;models.current?.original.dispose();models.current?.modified.dispose();models.current=undefined}},[props.uri])
  useEffect(()=>{const value=models.current;if(value===undefined)return;if(value.original.getValue()!==props.original)value.original.setValue(props.original);if(value.modified.getValue()!==props.modified)value.modified.setValue(props.modified)},[props.original,props.modified])
  useEffect(()=>{editor.current?.updateOptions({renderSideBySide:props.mode==='split'})},[props.mode])
  useEffect(()=>{if(window.monaco!==undefined)window.monaco.editor.setTheme(dshMonacoTheme(window.monaco,props.theme))},[props.theme])
  return error===undefined?<div className="dvw-diff dvw-monaco-diff" data-mode={props.mode} data-render-side-by-side={props.mode==='split'} ref={root}/>:<div className="dvw-error">{error}</div>
}

export function MonacoEditor(props: { uri: string; value: string; theme: 'dark' | 'light'; line?: number; column?: number; onChange(value: string): void; onSave(): void }) {
  const root = useRef<HTMLDivElement>(null)
  const editor = useRef<import('monaco-editor').editor.IStandaloneCodeEditor>()
  const callbacks = useRef({ onChange: props.onChange, onSave: props.onSave })
  callbacks.current = { onChange: props.onChange, onSave: props.onSave }
  const [error, setError] = useState<string>()
  useEffect(() => {
    let disposed = false; let model: import('monaco-editor').editor.ITextModel | undefined
    void loadMonaco().then((monaco) => {
      if (disposed || root.current === null) return
      const uri = monaco.Uri.parse(`file:///${props.uri.replace(/^\/+/, '')}`)
      model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(props.value, undefined, uri)
      if (model.getValue() !== props.value) model.setValue(props.value)
      const instance = monaco.editor.create(root.current, { model, automaticLayout: true, theme: dshMonacoTheme(monaco, props.theme), fontSize: 14, ...WORKBENCH_EDITOR_CHROME, wordWrap: 'off' })
      editor.current = instance
      const change = instance.onDidChangeModelContent(() => callbacks.current.onChange(instance.getValue()))
      instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacks.current.onSave())
      if (props.line !== undefined) { instance.setPosition({ lineNumber: props.line, column: props.column ?? 1 }); instance.revealLineInCenter(props.line); instance.focus() }
      return () => { change.dispose() }
    }).catch(error => setError(error instanceof Error ? error.message : String(error)))
    return () => { disposed = true; editor.current?.dispose(); editor.current = undefined }
  }, [props.uri])
  useEffect(() => {
    const model = editor.current?.getModel(); if (model !== null && model !== undefined && model.getValue() !== props.value) model.setValue(props.value)
  }, [props.value])
  useEffect(() => { if (window.monaco !== undefined) window.monaco.editor.setTheme(dshMonacoTheme(window.monaco, props.theme)) }, [props.theme])
  return error === undefined ? <div ref={root} style={{ position: 'absolute', inset: 0 }} /> : <div className="dvw-error">{error}</div>
}
