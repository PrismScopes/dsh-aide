import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LanguageGroup, SettingsPanel, type WorkbenchSettingsState } from '../src/client/SettingsPanel.tsx'
import { ShortcutDialogContent } from '../src/client/ShortcutSettings.tsx'
import { PREFERENCES_KEY, preferences } from '../src/client/preferences.ts'
import { keybindings } from '../src/client/keybindings.ts'
import type { CompletionSettingsView, LanguageSettingsView, WorkbenchSettingsView } from '../src/client/api.ts'

/**
 * 设置页的结构测试。
 *
 * 不测交互（那要 jsdom + 真实点击），只钉住几件容易回退的事：
 *   1. 一页滚动的六个分组都在（曾经做过左侧分类子菜单，用户反馈太丑已去掉，不能再回来）；
 *   2. 五项就地可改的布局设置不能回到这一页；
 *   3. 每个分组的设置项都有标题（说明真的渲染了）；
 *   4. 字号与 DSH 设置页统一（行标题 14/20、说明 12/18、控件 14），且不能再出现第二套比例；
 *   5. 已保存的界面偏好出现在渲染结果里（读的是同一份存储）。
 * 宿主设置与模型列表在挂载后才会拉取；静态渲染只验证控件留了位置、拿不到宿主视图时的兜底文案。
 * 「语言服务」分组另外单独注入一份宿主视图渲染 —— useEffect 在 SSR 里不执行，只有这样才测得到
 * 服务器状态映射与环境变量覆盖警告。
 */
const styles = readFileSync(fileURLToPath(new URL('../src/client/styles.ts', import.meta.url)), 'utf8')
/** 版本号只有 package.json 一个事实源：测试跟着它走，发版时不用再改这里。 */
const VERSION = (JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }).version
const html = renderToStaticMarkup(<SettingsPanel/>)

/* ── 静态渲染用的宿主视图替身 ──────────────────────────────────────────────
 * 设置页的 GET 在 useEffect 里，SSR 不会执行；要测「宿主有响应时」的渲染，
 * 只能直接渲染分组并注入一份视图。形状与宿主 /dsh-vscode/settings 的响应一致。 */

function completionView(): CompletionSettingsView {
  return {
    route: null,
    fallback: false,
    routeSource: 'default',
    fallbackSource: 'default',
    envRoute: null,
    effective: { source: 'dsh', model: 'deepseek-chat' },
    lastFailure: null,
  }
}

function languageView(overrides: Partial<LanguageSettingsView> = {}): LanguageSettingsView {
  return {
    enabled: true,
    builtinTypescript: true,
    file: '/home/dev/.dsh/language.settings.json',
    servers: [],
    ...overrides,
  }
}

function settingsState(view: WorkbenchSettingsView | undefined): WorkbenchSettingsState {
  return {
    view,
    loadError: undefined,
    writeError: undefined,
    saving: false,
    routeDraft: '',
    setRouteDraft: () => {},
    commitRoute: () => {},
    commit: () => {},
    commitLanguage: () => {},
  }
}

function languageGroupHtml(view?: WorkbenchSettingsView): string {
  return renderToStaticMarkup(<LanguageGroup preferences={preferences.get()} settings={settingsState(view)}/>)
}

describe('workbench settings page', () => {
  afterEach(() => { preferences.reset(); keybindings.resetAll() })

  it('renders all six groups in one scrolling page, in the agreed order, without the removed sub-menu', () => {
    const titles = [...html.matchAll(/class="dvw-set-group-title">([^<]+)<\/h3>/g)].map(match => match[1])
    // 语言服务插在 AI 补全与终端之间：与「编辑器 → AI 补全 → 语言服务 → 终端」的心智顺序一致。
    expect(titles).toEqual(['编辑器', 'AI 补全', '语言服务', '终端', '快捷键', '关于与诊断'])
    // 左侧分类子菜单已经按用户反馈去掉：不再有 tablist / tab / tabpanel，也没有对应样式。
    expect(html).not.toContain('role="tablist"')
    expect(html).not.toContain('role="tabpanel"')
    expect(styles).not.toContain('.dvw-set-nav')
    expect(styles).not.toContain('.dvw-set-tab')
    expect(styles).not.toContain('@container')
  })

  it('renders every editor setting the preferences contract defines', () => {
    for (const title of [
      '字号',
      '行高',
      '制表符宽度',
      '用空格缩进',
      '自动换行',
      '自动换行列宽',
      '缩略图',
      '概览标尺',
      '选中内容同类词高亮',
      '显示空白字符',
      '光标样式',
      '平滑滚动',
      '粘性滚动',
      '自动保存',
      '自动保存延迟',
    ]) {
      expect(html).toContain(`class="dvw-set-title">${title}</span>`)
    }
  })

  it('drops the layout rows that already have in-place controls', () => {
    for (const removed of ['显示左侧视图', '显示 DSH 对话栏', '显示底部状态栏', '左侧视图宽度', 'DSH 对话栏宽度']) {
      expect(html).not.toContain(removed)
    }
  })

  it('disables the dependent steppers until their mode is selected', () => {
    // 默认 wordWrap=off：列宽控件禁用。属性顺序由 JSX 决定，aria-label 紧跟 disabled。
    expect(html).toMatch(/aria-label="增大自动换行列宽" disabled=""/)
    // 默认 editorAutoSave=off：延迟控件禁用。
    expect(html).toMatch(/aria-label="增大自动保存延迟" disabled=""/)

    preferences.set({ editorWordWrap: 'bounded', editorAutoSave: 'afterDelay' })
    const enabled = renderToStaticMarkup(<SettingsPanel/>)
    expect(enabled).not.toMatch(/aria-label="增大自动换行列宽" disabled=""/)
    expect(enabled).not.toMatch(/aria-label="增大自动保存延迟" disabled=""/)
  })

  it('renders the completion group with the model route fallback text', () => {
    expect(html).toContain('AI 补全')
    expect(html).toContain('行内补全')
    expect(html).toContain('模型路由')
    expect(html).toContain('模型失败时回落本地兜底')
    expect(html).toContain('触发延迟')
    // 模型列表还没拉到时也要在说明里写清「跟随 DSH 默认模型」，控件留了 datalist 的位置。
    expect(html).toContain('跟随 DSH 默认模型')
    expect(html).toContain('<datalist id="dvw-set-model-route-options">')
    // 宿主设置未就绪：模型路由输入框禁用，但界面偏好（补全开关/延迟）照常可改。
    expect(html).toMatch(/aria-label="补全模型路由"[^>]*disabled=""/)
    expect(html).toContain('aria-label="增大补全触发延迟"')
  })

  it('renders the language service rows and the host-off fallbacks', () => {
    expect(html).toContain('class="dvw-set-group-title">语言服务</h3>')
    for (const title of ['启用语言服务', '内置 TypeScript', '悬停提示', '语言补全', '语言服务器', '设置文件']) {
      expect(html).toContain(`class="dvw-set-title">${title}</span>`)
    }
    expect(html).toContain('诊断、跳转、补全由宿主语言服务提供；关闭后编辑器只剩语法高亮')
    expect(html).toContain('为 .ts/.js 提供项目级诊断与跳转；外部语言服务器不受影响')
    // 宿主视图还没拉到时：两个宿主开关显示默认开启、但禁用；两个客户端偏好开关不受影响。
    expect(html).toMatch(/aria-checked="true" aria-label="启用语言服务" class="dvw-set-switch" disabled=""/)
    expect(html).toMatch(/aria-checked="true" aria-label="内置 TypeScript" class="dvw-set-switch" disabled=""/)
    expect(html).toContain('aria-label="悬停提示" class="dvw-set-switch">')
    expect(html).toContain('aria-label="语言补全" class="dvw-set-switch">')
    // 服务器列表与设置文件的兜底文案：拿不到宿主视图时也要说清「现在能做什么」。
    expect(html).toContain('没有发现外部语言服务器（可在 language.settings.json 配置）')
    expect(html).toContain('未设置 DSH_HOME')
    expect(html).not.toContain('环境变量覆盖')
  })

  it('keeps the shortcut editor behind one row entry instead of flattening it into the page', () => {
    // 与 DSH 一致：设置页只有一行入口（标题 + 说明 + 「查看」），列表与改键都在面板里。
    expect(html).toContain('class="dvw-set-title">快捷键面板</span>')
    expect(html).toContain('aria-label="打开快捷键设置"')
    expect(html).not.toContain('dvw-set-shortcut')
    expect(html).not.toContain('dvw-set-subgroup')
    expect(html).not.toContain('dvw-set-keycap')
    expect(styles).toContain('.dvw-shortcut-backdrop')
    expect(styles).toContain('.dvw-set-recorder')
    expect(styles).toContain('.dvw-set-subgroup')
  })

  it('renders the shortcut panel with search, groups and editable rows', () => {
    const dialog = renderToStaticMarkup(<ShortcutDialogContent onClose={() => {}}/>)
    expect(dialog).toContain('role="dialog"')
    expect(dialog).toContain('aria-modal="true"')
    expect(dialog).toContain('aria-label="搜索快捷键"')
    expect(dialog).toContain('class="dvw-set-subgroup">导航</h4>')
    expect(dialog).toContain('aria-label="修改快捷键：保存当前文件"')
    expect(dialog).toContain('aria-label="快捷键（编辑器内置，不可修改）：编辑器内查找"')
    expect(dialog).toContain('<kbd class="dvw-set-keycap">Ctrl</kbd>')
    expect(dialog).toContain('采纳整条补全建议')
    expect(dialog).toContain('恢复全部默认')
    // 语言服务命令（9 条可改 + 1 条固定鼠标行）加进注册表后，下面两处数量/顺序按实际渲染更新。
    expect(dialog).toContain('class="dvw-set-subgroup">语言服务</h4>')
    expect(dialog).toContain('aria-label="修改快捷键：转到定义"')
    expect(dialog).toContain('快捷键（编辑器内置，不可修改）：按住 Ctrl 点击标识符转到定义')
    // 20 条可改命令 + 10 条固定键位 = 30 行；分组顺序与 keybindings.ts 的定义顺序一致。
    expect([...dialog.matchAll(/class="dvw-set-row dvw-set-shortcut"/g)]).toHaveLength(30)
    expect([...dialog.matchAll(/class="dvw-set-subgroup">([^<]+)<\/h4>/g)].map(match => match[1]))
      .toEqual(['编辑器', '导航', '终端', 'DSH', '语言服务', '编辑器内置（不可改）'])
  })

  it('shows changed bindings and how many shortcuts were modified inside the panel', () => {
    keybindings.set('editor.save', { code: 'KeyQ', ctrl: true })
    const dialog = renderToStaticMarkup(<ShortcutDialogContent onClose={() => {}}/>)
    expect(dialog).toContain('<kbd class="dvw-set-keycap">Q</kbd>')
    expect(dialog).toContain('已修改 1 项')
    keybindings.set('terminal.toggle', null)
    expect(renderToStaticMarkup(<ShortcutDialogContent onClose={() => {}}/>)).toContain('未绑定')
    keybindings.resetAll()
  })

  it('renders the terminal, shortcut and diagnostic groups', () => {
    expect(html).toContain('终端字号')
    expect(html).toContain('class="dvw-set-value">13</span>')
    expect(html).toContain('打开快捷键设置')
    expect(html).toContain('版本')
    expect(html).toContain(VERSION)
    expect(html).toContain('DSH 设置文件')
    expect(html).toContain(PREFERENCES_KEY)
    expect(html).toContain('恢复默认设置')
  })

  it('renders the stored preferences', () => {
    preferences.set({ editorFontSize: 19, editorAutoSave: 'afterDelay', editorAutoSaveDelayMs: 2500, editorMinimap: true, editorInsertSpaces: false, terminalFontSize: 17, languageHover: false, languageCompletion: false })
    const updated = renderToStaticMarkup(<SettingsPanel/>)
    expect(updated).toContain('class="dvw-set-value">19</span>')
    expect(updated).toContain('class="dvw-set-value">2500</span>')
    expect(updated).toContain('class="dvw-set-value">17</span>')
    // 开关状态直接来自偏好：用空格缩进被关掉、缩略图被打开、语言服务的两个客户端开关都关掉。
    expect(updated).toContain('aria-checked="false" aria-label="用空格缩进"')
    expect(updated).toContain('aria-checked="true" aria-label="缩略图"')
    expect(updated).toContain('aria-checked="false" aria-label="悬停提示"')
    expect(updated).toContain('aria-checked="false" aria-label="语言补全"')
  })

  it('uses the DSH settings type scale for titles, hints and controls', () => {
    // 行标题 14px/20px、说明 12px/18px、行距与分隔线按 DSH 设置页规格。
    expect(styles).toContain('.dvw-set-title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px}')
    expect(styles).toContain('.dvw-set-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}')
    expect(styles).toMatch(/\.dvw-set-row\{[^}]*padding:14px 2px[^}]*border-bottom:\.5px solid var\(--dsw-alias-border-l2\)/)
    // 控件文字不再比标签大一号：输入框/下拉/按钮都是 32px 高、14px 字号。
    for (const rule of ['.dvw-set-input', '.dvw-set-select', '.dvw-set-button']) {
      expect(styles).toMatch(new RegExp(rule.replace('.', '\\.') + '\\{[^}]*font-size:14px'))
      expect(styles).toMatch(new RegExp(rule.replace('.', '\\.') + '\\{[^}]*height:32px'))
    }
    // 步骤器数值与单位也是 14px（与控件同档）。
    expect(styles).toContain('.dvw-set-value{font-size:14px;')
    expect(styles).toContain('.dvw-set-unit{color:var(--dsw-alias-label-secondary);font-size:14px}')
  })
})

/**
 * 语言服务分组在「宿主有响应」时的渲染。
 *
 * 注入一份视图而不是 mock fetch：GET 在 useEffect 里，SSR 不执行它；直接渲染分组能确定地覆盖
 * 状态映射、环境变量警告与开关的禁用关系，不用把网络 mock 搞复杂。
 */
describe('language service group with a host view', () => {
  afterEach(() => { preferences.reset() })

  it('renders every discovered server with name, languages and Chinese state', () => {
    const servers: LanguageSettingsView['servers'] = [
      { id: 'builtin-typescript', name: '内置 TypeScript', languages: ['typescript', 'javascript'], state: 'builtin' },
      { id: 'pyright', name: 'Pyright', languages: ['python'], state: 'idle' },
      { id: 'gopls', name: 'gopls', languages: ['go'], state: 'starting' },
      { id: 'rust-analyzer', name: 'rust-analyzer', languages: ['rust'], state: 'running' },
      { id: 'clangd', name: 'clangd', languages: ['c', 'cpp'], state: 'missing', detail: '命令未找到' },
      { id: 'pyright-failed', name: 'Pyright（启动失败）', languages: ['python'], state: 'failed', detail: '握手超时' },
      { id: 'json-ls', name: 'JSON 语言服务器', languages: ['json'], state: 'disabled' },
    ]
    const group = languageGroupHtml({ completion: completionView(), language: languageView({ servers }) })
    // 状态 → 中文的映射一次钉死：宿主给的是稳定英文状态，界面不能漏翻。
    expect(group).toContain('typescript、javascript · 内置')
    expect(group).toContain('python · 已发现')
    expect(group).toContain('go · 启动中')
    expect(group).toContain('rust · 运行中')
    expect(group).toContain('c、cpp · 未安装（命令未找到）')
    expect(group).toContain('python · 启动失败（握手超时）')
    expect(group).toContain('json · 已关闭')
    // 有服务器时不再显示「没有发现外部语言服务器」的兜底。
    expect(group).not.toContain('没有发现外部语言服务器')
    // 设置文件路径来自宿主视图。
    expect(group).toContain('/home/dev/.dsh/language.settings.json')
    // 宿主视图可用：两个宿主开关都可操作（总开关与内置都开）。
    expect(group).toMatch(/aria-checked="true" aria-label="启用语言服务" class="dvw-set-switch">/)
    expect(group).toMatch(/aria-checked="true" aria-label="内置 TypeScript" class="dvw-set-switch">/)
  })

  it('disables the builtin switch while the master switch is off', () => {
    const group = languageGroupHtml({ completion: completionView(), language: languageView({ enabled: false, builtinTypescript: false }) })
    expect(group).toMatch(/aria-checked="false" aria-label="启用语言服务" class="dvw-set-switch">/)
    // 总开关关闭时内置 TypeScript 跟着禁用，但它自身的值仍然如实显示。
    expect(group).toMatch(/aria-checked="false" aria-label="内置 TypeScript" class="dvw-set-switch" disabled=""/)
  })

  it('warns that environment variables override the switches, naming the active ones', () => {
    const group = languageGroupHtml({
      completion: completionView(),
      language: languageView({ env: { enabled: '0', builtinTypescript: '1' } }),
    })
    expect(group).toContain('环境变量覆盖')
    expect(group).toContain('DSH_AIDE_LANGUAGE=0')
    expect(group).toContain('DSH_AIDE_LANGUAGE_BUILTIN=1')
    expect(group).toContain('正在覆盖此处的开关')
  })

  it('reports a missing DSH_HOME and an unavailable host view in the fallback copy', () => {
    // 宿主给了响应但数据目录未知：file 缺省时说明只能改环境变量。
    const noHome = languageGroupHtml({ completion: completionView(), language: languageView({ file: undefined }) })
    expect(noHome).toContain('未设置 DSH_HOME')
    // 旧宿主没有 language 字段：明确提示更新，而不是给一堆看起来能点却没反应的开关。
    const noLanguage = languageGroupHtml({ completion: completionView() } as WorkbenchSettingsView)
    expect(noLanguage).toContain('语言服务设置不可用')
  })
})
