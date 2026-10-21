import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { OutputPanel } from '../src/client/OutputPanel.tsx'
import { appendOutput, clearOutput, OUTPUT_LIMIT, outputLines, resetOutput } from '../src/client/output.ts'

/**
 * 「输出」面板测试。
 *
 * 分三层：
 *   1. store：环形缓冲、按通道清空、快照引用稳定（useSyncExternalStore 不重复渲染的前提）；
 *   2. 面板：空状态文案、日志行的级别/时间、清空按钮的禁用；
 *   3. 接线：底部面板标签（问题/输出/终端）、⋯ 菜单、终端会话标签移入内容区、日志来源。
 */

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')
}

function render(): string {
  return renderToStaticMarkup(<OutputPanel sessionId="s" cwd="/ws" visible colorScheme="dark" header={null}/>)
}

describe('output store', () => {
  beforeEach(() => resetOutput())

  it('keeps the newest lines and drops the oldest beyond the limit', () => {
    for (let index = 0; index < OUTPUT_LIMIT + 5; index++) appendOutput('language', `line ${index}`)
    const lines = outputLines('language')
    expect(lines).toHaveLength(OUTPUT_LIMIT)
    expect(lines[0]?.text).toBe('line 5')
    expect(lines.at(-1)?.text).toBe(`line ${OUTPUT_LIMIT + 4}`)
  })

  it('clears one channel without touching the other', () => {
    appendOutput('language', 'LSP 已就绪')
    appendOutput('git', 'git status')
    clearOutput('language')
    expect(outputLines('language')).toHaveLength(0)
    expect(outputLines('git').map(line => line.text)).toEqual(['git status'])
  })

  it('returns a stable snapshot until the channel changes', () => {
    appendOutput('language', 'a')
    expect(outputLines('language')).toBe(outputLines('language'))
    const before = outputLines('language')
    appendOutput('language', 'b')
    expect(outputLines('language')).not.toBe(before)
  })
})

describe('OutputPanel', () => {
  beforeEach(() => resetOutput())

  it('renders the channel picker and the language empty state', () => {
    const html = render()
    expect(html).toContain('class="dvw-output"')
    expect(html).toContain('aria-label="输出通道"')
    expect(html).toContain('语言服务')
    expect(html).toContain('Git')
    expect(html).toContain('还没有语言服务输出')
    expect(html).toContain('disabled=""')
  })

  it('renders lines with time and severity', () => {
    appendOutput('language', '启动语言服务器 pyright', 'info')
    appendOutput('language', '启动失败：missing binary', 'error')
    const html = render()
    expect(html).toContain('启动语言服务器 pyright')
    expect(html).toContain('启动失败：missing binary')
    expect(html).toContain('data-level="error"')
    expect(html).toContain('class="dvw-output-time"')
    // 有内容后清空按钮可用
    expect(html).not.toContain('disabled=""')
  })
})

describe('output wiring', () => {
  const workbench = read('src/client/Workbench.tsx')
  const clientIndex = read('src/client/index.tsx')
  const terminal = read('src/client/TerminalPanel.tsx')
  const languageClient = read('src/client/language/client.ts')
  const gitOutput = read('src/client/gitOutput.ts')
  const styles = read('src/client/styles.ts')

  it('registers the Output bottom panel', () => {
    expect(clientIndex).toContain("id: 'output'")
    expect(clientIndex).toContain("title: '输出'")
    expect(clientIndex).toContain('OutputPanel')
  })

  it('puts 问题 / 输出 / 终端 view tabs before the ⋯ menu', () => {
    for (const label of ['问题', '输出', '终端']) expect(workbench).toContain(`label: '${label}'`)
    const tabs = workbench.indexOf('BOTTOM_PANEL_TABS.map')
    const more = workbench.indexOf('dvw-bottom-more')
    expect(tabs).toBeGreaterThan(-1)
    expect(more).toBeGreaterThan(-1)
    expect(tabs).toBeLessThan(more)
    expect(workbench).toContain('aria-label="底部面板"')
    expect(workbench).toContain('selectBottomPanel')
  })

  it('moves the terminal session tab strip into the terminal view', () => {
    expect(terminal).not.toContain('createPortal')
    expect(terminal).toContain('dvw-terminal-tabbar')
    expect(workbench).not.toContain('dvw-bottom-headslot')
    expect(styles).toContain('.dvw-terminal-tabbar')
  })

  it('feeds the language and Git channels from their existing sources', () => {
    expect(languageClient).toContain("appendOutput('language'")
    expect(gitOutput).toContain("appendOutput('git'")
    expect(styles).toContain('.dvw-output-log')
  })
})
