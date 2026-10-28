import { useEffect, useMemo, useRef, useState } from 'react'
import type { UIEvent } from 'react'
import { copyText } from './clipboard.ts'
import { requestContextCard } from './contextRequest.ts'
import { openLocationAt } from './language/picker.ts'
import type { BottomPanelProps } from './service.ts'
import {
  DEFAULT_OUTPUT_LEVEL_FILTERS,
  OUTPUT_LEVELS,
  OUTPUT_LEVEL_LABEL,
  clearOutput,
  countOutputLevels,
  filterOutputLines,
  readOutputChannel,
  saveOutputChannel,
  useOutputLines,
  type OutputChannel,
  type OutputLevel,
  type OutputLevelFilters,
  type OutputLine,
} from './output.ts'

/**
 * 「输出」底部面板（对应 VS Code 的 Output 视图）。
 *
 * 两个真实通道：
 * - 语言服务：宿主的 LSP 日志（server stderr、协议告警、启动失败）以及客户端自己记录的连接/扫描事件；
 * - Git：工作台发起的每条 git 动作（与编辑器里的「Git 输出」标签页同一份来源）。
 *
 * 面板职责（存储与过滤分开）：
 * - 过滤只是**隐藏**：级别开关/搜索框只影响渲染，store 一行都不删，重新开启立即恢复；
 * - 五级级别（trace/debug/info/warn/error）各自开关、默认全开，按钮上的计数来自整条通道；
 * - 滚动锁定（显式开关）与「用户上翻自动停止跟随」（隐式状态）是两个独立状态，不合并；
 * - 输出里的 `path:line(:col)` 渲染成可点按钮，点击跳到对应位置（相对路径按 cwd 解析）；
 * - 行数可能到几千，渲染只画可视区 + overscan（固定 18px 行高）。
 *
 * 只读：这里不提供命令行或输入框 —— 输出面板是日志视图，不是终端。
 */

const CHANNELS: readonly { id: OutputChannel; label: string; empty: string }[] = [
  { id: 'language', label: '语言服务', empty: '还没有语言服务输出。打开文件、启动语言服务器或扫描工作区后，日志会显示在这里。' },
  { id: 'git', label: 'Git', empty: '还没有 Git 输出。在源代码管理里执行操作后，命令记录会显示在这里。' },
]

/** 虚拟化的固定行高；与 outputStyles.ts 里 `.dvw-output-line` 的 height/line-height 必须一致。 */
export const OUTPUT_LINE_HEIGHT = 18
/** 加入对话时最多携带的最近行数/字符数（防止整通道日志进草稿与模型上下文）。 */
export const OUTPUT_CARD_LINES = 300
export const OUTPUT_CARD_CHARS = 32000
/** 可视区上下各多渲染的行数，减少快速滚动时的白屏。 */
export const OUTPUT_OVERSCAN = 12
/** 还没测量到 DOM 高度时（服务端渲染、首帧）按这个视口估高。 */
const FALLBACK_VIEWPORT_HEIGHT = 540
/** 滚动容器底部留白（最后一行不贴边）。 */
const BOTTOM_PADDING = 8
/** 距底部多少像素内算「跟随」状态。 */
const FOLLOW_THRESHOLD_PX = 4

/** 级别按钮上的小字形：与问题面板一样用文字符号，不扩 codicon 表。 */
const LEVEL_GLYPH: Readonly<Record<OutputLevel, string>> = { trace: '·', debug: '·', info: '·', warn: '!', error: '✕' }

/** 行首时间：只显示时分秒，日期对「刚发生的输出」没有意义。 */
function formatTime(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/* ────────────────────────────── 虚拟化窗口 ────────────────────────────── */

export interface VisibleLineRange {
  /** 半开区间 [start, end)。 */
  start: number
  end: number
}

/** 根据滚动位置算可视行窗口；超出范围一律夹取，total=0 时返回空窗口。 */
export function visibleLineRange(total: number, scrollTop: number, viewportHeight: number, overscan: number = OUTPUT_OVERSCAN): VisibleLineRange {
  if (total <= 0) return { start: 0, end: 0 }
  const first = Math.max(0, Math.min(total - 1, Math.floor(Math.max(0, scrollTop) / OUTPUT_LINE_HEIGHT)))
  const visible = Math.max(1, Math.ceil(Math.max(0, viewportHeight) / OUTPUT_LINE_HEIGHT))
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(total, first + visible + overscan),
  }
}

/* ────────────────────────────── 文件链接解析 ────────────────────────────── */

export interface OutputLinkTarget {
  /** 输出里写的原始路径（可能是相对路径）。 */
  path: string
  /** 1 基行号（输出文本里的写法）。 */
  line: number
  /** 1 基列号；`path:line` 形式没有。 */
  column?: number
  /** 解析后的绝对路径：跳转用。 */
  absolutePath: string
}

export type OutputSegment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; link: OutputLinkTarget }

/** 路径候选允许的字符：ASCII 路径常见字符 + Windows 盘符冒号。中文/空白/引号都会截断候选。 */
const PATH_CHAR = /[A-Za-z0-9_:.\-\\/]/
const LOCATION_PATTERN = /:(\d+)(?::(\d+))?/g

function pathCandidateBefore(text: string, end: number): string | undefined {
  let start = end
  while (start > 0 && PATH_CHAR.test(text[start - 1] ?? '')) start--
  const raw = text.slice(start, end)
  return raw === '' ? undefined : raw
}

/** 候选是否像路径：绝对路径 / 含分隔符 / 带扩展名的裸文件名；排除 `http://x:8080` 与时间戳。 */
function isPathLike(raw: string): boolean {
  if (raw.length > 512) return false
  let body = raw
  if (/^[A-Za-z]:/.test(raw)) {
    // Windows 绝对路径必须是盘符 + 分隔符；`C:foo` 这种盘符相对路径不认。
    if (!/^[A-Za-z]:[\\/]/.test(raw)) return false
    body = raw.slice(2)
  }
  if (body === '' || body.includes(':')) return false
  if (raw.startsWith('/') || raw.startsWith('\\')) return true
  if (body.includes('/') || body.includes('\\')) return true
  return /\.[A-Za-z][\w.-]*$/.test(body)
}

/** 相对路径按工作区根解析；绝对路径原样返回（Windows 盘符 / `/` / `\` 开头都算绝对）。 */
export function resolveOutputPath(cwd: string, path: string): string {
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\')) return path
  const base = cwd.replace(/[\\/]+$/, '')
  const separator = base.includes('\\') ? '\\' : '/'
  const relative = path.replaceAll('\\', '/')
  return `${base}${separator}${separator === '\\' ? relative.replaceAll('/', '\\') : relative}`
}

/**
 * 从一行输出里找 `path:line` / `path:line:col` 链接。
 *
 * 返回按原文顺序切好的片段：文本片段原样渲染，链接片段渲染成按钮。无法确认是路径的
 * 冒号数字保持纯文本（例如 `12:30:45`、`http://x:8080`、`foo:12`）。
 */
export function parseOutputLinks(text: string, cwd: string): OutputSegment[] {
  const pattern = new RegExp(LOCATION_PATTERN.source, 'g')
  const segments: OutputSegment[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const line = Number.parseInt(match[1] ?? '', 10)
    const column = match[2] === undefined ? undefined : Number.parseInt(match[2], 10)
    if (!Number.isSafeInteger(line) || line < 1) continue
    if (column !== undefined && (!Number.isSafeInteger(column) || column < 1)) continue
    const rawPath = pathCandidateBefore(text, match.index)
    if (rawPath === undefined || !isPathLike(rawPath)) continue
    const start = match.index - rawPath.length
    const end = match.index + match[0].length
    if (start < cursor) continue
    if (start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, start) })
    segments.push({
      kind: 'link',
      text: text.slice(start, end),
      link: { path: rawPath, line, ...(column === undefined ? {} : { column }), absolutePath: resolveOutputPath(cwd, rawPath) },
    })
    cursor = end
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
  if (segments.length === 0) segments.push({ kind: 'text', text })
  return segments
}

/** 一行正文：按链接片段渲染；链接用 button（可 Tab 聚焦、Enter 触发）。 */
function OutputText({ text, cwd }: { text: string; cwd: string }) {
  const segments = useMemo(() => parseOutputLinks(text, cwd), [text, cwd])
  return <span className="dvw-output-text">{segments.map((segment, index) => {
    if (segment.kind === 'text') return <span key={index}>{segment.text}</span>
    const { absolutePath, line, column, path } = segment.link
    return <button
      key={index}
      type="button"
      className="dvw-output-link"
      title={`打开 ${path}:${line}${column === undefined ? '' : `:${column}`}`}
      onClick={() => {
        if (column === undefined) openLocationAt(absolutePath, line - 1)
        else openLocationAt(absolutePath, line - 1, column - 1)
      }}
    >{segment.text}</button>
  })}</span>
}

/* ────────────────────────────── 面板 ────────────────────────────── */

export function OutputPanel({ cwd, visible: panelVisible }: BottomPanelProps) {
  const [channel, setChannel] = useState<OutputChannel>(() => readOutputChannel())
  const [filters, setFilters] = useState<OutputLevelFilters>(DEFAULT_OUTPUT_LEVEL_FILTERS)
  const [query, setQuery] = useState('')
  const [locked, setLocked] = useState(false)
  /** 隐式跟随：用户滚离底部后自动 false；与显式锁定是两件事。 */
  const [following, setFollowing] = useState(true)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const logRef = useRef<HTMLDivElement>(null)
  const savedScrollTop = useRef(0)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const previousChannel = useRef(channel)

  const lines = useOutputLines(channel)
  const counts = useMemo(() => countOutputLevels(lines), [lines])
  const filtered = useMemo(() => filterOutputLines(lines, filters, query), [lines, filters, query])
  const range = visibleLineRange(filtered.length, scrollTop, viewportHeight > 0 ? viewportHeight : FALLBACK_VIEWPORT_HEIGHT)
  const windowLines = filtered.slice(range.start, range.end)

  const channelInfo = CHANNELS.find(entry => entry.id === channel) ?? CHANNELS[0]!
  /** 「当前可见输出」= 过滤后全部行（不是虚拟化的可视窗口），复制/加入对话都用它。 */
  // 上下文卡片的载荷会进 composer 草稿/会话历史：只取最近的窗口，避免把 4000 行整段塞进去。
  const visibleText = useMemo(() => {
    const all = filtered.map(line => `${formatTime(line.at)}  ${line.text}`)
    const kept = all.slice(-OUTPUT_CARD_LINES)
    const text = kept.join('\n')
    return text.length > OUTPUT_CARD_CHARS ? text.slice(-OUTPUT_CARD_CHARS) : text
  }, [filtered])

  // 视口高度：面板拖拽改变高度时虚拟化窗口要跟着变。
  useEffect(() => {
    const element = logRef.current
    if (element === null) return
    const measure = (): void => setViewportHeight(element.clientHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // 以下两种情况下自动滚到底：新行到达且没有锁定/没有被用户上翻；切换通道时总是先看最新。
  useEffect(() => {
    const element = logRef.current
    if (element === null) return
    const switched = previousChannel.current !== channel
    previousChannel.current = channel
    if (switched) {
      element.scrollTop = element.scrollHeight
      savedScrollTop.current = element.scrollTop
      setScrollTop(element.scrollTop)
      return
    }
    if (locked || !following) return
    element.scrollTop = element.scrollHeight
    savedScrollTop.current = element.scrollTop
    setScrollTop(element.scrollTop)
  }, [filtered, channel, locked, following])

  /* 面板从 display:none 恢复时 scrollTop 被浏览器重置：跟随状态回到底部，锁定状态回上次位置。 */
  useEffect(() => {
    if (!panelVisible) return
    const element = logRef.current
    if (element === null) return
    if (locked || !following) {
      if (element.scrollTop !== savedScrollTop.current) element.scrollTop = savedScrollTop.current
    } else {
      element.scrollTop = element.scrollHeight
    }
    setScrollTop(element.scrollTop)
  }, [panelVisible])

  useEffect(() => () => {
    if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current)
  }, [])

  const showNotice = (text: string): void => {
    setNotice(text)
    if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(undefined), 2400)
  }

  const handleScroll = (event: UIEvent<HTMLDivElement>): void => {
    if (!panelVisible) return
    const element = event.currentTarget
    savedScrollTop.current = element.scrollTop
    setScrollTop(element.scrollTop)
    if (element.clientHeight !== viewportHeight) setViewportHeight(element.clientHeight)
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_THRESHOLD_PX
    if (atBottom !== following) setFollowing(atBottom)
  }

  const selectChannel = (next: OutputChannel): void => {
    if (next === channel) return
    setChannel(next)
    saveOutputChannel(next)
    setFollowing(true)
  }

  const toggleLevel = (level: OutputLevel): void => {
    // 只切换渲染开关；store 不受影响，重新打开立即恢复。
    setFilters(current => ({ ...current, [level]: !current[level] }))
  }

  const goToBottom = (): void => {
    setLocked(false)
    setFollowing(true)
    const element = logRef.current
    if (element === null) return
    element.scrollTop = element.scrollHeight
    savedScrollTop.current = element.scrollTop
    setScrollTop(element.scrollTop)
  }

  const toggleLock = (): void => {
    if (locked) goToBottom()
    else setLocked(true)
  }

  const copyVisible = (): void => {
    void copyText(visibleText).then(ok => {
      showNotice(ok ? `已复制 ${filtered.length} 行输出` : '复制失败，请手动选择文本')
    })
  }

  const addToConversation = (): void => {
    const title = `${channelInfo.label}输出`
    void requestContextCard({ kind: 'terminal', text: visibleText, title }).then(ok => {
      if (ok) {
        showNotice('已加入对话')
        return
      }
      // 没有 DSH composer（旧版本/测试环境）：按 contextRequest.ts 的约定回落到复制文本。
      void copyText(visibleText).then(copied => {
        showNotice(copied ? '当前没有可用的对话输入框，已复制输出' : '当前没有可用的对话输入框')
      })
    }).catch(() => showNotice('加入对话失败'))
  }

  return <div className="dvw-output">
    <div className="dvw-output-toolbar">
      <select
        className="dvw-output-channel"
        value={channel}
        aria-label="输出通道"
        onChange={event => selectChannel(event.target.value as OutputChannel)}
      >
        {CHANNELS.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      </select>

      <div className="dvw-output-levels" role="group" aria-label="按级别过滤">
        {OUTPUT_LEVELS.map(level => <button
          key={level}
          type="button"
          className="dvw-output-level"
          data-level={level}
          aria-pressed={filters[level]}
          aria-label={`${OUTPUT_LEVEL_LABEL[level]}（${counts[level]}）`}
          onClick={() => toggleLevel(level)}
        >
          <span className="dvw-output-level-glyph" aria-hidden="true">{LEVEL_GLYPH[level]}</span>
          <span>{OUTPUT_LEVEL_LABEL[level]}</span>
          <span className="dvw-output-count">{counts[level]}</span>
        </button>)}
      </div>

      <input
        className="dvw-output-query"
        type="search"
        value={query}
        placeholder="按内容过滤"
        aria-label="按内容过滤"
        onChange={event => setQuery(event.target.value)}
      />

      <div className="dvw-output-actions">
        <button type="button" className="dvw-output-action" disabled={filtered.length === 0} onClick={copyVisible}>复制</button>
        <button type="button" className="dvw-output-action" disabled={filtered.length === 0} onClick={addToConversation}>加入对话</button>
        <button
          type="button"
          className="dvw-output-action"
          aria-pressed={locked}
          title={locked ? '已锁定：新输出不会把视图滚到底部' : '锁定滚动：新输出不自动滚到底部'}
          onClick={toggleLock}
        >{locked ? '已锁定' : '滚动锁定'}</button>
        {following || filtered.length === 0 ? null : <button type="button" className="dvw-output-action" onClick={goToBottom}>回到底部</button>}
        <button type="button" className="dvw-output-clear" disabled={lines.length === 0} onClick={() => clearOutput(channel)}>清空</button>
      </div>

      {notice === undefined ? null : <span className="dvw-output-notice" role="status">{notice}</span>}
    </div>

    <div
      className="dvw-output-log"
      role="log"
      aria-live="polite"
      aria-label={`${channelInfo.label}输出`}
      ref={logRef}
      onScroll={handleScroll}
    >
      {lines.length === 0
        ? <div className="dvw-output-empty">{channelInfo.empty}</div>
        : filtered.length === 0
          ? <div className="dvw-output-empty">没有匹配的输出。调整级别过滤或清空搜索框试试。</div>
          : <div className="dvw-output-spacer" style={{ height: filtered.length * OUTPUT_LINE_HEIGHT + BOTTOM_PADDING }}>
            <div className="dvw-output-rows" style={{ transform: `translateY(${range.start * OUTPUT_LINE_HEIGHT}px)` }}>
              {windowLines.map((line: OutputLine, index: number) => <div
                className="dvw-output-line"
                data-level={line.level}
                key={`${line.at}:${range.start + index}`}
              >
                <span className="dvw-output-time">{formatTime(line.at)}</span>
                <OutputText text={line.text} cwd={cwd}/>
              </div>)}
            </div>
          </div>}
    </div>
  </div>
}
