/**
 * 终端启动基准：直接调用仓库 node_modules 里的 node-pty，对 COMSPEC/cmd、
 * pwsh.exe、powershell.exe 各采样 N 次。
 *
 * 本文件既可以在主入口里通过子进程调用（推荐：node-pty 的 stderr 噪声会被
 * 父进程归类，不污染基准输出），也可以直接运行：
 *
 *   node scripts/perf/pty.mjs --rounds=5 [--conpty-dll-control]
 *
 * stdout 只输出一行 JSON；诊断信息一律走 stderr。主入口负责把 stderr 分成
 * 「已知噪声」与「意外输出」。
 *
 * 指标定义（全部以 pty.spawn 调用前为 t0）：
 *   spawn      : pty.spawn(...) 返回到调用方，不含 shell 进程启动
 *   firstByte  : 第一次收到 shell 输出（ConPTY 首次 flush）的耗时
 *   shellReady : spawn 后立即写入 `echo <唯一 marker>`，直到输出里出现
 *                「行首的 marker」——即命令真正执行完成、结果回显的耗时。
 *                行首判定用来排除输入回显（输入行前面还有提示符和 "echo "）。
 */
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pty from 'node-pty'
import { escapeRegExp, stats, stripAnsi, toErrorRecord, which } from './util.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')

/** 与工作台 src/terminal.ts 保持一致的敏感环境变量过滤规则。 */
const SENSITIVE = /(api[_-]?key|token|credential|secret|password|passwd|private[_-]?key|^dsh_.*(?:key|token|secret))/i

const DEFAULT_ROUNDS = 5
const DEFAULT_TIMEOUT_MS = 15_000
const CONTROL_TIMEOUT_MS = 4_000
const BETWEEN_RUNS_MS = 150
const WARMUP_ROUNDS = 1
const MAX_BUFFER_CHARS = 128 * 1024

function sanitizedTerminalEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => value !== undefined && !SENSITIVE.test(key)),
  )
}

/** 探测三个 shell。缺失时返回 missing 记录，由上层作为显式错误处理。 */
export function resolveShells(env = process.env) {
  const comspec = env.COMSPEC?.trim()
  const cmdPath = comspec !== undefined && comspec !== '' ? comspec : which('cmd.exe', env)
  const candidates = [
    { id: 'cmd', label: 'cmd.exe', shell: cmdPath, args: [] },
    { id: 'pwsh', label: 'pwsh.exe', shell: which('pwsh.exe', env), args: [] },
    { id: 'powershell', label: 'powershell.exe', shell: which('powershell.exe', env), args: [] },
  ]
  const shells = []
  const missing = []
  for (const candidate of candidates) {
    if (candidate.shell === undefined) {
      missing.push({ ...candidate, reason: `${candidate.label} not found on PATH${candidate.id === 'cmd' ? ' and COMSPEC is empty' : ''}` })
    } else {
      shells.push(candidate)
    }
  }
  return { shells, missing }
}

function tailOf(buffer) {
  return buffer.length <= 600 ? buffer : `…${buffer.slice(-600)}`
}

/**
 * 跑一次终端启动采样。永不 reject：失败以 { ok: false, ... } 返回，
 * 由上层决定是否算基准失败。
 */
export function runOnce({ shell, args = [], useConptyDll = false, timeoutMs = DEFAULT_TIMEOUT_MS, cols = 80, rows = 24 }) {
  return new Promise(resolve => {
    const marker = `__DVW_${randomUUID().replace(/-/g, '').slice(0, 8)}__`
    const markerPattern = new RegExp(`(?:^|[\\r\\n])\\s*${escapeRegExp(marker)}`)
    const started = performance.now()
    let child
    try {
      child = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: REPO_ROOT,
        env: sanitizedTerminalEnv(),
        useConptyDll,
      })
    } catch (error) {
      resolve({ ok: false, spawnError: error instanceof Error ? error.message : String(error), marker, useConptyDll })
      return
    }
    const spawnMs = performance.now() - started

    let dataSubscription
    let exitSubscription
    let settled = false
    let firstByteMs = null
    let shellReadyMs = null
    let dataEvents = 0
    let bytes = 0
    let markerOccurrences = 0
    let buffer = ''

    const cleanup = () => {
      try {
        dataSubscription?.dispose()
      } catch {
        /* listener 可能已被 pty 内部清理 */
      }
      try {
        exitSubscription?.dispose()
      } catch {
        /* 同上 */
      }
      try {
        child.kill()
      } catch {
        /* 进程可能已退出 */
      }
      try {
        child.dispose()
      } catch {
        /* 同上 */
      }
    }

    const finish = (result, settleDelayMs = 0) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const payload = {
        ok: result.ok,
        marker,
        useConptyDll,
        ...result,
        spawnMs: Math.round(spawnMs * 100) / 100,
        firstByteMs: firstByteMs === null ? null : Math.round(firstByteMs * 100) / 100,
        shellReadyMs: shellReadyMs === null ? null : Math.round(shellReadyMs * 100) / 100,
        dataEvents,
        bytes,
        markerOccurrences,
      }
      if (payload.ok === false && payload.tail === undefined) payload.tail = tailOf(buffer)
      cleanup()
      setTimeout(() => resolve(payload), settleDelayMs)
    }

    const timer = setTimeout(() => {
      finish({ ok: false, timedOut: true })
    }, timeoutMs)

    dataSubscription = child.onData(chunk => {
      if (settled || chunk.length === 0) return
      if (firstByteMs === null) firstByteMs = performance.now() - started
      dataEvents += 1
      bytes += Buffer.byteLength(chunk)
      markerOccurrences += chunk.split(marker).length - 1
      if (buffer.length < MAX_BUFFER_CHARS) {
        buffer += chunk
        if (buffer.length > MAX_BUFFER_CHARS) buffer = buffer.slice(-MAX_BUFFER_CHARS)
      }
      // PSReadLine 有时会在 marker 前插入 \x1b[?25h 之类的转义序列，导致
      // 「行首」判定失败；判定前先剥掉 ANSI，原始 buffer 仍保留给失败诊断。
      if (shellReadyMs === null && markerPattern.test(stripAnsi(buffer))) {
        shellReadyMs = performance.now() - started
        // marker 之后通常还会跟提示符；多等 20ms 让 ConPTY 把该次输出 flush 完。
        finish({ ok: true }, 20)
      }
    })

    exitSubscription = child.onExit(({ exitCode, signal }) => {
      finish({ ok: false, exitedBeforeReady: true, exitCode, signal })
    })

    // 与用户「终端一打开就粘贴命令」等价：spawn 之后立即写入，命令会由 shell
    // 的输入缓冲接住；因此 shellReady 包含 shell 自身的启动时间。
    try {
      child.write(`echo ${marker}\r`)
    } catch (error) {
      finish({ ok: false, writeError: error instanceof Error ? error.message : String(error) })
    }
  })
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 跑完整 pty 套件。返回值即 pty 子进程写出的 JSON。
 */
export async function runPtySuite({ rounds = DEFAULT_ROUNDS, conptyDllControl = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const startedAt = new Date().toISOString()
  const { shells, missing } = resolveShells()
  const errors = []
  const warnings = []

  for (const absent of missing) {
    errors.push(toErrorRecord('pty', 'missing-shell', new Error(absent.reason), { shell: absent.id }))
  }

  const shellResults = []
  for (const shell of shells) {
    const warmupRuns = []
    for (let index = 0; index < WARMUP_ROUNDS; index += 1) {
      const run = await runOnce({ shell: shell.shell, args: shell.args, timeoutMs })
      warmupRuns.push(run)
      if (!run.ok) {
        warnings.push({
          shell: shell.id,
          kind: 'warmup-failed',
          reason: run.timedOut ? 'timeout' : run.exitCode !== undefined ? `exit ${run.exitCode}` : run.spawnError ?? 'unknown',
        })
      }
      await sleep(BETWEEN_RUNS_MS)
    }

    const runs = []
    const failures = []
    for (let index = 0; index < rounds; index += 1) {
      const run = await runOnce({ shell: shell.shell, args: shell.args, timeoutMs })
      runs.push(run)
      if (!run.ok) {
        const failure = toErrorRecord(
          'pty',
          run.timedOut ? 'run-timeout' : 'run-failed',
          new Error(
            run.timedOut
              ? `shell ${shell.id} did not reach shell-ready within ${timeoutMs}ms`
              : run.spawnError ?? run.writeError ?? `shell ${shell.id} exited before shell-ready (exit ${run.exitCode})`,
          ),
          { shell: shell.id, round: index + 1, tail: run.tail },
        )
        failures.push(failure)
        errors.push(failure)
      }
      await sleep(BETWEEN_RUNS_MS)
    }

    const successful = runs.filter(run => run.ok)
    shellResults.push({
      id: shell.id,
      label: shell.label,
      shell: shell.shell,
      args: shell.args,
      status: failures.length === 0 ? 'ok' : 'failed',
      rounds,
      warmupRuns,
      runs,
      failures,
      stats: {
        spawn: stats(successful.map(run => run.spawnMs)),
        firstByte: stats(successful.map(run => run.firstByteMs)),
        shellReady: stats(successful.map(run => run.shellReadyMs)),
      },
    })
  }

  let control = null
  if (conptyDllControl && shells.length > 0) {
    const cmd = shells.find(shell => shell.id === 'cmd') ?? shells[0]
    const run = await runOnce({ shell: cmd.shell, args: cmd.args, useConptyDll: true, timeoutMs: CONTROL_TIMEOUT_MS })
    control = {
      shell: cmd.id,
      useConptyDll: true,
      timeoutMs: CONTROL_TIMEOUT_MS,
      ...run,
      anomalyObserved: !run.ok || (run.markerOccurrences ?? 0) > 2,
      knownIssue: 'useConptyDll:true 已知异常：输入会被重复/乱序回显，shell-ready 不可靠。仅作对照项，默认不启用。',
    }
  }

  return {
    suite: 'pty',
    startedAt,
    finishedAt: new Date().toISOString(),
    meta: {
      repoRoot: REPO_ROOT,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      rounds,
      warmupRounds: WARMUP_ROUNDS,
      betweenRunsMs: BETWEEN_RUNS_MS,
      timeoutMs,
      cols: 80,
      rows: 24,
      shellEnv: 'process.env（按工作台 sanitizedTerminalEnv 过滤敏感键）',
      note: 'shell 未加 -NoProfile（与工作台一致，PowerShell profile 加载计入启动耗时）',
    },
    shells: shellResults,
    missingShells: missing,
    controls: { useConptyDll: control },
    noise: {
      note: 'node-pty 的 console list agent 可能向 stderr 打印 "AttachConsole failed"；本套件由父进程捕获并按已知噪声归类，不视为失败。',
    },
    errors,
    warnings,
  }
}

/** 子进程 CLI：stdout 只写一行 JSON。 */
async function main(argv) {
  let rounds = DEFAULT_ROUNDS
  let conptyDllControl = false
  for (const arg of argv) {
    if (arg.startsWith('--rounds=')) {
      rounds = Number.parseInt(arg.slice('--rounds='.length), 10)
      if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) {
        throw new Error(`invalid --rounds value: ${arg}`)
      }
    } else if (arg === '--conpty-dll-control') {
      conptyDllControl = true
    } else if (arg === '--help' || arg === '-h') {
      process.stderr.write('usage: node scripts/perf/pty.mjs [--rounds=N] [--conpty-dll-control]\n')
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }

  let result
  try {
    result = await runPtySuite({ rounds, conptyDllControl })
  } catch (error) {
    result = {
      suite: 'pty',
      errors: [toErrorRecord('pty', 'crash', error)],
      warnings: [],
      shells: [],
    }
  }
  const output = `${JSON.stringify(result)}\n`
  process.stdout.write(output, () => {
    process.exit(result.errors.length > 0 ? 1 : 0)
  })
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`[pty] fatal: ${error instanceof Error ? error.stack : String(error)}\n`)
    process.exit(1)
  })
}
