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
import { DEFAULT_COMPLETION_PARAMS, debounceFor, type CompletionParams } from '../completion/params.ts'
import { CompletionClient, type CompletionResponse } from './completion.ts'

/** 最近一次内容变更是否包含换行。换行意味着语句或块结束，按文档跳过防抖。 */
export interface ChangeTracker {
  lastChangeHadNewline: boolean
}

/** 是否需要为本轮触发等待防抖：自动触发且上一次变更不是换行时才等。 */
export function shouldDebounce(tracker: ChangeTracker, triggerKind: monaco.languages.InlineCompletionTriggerKind, explicitKind: monaco.languages.InlineCompletionTriggerKind): boolean {
  if (triggerKind === explicitKind) return false
  return !tracker.lastChangeHadNewline
}

/** 可被取消的等待：取消发生在防抖窗口内时，请求根本不会发出去。 */
export function delayWithToken(ms: number, token: monaco.CancellationToken): Promise<void> {
  if (ms <= 0 || token.isCancellationRequested) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    token.onCancellationRequested(() => { clearTimeout(timer); resolve() })
  })
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

/** 按词采纳时取出的下一段：标识符整体取出，其余取一个非空白字符。 */
export function nextWordOf(text: string): string {
  const match = /^\s*[A-Za-z_$][\w$]*|^\s*\d+(?:\.\d+)?|^\s*\S/.exec(text)
  return match?.[0] ?? ''
}

/** 按行采纳时取出的下一行；含换行符，便于连续按行采纳。 */
export function nextLineOf(text: string): string {
  const index = text.indexOf('\n')
  return index === -1 ? text : text.slice(0, index + 1)
}

export class InlineCompletionController {
  readonly tracker: ChangeTracker = { lastChangeHadNewline: false }
  private inFlight: AbortController | undefined
  /** 当前展示的建议：整块之外的采纳粒度都基于它切分。 */
  private current: { text: string; position: { lineNumber: number; column: number }; path: string } | undefined

  constructor(private readonly options: InlineCompletionControllerOptions) {}

  /** 由 Monaco 在条目被采纳时调起（整块采纳走这条路）。 */
  recordAccepted(payload: Pick<AcceptPayload, 'path' | 'offset' | 'text'>): void {
    this.options.client.recordAccept({
      filePath: payload.path,
      start: payload.offset,
      end: payload.offset + payload.text.length,
      text: payload.text,
      inline: true,
    })
  }

  /**
   * 按词或按行采纳。
   *
   * Monaco 只自带整块采纳，这两种粒度由本地切片后作为一次编辑写入并同样记账。切分与记账都不依赖
   * Monaco 的内部状态，因此可以单独测。
   */
  acceptPartial(granularity: 'word' | 'line'): string | undefined {
    const current = this.current
    if (current === undefined || current.text === '') return undefined
    const slice = granularity === 'word' ? nextWordOf(current.text) : nextLineOf(current.text)
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

  private offsetAt(position: { lineNumber: number; column: number }): number {
    return this.options.editor.getModel()?.getOffsetAt({ lineNumber: position.lineNumber, column: position.column }) ?? 0
  }

  private acceptPayload(text: string, position: { lineNumber: number; column: number }, path: string): AcceptPayload {
    return { controllerId: this.options.controllerId, path, offset: this.offsetAt(position), text }
  }

  /**
   * 接到内容变更：更新换行标记，并作废在途请求（作废不只丢结果，还中止底层连接）。
   *
   * 参数取事件对象而不是变更数组：编辑器给的是事件，而这里只要它的 changes 字段，
   * 写成事件形状既能直接用，也还能手搓一个对象来单测。
   */
  noteChange(event: { changes: readonly monaco.editor.IModelContentChange[] }): void {
    this.tracker.lastChangeHadNewline = event.changes.some(change => change.text.includes('\n'))
    this.inFlight?.abort()
    this.inFlight = undefined
  }

  async provide(model: monaco.editor.ITextModel, position: monaco.Position, context: monaco.languages.InlineCompletionContext, token: monaco.CancellationToken): Promise<monaco.languages.InlineCompletions | undefined> {
    const params = this.options.params ?? DEFAULT_COMPLETION_PARAMS
    const language = model.getLanguageId()
    if (shouldDebounce(this.tracker, context.triggerKind, this.options.kinds.explicit)) {
      await delayWithToken(debounceFor(language, params), token)
      // 防抖窗口内用户又敲了键：这次触发已经作废，链接都没建立。
      if (token.isCancellationRequested) return undefined
    }

    const controller = new AbortController()
    this.inFlight = controller
    token.onCancellationRequested(() => controller.abort())
    let response: CompletionResponse
    try {
      response = await this.options.client.suggest({
        filePath: model.uri.path.replace(/^\//, ''),
        language,
        document: model.getValue(),
        rewriteAt: { line: position.lineNumber, column: position.column - 1 },
        signal: controller.signal,
        firstCandidateOnly: true,
      })
    } catch (error) {
      if (controller.signal.aborted) return undefined
      throw error
    } finally {
      if (this.inFlight === controller) this.inFlight = undefined
    }

    const path = model.uri.path.replace(/^\//, '')
    this.current = { text: response.candidates[0] ?? '', position: { lineNumber: position.lineNumber, column: position.column }, path }
    const items = buildInlineCompletionItems(response.candidates, position, this.options.emptyRangeAt, text => ({
      id: ACCEPT_COMMAND_ID,
      title: '记录补全采纳',
      arguments: [this.acceptPayload(text, position, path)],
    }))
    return items.length === 0 ? undefined : { items }
  }

  dispose(): void {
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
    ...(options.params === undefined ? {} : { params: options.params }),
    kinds: { automatic: monacoApi.languages.InlineCompletionTriggerKind.Automatic, explicit: monacoApi.languages.InlineCompletionTriggerKind.Explicit },
    emptyRangeAt: position => new monacoApi.Range(position.lineNumber, position.column, position.lineNumber, position.column),
    editor,
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
      id: 'dsh-completion.acceptWord',
      label: '采纳补全的下一段',
      precondition: 'inlineSuggestionVisible',
      keybindings: [monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.RightArrow],
      run: () => { controller.acceptPartial('word') },
    }),
    editor.addAction({
      id: 'dsh-completion.acceptLine',
      label: '采纳补全的下一行',
      precondition: 'inlineSuggestionVisible',
      keybindings: [monacoApi.KeyMod.CtrlCmd | monacoApi.KeyMod.Alt | monacoApi.KeyCode.RightArrow],
      run: () => { controller.acceptPartial('line') },
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
