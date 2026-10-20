import { useEffect, useState } from 'react'
import type { CompletionSettingsView, WorkbenchSettingsView } from './api.ts'
import { ApiError, readWorkbenchSettings, writeWorkbenchSettings } from './api.ts'
import { PREFERENCE_LIMITS, updatePreferences, usePreferences } from './preferences.ts'

/**
 * 工作台的设置页。
 *
 * 注册进 DSH 设置导航（settings.section），渲染在设置面板的内容列里，所以必须贴合 DSH 的观感 ——
 * 颜色一律取 --dsw-alias-* 令牌，不写死色值，深浅色由 DSH 自己切换。
 *
 * **这一页只放「界面上改不了的东西」。** 早前那五项（左右栏与状态栏显隐、两个栏宽）已经移除：
 * 它们在工作台里本来就有就地控件 —— 活动栏点图标即切换左栏、标签栏按钮与 Ctrl+Alt+B 切对话栏、
 * 拖拽分隔条改宽度且双击恢复默认。把可拖动的东西再抄一份成数字设置，只会让同一个状态有两个入口，
 * 用户还得记住改哪个才算数。
 *
 * 现在三组：
 *   1. AI 补全 —— 总开关（客户端）、模型路由与失败兜底（宿主侧设置文件），外加当前生效与最近失败；
 *   2. 编辑器 —— 字号、自动换行、缩略图（这三项原先写死在代码里，只能改代码才变）；
 *   3. 快捷键 —— 只读清单：这些键位没有别的入口能发现。
 *
 * 两个控件的规格照 DSH 设置页重画（那些 class 是 CSS Module 哈希，插件里用不了）：
 *   - 开关：36×20、radius 999px；开启时轨道取前景色、圆钮取底色（反色），关闭时轨道为 16% 前景色、圆钮为三级文字色。
 *   - 步进器：72×36、radius 12px、底色为 bg-layer-3；数值用等宽数字，上下箭头默认透明、悬停才显形。
 */

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
function Stepper({ value, min, max, step, unit, label, onChange }: { value: number; min: number; max: number; step: number; unit: string; label: string; onChange(value: number): void }) {
  const clamp = (input: number) => Math.max(min, Math.min(max, input))
  return <>
    <div className="dvw-set-stepper">
      <span className="dvw-set-value">{value}</span>
      <span className="dvw-set-arrows">
        <button type="button" className="dvw-set-arrow" aria-label={`增大${label}`} disabled={value >= max} onClick={() => onChange(clamp(value + step))}><Arrow direction="up"/></button>
        <button type="button" className="dvw-set-arrow" aria-label={`减小${label}`} disabled={value <= min} onClick={() => onChange(clamp(value - step))}><Arrow direction="down"/></button>
      </span>
    </div>
    <span className="dvw-set-unit">{unit}</span>
  </>
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

/** 只读键位清单：这些能力在工作台里没有任何可见入口，不写在设置页就只能靠猜。 */
const SHORTCUTS: ReadonlyArray<{ keys: readonly string[]; label: string }> = [
  { keys: ['Tab'], label: '采纳整条补全建议' },
  { keys: ['Ctrl', 'Alt', '→'], label: '只采纳补全的下一行' },
  { keys: ['Ctrl', 'S'], label: '保存当前文件' },
  { keys: ['Ctrl', 'Alt', 'B'], label: '显示或隐藏右侧 DSH 对话栏' },
  { keys: ['Ctrl', 'Shift', 'E'], label: '资源管理器' },
  { keys: ['Ctrl', 'Shift', 'F'], label: '搜索' },
  { keys: ['Ctrl', 'Shift', 'G'], label: '源代码管理' },
  { keys: ['Ctrl', '`'], label: '显示或隐藏终端' },
  { keys: ['Ctrl', 'Shift', '`'], label: '新建终端' },
]

export function SettingsPanel() {
  const preferences = usePreferences()
  // 宿主侧的补全设置：还没读到（或旧宿主没有这个端点）时为 undefined，此时只禁用那两项。
  const [view, setView] = useState<WorkbenchSettingsView>()
  const [loadError, setLoadError] = useState<string>()
  const [writeError, setWriteError] = useState<string>()
  const [saving, setSaving] = useState(false)
  // 输入框的草稿：失焦或回车才提交，不为每一个按键写一次盘。
  const [routeDraft, setRouteDraft] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    void readWorkbenchSettings(controller.signal)
      .then(next => { setView(next); setRouteDraft(next.completion.route ?? ''); setLoadError(undefined) })
      .catch(error => { if (!controller.signal.aborted) setLoadError(messageOf(error)) })
    return () => controller.abort()
  }, [])

  const completionUnavailable = view === undefined
  const commit = async (patch: { route?: string | null; fallback?: boolean }) => {
    setSaving(true); setWriteError(undefined)
    try {
      const next = await writeWorkbenchSettings(patch)
      setView(next); setRouteDraft(next.completion.route ?? '')
    } catch (error) { setWriteError(messageOf(error)) }
    finally { setSaving(false) }
  }
  const commitRoute = () => {
    if (saving || completionUnavailable) return
    const stored = view.completion.route ?? ''
    const next = routeDraft.trim()
    if (next === stored) return
    void commit({ route: next === '' ? null : next })
  }

  const completion = view?.completion
  return <div className="dvw-settings-panel">
    <section className="dvw-set-group">
      <h3 className="dvw-set-group-title">AI 补全</h3>
      <Row title="行内补全" description="在编辑器里按 Tab 采纳建议。关闭后一次模型请求都不会发出。">
        <Switch checked={preferences.completionEnabled} label="行内补全" onChange={value => updatePreferences({ completionEnabled: value })}/>
      </Row>
      <div className="dvw-set-row dvw-set-row-stack">
        <div className="dvw-set-text">
          <span className="dvw-set-title">模型路由</span>
          <span className="dvw-set-desc">补全单独使用的模型，写成 provider/model。留空则跟随 DSH 的默认模型；回车或离开输入框即保存，立即生效。</span>
        </div>
        <input className="dvw-set-input" value={routeDraft} placeholder="跟随 DSH 默认模型" aria-label="补全模型路由" spellCheck={false} autoComplete="off"
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
      </div>
      <Row title="模型失败时回落本地兜底" description="默认关闭：故障应当显式暴露。开启后仍有候选可用，回落原因会写进补全诊断日志。">
        <Switch checked={completion?.fallback ?? false} label="模型失败时回落本地兜底" disabled={completionUnavailable || saving}
          onChange={value => { if (!saving && completion !== undefined) void commit({ fallback: value }) }}/>
      </Row>
      {completion !== undefined && <Info label="当前生效" value={effectiveLabel(completion)}/>}
      {completion?.routeSource === 'env' && <Info tone="warn" label="环境变量覆盖" value={`DSH_COMPLETION_ROUTE=${completion.envRoute ?? ''} 正在覆盖这里设置的路由`}/>}
      {completion?.fallbackSource === 'env' && <Info tone="warn" label="环境变量覆盖" value="DSH_COMPLETION_FALLBACK=local 正在覆盖这里的兜底开关"/>}
      {completion?.lastFailure != null && <Info tone="warn" label="最近一次失败" value={completion.lastFailure}/>}
      {completion?.file !== undefined && <Info label="设置文件" value={completion.file}/>}
      {loadError !== undefined && <Info tone="warn" label="宿主设置不可用" value={`${loadError}。模型路由与兜底需要重启 DSH 后才能在这里改，界面偏好不受影响。`}/>}
      {writeError !== undefined && <Info tone="error" label="保存失败" value={writeError}/>}
    </section>

    <section className="dvw-set-group">
      <h3 className="dvw-set-group-title">编辑器</h3>
      <Row title="字号" description="源码编辑器与差异对比的字体大小。">
        <Stepper value={preferences.editorFontSize} min={PREFERENCE_LIMITS.editorFontSize.min} max={PREFERENCE_LIMITS.editorFontSize.max} step={1} unit="px" label="编辑器字号"
          onChange={value => updatePreferences({ editorFontSize: value })}/>
      </Row>
      <Row title="自动换行" description="长行在编辑器宽度处折行，不再需要横向滚动。">
        <Switch checked={preferences.editorWordWrap} label="自动换行" onChange={value => updatePreferences({ editorWordWrap: value })}/>
      </Row>
      <Row title="缩略图" description="编辑器右侧的代码缩略图。关闭后只留滚动条。">
        <Switch checked={preferences.editorMinimap} label="缩略图" onChange={value => updatePreferences({ editorMinimap: value })}/>
      </Row>
    </section>

    <section className="dvw-set-group">
      <h3 className="dvw-set-group-title">快捷键</h3>
      {SHORTCUTS.map(shortcut => <div className="dvw-set-row" key={shortcut.label}>
        <div className="dvw-set-text"><span className="dvw-set-title">{shortcut.label}</span></div>
        <div className="dvw-set-control">{shortcut.keys.map(key => <kbd className="dvw-set-keycap" key={key}>{key}</kbd>)}</div>
      </div>)}
    </section>

    <p className="dvw-set-footnote">界面偏好保存在本机浏览器里；补全的模型路由与兜底写入 DSH 数据目录，重启后仍然有效。</p>
  </div>
}
