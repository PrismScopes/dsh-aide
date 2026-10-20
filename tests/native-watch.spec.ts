import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkspaceWatcher, createRescanThrottle, isWatcherOverflow, RESCAN_EVENT, RESCAN_THROTTLE_MS } from '../src/watch.ts'

const roots:string[]=[]
async function temp(){const value=await mkdtemp(join(tmpdir(),'dvw-watch-'));roots.push(value);return value}
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})))})
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))

describe('watcher overflow handling', () => {
  it('treats an empty filename or a native error event as overflow', () => {
    expect(RESCAN_EVENT).toBe('rescan')
    // Windows ReadDirectoryChangesW 缓冲溢出：filename 为 null。
    expect(isWatcherOverflow('change', null)).toBe(true)
    expect(isWatcherOverflow('change', undefined)).toBe(true)
    expect(isWatcherOverflow('change', '')).toBe(true)
    // error 事件拿不到路径：同样视为可能丢事件。
    expect(isWatcherOverflow('error', 'src/a.ts')).toBe(true)
    // 正常事件不能误判成溢出。
    expect(isWatcherOverflow('change', 'src/a.ts')).toBe(false)
    expect(isWatcherOverflow('rename', 'a.ts')).toBe(false)
  })

  it('throttles consecutive overflow signals within the 500ms window', () => {
    let now = 1_000
    const allow = createRescanThrottle(RESCAN_THROTTLE_MS, () => now)
    expect(allow()).toBe(true)
    expect(allow()).toBe(false)
    now += RESCAN_THROTTLE_MS - 1
    expect(allow()).toBe(false)
    now += 1
    expect(allow()).toBe(true)
  })
})

describe('workspace watcher',()=>{
  it('reports a change inside a nested directory',async()=>{
    const root=await temp()
    await mkdir(join(root,'src','deep'),{recursive:true})
    const watcher=createWorkspaceWatcher(root)
    const changed:string[]=[]
    watcher.on('all',(_event:string,changedPath:string)=>{changed.push(changedPath)})
    await wait(400)
    await writeFile(join(root,'src','deep','a.ts'),'one')
    const started=Date.now()
    while(Date.now()-started<8000&&!changed.some(item=>item.includes('a.ts')))await wait(50)
    expect(changed.some(item=>item.includes('a.ts'))).toBe(true)
    watcher.close()
  })

  it('does not report changes under node_modules',async()=>{
    const root=await temp()
    await mkdir(join(root,'node_modules','pkg'),{recursive:true})
    const watcher=createWorkspaceWatcher(root)
    const changed:string[]=[]
    watcher.on('all',(_event:string,changedPath:string)=>{changed.push(changedPath)})
    await wait(400)
    await writeFile(join(root,'node_modules','pkg','index.js'),'one')
    await wait(1500)
    expect(changed.filter(item=>item.includes('node_modules'))).toEqual([])
    watcher.close()
  })

  it('stops reporting after the listener is removed and after close',async()=>{
    const root=await temp()
    const watcher=createWorkspaceWatcher(root)
    const changed:string[]=[]
    const handler=(_event:string,changedPath:string)=>{changed.push(changedPath)}
    watcher.on('all',handler)
    await wait(400)
    await writeFile(join(root,'first.txt'),'one')
    const started=Date.now()
    while(Date.now()-started<8000&&changed.length===0)await wait(50)
    const afterFirst=changed.length
    expect(afterFirst).toBeGreaterThan(0)
    watcher.off('all',handler)
    await writeFile(join(root,'second.txt'),'two')
    await wait(1200)
    expect(changed.length).toBe(afterFirst)
    watcher.close()
  })
})
