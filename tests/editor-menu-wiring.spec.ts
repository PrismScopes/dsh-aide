import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 编辑器右键菜单 / DSH 对话联动的**接线**测试。
 *
 * 这些是跨文件的组装点（纯数据模块各自有单测，组件本身没有 jsdom 可渲染），用源码静态断言
 * 钉住四件事，防止以后重构时把它们悄悄弄丢：
 *   1. 编辑器菜单把置顶贡献（DeepSeek Harness）放在标准编辑项之前，且段间补分隔线；
 *   2. 客户端入口把 DSH 对话适配器接上，并把「选中文本才有」的置顶贡献注册进去；
 *   3. 主视图会话变化时告诉适配器（发送消息要用它）；
 *   4. 工作台监听 reveal 事件，把右侧对话栏展开。
 */
const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../src/client/${path}`, import.meta.url)), 'utf8')

describe('editor context menu wiring', () => {
  const editor = read('MonacoEditor.tsx')
  const index = read('index.tsx')
  const workbench = read('Workbench.tsx')

  it('puts top contributions before the standard edit items, separated by a divider', () => {
    expect(editor).toContain('contributionEntries(target, \'top\')')
    expect(editor).toContain('contributionEntries(target, \'bottom\')')
    expect(editor).toContain('buildEditorMenuEntries')
    // 置顶段之后要有分隔线，标准项之后接追加段同样要分隔线。
    expect(editor).toMatch(/if \(top\.length > 0\) entries\.push\(\.\.\.top, separator\(\)\)/)
    expect(editor).toMatch(/if \(bottom\.length > 0\) entries\.push\(separator\(\), \.\.\.bottom\)/)
    // 标准编辑项仍然来自 editorMenus.ts 的纯数据。
    expect(editor).toContain('editorMenuItems(editorMenuContext(instance, save))')
  })

  it('keeps the editor menu context complete (isSupported + run)', () => {
    // 少了这两个字段菜单会在运行时禁用全部命令（TS 也会报错，但这里再钉一次语义）。
    expect(editor).toContain('isSupported: (commandId: string): boolean =>')
    expect(editor).toContain('run: (commandId: string) =>')
    // 剪贴板三个动作必须走带回退的实现，不能直接 trigger。
    for (const id of ['editor.action.clipboardCopyAction', 'editor.action.clipboardCutAction', 'editor.action.clipboardPasteAction']) {
      expect(editor).toContain(`if (commandId === '${id}')`)
    }
    // Action2 命令（getAction 拿不到）需要单独放行，否则转到定义/查找引用永远禁用。
    expect(editor).toContain('ACTION2_COMMANDS')
  })

  it('registers the DeepSeek Harness submenu as a top contribution', () => {
    expect(index).toContain("attachDshChat(ctx)")
    expect(index).toMatch(/place:\s*'top'/)
    expect(index).toContain("id: 'dsh-harness'")
    expect(index).toContain('submenu: dshMenuEntries(')
    // 用户要求：选中词条时才出现；没有选区时贡献返回空数组，不留下孤立分隔线。
    expect(index).toContain('target.hasSelection ? [dshHarnessEntry(target)] : []')
    expect(index).toContain('addSelectionToConversation')
    expect(index).toContain('askDsh')
    expect(index).toContain('formatSnippetQuote')
  })

  it('tells the DSH adapter which session is in the main view', () => {
    expect(index).toContain('setActiveSession(')
    // 必须在「没有会话就 return」之前，否则切换会话时 hooks 顺序会变。
    const overlayStart = index.indexOf('const Overlay =')
    const sessionEffect = index.indexOf('setActiveSession(', overlayStart)
    const earlyReturn = index.indexOf('if (session === undefined || session.id === \'\')', overlayStart)
    expect(sessionEffect).toBeGreaterThan(overlayStart)
    expect(earlyReturn).toBeGreaterThan(sessionEffect)
  })

  it('reveals the right-hand conversation panel when DSH actions ask for it', () => {
    expect(workbench).toContain('REVEAL_CHAT_EVENT')
    expect(workbench).toMatch(/addEventListener\(REVEAL_CHAT_EVENT, reveal\)/)
    expect(workbench).toContain("service.setLayout({ chatVisible: true })")
  })
})
