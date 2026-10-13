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
}

export class InlineCompletionController {
  readonly tracker: ChangeTracker = { lastChangeHadNewline: false }
  private inFlight: AbortController | undefined

  constructor(private readonly options: InlineCompletionControllerOptions) {}

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

    const items = response.candidates
      .filter(text => text !== '')
      .map(text => ({ insertText: text }))
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
let providerRegistered = false

export function attachInlineCompletion(monacoApi: typeof monaco, editor: monaco.editor.IStandaloneCodeEditor, options: { sessionId: string; endpoint?: string; params?: CompletionParams }): () => void {
  const client = new CompletionClient({ endpoint: options.endpoint ?? '/dsh-vscode/completion', sessionId: options.sessionId, ...(options.params === undefined ? {} : { params: options.params }) })
  const controller = new InlineCompletionController({
    client,
    ...(options.params === undefined ? {} : { params: options.params }),
    kinds: { automatic: monacoApi.languages.InlineCompletionTriggerKind.Automatic, explicit: monacoApi.languages.InlineCompletionTriggerKind.Explicit },
  })
  const model = editor.getModel()
  const key = model?.uri.toString() ?? ''
  if (key !== '') controllers.set(key, controller)

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
    change.dispose()
    controller.dispose()
    if (key !== '') controllers.delete(key)
  }
}
