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
const reviewPanel = read('src/client/ReviewPanel.tsx')
const paletteComponent = read('src/client/CommandPalette.tsx')

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

  it('exposes the full command inventory across every subsystem', () => {
    for (const id of ['file.saveAll', 'file.closeOthers', 'file.closeRight', 'file.closeSaved', 'file.togglePin', 'file.copyAbsolutePath',
      'editor.undo', 'editor.format', 'editor.comment', 'editor.selectHighlights',
      'view.sidebar', 'view.output', 'view.outline', 'view.diffSplit',
      'git.graph', 'git.output',
      'ai.explain', 'ai.fix', 'ai.tests', 'ai.review',
      'review.checkpoint', 'review.acceptAll',
      'workbench.dino']) {
      expect(workbench).toContain(`add('${id}'`)
    }
    // 命令 id 不能重复：重复会让 Enter 执行到错误的那一条。
    const ids = [...workbench.matchAll(/add\('([^']+)'/g)].map(match => match[1])
    expect(ids.length).toBeGreaterThan(45)
    expect(new Set(ids).size).toBe(ids.length)
    // 审查动作执行后显式通知面板刷新。
    expect(reviewPanel).toContain("window.addEventListener('dvw-review-refresh'")
    expect(workbench).toContain("new Event('dvw-review-refresh')")
  })

  it('renders every command when the query is empty', () => {
    const cap = Number(/const MAX_ROWS = (\d+)/.exec(paletteComponent)?.[1])
    const count = [...workbench.matchAll(/add\('([^']+)'/g)].length
    expect(cap).toBeGreaterThanOrEqual(count)
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

  it('does not draw a square focus ring inside the rounded palette', () => {
    // 全局 input:focus-visible 会画方角蓝框；输入框自身必须显式关掉，只留光标。
    expect(styles).toContain('.dvw-overlay .dvw-palette-input:focus-visible{outline:0}')
    expect(styles).toContain('caret-color:var(--dvw-accent)')
    // 焦点反馈不再额外画边框（用户明确只要光标）。
    expect(styles).not.toContain('.dvw-palette:focus-within')
  })

  it('anchors the palette to the AIDE overlay instead of the browser viewport', () => {
    // fixed + left:50% 会以浏览器视口居中，打开对话栏或缩放界面后中心会偏离编辑器区。
    expect(styles).toContain('.dvw-palette-backdrop{position:absolute')
    expect(styles).toContain('justify-content:center')
    expect(styles).not.toContain('.dvw-palette{position:absolute;top:10%;left:50%')
  })
})
