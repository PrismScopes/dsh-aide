import { useEffect, useState } from 'react'
import { LAYOUT_LIMITS, type VscodeWorkbench, type WorkbenchLayout } from './service.ts'

/**
 * 工作台的设置页。
 *
 * 注册进 DSH 设置导航（settings.section），排「插件市场」之后，所以它渲染在 DSH 设置面板的
 * 内容列内，必须自己贴合 DSH 的观感 —— 颜色一律取 --dsw-alias-* 令牌，不写死色值，
 * 深浅色由 DSH 自己切换。
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

/** 开关。用 role="switch" 而不是 checkbox，键盘与读屏语义更直接。 */
function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange(value: boolean): void }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="dvw-set-switch" onClick={() => onChange(!checked)}>
    <span className="dvw-set-knob"/>
  </button>
}

/** 带数值显示的滑块。 */
function Range({ value, min, max, label, onChange }: { value: number; min: number; max: number; label: string; onChange(value: number): void }) {
  return <div className="dvw-set-range">
    <input type="range" aria-label={label} min={min} max={max} step={1} value={value} onChange={(event) => onChange(Number(event.target.value))}/>
    <output>{value}px</output>
  </div>
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
        <Range value={layout.sideWidth} min={LAYOUT_LIMITS.sideWidth.min} max={LAYOUT_LIMITS.sideWidth.max} label="左侧视图宽度" onChange={(value) => patch({ sideWidth: value })}/>
      </Row>
      <Row title="DSH 对话栏宽度">
        <Range value={layout.chatWidth} min={LAYOUT_LIMITS.chatWidth.min} max={LAYOUT_LIMITS.chatWidth.max} label="DSH 对话栏宽度" onChange={(value) => patch({ chatWidth: value })}/>
      </Row>
    </section>
  </div>
}
