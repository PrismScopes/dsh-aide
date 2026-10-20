/**
 * 性能基准的公共工具：统计、表格、子进程、PATH 探测、stderr 噪声归类。
 *
 * 只依赖 node 内置模块，不引入新依赖。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { delimiter, dirname } from 'node:path'

/** 保留 digits 位小数；非有限数值返回 null，避免 JSON 里出现 NaN。 */
export function round(value, digits = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * 基础统计。只统计有限数值样本；空样本返回全 null。
 * 计时单位是毫秒，默认保留 2 位小数。
 */
export function stats(values, digits = 2) {
  const clean = values.filter(value => typeof value === 'number' && Number.isFinite(value))
  if (clean.length === 0) {
    return { n: 0, mean: null, min: null, max: null, median: null, stddev: null }
  }
  const sorted = [...clean].sort((left, right) => left - right)
  const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
  const variance = clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / clean.length
  return {
    n: clean.length,
    mean: round(mean, digits),
    min: round(sorted[0], digits),
    max: round(sorted[sorted.length - 1], digits),
    median: round(median, digits),
    stddev: round(Math.sqrt(variance), digits),
  }
}

/** 例：2628253 → "2.51 MiB"（表格里另给字节数与 KiB）。 */
export function formatBytes(bytes, digits = 2) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '-'
  if (bytes >= 1024 * 1024) return `${round(bytes / (1024 * 1024), digits)} MiB`
  if (bytes >= 1024) return `${round(bytes / 1024, digits)} KiB`
  return `${bytes} B`
}

/** 把耗时统计格式化成 "mean (min-max)"，空样本给 "-"。 */
export function formatTiming(summary) {
  if (summary === null || summary === undefined || summary.n === 0) return '-'
  return `${summary.mean} (${summary.min}-${summary.max})`
}

/** 在 PATH 里按文件名查找可执行文件（与工作台 src/terminal.ts 的 which 同一套规则）。 */
export function which(file, env = process.env) {
  const searchPath = env.PATH ?? env.Path ?? ''
  for (const directory of searchPath.split(delimiter)) {
    if (directory === '') continue
    const candidate = `${directory.replace(/[\\/]+$/, '')}\\${file}`
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** 正则转义，用于把唯一 marker 拼进检测表达式。 */
export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 去掉 ANSI 转义序列，用于「行首 marker」判定（输出与输入回显都可能夹带 CSI/OSC）。 */
export function stripAnsi(text) {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_]/g, '')
}

/** 写文件前确保父目录存在（产物目录可能还不存在）。 */
export async function ensureParent(filePath) {
  await mkdir(dirname(filePath), { recursive: true })
  return filePath
}

/**
 * 简单的等宽表格渲染，不依赖第三方包。
 * align：每列 'left' | 'right'，缺省首列左对齐、其余右对齐。
 */
export function renderTable(headers, rows, { align } = {}) {
  const matrix = [headers.map(String), ...rows.map(row => row.map(cell => (cell === null || cell === undefined ? '' : String(cell))))]
  const widths = headers.map((_, column) => Math.max(...matrix.map(row => row[column].length)))
  const aligns = headers.map((_, column) => align?.[column] ?? (column === 0 ? 'left' : 'right'))
  const renderRow = cells => cells.map((cell, column) => (aligns[column] === 'right' ? cell.padStart(widths[column]) : cell.padEnd(widths[column]))).join('  ')
  const separator = widths.map(width => '-'.repeat(width)).join('  ')
  return [renderRow(matrix[0]), separator, ...matrix.slice(1).map(renderRow)].join('\n')
}

/**
 * 跑一个子进程并收集 stdio。用于把 pty 噪声隔离到子进程的 stderr，
 * 也用于 host 的独立进程 import 测量。
 */
export function runCommand(file, args, { cwd, env = process.env, timeoutMs = 300_000 } = {}) {
  return new Promise(resolve => {
    const started = performance.now()
    let child
    try {
      child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', wallMs: round(performance.now() - started), timedOut: false, spawnError: error })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
      // 防止异常进程刷爆内存；保留末尾即可诊断。
      if (stderr.length > 256 * 1024) stderr = stderr.slice(-256 * 1024)
    })
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        /* 进程可能已退出；超时仍会作为失败记录 */
      }
    }, timeoutMs)
    let settled = false
    const finish = (code, signal, spawnError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, wallMs: round(performance.now() - started), timedOut, spawnError })
    }
    child.on('error', error => finish(null, null, error))
    child.on('close', (code, signal) => finish(code, signal))
  })
}

/**
 * node-pty 在 Windows 上每次 kill 会 fork conpty_console_list_agent.js，而该
 * agent 会往 stderr 打一整段 "AttachConsole failed" 的 Node 崩溃堆栈。这是
 * 已知噪声，不是基准失败；按「块」整段归类，避免堆栈行被误报成意外输出。
 */
export function classifyStderr(stderr) {
  const lines = stderr.split(/\r?\n/)
  const noise = []
  const unexpected = []
  let insideNoiseBlock = false
  for (const line of lines) {
    if (line.trim() === '') {
      if (insideNoiseBlock) {
        noise.push(line)
        continue
      }
      continue
    }
    const blockStart = /conpty_console_list_agent\.js:\d+/.test(line) || /AttachConsole failed/i.test(line)
    if (blockStart) {
      insideNoiseBlock = true
      noise.push(line)
      continue
    }
    if (insideNoiseBlock) {
      const stackFrame = /^\s+at /.test(line) || /^Node\.js v\d/.test(line) || /^var consoleProcessList/.test(line) || /^\s*\^/.test(line)
      if (stackFrame) {
        noise.push(line)
        continue
      }
      insideNoiseBlock = false
    }
    unexpected.push(line)
  }
  return { noise, unexpected, attachConsoleEvents: (stderr.match(/AttachConsole failed/g) ?? []).length }
}

/** 取子进程 stdout 的最后一个非空行并解析为 JSON；失败返回 {error}。 */
export function parseLastJsonLine(stdout) {
  const lines = stdout.split(/\r?\n/).filter(line => line.trim() !== '')
  if (lines.length === 0) return { error: 'empty stdout' }
  const last = lines[lines.length - 1]
  try {
    return { value: JSON.parse(last) }
  } catch (error) {
    return { error: `invalid JSON in stdout: ${error.message}`, raw: last.slice(0, 500) }
  }
}

/** 统一错误对象，便于写进 JSON 并打印。 */
export function toErrorRecord(suite, kind, error, extra = {}) {
  const record = { suite, kind, message: error instanceof Error ? error.message : String(error), ...extra }
  if (error instanceof Error && error.stack !== undefined) record.stack = error.stack
  return record
}
