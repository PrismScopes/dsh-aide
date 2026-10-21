/**
 * LSP 的 stdio 传输层：帧编解码、子进程启动与生命周期。
 *
 * 这里只做两件事：把字节流切成 JSON 消息、把 JSON 消息写回字节流；协议语义（initialize、
 * 请求超时、诊断转换）在 client.ts。拆开的好处是「半包 / 粘包 / 坏头」能脱离真实服务器单测。
 */
import { spawn, type ChildProcess } from 'node:child_process'

/** 单条消息上限：坏头里一个巨大的 Content-Length 不能让我们按它预分配内存。 */
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024
const CRLF_HEADER_END = Buffer.from('\r\n\r\n', 'ascii')
const LF_HEADER_END = Buffer.from('\n\n', 'ascii')
/** close() 之后等这么久还没退出就强杀：有些服务器收到 EOF 也不自己退。 */
const CLOSE_TIMEOUT_MS = 1_000

export interface LspTransportOptions {
  command: string
  args?: readonly string[]
  cwd: string
  /** 额外/覆盖的环境变量；与 process.env 合并（Windows 下按名字大小写不敏感合并）。 */
  env?: NodeJS.ProcessEnv
  /** 服务器 stderr 的每一行（行尾已去掉），用于日志面板。 */
  onStderr?: (line: string) => void
}

/** 一条 LSP 连接。收发的是已解析的 JSON 值，不是字符串。 */
export interface LspTransport {
  send(message: unknown): void
  /** 返回取消订阅函数。 */
  onMessage(listener: (message: unknown) => void): () => void
  /** 连接断开（进程退出、spawn 失败、解析错误）。返回取消订阅函数。 */
  onClose(listener: (error?: Error) => void): () => void
  /** 结束 stdin；进程在 CLOSE_TIMEOUT_MS 内不退出就 kill。可重复调用。 */
  close(): void
}

/**
 * 编码一条 LSP 帧：`Content-Length: N\r\n\r\n` + UTF-8 JSON。
 *
 * Content-Length 必须是 **UTF-8 字节数**，不是字符串长度 —— 服务器会按字节数切下一帧，
 * 中文/emoji 用 `text.length` 会少算，导致服务器一直等不到完整正文。
 */
export function encodeLspMessage(message: unknown): Buffer {
  const json = JSON.stringify(message)
  if (json === undefined) throw new Error('cannot encode a non-serializable LSP message')
  const body = Buffer.from(json, 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

interface HeaderBounds { headerEnd: number; bodyStart: number }

/** 找头部结束位置。LSP 规定 CRLF，但部分服务器用裸 `\n`，两种都接受。 */
function headerBounds(buffer: Buffer): HeaderBounds | undefined {
  const crlf = buffer.indexOf(CRLF_HEADER_END)
  const lf = buffer.indexOf(LF_HEADER_END)
  if (crlf === -1 && lf === -1) return undefined
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) return { headerEnd: crlf, bodyStart: crlf + CRLF_HEADER_END.length }
  return { headerEnd: lf, bodyStart: lf + LF_HEADER_END.length }
}

/** 解析头部里的 Content-Length；头部非法、缺失或超限都抛错（调用方据此断开连接）。 */
function contentLength(headerText: string): number {
  let length: number | undefined
  for (const rawLine of headerText.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') continue
    const colon = line.indexOf(':')
    if (colon <= 0) throw new Error(`malformed LSP header line: ${line}`)
    const name = line.slice(0, colon).trim().toLowerCase()
    if (name !== 'content-length') continue // Content-Type 之类的头按规范忽略
    const value = line.slice(colon + 1).trim()
    if (!/^\d+$/.test(value)) throw new Error(`invalid LSP Content-Length: ${value}`)
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed > MAX_MESSAGE_BYTES) throw new Error(`LSP Content-Length is too large: ${value}`)
    length = parsed
  }
  if (length === undefined) throw new Error('LSP header is missing Content-Length')
  return length
}

/**
 * 字节流 → 消息的增量解析器。
 *
 * stdout 分块是任意的：一帧可能拆成几块（半包），一块里也可能有多帧（粘包），所以必须
 * 缓存未消费的字节、按 Content-Length 精确切分。按 Buffer 而不是字符串缓存，才能在
 * 正文里出现被 chunk 边界切断的多字节 UTF-8 字符时仍然正确。
 */
export class LspStreamParser {
  private buffer: Buffer = Buffer.alloc(0)

  /** 追加一块数据，返回这次凑齐的完整消息（可能 0 条、1 条或多条）。 */
  push(chunk: Buffer): unknown[] {
    if (chunk.length > 0) this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const messages: unknown[] = []
    for (;;) {
      const bounds = headerBounds(this.buffer)
      if (bounds === undefined) break
      const headerText = this.buffer.subarray(0, bounds.headerEnd).toString('ascii')
      const length = contentLength(headerText)
      if (this.buffer.length - bounds.bodyStart < length) break
      const body = this.buffer.subarray(bounds.bodyStart, bounds.bodyStart + length)
      this.buffer = this.buffer.subarray(bounds.bodyStart + length)
      try { messages.push(JSON.parse(body.toString('utf8')) as unknown) }
      catch { throw new Error('LSP message body is not valid JSON') }
    }
    // 消费过数据后把残留拷贝出来：subarray 会一直引用原来的大 buffer，长连接下等于漏内存。
    if (messages.length > 0 && this.buffer.length > 0) this.buffer = Buffer.from(this.buffer)
    return messages
  }

  /** 还没凑成完整一帧的字节数（排查用）。 */
  get pendingBytes(): number { return this.buffer.length }
}

/** 在当前进程环境里读一个变量（Windows 的 PATH/PATHEXT 大小写不定）。 */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const target = name.toLowerCase()
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() !== target) continue
    const value = env[key]
    return typeof value === 'string' ? value : undefined
  }
  return undefined
}

/** 合并环境变量：option.env 覆盖 process.env；同名的不同大小写键只保留一份。 */
function mergedEnv(extra: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  if (extra === undefined) return process.env
  const merged: NodeJS.ProcessEnv = { ...process.env }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue
    for (const existing of Object.keys(merged)) if (existing.toLowerCase() === key.toLowerCase()) delete merged[existing]
    merged[key] = value
  }
  return merged
}

function spawnChild(options: LspTransportOptions): ChildProcess {
  const env = mergedEnv(options.env)
  const args = [...(options.args ?? [])]
  // Windows 不能直接 spawn 一个 .cmd/.bat（它不是 PE 可执行文件），必须交给 cmd.exe 解释。
  // 参数仍以数组传给 Node，由 Node 负责加引号，不手工拼 shell 字符串 —— 避免空格/引号被二次解释。
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(options.command)) {
    const comspec = readEnv(env, 'COMSPEC') ?? 'cmd.exe'
    return spawn(comspec, ['/d', '/s', '/c', options.command, ...args], {
      cwd: options.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
  }
  return spawn(options.command, args, {
    cwd: options.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
}

class ChildProcessTransport implements LspTransport {
  private readonly child: ChildProcess
  private readonly parser = new LspStreamParser()
  private readonly messageListeners = new Set<(message: unknown) => void>()
  private readonly closeListeners = new Set<(error?: Error) => void>()
  private stderrBuffer = ''
  private closed = false
  private closing = false
  private closeTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: LspTransportOptions) {
    this.child = spawnChild(options)
    this.child.stdout?.on('data', (chunk: Buffer) => this.consumeStdout(chunk))
    this.child.stderr?.on('data', (chunk: Buffer) => this.consumeStderr(chunk))
    // 进程已退出后再写 stdin 会得到 EPIPE；这是「连接断了」，不是未捕获异常。
    this.child.stdin?.on('error', error => this.finish(error))
    this.child.on('error', error => this.finish(error))
    this.child.on('close', (code, signal) => {
      const failed = !this.closing && code !== 0
      const detail = signal === null || signal === undefined ? `code ${code ?? 'null'}` : `code ${code ?? 'null'}, signal ${signal}`
      this.finish(failed ? new Error(`LSP server exited with ${detail}`) : undefined)
    })
  }

  send(message: unknown): void {
    if (this.closed || this.closing) return
    let frame: Buffer
    try { frame = encodeLspMessage(message) } catch (error) { this.finish(error instanceof Error ? error : new Error(String(error))); return }
    try { this.child.stdin?.write(frame, error => { if (error !== undefined && error !== null) this.finish(error) }) }
    catch (error) { this.finish(error instanceof Error ? error : new Error(String(error))) }
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener)
    return () => { this.messageListeners.delete(listener) }
  }

  onClose(listener: (error?: Error) => void): () => void {
    if (this.closed) { listener(); return () => undefined }
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  close(): void {
    if (this.closed || this.closing) return
    this.closing = true
    try { this.child.stdin?.end() } catch { /* stdin 可能已经关闭 */ }
    this.closeTimer = setTimeout(() => {
      this.closeTimer = undefined
      try { this.child.kill('SIGKILL') } catch { /* 进程可能已经退出 */ }
    }, CLOSE_TIMEOUT_MS)
    ;(this.closeTimer as { unref?: () => void }).unref?.()
  }

  private consumeStdout(chunk: Buffer): void {
    let messages: unknown[]
    try { messages = this.parser.push(chunk) }
    catch (error) { this.finish(error instanceof Error ? error : new Error(String(error))); return }
    for (const message of messages) {
      for (const listener of this.messageListeners) {
        // 监听方（client）自己保证不抛；这里再兜一层，单条坏消息不该带崩整条连接。
        try { listener(message) } catch { /* ignore */ }
      }
    }
  }

  private consumeStderr(chunk: Buffer): void {
    this.stderrBuffer += chunk.toString('utf8')
    const lines = this.stderrBuffer.split('\n')
    this.stderrBuffer = lines.pop() ?? ''
    for (const line of lines) this.emitStderr(line)
  }

  private flushStderr(): void {
    const tail = this.stderrBuffer
    this.stderrBuffer = ''
    if (tail !== '') this.emitStderr(tail)
  }

  private emitStderr(line: string): void {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line
    if (text.trim() === '') return
    try { this.options.onStderr?.(text) } catch { /* 日志回调不该影响传输 */ }
  }

  private finish(error?: Error): void {
    if (this.closed) return
    this.closed = true
    if (this.closeTimer !== undefined) { clearTimeout(this.closeTimer); this.closeTimer = undefined }
    this.flushStderr()
    const listeners = [...this.closeListeners]
    this.closeListeners.clear()
    this.messageListeners.clear()
    for (const listener of listeners) {
      try { listener(this.closing ? undefined : error) } catch { /* ignore */ }
    }
  }
}

/** 启动一个 stdio LSP 服务器进程并返回传输层；启动失败通过 onClose 报告。 */
export function spawnLspTransport(options: LspTransportOptions): LspTransport {
  return new ChildProcessTransport(options)
}
