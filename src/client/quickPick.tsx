import { useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Icon } from './Icon.tsx'

/**
 * 通用快速选择框（VS Code quick pick 的形状）：顶部居中、输入即过滤、↑↓/Enter/Esc 键盘操作。
 *
 * 分支选择、贮藏、标签删除、提交信息、分支名/标签名输入都用它 —— 以前分支用的是 `window.prompt`，
 * 不能搜索、不能键盘操作，还会阻塞渲染进程。
 */

export interface QuickPickItem {
  /** 稳定标识；点选后回调里带回。 */
  id: string
  label: string
  /** 右侧灰字（远程分支、贮藏说明之类）。 */
  detail?: string
  /** 当前项（当前分支/HEAD）：左侧打勾。 */
  current?: boolean
}

/** 过滤纯函数：标签与详情做大小写不敏感的子串匹配，保持原顺序。 */
export function filterQuickPickItems(items: readonly QuickPickItem[], filter: string): QuickPickItem[] {
  const needle = filter.trim().toLowerCase()
  if (needle === '') return [...items]
  return items.filter(item => `${item.label} ${item.detail ?? ''}`.toLowerCase().includes(needle))
}

export function QuickPick(props: {
  title: string
  placeholder?: string
  items?: readonly QuickPickItem[]
  /** 输入并回车时调用（输入模式）；与 onPick 互斥使用时只走输入。 */
  onSubmit?(value: string): void
  /** 输入模式下回车创建项的文案；不传则不显示这一行（纯输入框）。 */
  submitLabel?(value: string): string
  /** 输入模式是否允许空串（例如可选的贮藏说明）。 */
  allowEmpty?: boolean
  onPick?(item: QuickPickItem): void
  /** 多选模式：点一行调用 onToggle 且不关闭选择器（分支过滤用）。 */
  onToggle?(item: QuickPickItem): void
  /** 多选模式下已勾选的 id。 */
  selectedIds?: readonly string[]
  /**
   * 输入变化回调（动态搜索用：工作区符号这类结果由远端返回，不在本地过滤）。
   * 提供它时列表仍会按本地过滤再收窄一遍，所以远端结果可以是宽集。
   */
  onFilterChange?(value: string): void
  onClose(): void
  emptyText?: string
}) {
  const items = useMemo(() => props.items ?? [], [props.items])
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)
  const visible = useMemo(() => filterQuickPickItems(items, filter), [items, filter])
  useEffect(() => setActive(0), [filter])
  const submit = () => {
    const value = filter.trim()
    if (props.onSubmit === undefined) return
    if (value === '' && props.allowEmpty !== true) return
    props.onSubmit(value)
  }
  const pick = (item: QuickPickItem) => props.onPick?.(item)
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); props.onClose(); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (visible.length === 0) return
      setActive(value => event.key === 'ArrowDown' ? Math.min(value + 1, visible.length - 1) : Math.max(value - 1, 0))
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    const item = visible[active]
    if (item !== undefined && props.onToggle !== undefined) { props.onToggle(item); return }
    if (item !== undefined && props.onPick !== undefined && filter.trim() === '') { pick(item); return }
    if (props.onSubmit !== undefined) { submit(); return }
    if (item !== undefined) pick(item)
  }
  const createLabel = props.submitLabel === undefined ? undefined : props.submitLabel(filter.trim())
  const showCreate = createLabel !== undefined && (filter.trim() !== '' || props.allowEmpty === true)
  return <div className="dvw-quickpick-backdrop" onMouseDown={props.onClose}>
    <div className="dvw-quickpick" role="dialog" aria-label={props.title} onMouseDown={event => event.stopPropagation()}>
      <div className="dvw-quickpick-head">{props.title}</div>
      <input className="dvw-input" autoFocus value={filter} aria-label={props.title} placeholder={props.placeholder ?? props.title}
        onChange={event => { setFilter(event.target.value); props.onFilterChange?.(event.target.value) }} onKeyDown={onKeyDown}/>
      {showCreate && <button className="dvw-quickpick-item dvw-quickpick-create" onClick={submit}><Icon name="add"/><span>{createLabel}</span></button>}
      {props.onPick !== undefined && <div className="dvw-quickpick-list">
        {visible.map((item, index) => <button className="dvw-quickpick-item" key={item.id} data-active={index === active || undefined}
          onMouseDown={event => event.preventDefault()} onClick={() => { if (props.onToggle !== undefined) props.onToggle(item); else pick(item) }}>
          {(item.current === true || props.selectedIds?.includes(item.id) === true) ? <Icon name="check"/> : <span className="dvw-quickpick-blank" aria-hidden="true"/>}
          <span className="dvw-quickpick-name">{item.label}</span>
          {item.detail !== undefined && <span className="dvw-quickpick-meta">{item.detail}</span>}
        </button>)}
        {visible.length === 0 && <div className="dvw-quickpick-empty">{props.emptyText ?? (props.onSubmit === undefined ? '没有匹配项' : '直接输入后回车')}</div>}
      </div>}
    </div>
  </div>
}
