import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchController } from '../src/client/service.ts'
import {
  contributionEntries,
  editorMenuContributions,
  registerEditorMenuContribution,
  resetEditorMenuContributions,
  subscribeEditorMenuContributions,
  type EditorMenuTarget,
} from '../src/client/editorMenuRegistry.ts'
import { separator, type MenuEntry } from '../src/client/ContextMenu.tsx'

/**
 * 编辑器右键菜单扩展点的测试。
 *
 * 这个注册表是「以后加功能不必改 MonacoEditor.tsx」的关键：DSH 子菜单、后续适配器都往这里注册。
 * 这里钉住注册/注销、顺序稳定、空组跳过、分隔线只出现在组之间、单个贡献者报错不连累整张菜单，
 * 以及工作台服务把能力暴露给其它插件。
 */
const target: EditorMenuTarget = { language: 'typescript', hasSelection: true, selectionText: 'const a = 1', lineStart: 3, lineEnd: 3 }

const item = (id: string): MenuEntry => ({ kind: 'item', id, label: `项-${id}`, onSelect: () => {} })
const shape = (entries: readonly MenuEntry[]): string[] => entries.map(entry => entry.kind === 'separator' ? '---' : entry.id)

afterEach(() => { resetEditorMenuContributions() })

describe('editor menu contributions', () => {
  it('registers, lists and unregisters contributions', () => {
    expect(editorMenuContributions()).toEqual([])
    const dispose = registerEditorMenuContribution({ id: 'dsh', entries: () => [item('dsh-add')] })
    expect(editorMenuContributions().map(entry => entry.id)).toEqual(['dsh'])
    dispose()
    expect(editorMenuContributions()).toEqual([])
    // 注销两次是安全的（菜单贡献可能在插件卸载与热重载时重复调用）。
    dispose()
    expect(editorMenuContributions()).toEqual([])
  })

  it('rejects duplicate ids and empty ids instead of silently overwriting', () => {
    registerEditorMenuContribution({ id: 'dsh', entries: () => [] })
    expect(() => registerEditorMenuContribution({ id: 'dsh', entries: () => [] })).toThrowError(/already registered/)
    expect(() => registerEditorMenuContribution({ id: '', entries: () => [] })).toThrowError(/must not be empty/)
  })

  it('keeps a stable order: explicit order first, then id', () => {
    registerEditorMenuContribution({ id: 'z-late', order: 20, entries: () => [item('z')] })
    registerEditorMenuContribution({ id: 'b-default', entries: () => [item('b')] })
    registerEditorMenuContribution({ id: 'a-default', entries: () => [item('a')] })
    registerEditorMenuContribution({ id: 'early', order: -10, entries: () => [item('e')] })
    expect(editorMenuContributions().map(entry => entry.id)).toEqual(['early', 'a-default', 'b-default', 'z-late'])
  })

  it('joins groups with one separator and skips empty groups', () => {
    registerEditorMenuContribution({ id: 'empty', entries: () => [] })
    registerEditorMenuContribution({ id: 'first', entries: () => [item('a'), item('b')] })
    registerEditorMenuContribution({ id: 'second', entries: () => [item('c')] })
    expect(shape(contributionEntries(target))).toEqual(['a', 'b', '---', 'c'])
    // 只有一组时不应多出首尾分隔线。
    resetEditorMenuContributions()
    registerEditorMenuContribution({ id: 'only', entries: () => [item('a')] })
    expect(shape(contributionEntries(target))).toEqual(['a'])
  })

  it('separates top placements from bottom placements', () => {
    // 「DeepSeek Harness」要求置顶；普通适配器默认追加在标准编辑项之后。
    registerEditorMenuContribution({ id: 'dsh', place: 'top', order: -100, entries: () => [item('dsh')] })
    registerEditorMenuContribution({ id: 'bottom-default', entries: () => [item('bottom')] })
    expect(shape(contributionEntries(target, 'top'))).toEqual(['dsh'])
    expect(shape(contributionEntries(target, 'bottom'))).toEqual(['bottom'])
    // 缺省是 bottom，旧调用方不传 place 时行为不变。
    expect(shape(contributionEntries(target))).toEqual(['bottom'])
  })

  it('passes the editor target to each contribution', () => {
    const seen: EditorMenuTarget[] = []
    registerEditorMenuContribution({ id: 'spy', entries: value => { seen.push(value); return [item('a')] } })
    contributionEntries(target)
    expect(seen).toEqual([target])
  })

  it('skips a throwing contribution so the rest of the menu still works', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      registerEditorMenuContribution({ id: 'broken', order: 1, entries: () => { throw new Error('boom') } })
      registerEditorMenuContribution({ id: 'good', order: 2, entries: () => [item('ok')] })
      expect(shape(contributionEntries(target))).toEqual(['ok'])
      expect(warn).toHaveBeenCalled()
    } finally { warn.mockRestore() }
  })

  it('notifies subscribers when contributions change', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeEditorMenuContributions(listener)
    const dispose = registerEditorMenuContribution({ id: 'dsh', entries: () => [separator(), item('a')] })
    expect(listener).toHaveBeenCalledTimes(1)
    dispose()
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    registerEditorMenuContribution({ id: 'other', entries: () => [item('b')] })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('exposes the extension point on the workbench service for other plugins', () => {
    const service = new WorkbenchController(undefined)
    const dispose = service.registerEditorMenuContribution({ id: 'third-party', entries: () => [item('x')] })
    expect(editorMenuContributions().map(entry => entry.id)).toEqual(['third-party'])
    dispose()
    expect(editorMenuContributions()).toEqual([])
  })
})
