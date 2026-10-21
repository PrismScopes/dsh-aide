import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createExternalProvider, type ExternalProviderOptions } from '../src/language/lsp/external.ts'
import type { LanguageDiagnostic } from '../src/language/protocol.ts'
import type { LanguageProvider } from '../src/language/provider.ts'
import type { DetectedServer } from '../src/language/servers.ts'

const fixturePath = fileURLToPath(new URL('./fixtures/fake-lsp-server.mjs', import.meta.url))
const roots: string[] = []
const providers: LanguageProvider[] = []

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dvw-lsp-ext-'))
  roots.push(root)
  return root
}

/** Windows 上子进程退出前仍持有 cwd 句柄，rmdir 会短暂 EBUSY：重试到它真正退出。 */
async function removeRoot(root: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rm(root, { recursive: true, force: true }); return }
    catch (error) {
      if (attempt >= 40) throw error
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
}

afterEach(async () => {
  for (const provider of providers.splice(0)) { try { await provider.dispose() } catch { /* 已停用 */ } }
  await Promise.all(roots.splice(0).map(removeRoot))
})

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** 用当前 Node 解释器跑 fixtures 里的假服务器，确保真实子进程 + 真实 stdio 帧。 */
function fakeServer(overrides: Partial<DetectedServer['definition']> = {}): DetectedServer {
  const definition = {
    id: 'fake-lsp',
    name: 'Fake LSP',
    languages: ['python'],
    extensions: ['py'],
    command: process.execPath,
    args: [fixturePath],
    ...overrides,
  }
  return {
    id: definition.id,
    name: definition.name,
    languages: definition.languages,
    extensions: definition.extensions,
    executable: process.execPath,
    args: [fixturePath],
    definition,
  }
}

interface TestProvider {
  provider: LanguageProvider
  pushes: Array<{ path: string; diagnostics: readonly LanguageDiagnostic[] }>
  logs: Array<{ level: 'info' | 'warn' | 'error'; message: string }>
}

function createTestProvider(workspace: string, options: Partial<ExternalProviderOptions> = {}): TestProvider {
  const pushes: TestProvider['pushes'] = []
  const logs: TestProvider['logs'] = []
  const provider = createExternalProvider({
    workspace,
    server: fakeServer(),
    env: { DSH_FAKE_LSP_EXIT_FILE: join(workspace, '.lsp-exited') },
    onLog: (level, message) => logs.push({ level, message }),
    onDiagnostics: (path, diagnostics) => pushes.push({ path, diagnostics: [...diagnostics] }),
    ...options,
  })
  providers.push(provider)
  return { provider, pushes, logs }
}

describe('external LSP provider', () => {
  it('runs a real LSP server: diagnostics, hover, definition, references, rename and symbols', async () => {
    const root = await temp()
    const sample = join(root, 'sample.py')
    await writeFile(sample, 'x = 1\n')
    const marker = join(root, '.lsp-exited')
    const { provider, pushes, logs } = createTestProvider(root, {
      env: { DSH_FAKE_LSP_EXIT_FILE: marker, DSH_FAKE_LSP_STDERR: 'fake server ready' },
    })

    expect(provider.info).toMatchObject({ id: 'fake-lsp', name: 'Fake LSP', kind: 'external', languages: ['python'] })

    provider.openDocument({ path: sample, languageId: 'python', version: 1, content: 'x = 1\n' })
    await waitFor(() => pushes.length > 0)
    // stderr 按行回调进日志（provider 会加上服务器 id 前缀）。
    await waitFor(() => logs.some(entry => entry.message.includes('fake server ready')))
    expect(logs.find(entry => entry.message.includes('fake server ready'))?.level).toBe('info')
    const published = pushes.find(entry => entry.path === sample)
    expect(published).toBeDefined()
    expect(published!.diagnostics[0]).toMatchObject({ severity: 'error', code: '4242', source: 'fake', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } })
    // 正文里带 languageId、version 与中文，验证 didOpen 载荷与 UTF-8 帧解码。
    expect(published!.diagnostics[0]!.message).toContain('python')
    expect(published!.diagnostics[0]!.message).toContain('v1')
    expect(published!.diagnostics[0]!.message).toContain('中文')

    // workspaceFolders 由 initialize 传给服务器；假服务器把它塞进 hover 文本。
    const hover = await provider.hover!(sample, { line: 0, character: 0 })
    expect(hover?.contents).toContain('fake hover')
    expect(hover?.contents).toContain('folders:1')
    expect(hover?.range).toMatchObject({ start: { line: 0, character: 0 }, end: { line: 0, character: 5 } })

    const definitions = await provider.definition!(sample, { line: 0, character: 0 })
    expect(definitions).toHaveLength(1)
    expect(definitions[0]!.path).toBe(join(root, 'target.py'))
    expect(definitions[0]!.range.start.line).toBe(2)

    const references = await provider.references!(sample, { line: 0, character: 0 })
    expect(references).toHaveLength(1)
    expect(references[0]!.path).toBe(sample)

    const rename = await provider.rename!(sample, { line: 0, character: 0 }, 'renamed')
    expect(rename.canRename).toBe(true)
    expect(rename.edit?.changes).toHaveLength(1)
    expect(rename.edit?.changes[0]!.path).toBe(sample)
    expect(rename.edit?.changes[0]!.edits[0]).toEqual({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: 'renamed' })

    const symbols = await provider.documentSymbols!(sample)
    expect(symbols[0]).toMatchObject({ name: 'fakeSymbol', kind: 'function', detail: 'detail' })
    expect(symbols[0]!.children?.[0]).toMatchObject({ name: 'fakeChild', kind: 'variable' })

    const workspaceSymbols = await provider.workspaceSymbols!('fake', 10)
    expect(workspaceSymbols).toHaveLength(1)
    expect(workspaceSymbols[0]).toMatchObject({ name: 'fakeWorkspaceSymbol', kind: 'function', containerName: 'module', path: sample })

    const completion = await provider.completion!(sample, { line: 0, character: 3 }, '.')
    expect(completion?.incomplete).toBe(true)
    const item = completion?.items[0]
    expect(item).toMatchObject({ label: 'fakeCompletion', kind: 'function', detail: 'detail text', documentation: 'doc text', insertText: 'fakeCompletion', sortText: '1' })
    expect(item?.replaceRange).toEqual({ start: { line: 0, character: 0 }, end: { line: 0, character: 3 } })
    expect(item?.additionalEdits?.[0]).toEqual({ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, newText: 'import fake\n' })

    const signature = await provider.signatureHelp!(sample, { line: 0, character: 2 })
    expect(signature?.signatures[0]?.label).toBe('fake(a: int)')
    expect(signature?.signatures[0]?.documentation).toBe('sig doc')
    expect(signature?.signatures[0]?.parameters).toEqual([{ label: 'a: in' }, { label: 'b' }])
    expect(signature?.activeSignature).toBe(0)

    const actions = await provider.codeActions!(sample, { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, published!.diagnostics)
    expect(actions).toHaveLength(1) // 只有 command 的动作会被丢弃
    expect(actions[0]).toMatchObject({ title: 'Fake quick fix', kind: 'quickfix', isPreferred: true })
    expect(actions[0]!.edit?.changes[0]!.edits[0]!.newText).toBe('fixed')

    // didChange 走全量同步：服务器按新版本再推一次诊断。
    provider.changeDocument({ path: sample, languageId: 'python', version: 2, content: 'y = 2\n' })
    await waitFor(() => pushes.some(entry => entry.path === sample && entry.diagnostics.some(diagnostic => diagnostic.message.includes('v2'))))
    const changed = pushes.filter(entry => entry.path === sample).at(-1)!
    expect(changed.diagnostics[0]!.message).toContain('y = 2')

    // closeDocument 之后该文件没有新的诊断推送（服务器端 didClose 清掉文档）。
    const pushCountBeforeClose = pushes.filter(entry => entry.path === sample).length
    provider.closeDocument(sample)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(pushes.filter(entry => entry.path === sample)).toHaveLength(pushCountBeforeClose)

    await provider.dispose()
    await waitFor(() => existsSync(marker))
    expect((provider as unknown as { state: string }).state).toBe('disabled')
    expect(logs.filter(entry => entry.level === 'error')).toEqual([])
  })

  it('reports startup failure without throwing', async () => {
    const root = await temp()
    const missingCommand = join(root, 'missing-lsp-binary')
    const logs: TestProvider['logs'] = []
    const provider = createExternalProvider({
      workspace: root,
      server: {
        id: 'missing-lsp',
        name: 'Missing LSP',
        languages: ['python'],
        extensions: ['py'],
        executable: missingCommand,
        args: [],
        definition: { id: 'missing-lsp', name: 'Missing LSP', languages: ['python'], extensions: ['py'], command: missingCommand, args: [] },
      },
      env: { DSH_FAKE_LSP_EXIT_FILE: join(root, '.lsp-exited') },
      onLog: (level, message) => logs.push({ level, message }),
      onDiagnostics: () => undefined,
    })
    providers.push(provider)
    provider.openDocument({ path: join(root, 'a.py'), languageId: 'python', version: 1, content: '' })
    await waitFor(() => logs.some(entry => entry.level === 'error'))
    expect((provider as unknown as { state: string }).state).toBe('failed')
    // 启动失败后继续调用语言特性只降级成空结果，不抛异常。
    await expect(provider.hover!(join(root, 'a.py'), { line: 0, character: 0 })).resolves.toBeNull()
    await expect(provider.definition!(join(root, 'a.py'), { line: 0, character: 0 })).resolves.toEqual([])
    await expect(provider.dispose()).resolves.toBeUndefined()
  })

  it('returns a non-applicable rename result when the server is unavailable', async () => {
    const root = await temp()
    const missingCommand = join(root, 'missing-rename-binary')
    const provider = createExternalProvider({
      workspace: root,
      server: {
        id: 'missing-rename',
        name: 'Missing Rename',
        languages: ['python'],
        extensions: ['py'],
        executable: missingCommand,
        args: [],
        definition: { id: 'missing-rename', name: 'Missing Rename', languages: ['python'], extensions: ['py'], command: missingCommand, args: [] },
      },
      onDiagnostics: () => undefined,
    })
    providers.push(provider)
    await expect(provider.rename!(join(root, 'a.py'), { line: 0, character: 0 }, 'x')).resolves.toMatchObject({ canRename: false })
  })
})
