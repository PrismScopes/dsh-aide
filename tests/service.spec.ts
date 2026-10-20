import { describe, expect, it, vi } from 'vitest'
import { WorkbenchController } from '../src/client/service.ts'
describe('workbench client service',()=>{it('publishes stable snapshots and disposable panels',()=>{const service=new WorkbenchController();const listener=vi.fn();service.subscribe(listener);expect(service.getPanels()).toBe(service.getPanels());service.show('search');expect(service.getSnapshot()).toMatchObject({visible:true,view:'search'});const dispose=service.registerBottomPanel({id:'terminal',title:'Terminal',component:()=>null});const panels=service.getPanels();expect(panels).toHaveLength(1);expect(service.getPanels()).toBe(panels);service.toggleBottomPanel('terminal');expect(service.getSnapshot().bottomPanel).toBe('terminal');dispose();expect(service.getPanels()).toHaveLength(0);expect(listener).toHaveBeenCalled()})})

it('never restores workbench visibility after a page refresh, keeping only the view preference',()=>{
  const values=new Map<string,string>()
  const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)}}
  const beforeRefresh=new WorkbenchController(storage)
  beforeRefresh.show('git')
  // 工作台只能由用户主动打开：刷新后必须保持关闭，视图偏好仍然保留。
  expect(new WorkbenchController(storage).getSnapshot()).toMatchObject({visible:false,view:'git'})
  beforeRefresh.hide()
  expect(new WorkbenchController(storage).getSnapshot()).toMatchObject({visible:false,view:'git'})
})
