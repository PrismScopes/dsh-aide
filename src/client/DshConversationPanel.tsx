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
    const attach = () => {
      const next = findDshConversationRoot()
      if (next === attached) return
      attached?.removeAttribute('data-dvw-conversation-panel')
      attached?.style.removeProperty('--dvw-chat-width')
      attached?.style.removeProperty('--dvw-status-height')
      attached = next
      attached?.setAttribute('data-dvw-conversation-panel', '')
      attached?.style.setProperty('--dvw-chat-width', `${width}px`)
      attached?.style.setProperty('--dvw-status-height', `${statusHeight}px`)
    }
    attach()
    const observer = new MutationObserver(attach)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      attached?.removeAttribute('data-dvw-conversation-panel')
      attached?.style.removeProperty('--dvw-chat-width')
      attached?.style.removeProperty('--dvw-status-height')
    }
  }, [visible, width, statusHeight])
  return null
}

/**
 * 旧版 DSH 用 body[data-ds-dark-theme] 表达配色，可借它把内嵌对话栏临时对齐到工作台配色。
 * DSH 0.2.0 起主题由 html[data-ds-theme-source] 决定：实测写 documentElement.style.colorScheme
 * 会被宿主自身的主题解析读走，选「深色」会连带把 DSH 主界面一起变暗（冲突）。
 * 因此宿主已有权威主题来源时不再介入，内嵌对话栏始终跟随宿主主题。
 */
export function DshConversationTheme({ visible, colorScheme, followDsh }: { visible: boolean; colorScheme: 'dark' | 'light'; followDsh: boolean }) {
  useLayoutEffect(() => {
    if (!visible || followDsh) return
    const root = document.documentElement
    // 宿主已有权威主题来源：保持其解析结果，不代它决定配色。
    if (root.dataset.dsThemeSource !== undefined) return
    const body = document.body
    const wasDark = body.hasAttribute('data-ds-dark-theme')
    body.toggleAttribute('data-ds-dark-theme', colorScheme === 'dark')
    return () => { body.toggleAttribute('data-ds-dark-theme', wasDark) }
  }, [visible, colorScheme, followDsh])
  return null
}
