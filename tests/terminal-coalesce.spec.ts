import { mkdtempSync, rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { IPty } from 'node-pty'
import { OUTPUT_FLUSH_CHARS, OUTPUT_FLUSH_MS, OutputCoalescer, TerminalManager, type CoalescerClock, type OutputFrame, type TerminalOutput } from '../src/terminal.ts'

/**
 * 终端输出合批（OutputCoalescer）的单测。
 *
 * 依据运行时审计第 7 项：原先 pty 每一小块数据都对每个连接 `JSON.stringify` 一次再 `send` 一帧，
 * 大输出（5MB/s）时每秒上千次序列化 + 上千个 ws 帧。合批把同一窗口内的块拼成一帧，协议形状不变
 * （{type:'output',sequence,data}），客户端无需改动。
 *
 * 用假时钟（注入 CoalescerClock），测试不依赖真实定时器，也不会真的等 8ms。
 */

/** 假时钟：手动推进，只有 advance 到点才触发。 */
class FakeClock implements CoalescerClock {
  private time = 0
  private tasks: Array<{ at: number; run: () => void; token: object }> = []

  schedule = (run: () => void, ms: number): unknown => {
    const token = {}
    this.tasks.push({ at: this.time + ms, run, token })
    return token
  }

  cancel = (handle: unknown): void => { this.tasks = this.tasks.filter(task => task.token !== handle) }

  advance(ms: number): void {
    this.time += ms
    const due = this.tasks.filter(task => task.at <= this.time)
    this.tasks = this.tasks.filter(task => task.at > this.time)
    for (const task of due) task.run()
  }

  get pending(): number { return this.tasks.length }
}

function setup(options: { flushAfterMs?: number; flushAtChars?: number } = {}) {
  const frames: OutputFrame[] = []
  const clock = new FakeClock()
  const coalescer = new OutputCoalescer(frame => { frames.push(frame) }, { clock, ...options })
  return { frames, clock, coalescer }
}

describe('OutputCoalescer：合批语义', () => {
  it('同一窗口内的多块只发一帧，内容按序拼接、sequence 取最后一块', () => {
    const { frames, clock, coalescer } = setup()
    coalescer.push(1, 'line 1\r\n')
    coalescer.push(2, 'line 2\r\n')
    coalescer.push(3, 'line 3\r\n')
    // 窗口未到点：一帧都还没发（这里正是「延迟最多 8ms」的来源）。
    expect(frames).toEqual([])
    expect(coalescer.state).toEqual({ chars: 24, scheduled: true })
    clock.advance(OUTPUT_FLUSH_MS)
    expect(frames).toEqual([{ type: 'output', sequence: 3, data: 'line 1\r\nline 2\r\nline 3\r\n' }])
    // 到点 flush 后定时器不残留，缓冲清空。
    expect(clock.pending).toBe(0)
    expect(coalescer.state).toEqual({ chars: 0, scheduled: false })
  })

  it('定时器未到点不会提前发送（交互小输出最多多等一个窗口）', () => {
    const { frames, clock, coalescer } = setup()
    coalescer.push(1, 'x')
    clock.advance(OUTPUT_FLUSH_MS - 1)
    expect(frames).toEqual([])
    clock.advance(1)
    expect(frames).toHaveLength(1)
  })

  it('缓冲超过字符上限时立刻发，不等定时器（大输出不会把缓冲撑大）', () => {
    const { frames, clock, coalescer } = setup({ flushAtChars: 10 })
    coalescer.push(1, 'aaaa')
    expect(coalescer.state.scheduled).toBe(true)
    coalescer.push(2, 'bbbbbb')
    // 10 >= 上限：立刻发出，且定时器被清掉。
    expect(frames).toEqual([{ type: 'output', sequence: 2, data: 'aaaabbbbbb' }])
    expect(clock.pending).toBe(0)
  })

  it('immediate 块（进程退出消息）把之前的缓冲一起立刻发出，顺序不变', () => {
    const { frames, clock, coalescer } = setup()
    coalescer.push(1, 'building...\r\n')
    coalescer.push(2, '\r\n[process exited with code 0]\r\n', true)
    expect(frames).toEqual([{ type: 'output', sequence: 2, data: 'building...\r\n\r\n[process exited with code 0]\r\n' }])
    // 退出时那个 pending 的定时器也必须清掉，别让宿主多挂一个 8ms 定时器。
    expect(clock.pending).toBe(0)
    // 退出消息在最后一帧里排在此前所有输出之后。
    expect(frames[0]!.data.endsWith('[process exited with code 0]\r\n')).toBe(true)
  })

  it('ANSI 内容逐字节不变（只做字符串拼接，不解析不重编码）', () => {
    const { frames, clock, coalescer } = setup()
    const chunks = ['\x1b[32m✓\x1b[0m one\r\n', '\x1b[36mtransforming\x1b[0m two\r\n', '\x1b[2K\rprogress 50%']
    chunks.forEach((chunk, index) => coalescer.push(index + 1, chunk))
    clock.advance(OUTPUT_FLUSH_MS)
    expect(frames).toHaveLength(1)
    expect(frames[0]!.data).toBe(chunks.join(''))
  })

  it('dispose（连接关闭）把剩余内容发出去、清定时器，之后的 push 忽略', () => {
    const { frames, clock, coalescer } = setup()
    coalescer.push(7, 'tail without newline')
    coalescer.dispose()
    expect(frames).toEqual([{ type: 'output', sequence: 7, data: 'tail without newline' }])
    expect(clock.pending).toBe(0)
    coalescer.push(8, 'after dispose')
    expect(frames).toHaveLength(1)
    expect(coalescer.state).toEqual({ chars: 0, scheduled: false })
  })

  it('dispose 时缓冲为空不产生空帧；重复 dispose 是幂等空操作', () => {
    const { frames, clock, coalescer } = setup()
    coalescer.push(1, 'a')
    clock.advance(OUTPUT_FLUSH_MS)
    expect(frames).toHaveLength(1)
    coalescer.dispose()
    coalescer.dispose()
    expect(frames).toHaveLength(1)
  })

  it('空数据块不安排定时器（避免空转）', () => {
    const { frames, clock, coalescer } = setup()
    coalescer.push(1, '')
    expect(coalescer.state).toEqual({ chars: 0, scheduled: false })
    expect(clock.pending).toBe(0)
    clock.advance(OUTPUT_FLUSH_MS)
    expect(frames).toEqual([])
  })

  it('flush 之后再次 push 会重新起一个定时器（不会因为上一次 flush 而丢掉后续输出）', () => {
    const { frames, clock, coalescer } = setup()
    coalescer.push(1, 'first')
    clock.advance(OUTPUT_FLUSH_MS)
    coalescer.push(2, 'second')
    expect(frames).toHaveLength(1)
    clock.advance(OUTPUT_FLUSH_MS)
    expect(frames).toHaveLength(2)
    expect(frames[1]).toEqual({ type: 'output', sequence: 2, data: 'second' })
  })

  it('默认常量：8ms 窗口 / 32KiB 上限（64KiB 会踩到 stringify 的成本悬崖，见常量注释）', () => {
    expect(OUTPUT_FLUSH_MS).toBe(8)
    expect(OUTPUT_FLUSH_CHARS).toBe(32 * 1024)
  })
})

/** 可显式触发退出的假 pty：只记录订阅者，不碰真 shell。 */
function fakePty() {
  const dataHandlers: Array<(data: string) => void> = []
  let exitHandler: ((event: { exitCode: number }) => void) | undefined
  const child = {
    pid: 1,
    kill: () => {},
    onData: (handler: (data: string) => void) => { dataHandlers.push(handler) },
    onExit: (handler: (event: { exitCode: number }) => void) => { exitHandler = handler },
    write: () => {},
    resize: () => {},
  } as unknown as IPty
  return {
    child,
    emit: (data: string) => { for (const handler of dataHandlers) handler(data) },
    exit: (exitCode = 0) => { exitHandler?.({ exitCode }) },
  }
}

describe('终端退出消息与合批的先后顺序（走真实 TerminalManager）', () => {
  it('退出前的输出与 [process exited] 合成一帧，顺序不变、sequence 是最后一块', () => {
    const root = mkdtempSync(join(tmpdir(), 'dvw-coalesce-'))
    try {
      const pty = fakePty()
      const manager = new TerminalManager(() => pty.child)
      const info = manager.create(root)
      const handle = manager.get(root, info.id)
      expect(handle).toBeDefined()
      const clock = new FakeClock()
      const frames: OutputFrame[] = []
      const coalescer = new OutputCoalescer(frame => { frames.push(frame) }, { clock })
      // 与 installTerminal 里完全同一行接线。
      const listener = (output: TerminalOutput) => coalescer.push(output.sequence, output.data, output.immediate === true)
      handle!.listeners.add(listener)

      pty.emit('line one\r\n')
      pty.emit('line two\r\n')
      // 还在合批窗口里：一帧都没发。
      expect(frames).toEqual([])
      pty.exit(3)
      // 退出消息带 immediate：立刻 flush，且排在此前所有输出之后。
      expect(frames).toHaveLength(1)
      expect(frames[0]!.data).toBe('line one\r\nline two\r\n\r\n[process exited with code 3]\r\n')
      expect(frames[0]!.sequence).toBe(3)
      expect(clock.pending).toBe(0)
      manager.dispose()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('终端输出合批接线', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/terminal.ts', import.meta.url)), 'utf8')

  it('WS 输出路径走增量合批器，而不是每块直接 stringify + send', () => {
    expect(source).toContain('new OutputCoalescer(frame =>')
    expect(source).toContain('coalescer.push(output.sequence, output.data, output.immediate === true)')
    // 旧的逐块序列化写法必须消失（否则合批等于没接）。
    expect(source).not.toContain("connection.send(JSON.stringify({ type: 'output', ...output }))")
  })

  it('进程退出消息带 immediate 标记（否则会被合批窗口拖住）', () => {
    expect(source).toContain('immediate: true')
    expect(source).toMatch(/\[process exited with code \$\{exitCode\}\]/)
  })

  it('连接关闭时 dispose（发完剩余 + 清定时器）', () => {
    expect(source).toContain('connection.on(\'close\', () => { coalescer.dispose(); handle.listeners.delete(listener) })')
  })

  it('replay 路径保持原样：直接 send、不合批', () => {
    expect(source).toContain("connection.send(JSON.stringify({ type: 'replay', sequence, data: chunk }))")
  })
})

/**
 * 微基准：只在 `DWV_TERMINAL_BENCH=1` 时运行（默认测试套件保持安静、不看时间）。
 *
 * 用 5MB 的彩色构建输出（逐字节与审计口径一致），对比「逐块 stringify + 发送」与「合批」：
 * 帧数、宿主序列化耗时、客户端 parse 次数/耗时、线上字节数。块大小取 Windows conpty 常见的
 * 1KB/4KB/16KB 三档。合批用真实 OutputCoalescer + 假时钟驱动，和线上路径同一份逻辑。
 */
describe.skipIf(process.env.DWV_TERMINAL_BENCH !== '1')('终端输出合批微基准（DWV_TERMINAL_BENCH=1）', () => {
  it('5MB ANSI 输出：逐块 vs 合批', () => {
    const TOTAL_BYTES = 5 * 1024 * 1024
    // 彩色构建输出：每行都带 SGR，JSON 转义会膨胀（ESC → \u001b）。
    const unit = '\x1b[32m✓\x1b[0m transforming src/modules/example.ts \x1b[90m(1.2ms)\x1b[0m\r\n'
    const flatNoise = unit.repeat(Math.ceil(TOTAL_BYTES / unit.length))
    const now = () => performance.now()
    const med = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number

    for (const chunkSize of [1024, 4096, 16 * 1024]) {
      const count = Math.floor(TOTAL_BYTES / chunkSize)
      const chunks: string[] = []
      for (let index = 0; index < count; index++) chunks.push(flatNoise.slice(index * chunkSize, (index + 1) * chunkSize))

      // before：每块一次 JSON.stringify + 一帧（客户端对应一次 parse + 一次 listener/xterm.write 调用）。
      const beforeSerializeRuns: number[] = []
      const beforeParseRuns: number[] = []
      let beforeFrames: string[] = []
      for (let round = 0; round < 5; round++) {
        const frames: string[] = []
        const started = now()
        for (let index = 0; index < count; index++) frames.push(JSON.stringify({ type: 'output', sequence: index + 1, data: chunks[index] as string }))
        beforeSerializeRuns.push(now() - started)
        const parseStarted = now()
        for (const frame of frames) JSON.parse(frame)
        beforeParseRuns.push(now() - parseStarted)
        beforeFrames = frames
      }

      // after：按 8ms 窗口合批，且受 OUTPUT_FLUSH_CHARS 上限约束（与线上阈值同一套）。
      const chunksPerWindow = Math.max(1, Math.min(
        Math.round((TOTAL_BYTES / chunkSize) * (OUTPUT_FLUSH_MS / 1000)),
        Math.floor(OUTPUT_FLUSH_CHARS / chunkSize),
      ))
      const afterSerializeRuns: number[] = []
      const afterParseRuns: number[] = []
      let afterFrames: string[] = []
      for (let round = 0; round < 5; round++) {
        const clock = new FakeClock()
        const frames: string[] = []
        const coalescer = new OutputCoalescer(frame => { frames.push(JSON.stringify(frame)) }, { clock })
        const started = now()
        for (let windowStart = 0; windowStart < count; windowStart += chunksPerWindow) {
          const end = Math.min(windowStart + chunksPerWindow, count)
          for (let index = windowStart; index < end; index++) coalescer.push(index + 1, chunks[index] as string)
          clock.advance(OUTPUT_FLUSH_MS)
        }
        coalescer.flush()
        afterSerializeRuns.push(now() - started)
        const parseStarted = now()
        for (const frame of frames) JSON.parse(frame)
        afterParseRuns.push(now() - parseStarted)
        afterFrames = frames
      }

      const beforeSerialize = med(beforeSerializeRuns)
      const afterSerialize = med(afterSerializeRuns)
      const beforeParse = med(beforeParseRuns)
      const afterParse = med(afterParseRuns)
      const beforeBytes = beforeFrames.reduce((sum, frame) => sum + frame.length, 0)
      const afterBytes = afterFrames.reduce((sum, frame) => sum + frame.length, 0)
      const pct = (before: number, after: number) => `${(100 - (after / before) * 100).toFixed(0)}%`
      console.log([
        `[terminal-bench] chunk=${chunkSize}B chunks=${count} chunks/window=${chunksPerWindow}`,
        `  host serialize+frame: ${beforeSerialize.toFixed(1)}ms / ${beforeFrames.length} -> ${afterSerialize.toFixed(1)}ms / ${afterFrames.length} (${pct(beforeSerialize, afterSerialize)} less time, -${pct(beforeFrames.length, afterFrames.length)} frames)`,
        `  client parse:         ${beforeParse.toFixed(1)}ms / ${beforeFrames.length} -> ${afterParse.toFixed(1)}ms / ${afterFrames.length} (${pct(beforeParse, afterParse)} less time, -${pct(beforeFrames.length, afterFrames.length)} calls)`,
        `  wire bytes:           ${beforeBytes} -> ${afterBytes} (${pct(beforeBytes, afterBytes)})`,
      ].join('\n'))

      // 确定性断言：帧数真的降下来；内容逐字节不变（合批后按顺序拼回去必须等于原输出）。
      expect(afterFrames.length).toBeLessThan(beforeFrames.length)
      const reassembled = afterFrames.map(frame => (JSON.parse(frame) as { data: string }).data).join('')
      expect(reassembled.length).toBeGreaterThan(TOTAL_BYTES - chunkSize)
      expect(reassembled).toBe(chunks.join(''))
    }
  })
})
