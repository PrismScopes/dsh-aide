import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorkspaceWatch, createFilesChangedBatcher, FILES_CHANGED_FLUSH_MS, type FilesChangedMessage } from '../src/routes.ts'
import { RESCAN_EVENT } from '../src/watch.ts'

function fake(){return{closeCalls:0,listeners:0,on(){this.listeners++},off(){this.listeners--},close(){this.closeCalls++}}}
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))

describe('files.changed batching', () => {
  const workspace = process.platform === 'win32' ? 'C:\\repo' : '/repo'

  it('coalesces normal events for 150ms, dedupes relative paths and omits reload', () => {
    vi.useFakeTimers()
    try {
      const sent: FilesChangedMessage[] = []
      const batcher = createFilesChangedBatcher(workspace, message => sent.push(message))
      batcher.push('change', join(workspace, 'src', 'a.ts'))
      batcher.push('change', join(workspace, 'src', 'a.ts'))
      batcher.push('rename', join(workspace, 'src', 'b.ts'))
      expect(sent).toEqual([])
      vi.advanceTimersByTime(FILES_CHANGED_FLUSH_MS - 1)
      expect(sent).toEqual([])
      vi.advanceTimersByTime(1)
      expect(sent).toEqual([{ type: 'files.changed', paths: ['src/a.ts', 'src/b.ts'] }])
      expect('reload' in (sent[0] as object)).toBe(false)
    } finally { vi.useRealTimers() }
  })

  it('sends reload:true with empty paths on rescan and resets the flag after each flush', () => {
    vi.useFakeTimers()
    try {
      const sent: FilesChangedMessage[] = []
      const batcher = createFilesChangedBatcher(workspace, message => sent.push(message))
      batcher.push(RESCAN_EVENT, '')
      vi.advanceTimersByTime(FILES_CHANGED_FLUSH_MS)
      expect(sent).toEqual([{ type: 'files.changed', paths: [], reload: true }])
      batcher.push('change', join(workspace, 'x.ts'))
      vi.advanceTimersByTime(FILES_CHANGED_FLUSH_MS)
      expect(sent[1]).toEqual({ type: 'files.changed', paths: ['x.ts'] })
      expect('reload' in (sent[1] as object)).toBe(false)
    } finally { vi.useRealTimers() }
  })

  it('dispose cancels a pending flush', () => {
    vi.useFakeTimers()
    try {
      const sent: FilesChangedMessage[] = []
      const batcher = createFilesChangedBatcher(workspace, message => sent.push(message))
      batcher.push('change', join(workspace, 'x.ts'))
      batcher.dispose()
      vi.advanceTimersByTime(1_000)
      expect(sent).toEqual([])
    } finally { vi.useRealTimers() }
  })

  it('client dispatches reload as a detail-less rescan event (static contract)', () => {
    const source = readFileSync(new URL('../src/client/Workbench.tsx', import.meta.url), 'utf8')
    expect(source).toContain('reload = message.reload === true')
    expect(source).toContain("reload ? new CustomEvent('dvw-files-changed') : new CustomEvent('dvw-files-changed', { detail: paths })")
    // Tree 用 detail === undefined 判断「整体重扫」；CustomEvent 显式 detail:undefined 会变 null，必须覆盖。
    expect(source).toContain("Object.defineProperty(changed, 'detail', { value: undefined, configurable: true })")
  })
})

describe('shared workspace watcher',()=>{
  it('shares one watcher per workspace and counts users',()=>{
    let made=0
    const watches=new WorkspaceWatch(()=>{made++;return fake()})
    const first=watches.acquire('H:/repo')
    const second=watches.acquire('H:/repo')
    expect(first).toBe(second)
    expect(made).toBe(1)
    expect(watches.size()).toBe(1)
    watches.release('H:/repo')
    expect(watches.size()).toBe(1)
  })

  it('closes the watcher once the last user is gone and the grace period passes',async()=>{
    let watcher:ReturnType<typeof fake>|undefined
    const watches=new WorkspaceWatch(()=>{watcher=fake();return watcher},20)
    watches.acquire('H:/repo')
    watches.release('H:/repo')
    expect(watcher?.closeCalls).toBe(0)
    await wait(80)
    expect(watcher?.closeCalls).toBe(1)
    expect(watches.size()).toBe(0)
  })

  it('reuses the watcher when it is reacquired during the grace period',async()=>{
    let made=0
    let watcher:ReturnType<typeof fake>|undefined
    const watches=new WorkspaceWatch(()=>{made++;watcher=fake();return watcher},60)
    const first=watches.acquire('H:/repo')
    watches.release('H:/repo')
    await wait(20)
    const second=watches.acquire('H:/repo')
    await wait(120)
    expect(second).toBe(first)
    expect(made).toBe(1)
    expect(watcher?.closeCalls).toBe(0)
    expect(watches.size()).toBe(1)
  })

  it('keeps watchers for different workspaces apart and closes all on teardown',()=>{
    const created:ReturnType<typeof fake>[]=[]
    const watches=new WorkspaceWatch(()=>{const watcher=fake();created.push(watcher);return watcher})
    watches.acquire('H:/a')
    watches.acquire('H:/b')
    expect(created).toHaveLength(2)
    expect(watches.size()).toBe(2)
    watches.closeAll()
    expect(created.every(watcher=>watcher.closeCalls===1)).toBe(true)
    expect(watches.size()).toBe(0)
  })

  it('ignores a release for a workspace it does not hold',()=>{
    const watches=new WorkspaceWatch(()=>fake())
    expect(()=>watches.release('H:/none')).not.toThrow()
    expect(watches.size()).toBe(0)
  })
})
