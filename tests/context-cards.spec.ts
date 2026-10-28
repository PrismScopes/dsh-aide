import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addContextCard,
  installContextCards,
  resetContextCardsForTests,
  serializeContextPayload,
  serializeProblems,
  setContextCardScope,
} from '../src/client/contextCards.ts'
import { diagnosticsStoreFor, resetDiagnosticsStores } from '../src/client/language/diagnostics.ts'

/**
 * 输入框上下文卡片的核心测试。
 *
 * 真正的 DSH composer 服务在 node 里不存在，这里用最小的结构替身验证：
 * - 问题/文件/选区在发送时如何序列化成模型可读的文本；
 * - 插入 chip 时拿到的 span（草稿末尾、按 occurrence 扣除 chip 的 detect 宽度）与 ref payload；
 * - `@` 候选源注册与候选内容。
 * 运行时由 DSH 的 sessions/conversation/inputTriggers 三个服务提供真实实现。
 */

const WS = '/ws'
const A = `${WS}/src/a.ts`

function seedDiagnostics(): void {
  diagnosticsStoreFor(WS).setDiagnostics(A, [
    { severity: 'error', message: '类型“string”不能赋给“number”', range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } }, source: 'ts', code: '2322' },
    { severity: 'warning', message: '变量已声明但从未读取', range: { start: { line: 4, character: 0 }, end: { line: 4, character: 3 } }, source: 'ts', code: '6133' },
  ])
  diagnosticsStoreFor(WS).flush()
}

interface InsertCall { ref: string; span: { start: number; end: number; draftRev: number } }

function fakeServices(state: { draft: string; draftRev: number; occurrences?: { length: number }[] }) {
  const calls: InsertCall[] = []
  const sources: unknown[] = []
  const facade = {
    state: { getSnapshot: () => state },
    insertReference: (ref: { ref: string }, span: InsertCall['span']) => { calls.push({ ref: ref.ref, span }); return true },
  }
  const ctx = {
    reflect: {
      get: (name: string) => {
        if (name === 'inputTriggers') return { registerSource: (source: unknown) => { sources.push(source); return () => { /* dispose */ } } }
        if (name === 'sessions') return { scope: (id: string) => ({ id }) }
        if (name === 'conversation') return { input: { for: () => facade } }
        return undefined
      },
    },
    effect: (callback: () => void) => { callback() },
  }
  return { ctx, calls, sources }
}

describe('context card serialization', () => {
  beforeEach(() => { resetDiagnosticsStores(); seedDiagnostics(); setContextCardScope({ sessionId: 's1', cwd: WS, activePath: 'src/a.ts' }) })
  afterEach(() => { resetDiagnosticsStores(); resetContextCardsForTests() })

  it('serializes current-file problems from the live store', () => {
    const text = serializeProblems({ cwd: WS, scope: 'file', path: A })
    expect(text).toContain('当前文件诊断（2 条）')
    expect(text).toContain(`${A}:3:5 [error] 类型“string”不能赋给“number” (ts:2322)`)
    expect(text).toContain(`${A}:5:1 [warning] 变量已声明但从未读取 (ts:6133)`)
  })

  it('serializes files as @path and selections as quoted code', async () => {
    await expect(serializeContextPayload({
      kind: 'file', label: '文件 · a.ts', clipboardText: '@src/a.ts', cwd: WS, path: A, appearance: 'file',
    })).resolves.toBe('@src/a.ts')
    const selection = await serializeContextPayload({
      kind: 'selection', label: '选区 · a.ts', clipboardText: '选区', cwd: WS, path: 'src/a.ts',
      lineStart: 2, lineEnd: 3, language: 'typescript', text: 'const x = 1',
    })
    expect(selection).toContain('引用自 `src/a.ts:2-3`')
    expect(selection).toContain('const x = 1')
  })
})

describe('addContextCard', () => {
  beforeEach(() => { resetDiagnosticsStores(); seedDiagnostics(); setContextCardScope({ sessionId: 's1', cwd: WS, activePath: 'src/a.ts' }) })
  afterEach(() => { resetDiagnosticsStores(); resetContextCardsForTests() })

  it('inserts a chip at the draft end and carries a type-only payload', async () => {
    const { ctx, calls } = fakeServices({ draft: 'hello', draftRev: 7 })
    installContextCards(ctx)
    await expect(addContextCard({ kind: 'problems', scope: 'workspace' }, 's1')).resolves.toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.span).toEqual({ start: 5, end: 5, draftRev: 7 })
    const payload = JSON.parse(calls[0]!.ref) as { kind: string; scope: string; cwd: string }
    expect(payload).toMatchObject({ kind: 'problems', scope: 'workspace', cwd: WS })
  })

  it('accounts for chip width when computing the detect offset', async () => {
    const { ctx, calls } = fakeServices({ draft: 'hi @src/a.ts', draftRev: 9, occurrences: [{ length: 9 }] })
    installContextCards(ctx)
    await addContextCard({ kind: 'file', path: 'src/a.ts' }, 's1')
    expect(calls[0]!.span).toEqual({ start: 4, end: 4, draftRev: 9 })
  })

  it('registers an @ source whose candidates expose file and problem contexts', async () => {
    const { ctx, sources } = fakeServices({ draft: '', draftRev: 1 })
    installContextCards(ctx)
    expect(sources).toHaveLength(1)
    const source = sources[0] as { candidates(): Promise<{ name: string; value?: string }[]> }
    const candidates = await source.candidates()
    expect(candidates.map(candidate => candidate.name)).toContain('文件 · a.ts')
    expect(candidates.some(candidate => candidate.name.startsWith('当前文件问题'))).toBe(true)
    expect(candidates.some(candidate => candidate.name.startsWith('工作区问题'))).toBe(true)
    expect(candidates.every(candidate => typeof candidate.value === 'string')).toBe(true)
  })
})
