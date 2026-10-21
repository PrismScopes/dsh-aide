const CSS = String.raw`
@font-face{font-family:codicon;font-display:block;src:url('/dsh-vscode/codicons/codicon.ttf') format('truetype')}
.codicon{display:inline-block;font:normal normal normal 16px/1 codicon;text-align:center;text-decoration:none;text-rendering:auto;-webkit-font-smoothing:antialiased;user-select:none}
.codicon-add:before{content:"\ea60"}.codicon-git-branch:before,.codicon-source-control:before{content:"\ea68"}.codicon-search:before{content:"\ea6d"}.codicon-close:before{content:"\ea76"}.codicon-close-all:before{content:"\eac1"}.codicon-cloud-upload:before{content:"\eac3"}.codicon-file:before{content:"\ea7b"}.codicon-new-file:before{content:"\ea7f"}.codicon-new-folder:before{content:"\ea80"}.codicon-folder:before{content:"\ea83"}.codicon-trash:before{content:"\ea81"}.codicon-code:before{content:"\eac4"}.codicon-check:before{content:"\eab2"}.codicon-chevron-down:before{content:"\eab4"}.codicon-chevron-right:before{content:"\eab6"}.codicon-diff:before,.codicon-diff-sidebyside:before{content:"\eae1"}.codicon-diff-single:before{content:"\ec22"}.codicon-discard:before{content:"\eae2"}.codicon-file-code:before{content:"\eae9"}.codicon-file-media:before{content:"\eaea"}.codicon-file-pdf:before{content:"\eaeb"}.codicon-file-zip:before{content:"\eaef"}.codicon-files:before{content:"\eaf0"}.codicon-folder-opened:before{content:"\eaf7"}.codicon-home:before{content:"\eb06"}.codicon-list-tree:before{content:"\eb86"}.codicon-preview:before{content:"\eb2f"}.codicon-refresh:before{content:"\eb37"}.codicon-remove:before{content:"\eb3b"}

.codicon-layout-sidebar-right:before{content:"\ebf4"}.codicon-layout-sidebar-right-off:before{content:"\ec00"}.codicon-settings:before{content:"\eb51"}.codicon-split-horizontal:before{content:"\eb56"}.codicon-terminal:before{content:"\ea85"}
/* 搜索面板用的字形：Aa / ab / .* / 保留大小写 / 单条替换 / 全部替换 / 更多选项 / 全部折叠 / 全部展开。 */
.codicon-case-sensitive:before{content:"\eab1"}.codicon-whole-word:before{content:"\eb7e"}.codicon-regex:before{content:"\eb38"}.codicon-preserve-case:before{content:"\eb2e"}.codicon-replace:before{content:"\eb3d"}.codicon-replace-all:before{content:"\eb3c"}.codicon-ellipsis:before{content:"\ea7c"}.codicon-collapse-all:before{content:"\eac5"}.codicon-expand-all:before{content:"\eb95"}
/* 提交图 / 存储 / 标记相关字形（Git 面板与 Git 输出标签页）。 */
.codicon-graph:before{content:"\eb03"}.codicon-git-commit:before{content:"\eafc"}.codicon-git-merge:before{content:"\eafe"}.codicon-tag:before{content:"\ea66"}.codicon-archive:before{content:"\ea98"}.codicon-history:before{content:"\ea82"}
.codicon-repo:before{content:"\ea62"}
/* 工作台显示期间，把 DSH 侧栏底部那个账户/设置入口整行收起来。
   那一行在 (10, 948)–(270, 990)，伸进工作台活动栏（x 0–48）；被 overlay 盖住后既收不到点击
   （命中测试落在活动栏上），里面的图标又会从接缝里透出来，看起来就是「两个图标重叠」。
   工作台活动栏的设置按钮提供的是同一个入口，所以收起它不影响可达性。

   为什么用 CSS 而不是在 effect 里 row.remove()：DSH 在会话切换、重新渲染时会重建那一行。
   早前那次实现只在 visible 变化时移除一次，并把节点记下来以便恢复 —— 新建的节点不在记录里，
   effect 也不会重跑，于是移除失效、那行又露出来。样式是声明式的，重建多少次都照样生效。

   收起整行而不是只删 svg：那行放什么取决于登录状态（未登录是省略号图标，已登录是头像），
   只删 svg 会在已登录时漏掉头像。 */
body:has(.dvw-overlay) [class*=_triggerRow]{display:none!important}
body{/* 令牌定义在 body 上而不是 .dvw-overlay 上：右键菜单 portal 到 body，*/
/* 拿不到 overlay 作用域内的自定义属性，否则菜单会透明、无边框。 */
--dvw-side-width:210px;--dvw-base:var(--dsw-alias-bg-base,#181818);--dvw-surface-1:var(--dsw-alias-bg-layer-1,#1e1e1e);--dvw-surface-2:var(--dsw-alias-bg-layer-2,#252526);--dvw-surface-3:var(--dsw-alias-bg-layer-3,#2d2d30);--dvw-text:var(--dsw-alias-label-primary,#ccc);--dvw-text-2:var(--dsw-alias-label-secondary,#aaa);--dvw-text-3:var(--dsw-alias-label-tertiary,#858585);--dvw-border:var(--dsw-alias-border-l2,#333);--dvw-border-soft:var(--dsw-alias-border-l3,#292929);--dvw-hover:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));--dvw-active:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.14));--dvw-accent:var(--dsw-alias-state-business-primary,#3b82f6);--dvw-error:var(--dsw-alias-state-error-primary,#f48771);--dvw-success:var(--dsw-alias-state-success-primary,#73c991);--dvw-warn:var(--dsw-alias-state-warn-primary,#d7ba7d);--dvw-radius-xs:var(--dsw-radius-xs,4px);--dvw-radius-sm:var(--dsw-radius-sm,8px);--dvw-radius-md:var(--dsw-radius-md,12px);--dvw-shadow-1:var(--dsw-shadow-lv1,0 2px 4px 0 #0000000d);--dvw-shadow-2:var(--dsw-shadow-lv2,0 4px 12px 0 #00000005,0 2px 8px 0 #0000000a);--dvw-shadow-3:var(--dsw-shadow-lv3,0 0 1px 0 #0003,0 0 4px 0 #00000005,0 12px 32px 0 #00000014);--dvw-nav-active:var(--dsw-specific-sidebar-nav-item-active,#ebeef2);--dvw-nav-hover:var(--dsw-specific-sidebar-nav-item-hover,#f1f3f5);--dvw-sidebar-fill:var(--dsw-specific-sidebar-fill,#f9fafb);--dvw-mask:var(--dsw-alias-bg-mask-1,#0000003d);}
.dvw-overlay{position:absolute;inset:0;z-index:100;display:grid;grid-template-columns:48px var(--dvw-side-width) minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto 24px;background:var(--dvw-base);color:var(--dvw-text);pointer-events:auto;font:13px/1.4 var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);overflow:hidden}
/* DSH 桌面版在 Windows 上由窗口层占用顶部，官方的全屏覆盖层用
   padding-top:var(--dsh-windows-titlebar-height) 避让（见 dsh-client-ui-settings-account）。
   插件原先从 y=0 铺起，会盖住标题栏与窗口控制按钮。 */
[data-windows-titlebar] .dvw-overlay{padding-top:var(--dsh-windows-titlebar-height,0px)}
/* 这两处用 position:fixed 且把 top 写死为 36px（对齐对话栏头部），基准是视口而非
   overlay，因此不会随上面的 padding-top 下移。标题栏环境下需同步补偿，否则宿主
   对话面板会与对话栏头部重叠。 */

[data-windows-titlebar] [data-dvw-conversation-panel]{top:calc(36px + var(--dsh-windows-titlebar-height,0px))!important}
html[data-ds-theme-source=dark] .dvw-overlay{color-scheme:dark}


.dvw-overlay *{box-sizing:border-box}.dvw-activity{grid-row:1/3;background:var(--dvw-sidebar-fill);border-right:1px solid var(--dvw-border-soft);display:flex;flex-direction:column;align-items:center;/* 底部留出 DSH 侧栏按钮的高度。DSH 侧栏宽 280、盖在活动栏（0-48）之上，它自己的设置按钮
   横向从 x=10 起、纵向在 y 948-990；活动栏底部的 home 与设置按钮若不抬高，会与它叠成两个图标。 */
padding-bottom:56px}.dvw-act{width:40px;height:40px;margin:4px 0;border:0;border-radius:var(--dvw-radius-sm);background:transparent;color:var(--dvw-text-3);font-size:20px;cursor:pointer}.dvw-act:hover{background:var(--dvw-hover);color:var(--dvw-text)}.dvw-act[data-active=true]{background:var(--dvw-nav-active);color:var(--dvw-text)}.dvw-act.dsh{margin-top:auto}.dvw-side{grid-column:2;grid-row:1/3;min-width:0;width:100%;background:var(--dvw-sidebar-fill);border-right:1px solid var(--dvw-border);display:flex;flex-direction:column}
.dvw-side-head{height:36px;display:flex;align-items:center;padding:0 12px;font-size:12px;color:var(--dvw-text-2)}.dvw-toolbar{margin-left:auto;display:flex;gap:2px}.dvw-icon{border:0;background:transparent;color:var(--dvw-text-2);border-radius:var(--dvw-radius-xs);min-width:24px;height:24px;display:inline-grid;place-items:center;cursor:pointer}.dvw-icon:hover{background:var(--dvw-hover);color:var(--dvw-text)}.dvw-icon:disabled{opacity:.45;cursor:default}.dvw-file-picker{display:none}.dvw-tree,.dvw-results,.dvw-git{overflow:auto;flex:1}.dvw-tree[data-drop-target=true]{outline:1px dashed var(--dvw-accent);outline-offset:-3px}.dvw-tree-row{display:flex;align-items:center;height:24px;padding-right:6px;cursor:pointer;white-space:nowrap}.dvw-tree-row:hover{background-color:var(--dvw-hover)}.dvw-tree-row[data-selected=true],.dvw-tree-row[data-drop-target=true]{background-color:var(--dvw-active)}.dvw-chevron{width:16px;flex:none;text-align:center;color:var(--dvw-text-3)}.dvw-file-icon{width:18px;flex:none;color:var(--dvw-text-2)}.dvw-file-icon.folder{color:var(--dvw-accent)}.dvw-tree-name{overflow:hidden;text-overflow:ellipsis}.dvw-tree-rename,.dvw-tree-create-input{min-width:0;flex:1;height:20px;border:1px solid var(--dvw-accent);border-radius:0;background:var(--dvw-surface-1);color:var(--dvw-text);padding:0 3px;font:inherit;letter-spacing:0;outline:0}.dvw-tree-create-row{cursor:text}.dvw-tree-create-row:hover{background-color:transparent}.dvw-tree-create-input::placeholder{color:var(--dvw-text-3)}.dvw-tree-create-input[aria-invalid=true]{border-color:var(--dvw-error)}.dvw-tree-create-error{min-height:20px;padding-top:2px;padding-right:6px;padding-bottom:3px;color:var(--dvw-error);font-size:11px;line-height:15px;white-space:normal;overflow-wrap:anywhere}.dvw-tree-status{width:6px;height:6px;margin-left:auto;flex:none;border-radius:50%;background:var(--dvw-warn)}.dvw-tree-status[data-status=M]{background:var(--dvw-warn)}.dvw-tree-status[data-status=A]{background:var(--dvw-success)}.dvw-tree-status[data-status=D]{background:var(--dvw-error)}.dvw-tree-dirty{width:6px;height:6px;margin-right:5px;flex:none;border-radius:50%;background:var(--dvw-text-3)}.dvw-tree-status[data-status=D]{color:var(--dvw-error)}/* 统一右键菜单（资源管理器 / 标签页 / 终端 / 编辑器扩展项都走这里，见 ContextMenu.tsx）。
   z-index 取 200：菜单 portal 到 body，必须盖过工作台 overlay（z-index:100），又要低于 DSH 的设置面板（1000）。 */
.dvw-menu{position:fixed;z-index:200;font:13px/1.4 var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);color:var(--dvw-text);min-width:208px;max-width:340px;max-height:min(70vh,560px);overflow:auto;padding:4px;border:1px solid var(--dvw-border);border-radius:var(--dvw-radius-sm);background:var(--dvw-surface-3);box-shadow:var(--dvw-shadow-3);outline:none}
.dvw-menu-item{display:flex;align-items:center;gap:8px;width:100%;height:28px;padding:0 8px;border:0;border-radius:var(--dvw-radius-xs);background:transparent;color:var(--dvw-text);font:inherit;text-align:left;cursor:pointer}
.dvw-menu-item[data-active=true]{background:var(--dvw-active)}
.dvw-menu-item[aria-disabled=true]{opacity:.45;cursor:default}
.dvw-menu-item[data-danger=true]{color:var(--dvw-error)}


.dvw-menu-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dvw-menu-shortcut{flex:none;color:var(--dvw-text-3);font-size:11px;letter-spacing:.02em}
/* 带子菜单的父项：shortcut 之后再来一个 chevron-right，提示「这一项还有下一级」。
   宽度固定 12px，父项不会因为有没有箭头而左右抖动。 */
.dvw-menu-arrow{flex:none;width:12px;display:grid;place-items:center;color:var(--dvw-text-3);font-size:12px}
/* 子菜单：位置由 clampSubmenuPosition 按父项矩形算好（右侧优先、放不下翻左），
   这里只补滚动兜底 —— 项特别多时 max-height 让它自己滚，绝不把整页撑出视口。 */
.dvw-submenu{max-height:min(70vh,560px);overflow:auto}
.dvw-menu-separator{height:1px;margin:4px 6px;background:var(--dvw-border-soft)}
.dvw-main{grid-column:3;grid-row:1;display:flex;min-width:0;min-height:0;flex-direction:column;background:var(--dvw-base)}.dvw-tabs{height:36px;background:var(--dvw-sidebar-fill);display:flex;overflow-x:auto}.dvw-tab{height:36px;min-width:110px;max-width:260px;border:0;border-right:1px solid var(--dvw-border-soft);background:transparent;color:var(--dvw-text-2);padding:0 8px 0 12px;display:flex;align-items:center;gap:8px;cursor:pointer}.dvw-tab[data-active=true]{background:var(--dvw-base);color:var(--dvw-text)}.dvw-tab-name{overflow:hidden;text-overflow:ellipsis;flex:1;text-align:left}.dvw-editor{position:relative;flex:1;min-height:0}.dvw-editor .monaco-editor,.dvw-editor .monaco-editor.focused{outline:none!important}.dvw-editor-toolbar{position:absolute;z-index:3;top:0;right:0;left:0;height:36px;display:flex;align-items:center;justify-content:flex-end;gap:4px;padding:0 10px;border-bottom:1px solid var(--dvw-border-soft);background:var(--dvw-base)}.dvw-editor-body{position:absolute;inset:0;min-height:0}.dvw-editor-body[data-toolbar=true]{top:36px}.dvw-mode-button{height:27px;padding:0 10px;display:flex;align-items:center;gap:6px;border:1px solid transparent;border-radius:var(--dvw-radius-xs);background:transparent;color:var(--dvw-text-2);cursor:pointer}.dvw-mode-button:hover{background:var(--dvw-hover)}.dvw-mode-button[data-active=true]{border-color:var(--dvw-border);background:var(--dvw-active);color:var(--dvw-text)}.dvw-empty{height:100%;display:grid;place-items:center;color:var(--dvw-text-3);text-align:center}.dvw-empty strong{font-size:24px;color:var(--dvw-text-2)}.dvw-message{padding:12px;color:var(--dvw-warn)}.dvw-editor-prompt{position:absolute;inset:0;display:grid;place-content:center;justify-items:center;gap:12px;padding:24px;color:var(--dvw-text-2);text-align:center}.dvw-editor-prompt strong{font-size:15px;font-weight:600;color:var(--dvw-text)}.dvw-editor-prompt .dvw-editor-prompt-note{font-size:12px;color:var(--dvw-text-3)}.dvw-tabs{overflow:hidden}
.dvw-bottom{grid-column:3;grid-row:2;height:260px;min-height:120px;border-top:1px solid var(--dvw-border);background:var(--dvw-base);display:flex;flex-direction:column}.dvw-bottom-head{height:35px;display:flex;align-items:center;gap:6px;padding:0 6px 0 0;border-bottom:1px solid var(--dvw-border)}.dvw-bottom-body{flex:1;min-height:0}.dvw-status{grid-column:1/4;grid-row:3;background:var(--dvw-sidebar-fill);color:var(--dvw-text-2);border-top:1px solid var(--dvw-border);display:flex;align-items:center;padding:0 12px;gap:18px;font-size:12px}
.dvw-search-form{padding:10px;display:grid;gap:8px}.dvw-input{width:100%;border:1px solid var(--dvw-border);border-radius:var(--dvw-radius-sm);background:var(--dvw-surface-2);color:var(--dvw-text);padding:6px 10px;outline:none}.dvw-input:focus{border-color:var(--dvw-accent)}.dvw-options{display:flex;align-items:center;gap:8px;font-size:12px}.dvw-result-file{padding:5px 8px;font-weight:600}.dvw-result{padding:4px 8px 4px 20px;cursor:pointer;display:flex;gap:8px}.dvw-result:hover{background:var(--dvw-hover)}.dvw-line{color:var(--dvw-text-3);min-width:30px;text-align:right}.dvw-preview{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dvw-git-head{padding:7px 10px;border-bottom:1px solid var(--dvw-border);display:flex;align-items:center;gap:8px}.dvw-branch{min-width:0;border:0;background:transparent;color:var(--dvw-text);font:inherit;font-weight:600;display:flex;align-items:center;gap:5px;cursor:pointer}.dvw-commit{display:grid;grid-template-columns:1fr auto;gap:6px;padding:9px}.dvw-commit .dvw-input{grid-column:1/3}.dvw-commit-button{grid-column:1/3;height:31px;border:0;border-radius:var(--dvw-radius-sm);background:color-mix(in srgb,var(--dvw-accent) 24%,var(--dvw-surface-2));color:var(--dvw-text);display:flex;align-items:center;justify-content:center;gap:7px;cursor:pointer}.dvw-commit-button:hover{background:color-mix(in srgb,var(--dvw-accent) 34%,var(--dvw-surface-2))}.dvw-commit-button:disabled{opacity:.45;cursor:default}.dvw-group-head{height:30px;display:flex;align-items:center;gap:5px;padding:0 6px 0 9px;border-radius:var(--dvw-radius-xs);font-weight:600;position:sticky;top:0;background:var(--dvw-surface-1);z-index:1}.dvw-group-head:hover{background:var(--dvw-hover)}.dvw-group-head .dvw-count{margin-left:auto;min-width:20px;height:20px;border-radius:var(--dvw-radius-md);display:grid;place-items:center;background:var(--dvw-surface-3);color:var(--dvw-text-2);font-size:11px}.dvw-change{display:flex;align-items:center;min-height:28px;padding:3px 5px 3px 19px;gap:5px;cursor:pointer}.dvw-change:hover{background:var(--dvw-hover)}.dvw-change .dvw-icon{opacity:0}.dvw-change:hover .dvw-icon,.dvw-change:focus-within .dvw-icon{opacity:1}.dvw-change-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.dvw-badge{font-size:11px;color:var(--dvw-warn)}.dvw-graph{border-top:1px solid var(--dvw-border-soft);margin-top:8px;padding-top:3px}.dvw-graph-list{padding-bottom:8px}.dvw-graph-row{width:100%;height:38px;border:0;background:transparent;color:var(--dvw-text);display:flex;align-items:center;padding:0 7px;text-align:left;cursor:pointer;overflow:hidden}.dvw-graph-row:hover{background:var(--dvw-hover)}.dvw-graph-svg{flex:none;align-self:stretch}.dvw-graph-copy{display:flex;min-width:0;flex:1;flex-direction:column;justify-content:center}.dvw-graph-subject{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dvw-graph-meta{font-size:11px;color:var(--dvw-text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dvw-ref{max-width:82px;margin-left:4px;padding:1px 5px;border:1px solid color-mix(in srgb,var(--dvw-accent) 50%,transparent);border-radius:var(--dvw-radius-sm);color:var(--dvw-accent);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dvw-error{padding:8px;color:var(--dvw-error);white-space:pre-wrap}.dvw-diff{margin:0;height:100%;overflow:auto;padding:8px 0;background:var(--dvw-surface-1);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre}
.dvw-tabs{overflow:hidden}.dvw-tab[data-pinned] .dvw-tab-name{font-style:normal}.dvw-tab:not([data-pinned]) .dvw-tab-name{font-style:italic}.dvw-tab-list{display:flex;min-width:0;flex:1;overflow-x:auto}.dvw-tab-actions{flex:none;display:flex;align-items:center;gap:2px;padding:0 6px;background:var(--dvw-sidebar-fill)}.dvw-close-all{border:1px solid var(--dvw-border);background:transparent}.dvw-chat-action[data-active]{background:var(--dvw-active);color:var(--dvw-text)}.dvw-chat-action .codicon{-webkit-text-stroke:.35px currentColor}
/* 资源管理器的彩色类型图标（material-icon-theme 的 SVG）。尺寸与 codicon 的 .dvw-file-icon 对齐。 */
.dvw-file-icon-img{flex:none;width:16px;height:16px;object-fit:contain;pointer-events:none}
/* 设置页（DSH 设置导航里的一个 section）。颜色一律取 --dsw-alias-* 令牌，不写死色值。
   字号与行距照 DSH 设置页的规格统一：行标题 14px/20px、说明 12px/18px（label-secondary）、
   行 padding 14px、分隔线 .5px；控件里的文字同样 14px —— 早前输入框/步进器比标签大一号，
   整页看起来「有的字变大了」，这里不再出现两套比例。 */
.dvw-settings-panel{display:flex;flex-direction:column;gap:24px;padding:4px 2px 20px}
.dvw-set-group{display:flex;flex-direction:column}
.dvw-set-group-title{margin:0 0 2px;font-size:14px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}
.dvw-set-row{display:flex;align-items:center;gap:24px;padding:14px 2px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dvw-set-row:last-child{border-bottom:0}
.dvw-set-text{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.dvw-set-title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px}
.dvw-set-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dvw-set-control{flex:none;display:flex;align-items:center;gap:8px}
/* 开关按 DSH 设置页的真实规格：36×20、radius 999px；开启时轨道取前景色、圆钮取底色（反色），
   关闭时轨道为 16% 前景色、圆钮为三级文字色。那些 class 是 CSS Module 哈希，只能照规格重画。 */
.dvw-set-switch{position:relative;flex:none;width:36px;height:20px;border:0;border-radius:999px;padding:0;cursor:pointer;background:var(--dsw-alias-label-primary);transition:background .12s}
.dvw-set-switch[aria-checked=false]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent)}
.dvw-set-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .12s,background .12s}
.dvw-set-switch[aria-checked=true] .dvw-set-knob{transform:translateX(16px)}
.dvw-set-switch[aria-checked=false] .dvw-set-knob{background:var(--dsw-alias-label-tertiary);transform:none}
/* 数值调节：DSH 用步进器而不是滑块。72×36、radius 12px、底色 bg-layer-3；箭头默认透明、悬停才显形。 */
.dvw-set-stepper{flex:none;display:flex;align-items:center;justify-content:space-between;width:72px;height:36px;padding:0 8px;border-radius:12px;background:var(--dsw-alias-bg-layer-3)}
.dvw-set-value{font-size:14px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.dvw-set-arrows{display:flex;flex-direction:column;gap:2px;opacity:0;transition:opacity .12s}
.dvw-set-stepper:hover .dvw-set-arrows,.dvw-set-stepper:focus-within .dvw-set-arrows{opacity:1}
.dvw-set-arrow{display:grid;place-items:center;width:14px;height:14px;border:0;padding:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dvw-set-arrow:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dvw-set-arrow:disabled{opacity:.4;cursor:default}
.dvw-set-unit{color:var(--dsw-alias-label-secondary);font-size:14px}
/* 设置页里的补充控件：整行文本输入、只读信息行、键帽、页脚说明。
   开关与步进器的规格见上；这几样 DSH 设置页里没有直接对应的控件，按同一套令牌与圆角重画。 */
.dvw-set-row-stack{flex-direction:column;align-items:stretch;gap:8px;padding-top:12px;padding-bottom:12px}
.dvw-set-input{width:100%;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4,#4a4a4d);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;outline:none}
.dvw-set-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dvw-set-input:focus{border-color:var(--dsw-alias-state-business-primary)}
.dvw-set-input:disabled{opacity:.5;cursor:not-allowed}
.dvw-set-switch:disabled{opacity:.45;cursor:not-allowed}
/* 下拉与按钮：与输入框同一套规格（32px 高、14px 字号、DSH 的 .5px 边框与 bg-layer-1 底色）。
   它们原先只在左侧子菜单那版样式里定义，去掉子菜单时一并挪到这里，页面不再有两套控件比例。 */
.dvw-set-select{height:32px;max-width:240px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4,#4a4a4d);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer;outline:none}
.dvw-set-select:focus{border-color:var(--dsw-alias-state-business-primary)}
.dvw-set-select:disabled{opacity:.5;cursor:not-allowed}
.dvw-set-button{height:32px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l4,#4a4a4d);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;white-space:nowrap;cursor:pointer}
.dvw-set-button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dvw-set-button:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary,#3b82f6);outline-offset:1px}
.dvw-set-button-secondary{background:transparent;color:var(--dsw-alias-label-secondary)}
.dvw-set-button-danger{border-color:var(--dsw-alias-state-error-primary,#f48771);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f48771) 16%,transparent);color:var(--dsw-alias-state-error-primary,#f48771)}
.dvw-set-button-danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f48771) 26%,transparent)}
.dvw-set-stepper[data-disabled=true]{opacity:.5}
.dvw-set-info{display:flex;gap:10px;padding:4px 2px;font-size:12px;line-height:1.5}
.dvw-set-info-label{flex:none;color:var(--dsw-alias-label-tertiary)}
.dvw-set-info-value{min-width:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dvw-set-info[data-tone=warn] .dvw-set-info-value{color:var(--dsw-alias-state-warn-primary,#d7ba7d)}
.dvw-set-info[data-tone=error] .dvw-set-info-value{color:var(--dsw-alias-state-error-primary,#f48771)}
.dvw-set-keycap{display:inline-block;min-width:22px;padding:1px 6px;border:1px solid var(--dsw-alias-border-l2);border-bottom-width:2px;border-radius:6px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-align:center}
.dvw-set-footnote{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6}
/* 侧栏面板行：图标占一个正常 flex 位，命中层另用绝对定位铺满整行并在冒泡阶段吃掉点击，
   避免 DSH 把主区域切到空面板（那会卸载整个会话视图，是打开工作台时整屏卡顿的来源）。 */
.dvw-panel-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px}
.dvw-panel-hit{position:absolute;inset:0;z-index:1;cursor:pointer;border-radius:inherit}.dvw-monaco-diff{position:absolute;inset:0}.dvw-diff-toolbar{justify-content:flex-end}.dvw-group-head{gap:2px;padding-left:2px}.dvw-group-toggle{min-width:0;height:30px;flex:1;border:0;border-radius:var(--dvw-radius-xs);background:transparent;color:var(--dvw-text);font:inherit;font-weight:600;display:flex;align-items:center;gap:5px;padding:0 7px;cursor:pointer;text-align:left}.dvw-group-toggle:hover{background:var(--dvw-hover)}.dvw-graph-entry[data-expanded=true]{background:color-mix(in srgb,var(--dvw-accent) 5%,transparent)}.dvw-commit-files{padding:1px 0 5px 26px}.dvw-commit-file{width:100%;height:27px;border:0;background:transparent;color:var(--dvw-text);display:flex;align-items:center;gap:6px;padding:0 7px;text-align:left;cursor:pointer}.dvw-commit-file:hover{background:var(--dvw-hover)}.dvw-commit-file-name{white-space:nowrap}.dvw-commit-file-dir{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dvw-text-3);font-size:11px}
.dvw-outline{flex:none;max-height:38%;display:flex;flex-direction:column;border-bottom:1px solid var(--dvw-border)}.dvw-outline-head{height:30px;display:flex;align-items:center;justify-content:space-between;padding:0 5px 0 10px;font-weight:600}.dvw-outline-head>span{display:flex;align-items:center;gap:6px}.dvw-outline-list{overflow:auto;padding-bottom:5px}.dvw-outline-item{display:block;width:100%;height:25px;border:0;background:transparent;color:var(--dvw-text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;cursor:pointer}.dvw-outline-item:hover{background:var(--dvw-hover);color:var(--dvw-text)}.dvw-image-preview{position:absolute;inset:0;overflow:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;background:repeating-conic-gradient(var(--dvw-surface-2) 0 25%,var(--dvw-surface-1) 0 50%) 0/20px 20px}.dvw-image-preview img{max-width:100%;max-height:calc(100% - 32px);object-fit:contain;box-shadow:var(--dvw-shadow-3)}.dvw-image-preview span{max-width:100%;padding:3px 8px;border-radius:var(--dvw-radius-xs);background:var(--dvw-surface-1);color:var(--dvw-text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dvw-pdf-preview{position:absolute;inset:0;display:flex;min-height:0;flex-direction:column;background:var(--dvw-base);color:var(--dvw-text)}.dvw-pdf-toolbar{height:30px;flex:none;display:flex;align-items:center;justify-content:center;gap:2px;padding:0 8px;border-bottom:1px solid var(--dvw-border);background:var(--dvw-surface-1);font-variant-numeric:tabular-nums}.dvw-pdf-toolbar .dvw-icon{font-size:18px}.dvw-pdf-zoom{min-width:52px;height:24px;border:0;border-radius:var(--dvw-radius-xs);background:var(--dvw-active);color:var(--dvw-text);font:inherit;cursor:pointer}.dvw-pdf-zoom:hover{background:var(--dvw-hover)}.dvw-pdf-separator{width:1px;height:18px;margin:0 4px;background:var(--dvw-border)}.dvw-pdf-page{min-height:0;flex:1;overflow:auto;display:flex;justify-content:center;padding:8px;background:var(--dvw-base)}.dvw-pdf-page canvas{flex:none;background:#fff;box-shadow:var(--dvw-shadow-2)}.dvw-docx-preview{position:absolute;inset:0;overflow:auto;padding:28px;background:var(--dvw-base);color:var(--dvw-text)}
/* Word 文档自带白底黑字的排版，放进深色主题时必须给它自己的纸面底色与文字色，
   否则黑字落在深色底上几乎看不见。docx-preview 调用时传的是 inWrapper:false
   （见 documentPreview.tsx），它直接产出 section.docx、不生成 .docx-wrapper —— 而原先只给
   wrapper 加白底，那条规则永远命中不了。两种形态都写上，将来改了调用参数也不会退化。 */
.dvw-docx-preview .docx-wrapper,.dvw-docx-preview>section.docx{width:auto;max-width:100%;margin:auto;background:#fff;color:#000;box-shadow:var(--dvw-shadow-2)}
.dvw-docx-preview>section.docx{padding:32px}
.dvw-document-error,.dvw-document-download{height:100%;display:grid;place-content:center;justify-items:center;gap:12px;padding:24px;color:var(--dvw-text-2);text-align:center}.dvw-document-download a{color:var(--dvw-accent);text-decoration:none}.dvw-document-download a:hover{text-decoration:underline}
.dvw-markdown{height:100%;overflow:auto;padding:28px clamp(24px,6vw,80px) 60px;color:var(--dvw-text);font-size:15px;line-height:1.65}.dvw-markdown>*:first-child{margin-top:0}.dvw-markdown h1,.dvw-markdown h2{padding-bottom:.3em;border-bottom:1px solid var(--dvw-border)}.dvw-markdown h1{font-size:2em}.dvw-markdown h2{font-size:1.5em}.dvw-markdown h3{font-size:1.25em}.dvw-markdown a{color:var(--dvw-accent)}.dvw-markdown code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--dvw-surface-2);border-radius:var(--dvw-radius-xs);padding:.15em .35em}.dvw-markdown pre{overflow:auto;padding:14px;border:1px solid var(--dvw-border-soft);border-radius:var(--dvw-radius-sm);background:var(--dvw-base)}.dvw-markdown pre code{padding:0;background:transparent}.dvw-markdown blockquote{margin-left:0;padding-left:14px;border-left:3px solid var(--dvw-border);color:var(--dvw-text-2)}.dvw-markdown table{border-collapse:collapse;display:block;overflow:auto}.dvw-markdown th,.dvw-markdown td{padding:6px 12px;border:1px solid var(--dvw-border)}.dvw-markdown tr:nth-child(2n){background:var(--dvw-hover)}.dvw-markdown img{max-width:100%}.dvw-markdown hr{border:0;border-top:1px solid var(--dvw-border)}
.dvw-outline-toggle{margin-right:auto}.dvw-outline-toggle[data-active=true]{background:var(--dvw-active);color:var(--dvw-text)}.dvw-editor-outline{position:absolute;z-index:2;top:36px;bottom:0;left:0;width:240px;max-height:none;background:var(--dvw-surface-1);border-right:1px solid var(--dvw-border);border-bottom:0}.dvw-editor[data-outline=true] .dvw-editor-body{left:240px}.dvw-diff-preview-switch{margin-right:auto;display:flex;gap:4px}.dvw-commit-files{position:relative;padding-top:1px;padding-right:0;padding-bottom:5px}.dvw-graph-continuation{position:absolute;top:0;bottom:0;left:7px;height:100%;pointer-events:none}.dvw-commit-file-list{position:relative;min-width:0}.dvw-overlay button:focus-visible,.dvw-overlay input:focus-visible,.dvw-overlay select:focus-visible{outline:1px solid var(--dvw-accent);outline-offset:-1px}@media(max-width:800px){.dvw-overlay{grid-template-columns:44px var(--dvw-side-width) minmax(0,1fr)}.dvw-editor-outline{width:210px}.dvw-editor[data-outline=true] .dvw-editor-body{left:210px}}
.dvw-overlay[data-dvw-chat=true]{grid-template-columns:48px var(--dvw-side-width) minmax(0,1fr) var(--dvw-chat-width)}
.dvw-overlay:not([data-dvw-primary-side=true]){grid-template-columns:48px 0 minmax(0,1fr)}
.dvw-overlay[data-dvw-chat=true]:not([data-dvw-primary-side=true]){grid-template-columns:48px 0 minmax(0,1fr) var(--dvw-chat-width)}
.dvw-overlay:not([data-dvw-primary-side=true]) .dvw-side{visibility:hidden;border-right:0}
.dvw-overlay[data-dvw-chat=true] .dvw-status{grid-column:1/-1;padding-right:calc(var(--dvw-chat-width) + 8px)}
.dvw-chat{grid-column:4;grid-row:1/3;min-width:0;background:var(--dvw-base);border-left:1px solid var(--dvw-border);position:relative}
.dvw-chat-head{height:36px;display:flex;align-items:center;justify-content:space-between;padding:0 6px 0 12px;border-bottom:1px solid var(--dvw-border);background:var(--dvw-base);font-weight:600}
.dvw-chat-head>span{display:flex;align-items:center;gap:7px}.dvw-chat-body{height:calc(100% - 36px);background:var(--dvw-base)}
.dvw-dsh-mark{display:block}
/**
 * 侧栏与对话栏的缩放条。
 *
 * DSH 自己的缩放条只在悬停时改变鼠标样式，不做任何视觉反馈；这里保持一致 ——
 * 命中区做宽是为了好抓，但完全透明、也没有高亮：悬停、聚焦、拖动都不出现蓝色扩散。
 * 视觉上的分隔线由 .dvw-side / .dvw-chat 自身的 border 提供，缩放条不再画第二根线。
 */
.dvw-side-resizer,.dvw-chat-resizer{width:10px;cursor:ew-resize;touch-action:none;background:transparent}
.dvw-side-resizer{position:relative;grid-column:2;grid-row:1/3;justify-self:end;height:100%;z-index:22;transform:translateX(5px)}
.dvw-chat-resizer{position:fixed;top:36px;bottom:0;right:calc(var(--dvw-chat-width) - 5px);z-index:22}
[data-windows-titlebar] .dvw-chat-resizer{top:calc(36px + var(--dsh-windows-titlebar-height,0px))}
.dvw-overlay:not([data-dvw-primary-side=true]) .dvw-side-resizer{display:none}
/* 对话栏开关已移入标签栏操作区（.dvw-chat-action），原先右上角的浮动按钮与其预留空间已移除。 */
[data-dvw-conversation-panel]{position:fixed!important;top:36px!important;right:0!important;bottom:var(--dvw-status-height,24px)!important;left:auto!important;width:var(--dvw-chat-width)!important;height:auto!important;min-width:0!important;z-index:21!important;border-left:1px solid var(--dsw-alias-border-l2)!important;box-shadow:none!important}
.dvw-confirm-backdrop{position:fixed;z-index:50;inset:0;display:grid;place-items:center;padding:24px;background:var(--dvw-mask)}.dvw-confirm{width:min(380px,calc(100vw - 48px));border:1px solid var(--dvw-border);border-radius:var(--dvw-radius-md);background:var(--dvw-surface-1);box-shadow:var(--dvw-shadow-3);padding:18px}.dvw-confirm h2{margin:0 0 12px;font-size:15px}.dvw-confirm p{margin:0;color:var(--dvw-text)}.dvw-confirm-note{margin-top:8px!important;color:var(--dvw-text-3)!important;font-size:12px}.dvw-confirm footer{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}.dvw-confirm footer button{height:28px;border:1px solid var(--dvw-border);border-radius:var(--dvw-radius-xs);background:var(--dvw-surface-2);color:var(--dvw-text);padding:0 12px;font:inherit;cursor:pointer}.dvw-confirm footer button:hover{background:var(--dvw-hover)}.dvw-confirm footer .dvw-danger-button{border-color:color-mix(in srgb,var(--dvw-error) 65%,var(--dvw-border));background:var(--dvw-error);color:#fff}.dvw-confirm footer .dvw-danger-button:hover{background:color-mix(in srgb,var(--dvw-error) 82%,#000)}
.dvw-tree[data-dvw-native-drop-target=true]{outline:1px dashed var(--dvw-accent);outline-offset:-3px}.dvw-tree-row[data-dvw-native-drop-target=true]{background:var(--dvw-active)}
.dvw-act:disabled{opacity:.4;cursor:not-allowed}
.dvw-terminal-root{height:100%;display:flex;flex-direction:column;background:var(--dvw-base);color:var(--dvw-text)}.dvw-terminal-tabs{height:28px;display:flex;align-items:center;padding:0 8px;gap:3px;border-bottom:1px solid var(--dvw-border-soft)}.dvw-terminal-tab{height:24px;max-width:180px;border:0;background:transparent;color:var(--dvw-text-2);padding:0 9px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dvw-terminal-tab[data-active=true]{color:var(--dvw-text);background:var(--dvw-active)}.dvw-terminal-host{position:relative;flex:1;min-height:0;padding:5px 8px;background:var(--dvw-base)}.dvw-terminal-host .xterm{height:100%;position:relative;user-select:none}.dvw-terminal-host .xterm.focus,.dvw-terminal-host .xterm:focus{outline:none}.dvw-terminal-host .xterm-viewport{position:absolute;inset:0;overflow-y:scroll;background-color:transparent}.dvw-terminal-host .xterm-screen{position:relative}.dvw-terminal-host .xterm-helpers{position:absolute;top:0;z-index:5}.dvw-terminal-host .xterm-helper-textarea{position:absolute;opacity:0;left:-9999em;top:0;width:0;height:0;z-index:-5;white-space:nowrap;overflow:hidden;resize:none}.dvw-terminal-host .composition-view{background:var(--dvw-base);color:var(--dvw-text);display:none;position:absolute;white-space:nowrap;z-index:1}.dvw-terminal-host .composition-view.active{display:block}.dvw-terminal-host .xterm-char-measure-element{display:inline-block;visibility:hidden;position:absolute;left:-9999em;line-height:normal}.dvw-terminal-host .xterm-cursor-pointer,.dvw-terminal-host .xterm .xterm-cursor-pointer{cursor:pointer}.dvw-terminal-host .xterm-accessibility,.dvw-terminal-host .xterm-message{position:absolute;inset:0;z-index:10;color:transparent;pointer-events:none}.dvw-terminal-host .xterm-accessibility-tree{position:absolute;left:0;top:0;width:100%}.dvw-terminal-host .xterm-accessibility-tree>div{position:absolute;transform-origin:top left}.dvw-terminal-host canvas{position:absolute;left:0;top:0}.dvw-terminal-error{padding:8px;color:var(--dvw-error)}
.dvw-terminal-tabs{height:34px;padding:0 10px;gap:2px;background:var(--dvw-surface-1)}.dvw-terminal-tab{height:28px;display:flex;align-items:center;gap:6px;border-radius:var(--dvw-radius-xs);padding:0 10px;font:inherit}.dvw-terminal-tab .codicon{font-size:14px}.dvw-terminal-tab[data-active=true]{box-shadow:inset 0 1px 0 var(--dvw-accent)}.dvw-terminal-host{padding:0 6px;background:var(--dsw-alias-markdown-code-block,var(--dvw-base))}
.dvw-terminal-root{flex-direction:row}.dvw-terminal-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column}.dvw-terminal-main>.dvw-terminal-host{flex:1;min-height:0}.dvw-terminal-tabs{width:220px;height:auto;flex:none;display:flex;flex-direction:column;align-items:stretch;padding:0;border-left:1px solid var(--dvw-border);border-bottom:0;background:var(--dvw-base)}.dvw-terminal-list{min-height:0;overflow:auto;padding:6px}.dvw-terminal-tab{width:auto;max-width:calc(100% - 56px);justify-content:flex-start;height:30px;border-radius:var(--dvw-radius-sm);padding:0 6px 0 10px;color:var(--dvw-text-2);transition:background .1s}
.dvw-terminal-rename{width:100%;min-width:0;height:22px;border:1px solid var(--dvw-accent);border-radius:var(--dvw-radius-xs);background:var(--dvw-base);color:var(--dvw-text);padding:0 4px;font:inherit;outline:0}.dvw-terminal-menu{position:fixed;z-index:60;min-width:140px;padding:4px;border:1px solid var(--dvw-border);border-radius:var(--dvw-radius-sm);background:var(--dvw-surface-3);box-shadow:var(--dvw-shadow-3)}.dvw-terminal-menu button{display:block;width:100%;height:28px;border:0;border-radius:var(--dvw-radius-xs);background:transparent;color:var(--dvw-text);padding:0 10px;text-align:left;font:inherit;cursor:pointer}.dvw-terminal-menu button:hover{background:var(--dvw-hover)}.dvw-terminal-new{position:relative;display:inline-flex;align-items:center;height:24px;border-radius:var(--dvw-radius-xs)}.dvw-terminal-new:hover{background:var(--dvw-hover)}.dvw-terminal-new:has(.dvw-terminal-new-more[aria-expanded=true]){background:var(--dvw-active)}.dvw-terminal-new-main,.dvw-terminal-new-more{height:100%;border:0;background:transparent;color:var(--dvw-text-2);display:grid;place-items:center;cursor:pointer;font:inherit;padding:0;border-radius:var(--dvw-radius-xs)}.dvw-terminal-new-main:hover,.dvw-terminal-new-more:hover{background:var(--dvw-active)}.dvw-terminal-new:hover .dvw-terminal-new-main,.dvw-terminal-new:hover .dvw-terminal-new-more{color:var(--dvw-text)}.dvw-terminal-new-main{width:16px}.dvw-terminal-new-more{width:14px}.dvw-terminal-new-plus,.dvw-terminal-new-chevron{display:block}.dvw-terminal-menu.dvw-terminal-new-menu{position:absolute;top:calc(100% + 4px);left:0;min-width:200px}.dvw-terminal-menu .dvw-terminal-menu-sep{height:1px;margin:4px 0;background:var(--dvw-border-soft)}.dvw-terminal-menu button:disabled{opacity:.5;cursor:default}.dvw-terminal-menu button:disabled:hover{background:transparent}
.dvw-terminal-panes{flex:1;min-height:0;display:flex}.dvw-terminal-panes>.dvw-terminal-host{flex:1;min-width:0}.dvw-terminal-panes[data-split=true]>.dvw-terminal-host:not([hidden])+.dvw-terminal-host:not([hidden]){border-left:1px solid var(--dvw-border)}.dvw-terminal-empty{flex:1;display:grid;place-items:center;color:var(--dvw-text-3)}.dvw-terminal-host[hidden]{display:none}.dvw-terminal-pending{flex:1;display:grid;place-items:center;color:var(--dvw-text-3);font-size:12px}.dvw-terminal-resizer{width:4px;flex:none;cursor:ew-resize;position:relative;z-index:1;background:var(--dsw-alias-markdown-code-block,var(--dvw-base))}.dvw-terminal-entry{position:relative;display:flex;align-items:center;min-width:0;margin-bottom:2px;border-radius:var(--dvw-radius-sm);cursor:default;overflow:hidden}.dvw-terminal-entry:hover{background:var(--dvw-surface-2)}.dvw-terminal-entry[data-active=true]{background:var(--dvw-surface-3)}.dvw-terminal-entry-actions{position:absolute;right:0;top:0;bottom:0;display:none;align-items:stretch}.dvw-terminal-entry:hover .dvw-terminal-entry-actions,.dvw-terminal-entry:focus-within .dvw-terminal-entry-actions{display:flex}.dvw-terminal-entry-actions button{width:28px;display:grid;place-items:center;border:0;background:transparent;color:var(--dvw-text-2);cursor:pointer}.dvw-terminal-entry-actions button:hover{background:var(--dvw-hover);color:var(--dvw-text)}
.dvw-terminal-list,.dvw-terminal-host .xterm-viewport{scrollbar-width:none}.dvw-terminal-list::-webkit-scrollbar,.dvw-terminal-host .xterm-viewport::-webkit-scrollbar{display:none}
.dvw-bottom-headslot{align-self:stretch;display:flex;align-items:stretch;min-width:0}.dvw-bottom-tabs{display:flex;align-items:stretch;min-width:0;height:100%;overflow-x:auto;scrollbar-width:none}.dvw-bottom-tabs::-webkit-scrollbar{display:none}.dvw-bottom-tab{display:inline-flex;align-items:center;flex:none;height:100%;max-width:200px;color:var(--dvw-text-2)}.dvw-bottom-tab:hover{background:var(--dvw-hover)}.dvw-bottom-tab[data-active=true]{background:var(--dsw-alias-markdown-code-block,var(--dvw-base));color:var(--dvw-text);box-shadow:0 1px 0 var(--dsw-alias-markdown-code-block,var(--dvw-base))}.dvw-bottom-tab-label{display:flex;align-items:center;gap:5px;min-width:0;height:100%;border:0;background:transparent;color:inherit;padding:0 4px 0 10px;font:inherit;cursor:pointer}.dvw-bottom-tab-label .codicon{font-size:13px;flex:none}.dvw-bottom-tab-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dvw-bottom-tab-close{width:18px;height:18px;margin-right:4px;flex:none;border:0;border-radius:var(--dvw-radius-xs);background:transparent;color:inherit;display:grid;place-items:center;cursor:pointer;font-size:11px}.dvw-bottom-tab-close:hover{background:var(--dvw-hover);color:var(--dvw-text)}.dvw-bottom-tab-close-icon,.dvw-bottom-tab-close svg{display:block}.dvw-bottom-tab-rename{width:90px;height:20px;border:1px solid var(--dvw-accent);background:var(--dvw-base);color:var(--dvw-text);padding:0 4px;font:inherit;letter-spacing:0;outline:0}






@media(max-width:900px){.dvw-overlay[data-dvw-chat=true]{grid-template-columns:44px min(210px,var(--dvw-side-width)) minmax(0,1fr) min(400px,var(--dvw-chat-width))}[data-dvw-conversation-panel]{width:min(400px,var(--dvw-chat-width))!important}}
/* ---- 搜索面板（对齐 VS Code 搜索视图）----
   搜索框一行：折叠替换 / 输入框（内含清除）/ Aa·ab·.* / 更多选项；替换行与包含排除行各自独立成行。 */
.dvw-search-row{display:flex;align-items:center;gap:6px}
.dvw-search-input{position:relative;flex:1;min-width:0}
.dvw-search-input .dvw-input{padding-right:26px}
.dvw-search-clear{position:absolute;right:2px;top:2px}
.dvw-search-flags{display:flex;align-items:center;gap:2px;flex:none}
.dvw-flag{min-width:22px;height:22px;border:1px solid transparent;border-radius:var(--dvw-radius-xs);background:transparent;color:var(--dvw-text-2);display:inline-grid;place-items:center;padding:0 2px;cursor:pointer}
.dvw-flag:hover{background:var(--dvw-hover);color:var(--dvw-text)}
.dvw-flag[data-active=true]{border-color:var(--dvw-border);background:var(--dvw-active);color:var(--dvw-text)}
.dvw-flag:disabled,.dvw-icon:disabled{opacity:.4;cursor:default}
.dvw-search-toggle{flex:none}
.dvw-search-toggle-spacer{width:24px;flex:none}
.dvw-search-options{display:grid;gap:6px}
.dvw-search-hint{padding:6px 10px;font-size:12px;color:var(--dvw-text-2)}
.dvw-search-hint[data-tone=error]{color:var(--dvw-error)}
.dvw-search-hint[data-tone=warn]{color:var(--dvw-warn)}
.dvw-search-summary{padding:6px 10px;font-size:12px;color:var(--dvw-text-2);border-bottom:1px solid var(--dvw-border-soft)}
/* 进行中的细进度条：搜索结果会把列表整体换掉，需要一条「还在跑」的可见反馈。 */
.dvw-search-progress{height:2px;flex:none;background:var(--dvw-accent);animation:dvw-search-progress 1.1s ease-in-out infinite}
@keyframes dvw-search-progress{0%{transform:scaleX(.08);opacity:.4}50%{transform:scaleX(1);opacity:1}100%{transform:scaleX(.08);opacity:.4}}
.dvw-results{flex:1;min-height:0;overflow:auto;outline:none}
.dvw-results:focus-visible{outline:1px solid var(--dvw-accent);outline-offset:-1px}
.dvw-result-file{width:100%;border:0;background:transparent;color:var(--dvw-text);font:inherit;font-weight:600;display:flex;align-items:center;gap:4px;padding:4px 8px;cursor:pointer;text-align:left}
.dvw-result-file:hover{background:var(--dvw-hover)}
.dvw-result-file:focus-visible{outline:1px solid var(--dvw-accent);outline-offset:-1px}
.dvw-result-name{flex:none;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dvw-result-dir{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dvw-text-3);font-weight:400}
.dvw-count{flex:none;min-width:18px;height:18px;border-radius:var(--dvw-radius-md);display:grid;place-items:center;background:var(--dvw-surface-3);color:var(--dvw-text-2);font-size:11px;font-weight:400}
.dvw-result{align-items:center}
.dvw-result[data-active=true]{background:var(--dvw-active);box-shadow:inset 2px 0 0 var(--dvw-accent)}
.dvw-preview{flex:1;min-width:0}
.dvw-result mark{background:color-mix(in srgb,var(--dvw-warn) 34%,transparent);color:inherit;border-radius:2px}
.dvw-result mark[data-current]{background:color-mix(in srgb,var(--dvw-warn) 82%,transparent);color:var(--dvw-base)}
/* 单条替换按钮只在悬停/聚焦时出现（VS Code 的替换入口同样不占常驻视觉）。 */
.dvw-search-replace-one{flex:none;opacity:0}
.dvw-result:hover .dvw-search-replace-one,.dvw-result:focus-within .dvw-search-replace-one{opacity:1}

/* ---- 源代码管理：分组 ... 菜单 / 提交图引用配色 / 分支选择器 ---- */
.dvw-group-actions{display:flex;align-items:center;gap:2px;flex:none}
.dvw-git-notice{padding:6px 10px;font-size:12px;color:var(--dvw-success);border-bottom:1px solid var(--dvw-border-soft)}
.dvw-graph-empty{padding:14px 10px;color:var(--dvw-text-3);font-size:12px;text-align:center}
.dvw-graph-row[data-head=true]{background:color-mix(in srgb,var(--dvw-accent) 6%,transparent)}
.dvw-ref[data-kind=head]{border-color:color-mix(in srgb,var(--dvw-success) 55%,transparent);color:var(--dvw-success);font-weight:600}
.dvw-ref[data-kind=tag]{border-color:color-mix(in srgb,var(--dvw-warn) 55%,transparent);color:var(--dvw-warn)}
.dvw-ref[data-kind=remote]{border-color:var(--dvw-border);color:var(--dvw-text-2)}
.dvw-ref[data-kind=branch]{border-color:color-mix(in srgb,var(--dvw-accent) 50%,transparent);color:var(--dvw-accent)}
/* 分支选择器：VS Code quick pick 的形状（顶部居中 + 输入过滤 + 当前分支打勾）。 */
.dvw-quickpick-backdrop{position:fixed;z-index:70;inset:0;background:var(--dvw-mask)}
.dvw-quickpick{position:absolute;top:12%;left:50%;transform:translateX(-50%);width:min(460px,92vw);max-height:60vh;display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--dvw-border);border-radius:var(--dvw-radius-sm);background:var(--dvw-surface-2);box-shadow:var(--dvw-shadow-3)}
.dvw-quickpick-head{font-size:12px;color:var(--dvw-text-2)}
.dvw-quickpick-list{display:flex;flex-direction:column;min-height:0;overflow:auto}
.dvw-quickpick-item{width:100%;min-height:26px;border:0;border-radius:var(--dvw-radius-xs);background:transparent;color:var(--dvw-text);display:flex;align-items:center;gap:6px;padding:0 8px;text-align:left;cursor:pointer}
.dvw-quickpick-item:hover,.dvw-quickpick-item[data-active=true]{background:var(--dvw-active)}
.dvw-quickpick-blank{width:16px;flex:none}
.dvw-quickpick-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dvw-quickpick-meta{flex:none;font-size:11px;color:var(--dvw-text-3)}
.dvw-quickpick-empty{padding:8px;font-size:12px;color:var(--dvw-text-3);text-align:center}
.dvw-quickpick-create{color:var(--dvw-accent)}


/* ---- 提交图标签页 / Git 输出标签页 / 按目录分组 ---- */
.dvw-gittab{position:absolute;inset:0;display:flex;flex-direction:column;background:var(--dvw-base)}
.dvw-gittab-toolbar{flex:none;height:36px;display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid var(--dvw-border-soft)}
.dvw-gittab-branch{font-weight:600}
.dvw-gittab-meta{font-size:12px;color:var(--dvw-text-3)}
.dvw-gittab-actions{margin-left:auto;display:flex;align-items:center;gap:2px}
.dvw-gittab-body{flex:1;min-height:0;overflow:auto;padding:4px 0}
.dvw-gittab-empty{padding:28px;text-align:center;color:var(--dvw-text-3)}
.dvw-gitout{position:absolute;inset:0;display:flex;flex-direction:column;background:var(--dvw-base)}
.dvw-gitout-toolbar{flex:none;height:34px;display:flex;align-items:center;gap:6px;padding:0 10px;border-bottom:1px solid var(--dvw-border-soft);font-size:12px;color:var(--dvw-text-2)}
.dvw-gitout-count{margin-left:auto;color:var(--dvw-text-3)}
.dvw-gitout-list{flex:1;min-height:0;overflow:auto;padding:6px 0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.dvw-gitout-row{padding:2px 12px;white-space:pre-wrap;word-break:break-all;color:var(--dvw-text-2)}
.dvw-gitout-row[data-error=true]{color:var(--dvw-error)}
.dvw-gitout-empty{padding:20px;text-align:center;color:var(--dvw-text-3);font-family:inherit}
.dvw-git-dir{padding:3px 8px 1px;font-size:11px;color:var(--dvw-text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* 「提交图」入口按钮：Git Graph 同款 SVG 图标，跟随主题 currentColor。 */
.dvw-git-graph-mark{display:inline-grid;place-items:center;width:16px;height:16px;flex:none}
.dvw-git-graph-mark svg{display:block;color:inherit}

/* ---- 提交图标签页：详情面板 / 查找框 / 未提交与贮藏行 ---- */
.dvw-gitgraph-body{flex:1;min-height:0;display:flex}
.dvw-gitgraph-list{flex:1;min-width:0;overflow:auto;padding:4px 0}
.dvw-gitgraph-detail{flex:none;width:340px;min-height:0;overflow:auto;border-left:1px solid var(--dvw-border);background:var(--dvw-surface-1)}
.dvw-gittab-find{width:200px;height:24px;padding:0 8px;font-size:12px}
.dvw-graph-row[data-active=true]{background:var(--dvw-active);box-shadow:inset 2px 0 0 var(--dvw-accent)}
.dvw-git-detail{padding:10px;display:flex;flex-direction:column;gap:8px}
.dvw-git-detail-head{display:flex;align-items:center;gap:2px}
.dvw-git-detail-title{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dvw-git-detail-meta{font-size:11px;line-height:1.5;color:var(--dvw-text-3);word-break:break-all}
.dvw-git-detail-body{margin:0;padding:8px;max-height:180px;overflow:auto;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dvw-text-2);background:var(--dvw-surface-2);border-radius:var(--dvw-radius-xs)}
.dvw-git-detail-files{display:flex;flex-direction:column}
.dvw-git-detail-file{width:100%;border:0;background:transparent;color:var(--dvw-text);display:flex;align-items:center;gap:6px;padding:4px 6px;text-align:left;font:inherit;cursor:pointer;border-radius:var(--dvw-radius-xs)}
.dvw-git-detail-file:hover{background:var(--dvw-hover)}
.dvw-git-detail-file .dvw-graph-subject{flex:1;min-width:0}
.dvw-git-detail-empty{padding:6px;font-size:12px;color:var(--dvw-text-3)}
.dvw-file-stat{flex:none;display:flex;gap:6px;font-size:11px;font-variant-numeric:tabular-nums}
.dvw-stat-add{color:var(--dvw-success)}.dvw-stat-del{color:var(--dvw-error)}
.dvw-git-uncommitted{border-bottom:1px solid var(--dvw-border-soft)}
.dvw-uncommitted-dot{width:10px;height:10px;margin:0 8px 0 4px;flex:none;border-radius:50%;border:2px solid var(--dvw-warn)}
.dvw-uncommitted-files{padding:0 10px 6px 30px;display:flex;flex-direction:column;gap:2px}
.dvw-uncommitted-file{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dvw-text-2)}
.dvw-stash-dot{width:10px;height:10px;margin:0 8px 0 4px;flex:none;border-radius:50%;border:2px dashed var(--dvw-text-3)}

/* ---- 提交图列布局 / 代码审查 / 仓库设置对话框 ---- */
.dvw-graph-header{display:flex;align-items:center;gap:6px;padding:2px 8px;position:sticky;top:0;z-index:1;background:var(--dvw-surface-1);border-bottom:1px solid var(--dvw-border-soft);font-size:11px;color:var(--dvw-text-3)}
.dvw-graph-header-subject{flex:1;min-width:0}
.dvw-graph-header-col{position:relative;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:6px}
.dvw-col-resize{position:absolute;right:-2px;top:0;bottom:0;width:6px;cursor:col-resize}
.dvw-col-resize:hover{background:var(--dvw-accent)}
.dvw-graph-col{flex:none;padding-right:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dvw-text-3);text-align:left}
.dvw-graph-hash{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dvw-review-progress{flex:none;font-size:11px;color:var(--dvw-success)}
.dvw-review-toggle{flex:none;width:18px;height:18px;border:0;border-radius:var(--dvw-radius-xs);background:transparent;color:var(--dvw-text-3);display:grid;place-items:center;cursor:pointer}
.dvw-review-toggle:hover{background:var(--dvw-hover)}
.dvw-review-toggle[aria-pressed=true]{color:var(--dvw-success)}
.dvw-git-detail-file{display:flex;align-items:center;gap:2px}
.dvw-git-detail-open{flex:1;min-width:0;border:0;background:transparent;color:var(--dvw-text);display:flex;align-items:center;gap:6px;padding:4px 6px;text-align:left;font:inherit;cursor:pointer;border-radius:var(--dvw-radius-xs)}
.dvw-git-detail-open:hover{background:var(--dvw-hover)}
.dvw-git-detail-open .dvw-graph-subject{flex:1;min-width:0}
.dvw-git-issue-link{color:var(--dvw-accent);text-decoration:none}
.dvw-git-issue-link:hover{text-decoration:underline}
.dvw-git-dialog{width:min(560px,92vw)}
.dvw-git-dialog-head{display:flex;align-items:center;gap:6px;font-weight:600}
.dvw-git-dialog-head span{flex:1}
.dvw-git-dialog-section{margin-top:4px;font-size:12px;font-weight:600;color:var(--dvw-text-2)}
.dvw-git-dialog-row{display:flex;align-items:center;gap:6px}
.dvw-git-dialog-row .dvw-input{flex:1;min-width:0}
.dvw-git-dialog-name{flex:none;width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dvw-text-2)}
.dvw-git-dialog-add .dvw-input{flex:1}
.dvw-git-dialog-empty{font-size:12px;color:var(--dvw-text-3);padding:2px 0}
.dvw-git-dialog-note{font-size:11px;color:var(--dvw-text-3)}

/* ---- 编辑器空状态里的彩蛋：小恐龙（vendored 开源实现，iframe 铺满编辑器） ---- */
.dvw-dino-teaser{display:block;margin:10px auto 0;padding:2px 8px;border:0;border-radius:var(--dvw-radius-xs);background:transparent;color:var(--dvw-text-3);font:inherit;font-size:12px;cursor:pointer}
.dvw-dino-teaser:hover{color:var(--dvw-accent);background:var(--dvw-hover)}
.dvw-dino{position:absolute;inset:0;display:flex;flex-direction:column;background:var(--dvw-base)}
.dvw-dino-bar{flex:none;display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dvw-border-soft)}
.dvw-dino-title{flex:1;display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dvw-text-2)}
/* 注意：这里必须是块级布局，不能 display:flex —— 上游组件的根 div 是自动宽度的
   块，里面 .interstitial-wrapper 用 width:100% 撑开；一旦父级变成 flex，
   「flex 项自动宽度 ← 子项 100%」会互相依赖并塌成 0，画布宽度就是 0（游戏等于看不见）。 */
.dvw-dino-stage{flex:1;min-height:0;overflow:auto;padding-top:12px;background:#fff;color:#535353}
.dvw-dino-failed{margin:24px auto 0;font-size:12px;color:var(--dvw-text-3)}
/* 小恐龙自己的样式由 react-chrome-dino 组件在挂载时以 <style> 注入，这里不再重复。 */

`


export function installStyles(): () => void {
  const id = 'dsh-aide/styles'
  let tag = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${id}"]`)
  if (tag === null) { tag = document.createElement('style'); tag.dataset.pluginCss = id; tag.textContent = CSS; document.head.append(tag) }
  return () => { tag?.remove() }
}
