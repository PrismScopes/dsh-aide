/**
 * 打开标签的持久化（按工作区根目录分别保存）。
 *
 * 工作台隐藏时 `Workbench` 的标签状态本来只活在内存里：回 DSH 主页面说句话再回来，
 * 或者刷新页面/重启 DSH，打开过的文件就全没了。这里只持久化**标签栏**（路径、顺序、
 * 当前标签、几个虚拟标签的参数），不存正文：
 *   - 正文可能很大（几 MB 的 Markdown / diff），写 localStorage 会拖慢每一次输入；
 *   - 正文会过期：恢复时走和「点开一个文件」完全相同的加载路径，读到的永远是磁盘上的最新内容。
 *
 * 键带 `v1`：形状一变就换前缀，旧数据自然失效，不需要迁移代码。
 */

/** 存储键前缀；后面接工作区根目录。 */
export const OPEN_TABS_KEY_PREFIX = 'dvw:open-tabs:v1:'

/** 最多记住多少个标签。超出部分不落库（足够覆盖正常使用，也不让 localStorage 无限长）。 */
export const MAX_STORED_OPEN_TABS = 40

/** 一个标签在存储里的样子：恢复标签栏需要的最小信息。 */
export interface StoredTab {
  path: string
  title?: string
  line?: number
  column?: number
  graphAll?: boolean
}

/** 一次持久化的完整内容。 */
export interface StoredOpenTabs {
  tabs: StoredTab[]
  active?: string
}

/** 标签里与持久化有关的字段（工作台的 Tab 结构兼容）。 */
interface TabLike {
  path: string
  title?: string
  line?: number
  column?: number
  dirty?: boolean
  graphAll?: boolean
}

/** 工作区根目录 → 存储键。 */
export function openTabsKey(root: string): string {
  return OPEN_TABS_KEY_PREFIX + root
}

/**
 * 这个标签要不要落库。
 *
 * 排除两类：
 *   - `diff:` 标签是某次提交/暂存区差异的**内容快照**，恢复出来只会是一份过期副本；
 *   - 脏标签带未保存草稿。草稿要恢复得连正文一起存，而正文过期比「重开时没有这个标签」更糟。
 */
export function storableTab(tab: Pick<TabLike, 'path' | 'dirty'>): boolean {
  return tab.dirty !== true && !tab.path.startsWith('diff:')
}

/** 把当前标签列表压成要落库的形状（丢弃不可恢复的标签、去重、按顺序截断）。 */
export function serializeOpenTabs(tabs: readonly TabLike[], active?: string): StoredOpenTabs {
  const seen = new Set<string>()
  const stored: StoredTab[] = []
  for (const tab of tabs) {
    if (!storableTab(tab) || seen.has(tab.path)) continue
    seen.add(tab.path)
    const row: StoredTab = { path: tab.path }
    if (tab.title !== undefined) row.title = tab.title
    if (typeof tab.line === 'number' && Number.isFinite(tab.line)) row.line = tab.line
    if (typeof tab.column === 'number' && Number.isFinite(tab.column)) row.column = tab.column
    if (tab.graphAll === true) row.graphAll = true
    stored.push(row)
    if (stored.length >= MAX_STORED_OPEN_TABS) break
  }
  // 当前标签不在保留集合里（比如是脏标签）时不记它，恢复时回到第一个标签。
  return active !== undefined && stored.some(row => row.path === active) ? { tabs: stored, active } : { tabs: stored }
}

/**
 * 解析 localStorage 里的原值。任何不认识的形状都返回 `undefined`
 * —— 这是用户可见状态的入口，宁可当作「没有存过」，也不要把半截数据塞进标签栏。
 */
export function parseStoredOpenTabs(raw: string | null | undefined): StoredOpenTabs | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  let value: unknown
  try { value = JSON.parse(raw) } catch { return undefined }
  if (value === null || typeof value !== 'object') return undefined
  const record = value as { tabs?: unknown; active?: unknown }
  if (!Array.isArray(record.tabs)) return undefined
  const tabs: StoredTab[] = []
  for (const entry of record.tabs) {
    if (entry === null || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    if (typeof row.path !== 'string') continue
    const tab: StoredTab = { path: row.path }
    if (typeof row.title === 'string') tab.title = row.title
    if (typeof row.line === 'number' && Number.isFinite(row.line)) tab.line = row.line
    if (typeof row.column === 'number' && Number.isFinite(row.column)) tab.column = row.column
    if (row.graphAll === true) tab.graphAll = true
    tabs.push(tab)
    if (tabs.length >= MAX_STORED_OPEN_TABS) break
  }
  const active = typeof record.active === 'string' ? record.active : undefined
  return active === undefined ? { tabs } : { tabs, active }
}

/**
 * 一个存储里的路径还能不能恢复成标签。
 *
 * `virtualPaths` 是虚拟标签白名单（提交图 / Git 输出）。其余路径必须是工作区内的相对路径：
 * 绝对路径、`..` 跳级、以及任何带 `scheme:` 的值（`diff:`、`git:`、Windows 盘符）都拒绝
 * —— 旧数据、手改过的 localStorage、换了工作区都可能塞进来这种值。
 */
export function restorablePath(path: string, virtualPaths: readonly string[]): boolean {
  if (path === '' || path.length > 4096) return false
  if (virtualPaths.includes(path)) return true
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return false
  if (path.startsWith('/') || path.startsWith('\\')) return false
  return !path.split(/[\\/]/).some(segment => segment === '..')
}

/** 把存储内容过滤成可以真正恢复的标签列表（白名单 + 去重 + 截断 + 当前标签归属修正）。 */
export function restorableOpenTabs(stored: StoredOpenTabs | undefined, virtualPaths: readonly string[]): StoredOpenTabs {
  if (stored === undefined) return { tabs: [] }
  const seen = new Set<string>()
  const tabs: StoredTab[] = []
  for (const tab of stored.tabs) {
    if (!restorablePath(tab.path, virtualPaths) || seen.has(tab.path)) continue
    seen.add(tab.path)
    tabs.push(tab)
    if (tabs.length >= MAX_STORED_OPEN_TABS) break
  }
  const active = stored.active !== undefined && seen.has(stored.active) ? stored.active : undefined
  return active === undefined ? { tabs } : { tabs, active }
}
