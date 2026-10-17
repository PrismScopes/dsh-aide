import { useLayoutEffect } from 'react'

/**
 * Locate the resident DSH conversation without depending on generated CSS module names.
 *
 * DSH 0.2.1 把主视图包进 `[data-phase]` 容器，正文滚动节点在其内部；后台保活的会话也可能
 * 有同样的滚动节点，所以必须限定在 phase 容器里找，否则会把别人的对话搬进工作台。
 * 0.2.0 的旧结构（滚动节点的父元素带 data-phase / data-content-phase）保留为回退。
 */
export function findDshConversationRoot(documentRoot: Document = document): HTMLElement | null {
  const phase = documentRoot.querySelector<HTMLElement>('[data-phase] [data-conversation-scroll]')?.closest<HTMLElement>('[data-phase]')
  if (phase != null) return phase
  const scroller = documentRoot.querySelector<HTMLElement>('[data-conversation-scroll]')
  const root = scroller?.parentElement
  return root instanceof HTMLElement && (root.dataset.phase !== undefined || root.dataset.contentPhase !== undefined) ? root : null
}

/** Keep the official conversation mounted while presenting it in the workbench's right column. */
export function DshConversationPanel({ visible, width, statusHeight }: { visible: boolean; width: number; statusHeight: number }) {
  useLayoutEffect(() => {
    if (!visible) return
    let attached: HTMLElement | null = null
    let observed: HTMLElement | null = null
    let frame = 0
    const observer = new MutationObserver(() => { if (frame === 0) frame = requestAnimationFrame(apply) })
    function apply() {
      frame = 0
      const next = findDshConversationRoot()
      if (next === attached) return
      attached?.removeAttribute('data-dvw-conversation-panel')
      attached?.style.removeProperty('--dvw-chat-width')
      attached?.style.removeProperty('--dvw-status-height')
      attached = next
      attached?.setAttribute('data-dvw-conversation-panel', '')
      attached?.style.setProperty('--dvw-chat-width', `${width}px`)
      attached?.style.setProperty('--dvw-status-height', `${statusHeight}px`)
      /**
       * 只盯对话栏的直接父元素，且**不带 subtree**。会话正文渲染会在 body 子树上搅出成千上万次
       * 变动，每一条都要生成 mutation record——而 DSH 重建会话视图（打开/关闭工作台）时正是这种
       * 时刻，那部分开销就是卡顿来源。深层变动不会替换对话栏本身，无需监听；对话栏真被重建时，
       * 父元素的直接子节点必然变化，这一层足够捕捉。配合 rAF 合并，代价与页面变动量解耦。
       */
      const parent = next?.parentElement ?? null
      if (parent !== observed) {
        observer.disconnect()
        observed = parent
        if (parent !== null) observer.observe(parent, { childList: true })
      }
    }
    apply()
    return () => {
      observer.disconnect()
      if (frame !== 0) cancelAnimationFrame(frame)
      attached?.removeAttribute('data-dvw-conversation-panel')
      attached?.style.removeProperty('--dvw-chat-width')
      attached?.style.removeProperty('--dvw-status-height')
    }
  }, [visible, width, statusHeight])
  return null
}

/**
 * 工作台不再提供配色选项，始终跟随 DSH 主题，因此原先那个会改写 body[data-ds-dark-theme]
 * 的 DshConversationTheme 已删除 —— 内嵌对话栏一律随宿主主题，不再自行介入。
 */
