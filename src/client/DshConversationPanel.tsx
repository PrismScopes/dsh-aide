import { useLayoutEffect } from 'react'

/** Locate the resident DSH conversation without depending on generated CSS module names. */
export function findDshConversationRoot(documentRoot: Document = document): HTMLElement | null {
  const scroller = documentRoot.querySelector<HTMLElement>('[data-conversation-scroll]')
  const root = scroller?.parentElement
  // DSH 0.2.0 把阶段标记为 data-content-phase；旧版是 data-phase。两者都认，
  // 否则宿主对话栏搬不进工作台右列，会与工作台的第四列大面积重叠。
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
