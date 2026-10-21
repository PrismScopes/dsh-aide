import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NoSessionPrompt } from '../src/client/NoSessionPrompt.tsx'
import { Overlay } from '../src/client/index.tsx'
import type { VscodeWorkbench } from '../src/client/service.ts'

/**
 * 「没有会话」提示层的回归测试。
 *
 * 背景：DSH 归档最后一个会话后 mainViewSession 变成 undefined；overlay 是全局挂载的，
 * 旧实现无条件渲染这层提示，会把已经关闭的工作台「弹」出来，且「返回 DSH」只是把 visible
 * 置回 false（本来就没打开），提示层不看 visible，于是永远关不掉，页面被整层盖住。
 *
 * 这里钉住三件事：
 *   1. visible=false 时 NoSessionPrompt 返回 null（不产生任何遮挡 DOM）；
 *   2. visible=true 时提示与返回按钮仍然可用；
 *   3. 真实的 Overlay 在「没有主视图会话」分支里同样遵守 visible（归档回归）。
 */
function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')
}

describe('NoSessionPrompt', () => {
  it('renders nothing while the workbench is closed — the archive regression', () => {
    expect(renderToStaticMarkup(<NoSessionPrompt visible={false} onBack={() => {}}/>)).toBe('')
  })

  it('renders the prompt only when the workbench was opened without a session', () => {
    const html = renderToStaticMarkup(<NoSessionPrompt visible onBack={() => {}}/>)
    expect(html).toContain('dvw-overlay')
    expect(html).toContain('请选择一个会话')
    expect(html).toContain('返回 DSH')
  })
})

describe('Overlay without a main-view session', () => {
  /** 只造 Overlay 无会话分支需要的服务面；Workbench 分支不在这组测试里渲染。 */
  function renderOverlay(visible: boolean): string {
    const service = {
      getSnapshot: () => ({ visible, view: 'explorer' as const }),
      subscribe: () => () => {},
      setSettingsOpener: () => {},
    } as unknown as VscodeWorkbench
    // 其余 GlobalStandardProps（usePanelInfo 等）在无会话分支不会用到，SSR 里也不执行 effect；
    // 这里按组件签名整体收窄，避免为测试伪造一整套 runtime 服务。
    const props = { service, useSessions: () => undefined } as unknown as Parameters<typeof Overlay>[0]
    return renderToStaticMarkup(<Overlay {...props}/>)
  }

  it('stays unmounted when the workbench is closed — the archive regression', () => {
    expect(renderOverlay(false)).toBe('')
  })

  it('shows the prompt when the user opens the workbench without a session', () => {
    expect(renderOverlay(true)).toContain('请选择一个会话')
  })
})

describe('no-session prompt wiring', () => {
  const index = read('src/client/index.tsx')

  it('gates the no-session overlay by the workbench visible flag', () => {
    expect(index).toContain("import { NoSessionPrompt } from './NoSessionPrompt.tsx'")
    expect(index).toContain('<NoSessionPrompt visible={visible} onBack={() => service.hide()}/>')
    // visible 必须来自可订阅的 service 快照（否则归档后状态不会更新）。
    expect(index).toContain('service.subscribe(() => setVisible(service.getSnapshot().visible))')
    // 提示文案只属于 NoSessionPrompt；Overlay 里不能再有第二份无条件渲染。
    expect(index).not.toContain('请选择一个会话')
  })
})
