import { useEffect, useRef, useState } from 'react'
import type { BottomPanelProps } from './service.ts'
import { clearOutput, useOutputLines, type OutputChannel } from './output.ts'

/**
 * 「输出」底部面板（对应 VS Code 的 Output 视图）。
 *
 * 当前有两个真实通道：
 * - 语言服务：宿主的 LSP 日志（server stderr、协议告警、启动失败）以及客户端自己记录的连接/扫描事件；
 * - Git：工作台发起的每条 git 动作（与编辑器里的「Git 输出」标签页同一份来源）。
 *
 * 只读：这里不提供命令行或输入框 —— 输出面板是日志视图，不是终端。
 */
const CHANNELS: readonly { id: OutputChannel; label: string; empty: string }[] = [
  { id: 'language', label: '语言服务', empty: '还没有语言服务输出。打开文件、启动语言服务器或扫描工作区后，日志会显示在这里。' },
  { id: 'git', label: 'Git', empty: '还没有 Git 输出。在源代码管理里执行操作后，命令记录会显示在这里。' },
]

/** 行首时间：只显示时分秒，日期对「刚发生的输出」没有意义。 */
function formatTime(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function OutputPanel(_props: BottomPanelProps) {
  const [channel, setChannel] = useState<OutputChannel>('language')
  const lines = useOutputLines(channel)
  const log = useRef<HTMLDivElement>(null)
  /** 是否吸在底部。用户往上翻看历史时，新日志不能把视图拽回去（VS Code 也是这个行为）。 */
  const sticking = useRef(true)

  useEffect(() => {
    const element = log.current
    if (element === null || !sticking.current) return
    element.scrollTop = element.scrollHeight
  }, [lines])

  const current = CHANNELS.find(entry => entry.id === channel)

  return <div className="dvw-output">
    <div className="dvw-output-toolbar">
      <select
        className="dvw-output-channel"
        value={channel}
        aria-label="输出通道"
        onChange={event => setChannel(event.target.value as OutputChannel)}
      >
        {CHANNELS.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      </select>
      <button type="button" className="dvw-output-clear" disabled={lines.length === 0} onClick={() => clearOutput(channel)}>清空</button>
    </div>
    <div
      className="dvw-output-log"
      role="log"
      aria-label={`${current?.label ?? '输出'}输出`}
      ref={log}
      onScroll={event => {
        const element = event.currentTarget
        sticking.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
      }}
    >
      {lines.length === 0
        ? <div className="dvw-output-empty">{current?.empty ?? ''}</div>
        : lines.map((line, index) => <div className="dvw-output-line" data-level={line.level} key={`${line.at}:${index}`}>
          <span className="dvw-output-time">{formatTime(line.at)}</span>
          <span className="dvw-output-text">{line.text}</span>
        </div>)}
    </div>
  </div>
}
