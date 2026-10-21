import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { absolutePathOf, baseName, isWindowsPlatform, parentPath, pathKey, samePath, workspaceRelativeOf } from '../src/client/language/paths.ts'
import { absolutePathForModel, languagePosition, languageRange, modelForPath, monacoPosition, monacoRange, registerModelPath, unregisterModel } from '../src/client/language/models.ts'
import { DiagnosticsStore, diagnosticsStoreFor, installMarkerHost, MARKER_OWNER, resetDiagnosticsStores } from '../src/client/language/diagnostics.ts'
import { LanguageWorkspace, resetActiveLanguageWorkspace, setActiveLanguageWorkspace } from '../src/client/language/client.ts'
import type { LanguageDiagnostic, LanguageInfo } from '../src/language/protocol.ts'

/**
 * 客户端语言层：路径归一化、模型登记、诊断 store、HTTP/WS 客户端。
 *
 * 这里不接真 Monaco：模型登记只用到 `uri.toString()`，标记写入用假的
 * `editor.setModelMarkers`；编辑器本身的行为由 MonacoEditor 的既有测试与真机验证覆盖。
 */
const INFO: LanguageInfo = {
  enabled: true,
  builtin: { enabled: true, state: 'ready', version: '5.9.3' },
  servers: [{ id: 'builtin-typescript', name: 'TypeScript', languages: ['typescript'], state: 'builtin' }],
  languages: ['typescript', 'javascript'],
}

const diagnostic: LanguageDiagnostic = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
  severity: 'error', message: '类型不匹配', code: 'TS2322', source: 'ts',
}

type FakeFetchCall = { url: string; body?: Record<string, unknown> }
const calls: FakeFetchCall[] = []

function fakeFetch(value: unknown): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) })
    const payload = url.endsWith('/language.info') ? INFO : value
    return { ok: true, status: 200, json: async () => ({ ok: true, value: payload, wsBase: 'http://127.0.0.1:4321' }) } as Response
  }) as typeof fetch
}

class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 1
  onmessage: ((event: { data: string }) => void) | undefined
  onclose: (() => void) | undefined
  onerror: (() => void) | undefined
  sent: string[] = []
  constructor(readonly url: string) { FakeSocket.instances.push(this) }
  send(data: string): void { this.sent.push(data) }
  close(): void { this.readyState = 3; this.onclose?.() }
  emit(message: unknown): void { this.onmessage?.({ data: JSON.stringify(message) }) }
}

describe('客户端路径与模型登记', () => {
  it('round-trips workspace paths and compares case-insensitively where appropriate', () => {
    const root = 'C:\\repo'
    const absolute = absolutePathOf(root, 'src/a.ts')
    expect(workspaceRelativeOf(root, absolute)).toBe('src/a.ts')
    expect(workspaceRelativeOf('/repo', absolutePathOf('/repo', 'src/a.ts'))).toBe('src/a.ts')
    expect(workspaceRelativeOf('/repo', '/elsewhere/a.ts')).toBeUndefined()
    expect(baseName('src/a.ts')).toBe('a.ts')
    expect(parentPath('src/a.ts')).toBe('src')
    expect(samePath('/repo/a.ts', '/repo/a.ts')).toBe(true)
    // 只有 Windows 才做大小写折叠；其它平台保持大小写敏感（与宿主文件系统一致）。
    expect(samePath('/repo/a.ts', '/repo/A.ts')).toBe(isWindowsPlatform())
    expect(pathKey('/Repo/A.ts')).toBe(isWindowsPlatform() ? '/repo/a.ts' : '/Repo/A.ts')
  })

  it('maps positions/ranges between protocol (0-based) and Monaco (1-based)', () => {
    expect(monacoPosition({ line: 2, character: 3 })).toEqual({ lineNumber: 3, column: 4 })
    expect(languagePosition({ lineNumber: 3, column: 4 })).toEqual({ line: 2, character: 3 })
    expect(monacoRange({ start: { line: 0, character: 1 }, end: { line: 0, character: 5 } }))
      .toEqual({ startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 6 })
    expect(languageRange({ startLineNumber: 1, startColumn: 2, endLineNumber: 3, endColumn: 6 }))
      .toEqual({ start: { line: 0, character: 1 }, end: { line: 2, character: 5 } })
  })

  it('looks up models by absolute path and forgets them on unregister', () => {
    const model = { uri: { toString: () => 'file:///ws/a.ts' } } as never
    registerModelPath(model, 'C:\\repo\\a.ts')
    expect(absolutePathForModel(model)).toBe('C:\\repo\\a.ts')
    expect(modelForPath('C:\\repo\\a.ts')).toBe(model)
    expect(modelForPath('c:/repo/A.TS')).toBe(model)
    unregisterModel(model)
    expect(absolutePathForModel(model)).toBeUndefined()
    expect(modelForPath('C:\\repo\\a.ts')).toBeUndefined()
  })
})

describe('诊断 store', () => {
  let store: DiagnosticsStore
  beforeEach(() => { store = new DiagnosticsStore() })
  afterEach(() => { resetDiagnosticsStores() })

  it('counts severities, sorts files and exposes status', () => {
    store.setDiagnostics('/ws/b.ts', [{ ...diagnostic, severity: 'warning', message: 'w' }])
    store.setDiagnostics('/ws/a.ts', [diagnostic, { ...diagnostic, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 2 } }, severity: 'hint', message: 'h' }])
    store.applyInfo(INFO)
    const snapshot = store.getSnapshot()
    expect(snapshot.files.map(file => file.path)).toEqual(['/ws/a.ts', '/ws/b.ts'])
    expect(snapshot.errors).toBe(1)
    expect(snapshot.warnings).toBe(1)
    expect(snapshot.hints).toBe(1)
    expect(snapshot.status?.builtin.version).toBe('5.9.3')
    expect(store.diagnosticsOf('/ws/a.ts')).toHaveLength(2)
  })

  it('ignores duplicate diagnostics and stale versions, but accepts newer ones', () => {
    const listener = vi.fn()
    store.subscribe(listener)
    store.setDiagnostics('/ws/a.ts', [diagnostic], 2)
    store.flush()
    const first = listener.mock.calls.length
    const before = store.getSnapshot().revision
    store.setDiagnostics('/ws/a.ts', [diagnostic], 2)
    // 完全相同的诊断既不入库也不通知（同一 tick 内同步检查）。
    expect(listener.mock.calls.length).toBe(first)
    expect(store.getSnapshot().revision).toBe(before)
    store.setDiagnostics('/ws/a.ts', [{ ...diagnostic, message: '旧结果' }], 1)
    expect(store.diagnosticsOf('/ws/a.ts')[0]?.message).toBe('类型不匹配')
    store.setDiagnostics('/ws/a.ts', [], 3)
    expect(store.diagnosticsOf('/ws/a.ts')).toEqual([])
  })

  it('writes Monaco markers for registered models only', () => {
    const markers: { owner: string; markers: unknown[] }[] = []
    const fakeMonaco = {
      MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
      MarkerTag: { Unnecessary: 1, Deprecated: 2 },
      editor: { setModelMarkers: (_model: unknown, owner: string, value: unknown[]) => markers.push({ owner, markers: value }) },
    }
    installMarkerHost(fakeMonaco as never)
    const model = { uri: { toString: () => 'file:///ws/a.ts' } } as never
    registerModelPath(model, '/ws/a.ts')
    store.setDiagnostics('/ws/a.ts', [diagnostic])
    const last = markers.at(-1)
    expect(last?.owner).toBe(MARKER_OWNER)
    expect(last?.markers[0]).toMatchObject({ severity: 8, message: '类型不匹配', source: 'ts', code: 'TS2322' })
    // 没登记的模型（从未打开的文件）不产生标记，也不报错。
    store.setDiagnostics('/ws/never-open.ts', [diagnostic])
    expect(markers).toHaveLength(1)
  })

  it('merges status pushes while keeping the capability set from info', () => {
    store.applyInfo(INFO)
    store.applyStatus({ type: 'status', builtin: { enabled: true, state: 'ready' }, servers: [], scan: { running: true, checked: 3, total: 0, errors: 1, warnings: 0 } })
    const snapshot = store.getSnapshot()
    expect(snapshot.status?.languages).toEqual(['typescript', 'javascript'])
    expect(snapshot.scan).toMatchObject({ running: true, checked: 3 })
  })
})

describe('语言服务客户端', () => {
  let workspace: LanguageWorkspace | undefined
  const originalFetch = globalThis.fetch
  const originalSocket = globalThis.WebSocket
  const originalWindow = (globalThis as { window?: unknown }).window

  beforeEach(() => {
    calls.length = 0
    FakeSocket.instances = []
    fakeFetch({ ok: true })
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    ;(globalThis as { window?: unknown }).window = { dispatchEvent: () => {}, addEventListener: () => {}, removeEventListener: () => {} }
    resetDiagnosticsStores()
  })

  afterEach(() => {
    workspace?.dispose()
    workspace = undefined
    resetActiveLanguageWorkspace()
    globalThis.fetch = originalFetch
    globalThis.WebSocket = originalSocket
    ;(globalThis as { window?: unknown }).window = originalWindow
  })

  it('loads info on start, opens the push socket and advertises languages', async () => {
    workspace = new LanguageWorkspace('session', '/ws')
    await workspace.start()
    expect(workspace.supportsLanguage('typescript')).toBe(true)
    expect(workspace.supportsLanguage('python')).toBe(false)
    const socket = FakeSocket.instances.at(-1)
    expect(socket?.url).toContain('/dsh-vscode/ws/language')
    expect(socket?.url).toContain('sessionId=session')
    expect(workspace.store.getSnapshot().status?.builtin.enabled).toBe(true)
  })

  it('syncs opened documents with the workspace absolute path and version', async () => {
    workspace = new LanguageWorkspace('session', '/ws')
    await workspace.start()
    workspace.openDocument('/ws/src/a.ts', 'typescript', 'const x = 1')
    await new Promise(resolve => setTimeout(resolve, 20))
    const sync = calls.find(call => call.url.endsWith('/language.sync'))
    expect(sync?.body).toMatchObject({ sessionId: 'session', kind: 'open', path: '/ws/src/a.ts', languageId: 'typescript', version: expect.any(Number), content: 'const x = 1' })
    workspace.closeDocument('/ws/src/a.ts')
    await new Promise(resolve => setTimeout(resolve, 20))
    const close = calls.filter(call => call.url.endsWith('/language.sync')).at(-1)
    expect(close?.body).toMatchObject({ kind: 'close', path: '/ws/src/a.ts' })
  })

  it('receives pushed diagnostics/status/log messages into the store', async () => {
    workspace = new LanguageWorkspace('session', '/ws')
    await workspace.start()
    const socket = FakeSocket.instances.at(-1)
    socket?.emit({ type: 'diagnostics', path: '/ws/src/a.ts', diagnostics: [diagnostic] })
    expect(workspace.store.getSnapshot().errors).toBe(1)
    socket?.emit({ type: 'status', builtin: { enabled: false, state: 'disabled' }, servers: [] })
    expect(workspace.store.getSnapshot().status?.builtin.enabled).toBe(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    socket?.emit({ type: 'log', level: 'warn', message: 'server down' })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('applies workspace edits to open models and asks the host for the rest', async () => {
    const applied: unknown[] = []
    const model = {
      uri: { toString: () => 'file:///ws/src/a.ts' },
      pushEditOperations: (_selections: unknown[], edits: unknown[], _cursor: unknown) => { applied.push(edits); return null },
    } as never
    registerModelPath(model, '/ws/src/a.ts')
    fakeFetch({ ok: true })
    workspace = new LanguageWorkspace('session', '/ws')
    await workspace.start()
    const result = await workspace.applyEdit({
      changes: [
        { path: '/ws/src/a.ts', edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'b' }] },
        { path: '/ws/src/closed.ts', edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'x' }] },
      ],
    })
    expect(result.appliedModels).toEqual(['/ws/src/a.ts'])
    expect(applied).toHaveLength(1)
    const write = calls.find(call => call.url.endsWith('/language.applyEdit'))
    expect(write?.body).toMatchObject({ edit: { changes: [{ path: '/ws/src/closed.ts' }] } })
    unregisterModel(model)
  })

  it('registers itself as the active workspace and clears on dispose', async () => {
    const value = new LanguageWorkspace('session', '/ws')
    workspace = value
    setActiveLanguageWorkspace(value)
    await value.start()
    value.store.applyInfo(INFO)
    value.dispose()
    expect(value.store.getSnapshot().files).toEqual([])
  })
})
