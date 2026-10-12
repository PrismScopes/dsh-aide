import { useCallback, useEffect, useRef } from 'react'

/**
 * 返回一个防抖后的回调：ms 内重复调用只执行最后一次，卸载时清掉未触发的定时器。
 * 通过 ref 持有最新的 fn，所以不必把它放进依赖。
 */
export function useDebouncedCallback(fn: () => void, ms: number): () => void {
  const fnRef = useRef(fn); fnRef.current = fn
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])
  return useCallback(() => { clearTimeout(timer.current); timer.current = setTimeout(() => fnRef.current(), ms) }, [ms])
}
