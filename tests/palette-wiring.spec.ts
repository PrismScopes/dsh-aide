import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 命令面板/快速打开的接线测试：键位注册、宿主端点、面板渲染与样式。
 *
 * 行为由 palette.spec.ts 的纯函数用例覆盖；这里只钉住「入口真的连上了」，
 * 防止以后重构工作台时把面板接线丢掉。
 */
function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')
}

const workbench = read('src/client/Workbench.tsx')
const keybindings = read('src/client/keybindings.ts')
const styles = read('src/client/styles.ts')
const api = read('src/api.ts')
const host = read('src/host.ts')

describe('palette keybindings', () => {
  it('registers Ctrl+P and Ctrl+Shift+P with labels that match the panel', () => {
    expect(keybindings).toContain("{ id: 'view.quickOpen', label: '快速打开文件'")
    expect(keybindings).toContain("{ id: 'view.commandPalette', label: '显示所有命令'")
    expect(keybindings).toMatch(/view\.quickOpen[^\n]*code: 'KeyP', ctrl: true/)
    expect(keybindings).toMatch(/view\.commandPalette[^\n]*code: 'KeyP', ctrl: true, shift: true/)
  })
})

describe('workbench wiring', () => {
  it('opens the palette from the keybinding table and renders it', () => {
    expect(workbench).toContain("bindingOf('view.quickOpen')")
    expect(workbench).toContain("bindingOf('view.commandPalette')")
    expect(workbench).toContain('<CommandPalette initialMode={paletteMode}')
    // 面板打开时不再叠第二层：焦点在面板/快速选择框里时直接返回。
    expect(workbench).toContain(".dvw-palette,.dvw-quickpick")
  })

  it('loads the workspace file list through the host and caches it', () => {
    expect(api).toContain("case 'fs.files': return listWorkspaceFiles(cwd)")
    expect(host).toContain('export function listWorkspaceFiles(')
    expect(workbench).toContain("api<{files:string[];truncated:boolean}>('fs.files'")
    // 文件增删后清客户端缓存，下次打开重新取。
    expect(workbench).toContain('paletteFilesRef.current=undefined')
  })

  it('routes file picks through the same open() used by the explorer', () => {
    expect(workbench).toContain("entry.id.slice('file:'.length)")
    expect(workbench).toContain('pickPaletteEntry')
  })
})

describe('palette appearance', () => {
  it('has the dialog, list and keycap styles', () => {
    for (const selector of ['.dvw-palette-backdrop{', '.dvw-palette{', '.dvw-palette-input{', '.dvw-palette-row{', '.dvw-palette-keys kbd{', '.dvw-palette-hit{']) {
      expect(styles).toContain(selector)
    }
  })
})
