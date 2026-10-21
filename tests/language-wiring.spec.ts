import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 语言服务的接线静态测试。
 *
 * 这一层能力跨「宿主路由 → WebSocket 推送 → 客户端 store → Monaco provider → 工作台标签/面板」
 * 很多文件，交互测试（jsdom + 真 Monaco + 真子进程）成本过高；这里钉住「每一段都真的接上了」，
 * 行为本身由 language-client / language-manager / lsp-* / typescript-provider 等测试覆盖。
 */
function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')
}

const api = read('src/api.ts')
const routes = read('src/routes.ts')
const index = read('src/index.ts')
const clientIndex = read('src/client/index.tsx')
const workbench = read('src/client/Workbench.tsx')
const monacoEditor = read('src/client/MonacoEditor.tsx')
const monaco = read('src/client/language/monaco.ts')
const actions = read('src/client/language/actions.ts')
const client = read('src/client/language/client.ts')
const diagnostics = read('src/client/language/diagnostics.ts')
const styles = read('src/client/styles.ts')
const problems = read('src/client/ProblemsPanel.tsx')
const settingsPanel = read('src/client/SettingsPanel.tsx')
const clientApi = read('src/client/api.ts')
const keybindings = read('src/client/keybindings.ts')
const quickPick = read('src/client/quickPick.tsx')
const packageJson = JSON.parse(read('package.json')) as { version: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

describe('语言服务接线', () => {
  it('routs language.* methods and exposes a dedicated push socket', () => {
    expect(api).toContain("method.startsWith('language.')")
    expect(api).toContain('dispatchLanguage')
    expect(routes).toContain('/dsh-vscode/ws/language')
    expect(routes).toContain('languageHost.attach')
    expect(routes).toContain('languageHost.detach')
    expect(routes).toContain('language: languageHostFor(ctx).settingsView()')
    expect(routes).toContain('updateLanguageSettings')
    expect(index).toContain('setLanguageSettings')
  })

  it('loads TypeScript at runtime as a real dependency (host bundles it external)', () => {
    expect(packageJson.dependencies?.['typescript']).toBeDefined()
    expect(read('src/language/typescript.ts')).toContain("await import('typescript')")
  })

  it('creates a workspace-scoped client and keeps editors/tabs in sync', () => {
    expect(workbench).toContain('new LanguageWorkspace(sessionId,root)')
    expect(workbench).toContain('setActiveLanguageWorkspace(language)')
    expect(workbench).toContain("dispatchEvent(new Event('dvw-language-ready'))")
    expect(workbench).toContain('absoluteOfTab')
    expect(workbench).toContain("'dvw-language-picker'")
    expect(workbench).toContain('OPEN_LOCATION_EVENT')
    expect(workbench).toContain('externalAbsolute')
    expect(workbench).toContain('<LanguagePickerHost')
    expect(monacoEditor).toContain('registerModelPath(model, props.absolutePath)')
    expect(monacoEditor).toContain('registerLanguageEditor(instance, props.absolutePath)')
    expect(monacoEditor).toContain('workspace.openDocument(')
    expect(monacoEditor).toContain('workspace.changeDocument(')
    expect(monacoEditor).toContain('readOnly: props.readOnly === true')
    expect(client).toContain("new WebSocket(hostWebSocketUrl('/dsh-vscode/ws/language'")
    expect(client).toContain('SYNC_DEBOUNCE_MS')
  })

  it('disables duplicated Monaco TS language features and registers the host-backed ones', () => {
    expect(monaco).toContain('setModeConfiguration')
    for (const key of ['completionItems: false', 'hovers: false', 'documentSymbols: false', 'definitions: false', 'references: false', 'rename: false', 'diagnostics: false', 'signatureHelp: false', 'codeActions: false']) {
      expect(monaco).toContain(key)
    }
    expect(monaco).toContain('registerHoverProvider')
    expect(monaco).toContain('registerCompletionItemProvider')
    expect(monaco).toContain('registerSignatureHelpProvider')
    expect(monacoEditor).toContain('installLanguageMonaco(window.monaco)')
  })

  it('handles jump/rename/symbols/problems through the workbench quick pick and tag system', () => {
    expect(actions).toContain('registerLanguageEditor')
    expect(actions).toContain('gotoDefinition')
    expect(actions).toContain('findReferences')
    expect(actions).toContain('renameSymbol')
    expect(actions).toContain('documentSymbols')
    expect(actions).toContain('workspaceSymbols')
    expect(actions).toContain('quickFix')
    expect(actions).toContain('stepProblem')
    expect(actions).toContain("window.addEventListener('keydown', onKeyDown, true)")
    expect(actions).toContain("window.addEventListener('mousedown', onMouseDown, true)")
    expect(actions).toContain('getTargetAtClientPoint')
    expect(quickPick).toContain('onFilterChange')
    for (const id of ['language.definition', 'language.references', 'language.rename', 'language.documentSymbols', 'language.workspaceSymbols', 'language.quickFix', 'view.problems', 'problems.next', 'problems.previous']) {
      expect(keybindings).toContain(`'${id}'`)
    }
  })

  it('registers the Problems panel, status bar counts and activity badge', () => {
    expect(clientIndex).toContain("id: 'problems'")
    expect(clientIndex).toContain('installLanguageActions')
    expect(workbench).toContain('diagnosticsSnapshot.errors')
    expect(workbench).toContain('dvw-status-problem')
    expect(workbench).toContain('dvw-act-badge')
    expect(clientIndex).toContain('ProblemsPanel')
    expect(workbench).toContain("snapshot.bottomPanel==='problems'")
    expect(problems).toContain('openLocationAt')
    expect(problems).toContain('workspace.scan')
    expect(styles).toContain('PROBLEMS_STYLES')
    expect(read('src/client/problemStyles.ts')).toContain('.dvw-problems')
  })

  it('renders diagnostics as Monaco markers from the same store', () => {
    expect(diagnostics).toContain('setModelMarkers')
    expect(diagnostics).toContain('MARKER_OWNER')
    expect(diagnostics).toContain('applyMarkersForPath')
    expect(diagnostics).toContain('installMarkerHost')
  })

  it('exposes language settings in the DSH settings page and client preferences', () => {
    expect(settingsPanel).toContain('语言服务')
    expect(settingsPanel).toContain('languageHover')
    expect(settingsPanel).toContain('languageCompletion')
    expect(clientApi).toContain('language')
    expect(read('src/client/preferences.ts')).toContain('languageHover: true')
    expect(read('src/client/preferences.ts')).toContain('languageCompletion: true')
  })
})
