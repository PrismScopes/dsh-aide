import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsPanel } from '../src/client/SettingsPanel.tsx'
import { DEFAULT_PREFERENCES, PREFERENCES_KEY, preferences } from '../src/client/preferences.ts'

/**
 * 设置页的结构测试。
 *
 * 不测交互（那要 jsdom + 真实点击），只钉住几件容易回退的事：
 *   1. 页面内的左栏分类导航与五个分类都在，且默认停在「编辑器」；
 *   2. 五项就地可改的布局设置不能再回到这一页；
 *   3. 每个分组的关键设置项都有标题（说明它们真的渲染了，而不是只写在常量里）；
 *   4. 已保存的界面偏好出现在渲染结果里（字号、自动保存延迟、开关状态读的是同一份存储）。
 * 宿主设置与模型列表在挂载后才会拉取；静态渲染只验证控件留了位置、拿不到列表时有兜底文案。
 */
describe('workbench settings page', () => {
  afterEach(() => { preferences.reset() })

  it('renders the five category tabs and defaults to the editor panel', () => {
    const html = renderToStaticMarkup(<SettingsPanel/>)
    // 左侧是真正的 tablist：方向键切换、aria-current 标出当前项。
    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-orientation="vertical"')
    for (const label of ['编辑器', 'AI 补全', '终端', '快捷键', '关于与诊断']) {
      expect(html).toContain(`>${label}</button>`)
    }
    expect(html).toContain('aria-current="page"')
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
    // 默认只渲染编辑器分组；其余分组按需挂载，不把五个分组一起堆进 DOM。
    expect(html).toContain('data-category="editor"')
    expect(html).toContain('role="tabpanel"')
    expect(html).not.toContain('终端字号')
  })

  it('renders every editor setting the preferences contract defines', () => {
    const html = renderToStaticMarkup(<SettingsPanel/>)
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
    const html = renderToStaticMarkup(<SettingsPanel/>)
    for (const removed of ['显示左侧视图', '显示 DSH 对话栏', '显示底部状态栏', '左侧视图宽度', 'DSH 对话栏宽度']) {
      expect(html).not.toContain(removed)
    }
  })

  it('disables the dependent steppers until their mode is selected', () => {
    const html = renderToStaticMarkup(<SettingsPanel/>)
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
    const html = renderToStaticMarkup(<SettingsPanel initialCategory="completion"/>)
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
    const terminal = renderToStaticMarkup(<SettingsPanel initialCategory="terminal"/>)
    expect(terminal).toContain('终端字号')
    expect(terminal).toContain('class="dvw-set-value">13</span>')

    const shortcuts = renderToStaticMarkup(<SettingsPanel initialCategory="shortcuts"/>)
    // 键帽用 <kbd> 渲染，读屏与复制都能拿到真实键名。
    expect(shortcuts).toContain('<kbd class="dvw-set-keycap">Ctrl</kbd>')
    expect(shortcuts).toContain('采纳整条补全建议')
    expect(shortcuts).toContain('编辑器内查找')
    expect(shortcuts).toContain('显示或隐藏终端')

    const about = renderToStaticMarkup(<SettingsPanel initialCategory="about"/>)
    expect(about).toContain('关于与诊断')
    expect(about).toContain('版本')
    expect(about).toContain('0.2.2')
    expect(about).toContain('DSH 设置文件')
    expect(about).toContain(PREFERENCES_KEY)
    expect(about).toContain('恢复默认设置')
  })

  it('renders the stored preferences', () => {
    preferences.set({ editorFontSize: 19, editorAutoSave: 'afterDelay', editorAutoSaveDelayMs: 2500, editorMinimap: true, editorInsertSpaces: false })
    const editor = renderToStaticMarkup(<SettingsPanel/>)
    expect(editor).toContain('class="dvw-set-value">19</span>')
    expect(editor).toContain('class="dvw-set-value">2500</span>')
    // 开关状态直接来自偏好：用空格缩进被关掉、缩略图被打开。
    expect(editor).toContain('aria-checked="false" aria-label="用空格缩进"')
    expect(editor).toContain('aria-checked="true" aria-label="缩略图"')

    preferences.set({ terminalFontSize: 17 })
    const terminal = renderToStaticMarkup(<SettingsPanel initialCategory="terminal"/>)
    expect(terminal).toContain('class="dvw-set-value">17</span>')
  })

  it('degrades to top tabs in a narrow container via a container query', () => {
    // 设置页渲染在 DSH 设置面板的内容列里，视口宽不代表内容列宽 —— 用容器查询而不是媒体查询。
    const styles = readFileSync(fileURLToPath(new URL('../src/client/styles.ts', import.meta.url)), 'utf8')
    expect(styles).toContain('container-type:inline-size')
    expect(styles).toContain('@container (max-width:520px)')
    // 窄容器下导航变成顶部横向标签（容器查询与视口兜底各一条规则）。
    expect(styles.match(/\.dvw-set-nav\{position:static;width:100%;flex-direction:row/g)).toHaveLength(2)
    // 兜底：不支持容器查询的宿主按视口宽度退化。
    expect(styles).toContain('@media(max-width:640px)')
  })
})
