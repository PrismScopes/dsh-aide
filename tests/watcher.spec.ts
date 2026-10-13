import { describe, expect, it } from 'vitest'
import { WorkspaceWatch } from '../src/routes.ts'

function fake(){return{closeCalls:0,listeners:0,on(){this.listeners++},off(){this.listeners--},close(){this.closeCalls++}}}
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))

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
