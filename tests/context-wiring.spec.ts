import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 输入框上下文卡片的接线测试。
 *
 * 行为测试在 context-cards.spec.ts（用 fake DSH 服务验证 chip 插入/序列化），这里只钉住
 * 「面板/菜单 → Workbench → contextCards → DSH composer」这条链路没有被接断：
 * - 插件 apply 安装 `@` 源；
 * - Workbench 监听请求并把当前 sessionId 交给 contextCards；
 * - 面板拿到 activePath（当前文件过滤/文件上下文）；
 * - 编辑器菜单多一项「添加为上下文卡片」。
 */
function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')
}

describe('context card wiring', () => {
  const index = read('src/client/index.tsx')
  const workbench = read('src/client/Workbench.tsx')
  const service = read('src/client/service.ts')
  const menus = read('src/client/dshMenus.ts')

  it('installs the DSH source and forwards requests from the workbench', () => {
    expect(index).toContain('installContextCards(ctx')
    expect(workbench).toContain('CONTEXT_CARD_EVENT')
    expect(workbench).toContain('handleContextCardRequest(detail, sessionId)')
    expect(workbench).toContain('setContextCardScope(')
  })

  it('passes the active editor path to bottom panels', () => {
    expect(service).toContain('activePath?: string')
    expect(workbench).toContain('activePath={activeTab?.path}')
  })

  it('offers a context-card action in the editor DSH submenu', () => {
    expect(menus).toContain("label: '添加为上下文卡片'")
    expect(index).toContain('requestContextCard({')
    expect(index).toContain("kind: 'selection'")
  })
})
