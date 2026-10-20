import type { ComponentType } from 'react'

export type WorkbenchView = 'explorer' | 'search' | 'git'
/**
 * `header` 是面板头里那块留给面板自己用的容器。终端面板把标签渲染进去：标签的状态（当前是哪一个、
 * 拆分了哪几个）属于终端面板，把状态上提到 Workbench 只为了让标签出现在头部，会让职责变乱。
 */
export interface BottomPanelProps { sessionId: string; cwd: string; visible: boolean; colorScheme: 'dark' | 'light'; header?: HTMLElement | null }
export interface BottomPanelContribution { id: string; title: string; component: ComponentType<BottomPanelProps> }
export interface WorkbenchCommand { id: string; run(): void }
export interface WorkbenchSnapshot { visible: boolean; view: WorkbenchView; bottomPanel?: string }
interface WorkbenchStorage { getItem(key:string):string|null; setItem(key:string,value:string):unknown }

/**
 * 工作台布局。这些状态由工作台自身产生（拖分隔条、点活动栏图标、标签栏的对话栏按钮），
 * 也由它自己持久化，所以状态必须待在 service 上而不是某个组件的 useState 里。
 *
 * 它们**不在**设置页里：每一个都有就地控件，把可拖动的东西再抄一份成数字只会让同一个状态有两个入口。
 * 状态栏可见性已移除：24px 的一条，承载工作区路径与返回入口，工作台里没有就地开关能把它叫回来。
 */
export interface WorkbenchLayout {
  primarySideVisible: boolean
  chatVisible: boolean
  sideWidth: number
  chatWidth: number
}
export const LAYOUT_LIMITS = { sideWidth: { min: 210, max: 640 }, chatWidth: { min: 400, max: 720 } } as const
export const DEFAULT_LAYOUT: WorkbenchLayout = { primarySideVisible: true, chatVisible: true, sideWidth: 210, chatWidth: 420 }

const SNAPSHOT_KEY='dvw:workbench:snapshot:v1'
const LAYOUT_KEY='dvw:workbench:layout:v1'
const DEFAULT_SNAPSHOT:WorkbenchSnapshot={visible:false,view:'explorer'}
function browserStorage():WorkbenchStorage|undefined{try{return globalThis.localStorage}catch{return undefined}}
function restoreSnapshot(storage:WorkbenchStorage|undefined):WorkbenchSnapshot{if(storage===undefined)return {...DEFAULT_SNAPSHOT};try{const raw=storage.getItem(SNAPSHOT_KEY);if(raw===null)return {...DEFAULT_SNAPSHOT};const value=JSON.parse(raw) as Partial<WorkbenchSnapshot>;const view=value.view==='explorer'||value.view==='search'||value.view==='git'?value.view:'explorer';return {visible:false,view,...(typeof value.bottomPanel==='string'?{bottomPanel:value.bottomPanel}:{})}}catch{return {...DEFAULT_SNAPSHOT}}}

/** 逐个字段校验并夹取范围，坏数据不会让整份布局回落到默认值。 */
function restoreLayout(storage:WorkbenchStorage|undefined):WorkbenchLayout{
  if(storage===undefined)return {...DEFAULT_LAYOUT}
  try{
    const raw=storage.getItem(LAYOUT_KEY)
    if(raw===null)return {...DEFAULT_LAYOUT}
    const value=JSON.parse(raw) as Partial<WorkbenchLayout>
    const clamp=(input:unknown,min:number,max:number,fallback:number)=>typeof input==='number'&&Number.isFinite(input)?Math.max(min,Math.min(max,Math.round(input))):fallback
    return {
      primarySideVisible:typeof value.primarySideVisible==='boolean'?value.primarySideVisible:DEFAULT_LAYOUT.primarySideVisible,
      chatVisible:typeof value.chatVisible==='boolean'?value.chatVisible:DEFAULT_LAYOUT.chatVisible,
      sideWidth:clamp(value.sideWidth,LAYOUT_LIMITS.sideWidth.min,LAYOUT_LIMITS.sideWidth.max,DEFAULT_LAYOUT.sideWidth),
      chatWidth:clamp(value.chatWidth,LAYOUT_LIMITS.chatWidth.min,LAYOUT_LIMITS.chatWidth.max,DEFAULT_LAYOUT.chatWidth)
    }
  }catch{return {...DEFAULT_LAYOUT}}
}

/** Client service exposed by the workbench to small feature adapters. */
export interface VscodeWorkbench {
  show(view?: WorkbenchView): void
  hide(): void
  registerBottomPanel(contribution: BottomPanelContribution): () => void
  registerCommand(command: WorkbenchCommand): () => void
  toggleBottomPanel(id: string): void
  runCommand(id: string): void
  getSnapshot(): WorkbenchSnapshot
  getPanels(): readonly BottomPanelContribution[]
  /** 当前布局偏好。设置面板与工作台都从这里读，改动经 subscribe 广播给两边。 */
  getLayout(): WorkbenchLayout
  setLayout(patch: Partial<WorkbenchLayout>): void
  /**
   * 打开 DSH 自己的设置面板（插件页在 settings.section，内容见 SettingsPanel）。
   * 工作台不自建设置界面；具体实现由 Overlay 注册（触发时机要等侧栏入口恢复显示）。
   */
  openDshSettings(): void
  /** 注册 openDshSettings 的实现。Overlay 挂载时注入，卸载时恢复成 no-op。 */
  setSettingsOpener(opener: () => void): void
  subscribe(listener: () => void): () => void
}

export class WorkbenchController implements VscodeWorkbench {
  private snapshot: WorkbenchSnapshot
  private readonly storage:WorkbenchStorage|undefined
  private readonly listeners = new Set<() => void>()
  private readonly panels = new Map<string, BottomPanelContribution>()
  private panelSnapshot: readonly BottomPanelContribution[] = []
  private readonly commands = new Map<string, WorkbenchCommand>()
  private layout: WorkbenchLayout
  private settingsOpener: () => void = () => {}
  constructor(storage:WorkbenchStorage|undefined=browserStorage()){this.storage=storage;this.snapshot=restoreSnapshot(storage);this.layout=restoreLayout(storage)}
  show(view?: WorkbenchView): void { this.update({ ...this.snapshot, visible: true, ...(view === undefined ? {} : { view }) }) }
  hide(): void { this.update({ ...this.snapshot, visible: false }) }
  toggleBottomPanel(id: string): void {
    this.update({ ...this.snapshot, visible: true, bottomPanel: this.snapshot.bottomPanel === id ? undefined : id })
  }
  registerBottomPanel(value: BottomPanelContribution): () => void {
    if (this.panels.has(value.id)) throw new Error(`workbench panel already registered: ${value.id}`)
    this.panels.set(value.id, value); this.refreshPanels()
    return () => { this.panels.delete(value.id); this.refreshPanels() }
  }
  registerCommand(value: WorkbenchCommand): () => void {
    if (this.commands.has(value.id)) throw new Error(`workbench command already registered: ${value.id}`)
    this.commands.set(value.id, value)
    return () => { this.commands.delete(value.id) }
  }
  runCommand(id: string): void { this.commands.get(id)?.run() }
  getSnapshot(): WorkbenchSnapshot { return this.snapshot }
  getPanels(): readonly BottomPanelContribution[] { return this.panelSnapshot }
  getLayout(): WorkbenchLayout { return this.layout }
  openDshSettings(): void { this.settingsOpener() }
  /** 由持有 layout 服务的插件入口注入；未注入时保持 no-op，点了不会抛错。 */
  setSettingsOpener(opener: () => void): void { this.settingsOpener = opener }
  setLayout(patch: Partial<WorkbenchLayout>): void {
    const clamp=(input:number|undefined,min:number,max:number,fallback:number)=>input===undefined||!Number.isFinite(input)?fallback:Math.max(min,Math.min(max,Math.round(input)))
    const next: WorkbenchLayout = {
      primarySideVisible: patch.primarySideVisible ?? this.layout.primarySideVisible,
      chatVisible: patch.chatVisible ?? this.layout.chatVisible,
      sideWidth: clamp(patch.sideWidth,LAYOUT_LIMITS.sideWidth.min,LAYOUT_LIMITS.sideWidth.max,this.layout.sideWidth),
      chatWidth: clamp(patch.chatWidth,LAYOUT_LIMITS.chatWidth.min,LAYOUT_LIMITS.chatWidth.max,this.layout.chatWidth)
    }
    this.layout = next
    try { this.storage?.setItem(LAYOUT_KEY, JSON.stringify(next)) } catch { /* 隐私模式下存储可能被拒，内存中的布局仍然可用。 */ }
    this.emit()
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(snapshot: WorkbenchSnapshot): void { this.snapshot = snapshot;try{this.storage?.setItem(SNAPSHOT_KEY,JSON.stringify(snapshot))}catch{/* Browser privacy settings may deny storage while the in-memory workbench remains usable. */}this.emit() }
  private refreshPanels(): void { this.panelSnapshot = [...this.panels.values()]; this.emit() }
  private emit(): void { for (const listener of this.listeners) listener() }
}
