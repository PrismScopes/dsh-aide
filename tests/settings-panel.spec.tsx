import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsPanel } from '../src/client/SettingsPanel.tsx'
import { PREFERENCES_KEY, preferences } from '../src/client/preferences.ts'

/**
 * 设置页的结构测试。
 *
 * 不测交互（那要 jsdom + 真实点击），只钉住几件容易回退的事：
 *   1. 一页滚动的五个分组都在（曾经做过左侧分类子菜单，用户反馈太丑已去掉，不能再回来）；
 *   2. 五项就地可改的布局设置不能回到这一页；
 *   3. 每个分组的设置项都有标题（说明真的渲染了）；
 *   4. 字号与 DSH 设置页统一（行标题 14/20、说明 12/18、控件 14），且不能再出现第二套比例；
 *   5. 已保存的界面偏好出现在渲染结果里（读的是同一份存储）。
 * 宿主设置与模型列表在挂载后才会拉取；静态渲染只验证控件留了位置、拿不到列表时有兜底文案。
 */
const styles = readFileSync(fileURLToPath(new URL('../src/client/styles.ts', import.meta.url)), 'utf8')
const html = renderToStaticMarkup(<SettingsPanel/>)

describe('workbench settings page', () => {
  afterEach(() => { preferences.reset() })

  it('renders all five groups in one scrolling page, without the removed sub-menu', () => {
    for (const label of ['编辑器', 'AI 补全', '终端', '快捷键', '关于与诊断']) {
      expect(html).toContain(`class="dvw-set-group-title">${label}</h3>`)
    }
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

  it('renders the terminal, shortcut and diagnostic groups', () => {
    expect(html).toContain('终端字号')
    expect(html).toContain('class="dvw-set-value">13</span>')
    // 键帽用 <kbd> 渲染，读屏与复制都能拿到真实键名。
    expect(html).toContain('<kbd class="dvw-set-keycap">Ctrl</kbd>')
    expect(html).toContain('采纳整条补全建议')
    expect(html).toContain('编辑器内查找')
    expect(html).toContain('显示或隐藏终端')
    expect(html).toContain('版本')
    expect(html).toContain('0.2.2')
    expect(html).toContain('DSH 设置文件')
    expect(html).toContain(PREFERENCES_KEY)
    expect(html).toContain('恢复默认设置')
  })

  it('renders the stored preferences', () => {
    preferences.set({ editorFontSize: 19, editorAutoSave: 'afterDelay', editorAutoSaveDelayMs: 2500, editorMinimap: true, editorInsertSpaces: false, terminalFontSize: 17 })
    const updated = renderToStaticMarkup(<SettingsPanel/>)
    expect(updated).toContain('class="dvw-set-value">19</span>')
    expect(updated).toContain('class="dvw-set-value">2500</span>')
    expect(updated).toContain('class="dvw-set-value">17</span>')
    // 开关状态直接来自偏好：用空格缩进被关掉、缩略图被打开。
    expect(updated).toContain('aria-checked="false" aria-label="用空格缩进"')
    expect(updated).toContain('aria-checked="true" aria-label="缩略图"')
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
