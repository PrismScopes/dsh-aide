/**
 * 宿主入口基准：每个样本都在独立的 node 子进程里 import lib/index.js。
 *
 * 同时记录两类耗时：
 *   wallMs   —— 父进程 spawn→退出，包含 node 启动、模块解析、执行、退出
 *   importMs —— 子进程内 await import() 的耗时，近似宿主模块初始化成本
 *
 * 若 lib/index.js 完全无法导入，退化为只报告文件体积并标记 degraded（同时仍以
 * 非零退出码暴露失败原因，不静默吞掉）。
 */
import { stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyStderr, parseLastJsonLine, round, runCommand, stats, toErrorRecord } from './util.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROBE = join(HERE, 'host-probe.mjs')

async function probeOnce(repoRoot, target, timeoutMs) {
  const run = await runCommand(process.execPath, [PROBE, target], { cwd: repoRoot, timeoutMs })
  const parsed = parseLastJsonLine(run.stdout)
  const stderr = classifyStderr(run.stderr)
  return { run, parsed, stderr }
}

function summarize(run, parsed, stderr) {
  const value = parsed.value
  const ok = run.timedOut !== true && run.code === 0 && parsed.error === undefined && value?.ok === true
  return {
    ok,
    code: run.code,
    signal: run.signal,
    timedOut: run.timedOut,
    wallMs: run.wallMs,
    importMs: value?.importMs ?? null,
    exportCount: value?.exportCount ?? null,
    exports: value?.exports ?? null,
    stderrNoiseLines: stderr.noise.length,
    stderrNoiseEvents: stderr.attachConsoleEvents,
    stderrUnexpected: stderr.unexpected,
    error: ok
      ? undefined
      : run.timedOut
        ? 'probe timed out'
        : parsed.error ?? value?.error ?? run.spawnError?.message ?? `probe exited with code ${run.code}`,
  }
}

/**
 * @param {{repoRoot: string, rounds: number, timeoutMs?: number}} options
 */
export async function runHostSuite({ repoRoot, rounds, timeoutMs = 120_000 }) {
  const target = resolve(repoRoot, 'lib/index.js')
  const errors = []
  const warnings = []
  let sizeBytes = null
  try {
    sizeBytes = (await stat(target)).size
  } catch (error) {
    errors.push(toErrorRecord('host', 'entry-stat-failed', error, { target }))
  }

  const warmup = await probeOnce(repoRoot, target, timeoutMs)
  const warmupSummary = summarize(warmup.run, warmup.parsed, warmup.stderr)

  const runs = []
  const failedRuns = []
  for (let index = 0; index < rounds; index += 1) {
    const attempt = await probeOnce(repoRoot, target, timeoutMs)
    const summary = summarize(attempt.run, attempt.parsed, attempt.stderr)
    runs.push({ round: index + 1, ...summary })
    if (!summary.ok) {
      const failure = toErrorRecord('host', summary.timedOut ? 'probe-timeout' : 'probe-failed', new Error(summary.error ?? 'unknown'), {
        round: index + 1,
        code: summary.code,
        stderrUnexpected: summary.stderrUnexpected,
      })
      failedRuns.push(failure)
      errors.push(failure)
    }
  }

  const successful = runs.filter(run => run.ok)
  let fallback = null
  if (successful.length === 0) {
    fallback = {
      degraded: true,
      kind: 'size-only',
      sizeBytes,
      note: 'lib/index.js 无法在独立进程里导入，只能退化为文件体积；失败原因见 errors。',
    }
  }
  if (warmupSummary.ok === false) {
    warnings.push({
      kind: 'warmup-failed',
      reason: warmupSummary.error,
      stderrUnexpected: warmupSummary.stderrUnexpected,
    })
  }

  const attachConsoleNoiseLines = warmup.stderr.noise.length + runs.reduce((sum, run) => sum + run.stderrNoiseLines, 0)
  const attachConsoleNoiseEvents = warmup.stderr.attachConsoleEvents + runs.reduce((sum, run) => sum + run.stderrNoiseEvents, 0)
  const unexpectedStderr = [...warmup.stderr.unexpected, ...runs.flatMap(run => run.stderrUnexpected)]
  for (const line of unexpectedStderr) {
    // node 的 ExperimentalWarning 等也可能出现；记录下来但不当作失败。
    warnings.push({ kind: 'stderr-unexpected', line })
  }

  return {
    suite: 'host',
    meta: {
      repoRoot,
      target,
      rounds,
      warmupRounds: 1,
      timeoutMs,
      node: process.version,
      note: '每个样本是独立 node 子进程；wallMs 含 node 启动，importMs 为子进程内 import() 耗时。',
    },
    sizeBytes,
    warmup: warmupSummary,
    runs,
    failedRuns,
    stats: {
      wall: stats(successful.map(run => run.wallMs)),
      import: stats(successful.map(run => run.importMs)),
    },
    noise: {
      attachConsoleFailedLines: attachConsoleNoiseLines,
      attachConsoleFailedEvents: attachConsoleNoiseEvents,
      note: 'node-pty console list agent 的 "AttachConsole failed" 计入已知噪声；其余 stderr 原样记录在 warnings。',
    },
    fallback,
    errors,
    warnings,
  }
}
