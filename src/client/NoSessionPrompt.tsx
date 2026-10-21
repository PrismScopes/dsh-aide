/**
 * 「没有主视图会话」时的提示层。
 *
 * 为什么单独抽出来：DSH 归档会话后主视图会话会变成 `undefined`，而 overlay 是全局挂载的。
 * 旧实现直接在 Overlay 里无条件渲染这层提示 —— 工作台**已经关着**（visible=false）也会被
 * 归档动作「弹」出来；此时点「返回 DSH」只是把 visible 再设回 false，提示层自己不看 visible，
 * 于是一直留在屏幕上，DSH 被整层盖住，表现为页面卡死。
 *
 * 所以这层提示必须和 Workbench 一样受 visible 控制：只有用户主动打开工作台、且确实没有会话时
 * 才显示。组件返回 null 时不会留下任何 DOM，也就不会挡住 DSH。
 */
import type { CSSProperties } from 'react'

const emptyStyle: CSSProperties = { gridColumn: '1/4' }

export function NoSessionPrompt({ visible, onBack }: { visible: boolean; onBack(): void }) {
  if (!visible) return null
  return <div className="dvw-overlay">
    <div className="dvw-empty" style={emptyStyle}>
      <div>请选择一个会话
        <div className="dvw-message" style={{ marginTop: 6 }}>先在 DSH 里选择要使用的会话，再打开 AIDE。</div>
      </div>
      <button className="dvw-mode-button" onClick={onBack}>返回 DSH</button>
    </div>
  </div>
}
