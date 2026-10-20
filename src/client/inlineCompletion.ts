/**
 * Monaco 的幻影文本绑定。
 *
 * 为什么还要一层控制器而不是直接在 provider 里发请求：文档 4.1 的三条触发规则（按语言防抖、换行立即
 * 触发、连续输入作废在途请求）需要跨多次调用保存状态，provider 是每次调用独立触发的，存不下这些状态。
 *
 * 一个已知限制：Monaco 的行内补全接口是「一次请求一次返回」，没法把增量推上屏幕。所以这里用
 * 「拿到首个候选就返回」把首字节优势用上，而不是等整个流结束。
 */
import type * as monaco from 'monaco-editor'
import { DEFAULT_COMPLETION_PARAMS, type CompletionParams } from '../completion/params.ts'
import { evaluateSecurity, type SecurityRule } from '../completion/security.ts'
import { triggerPlan } from './completion.ts'
import { api } from './api.ts'
import { DEFAULT_PREFERENCES, getPreferences } from './preferences.ts'
import { CompletionClient, type CompletionResponse } from './completion.ts'

/** 最近一次内容变更是否包含换行。换行意味着语句或块结束，按文档跳过防抖。 */
export interface ChangeTracker {
  lastChangeHadNewline: boolean
}


export interface InlineCompletionControllerOptions {
  client: CompletionClient
  params?: CompletionParams
  /** 由 Monaco 的触发类型常量注入，避免在纯逻辑里依赖 monaco 的运行时值。 */
  kinds: { automatic: monaco.languages.InlineCompletionTriggerKind; explicit: monaco.languages.InlineCompletionTriggerKind }
  /** 造一个光标处的空范围；由调用方注入，便于单测。 */
  emptyRangeAt(position: { lineNumber: number; column: number }): monaco.Range
  /** 按词与按行采纳要写回编辑器，因此控制器持有编辑器。 */
  editor: monaco.editor.IStandaloneCodeEditor
  /** 采纳回调里用它把载荷路由回本控制器：命令标识是全局的，载荷必须能自证归属。 */
  controllerId: string
  /**
   * 埋点出口（文档七）。留成回调而不是直接发请求：这一层只管补全，传输由调用方决定，
   * 也便于单测里断言「展示、采纳、取消」各报了一次。
   */
  report?: (event: { kind: 'shown' | 'accepted' | 'cancelled' | 'failed'; language: string; model?: string; experiment?: string; firstByteMs?: number; candidateCount?: number; error?: string }) => void
}

/**
 * 把候选文本做成 Monaco 的行内补全条目。
 *
 * 必须显式给范围：省略时 Monaco 的默认替换范围是「当前词的起点到行尾」，会把插入当成替换，
 * 而类型声明要求被替换文本必须是插入文本的前缀 —— 不满足就直接被丢弃（表现为「明明拿到了候选
 * 却不显示幻影文本」）。空范围在光标处等于纯插入。
 */
export function buildInlineCompletionItems<TItem, TCommand>(candidates: readonly string[], position: { lineNumber: number; column: number }, emptyRangeAt: (position: { lineNumber: number; column: number }) => TItem, commandFor?: (text: string) => TCommand): Array<{ insertText: string; filterText: string; range: TItem; command?: TCommand }> {
  const range = emptyRangeAt(position)
  return candidates
    .filter(text => text !== '')
    .map(text => ({ insertText: text, filterText: text, range, ...(commandFor === undefined ? {} : { command: commandFor(text) }) }))
}

/** 采纳回调的命令标识：条目被采纳时由 Monaco 调起，用来记账。 */
export const ACCEPT_COMMAND_ID = 'dsh-completion.accept'

/** 记账载荷：采纳起点（字符偏移）与采纳文本，区间取 [offset, offset + text.length)。 */
export interface AcceptPayload { controllerId: string; path: string; offset: number; text: string }



/** 按行采纳时取出的下一行；含换行符，便于连续按行采纳。 */
export function nextLineOf(text: string): string {
  const index = text.indexOf('\n')
  return index === -1 ? text : text.slice(0, index + 1)
}

/** 编辑历史只在文档不超过这个长度时记录：整篇取值是 O(长度)，而它跑在每次按键上。 */
const MAX_EDIT_TRACK_CHARS = 400_000

/**
 * 把 1 起的行号列号换算成字符偏移。
 *
 * 客户端不引用宿主的模块（那会把整个 prompt 组装拉进浏览器包），所以这里是同一约定的小实现：
 * 行列都从 1 起，与 Monaco 位置、与协议一致。
 */
function offsetOfPosition(text: string, line: number, column: number): number {
  const lines = text.split('\n')
  const target = Math.max(1, Math.min(line, lines.length))
  let offset = 0
  for (let index = 0; index < target - 1; index++) offset += (lines[index] ?? '').length + 1
  return Math.min(offset + Math.max(0, column - 1), text.length)
}


export class InlineCompletionController {
  readonly tracker: ChangeTracker = { lastChangeHadNewline: false }
  private inFlight: AbortController | undefined
  private triggerTimer: ReturnType<typeof setTimeout> | undefined
  /** 最近一次编辑的前后文本；宿主用它做「回滚编辑」等判定，并写进 prompt 的编辑历史。 */
  private lastEdit: { before: string; after: string } | undefined
  /** 上一版文档：变更事件发生在编辑之后，被删掉的文本只能从这里取。 */
  private previousValue: string | undefined
  /** 服务端下发的参数覆盖本地默认值（文档七：参数由服务端下发，便于按分组灰度）。 */
  private paramsOverride: CompletionParams | undefined
  /** 请求前预过滤用的租户规则（文档 6.4 的请求前一道）。 */
  private securityRules: readonly SecurityRule[] = []
  /** 服务端下发（并按会话稳定分配）的实验分组，用于给尚未拿到响应的埋点归组。 */
  private experiment: string | undefined
  /** 当前展示的建议：整块之外的采纳粒度都基于它切分。 */
  private current: { text: string; position: { lineNumber: number; column: number }; path: string } | undefined
  /** 上一次成功产出的候选与它对应的位置，供自动触发直接呈现（文档 4.1：命中缓存不发请求）。 */
  private lastResult: { candidates: readonly string[]; position: { lineNumber: number; column: number } } | undefined

  constructor(private readonly options: InlineCompletionControllerOptions) {}

  /** 由 Monaco 在条目被采纳时调起（整块采纳走这条路）。 */
  recordAccepted(payload: Pick<AcceptPayload, 'path' | 'offset' | 'text'>): void {
    this.options.report?.({ kind: 'accepted', language: this.languageOf(), ...(this.experiment === undefined ? {} : { experiment: this.experiment }) })
    this.options.client.recordAccept({
      filePath: payload.path,
      start: payload.offset,
      end: payload.offset + payload.text.length,
      text: payload.text,
      inline: true,
    })
  }

  /**
   * 采纳建议的下一行。
   *
   * 整块采纳与按词采纳由 Monaco 自带（Tab 与 Ctrl+方向键右），按行它没有，所以由本地切片后
   * 作为一次编辑写入并同样记账。切分与记账都不依赖 Monaco 的内部状态，因此可以单独测。
   */
  acceptNextLine(): string | undefined {
    const current = this.current
    if (current === undefined || current.text === '') return undefined
    const slice = nextLineOf(current.text)
    if (slice === '') return undefined
    const editor = this.options.editor
    // 记账要在写入之前算：写入之后光标已经不在原处了。
    this.recordAccepted({ path: current.path, offset: this.offsetAt(current.position), text: slice })
    editor.executeEdits('dsh-completion', [{ range: this.options.emptyRangeAt(current.position), text: slice, forceMoveMarkers: true }])
    // 剩余部分留给下一次触发继续切分；位置读编辑器的实际光标，多行切片也不必手算行列。
    const moved = editor.getPosition() ?? current.position
    this.current = { ...current, text: current.text.slice(slice.length), position: { lineNumber: moved.lineNumber, column: moved.column } }
    return slice
  }

  /** 把候选变成 Monaco 的条目；采纳命令带上位置与控制器标识，便于采纳后记账。 */
  private toInlineCompletions(candidates: readonly string[], position: monaco.Position, model: monaco.editor.ITextModel): monaco.languages.InlineCompletions | undefined {
    const path = model.uri.path.replace(/^\//, '')
    const items = buildInlineCompletionItems(candidates, position, this.options.emptyRangeAt, text => ({
      id: ACCEPT_COMMAND_ID,
      title: '记录补全采纳',
      arguments: [this.acceptPayload(text, position, path)],
    }))
    return items.length === 0 ? undefined : { items }
  }


  /** 应用服务端下发的参数。传 undefined 表示回到本地默认值。 */
  setParams(params: CompletionParams | undefined): void {
    this.paramsOverride = params
  }


  /**
   * 识别采纳。
   *
   * 采纳会在光标处插入一段文本并产生内容变更事件（实测：`{"text":"te","rangeLength":0}`）。
   * 插入长度 ≥ 2 且是最近一次候选的前缀时按采纳记账；单字符不记，命中候选前缀的概率太高。
   */
  private notePossibleAccept(event: { changes: readonly monaco.editor.IModelContentChange[] }): void {
    const last = this.lastResult
    if (last === undefined) return
    for (const change of event.changes) {
      if (change.text.length < 2 || change.rangeLength !== 0) continue
      if (change.text.includes('\n')) continue
      if (!last.candidates.some(candidate => candidate.startsWith(change.text))) continue
      this.recordAccepted({ path: this.current?.path ?? '', offset: this.offsetAt({ lineNumber: change.range.startLineNumber, column: change.range.startColumn }), text: change.text })
      return
    }
  }

  /**
   * 记录最近一次编辑的前后文本。
   *
   * 变更事件发生在编辑之后，被删掉的文本只能从上一版文档里按变更范围取。一次事件里有多处变更时
   * 不做重建（长度对不上就跳过）：宁可不记，也不记错。
   *
   * **超大文档不记**：取值是整篇复制，而这段代码跑在每一次按键上。工作区里可能有大文件（日志、
   * 数据文件），对它们每次按键复制两遍会直接把编辑器拖死 —— 表现为「打开文件没反应」。
   * 编辑历史只是加分项，不值得拿编辑流畅性去换。
   */
  private captureEdit(event: { changes: readonly monaco.editor.IModelContentChange[] }): void {
    const model = this.options.editor.getModel()
    const change = event.changes[0]
    if (model === null || change === undefined) return
    // 防御式调用：假模型或未来某个宿主可能没有这个方法，取不到长度就按「不记」处理，
    // 不能让一个可选优化在按键路径上抛错。
    const length = typeof model.getValueLength === 'function' ? model.getValueLength() : Number.POSITIVE_INFINITY
    if (length > MAX_EDIT_TRACK_CHARS) {
      this.previousValue = undefined
      return
    }
    const current = model.getValue()
    if (this.previousValue !== undefined && current.length === this.previousValue.length - change.rangeLength + change.text.length) {
      const start = offsetOfPosition(this.previousValue, change.range.startLineNumber, change.range.startColumn)
      this.lastEdit = { before: this.previousValue.slice(start, start + change.rangeLength), after: change.text }
    }
    this.previousValue = current
  }

  /** 应用服务端下发的实验分组。 */
  setExperiment(experiment: string | undefined): void {
    this.experiment = experiment
  }

  /** 应用服务端下发的安全规则；空数组表示不做请求前过滤。 */
  setSecurityRules(rules: readonly SecurityRule[]): void {
    this.securityRules = rules
  }

  private paramsOf(): CompletionParams {
    const base = this.paramsOverride ?? this.options.params ?? DEFAULT_COMPLETION_PARAMS
    // 防抖值的优先级：用户显式改过偏好 > 实验/服务端下发值 > 参数默认。
    //
    // 设置页只有一个「触发延迟」数字。它等于默认值时说明用户没动过，应当让实验分组下发的
    // 快/慢档（以及参数默认值）生效；只有用户真的改成别的数字，才两档统一成那个值 —— 设置页
    // 只暴露一个数字，按语言分档后界面上写 120 实际行为却因文件类型不同而不一致，用户无从理解。
    const debounce = getPreferences().completionDebounceMs
    if (debounce === DEFAULT_PREFERENCES.completionDebounceMs) return base
    return { ...base, debounceFastMs: debounce, debounceSlowMs: debounce }
  }

  private languageOf(): string {
    return this.options.editor.getModel()?.getLanguageId() ?? 'plaintext'
  }

  private offsetAt(position: { lineNumber: number; column: number }): number {
    return this.options.editor.getModel()?.getOffsetAt({ lineNumber: position.lineNumber, column: position.column }) ?? 0
  }

  private acceptPayload(text: string, position: { lineNumber: number; column: number }, path: string): AcceptPayload {
    return { controllerId: this.options.controllerId, path, offset: this.offsetAt(position), text }
  }

  /**
   * 接到内容变更：更新换行标记、作废在途请求，并按文档 4.1 的规则调度一次触发。
   *
   * 参数取事件对象而不是变更数组：编辑器给的是事件，而这里只要它的 changes 字段，
   * 写成事件形状既能直接用，也还能手搓一个对象来单测。
   */
  noteChange(event: { changes: readonly monaco.editor.IModelContentChange[] }): void {
    this.captureEdit(event)
    this.tracker.lastChangeHadNewline = event.changes.some(change => change.text.includes('\n'))
    this.notePossibleAccept(event)
    // 有在途请求而被这次变更作废，就是一次「请求取消」（文档七的取消率指标）。
    if (this.inFlight !== undefined) this.options.report?.({ kind: 'cancelled', language: this.languageOf(), ...(this.experiment === undefined ? {} : { experiment: this.experiment }) })
    this.inFlight?.abort()
    this.inFlight = undefined
    this.scheduleTrigger()
  }

  /**
   * 按文档 4.1 的规则调度一次显式触发：换行立即，其余按语言防抖。
   *
   * 触发时机由本插件决定，而不是交给 Monaco 的自动触发链路 —— 原因见 provide。
   */
  private scheduleTrigger(): void {
    if (this.triggerTimer !== undefined) clearTimeout(this.triggerTimer)
    // 补全被关掉时不排触发，并且把已经显示的幻影文本收起来 —— 否则它会留成一条点不动的建议，
    // 一路跟着光标走到下一次编辑。这里读的是当前的偏好值，所以设置页里一关就生效，不用刷新。
    if (!getPreferences().completionEnabled) {
      this.triggerTimer = undefined
      this.options.editor.trigger('dsh-completion', 'editor.action.inlineSuggest.hide', {})
      return
    }
    const language = this.languageOf()
    const plan = triggerPlan({ isNewLine: this.tracker.lastChangeHadNewline }, language, this.paramsOf())
    this.triggerTimer = setTimeout(() => {
      this.triggerTimer = undefined
      this.options.editor.trigger('dsh-completion', 'editor.action.inlineSuggest.trigger', {})
    }, plan.delayMs)
  }

  async provide(model: monaco.editor.ITextModel, position: monaco.Position, context: monaco.languages.InlineCompletionContext, token: monaco.CancellationToken): Promise<monaco.languages.InlineCompletions | undefined> {
    // 关闭状态下一条请求都不发：这一层是补全唯一向外发请求的地方。
    if (!getPreferences().completionEnabled) return undefined
    const params = this.paramsOf()
    const language = model.getLanguageId()
    // 位置一致时直接复用上次候选（文档 4.1：命中缓存直接呈现、不发请求）：
    // 切换候选走的就是这条路 —— 只改先看哪一条，不取新结果。
    const cached = this.lastResult
    if (cached !== undefined && cached.position.lineNumber === position.lineNumber && cached.position.column === position.column) {
      return this.toInlineCompletions(cached.candidates, position, model)
    }
    // 自动触发在位置不一致时放弃：返回空候选等于清空当前建议，会把刚显示的内容抹掉。
    if (context.triggerKind !== this.options.kinds.explicit) return undefined

    // 请求前预过滤（文档 6.4 的请求前一道）：命中拦截规则就什么都不发，
    // 而不是发出去再让服务端拦 —— 那时代码已经离开本机了。
    if (evaluateSecurity(model.getValue(), this.securityRules)?.action === 'block') return undefined

    const controller = new AbortController()
    this.inFlight = controller
    token.onCancellationRequested(() => controller.abort())
    let response: CompletionResponse
    try {
      response = await this.options.client.suggest({
        filePath: model.uri.path.replace(/^\//, ''),
        language,
        document: model.getValue(),
        // 原样传 Monaco 的位置：协议约定行列都从 1 起，换算只发生在宿主一侧（见 protocol.ts）。
        rewriteAt: { line: position.lineNumber, column: position.column },
        ...(this.lastEdit === undefined ? {} : { lastEdit: this.lastEdit }),
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) return undefined
      // 上游失败要留痕：否则界面上只表现为「没有补全」，第二天只能靠猜（文档 4.3 的用途是问题定位）。
      this.options.report?.({ kind: 'failed', language, error: error instanceof Error ? error.message : String(error), ...(this.experiment === undefined ? {} : { experiment: this.experiment }) })
      throw error
    } finally {
      if (this.inFlight === controller) this.inFlight = undefined
    }

    const path = model.uri.path.replace(/^\//, '')
    this.current = { text: response.candidates[0] ?? '', position: { lineNumber: position.lineNumber, column: position.column }, path }
    this.lastResult = { candidates: response.candidates, position: { lineNumber: position.lineNumber, column: position.column } }
    const completions = this.toInlineCompletions(response.candidates, position, model)
    // 真的呈现出来了才算一次「展示」：过滤后空手而归不该算进采纳率的分母。
    if (completions !== undefined) {
      this.options.report?.({ kind: 'shown', language, candidateCount: completions.items.length, ...(response.model === undefined ? {} : { model: response.model }), ...(response.experiment === undefined ? {} : { experiment: response.experiment }), ...(response.timing.rttMs === undefined ? {} : { firstByteMs: response.timing.rttMs }) })
    }
    return completions
  }

  dispose(): void {
    if (this.triggerTimer !== undefined) clearTimeout(this.triggerTimer)
    this.triggerTimer = undefined
    this.inFlight?.abort()
    this.inFlight = undefined
  }
}

/**
 * 把补全接到一个编辑器实例上。
 *
 * 语言级的 provider 只能全局注册一次 —— 放在每个编辑器的挂载效果里注册会随文件切换不断叠加。
 * 所以 provider 只认契约里的模型，再由模块级的表把模型 URI 映射到当前控制器；没有对应控制器的模型
 * （比如 diff 视图的只读模型）直接不提供补全。
 */
const controllers = new Map<string, InlineCompletionController>()
/**
 * 服务端配置只取一次。
 *
 * 参数与规则在同一次编辑会话里不会变（分组按会话稳定分配），反复拉取只会把请求量翻倍。
 * 缓存的是一次 promise 而不是结果：多个编辑器同时挂载时也只发一次请求。
 */
let configPromise: Promise<{ params?: CompletionParams; experiment?: string; security?: { rules: readonly SecurityRule[] } }> | undefined
function loadConfig(sessionId: string): Promise<{ params?: CompletionParams; experiment?: string; security?: { rules: readonly SecurityRule[] } }> {
  configPromise ??= api<{ params?: CompletionParams; experiment?: string; security?: { rules: readonly SecurityRule[] } }>('completion.config', { sessionId }).catch(() => ({}))
  return configPromise
}

/** 采纳命令是全局的，按控制器标识路由回具体编辑器。 */
const controllersById = new Map<string, InlineCompletionController>()
let providerRegistered = false
let acceptCommandRegistered = false
let controllerSequence = 0

export function attachInlineCompletion(monacoApi: typeof monaco, editor: monaco.editor.IStandaloneCodeEditor, options: { sessionId: string; endpoint?: string; params?: CompletionParams }): () => void {
  const client = new CompletionClient({ endpoint: options.endpoint ?? '/dsh-vscode/completion', sessionId: options.sessionId, ...(options.params === undefined ? {} : { params: options.params }) })
  const controllerId = `dsh-completion-${++controllerSequence}`
  const controller = new InlineCompletionController({
    client,
    controllerId,
    // 埋点是旁路：发不出去就算了，绝不因为它影响补全。
    report: event => {
      void api('completion.telemetry', { ...event, sessionId: options.sessionId ?? '' }).catch(() => undefined)
    },
    ...(options.params === undefined ? {} : { params: options.params }),
    kinds: { automatic: monacoApi.languages.InlineCompletionTriggerKind.Automatic, explicit: monacoApi.languages.InlineCompletionTriggerKind.Explicit },
    emptyRangeAt: position => new monacoApi.Range(position.lineNumber, position.column, position.lineNumber, position.column),
    editor,
  })
  // 服务端下发的参数与规则在这里生效；拉不到就继续用本地默认值，补全不受影响。
  void loadConfig(options.sessionId ?? '').then(config => {
    controller.setParams(config.params)
    controller.setExperiment(config.experiment)
    controller.setSecurityRules(config.security?.rules ?? [])
    // 环境元数据里带上分组标识（文档 4.3）；服务端仍会按会话重新分配，这份用于对齐语义。
    if (config.experiment !== undefined) client.setEnvironment({ experiment: config.experiment })
  })

  const model = editor.getModel()
  const key = model?.uri.toString() ?? ''
  if (key !== '') controllers.set(key, controller)
  controllersById.set(controllerId, controller)

  if (!acceptCommandRegistered) {
    acceptCommandRegistered = true
    // 整块采纳由 Monaco 的 commit 触发，条目上的 command 随之被调起。
    monacoApi.editor.registerCommand(ACCEPT_COMMAND_ID, (_accessor: unknown, payload: unknown) => {
      if (typeof payload !== 'object' || payload === null) return
      const accept = payload as AcceptPayload
      controllersById.get(accept.controllerId)?.recordAccepted(accept)
    })
  }

  // 按词与按行：只在建议可见时接管按键，否则会抢掉正常的按词移动。
  const actions = [

    editor.addAction({
      id: 'dsh-completion.acceptLine',
      label: '采纳补全的下一行',
      precondition: 'inlineSuggestionVisible',
      keybindings: [monacoApi.KeyMod.CtrlCmd | monacoApi.KeyMod.Alt | monacoApi.KeyCode.RightArrow],
      run: () => { controller.acceptNextLine() },
    }),

  ]

  const change = editor.onDidChangeModelContent(changes => controller.noteChange(changes))
  if (!providerRegistered) {
    providerRegistered = true
    monacoApi.languages.registerInlineCompletionsProvider({ pattern: '**' }, {
      async provideInlineCompletions(target, position, context, token) {
        const found = controllers.get(target.uri.toString())
        if (found === undefined) return undefined
        return await found.provide(target, position, context, token)
      },
      freeInlineCompletions() { /* 候选是纯文本，没有需要回收的资源。 */ },
    })
  }
  return () => {
    for (const action of actions) action.dispose()
    change.dispose()
    controller.dispose()
    if (key !== '') controllers.delete(key)
    controllersById.delete(controllerId)
  }
}
