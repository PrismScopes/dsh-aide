/**
 * 提交图的视图设置（列显示 / 列宽 / emoji 替换）。
 *
 * 为什么不塞进设置页的 preferences：这些是「这台机器上这个仓库怎么看提交图」的显示偏好，
 * 原版 Git Graph 也是按工作区存在本地（VS Code workspaceState）。改动频繁（拖列宽）而且只影响
 * 提交图标签页，放在这里按仓库持久化最省事，也不污染全局编辑器设置。
 */

export interface GitGraphViewSettings {
  showAuthor: boolean
  showDate: boolean
  showHash: boolean
  /** 列宽（px），拖动表头时写回；夹取范围 40–320。 */
  authorWidth: number
  dateWidth: number
  hashWidth: number
  /** 提交说明里的 emoji 短代码替换（:bug: → 🐛）。 */
  emoji: boolean
}

export const DEFAULT_GIT_VIEW: GitGraphViewSettings = {
  showAuthor: true, showDate: true, showHash: true,
  authorWidth: 90, dateWidth: 110, hashWidth: 80,
  emoji: true,
}

export const COLUMN_WIDTH = { min: 40, max: 320 } as const

/** 列宽夹取：非有限数字回落 fallback，越界夹到 40–320。 */
export function clampColumnWidth(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(COLUMN_WIDTH.min, Math.min(COLUMN_WIDTH.max, Math.round(value)))
}

/** 宽松解析持久化内容：逐字段校验，坏数据只让该项回落默认值。 */
export function parseGitViewSettings(raw: string | null): GitGraphViewSettings {
  if (raw === null || raw === '') return { ...DEFAULT_GIT_VIEW }
  let value: unknown
  try { value = JSON.parse(raw) } catch { return { ...DEFAULT_GIT_VIEW } }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_GIT_VIEW }
  const source = value as Record<string, unknown>
  const flag = (key: keyof GitGraphViewSettings): boolean => typeof source[key] === 'boolean' ? source[key] as boolean : DEFAULT_GIT_VIEW[key] as boolean
  const width = (key: 'authorWidth' | 'dateWidth' | 'hashWidth'): number => typeof source[key] === 'number' ? clampColumnWidth(source[key] as number, DEFAULT_GIT_VIEW[key]) : DEFAULT_GIT_VIEW[key]
  return { showAuthor: flag('showAuthor'), showDate: flag('showDate'), showHash: flag('showHash'), authorWidth: width('authorWidth'), dateWidth: width('dateWidth'), hashWidth: width('hashWidth'), emoji: flag('emoji') }
}

/** 按仓库分别保存：换一个仓库不会把上一个仓库的列宽/列显示带过来。 */
export function gitViewStorageKey(repository: string): string {
  return 'dvw:git-view:v1:' + repository
}
