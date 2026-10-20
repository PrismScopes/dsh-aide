import type { MenuEntry } from './ContextMenu.tsx'

/**
 * 编辑器右键菜单的**扩展点**。
 *
 * 为什么要有这一层：编辑器菜单项会越来越多（标准编辑项、DeepSeek Harness 子菜单、以后可能还有
 * 补全/终端/调试等适配器）。如果都写死在 `MonacoEditor.tsx` 里，每加一项就要改组件、还可能撞上
 * 别人的改动；而工作台是把 `vscodeWorkbench` 服务暴露给其它插件的，那些插件也需要能往这个菜单里
 * 加自己的项。所以这里提供一份进程内的贡献点注册表：
 *   - 本插件内部（比如 DSH 子菜单）直接调用 `registerEditorMenuContribution`；
 *   - 其它插件通过 `ctx.get('vscodeWorkbench').registerEditorMenuContribution(...)` 注册；
 *   - `MonacoEditor` 在打开菜单时把注册表里的项按 `order` 拼到标准编辑项后面。
 *
 * 菜单项本身仍是 `ContextMenu.tsx` 的纯数据（`MenuEntry`），可单测；这里只管「有哪些贡献者」。
 */

/** 打开菜单那一刻的编辑器状态，贡献者据此决定项是否可用。 */
export interface EditorMenuTarget {
  /** 工作区相对路径；预览类编辑器可能没有。 */
  filePath?: string
  language: string
  hasSelection: boolean
  selectionText: string
  /** 1 起的行号；没有选区时是光标所在行。 */
  lineStart: number
  lineEnd: number
}

export interface EditorMenuContribution {
  /** 稳定标识，重复注册会被拒绝（显式报错好过静默覆盖）。 */
  id: string
  /** 越小越靠前；缺省按 id 排序。 */
  order?: number
  /**
   * 插在标准编辑项之前还是之后。
   *
   * `top` 给「DeepSeek Harness」这类需要占最上面的入口（用户明确要求：选中词条时置顶）；
   * `bottom`（缺省）给补充性的适配器项。同组内仍按 `order` 再按 id 排序。
   */
  place?: 'top' | 'bottom'
  /** 返回要追加的分组内容；分隔线由工作台在组与组之间补，贡献者自己不必在首尾加。 */
  entries(target: EditorMenuTarget): readonly MenuEntry[]
}

const contributions = new Map<string, EditorMenuContribution>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

/** 注册一个贡献者；返回注销函数（重复调用安全）。 */
export function registerEditorMenuContribution(contribution: EditorMenuContribution): () => void {
  if (contribution.id === '') throw new Error('editor menu contribution id must not be empty')
  if (contributions.has(contribution.id)) throw new Error(`editor menu contribution already registered: ${contribution.id}`)
  contributions.set(contribution.id, contribution)
  emit()
  return () => {
    if (!contributions.delete(contribution.id)) return
    emit()
  }
}

/** 当前贡献者，按 order（缺省用 0）再按 id 排序 —— 顺序稳定，菜单不会每次打开都跳来跳去。 */
export function editorMenuContributions(): readonly EditorMenuContribution[] {
  return [...contributions.values()].sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id))
}

/** 订阅贡献者变化（MonacoEditor 用它重建菜单项）。 */
export function subscribeEditorMenuContributions(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * 把贡献者的项拼成一段菜单内容：每组之间补一条分隔线，空组直接跳过。
 *
 * `place` 决定取哪一组：`top`（标准编辑项之上）或 `bottom`（缺省，标准编辑项之下）。
 * 贡献者返回空数组是合法状态（例如没有选中文本时），此时不产生多余的分隔线。
 */
export function contributionEntries(target: EditorMenuTarget, place: 'top' | 'bottom' = 'bottom'): MenuEntry[] {
  const entries: MenuEntry[] = []
  for (const contribution of editorMenuContributions()) {
    if ((contribution.place ?? 'bottom') !== place) continue
    let produced: readonly MenuEntry[]
    try {
      produced = contribution.entries(target)
    } catch (error) {
      // 一个贡献者报错不能连累整张菜单：跳过它，让其余项照常可用。
      console.warn(`[dvw] 编辑器菜单贡献者 ${contribution.id} 生成菜单项失败：`, error)
      continue
    }
    if (produced.length === 0) continue
    if (entries.length > 0) entries.push({ kind: 'separator' })
    entries.push(...produced)
  }
  return entries
}

/** 供测试清理注册表。 */
export function resetEditorMenuContributions(): void {
  contributions.clear()
  listeners.clear()
}
