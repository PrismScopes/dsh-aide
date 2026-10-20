import { describe, expect, it } from 'vitest'
import type { MenuEntry, MenuItem } from '../src/client/ContextMenu.tsx'
import type { DshAskKind } from '../src/client/dshChat.ts'
import { dshMenuEntries, type DshMenuActions, type DshMenuContext } from '../src/client/dshMenus.ts'

/** 只挑出可点的菜单项（跳过分隔线），便于按顺序断言。 */
function items(entries: readonly MenuEntry[]): MenuItem[] {
  return entries.filter((entry): entry is MenuItem => entry.kind === 'item')
}

/** 记录动作调用的假 actions：菜单数据只依赖这个接口，不需要真的连 DSH。 */
function fakeActions(): { calls: string[]; actions: DshMenuActions } {
  const calls: string[] = []
  return {
    calls,
    actions: {
      addToConversation: () => { calls.push('add') },
      ask: (kind: DshAskKind) => { calls.push(`ask:${kind}`) },
      copyQuote: () => { calls.push('copy') },
    },
  }
}

function context(overrides: Partial<Omit<DshMenuContext, 'actions'>> = {}, actions = fakeActions().actions): DshMenuContext {
  return { hasSelection: true, available: true, ...overrides, actions }
}

describe('dsh menu entries', () => {
  it('lists the expected items in a stable order, grouped by separators', () => {
    const entries = dshMenuEntries(context())
    expect(items(entries).map(entry => entry.id)).toEqual([
      'dsh-add',
      'dsh-ask',
      'dsh-explain',
      'dsh-fix',
      'dsh-refactor',
      'dsh-tests',
      'dsh-comment',
      'dsh-review',
      'dsh-copy-quote',
    ])
    // 分隔线把「添加至对话」「询问动作」「复制为引用」分成三组。
    expect(entries.map(entry => entry.kind)).toEqual([
      'item', 'separator',
      'item', 'item', 'item', 'item', 'item', 'item', 'item',
      'separator',
      'item',
    ])
  })

  it('uses Chinese labels', () => {
    const entries = dshMenuEntries(context())
    expect(items(entries).map(entry => entry.label)).toEqual([
      '添加至对话',
      '询问 DSH…',
      '解释这段代码',
      '修复这段代码',
      '重构这段代码',
      '生成单元测试',
      '添加注释',
      '审查这段代码',
      '复制为引用',
    ])
    for (const entry of items(entries)) {
      // 菜单全中文：每个 label 都要有汉字（「询问 DSH…」里的 DSH 是服务名，保留原文）。
      expect(entry.label).toMatch(/[\u4e00-\u9fa5]/)
    }
  })

  it('gives every item a distinct icon that matches the agreed table', () => {
    const entries = items(dshMenuEntries(context()))
    // 用户反馈：旧版 sparkle×3 / edit×3 / check×2 看起来像没做完 —— 9 项必须互不重复。
    const icons = entries.map(entry => entry.icon)
    expect(new Set(icons).size).toBe(icons.length)
    expect(Object.fromEntries(entries.map(entry => [entry.id, entry.icon]))).toEqual({
      'dsh-add': 'comment-discussion',
      'dsh-ask': 'comment',
      'dsh-explain': 'book',
      'dsh-fix': 'wrench',
      'dsh-refactor': 'tools',
      'dsh-tests': 'beaker',
      'dsh-comment': 'note',
      'dsh-review': 'checklist',
      'dsh-copy-quote': 'quote',
    })
    // 父项仍用 sparkle，不在这 9 项里重复。
    expect(icons).not.toContain('sparkle')
  })

  it('disables every selection action without a selection', () => {
    const entries = items(dshMenuEntries(context({ hasSelection: false })))
    expect(entries.every(entry => entry.disabled === true)).toBe(true)
  })

  it('keeps only the clipboard action enabled when the chat column is unavailable', () => {
    const entries = items(dshMenuEntries(context({ available: false })))
    const enabled = entries.filter(entry => entry.disabled !== true).map(entry => entry.id)
    // 复制引用不碰对话栏：对话栏不可用时它仍然是用户的退路。
    expect(enabled).toEqual(['dsh-copy-quote'])
  })

  it('enables everything with a selection and an available chat column', () => {
    const entries = items(dshMenuEntries(context()))
    expect(entries.every(entry => entry.disabled !== true)).toBe(true)
  })

  it('binds every item to the matching action', () => {
    const { calls, actions } = fakeActions()
    for (const entry of items(dshMenuEntries(context({}, actions)))) entry.onSelect()
    expect(calls).toEqual([
      'add',
      'ask:ask',
      'ask:explain',
      'ask:fix',
      'ask:refactor',
      'ask:tests',
      'ask:comment',
      'ask:review',
      'copy',
    ])
  })
})
