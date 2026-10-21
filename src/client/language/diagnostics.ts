/**
 * 客户端诊断存储 + Monaco 标记同步。
 *
 * 为什么需要一层 store：诊断是**按工作区**推过来的异步数据，编辑器只是其中一个消费者 ——
 * 问题面板、状态栏计数、活动栏角标、跳转动作都要读同一份快照。把数据挂在组件 state 里会导致
 * 四份拷贝互相追不上；这里做成可订阅的 store，React 侧用 useSyncExternalStore 读。
 *
 * Monaco 标记由 store 在数据变化时统一写入：模型不在了就跳过（跳转目标可能从未在本进程打开），
 * 等编辑器挂载时再由 `flushMarkers` 补一次。
 */
import { useSyncExternalStore } from 'react'
import type { editor, MarkerSeverity } from 'monaco-editor'
import type {
  LanguageDiagnostic,
  LanguageInfo,
  LanguagePushMessage,
  LanguageScanState,
  LanguageSeverity,
} from '../../language/protocol.ts'
import { diagnosticCounts } from '../../language/protocol.ts'
import { modelForPath, monacoRange, registeredModels } from './models.ts'
import { pathKey } from './paths.ts'

export interface DiagnosticsFile {
  path: string
  diagnostics: readonly LanguageDiagnostic[]
  errors: number
  warnings: number
}

export interface DiagnosticsSnapshot {
  /** 按路径排序，问题面板直接渲染。 */
  files: readonly DiagnosticsFile[]
  errors: number
  warnings: number
  infos: number
  hints: number
  /** 最近一次 /language.info 的结果（服务器状态、能力集合）。 */
  status?: LanguageInfo
  scan?: LanguageScanState
  /** 每次变化 +1，组件可据此做记忆化。 */
  revision: number
}

const EMPTY_SNAPSHOT: DiagnosticsSnapshot = { files: [], errors: 0, warnings: 0, infos: 0, hints: 0, revision: 0 }

/** Monaco 的标记 API 需要完整 monaco 命名空间；语言特性安装时注入一次。 */
let markerHost: typeof import('monaco-editor') | undefined

/** 诊断标记的 owner：清理/覆盖都只动这一份，不碰 Monaco 内置语言服务的标记。 */
export const MARKER_OWNER = 'aide-language'

function severityOf(severity: LanguageSeverity, monaco: typeof import('monaco-editor')): MarkerSeverity {
  switch (severity) {
    case 'error': return monaco.MarkerSeverity.Error
    case 'warning': return monaco.MarkerSeverity.Warning
    case 'info': return monaco.MarkerSeverity.Info
    case 'hint': return monaco.MarkerSeverity.Hint
  }
}

/** 把一条诊断转成 Monaco 标记。 */
function markerOf(monaco: typeof import('monaco-editor'), diagnostic: LanguageDiagnostic): editor.IMarkerData {
  return {
    ...monacoRange(diagnostic.range),
    severity: severityOf(diagnostic.severity, monaco),
    message: diagnostic.message,
    source: diagnostic.source ?? 'AIDE',
    ...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
    ...(diagnostic.tags === undefined ? {} : {
      tags: diagnostic.tags.map(tag => tag === 'unnecessary' ? monaco.MarkerTag.Unnecessary : monaco.MarkerTag.Deprecated),
    }),
  }
}

/** 用当前诊断覆盖某个文件的标记；文件没有打开模型时什么也不做。 */
export function applyMarkersForPath(absPath: string, diagnostics: readonly LanguageDiagnostic[]): void {
  const monaco = markerHost
  if (monaco === undefined) return
  const model = modelForPath(absPath)
  if (model === undefined) return
  monaco.editor.setModelMarkers(model, MARKER_OWNER, diagnostics.map(diagnostic => markerOf(monaco, diagnostic)))
}

/** 编辑器挂载后调用：把 store 里已有的诊断补到这个模型上。 */
export function flushMarkersForPath(absPath: string, diagnostics: readonly LanguageDiagnostic[]): void {
  applyMarkersForPath(absPath, diagnostics)
}

/** 安装标记宿主并把已有诊断重放一遍；语言特性只安装一次。 */
export function installMarkerHost(monaco: typeof import('monaco-editor')): void {
  markerHost = monaco
}

/** 清理所有已登记模型上的 AIDE 标记（工作区关闭/禁用语言服务时）。 */
export function clearAllMarkers(): void {
  const monaco = markerHost
  if (monaco === undefined) return
  for (const { model } of registeredModels()) {
    try { monaco.editor.setModelMarkers(model, MARKER_OWNER, []) } catch { /* 模型可能刚销毁 */ }
  }
}

/** 一条诊断是否与另一条等价（避免重复推送触发整棵树重渲染）。 */
function sameDiagnostics(left: readonly LanguageDiagnostic[], right: readonly LanguageDiagnostic[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    const a = left[index]
    const b = right[index]
    if (a === undefined || b === undefined) return false
    if (a.severity !== b.severity || a.message !== b.message || a.code !== b.code || a.source !== b.source) return false
    if (a.range.start.line !== b.range.start.line || a.range.start.character !== b.range.start.character) return false
    if (a.range.end.line !== b.range.end.line || a.range.end.character !== b.range.end.character) return false
  }
  return true
}

export class DiagnosticsStore {
  private readonly files = new Map<string, { path: string; diagnostics: readonly LanguageDiagnostic[]; version?: number }>()
  private status: LanguageInfo | undefined
  private scan: LanguageScanState | undefined
  private readonly listeners = new Set<() => void>()
  private snapshot: DiagnosticsSnapshot = EMPTY_SNAPSHOT
  private snapshotDirty = false
  private revision = 0
  private notifyTimer: ReturnType<typeof setTimeout> | undefined

  /** 收到一条诊断推送。`version` 只用于丢弃旧结果（宿主可能先发后算、乱序到达）。 */
  setDiagnostics(path: string, diagnostics: readonly LanguageDiagnostic[], version?: number): void {
    const key = pathKey(path)
    const existing = this.files.get(key)
    if (existing !== undefined) {
      if (version !== undefined && existing.version !== undefined && version < existing.version) return
      if (sameDiagnostics(existing.diagnostics, diagnostics)) return
    }
    this.files.set(key, { path, diagnostics, ...(version === undefined ? {} : { version }) })
    this.snapshotDirty = true
    applyMarkersForPath(path, diagnostics)
    this.scheduleNotify()
  }

  /** 状态推送（服务器状态、扫描进度）。与 info 合并，保留 language 能力集合。 */
  applyStatus(message: Extract<LanguagePushMessage, { type: 'status' }>): void {
    const next: LanguageInfo = {
      enabled: this.status?.enabled ?? true,
      builtin: message.builtin,
      servers: message.servers,
      languages: this.status?.languages ?? [],
      ...(message.scan === undefined ? {} : { scan: message.scan }),
    }
    this.status = next
    this.scan = message.scan ?? this.scan
    this.snapshotDirty = true
    this.scheduleNotify()
  }

  /** /language.info 的结果。 */
  applyInfo(info: LanguageInfo): void {
    this.status = info
    this.scan = info.scan ?? this.scan
    this.snapshotDirty = true
    this.scheduleNotify()
  }

  diagnosticsOf(path: string): readonly LanguageDiagnostic[] {
    return this.files.get(pathKey(path))?.diagnostics ?? []
  }

  clear(): void {
    this.files.clear()
    this.status = undefined
    this.scan = undefined
    this.snapshotDirty = true
    this.revision++
    clearAllMarkers()
    this.scheduleNotify()
  }

  /** 只清诊断与标记，保留服务器状态（语言服务被关掉时用：状态栏/设置页仍要显示「已关闭」）。 */
  clearDiagnostics(): void {
    if (this.files.size === 0) return
    this.files.clear()
    this.snapshotDirty = true
    this.revision++
    clearAllMarkers()
    this.scheduleNotify()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): DiagnosticsSnapshot => {
    if (!this.snapshotDirty) return this.snapshot
    this.snapshotDirty = false
    const files: DiagnosticsFile[] = []
    let errors = 0, warnings = 0, infos = 0, hints = 0
    for (const entry of [...this.files.values()].sort((left, right) => left.path.localeCompare(right.path))) {
      const counts = diagnosticCounts(entry.diagnostics)
      errors += counts.errors; warnings += counts.warnings; infos += counts.infos; hints += counts.hints
      files.push({ path: entry.path, diagnostics: entry.diagnostics, errors: counts.errors, warnings: counts.warnings })
    }
    this.revision++
    this.snapshot = {
      files, errors, warnings, infos, hints,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.scan === undefined ? {} : { scan: this.scan }),
      revision: this.revision,
    }
    return this.snapshot
  }

  /** 测试/立即刷新用：取消合并窗口，马上通知订阅者。 */
  flush(): void {
    if (this.notifyTimer !== undefined) { clearTimeout(this.notifyTimer); this.notifyTimer = undefined }
    for (const listener of [...this.listeners]) listener()
  }

  /** 合并 80ms 内的多次诊断推送：一次工作区扫描会连着推几百条，不能每条都重渲染问题面板。 */
  private scheduleNotify(): void {
    if (this.notifyTimer !== undefined) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined
      for (const listener of [...this.listeners]) listener()
    }, 80)
  }
}

const stores = new Map<string, DiagnosticsStore>()

/** 每个工作区一份诊断 store（按 cwd 区分；同一浏览标签页里通常只有一个工作台）。 */
export function diagnosticsStoreFor(cwd: string): DiagnosticsStore {
  const key = pathKey(cwd)
  const existing = stores.get(key)
  if (existing !== undefined) return existing
  const store = new DiagnosticsStore()
  stores.set(key, store)
  return store
}

/** React 侧读取诊断快照；cwd 未解析出来时给一份空快照。 */
export function useDiagnostics(cwd: string | undefined): DiagnosticsSnapshot {
  const store = cwd === undefined ? undefined : diagnosticsStoreFor(cwd)
  return useSyncExternalStore(
    store?.subscribe ?? (() => () => {}),
    store?.getSnapshot ?? (() => EMPTY_SNAPSHOT),
    store?.getSnapshot ?? (() => EMPTY_SNAPSHOT),
  )
}

/** 测试用：清掉全部工作区的 store。 */
export function resetDiagnosticsStores(): void {
  for (const store of stores.values()) store.clear()
  stores.clear()
}
