import type { BottomPanelProps } from './service.ts'

/**
 * 「调试控制台」（Debug Console）底部面板。
 *
 * 当前 AIDE 还没有接入调试器，所以这里先按 VS Code 的空状态呈现：面板已经占住位置，
 * 等调试器落地后把输出/求值结果写进 `.dvw-debug-log` 即可，不需要再改面板头或菜单入口。
 *
 * 不做输入框：没有活动的调试会话时，VS Code 的 REPL 也没有有意义可求值的目标；
 * 先给一个完全只读的占位，避免出现「看起来能输入、按回车却什么都不发生」的假交互。
 */
export function DebugConsolePanel(_props: BottomPanelProps) {
  return <div className="dvw-debug">
    <div className="dvw-debug-log" role="log" aria-label="调试控制台输出">
      <div className="dvw-debug-empty">
        <p className="dvw-debug-empty-title">调试控制台</p>
        <p className="dvw-debug-empty-note">没有活动的调试会话。</p>
        <p className="dvw-debug-empty-note">调试器接入后，调试输出与表达式求值结果会显示在这里。</p>
      </div>
    </div>
  </div>
}
