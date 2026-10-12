import { useEffect, useState } from 'react'
import { LAYOUT_LIMITS, type VscodeWorkbench, type WorkbenchLayout } from './service.ts'

/**
 * 工作台的设置页。
 *
 * 注册进 DSH 设置导航（settings.section），排「插件市场」之后，所以它渲染在 DSH 设置面板的
 * 内容列内，必须自己贴合 DSH 的观感 —— 颜色一律取 --dsw-alias-* 令牌，不写死色值，
 * 深浅色由 DSH 自己切换。
 *
 * 两个控件按 DSH 设置页里的真实规格复刻（那些 class 是 CSS Module 哈希，插件里用不了，
 * 只能照尺寸与配色重画）：
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
function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange(value: boolean): void }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="dvw-set-switch" onClick={() => onChange(!checked)}>
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

export function SettingsPanel({ service }: { service: VscodeWorkbench }) {
  const [layout, setLayout] = useState<WorkbenchLayout>(() => service.getLayout())
  // 布局存在 service 上，订阅它就能让设置页和工作台保持一致（比如用快捷键切换对话栏之后）。
  useEffect(() => service.subscribe(() => setLayout(service.getLayout())), [service])
  const patch = (value: Partial<WorkbenchLayout>) => service.setLayout(value)

  return <div className="dvw-settings-panel">
    <section className="dvw-set-group">
      <h3 className="dvw-set-group-title">界面</h3>
      <Row title="显示左侧视图" description="资源管理器、搜索与源代码管理所在的一栏。">
        <Switch checked={layout.primarySideVisible} label="显示左侧视图" onChange={(value) => patch({ primarySideVisible: value })}/>
      </Row>
      <Row title="显示 DSH 对话栏" description="工作台右侧常驻的 DSH 对话区，也可用 Ctrl+Alt+B 切换。">
        <Switch checked={layout.chatVisible} label="显示 DSH 对话栏" onChange={(value) => patch({ chatVisible: value })}/>
      </Row>
      <Row title="显示底部状态栏" description="显示工作区路径与光标位置的那一条。">
        <Switch checked={layout.statusVisible} label="显示底部状态栏" onChange={(value) => patch({ statusVisible: value })}/>
      </Row>
    </section>

    <section className="dvw-set-group">
      <h3 className="dvw-set-group-title">尺寸</h3>
      <Row title="左侧视图宽度">
        <Stepper value={layout.sideWidth} min={LAYOUT_LIMITS.sideWidth.min} max={LAYOUT_LIMITS.sideWidth.max} step={10} unit="px" label="左侧视图宽度" onChange={(value) => patch({ sideWidth: value })}/>
      </Row>
      <Row title="DSH 对话栏宽度">
        <Stepper value={layout.chatWidth} min={LAYOUT_LIMITS.chatWidth.min} max={LAYOUT_LIMITS.chatWidth.max} step={10} unit="px" label="DSH 对话栏宽度" onChange={(value) => patch({ chatWidth: value })}/>
      </Row>
    </section>
  </div>
}
