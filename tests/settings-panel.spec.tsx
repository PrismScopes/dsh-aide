import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsPanel } from '../src/client/SettingsPanel.tsx'
import { DEFAULT_PREFERENCES, preferences } from '../src/client/preferences.ts'

/**
 * 设置页的结构测试。
 *
 * 不测交互（那要 jsdom），只钉住两件容易回退的事：
 *   1. 五项就地可改的布局设置不能再回到这一页；
 *   2. 已保存的界面偏好要出现在渲染结果里（字号、开关状态读的是同一份存储）。
 * 宿主设置（模型路由）在挂载后才会拉取，所以这里只断言它占了一个位置。
 */
describe('workbench settings page', () => {
  it('renders the completion, editor and shortcut sections', () => {
    const html = renderToStaticMarkup(<SettingsPanel/>)
    expect(html).toContain('AI 补全')
    expect(html).toContain('编辑器')
    expect(html).toContain('快捷键')
    expect(html).toContain('模型路由')
    expect(html).toContain('跟随 DSH 默认模型')
    expect(html).toContain('字号')
    // 宿主设置还没读到：补全那两项禁用，界面偏好照常可改。
    expect(html).toContain('disabled')
  })

  it('drops the layout rows that already have in-place controls', () => {
    const html = renderToStaticMarkup(<SettingsPanel/>)
    for (const removed of ['显示左侧视图', '显示 DSH 对话栏', '显示底部状态栏', '左侧视图宽度', 'DSH 对话栏宽度']) {
      expect(html).not.toContain(removed)
    }
  })

  it('renders the stored preferences', () => {
    preferences.set({ editorFontSize: 17, editorWordWrap: true, completionEnabled: false })
    try {
      const html = renderToStaticMarkup(<SettingsPanel/>)
      expect(html).toContain('17')
      expect(html).toContain('aria-checked="true"')
      expect(html).toContain('aria-checked="false"')
    } finally {
      preferences.set(DEFAULT_PREFERENCES)
    }
  })

  it('lists the shortcuts that have no other discoverable entry', () => {
    const html = renderToStaticMarkup(<SettingsPanel/>)
    // 键帽用 <kbd> 渲染，读屏与复制都能拿到真实键名。
    expect(html).toContain('<kbd class="dvw-set-keycap">Ctrl</kbd>')
    expect(html).toContain('采纳整条补全建议')
    expect(html).toContain('显示或隐藏终端')
  })
})
