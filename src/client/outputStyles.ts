/**
 * 「输出」底部面板的样式（独立文件，避免和 styles.ts 的超长模板互相抢字符串）。
 *
 * 约定：类名统一 `.dvw-output-*`；只用工作台现有 CSS 变量，不写死亮/暗两套颜色。
 * 面板逻辑在 OutputPanel.tsx，通道存储在 output.ts。
 *
 * 虚拟化要求行高固定：`.dvw-output-line` 的 height/line-height 必须与 OutputPanel.tsx 的
 * OUTPUT_LINE_HEIGHT（18px）一致，滚动位置才能用「scrollTop / 18」换算成行号。
 */
export const OUTPUT_STYLES = String.raw`

/* ---- 输出（Output）：语言服务 / Git 日志通道，只读 ---- */
.dvw-output{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dvw-base);color:var(--dvw-text)}

/* 工具条：通道 + 五级过滤 + 搜索 + 动作。 */
.dvw-output-toolbar{flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 8px;border-bottom:1px solid var(--dvw-border)}
.dvw-output-channel{height:24px;max-width:200px;padding:0 6px;border:1px solid var(--dvw-border);border-radius:var(--dvw-radius-xs);background:var(--dvw-surface-2);color:var(--dvw-text);font:inherit;font-size:12px;outline:0}
.dvw-output-channel:focus{border-color:var(--dvw-accent)}
.dvw-output-levels{display:flex;gap:2px}
.dvw-output-level{display:flex;align-items:center;gap:3px;height:24px;padding:0 6px;border:0;border-radius:var(--dvw-radius-xs);background:transparent;color:var(--dvw-text-2);font:inherit;font-size:12px;cursor:pointer}
.dvw-output-level:hover{background:var(--dvw-hover);color:var(--dvw-text)}
.dvw-output-level[aria-pressed=true]{background:var(--dvw-active);color:var(--dvw-text)}
.dvw-output-level[aria-pressed=false]{color:var(--dvw-text-3)}
.dvw-output-level-glyph{font-size:11px;font-weight:700;line-height:1}
.dvw-output-level[data-level=trace] .dvw-output-level-glyph{color:var(--dvw-text-3)}
.dvw-output-level[data-level=debug] .dvw-output-level-glyph{color:var(--dvw-text-2)}
.dvw-output-level[data-level=info] .dvw-output-level-glyph{color:var(--dvw-accent)}
.dvw-output-level[data-level=warn] .dvw-output-level-glyph{color:var(--dvw-warn)}
.dvw-output-level[data-level=error] .dvw-output-level-glyph{color:var(--dvw-error)}
/* 关闭的级别只变灰，不消失：按钮本身永远在。 */
.dvw-output-level[aria-pressed=false] .dvw-output-level-glyph{color:var(--dvw-text-3)}
.dvw-output-count{min-width:10px;text-align:right;font-size:11px;color:var(--dvw-text-3);font-variant-numeric:tabular-nums}
.dvw-output-query{flex:1;min-width:120px;max-width:260px;height:24px;padding:0 8px;border:1px solid var(--dvw-border);border-radius:var(--dvw-radius-xs);background:var(--dvw-surface-2);color:var(--dvw-text);font:inherit;font-size:12px;outline:none}
.dvw-output-query::placeholder{color:var(--dvw-text-3)}
.dvw-output-query:focus{border-color:var(--dvw-accent)}
.dvw-output-actions{display:flex;align-items:center;gap:2px;margin-left:auto}
.dvw-output-action{height:24px;padding:0 8px;border:1px solid transparent;border-radius:var(--dvw-radius-xs);background:transparent;color:var(--dvw-text-2);font:inherit;font-size:12px;cursor:pointer}
.dvw-output-action:hover:not(:disabled){background:var(--dvw-hover);color:var(--dvw-text)}
.dvw-output-action[aria-pressed=true]{border-color:var(--dvw-border);background:var(--dvw-active);color:var(--dvw-text)}
.dvw-output-action:disabled{opacity:.5;cursor:default}
.dvw-output-clear{height:24px;padding:0 10px;border:1px solid var(--dvw-border);border-radius:var(--dvw-radius-xs);background:transparent;color:var(--dvw-text-2);font:inherit;font-size:12px;cursor:pointer}
.dvw-output-clear:hover:not(:disabled){background:var(--dvw-hover);color:var(--dvw-text)}
.dvw-output-clear:disabled{opacity:.5;cursor:default}
.dvw-output-notice{flex-basis:100%;color:var(--dvw-text-3);font-size:11px}

/* 日志区：固定 18px 行高 + 横向滚动（white-space:pre，不折行）；虚拟化用 spacer + translateY。 */
.dvw-output-log{flex:1;min-height:0;overflow:auto;padding:4px 0;font:12px/18px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;white-space:pre}
.dvw-output-spacer{position:relative}
.dvw-output-rows{position:absolute;top:0;left:0;min-width:100%}
.dvw-output-line{display:flex;gap:8px;height:18px;line-height:18px;padding:0 10px;white-space:pre}
.dvw-output-time{flex:none;color:var(--dvw-text-3)}
.dvw-output-text{white-space:pre}
.dvw-output-line[data-level=trace] .dvw-output-text{color:var(--dvw-text-3)}
.dvw-output-line[data-level=debug] .dvw-output-text{color:var(--dvw-text-2)}
.dvw-output-line[data-level=warn] .dvw-output-text{color:var(--dvw-warn)}
.dvw-output-line[data-level=error] .dvw-output-text{color:var(--dvw-error)}

/* 文件链接：渲染成行内按钮，点击跳到对应位置。 */
.dvw-output-link{padding:0;border:0;background:transparent;color:var(--dvw-accent);font:inherit;line-height:inherit;text-decoration:underline dotted;text-underline-offset:2px;cursor:pointer}
.dvw-output-link:hover{text-decoration-style:solid}

.dvw-output-empty{padding:16px 12px;color:var(--dvw-text-3);font-size:12px;line-height:18px;white-space:pre-wrap}

`
