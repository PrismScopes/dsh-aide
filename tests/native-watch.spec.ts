import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkspaceWatcher } from '../src/watch.ts'

const roots:string[]=[]
async function temp(){const value=await mkdtemp(join(tmpdir(),'dvw-watch-'));roots.push(value);return value}
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})))})
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))

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
