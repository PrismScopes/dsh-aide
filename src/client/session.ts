import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'

/**
 * 主视图会话：DSH 0.2.1 起没有再提供 state.current，官方取法是找 retainedBy.mainView > 0 的会话。
 * 后台保活的会话不算主视图，否则工作台会跟着后台会话的工作区跑。
 */
export function mainViewSession(state: SessionListState) {
  return Object.values(state.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)
}
