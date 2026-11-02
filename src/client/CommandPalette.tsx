import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { fileIcon, fileIconUrl, Icon } from './Icon.tsx'
import { rankPaletteEntries, splitPaletteInput, type MatchRange, type PaletteEntry } from './palette.ts'

/**
 * 命令面板 / 快速打开（一个输入框两种模式，`>` 开头切到命令）。
 *
 * 为什么不是两个组件：两者只差数据源与占位文案，键盘语义、滚动、高亮、空状态完全一样；
 * 合在一起后，用户在一个输入框里从文件切命令（或反过来）不会丢失焦点。
 *
 * 每帧最多渲染 `MAX_ROWS` 行：结果在 rankPaletteEntries 里已按分数截断，这里不再做虚拟滚动。
 * 输入框的 value 是唯一状态，模式与查询都由 splitPaletteInput 派生，没有两份真相。
 */

/** 结果上限：文件最多 120 行（再多也翻不动），命令清单目前 60 余条，空查询时也必须全部可见。 */
const MAX_ROWS = 120

export interface CommandPaletteProps {
  /** 初始模式：Ctrl+P 是文件，Ctrl+Shift+P 是命令。 */
  initialMode: 'file' | 'command'
  fileEntries: readonly PaletteEntry[]
  commandEntries: readonly PaletteEntry[]
  /** 工作区文件还在读取：空查询时给一句状态，避免看起来像「工作区没有文件」。 */
  fileLoading?: boolean
  onPick(entry: PaletteEntry): void
  onClose(): void
}

export function CommandPalette(props: CommandPaletteProps) {
  const [value, setValue] = useState(props.initialMode === 'command' ? '>' : '')
  const parsed = splitPaletteInput(value)
  const entries = parsed.mode === 'command' ? props.commandEntries : props.fileEntries
  // 排序放到延迟值上：大工作区（两万条）一次排序 5–9ms，直接跟着每次按键跑会让输入发涩。
  // 模式切换仍然即时 —— entries 由当前输入决定，延迟的只是过滤串。
  const deferredQuery = useDeferredValue(parsed.query)
  const ranked = useMemo(() => rankPaletteEntries(entries, deferredQuery, MAX_ROWS), [entries, deferredQuery])
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // 查询或模式变化后，高亮回到第一条：继续按 Enter 打开的就是新结果的第一项。
  useEffect(() => setActive(0), [parsed.mode, deferredQuery])

  // 键盘上下移动时把当前项滚进可视区。只在 active 变化时跑一次，不监听滚动。
  useEffect(() => {
    const list = listRef.current
    if (list === null) return
    const row = list.querySelector<HTMLElement>('[data-active=true]')
    row?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const pick = (entry: PaletteEntry | undefined) => {
    if (entry !== undefined) props.onPick(entry)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); props.onClose(); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (ranked.length === 0) return
      setActive(current => {
        const next = event.key === 'ArrowDown' ? current + 1 : current - 1
        return Math.max(0, Math.min(next, ranked.length - 1))
      })
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      pick(ranked[active]?.entry)
    }
  }

  const placeholder = parsed.mode === 'command' ? '输入命令名称' : '按文件名搜索，输入 > 查找命令'
  let previousGroup: string | undefined
  return <div className="dvw-palette-backdrop" onMouseDown={props.onClose}>
    <div className="dvw-palette" role="dialog" aria-label={parsed.mode === 'command' ? '命令面板' : '快速打开'} onMouseDown={event => event.stopPropagation()}>
      <div className="dvw-palette-search">
        <Icon name={parsed.mode === 'command' ? 'ellipsis' : 'search'} className="dvw-palette-search-icon"/>
        <input className="dvw-palette-input" autoFocus value={value} placeholder={placeholder} aria-label={placeholder}
          aria-controls="dvw-palette-list" aria-activedescendant={ranked[active] === undefined ? undefined : `dvw-palette-${ranked[active]?.entry.id}`}
          onChange={event => setValue(event.target.value)} onKeyDown={onKeyDown}/>
      </div>
      <div className="dvw-palette-list" id="dvw-palette-list" role="listbox" ref={listRef}>
        {ranked.map((row, index) => {
          const group = row.entry.kind === 'command' ? row.entry.group : undefined
          const header = group !== undefined && group !== previousGroup ? group : undefined
          previousGroup = group ?? previousGroup
          return <div key={row.entry.id}>
            {header !== undefined && <div className="dvw-palette-group">{header}</div>}
            <button type="button" role="option" id={`dvw-palette-${row.entry.id}`} className="dvw-palette-row" data-active={index === active || undefined}
              aria-selected={index === active} onMouseMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => pick(row.entry)}>
              <PaletteGlyph entry={row.entry}/>
              <span className="dvw-palette-label">{highlight(row.entry.label, row.ranges)}</span>
              {row.entry.detail !== undefined && row.entry.detail !== '' && <span className="dvw-palette-detail">{row.entry.detail}</span>}
              {row.entry.keys !== undefined && row.entry.keys.length > 0 && <span className="dvw-palette-keys">{row.entry.keys.map(key => <kbd key={key}>{key}</kbd>)}</span>}
            </button>
          </div>
        })}
        {ranked.length === 0 && <div className="dvw-palette-empty">
          {parsed.mode === 'file' && props.fileLoading === true ? '正在读取工作区文件…' : parsed.mode === 'file' ? '没有匹配的文件，输入 > 查找命令' : '没有匹配的命令'}
        </div>}
      </div>
      <div className="dvw-palette-foot"><span>↑↓ 选择</span><span>Enter 打开</span><span>Esc 关闭</span><span className="dvw-palette-foot-mode">{parsed.mode === 'command' ? '命令' : '文件'}</span></div>
    </div>
  </div>
}

/** 文件用彩色类型图标，命令用通用字形；两者尺寸一致，行高不跳。 */
function PaletteGlyph({ entry }: { entry: PaletteEntry }) {
  if (entry.kind === 'command') return <Icon name="chevron-right" className="dvw-palette-glyph"/>
  const url = fileIconUrl(entry.label)
  return url === undefined
    ? <Icon name={fileIcon(entry.label)} className="dvw-palette-glyph"/>
    : <img className="dvw-palette-glyph" src={url} alt="" loading="lazy" decoding="async"/>
}

/** 命中字符加底色；没有命中区间（目录命中）时原样返回。 */
function highlight(text: string, ranges: readonly MatchRange[]) {
  if (ranges.length === 0) return text
  const parts: Array<string | { hit: string }> = []
  let cursor = 0
  for (const range of ranges) {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start))
    parts.push({ hit: text.slice(range.start, range.end) })
    cursor = range.end
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts.map((part, index) => typeof part === 'string' ? part : <mark className="dvw-palette-hit" key={index}>{part.hit}</mark>)
}
