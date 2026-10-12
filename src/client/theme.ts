import { useEffect, useState } from 'react'

/** 解析 #rgb / #rrggbb / rgb() / rgba() 为 [r,g,b]；无法解析时返回 undefined。 */
export function parseColor(value: string): [number, number, number] | undefined {
  const v = value.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v)
  if (hex !== null) {
    const raw = hex[1]!
    const full = raw.length === 3 ? raw.split('').map(c => c + c).join('') : raw
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(v)
  if (rgb !== null) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  return undefined
}

/** sRGB 相对亮度是否偏暗。 */
export function isDarkColor(rgb: [number, number, number]): boolean {
  const [r, g, b] = rgb.map(c => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5
}

/**
 * 判断宿主当前是否为深色。
 *
 * 以宿主实际渲染出来的 --dsw-alias-bg-base 为准。只看 html[data-ds-theme-source] 是不够的：
 * 该属性为 "system" 时只表示「跟随系统」，并不等于 DSH 最终采用的明暗 —— 用户可能在设置里
 * 显式选了深色而系统仍是浅色。此前正是这种情况被误判成浅色，于是深色底上套了一套浅色语法色
 * （关键字是纯蓝 #0000ff、注释是纯绿 #008000），在深底上几乎看不见，代码看起来就是「发灰」。
 */
export function useDshDarkTheme(): boolean {
  const read = () => {
    const fromToken = parseColor(getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base'))
    if (fromToken !== undefined) return isDarkColor(fromToken)
    // 拿不到底色时回退到属性与系统偏好。
    const source = document.documentElement.dataset.dsThemeSource
    if (source === 'dark') return true
    if (source === 'light') return false
    if (document.body.hasAttribute('data-ds-dark-theme')) return true
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
  }
  const [dark, setDark] = useState(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(read()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ds-theme-source'] })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined
    const onChange = () => setDark(read())
    media?.addEventListener('change', onChange)
    return () => { observer.disconnect(); media?.removeEventListener('change', onChange) }
  }, [])
  return dark
}
