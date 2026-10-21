import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  MAX_STORED_OPEN_TABS,
  openTabsKey,
  parseStoredOpenTabs,
  restorableOpenTabs,
  restorablePath,
  serializeOpenTabs,
  storableTab,
} from '../src/client/openTabs.ts'

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

describe('打开标签的持久化', () => {
  it('keys the stored tab list by workspace root', () => {
    expect(openTabsKey('H:\\repo')).toBe('dvw:open-tabs:v1:H:\\repo')
    expect(openTabsKey('/home/me/repo')).toBe('dvw:open-tabs:v1:/home/me/repo')
  })

  it('only stores tabs that can be restored faithfully', () => {
    expect(storableTab({ path: 'src/a.ts' })).toBe(true)
    // 差异标签是内容快照，恢复出来只会是过期副本。
    expect(storableTab({ path: 'diff:src/a.ts' })).toBe(false)
    // 脏标签的草稿不落库（正文过期比「重开时没有这个标签」更糟）。
    expect(storableTab({ path: 'src/a.ts', dirty: true })).toBe(false)
  })

  it('serializes paths, order, caret position and virtual-tab flags without any content', () => {
    const stored = serializeOpenTabs([
      { path: 'src/a.ts', line: 12, column: 3 },
      { path: 'git:graph', title: '提交图', graphAll: true },
      { path: 'src/b.ts' },
      { path: 'src/a.ts' },
      { path: 'src/c.ts', dirty: true },
      { path: 'diff:src/a.ts' },
    ], 'src/b.ts')
    expect(stored).toEqual({
      tabs: [
        { path: 'src/a.ts', line: 12, column: 3 },
        { path: 'git:graph', title: '提交图', graphAll: true },
        { path: 'src/b.ts' },
      ],
      active: 'src/b.ts',
    })
  })

  it('drops the active tab from the payload when it cannot be stored', () => {
    const stored = serializeOpenTabs([{ path: 'src/a.ts' }, { path: 'src/dirty.ts', dirty: true }], 'src/dirty.ts')
    expect(stored).toEqual({ tabs: [{ path: 'src/a.ts' }] })
    expect(stored.active).toBeUndefined()
  })

  it('caps the stored list so localStorage cannot grow without bound', () => {
    const many = Array.from({ length: MAX_STORED_OPEN_TABS + 10 }, (_item, index) => ({ path: `src/${index}.ts` }))
    expect(serializeOpenTabs(many).tabs).toHaveLength(MAX_STORED_OPEN_TABS)
  })

  it('treats malformed storage as "never stored" instead of half-restoring it', () => {
    expect(parseStoredOpenTabs(null)).toBeUndefined()
    expect(parseStoredOpenTabs('')).toBeUndefined()
    expect(parseStoredOpenTabs('not json')).toBeUndefined()
    expect(parseStoredOpenTabs('[]')).toBeUndefined()
    expect(parseStoredOpenTabs('{"tabs":"nope"}')).toBeUndefined()
    // 单个坏条目丢掉，其他照常恢复。
    expect(parseStoredOpenTabs('{"tabs":[{"path":7},{"path":"src/a.ts","line":"x"}],"active":3}')).toEqual({
      tabs: [{ path: 'src/a.ts' }],
    })
  })

  it('rejects paths that could escape the workspace or are not real files', () => {
    const virtual = ['git:graph']
    expect(restorablePath('src/a.ts', virtual)).toBe(true)
    expect(restorablePath('git:graph', virtual)).toBe(true)
    expect(restorablePath('src/../secret.txt', virtual)).toBe(false)
    expect(restorablePath('..\\secret.txt', virtual)).toBe(false)
    expect(restorablePath('/etc/passwd', virtual)).toBe(false)
    expect(restorablePath('C:\\Windows\\win.ini', virtual)).toBe(false)
    expect(restorablePath('diff:src/a.ts', virtual)).toBe(false)
    expect(restorablePath('git:output', virtual)).toBe(false)
    // 其它虚拟标签同样只认白名单里列出来的。
    expect(restorablePath('dino:game', ['dino:game'])).toBe(true)
    expect(restorablePath('', virtual)).toBe(false)
    expect(restorablePath('a'.repeat(5000), virtual)).toBe(false)
  })

  it('restores in order and falls back to the first tab when the active one is gone', () => {
    const restored = restorableOpenTabs({
      tabs: [{ path: 'src/a.ts' }, { path: '../evil.ts' }, { path: 'src/b.ts', line: 4 }, { path: 'src/a.ts' }],
      active: '../evil.ts',
    }, [])
    expect(restored.tabs).toEqual([{ path: 'src/a.ts' }, { path: 'src/b.ts', line: 4 }])
    expect(restored.active).toBeUndefined()
    expect(restorableOpenTabs(undefined, []).tabs).toEqual([])
  })

  it('keeps the tab bar across hide/show and reloads it from the workspace key', () => {
    // 回归点：以前「返回 DSH」再进来时工作台每个 visible=true 都清空一次标签，打开的文件全丢。
    const source = read('../src/client/Workbench.tsx')
    expect(source).toContain('serializeOpenTabs(tabs,active)')
    expect(source).toContain('restorableOpenTabs(stored')
    expect(source).toContain('readStoredOpenTabs(root)')
    expect(source).not.toContain('resetWorkspaceDocuments')
  })
})
