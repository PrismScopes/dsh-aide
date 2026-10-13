/**
 * 实验分组（文档 4.3 的环境元数据、文档七的「参数按实验分组灰度」）。
 *
 * 分组由服务端决定，客户端不固化。分配必须**按会话稳定**：同一会话的连续请求落在同一组，
 * 否则一次补全用 A 组参数、下一次用 B 组，数据没法归因。
 */
import { DEFAULT_COMPLETION_PARAMS, type CompletionParams } from './params.ts'

export const COMPLETION_EXPERIMENT_GROUPS = ['control', 'treatment'] as const

/**
 * 按会话标识稳定分组。
 *
 * 用 FNV-1a 而不是随机数：同一个会话必须永远得到同一组，而随机数做不到（进程重启就变）。
 * 也不需要密码学强度 —— 这里只是分流，不是安全边界。
 */
export function groupForSession(sessionId: string, groups: readonly string[] = COMPLETION_EXPERIMENT_GROUPS): string {
  const fallback = groups[0] ?? 'control'
  if (groups.length <= 1) return fallback
  let hash = 0x811c9dc5
  for (let index = 0; index < sessionId.length; index++) {
    hash ^= sessionId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return groups[hash % groups.length] ?? fallback
}

/**
 * 分组对应的参数。
 *
 * control 用文档第七节给出的起点值；treatment 只动两个最影响体感的旋钮（防抖更快、片段更多）。
 * 这两个值本身未经数据验证 —— 分组机制的目的是让它们**可以被数据验证**，而不是先给出答案。
 */
export function paramsForGroup(group: string): CompletionParams {
  if (group !== 'treatment') return DEFAULT_COMPLETION_PARAMS
  return { ...DEFAULT_COMPLETION_PARAMS, debounceFastMs: 70, debounceSlowMs: 110, snippetCount: 6 }
}
