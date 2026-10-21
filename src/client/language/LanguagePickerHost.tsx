/**
 * 语言服务弹层的 React 宿主。
 *
 * 动作层（actions.ts）在键盘/鼠标事件里触发，不在 React 树中；它们通过事件把「要显示什么」
 * 交给 Workbench，由这个组件用统一的 QuickPick 渲染。动态搜索（工作区符号）在这里防抖，
 * 并丢弃过期结果 —— 用户快速输入时后到的旧响应不能覆盖新结果。
 */
import { useEffect, useRef, useState } from 'react'
import { QuickPick, type QuickPickItem } from '../quickPick.tsx'
import type { LanguagePickerRequest } from './picker.ts'

/** 动态搜索防抖：输入停顿这么久才向宿主查询。 */
export const LANGUAGE_SEARCH_DEBOUNCE_MS = 140

export function LanguagePickerHost(props: { request: LanguagePickerRequest; onClose(): void }) {
  const [items, setItems] = useState<readonly QuickPickItem[]>(props.request.items ?? [])
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const generation = useRef(0)

  useEffect(() => {
    setItems(props.request.items ?? [])
    // 换一个请求（例如上一轮的搜索结果还没回来）时，旧结果必须作废。
    generation.current++
    return () => { if (timer.current !== undefined) clearTimeout(timer.current) }
  }, [props.request])

  const search = props.request.search
  const onFilterChange = (value: string) => {
    if (search === undefined) return
    if (timer.current !== undefined) clearTimeout(timer.current)
    const current = ++generation.current
    if (value.trim() === '') { setItems([]); return }
    timer.current = setTimeout(() => {
      search(value, next => {
        if (current !== generation.current) return
        setItems(next)
      })
    }, LANGUAGE_SEARCH_DEBOUNCE_MS)
  }

  const close = (): void => {
    if (timer.current !== undefined) clearTimeout(timer.current)
    props.onClose()
  }

  return <QuickPick
    title={props.request.title}
    placeholder={props.request.placeholder}
    items={items}
    onFilterChange={search === undefined ? undefined : onFilterChange}
    allowEmpty={props.request.allowEmpty}
    submitLabel={props.request.submitLabel}
    onClose={close}
    onSubmit={props.request.onSubmit === undefined ? undefined : value => { close(); props.request.onSubmit?.(value) }}
    onPick={props.request.onPick === undefined ? undefined : item => { close(); props.request.onPick?.(item.id) }}
    emptyText={search === undefined ? '没有匹配项' : '输入以搜索'}
  />
}
