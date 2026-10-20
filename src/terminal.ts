import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { WebSocket, WebSocketServer } from 'ws'
import type { HostContext } from './context.ts'
import { cwdFor } from './host.ts'
import { resolveExistingWorkspacePathSync, type WorkspacePathErrors } from './paths.ts'
import { authorize, readBody, send, sendError, WorkbenchError } from './wire.ts'

export interface TerminalInfo { id: string; title: string; cwd: string; running: boolean; exitCode?: number; sequence: number }
export interface TerminalOutput {
  sequence: number
  data: string
  /**
   * 这一块之后必须立刻可见（进程退出消息）。
   *
   * 输出走 OutputCoalescer 合批，正常情况下最多延迟一个 8ms 窗口；但「[process exited with code N]」
   * 必须排在此前所有输出之后且不能被窗口拖住，所以它带这个标记，合批器会把包含它的整段缓冲立刻发出。
   * 它是宿主内部字段，不会出现在 WebSocket 帧里（帧只有 {type,sequence,data}）。
   */
  immediate?: boolean
}

interface TerminalHandle { info: TerminalInfo; process: IPty; replay: ReplayBuffer; listeners: Set<(output: TerminalOutput) => void> }
const SENSITIVE = /(api[_-]?key|token|credential|secret|password|passwd|private[_-]?key|^dsh_.*(?:key|token|secret))/i
const MAX_TERMINALS = 8
/** 回放缓冲里最多留这么多字节。 */
const REPLAY_STORE_BYTES = 512 * 1024
/** 单次重连最多送回去多少字节。 */
export const REPLAY_SEND_BYTES = 256 * 1024
/** 与客户端 xterm 的 scrollback 对齐：它不会显示更多行，多送出去的字节只会被解析后丢掉。 */
export const REPLAY_LINES = 1000
/** 一次送出的字符数。整段一次性送出会让客户端在一次解析里卡住。 */
export const REPLAY_CHUNK_CHARS = 64 * 1024

/**
 * 回放缓冲。
 *
 * 原先是单个字符串：每拿到一块数据就对整段做一次 `Buffer.byteLength`，超限时再整段
 * `slice`。输出越久，单块越贵，整体是 O(n²)。改成按块保存、增量记账后，单块成本是 O(块长)。
 *
 * 保留量按「能显示的部分」定：xterm 的 scrollback 默认 1000 行，超出的字节不会被显示，
 * 却要在每次重连时序列化、传输、解析。实测保留 2 MiB 时，切一次标签要送 2,331,945 字节，
 * 主线程被卡 372ms、约 715ms 才恢复。
 */
export class ReplayBuffer {
  private readonly chunks: string[] = []
  private bytes = 0

  push(data: string): void {
    this.chunks.push(data)
    this.bytes += Buffer.byteLength(data)
    while (this.bytes > REPLAY_STORE_BYTES && this.chunks.length > 1) this.bytes -= Buffer.byteLength(this.chunks.shift() as string)
    if (this.bytes > REPLAY_STORE_BYTES) {
      const tail = (this.chunks[0] ?? '').slice(-REPLAY_STORE_BYTES)
      this.chunks[0] = tail
      this.bytes = Buffer.byteLength(tail)
    }
  }

  /** 重连时该看到的那一段：末尾若干行，并从行边界起算，避免半行或半截转义序列。 */
  tail(): string {
    const raw = this.chunks.join('')
    if (raw === '') return ''
    const lines = raw.split('\n')
    const keep = lines.length > REPLAY_LINES ? lines.slice(-REPLAY_LINES).join('\n') : raw
    if (Buffer.byteLength(keep) <= REPLAY_SEND_BYTES) return keep
    const cut = keep.slice(-REPLAY_SEND_BYTES)
    const boundary = cut.indexOf('\n')
    return boundary === -1 ? cut : cut.slice(boundary + 1)
  }
}

/** 按字符切块；不切开代理对。 */
export function replayChunks(text: string): string[] {
  if (text.length <= REPLAY_CHUNK_CHARS) return [text]
  const chunks: string[] = []
  let index = 0
  while (index < text.length) {
    let end = Math.min(index + REPLAY_CHUNK_CHARS, text.length)
    // 边界落在代理对中间时，把边界往前挪一个码元，让整个字符落进下一块 ——
    // 直接丢掉这个高代理会让这个字符彻底损坏（低代理会孤零零地留在下一块开头）。
    if (end < text.length) {
      const last = text.charCodeAt(end - 1)
      if (last >= 0xd800 && last <= 0xdbff) end -= 1
    }
    chunks.push(text.slice(index, end))
    index = end
  }
  return chunks
}

/** 合批窗口（毫秒）。小输出最多多等这么久；8ms 约等于半帧，交互上不可见。 */
export const OUTPUT_FLUSH_MS = 8
/**
 * 缓冲上限（字符数）。达到就立刻 flush，避免大输出时缓冲无限增长。
 *
 * 取 32KiB 而不是 64KiB 是实测结论：V8 的 `JSON.stringify` 在 ANSI 文本上约 2µs/KB，但到 64KiB
 * 会跳崖（实测 5.29µs/KB，翻 2.6 倍），128KiB 仍要 4µs/KB。32KiB 正好在平坦段内 —— 合批到 32KiB
 * 时宿主序列化成本与逐块发送持平，而帧数还能降 50–88%（块越小降得越多）。
 */
export const OUTPUT_FLUSH_CHARS = 32 * 1024

/** 发出去的一帧（形状与客户端约定的 `{type:'output',sequence,data}` 完全一致）。 */
export interface OutputFrame { type: 'output'; sequence: number; data: string }

/** 定时器接缝：真实实现是 setTimeout/clearTimeout，单测注入假时钟。 */
export interface CoalescerClock {
  schedule(run: () => void, ms: number): unknown
  cancel(handle: unknown): void
}

const defaultClock: CoalescerClock = {
  schedule(run, ms) {
    const timer = setTimeout(run, ms)
    // 宿主长时间运行：一个 8ms 的定时器没有理由把进程钉住（Node 的 timer 才有 unref）。
    const handle = timer as { unref?: () => void }
    if (typeof handle.unref === 'function') handle.unref()
    return timer
  },
  cancel(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

/**
 * 终端输出的**按连接合批器**。
 *
 * 为什么需要：pty 的数据块很小（Windows conpty 常见 4–16KB），原先每块都 `JSON.stringify` 一次再
 * `send` 一帧。ANSI 转义让 JSON 膨胀 44–46%（ESC → `\u001b`），实测 stringify 4KB=8.2µs、64KB=195µs，
 * 客户端 parse 4KB=5.8µs、64KB=73.6µs。大输出（`pnpm build` 级 5MB/s）就是每秒上千次序列化、
 * 上千个 ws 帧、上千次客户端 parse 与 xterm.write 调用 ── 其中**每帧的固定开销**才是合批能拿掉的部分。
 *
 * 语义保证（这几条是正确性的底线，都有单测）：
 * - **顺序不变**：只做字符串拼接，不同块之间的相对顺序与原样发送时一致；
 * - **逐字节不变**：不解析、不重编码 ANSI 内容；
 * - **不丢尾部**：`push(..., true)` 表示「这一块之后必须立刻可见」（进程退出消息），会把包含它在内的
 *   整个缓冲立刻发出去；连接关闭时 `dispose()` 尽力把剩余内容发出；
 * - **定时器不残留**：flush/dispose 都会 cancel，宿主侧默认定时器还 `unref()`。
 *
 * sequence 取「本次合批里最后一块的 sequence」：客户端只用它转给 xterm（不校验连续性），
 * 合批后这个值就是「这一帧的末尾状态」，与逐块发送时最后一块一致。
 */
export class OutputCoalescer {
  private buffer = ''
  private lastSequence = 0
  private timer: unknown
  private disposed = false
  private readonly flushAfterMs: number
  private readonly flushAtChars: number
  private readonly clock: CoalescerClock

  constructor(private readonly send: (frame: OutputFrame) => void, options: { flushAfterMs?: number; flushAtChars?: number; clock?: CoalescerClock } = {}) {
    this.flushAfterMs = options.flushAfterMs ?? OUTPUT_FLUSH_MS
    this.flushAtChars = options.flushAtChars ?? OUTPUT_FLUSH_CHARS
    this.clock = options.clock ?? defaultClock
  }

  /** 追加一块输出。immediate 表示「到这块为止必须立刻发出」（进程退出消息）。 */
  push(sequence: number, data: string, immediate = false): void {
    if (this.disposed) return
    if (data !== '') this.buffer += data
    this.lastSequence = sequence
    if (immediate || this.buffer.length >= this.flushAtChars) { this.flush(); return }
    if (this.buffer !== '' && this.timer === undefined) {
      this.timer = this.clock.schedule(() => { this.timer = undefined; this.flush() }, this.flushAfterMs)
    }
  }

  /** 把缓冲里的内容作为一帧发出；空缓冲是空操作。 */
  flush(): void {
    this.cancelTimer()
    if (this.buffer === '') return
    const data = this.buffer
    this.buffer = ''
    this.send({ type: 'output', sequence: this.lastSequence, data })
  }

  /** 连接关闭：把剩余内容交出去一次，然后彻底停掉（定时器不残留、之后的 push 忽略）。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelTimer()
    if (this.buffer === '') return
    const data = this.buffer
    this.buffer = ''
    this.send({ type: 'output', sequence: this.lastSequence, data })
  }

  /** 仅供测试与排查：尚未发出的字符数与是否有 pending 定时器。 */
  get state(): { chars: number; scheduled: boolean } { return { chars: this.buffer.length, scheduled: this.timer !== undefined } }

  private cancelTimer(): void {
    if (this.timer === undefined) return
    this.clock.cancel(this.timer)
    this.timer = undefined
  }
}

/** Remove credentials while retaining ordinary interactive-shell variables. */
export function sanitizedTerminalEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && !SENSITIVE.test(key)) as Array<[string, string]>)
}

/**
 * 平台默认的交互式 shell —— 也是「默认终端」在本机没有 PowerShell 7 时的落点。
 *
 * Windows 上用 COMSPEC —— 也就是用户自己的命令解释器 —— 原样启动，不替换成别的、也不加
 * 抑制启动横幅的参数。原先的写法是「COMSPEC 指向 powershell 就用它，否则一律 powershell.exe
 * 加 -NoLogo」：当用户的 COMSPEC 是 cmd.exe 时，它会被悄悄换成 PowerShell，于是终端里看到的
 * 是 PS 提示符，用户熟悉的 cmd 横幅（Microsoft Windows [版本 …]）永远不会出现。终端应当呈现
 * 用户自己的环境。
 */
export function defaultTerminalShell(platform = process.platform, env = process.env): { shell: string; args: string[] } {
  if (platform === 'win32') {
    const comspec = env.COMSPEC?.trim()
    return { shell: comspec !== undefined && comspec !== '' ? comspec : 'powershell.exe', args: [] }
  }
  return { shell: env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash'), args: ['-l'] }
}

/** 一个可选 shell 的对外描述。不含本机路径 —— 客户端不需要，也不该拿到。 */
export interface TerminalProfile { id: string; label: string }

/** 探测文件与 PATH 的能力。抽成接口是为了让测试能给定确定的文件系统。 */
export interface ProfileProbe {
  exists(path: string): boolean
  which(file: string): string | undefined
}

/** probe 的真实实现：读 PATH、查文件系统。 */
function systemProbe(env: NodeJS.ProcessEnv = process.env): ProfileProbe {
  const path = env.PATH ?? ''
  return {
    exists: candidate => existsSync(candidate),
    which: file => {
      for (const directory of path.split(delimiter)) {
        if (directory === '') continue
        const candidate = join(directory, file)
        if (existsSync(candidate)) return candidate
      }
      return undefined
    },
  }
}

interface ResolvedProfile extends TerminalProfile { shell: string; args: string[] }

/**
 * 探测本机可用的交互式 shell。
 *
 * 只认这几个已知名字，**不接受客户端传来的任意路径**：客户端给的是 profile id，
 * 由宿主在自己的探测结果里查，查不到就报错。否则这个接口就成了「按调用者的意思启动任意程序」。
 *
 * Git Bash 的定位方式：从 `git.exe` 回推安装目录（PATH 上的 git 通常位于 `<root>\cmd\git.exe`，
 * 与 `<root>\bin\bash.exe` 同级），比硬编码 `C:\Program Files\Git` 稳 —— 便携安装不在那里。
 */
function resolvedTerminalProfiles(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, probe: ProfileProbe): ResolvedProfile[] {
  if (platform !== 'win32') {
    const shell = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    return [{ id: 'default', label: basename(shell), shell, args: ['-l'] }]
  }
  const profiles: ResolvedProfile[] = []
  const pwsh = probe.which('pwsh.exe')
  if (pwsh !== undefined) profiles.push({ id: 'pwsh', label: 'PowerShell', shell: pwsh, args: [] })
  const powershell = probe.which('powershell.exe')
  if (powershell !== undefined) profiles.push({ id: 'windows-powershell', label: 'Windows PowerShell', shell: powershell, args: [] })
  const git = probe.which('git.exe')
  if (git !== undefined) {
    const root = dirname(dirname(git))
    const bash = [join(root, 'bin', 'bash.exe'), join(root, 'usr', 'bin', 'bash.exe')].find(candidate => probe.exists(candidate))
    if (bash !== undefined) profiles.push({ id: 'git-bash', label: 'Git Bash', shell: bash, args: ['--login', '-i'] })
  }
  const comspec = env.COMSPEC?.trim()
  if (comspec !== undefined && comspec !== '') profiles.push({ id: 'cmd', label: 'Command Prompt', shell: comspec, args: [] })
  const systemRoot = env.SystemRoot?.trim() || env.windir?.trim()
  if (systemRoot !== undefined && systemRoot !== '') {
    const wsl = join(systemRoot, 'System32', 'bash.exe')
    if (probe.exists(wsl)) profiles.push({ id: 'wsl', label: 'WSL', shell: wsl, args: [] })
  }
  return profiles
}

/** 供客户端渲染「新建终端」菜单的列表。 */
export function terminalProfiles(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, probe: ProfileProbe = systemProbe(env)): TerminalProfile[] {
  return resolvedTerminalProfiles(platform, env, probe).map(({ id, label }) => ({ id, label }))
}

/**
 * 按 profile id 解析出要启动的 shell。
 *
 * id 缺失时是「默认终端」：本机装了 PowerShell 7 就用 pwsh，否则仍是用户自己的命令解释器
 * （Windows 上 COMSPEC 原样启动，类 Unix 上是 SHELL）。菜单里的「新建终端」与命令入口走的都是
 * 这条缺省路径。
 */
export function terminalShell(profileId?: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, probe: ProfileProbe = systemProbe(env)): { shell: string; args: string[] } {
  const profiles = resolvedTerminalProfiles(platform, env, probe)
  if (profileId === undefined || profileId === '') {
    const preferred = profiles.find(candidate => candidate.id === 'pwsh')
    return preferred === undefined ? defaultTerminalShell(platform, env) : { shell: preferred.shell, args: preferred.args }
  }
  const profile = profiles.find(candidate => candidate.id === profileId)
  if (profile === undefined) throw new Error(`unknown terminal profile: ${profileId}`)
  return { shell: profile.shell, args: profile.args }
}

/** 默认标题：可执行名去掉扩展名 —— cmd.exe → cmd、pwsh.exe → pwsh、/bin/bash → bash。 */
export function terminalTitleBase(shell: string): string {
  const name = shell.split(/[\\/]/).filter(part => part !== '').pop() ?? shell
  return name.replace(/\.(exe|com|cmd|bat)$/i, '') || name
}

/**
 * 同名终端补序号：cmd、cmd (1)、cmd (2)。
 *
 * 原先默认标题取的是可执行文件名，于是同一个 shell 开几个都叫 `cmd.exe` —— 标签栏和右侧
 * 列表完全分不出谁是谁。这里按「当前有没有被占用」挑最小序号；手动改过的名字只是占用一个位置，
 * 不影响后来新建的基础名。
 */
export function uniqueTerminalTitle(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let index = 1; index < 10000; index++) {
    const candidate = `${base} (${index})`
    if (!used.has(candidate)) return candidate
  }
  return `${base} (${used.size})`
}

/** 终端面向用户的错误码/中文消息；与重构前逐字一致（tests/terminal-directory.spec.ts 依赖）。 */
const TERMINAL_PATH_ERRORS: WorkspacePathErrors = {
  outside: raw => new WorkbenchError('directory-outside', `终端目录超出了工作区：${raw}`, 400),
  symlinkOutside: raw => new WorkbenchError('directory-outside', `终端目录通过符号链接指向了工作区之外：${raw}`, 400),
  missing: raw => new WorkbenchError('directory-not-found', `终端目录不存在：${raw}`, 400),
  notDirectory: raw => new WorkbenchError('directory-invalid', `终端目录不是文件夹：${raw}`, 400),
}

/**
 * 解析「在终端中打开」给出的目录。
 *
 * 客户端传的是工作区**相对**路径（`''`/缺省表示工作区根）。终端会在这个目录里启动一个真正的
 * shell，所以边界必须和文件 API 一样严：不接收绝对路径、解析后必须落在工作区内、不能借符号链接
 * 跳出去、且必须是一个已存在的目录。任何一条不满足都抛 400 —— 这是调用方给了不能用的目录，
 * 不是宿主内部错误；消息直接显示在终端面板里，所以要能看懂。
 *
 * 为什么在宿主侧再解析一次而不是信任客户端：相对路径可能带 `..`，而且符号链接只有宿主看得见；
 * 只靠客户端校验等于把「能起 shell 的目录」交给页面决定。
 */
export function resolveTerminalDirectory(cwd: string, directory?: string): string {
  const root = realpathSync(cwd)
  if (directory === undefined || directory === '') return root
  if (isAbsolute(directory)) throw new WorkbenchError('directory-invalid', '终端目录必须是工作区内的相对路径', 400)
  return resolveExistingWorkspacePathSync(root, directory, TERMINAL_PATH_ERRORS, { kind: 'directory' }).actual
}

/** Own interactive terminals by their canonical workspace directory. */

/** 交给 pty 的启动参数（抽成类型是为了让测试能注入假的 spawn）。 */
interface PtySpawnOptions { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
type SpawnPty = (shell: string, args: string[], options: PtySpawnOptions) => IPty

const defaultSpawn: SpawnPty = (shell, args, options) => pty.spawn(shell, args, options)

/** 预热 shell 最多留多久：没人来认领就杀掉，别让后台多出一个长期 shell。 */
const PREWARM_TTL_MS = 90_000

/**
 * 是否启用终端预热。
 *
 * 预热是「多一个后台 shell 换启动速度」的取舍；默认开启，但留给不想多进程的部署一个开关：
 * `DWV_TERMINAL_PREWARM=0`（或 false/off）关掉。未知值一律视为开启。
 */
export function terminalPrewarmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.DWV_TERMINAL_PREWARM?.trim().toLowerCase()
  return value !== '0' && value !== 'false' && value !== 'off'
}

/** 跑起来了、但还没有终端 id 的 shell。 */
interface WarmShell { key: string; target: string; shell: string; handle: TerminalHandle; timer: ReturnType<typeof setTimeout> }

/**
 * 按工作区持有交互式终端，并额外维护**一个**预热 shell。
 *
 * 为什么要预热：实测 pwsh 从 spawn 到提示符可用平均约 530ms（大头是 profile 加载，不是我们的
 * 代码）。用户点「新建终端」到看见提示符的这段时间没法再压缩，但可以提前到「面板已经打开、
 * 用户还在看」的空档里 —— 面板一打开先把默认 shell 起好，点下去时回放缓冲里已经有提示符了。
 *
 * 认领规则：只有工作区根目录、且解析出的 shell 与预热时一致的新建请求才会拿走它；其余请求
 * （「在终端中打开」的子目录、选了别的 shell）照常现起，预热 shell 留着给下一次默认新建。
 * 90 秒没人用就自己退出（见 PREWARM_TTL_MS）。
 */
export class TerminalManager {
  private readonly workspaces = new Map<string, Map<string, TerminalHandle>>()
  private warm: WarmShell | undefined

  constructor(private readonly spawn: SpawnPty = defaultSpawn, private readonly warmTtlMs = PREWARM_TTL_MS, private readonly prewarmEnabled: () => boolean = () => terminalPrewarmEnabled()) {}

  private workspace(cwd: string): string { return realpathSync(cwd) }

  list(cwd: string): TerminalInfo[] { return [...(this.workspaces.get(this.workspace(cwd))?.values() ?? [])].map(handle => ({ ...handle.info })) }

  /**
   * 起一个预热 shell。
   *
   * 同一个工作区只保留一个；换到别的工作区时把旧的丢掉（它已经没机会被认领了）。
   * 已有终端时也允许预热：用户可能还要再开一个，而列表状态由客户端判断。
   */
  prewarm(cwd: string): void {
    // 部署方可以用 DWV_TERMINAL_PREWARM=0 关掉：此时预热请求是空操作，新建照常现起 shell。
    if (!this.prewarmEnabled()) return
    const key = this.workspace(cwd)
    if (this.warm !== undefined && this.warm.key === key) return
    this.dropWarm()
    const { shell, args } = terminalShell()
    const handle = this.spawnHandle(key, shell, args)
    const timer = setTimeout(() => { if (this.warm?.handle === handle) this.dropWarm() }, this.warmTtlMs)
    // 宿主长时间运行；这个定时器不该在关闭时多拖 90 秒。
    if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref?: () => void }).unref?.()
    this.warm = { key, target: key, shell, handle, timer }
  }

  /**
   * 新建终端。`directory` 是工作区相对目录（「在终端中打开」），缺省为工作区根。
   *
   * pty 的 cwd 用解析后的绝对目录，`TerminalInfo.cwd` 记的也是它 —— 客户端据此显示
   * 「这个终端实际在哪」，重连/排查时不必再猜一次。
   */
  create(cwd: string, title?: string, profileId?: string, directory?: string): TerminalInfo {
    const key = this.workspace(cwd)
    const target = resolveTerminalDirectory(key, directory)
    const terminals = this.workspaces.get(key) ?? new Map<string, TerminalHandle>()
    this.workspaces.set(key, terminals)
    if (terminals.size >= MAX_TERMINALS) throw new Error(`terminal limit reached (${MAX_TERMINALS})`)
    const { shell, args } = terminalShell(profileId)
    // 预热 shell 是一份已经跑起来的默认终端：目录与 shell 都对得上才提上来。
    const handle = this.takeWarm(key, target, shell) ?? this.spawnHandle(target, shell, args)
    const info = handle.info
    info.id = randomUUID()
    info.cwd = target
    info.title = title || uniqueTerminalTitle(terminalTitleBase(shell), [...terminals.values()].map(value => value.info.title))
    terminals.set(info.id, handle)
    return { ...info }
  }

  /** 真正起一个 shell 并接上输出采集；创建路径与预热路径共用这一份。 */
  private spawnHandle(target: string, shell: string, args: string[]): TerminalHandle {
    const child = this.spawn(shell, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd: target, env: sanitizedTerminalEnv(process.env) })
    const info: TerminalInfo = { id: '', title: '', cwd: target, running: true, sequence: 0 }
    const handle: TerminalHandle = { info, process: child, replay: new ReplayBuffer(), listeners: new Set() }
    child.onData(data => {
      info.sequence++
      handle.replay.push(data)
      for (const listener of handle.listeners) listener({ sequence: info.sequence, data })
    })
    child.onExit(({ exitCode }) => {
      info.running = false
      info.exitCode = exitCode
      info.sequence++
      const data = `\r\n[process exited with code ${exitCode}]\r\n`
      // immediate：退出消息必须排在它之前所有输出之后、且不能被合批窗口拖住（见 TerminalOutput）。
      for (const listener of handle.listeners) listener({ sequence: info.sequence, data, immediate: true })
    })
    return handle
  }

  /** 认领预热 shell：目录与 shell 都对上、而且它还活着才提上来；不匹配就留着。 */
  private takeWarm(key: string, target: string, shell: string): TerminalHandle | undefined {
    const warm = this.warm
    if (warm === undefined) return undefined
    if (warm.key !== key || warm.target !== target || warm.shell !== shell) return undefined
    clearTimeout(warm.timer)
    this.warm = undefined
    // 预热的 shell 可能已经自己退出了（用户改了 profile、shell 崩溃等）：那就是没有可认领的。
    if (warm.handle.info.running) return warm.handle
    try { warm.handle.process.kill() } catch { /* 已经退出了。 */ }
    return undefined
  }

  private dropWarm(): void {
    const warm = this.warm
    if (warm === undefined) return
    this.warm = undefined
    clearTimeout(warm.timer)
    try { warm.handle.process.kill() } catch { /* 可能已经退出。 */ }
  }

  get(cwd: string, id: string): TerminalHandle | undefined { return this.workspaces.get(this.workspace(cwd))?.get(id) }

  close(cwd: string, id: string): void {
    const key = this.workspace(cwd)
    const terminals = this.workspaces.get(key)
    const handle = terminals?.get(id)
    if (handle === undefined || terminals === undefined) return
    terminals.delete(id)
    try { handle.process.kill() } catch { /* The shell may already have exited. */ }
    if (terminals.size === 0) this.workspaces.delete(key)
  }

  rename(cwd: string, id: string, title: string): TerminalInfo {
    const handle = this.get(cwd, id)
    if (handle === undefined) throw new Error('terminal not found')
    handle.info.title = title
    return { ...handle.info }
  }

  dispose(): void { this.dropWarm(); for (const [cwd, terminals] of this.workspaces) for (const id of terminals.keys()) this.close(cwd, id) }
}

function terminalRequestAllowed(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined || req.headers['sec-fetch-site'] === 'cross-site') return false
  let hostname: string
  try { hostname = new URL(`http://${host}`).hostname } catch { return false }
  if (hostname !== 'localhost' && hostname !== '[::1]' && !hostname.startsWith('127.')) return false
  const origin = req.headers.origin
  try { return origin === undefined || new URL(origin).host === host } catch { return false }
}

/**
 * 本机地址，供客户端拼 WebSocket 用。
 *
 * 为什么需要它：桌面端(Electron)的页面跑在 `dsh-app://app/` 下，`location.host` 是 `app`，
 * 客户端按它拼出来的 `ws://app/…` 根本无法连接（实测 close code 1006）。桌面端把 HTTP 请求
 * 经自定义协议转发给宿主，但 **WebSocket 的 upgrade 不经过那条转发**，所以必须给客户端一个
 * 宿主的绝对地址。
 *
 * **只用 `req.socket.localPort`** —— 它回答的是「这个请求打到了哪个端口」，是第一手事实。
 *
 * 明确不用 `DSH_WEB_URL`：它由 DSH 的 web-app 注册在 shellEnv 上，描述的是 **shell 命令所在
 * 那个 Harness 实例**的地址，未必是当前宿主。实测代价很直观 —— 在桌面端内启动的 Web 测试实例
 * 会继承 `DSH_WEB_URL=http://127.0.0.1:19387`，于是 Web 端的终端跑去连桌面端的端口，连接失败
 * （close 1006）、终端空白。两个来源在这种情况下会给出互相矛盾的答案，而 localPort 是对的。
 *
 * 只输出回环地址：客户端就在本机，没有理由把对外地址交出去。
 */
export function localBase(req: IncomingMessage): string | undefined {
  const port = req.socket.localPort
  if (typeof port !== 'number' || port <= 0) return undefined
  const host = req.socket.localAddress === '::1' ? '[::1]' : '127.0.0.1'
  return `http://${host}:${port}`
}

/** Register the private local terminal API and WebSocket transport. */
export function installTerminal(ctx: HostContext): void {
  const manager = new TerminalManager()
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-vscode-terminal/api', handler: async (req, res) => {
    if (!authorize(req, res, ctx.connection)) return
    if (!terminalRequestAllowed(req)) return send(res, 403, { ok: false, error: { message: 'forbidden' } })
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: { message: 'POST required' } })
    try {
      const body = await readBody(req)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (sessionId === '') throw new Error('sessionId required')
      const cwd = cwdFor(ctx, sessionId)
      const method = new URL(req.url ?? '/', 'http://dsh.local').pathname.slice('/dsh-vscode-terminal/api/'.length)
      let value: unknown
      if (method === 'list') value = manager.list(cwd)
      else if (method === 'profiles') value = terminalProfiles()
      // `directory` 来自「在终端中打开」：工作区相对路径，由 resolveTerminalDirectory 校验后作为 pty 的 cwd。
      else if (method === 'create') value = manager.create(cwd, typeof body.title === 'string' ? body.title : undefined, typeof body.profile === 'string' ? body.profile : undefined, typeof body.directory === 'string' ? body.directory : undefined)
      else if (method === 'close') { manager.close(cwd, typeof body.id === 'string' ? body.id : ''); value = manager.list(cwd) }
      else if (method === 'rename') value = manager.rename(cwd, typeof body.id === 'string' ? body.id : '', typeof body.title === 'string' ? body.title : '')
      // 预热：面板打开、还没有终端时先把默认 shell 起好（见 TerminalManager.prewarm）。
      else if (method === 'prewarm') { manager.prewarm(cwd); value = manager.list(cwd) }
      else throw new Error('unknown terminal method')
      // 把本机地址一并带上，供客户端拼 WebSocket 用（桌面端按 location.host 拼不出可连的地址）。
      send(res, 200, { ok: true, value, wsBase: localBase(req) })
    } catch (error) { sendError(res, error) }
  } }), 'dsh-vscode-workbench: terminal API')

  const webSocket = new WebSocketServer({ noServer: true })
  ctx.effect(() => ctx.webServer.registerUpgrade({ path: '/dsh-vscode-terminal/ws', handler(req, socket, head) {
    if (ctx.connection.requestRejection(req) !== undefined || !terminalRequestAllowed(req as IncomingMessage)) { socket.destroy(); return }
    webSocket.handleUpgrade(req as IncomingMessage, socket as Duplex, head, connection => {
      const url = new URL(req.url ?? '/', 'http://dsh.local')
      const sessionId = url.searchParams.get('sessionId')
      const id = url.searchParams.get('id')
      if (sessionId === null || id === null) { connection.close(1008, 'sessionId and id required'); return }
      let handle: TerminalHandle | undefined
      try { handle = manager.get(cwdFor(ctx, sessionId), id) }
      catch { connection.close(1008, 'session workspace unavailable'); return }
      if (handle === undefined) { connection.close(1008, 'terminal not found'); return }
      const replay = handle.replay.tail()
      if (replay !== '') {
        const sequence = handle.info.sequence
        for (const chunk of replayChunks(replay)) connection.send(JSON.stringify({ type: 'replay', sequence, data: chunk }))
      }
      // 每个连接一个合批器：同一个终端可能有多个订阅者（多开标签页），各自按自己的节奏收帧，
      // 互不影响序列化成本（每个连接仍然只序列化自己那一份合并结果）。
      const coalescer = new OutputCoalescer(frame => { if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify(frame)) })
      const listener = (output: TerminalOutput) => coalescer.push(output.sequence, output.data, output.immediate === true)
      handle.listeners.add(listener)
      connection.on('message', raw => {
        const text = raw.toString()
        try {
          const message: unknown = JSON.parse(text)
          if (message !== null && typeof message === 'object' && 'type' in message && message.type === 'input' && 'data' in message && typeof message.data === 'string') handle.process.write(message.data)
          else if (message !== null && typeof message === 'object' && 'type' in message && message.type === 'resize' && 'cols' in message && 'rows' in message && typeof message.cols === 'number' && typeof message.rows === 'number') handle.process.resize(Math.max(2, Math.floor(message.cols)), Math.max(2, Math.floor(message.rows)))
        } catch { handle.process.write(text) }
      })
      // 连接关闭：先把剩余输出尽力发出去（socket 已关时 send 会自己跳过），再注销订阅并清理定时器。
      connection.on('close', () => { coalescer.dispose(); handle.listeners.delete(listener) })
    })
  } }), 'dsh-vscode-workbench: terminal WebSocket')
  ctx.effect(() => () => { webSocket.close(); manager.dispose() }, 'dsh-vscode-workbench: terminal teardown')
}
