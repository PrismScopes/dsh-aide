/**
 * 「改动」底部面板（工作区改动审查 + 检查点）的样式。
 *
 * 与问题/输出面板同一套约定：全部类名挂在 `.dvw-review-*` 下，颜色只用工作台已有的
 * CSS 变量，亮/暗两套由 DSH 主题令牌决定。接入方式是在 styles.ts 的 CSS 模板里插值
 * `${REVIEW_STYLES}`，本文件不 import 任何模块。
 */

export const REVIEW_STYLES = String.raw`
.dvw-review{height:100%;display:flex;flex-direction:column;background:var(--dvw-surface-1);font-size:12px;color:var(--dvw-text)}
.dvw-review-toolbar{flex:none;display:flex;align-items:center;gap:6px;height:32px;padding:0 8px;border-bottom:1px solid var(--dvw-border-soft)}
.dvw-review-button{height:24px;padding:0 8px;border:1px solid transparent;border-radius:var(--dvw-radius-xs);background:transparent;color:var(--dvw-text-2);font:inherit;cursor:pointer}
.dvw-review-button:hover{background:var(--dvw-hover);color:var(--dvw-text)}
.dvw-review-button:disabled{opacity:.45;cursor:default}
.dvw-review-button[data-danger=true]{color:var(--dvw-error);border-color:color-mix(in srgb,var(--dvw-error) 45%,transparent)}
.dvw-review-count{margin-left:auto;color:var(--dvw-text-3);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dvw-review-error{flex:none;padding:6px 10px;background:color-mix(in srgb,var(--dvw-error) 12%,transparent);color:var(--dvw-error)}
.dvw-review-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 260px}
.dvw-review-files{min-height:0;overflow:auto}
.dvw-review-row{display:flex;align-items:center;gap:8px;min-height:26px;padding:0 10px}
.dvw-review-row:hover{background:var(--dvw-hover)}
.dvw-review-row[data-reviewed=true]{opacity:.62}
.dvw-review-status{width:16px;flex:none;text-align:center;font-weight:700;font-size:11px}
.dvw-review-status[data-status=M]{color:var(--dvw-warn)}
.dvw-review-status[data-status=A],.dvw-review-status[data-status=U]{color:var(--dvw-success)}
.dvw-review-status[data-status=D]{color:var(--dvw-error)}
.dvw-review-status[data-status=R]{color:var(--dvw-accent)}
.dvw-review-path{flex:1;min-width:0;padding:0;border:0;background:transparent;color:var(--dvw-text);font:inherit;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dvw-review-path:hover{color:var(--dvw-accent);text-decoration:underline}
.dvw-review-tag{flex:none;padding:0 5px;border:1px solid var(--dvw-border-soft);border-radius:999px;color:var(--dvw-text-3);font-size:10px;line-height:16px}
.dvw-review-tag[data-warn=true]{color:var(--dvw-warn);border-color:color-mix(in srgb,var(--dvw-warn) 45%,transparent)}
.dvw-review-actions{flex:none;display:flex;align-items:center;gap:2px}
.dvw-review-side{min-height:0;overflow:auto;padding:6px;border-left:1px solid var(--dvw-border-soft)}
.dvw-review-section{padding:4px 4px 6px;font-size:11px;color:var(--dvw-text-3)}
.dvw-review-checkpoint{display:flex;align-items:center;gap:6px;padding:4px;border-radius:var(--dvw-radius-xs)}
.dvw-review-checkpoint:hover{background:var(--dvw-hover)}
.dvw-review-checkpoint-main{flex:1;min-width:0;display:flex;flex-direction:column}
.dvw-review-checkpoint-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dvw-text-2)}
.dvw-review-checkpoint-meta{font-size:10px;color:var(--dvw-text-3)}
.dvw-review-empty{padding:14px 10px;color:var(--dvw-text-3);font-size:12px}
`
