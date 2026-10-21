/**
 * Git Graph 同款图标（提交图的入口按钮）。
 *
 * 图形数据来自 mhutchie/vscode-git-graph（MIT）的 `resources/cmd-icon-dark.svg` /
 * `cmd-icon-light.svg`：同一个形状按主题出深/浅两套灰阶。这里改成 `currentColor` + 不同
 * opacity，既保留原来的三层灰阶观感，又能跟随 AIDE 的 DSH 主题变色（不需要再判断明暗）。
 */
export function GitGraphMark({ className = '' }: { className?: string }) {
  return <span className={`dvw-git-graph-mark ${className}`.trim()} aria-hidden="true">
    <svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
      <g fill="currentColor">
        <path opacity=".7" d="m 2.604,10.221 c 0,0 0.292,0.117 0.729,0.117 0.437,0 0.729,-0.117 0.729,-0.117 V 15 H 2.604 Z"/>
        <path opacity=".85" d="m 7.27,4.965 c 0,0 0.292,0.117 0.729,0.118 C 8.437,5.083 8.729,4.965 8.729,4.965 V 9.441 L 7.270,9.167 Z"/>
        <path opacity=".85" d="m 7.27,11.803 1.458,0.268 V 15 H 7.270 Z"/>
        <path opacity=".45" d="m 2.604,1 h 1.458 v 4.783 c 0,0 -0.292,-0.117 -0.742,-0.117 -0.425,0 -0.716,0.118 -0.716,0.117 z"/>
        <path opacity=".6" d="m 4,10.238 c 0.055,0.041 0.001,0.02 0.501,0.242 1,0.437 2.206,0.638 3.372,0.857 1.167,0.219 2.068,0.333 2.819,0.661 0.327,-0.49 0.737,-0.811 1.309,-0.979 -0.111,-0.075 0,-0.029 -0.5,-0.248 C 10.5,10.334 9.294,10.133 8.127,9.914 6.961,9.695 6.072,9.552 5.322,9.223 5.085,9.592 4.695,10.029 3.998,10.238 Z"/>
        <circle opacity=".7" cx="3.33" cy="8" r="1.75"/>
        <circle opacity=".85" cx="8" cy="2.75" r="1.75"/>
        <circle opacity=".6" cx="12.67" cy="13.25" r="1.75"/>
      </g>
    </svg>
  </span>
}
