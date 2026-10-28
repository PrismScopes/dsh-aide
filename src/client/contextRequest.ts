/**
 * AIDE → DSH 对话栏的「上下文卡片」请求总线。
 *
 * 问题面板、资源管理器菜单、编辑器菜单都只声明「我要把哪类上下文加到对话里」，
 * 不直接依赖 DSH 的 composer 服务：真正的插入由 contextCards 模块完成（它需要 host 的
 * sessions/conversation/inputTriggers 服务）。没有 DSH 服务时事件没人接，调用方拿不到结果，
 * 可以回落到旧的文本插入路径。
 *
 * 载荷只带定位信息与类型，不带内容快照 —— 内容在发送时由输入框里的 chip codec 现读，
 * 避免「加入卡片后源头又变了」的不一致（见方案文档 5.2 / 七）。
 */

export type ContextCardKind = 'problems' | 'problem' | 'file' | 'selection' | 'terminal' | 'subagent'

export interface ContextCardRequest {
  kind: ContextCardKind
  /** 问题面板的 scope：当前文件 / 整个工作区。 */
  scope?: 'file' | 'workspace'
  /** 工作区相对路径（文件 / 选区 / 单条诊断）。 */
  path?: string
  /** 选区的 1 基行列（与 DSH 的 composer 文本一致）。 */
  lineStart?: number
  lineEnd?: number
  /** 选区正文；只有 selection 类需要。 */
  text?: string
  language?: string
  /** 单条诊断的 1 基位置与消息（仅单条问题时使用）。 */
  line?: number
  column?: number
  message?: string
  title?: string
}

/** 请求事件名：Workbench 持有 sessionId，由它把请求交给 contextCards。 */
export const CONTEXT_CARD_EVENT = 'dvw-context-card'

export interface ContextCardEventDetail extends ContextCardRequest {
  resolve(ok: boolean): void
}

/**
 * 请求把上下文加入对话输入框。
 *
 * 返回 Promise<boolean>：true = 已作为卡片（chip）插入；false = 当前没有可用的 DSH composer，
 * 调用方可以回落到旧的文本插入。事件同步派发、异步 resolve；没人监听时立即 false。
 */
export function requestContextCard(request: ContextCardRequest): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false)
  return new Promise<boolean>(resolve => {
    let settled = false
    let timer: number | undefined
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      if (timer !== undefined) window.clearTimeout(timer)
      resolve(ok)
    }
    // 没有 Workbench 监听（例如测试 harness/工作台未挂载）时不能永久挂起按钮。
    timer = window.setTimeout(() => finish(false), 1500)
    window.dispatchEvent(new CustomEvent<ContextCardEventDetail>(CONTEXT_CARD_EVENT, { detail: { ...request, resolve: finish } }))
  })
}
