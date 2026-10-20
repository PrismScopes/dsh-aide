/**
 * 终端预热基准（真机 shell）。
 *
 * 由 index.mjs 以 `node --experimental-transform-types --no-warnings` 在子进程里运行：
 * src/terminal.ts 用了 TS 参数属性，Node 的类型剥离模式不支持，必须开 transform。
 *
 * 三个指标：
 *   warmReadyMs  从 prewarm() 到预热 shell 吐出提示符（shell 自己启动的成本，被面板打开的空档吸收）
 *   adoptMs      create() 认领预热 shell 的耗时（宿主侧只剩一次随机 id / 标题计算）
 *   coldReadyMs  不预热直接 create() 到提示符（用户点新建后干等的成本）
 * 末尾打印一行 JSON，index.mjs 用 parseLastJsonLine 取回。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TerminalManager } from '../../src/terminal.ts'

const roundsArg = process.argv.find(argument => argument.startsWith('--rounds='))
const rounds = roundsArg === undefined ? 5 : Math.max(1, Math.min(20, Number.parseInt(roundsArg.slice('--rounds='.length), 10) || 5))
const DEADLINE_MS = 15_000
const POLL_MS = 10

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function stats(values) {
  if (values.length === 0) return { n: 0, mean: null, min: null, max: null }
  const sorted = [...values].sort((left, right) => left - right)
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  return {
    n: values.length,
    mean: Number(mean.toFixed(2)),
    min: Number(sorted[0].toFixed(2)),
    max: Number(sorted[sorted.length - 1].toFixed(2)),
  }
}

/** 轮询预热槽里的回放缓冲，直到 shell 自己吐出提示符。 */
async function waitForWarmPrompt(manager, deadlineMs) {
  const started = performance.now()
  while (performance.now() - started < deadlineMs) {
    const warm = manager.warm
    if (warm !== undefined && warm.handle.replay.tail() !== '') return { readyMs: performance.now() - started, replayBytes: warm.handle.replay.tail().length }
    await sleep(POLL_MS)
  }
  return { readyMs: null, replayBytes: 0 }
}

/** 轮询某个终端句柄的回放缓冲，直到 shell 吐出提示符。 */
async function waitForTerminalPrompt(manager, workspace, info, deadlineMs) {
  const started = performance.now()
  while (performance.now() - started < deadlineMs) {
    const replay = manager.get(workspace, info.id)?.replay.tail() ?? ''
    if (replay !== '') return { readyMs: performance.now() - started, replayBytes: replay.length }
    await sleep(POLL_MS)
  }
  return { readyMs: null, replayBytes: 0 }
}

async function main() {
  const workspace = mkdtempSync(join(tmpdir(), 'dvw-perf-prewarm-'))
  const warmReady = []
  const adopt = []
  const coldReady = []
  const failures = []
  const shells = new Set()

  try {
    for (let round = 0; round < rounds; round++) {
      const warmManager = new TerminalManager()
      try {
        warmManager.prewarm(workspace)
        const state = warmManager.warm
        if (state === undefined) {
          failures.push({ round, kind: 'prewarm-skipped', reason: 'DWV_TERMINAL_PREWARM 被关闭或预热被拒绝' })
          continue
        }
        shells.add(state.shell)
        const ready = await waitForWarmPrompt(warmManager, DEADLINE_MS)
        if (ready.readyMs === null) { failures.push({ round, kind: 'warm-timeout' }); continue }
        warmReady.push(ready.readyMs)
        const created = performance.now()
        const info = warmManager.create(workspace)
        const adoptMs = performance.now() - created
        adopt.push(adoptMs)
        const replay = warmManager.get(workspace, info.id)?.replay.tail() ?? ''
        if (replay === '') failures.push({ round, kind: 'adopt-without-replay' })
      } finally {
        warmManager.dispose()
      }

      // 冷启动对照：全新 manager，直接 create，量到提示符出现。
      const coldManager = new TerminalManager()
      try {
        const created = performance.now()
        const info = coldManager.create(workspace)
        const createdMs = performance.now() - created
        const ready = await waitForTerminalPrompt(coldManager, workspace, info, DEADLINE_MS)
        if (ready.readyMs === null) failures.push({ round, kind: 'cold-timeout' })
        else coldReady.push(createdMs + ready.readyMs)
      } finally {
        coldManager.dispose()
      }
    }
  } finally {
    try { rmSync(workspace, { recursive: true, force: true }) } catch { /* shell 可能还占着目录 */ }
  }

  const data = {
    suite: 'prewarm',
    shell: [...shells].join(','),
    rounds,
    warmReadyMs: stats(warmReady),
    adoptMs: stats(adopt),
    coldReadyMs: stats(coldReady),
    savedMs: warmReady.n === 0 || coldReady.n === 0 ? null : Number((stats(coldReady).mean - stats(adopt).mean).toFixed(2)),
    failures,
    note: 'warmReadyMs 是 shell 自身启动成本被提前吸收；adoptMs 是用户点新建后宿主侧等待；coldReadyMs 是不预热时的干等成本。',
  }
  console.log(JSON.stringify(data))
}

await main()
