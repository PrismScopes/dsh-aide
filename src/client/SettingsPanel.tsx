import { useEffect, useRef, useState } from 'react'
import type { CompletionSettingsView, WorkbenchSettingsView } from './api.ts'
import { ApiError, readWorkbenchSettings, writeWorkbenchSettings } from './api.ts'
import { listDshModelRoutes } from './dshModels.ts'
import type { AutoSaveMode, CursorStyle, RenderWhitespace, WordWrapMode } from './preferences.ts'
import {
  EDITOR_LINE_HEIGHT_MIN,
  PREFERENCE_LIMITS,
  PREFERENCES_KEY,
  resetPreferences,
  updatePreferences,
  usePreferences,
} from './preferences.ts'

/**
 * 工作台的设置页。
 *
 * 注册进 DSH 设置导航（settings.section），渲染在设置面板的内容列里，所以必须贴合 DSH 的观感 ——
 * 颜色一律取 --dsw-alias-* 令牌，不写死色值，深浅色由 DSH 自己切换。
 *
 * 布局是**单列滚动 + 分组标题**（编辑器 / AI 补全 / 终端 / 快捷键 / 关于与诊断）。曾经做过一版
 * 页面内左侧分类子菜单 + 右侧面板，但那一栏在 DSH 设置的内容列里既挤又难看，而且 DSH 自己的设置页
 * 就是单列滚动、靠分组标题分段；字号也统一成 DSH 设置页的规格（行标题 14px/20px、说明 12px/18px、
 * 控件文字 14px），不再出现「输入框比标签大一号」的不一致。
 *
 * 落点分两类，别混淆：
 *   1. 界面偏好（localStorage，见 preferences.ts）—— 编辑器排版、补全开关与触发节奏、终端字号；
 *   2. 宿主设置（DSH 数据目录，读写 /dsh-vscode/settings）—— 补全模型路由与失败兜底。
 * 宿主不可用时第二类只读不可改，第一类照常可用 —— 界面偏好不能因为宿主端点缺失就一起废掉。
 *
 * 早前那五项布局设置（左右栏与状态栏显隐、两个栏宽）不再出现：它们在工作台里本来就有就地控件
 * （活动栏图标、标签栏按钮、拖拽分隔条），把可拖动的东西再抄一份成数字设置只会让同一个状态有两个入口。
 */

/** 版本号写常量：客户端不能直接 import package.json（tsconfig 没开 resolveJsonModule），
 *  这个值随发布更新，与 package.json 的版本保持一致。 */
const WORKBENCH_VERSION = '0.2.4'

/** 一行设置：左侧标题与说明，右侧控件。 */
function Row({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return <div className="dvw-set-row">
    <div className="dvw-set-text">
      <span className="dvw-set-title">{title}</span>
      {description !== undefined && <span className="dvw-set-desc">{description}</span>}
    </div>
    <div className="dvw-set-control">{children}</div>
  </div>
}

/** 开关。role="switch" 与 DSH 自己的写法一致。 */
function Switch({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange(value: boolean): void }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="dvw-set-switch" disabled={disabled} onClick={() => onChange(!checked)}>
    <span className="dvw-set-knob"/>
  </button>
}

/** DSH 步进器里用的箭头，路径照抄其 SVG。 */
function Arrow({ direction }: { direction: 'up' | 'down' }) {
  const path = direction === 'up'
    ? 'M12 10L8.70711 6.70711C8.31658 6.31658 7.68342 6.31658 7.29289 6.70711L4 10'
    : 'M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6'
  return <svg width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden="true" strokeWidth="1">
    <path d={path} stroke="currentColor"/>
  </svg>
}

/**
 * 数值调节。DSH 设置里的数值项用步进器（数值 + 上下箭头 + 单位）而不是滑块，
 * 这里保持一致；长按不连发，每次点击走一个 step。
 */
function Stepper({ value, min, max, step, unit, label, disabled, onChange }: {
  value: number
  min: number
  max: number
  step: number
  unit: string
  label: string
  disabled?: boolean
  onChange(value: number): void
}) {
  const clamp = (input: number) => Math.max(min, Math.min(max, input))
  return <>
    <div className="dvw-set-stepper" data-disabled={disabled}>
      <span className="dvw-set-value">{value}</span>
      <span className="dvw-set-arrows">
        <button type="button" className="dvw-set-arrow" aria-label={`增大${label}`} disabled={disabled === true || value >= max} onClick={() => onChange(clamp(value + step))}><Arrow direction="up"/></button>
        <button type="button" className="dvw-set-arrow" aria-label={`减小${label}`} disabled={disabled === true || value <= min} onClick={() => onChange(clamp(value - step))}><Arrow direction="down"/></button>
      </span>
    </div>
    <span className="dvw-set-unit">{unit}</span>
  </>
}

/** 下拉选择。枚举型设置（换行模式、光标样式、自动保存……）用它，
 *  这样每个选项都能被键盘与读屏直接念出中文名，而不是一串内部字面量。 */
function Choice<T extends string>({ label, value, options, disabled, onChange }: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  disabled?: boolean
  onChange(value: T): void
}) {
  return <select className="dvw-set-select" aria-label={label} value={value} disabled={disabled}
    onChange={event => onChange(event.target.value as T)}>
    {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>
}

/** 一行只读信息（当前生效、失败原因、文件位置）。 */
function Info({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'error' }) {
  return <div className="dvw-set-info" data-tone={tone}>
    <span className="dvw-set-info-label">{label}</span>
    <span className="dvw-set-info-value">{value}</span>
  </div>
}

/** 把宿主的错误翻成一句能照着做的话。 */
function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message
  return error instanceof Error ? error.message : String(error)
}

/** 补全这一步实际由谁执行 —— 与宿主 resolveProvider 的三种来源对应。 */
function effectiveLabel(completion: CompletionSettingsView): string {
  if (completion.effective.source === 'local') return '本地兜底 · 当前没有可用的模型服务'
  if (completion.effective.source === 'http') return `自定义端点 · ${completion.effective.model}`
  return `DSH 模型 · ${completion.effective.model}`
}

/** DSH 模型路由列表的展示形态。dshModels.ts 是队友的模块，这里不依赖它的类型形状：
 *  宿主版本不同时 routes 可能是字符串数组，也可能是 { route, label } 对象数组。 */
interface ModelChoice { route: string; label: string }

function modelChoiceOf(entry: unknown): ModelChoice | undefined {
  if (typeof entry === 'string') return entry.trim() === '' ? undefined : { route: entry, label: entry }
  if (typeof entry !== 'object' || entry === null) return undefined
  const record = entry as Record<string, unknown>
  const route = record['route']
  if (typeof route !== 'string' || route.trim() === '') return undefined
  const label = record['label']
  return { route, label: typeof label === 'string' && label.trim() !== '' ? label : route }
}

function normalizeModelRoutes(value: unknown): ModelChoice[] {
  if (typeof value !== 'object' || value === null) return []
  const routes = (value as { routes?: unknown }).routes
  if (!Array.isArray(routes)) return []
  const choices: ModelChoice[] = []
  const seen = new Set<string>()
  for (const entry of routes) {
    const choice = modelChoiceOf(entry)
    if (choice === undefined || seen.has(choice.route)) continue
    seen.add(choice.route)
    choices.push(choice)
  }
  return choices
}

function normalizeModelDefault(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const fallback = (value as { default?: unknown }).default
  return typeof fallback === 'string' && fallback.trim() !== '' ? fallback : undefined
}

/** 自动换行模式。 */
const WORD_WRAP_OPTIONS: ReadonlyArray<{ value: WordWrapMode; label: string }> = [
  { value: 'off', label: '关闭' },
  { value: 'on', label: '按窗口宽度' },
  { value: 'bounded', label: '按列宽' },
]

const RENDER_WHITESPACE_OPTIONS: ReadonlyArray<{ value: RenderWhitespace; label: string }> = [
  { value: 'none', label: '不显示' },
  { value: 'selection', label: '仅选区' },
  { value: 'all', label: '全部' },
]

const CURSOR_STYLE_OPTIONS: ReadonlyArray<{ value: CursorStyle; label: string }> = [
  { value: 'line', label: '竖线' },
  { value: 'block', label: '方块' },
  { value: 'underline', label: '下划线' },
]

const AUTO_SAVE_OPTIONS: ReadonlyArray<{ value: AutoSaveMode; label: string }> = [
  { value: 'off', label: '关闭' },
  { value: 'afterDelay', label: '延迟保存' },
]

/** 行高允许「自动」（0）或 16–40px 的整数；下拉里把每个合法值都列出来，
 *  这样存储里被手改成奇数（比如 17）时控件仍然能显示对应的选中项。 */
const LINE_HEIGHT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '0', label: '自动' },
  ...Array.from({ length: PREFERENCE_LIMITS.editorLineHeight.max - EDITOR_LINE_HEIGHT_MIN + 1 }, (_, offset) => {
    const pixels = EDITOR_LINE_HEIGHT_MIN + offset
    return { value: String(pixels), label: `${pixels} px` }
  }),
]

/** 只读键位清单：这些能力在工作台里没有任何可见入口，不写在设置页就只能靠猜。 */
const SHORTCUTS: ReadonlyArray<{ keys: readonly string[]; label: string }> = [
  { keys: ['Tab'], label: '采纳整条补全建议' },
  { keys: ['Ctrl', 'Alt', '→'], label: '只采纳补全的下一行' },
  { keys: ['Ctrl', 'S'], label: '保存当前文件' },
  { keys: ['Ctrl', 'F'], label: '编辑器内查找' },
  { keys: ['Ctrl', 'H'], label: '编辑器内替换' },
  { keys: ['Ctrl', 'G'], label: '转到行' },
  { keys: ['Ctrl', '/'], label: '注释或取消注释当前行' },
  { keys: ['Shift', 'Alt', 'F'], label: '格式化文档' },
  { keys: ['Ctrl', 'Alt', 'B'], label: '显示或隐藏右侧 DSH 对话栏' },
  { keys: ['Ctrl', 'Shift', 'E'], label: '资源管理器' },
  { keys: ['Ctrl', 'Shift', 'F'], label: '搜索' },
  { keys: ['Ctrl', 'Shift', 'G'], label: '源代码管理' },
  { keys: ['Ctrl', '`'], label: '显示或隐藏终端' },
  { keys: ['Ctrl', 'Shift', '`'], label: '新建终端' },
]

/** 编辑器分组：每一项都真的写进 preferences，MonacoEditor 读同一份 store 后立即生效。 */
function EditorGroup({ preferences }: { preferences: ReturnType<typeof usePreferences> }) {
  return <section className="dvw-set-group">
    <h3 className="dvw-set-group-title">编辑器</h3>
    <Row title="字号" description="源码编辑器与差异对比的字体大小。">
      <Stepper value={preferences.editorFontSize} min={PREFERENCE_LIMITS.editorFontSize.min} max={PREFERENCE_LIMITS.editorFontSize.max} step={1} unit="px" label="编辑器字号"
        onChange={value => updatePreferences({ editorFontSize: value })}/>
    </Row>
    <Row title="行高" description="行与行之间的距离。选「自动」交给编辑器按字号换算，通常最稳妥。">
      <Choice label="编辑器行高" value={String(preferences.editorLineHeight)} options={LINE_HEIGHT_OPTIONS}
        onChange={value => updatePreferences({ editorLineHeight: Number(value) })}/>
    </Row>
    <Row title="制表符宽度" description="一个制表位等于几个空格列；只影响显示与按 Tab 的缩进量，不会重写已有文件。">
      <Stepper value={preferences.editorTabSize} min={PREFERENCE_LIMITS.editorTabSize.min} max={PREFERENCE_LIMITS.editorTabSize.max} step={1} unit="列" label="制表符宽度"
        onChange={value => updatePreferences({ editorTabSize: value })}/>
    </Row>
    <Row title="用空格缩进" description="按 Tab 时插入空格而不是制表符。关闭后保存到磁盘的是真正的 \\t，会与只认空格的格式化工具冲突。">
      <Switch checked={preferences.editorInsertSpaces} label="用空格缩进" onChange={value => updatePreferences({ editorInsertSpaces: value })}/>
    </Row>
    <Row title="自动换行" description="长行如何折行。「按列宽」时才使用下面的列宽数值。">
      <Choice label="自动换行模式" value={preferences.editorWordWrap} options={WORD_WRAP_OPTIONS}
        onChange={value => updatePreferences({ editorWordWrap: value })}/>
    </Row>
    <Row title="自动换行列宽" description="仅「按列宽」模式生效：在第几列折行。">
      <Stepper value={preferences.editorWordWrapColumn} min={PREFERENCE_LIMITS.editorWordWrapColumn.min} max={PREFERENCE_LIMITS.editorWordWrapColumn.max} step={10} unit="列" label="自动换行列宽"
        disabled={preferences.editorWordWrap !== 'bounded'}
        onChange={value => updatePreferences({ editorWordWrapColumn: value })}/>
    </Row>
    <Row title="缩略图" description="编辑器右侧的代码缩略图。关闭后只留滚动条，代码区更宽。">
      <Switch checked={preferences.editorMinimap} label="缩略图" onChange={value => updatePreferences({ editorMinimap: value })}/>
    </Row>
    <Row title="概览标尺" description="滚动条右侧的全局预览条，标出选区、搜索结果与错误位置。">
      <Switch checked={preferences.editorOverviewRuler} label="概览标尺" onChange={value => updatePreferences({ editorOverviewRuler: value })}/>
    </Row>
    <Row title="选中内容同类词高亮" description="划词后把文档里所有相同的词一起高亮，方便看清这个变量都在哪里用。">
      <Switch checked={preferences.editorOccurrencesHighlight} label="选中内容同类词高亮" onChange={value => updatePreferences({ editorOccurrencesHighlight: value })}/>
    </Row>
    <Row title="显示空白字符" description="把空格、制表符画成可见符号，用来排查缩进混用。">
      <Choice label="显示空白字符" value={preferences.editorRenderWhitespace} options={RENDER_WHITESPACE_OPTIONS}
        onChange={value => updatePreferences({ editorRenderWhitespace: value })}/>
    </Row>
    <Row title="光标样式" description="插入光标的形状；块状光标在深色主题下更容易定位。">
      <Choice label="光标样式" value={preferences.editorCursorStyle} options={CURSOR_STYLE_OPTIONS}
        onChange={value => updatePreferences({ editorCursorStyle: value })}/>
    </Row>
    <Row title="平滑滚动" description="滚动时用动画过渡，长文件里快速翻页更连贯；低配机器上可能显得迟滞。">
      <Switch checked={preferences.editorSmoothScrolling} label="平滑滚动" onChange={value => updatePreferences({ editorSmoothScrolling: value })}/>
    </Row>
    <Row title="粘性滚动" description="滚动时把当前函数 / 类的声明行钉在顶部，长文件里不容易迷失位置。">
      <Switch checked={preferences.editorStickyScroll} label="粘性滚动" onChange={value => updatePreferences({ editorStickyScroll: value })}/>
    </Row>
    <Row title="自动保存" description="开启后，停止编辑一段时间就自动保存有改动的标签页；关闭则只能手动 Ctrl+S。">
      <Choice label="自动保存模式" value={preferences.editorAutoSave} options={AUTO_SAVE_OPTIONS}
        onChange={value => updatePreferences({ editorAutoSave: value })}/>
    </Row>
    <Row title="自动保存延迟" description="仅「延迟保存」生效：最后一次改动静默多久后保存。">
      <Stepper value={preferences.editorAutoSaveDelayMs} min={PREFERENCE_LIMITS.editorAutoSaveDelayMs.min} max={PREFERENCE_LIMITS.editorAutoSaveDelayMs.max} step={500} unit="ms" label="自动保存延迟"
        disabled={preferences.editorAutoSave !== 'afterDelay'}
        onChange={value => updatePreferences({ editorAutoSaveDelayMs: value })}/>
    </Row>
  </section>
}

/**
 * 宿主设置（模型路由 / 失败兜底）的读写状态。
 *
 * 放在页面的顶层而不是各分组里：AI 补全分组要改它，关于分组要展示其中的设置文件路径，
 * 两处各拉一次会出现「同一份数据两个 owner」，写完一处另一处还是旧值。
 */
interface WorkbenchSettingsState {
  view: WorkbenchSettingsView | undefined
  loadError: string | undefined
  writeError: string | undefined
  saving: boolean
  routeDraft: string
  setRouteDraft(value: string): void
  commitRoute(): void
  commit(patch: { route?: string | null; fallback?: boolean }): void
}

function useWorkbenchSettings(): WorkbenchSettingsState {
  // 还没读到（或旧宿主没有这个端点）时 view 为 undefined，此时只禁用宿主侧那两项。
  const [view, setView] = useState<WorkbenchSettingsView>()
  const [loadError, setLoadError] = useState<string>()
  const [writeError, setWriteError] = useState<string>()
  const [saving, setSaving] = useState(false)
  // 输入框的草稿：失焦或回车才提交，不为每一个按键写一次盘。
  const [routeDraft, setRouteDraft] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    void readWorkbenchSettings(controller.signal)
      .then(next => { if (!controller.signal.aborted) { setView(next); setRouteDraft(next.completion.route ?? ''); setLoadError(undefined) } })
      .catch(error => { if (!controller.signal.aborted) setLoadError(messageOf(error)) })
    return () => controller.abort()
  }, [])

  const commit = async (patch: { route?: string | null; fallback?: boolean }) => {
    setSaving(true); setWriteError(undefined)
    try {
      const next = await writeWorkbenchSettings(patch)
      setView(next); setRouteDraft(next.completion.route ?? '')
    } catch (error) { setWriteError(messageOf(error)) }
    finally { setSaving(false) }
  }
  const commitRoute = () => {
    if (saving || view === undefined) return
    const stored = view.completion.route ?? ''
    const next = routeDraft.trim()
    if (next === stored) return
    void commit({ route: next === '' ? null : next })
  }

  return { view, loadError, writeError, saving, routeDraft, setRouteDraft, commitRoute, commit }
}

/** AI 补全分组：客户端开关与节奏走 preferences；模型路由与兜底走宿主设置文件。 */
function CompletionGroup({ preferences, settings }: { preferences: ReturnType<typeof usePreferences>; settings: WorkbenchSettingsState }) {
  const { view, loadError, writeError, saving, routeDraft, setRouteDraft, commitRoute, commit } = settings
  // DSH 的模型列表：拿不到就保持为空，模型路由控件退化成纯手填。
  const [modelRoutes, setModelRoutes] = useState<readonly ModelChoice[]>([])
  const [modelDefault, setModelDefault] = useState<string>()

  // 模型列表来自 DSH 宿主；接口约定「失败返回空」但仍加 catch —— 旧宿主没有这个端点时
  // listDshModelRoutes 可能直接拒绝，绝不能让设置页跟着白屏。
  useEffect(() => {
    const controller = new AbortController()
    void listDshModelRoutes(controller.signal)
      .then(result => {
        if (controller.signal.aborted) return
        setModelRoutes(normalizeModelRoutes(result))
        setModelDefault(normalizeModelDefault(result))
      })
      .catch(() => { if (!controller.signal.aborted) setModelRoutes([]) })
    return () => controller.abort()
  }, [])

  const completionUnavailable = view === undefined
  const completion = view?.completion
  const routeDescription = modelRoutes.length > 0
    ? `从 DSH 已配置的模型里选，也可以直接手填 provider/model。留空则跟随 DSH 默认模型${modelDefault === undefined ? '' : `（当前为 ${modelDefault}）`}；回车或离开输入框即保存。`
    : '跟随 DSH 默认模型。暂时读不到 DSH 的模型列表，可以直接手填 provider/model；留空表示跟随 DSH 默认模型。回车或离开输入框即保存。'

  return <section className="dvw-set-group">
    <h3 className="dvw-set-group-title">AI 补全</h3>
    <Row title="行内补全" description="在编辑器里按 Tab 采纳建议。关闭后一次模型请求都不会发出，也不会有幻影文本。">
      <Switch checked={preferences.completionEnabled} label="行内补全" onChange={value => updatePreferences({ completionEnabled: value })}/>
    </Row>
    <div className="dvw-set-row dvw-set-row-stack">
      <div className="dvw-set-text">
        <span className="dvw-set-title">模型路由</span>
        <span className="dvw-set-desc">{routeDescription}</span>
      </div>
      <input className="dvw-set-input" list="dvw-set-model-route-options" value={routeDraft} placeholder="跟随 DSH 默认模型" aria-label="补全模型路由" spellCheck={false} autoComplete="off"
        disabled={completionUnavailable || saving}
        onChange={event => setRouteDraft(event.target.value)}
        onBlur={commitRoute}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); return }
          if (event.key !== 'Escape') return
          event.preventDefault()
          setRouteDraft(completion?.route ?? '')
          event.currentTarget.blur()
        }}/>
      <datalist id="dvw-set-model-route-options">
        {modelRoutes.map(choice => <option key={choice.route} value={choice.route}>{choice.label}</option>)}
      </datalist>
    </div>
    <Row title="模型失败时回落本地兜底" description="默认关闭：故障应当显式暴露。开启后仍有候选可用，回落原因会写进补全诊断日志。">
      <Switch checked={completion?.fallback ?? false} label="模型失败时回落本地兜底" disabled={completionUnavailable || saving}
        onChange={value => { if (!saving && completion !== undefined) void commit({ fallback: value }) }}/>
    </Row>
    <Row title="触发延迟" description="停止输入多久后才向模型请求补全。调大可减少不必要的调用，但补全出现得更晚。">
      <Stepper value={preferences.completionDebounceMs} min={PREFERENCE_LIMITS.completionDebounceMs.min} max={PREFERENCE_LIMITS.completionDebounceMs.max} step={10} unit="ms" label="补全触发延迟"
        onChange={value => updatePreferences({ completionDebounceMs: value })}/>
    </Row>
    {completion !== undefined && <Info label="当前生效" value={effectiveLabel(completion)}/>}
    {completion?.routeSource === 'env' && <Info tone="warn" label="环境变量覆盖" value={`DSH_COMPLETION_ROUTE=${completion.envRoute ?? ''} 正在覆盖这里设置的路由`}/>}
    {completion?.fallbackSource === 'env' && <Info tone="warn" label="环境变量覆盖" value="DSH_COMPLETION_FALLBACK=local 正在覆盖这里的兜底开关"/>}
    {completion?.lastFailure != null && <Info tone="warn" label="最近一次失败" value={completion.lastFailure}/>}
    {completion?.file !== undefined && <Info label="设置文件" value={completion.file}/>}
    {loadError !== undefined && <Info tone="warn" label="宿主设置不可用" value={`${loadError}。模型路由与兜底需要重启 DSH 后才能在这里改，界面偏好不受影响。`}/>}
    {writeError !== undefined && <Info tone="error" label="保存失败" value={writeError}/>}
  </section>
}

/** 终端分组。终端字号只写偏好，由终端面板读取后应用（接线在工作台侧）。 */
function TerminalGroup({ preferences }: { preferences: ReturnType<typeof usePreferences> }) {
  return <section className="dvw-set-group">
    <h3 className="dvw-set-group-title">终端</h3>
    <Row title="终端字号" description="终端（xterm）的字体大小，与编辑器的字号互不影响。保存后由终端面板读取并重新量算列宽。">
      <Stepper value={preferences.terminalFontSize} min={PREFERENCE_LIMITS.terminalFontSize.min} max={PREFERENCE_LIMITS.terminalFontSize.max} step={1} unit="px" label="终端字号"
        onChange={value => updatePreferences({ terminalFontSize: value })}/>
    </Row>
  </section>
}

/** 快捷键分组：只读清单，这些键位没有别的入口能发现。 */
function ShortcutGroup() {
  return <section className="dvw-set-group">
    <h3 className="dvw-set-group-title">快捷键</h3>
    {SHORTCUTS.map(shortcut => <div className="dvw-set-row" key={shortcut.label}>
      <div className="dvw-set-text"><span className="dvw-set-title">{shortcut.label}</span></div>
      <div className="dvw-set-control">{shortcut.keys.map(key => <kbd className="dvw-set-keycap" key={key}>{key}</kbd>)}</div>
    </div>)}
  </section>
}

/** 关于与诊断分组：版本、设置落点、以及一个带二次确认的「恢复默认设置」。 */
function AboutGroup({ settingsFile }: { settingsFile?: string }) {
  const [resetArmed, setResetArmed] = useState(false)
  return <section className="dvw-set-group">
    <h3 className="dvw-set-group-title">关于与诊断</h3>
    <Info label="版本" value={WORKBENCH_VERSION}/>
    <Info label="DSH 设置文件" value={settingsFile ?? 'DSH 数据目录下的工作台设置文件（读取到宿主设置后显示完整路径）'}/>
    <Info label="客户端偏好键" value={PREFERENCES_KEY}/>
    <Info label="界面偏好位置" value="本机浏览器 localStorage；换浏览器或清空站点数据会回到默认值"/>
    <div className="dvw-set-row">
      <div className="dvw-set-text">
        <span className="dvw-set-title">恢复默认设置</span>
        <span className="dvw-set-desc">把这一页保存的界面偏好全部写回默认值。宿主侧的模型路由与兜底不在其中，不会被改动。</span>
      </div>
      <div className="dvw-set-control">
        {resetArmed
          ? <>
            <button type="button" className="dvw-set-button dvw-set-button-danger" onClick={() => { resetPreferences(); setResetArmed(false) }}>确认恢复</button>
            <button type="button" className="dvw-set-button dvw-set-button-secondary" onClick={() => setResetArmed(false)}>取消</button>
          </>
          : <button type="button" className="dvw-set-button" onClick={() => setResetArmed(true)}>恢复默认设置</button>}
      </div>
    </div>
  </section>
}

/**
 * 设置页。
 *
 * 一列滚动、按分组标题分段，**不做页内左侧分类导航**：之前那版左栏（152px 卡片 + 竖排 tab）
 * 在 DSH 设置的内容列里太挤也难看，而 DSH 自己的设置页本来就是单列滚动、靠分组标题区分。
 * 分组标题与行字号也按 DSH 设置页的规格来：行标题 14px/20px、说明 12px/18px、行距与分隔线一致，
 * 不再让某些控件（输入框、步进器）比标签大一号。
 */
export function SettingsPanel() {
  const preferences = usePreferences()
  // 宿主设置只有一个 owner：AI 补全分组负责改，关于分组负责展示其中的设置文件路径。
  const settings = useWorkbenchSettings()

  return <div className="dvw-settings-panel">
    <EditorGroup preferences={preferences}/>
    <CompletionGroup preferences={preferences} settings={settings}/>
    <TerminalGroup preferences={preferences}/>
    <ShortcutGroup/>
    <AboutGroup settingsFile={settings.view?.completion.file}/>
    <p className="dvw-set-footnote">界面偏好保存在本机浏览器里；补全的模型路由与兜底写入 DSH 数据目录，重启后仍然有效。</p>
  </div>
}
