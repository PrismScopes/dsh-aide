/**
 * 「问题」（Problems）底部面板的样式。
 *
 * 为什么单独成文件而不是直接写进 styles.ts：问题面板与语言服务是分批落地的能力，样式先在这里
 * 独立评审、独立测试；接入时由 styles.ts 的 CSS 模板插值这一份（Lead 负责，见文件末尾说明），
 * 这样面板的改动不会和别的面板抢同一个超长字符串。
 *
 * 约定：
 * - 类名统一 `.dvw-problems-*`，全部挂在 `.dvw-problems` 下面；
 * - 只用工作台已有的 CSS 变量，不写死亮/暗两套颜色 —— 主题切换由 DSH 令牌负责；
 * - 严重级别只用 --dvw-error / --dvw-warn / --dvw-accent / --dvw-text-3 四种颜色。
 *
 * 虚拟化的行是绝对定位的：外层 `.dvw-problems-list` 负责滚动，内层 `.dvw-problems-rows` 撑出总高度，
 * 每一行用内联的 `top/height` 落在自己的位置上（行高常量见 problemView.ts）。因此这里的 `.dvw-problems-file`
 * 与 `.dvw-problems-item` 只负责「长什么样」，不再负责行高（行高随「单行 / 多行」模式变化）。
 *
 * 接入方式（styles.ts，Lead 操作）：在 CSS 模板里插值 `${PROBLEMS_STYLES}` 即可，
 * 不需要再复制任何规则；本文件不 import 任何模块，也不产生运行时副作用。
 */
export const PROBLEMS_STYLES = String.raw`

/* ---- 问题面板（Problems）：工作区诊断列表 ---- */
.dvw-problems{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dvw-text);background:var(--dvw-base)}

/* 顶部工具条：严重级别过滤 + 文本过滤 + 视图模式 + 两个开关 + 交给 AI + 扫描入口。 */
.dvw-problems-toolbar{flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:5px 8px;border-bottom:1px solid var(--dvw-border)}
.dvw-problems-filters{display:flex;gap:2px}
.dvw-problems-filter{display:flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:0;border-radius:var(--dvw-radius-xs);background:transparent;color:var(--dvw-text-2);font:inherit;cursor:pointer}
.dvw-problems-filter:hover{background:var(--dvw-hover);color:var(--dvw-text)}
.dvw-problems-filter[aria-pressed=true]{background:var(--dvw-active);color:var(--dvw-text)}
.dvw-problems-filter[aria-pressed=false]{color:var(--dvw-text-3)}
.dvw-problems-glyph{flex:none;width:12px;text-align:center;font-size:11px;font-weight:700;line-height:1}
.dvw-problems-filter[data-severity=error] .dvw-problems-glyph{color:var(--dvw-error)}
.dvw-problems-filter[data-severity=warning] .dvw-problems-glyph{color:var(--dvw-warn)}
.dvw-problems-filter[data-severity=info] .dvw-problems-glyph{color:var(--dvw-accent)}
.dvw-problems-filter[aria-pressed=false] .dvw-problems-glyph{color:var(--dvw-text-3)}
.dvw-problems-count{min-width:12px;text-align:right;font-size:11px;color:var(--dvw-text-3);font-variant-numeric:tabular-nums}
.dvw-problems-query{flex:1;min-width:120px;max-width:320px;height:24px;padding:0 8px;border:1px solid var(--dvw-border);border-radius:var(--dvw-radius-xs);background:var(--dvw-surface-2);color:var(--dvw-text);font:inherit;outline:none}
.dvw-problems-query::placeholder{color:var(--dvw-text-3)}
.dvw-problems-query:focus{border-color:var(--dvw-accent)}

/* 视图模式与开关：外观一致，选中态用 aria-pressed 表达（测试/读屏都读得到）。 */
.dvw-problems-modes{display:flex;gap:2px}
.dvw-problems-mode,.dvw-problems-toggle{height:24px;padding:0 8px;border:1px solid var(--dvw-border);border-radius:var(--dvw-radius-xs);background:transparent;color:var(--dvw-text-2);font:inherit;cursor:pointer}
.dvw-problems-mode:hover:not(:disabled),.dvw-problems-toggle:hover:not(:disabled){background:var(--dvw-hover);color:var(--dvw-text)}
.dvw-problems-mode[aria-pressed=true],.dvw-problems-toggle[aria-pressed=true]{background:var(--dvw-active);border-color:var(--dvw-accent);color:var(--dvw-text)}
.dvw-problems-toggle:disabled{opacity:.5;cursor:default}

/* 「交给 AI」：成功后进入约 3 秒的完成态，避免用户重复点击。 */
.dvw-problems-ai{height:24px;padding:0 10px;border:1px solid var(--dvw-border);border-radius:var(--dvw-radius-xs);background:transparent;color:var(--dvw-text-2);font:inherit;cursor:pointer}
.dvw-problems-ai:hover:not(:disabled){background:var(--dvw-hover);color:var(--dvw-text)}
.dvw-problems-ai[data-done=true]{border-color:var(--dvw-accent);color:var(--dvw-accent)}
.dvw-problems-ai:disabled{opacity:.55;cursor:default}

.dvw-problems-scan{margin-left:auto;height:24px;padding:0 10px;border:1px solid var(--dvw-border);border-radius:var(--dvw-radius-xs);background:transparent;color:var(--dvw-text-2);font:inherit;cursor:pointer}
.dvw-problems-scan:hover:not(:disabled){background:var(--dvw-hover);color:var(--dvw-text)}
.dvw-problems-scan:disabled{opacity:.5;cursor:default}
/* 扫描进度：运行中显示 checked/total，扫描结束自动消失（状态来自 snapshot.scan）。 */
.dvw-problems-progress{flex:none;padding:3px 10px;border-bottom:1px solid var(--dvw-border);color:var(--dvw-text-3);font-size:11px;font-variant-numeric:tabular-nums}

/* 滚动容器 + 虚拟化行容器：行绝对定位在内层，外层只负责滚动与键盘焦点。 */
.dvw-problems-list{flex:1;min-height:0;overflow:auto;padding:3px 0 8px;outline:none}
.dvw-problems-list:focus-visible{outline:1px solid var(--dvw-accent);outline-offset:-1px}
.dvw-problems-rows{position:relative;width:100%}
.dvw-problems-row{position:absolute;left:0;right:0;box-sizing:border-box}
.dvw-problems-row[aria-selected=true]{background:var(--dvw-active)}
.dvw-problems-row[aria-selected=true] .dvw-problems-message{color:var(--dvw-text)}

/* 文件头行：26px（行高由内联样式给，这里只管内部排版）。 */
.dvw-problems-file{display:flex;align-items:center;gap:5px;width:100%;padding:0 8px;color:var(--dvw-text);font:inherit;text-align:left;cursor:pointer}
.dvw-problems-file:hover{background:var(--dvw-hover)}
.dvw-problems-chevron{flex:none;width:14px;font-size:14px;color:var(--dvw-text-3)}
.dvw-problems-file-name{flex:none;font-weight:600;white-space:nowrap}
.dvw-problems-file-dir{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dvw-text-3)}
.dvw-problems-file-counts{display:flex;flex:none;gap:8px;margin-left:auto;font-size:11px;font-variant-numeric:tabular-nums}
.dvw-problems-file-count[data-severity=error]{color:var(--dvw-error)}
.dvw-problems-file-count[data-severity=warning]{color:var(--dvw-warn)}

/* 诊断行：单行 24px / 多行 42px（行高由内联样式给）；单行截断，多行按两行截断。 */
.dvw-problems-item{display:flex;align-items:flex-start;gap:6px;width:100%;padding:3px 10px 3px 29px;color:var(--dvw-text);font:inherit;line-height:18px;text-align:left;cursor:pointer}
.dvw-problems-item:hover{background:var(--dvw-hover)}
.dvw-problems-item .dvw-problems-glyph{margin-top:3px}
.dvw-problems-item[data-severity=error] .dvw-problems-glyph{color:var(--dvw-error)}
.dvw-problems-item[data-severity=warning] .dvw-problems-glyph{color:var(--dvw-warn)}
.dvw-problems-item[data-severity=info] .dvw-problems-glyph{color:var(--dvw-accent)}
.dvw-problems-item[data-severity=hint] .dvw-problems-glyph{color:var(--dvw-text-3)}
.dvw-problems-message{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dvw-problems-item[data-multiline=true] .dvw-problems-message{white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.dvw-problems-meta{flex:none;white-space:nowrap;font-size:11px;color:var(--dvw-text-3);font-variant-numeric:tabular-nums}
.dvw-problems-item[data-multiline=true] .dvw-problems-meta{margin-top:3px}

/* 空态：没有任何诊断，或过滤后没有匹配项。 */
.dvw-problems-empty{padding:26px 24px;text-align:center;color:var(--dvw-text-3)}
.dvw-problems-empty-title{margin:0 0 4px;font-weight:600;color:var(--dvw-text-2)}
.dvw-problems-empty-note{margin:0;font-size:12px;line-height:18px}

/* 语言服务器状态摘要：贴底一行，失败/未安装用严重级别色提示。 */
.dvw-problems-servers{flex:none;display:flex;flex-wrap:wrap;gap:4px 12px;padding:4px 10px;border-top:1px solid var(--dvw-border);font-size:11px;color:var(--dvw-text-3)}
.dvw-problems-server[data-state=failed]{color:var(--dvw-error)}
.dvw-problems-server[data-state=missing]{color:var(--dvw-warn)}

`
