/**
 * dsh-aide 性能基准入口。
 *
 * 用法：
 *   node scripts/perf/index.mjs                 # 跑全部（pty + bundle + host）
 *   node scripts/perf/index.mjs --only=pty
 *   node scripts/perf/index.mjs --only=bundle,host
 *   node scripts/perf/index.mjs --rounds=10
 *   node scripts/perf/index.mjs --conpty-dll-control   # 额外跑一次已知异常的对照
 *   node scripts/perf/index.mjs --out=path/to/result.json
 *
 * 退出码：0 全部成功；1 有失败样本/套件（错误原因打印到 stderr，同时仍写出
 * 已采集到的 JSON）；2 命令行参数错误。
 */
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { availableParallelism, cpus, freemem, release, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBundleSuite } from './bundle.mjs'
import { runHostSuite } from './host.mjs'
import {
  classifyStderr,
  ensureParent,
  formatTiming,
  parseLastJsonLine,
  renderTable,
  round,
  runCommand,
  toErrorRecord,
} from './util.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const DEFAULT_OUT = process.env.DVW_PERF_OUT ?? 'perf-results/baseline.json'
const ALL_SUITES = ['pty', 'prewarm', 'bundle', 'host']
const DEFAULT_ROUNDS = 5

function usage() {
  return [
    'usage: node scripts/perf/index.mjs [options]',
    '',
    'options:',
    '  --only=pty|prewarm|bundle|host  只跑指定套件，可用逗号组合（默认全部）',
    '  --rounds=N               每个指标的有效样本数（默认 5）',
    '  --conpty-dll-control     额外跑一次 useConptyDll:true 对照（已知异常，默认关闭）',
    '  --out=PATH               结果 JSON 路径（默认 ' + DEFAULT_OUT + '）',
    '  --help                   显示本帮助',
    '',
    '产物目录不存在时会自动创建；仓库内只保留 scripts/perf/ 下的脚本。',
  ].join('\n')
}

function parseArguments(argv) {
  const options = {
    only: [...ALL_SUITES],
    rounds: DEFAULT_ROUNDS,
    conptyDllControl: false,
    out: DEFAULT_OUT,
    help: false,
  }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg.startsWith('--only=')) {
      const requested = arg.slice('--only='.length).split(',').map(item => item.trim()).filter(Boolean)
      if (requested.length === 0) throw new Error('--only 不能为空')
      for (const suite of requested) {
        if (!ALL_SUITES.includes(suite)) throw new Error(`未知套件: ${suite}（可选 ${ALL_SUITES.join('|')}）`)
      }
      options.only = [...new Set(requested)]
    } else if (arg.startsWith('--rounds=')) {
      const rounds = Number.parseInt(arg.slice('--rounds='.length), 10)
      if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw new Error(`--rounds 必须是 1..100 的整数: ${arg}`)
      options.rounds = rounds
    } else if (arg === '--conpty-dll-control') {
      options.conptyDllControl = true
    } else if (arg.startsWith('--out=')) {
      const out = arg.slice('--out='.length)
      if (out.trim() === '') throw new Error('--out 不能为空')
      options.out = out
    } else {
      throw new Error(`未知参数: ${arg}`)
    }
  }
  options.out = resolve(options.out)
  return options
}

async function readRepoMeta() {
  const meta = { root: REPO_ROOT, name: null, version: null, head: null, branch: null }
  try {
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'))
    meta.name = pkg.name ?? null
    meta.version = pkg.version ?? null
  } catch {
    /* package.json 读取失败不阻断基准；JSON 里保留 null */
  }
  const git = args => {
    try {
      return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 5000, windowsHide: true }).trim()
    } catch {
      return null
    }
  }
  meta.head = git(['rev-parse', '--short', 'HEAD'])
  meta.branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  return meta
}

function runtimeMeta() {
  return {
    node: process.version,
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpu: cpus()[0]?.model ?? null,
    logicalCpus: availableParallelism?.() ?? null,
    totalMemBytes: totalmem(),
    freeMemBytesAtStart: freemem(),
  }
}

/**
 * 通用「子进程套件」运行器：pty / prewarm 这类会起真 shell 的套件都放进子进程，
 * 把 node-pty 的 stderr 噪声与 pty 句柄隔离在子进程里（父进程只解析最后一行 JSON）。
 */
async function runNodeSuiteIsolated({ suite, script, nodeArgs = [], args = [], rounds, timeoutMs = 600_000 }) {
  const run = await runCommand(process.execPath, [...nodeArgs, script, `--rounds=${rounds}`, ...args], { cwd: REPO_ROOT, timeoutMs })
  const stderr = classifyStderr(run.stderr)
  const parsed = parseLastJsonLine(run.stdout)
  const errors = []

  if (run.spawnError) errors.push(toErrorRecord(suite, 'child-spawn-failed', run.spawnError))
  if (run.timedOut) errors.push(toErrorRecord(suite, 'child-timeout', new Error(`${suite} 子进程超时未退出`)))
  if (parsed.error !== undefined) errors.push(toErrorRecord(suite, 'child-protocol-error', new Error(parsed.error), { raw: parsed.raw, stderr: stderr.unexpected.slice(0, 20) }))

  const data = parsed.value ?? { suite, errors: [], warnings: [] }
  if (Array.isArray(data.errors)) errors.push(...data.errors)
  if (run.code !== 0 && errors.length === 0) {
    errors.push(toErrorRecord(suite, 'child-exit', new Error(`${suite} 子进程退出码 ${run.code}`), { signal: run.signal }))
  }
  for (const line of stderr.unexpected) {
    data.warnings = data.warnings ?? []
    data.warnings.push({ kind: 'stderr-unexpected', line })
  }

  return {
    data: {
      ...data,
      child: {
        exitCode: run.code,
        signal: run.signal,
        timedOut: run.timedOut,
        wallMs: run.wallMs,
        stdoutBytes: Buffer.byteLength(run.stdout),
        stderrNoiseLines: stderr.noise.length,
        stderrNoiseEvents: stderr.attachConsoleEvents,
        stderrUnexpectedLines: stderr.unexpected.length,
      },
      stderr: {
        note: 'node-pty 的 console list agent 可能打印 "AttachConsole failed"；已归入 stderrNoiseLines，不作为失败。',
        noiseSample: stderr.noise.slice(0, 3),
      },
    },
    errors,
    warnings: data.warnings ?? [],
  }
}

/** pty 套件：三种 shell 的 spawn / 首字节 / shell-ready。 */
function runPtySuiteIsolated({ rounds, conptyDllControl }) {
  return runNodeSuiteIsolated({ suite: 'pty', script: join(HERE, 'pty.mjs'), args: conptyDllControl ? ['--conpty-dll-control'] : [], rounds })
}

/**
 * 预热套件：真机起 TerminalManager 预热 shell，量「预热就绪 / 认领 / 不预热干等」。
 * src/terminal.ts 有 TS 参数属性，需要 Node 的 transform-types 模式。
 */
async function runPrewarmSuiteIsolated({ rounds }) {
  const result = await runNodeSuiteIsolated({ suite: 'prewarm', script: join(HERE, 'prewarm.mjs'), nodeArgs: ['--experimental-transform-types', '--no-warnings'], rounds })
  for (const failure of result.data.failures ?? []) result.errors.push(toErrorRecord('prewarm', 'sample-failure', new Error(JSON.stringify(failure))))
  return result
}

async function runSuite(name, options) {
  if (name === 'pty') return runPtySuiteIsolated(options)
  if (name === 'prewarm') return runPrewarmSuiteIsolated(options)
  if (name === 'bundle') {
    const data = await runBundleSuite({ repoRoot: REPO_ROOT, rounds: options.rounds })
    return { data, errors: data.errors, warnings: data.warnings }
  }
  if (name === 'host') {
    const data = await runHostSuite({ repoRoot: REPO_ROOT, rounds: options.rounds })
    return { data, errors: data.errors, warnings: data.warnings }
  }
  throw new Error(`unknown suite: ${name}`)
}

function printHeader(results, options) {
  const repo = results.repo
  console.log('')
  console.log('dsh-aide · perf baseline')
  console.log(`  repo      ${repo.name ?? '?'}@${repo.version ?? '?'}  ${repo.branch ?? '?'}@${repo.head ?? '?'}`)
  console.log(`  runtime   node ${results.runtime.node}  ${results.runtime.platform}/${results.runtime.arch}  cpu=${results.runtime.cpu ?? '?'}`)
  console.log(`  options   rounds=${options.rounds}  only=${options.only.join(',')}  conptyDllControl=${options.conptyDllControl ? 'on' : 'off'}`)
  console.log(`  output    ${results.options.out}`)
}

function printPty(pty) {
  console.log('\n[pty] terminal startup · node-pty · warmup 1 次不计入统计')
  if (pty === undefined || pty === null) {
    console.log('  (skipped)')
    return
  }
  const rows = (pty.shells ?? []).map(shell => {
    const successful = shell.stats?.spawn?.n ?? 0
    return [
      `${shell.id} (${shell.label})`,
      formatTiming(shell.stats?.spawn),
      formatTiming(shell.stats?.firstByte),
      formatTiming(shell.stats?.shellReady),
      `${successful}/${shell.failures?.length ?? 0}`,
    ]
  })
  if (rows.length > 0) {
    console.log(renderTable(['shell', 'spawn ms mean(min-max)', 'first byte ms mean(min-max)', 'shell-ready ms mean(min-max)', 'ok/fail'], rows))
  }
  for (const missing of pty.missingShells ?? []) {
    console.log(`  MISSING ${missing.id}: ${missing.reason}`)
  }
  console.log('  shell-ready = spawn 后立即写入 `echo <唯一 marker>`，直到输出行首出现 marker；包含 shell 启动与 profile 加载。')
  const control = pty.controls?.useConptyDll
  if (control !== null && control !== undefined) {
    const detail = control.timedOut
      ? `timed out after ${control.timeoutMs ?? '?'} ms`
      : control.ok
        ? `marker occurrences=${control.markerOccurrences}`
        : (control.error ?? 'failed')
    const observation = control.anomalyObserved ? `ANOMALY observed（${detail}）` : `no anomaly（ready ${control.shellReadyMs ?? '-'} ms, marker occurrences=${control.markerOccurrences ?? '-'}）`
    console.log(`  control useConptyDll=true: ${observation}`)
    console.log(`    known issue: ${control.knownIssue}`)
  }
}

function printFiles(files) {
  const rows = Object.values(files ?? {}).map(file => [
    file.file,
    file.bytes,
    round(file.bytes / 1024, 1),
    round(file.gzip.bytes / 1024, 1),
    round(file.brotli.bytes / 1024, 1),
    file.sha256.slice(0, 12),
  ])
  if (rows.length > 0) {
    console.log(renderTable(['file', 'bytes', 'KiB', 'gzip KiB', 'brotli KiB', 'sha256'], rows))
  }
}

function printSourcemap(sourcemap, limit = 10) {
  if (sourcemap === undefined || sourcemap === null) return
  const rows = sourcemap.topPackages.slice(0, limit).map((entry, index) => [
    index + 1,
    entry.package,
    round(entry.bytes / 1024, 1),
    `${round(entry.share * 100, 1)}%`,
    entry.files,
  ])
  if (rows.length === 0) return
  console.log(`\n[bundle] sourcemap packages · ${sourcemap.file} · sources=${sourcemap.sourceCount} · ${round(sourcemap.totalSourceBytes / 1024 / 1024, 2)} MiB`)
  console.log(renderTable(['#', 'package', 'source KiB', 'share', 'files'], rows))
}

function printBundle(bundle) {
  console.log('\n[bundle] client bundle')
  if (bundle === undefined || bundle === null) {
    console.log('  (skipped)')
    return
  }
  printFiles(bundle.files)
  if (bundle.compile !== null && bundle.compile !== undefined) {
    const compile = bundle.compile
    console.log(
      `  new Function(${compile.target}, ${round(compile.sourceBytes / 1024 / 1024, 2)} MiB): ` +
        `cold ${compile.coldMs} ms; warm mean ${compile.stats.mean} ms ` +
        `(min ${compile.stats.min}, max ${compile.stats.max}, n=${compile.stats.n})`,
    )
  }
  printSourcemap(bundle.sourcemaps?.client)
  printSourcemap(bundle.sourcemaps?.index)
}

function printPrewarm(prewarm) {
  console.log('\n[prewarm] terminal prewarm · 真机 shell · 预热由面板打开/悬停触发，create 认领')
  if (prewarm === undefined || prewarm === null) {
    console.log('  (skipped)')
    return
  }
  const rows = [
    ['warm ready（shell 自己启动，被空档吸收）', formatTiming(prewarm.warmReadyMs), 'ms'],
    ['create adopt（用户点新建后宿主侧等待）', formatTiming(prewarm.adoptMs), 'ms'],
    ['cold ready（不预热时点新建到提示符）', formatTiming(prewarm.coldReadyMs), 'ms'],
    ['saved vs cold（adopt 相对冷启动）', prewarm.savedMs === null ? '-' : `${prewarm.savedMs} ms`, ''],
  ]
  console.log(renderTable(['metric', 'mean(min-max)', ''], rows))
  if ((prewarm.failures ?? []).length > 0) {
    console.log(`  FAILURES: ${JSON.stringify(prewarm.failures.slice(0, 5))}`)
  }
  console.log('  说明：warm ready 是 shell 自身启动成本；adopt 是用户点新建后真正要等的时间；差值即预热收益。')
}

function printHost(host) {
  console.log('\n[host] lib/index.js isolated import · 每个样本独立 node 子进程 · warmup 1 次')
  if (host === undefined || host === null) {
    console.log('  (skipped)')
    return
  }
  const rows = [['lib/index.js', formatTiming(host.stats?.wall), formatTiming(host.stats?.import), host.stats?.import?.n ?? 0, host.failedRuns?.length ?? 0]]
  console.log(renderTable(['target', 'wall ms mean(min-max)', 'import ms mean(min-max)', 'ok', 'fail'], rows))
  if (host.fallback?.degraded) {
    console.log(`  DEGRADED: ${host.fallback.note} size=${host.fallback.sizeBytes} bytes`)
  }
}

function printDiagnostics(results) {
  const warnings = results.warnings ?? []
  if (warnings.length > 0) {
    console.log(`\n[warnings] ${warnings.length} 条（不阻断基准）`)
    for (const warning of warnings.slice(0, 10)) console.log(`  - ${JSON.stringify(warning)}`)
    if (warnings.length > 10) console.log(`  ... 另有 ${warnings.length - 10} 条，见 JSON warnings`)
  }
  const errors = results.errors ?? []
  if (errors.length > 0) {
    console.error(`\n[FAILED] ${errors.length} 个失败样本/套件（退出码 1）`)
    for (const error of errors.slice(0, 20)) {
      const location = [error.suite, error.kind].filter(Boolean).join('/')
      console.error(`  - ${location}: ${error.message}`)
      if (error.stderrUnexpected?.length) console.error(`    stderr: ${JSON.stringify(error.stderrUnexpected.slice(0, 5))}`)
    }
    if (errors.length > 20) console.error(`  ... 另有 ${errors.length - 20} 条，见 JSON errors`)
  } else {
    console.log('\nOK: 所有套件完成，无失败样本。')
  }
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    console.error(`[perf] ${error.message}\n`)
    console.error(usage())
    process.exit(2)
  }
  if (options.help) {
    console.log(usage())
    process.exit(0)
  }

  const startedAt = new Date().toISOString()
  const results = {
    schemaVersion: 1,
    tool: 'dsh-aide-perf',
    generatedAt: startedAt,
    repo: await readRepoMeta(),
    runtime: runtimeMeta(),
    options: {
      only: options.only,
      rounds: options.rounds,
      conptyDllControl: options.conptyDllControl,
      out: options.out,
    },
    errors: [],
    warnings: [],
  }

  for (const suite of options.only) {
    try {
      const suiteResult = await runSuite(suite, options)
      results[suite] = suiteResult.data
      results.errors.push(...(suiteResult.errors ?? []))
      results.warnings.push(...(suiteResult.warnings ?? []))
    } catch (error) {
      results.errors.push(toErrorRecord(suite, 'suite-crash', error))
      results[suite] = { suite, error: error instanceof Error ? error.message : String(error), errors: results.errors }
    }
  }

  results.finishedAt = new Date().toISOString()
  results.noise = {
    attachConsoleFailedEvents: (results.pty?.child?.stderrNoiseEvents ?? 0) + (results.host?.noise?.attachConsoleFailedEvents ?? 0),
    note: 'node-pty 每次 kill 会 fork conpty_console_list_agent.js，该 agent 的 "AttachConsole failed" 崩溃堆栈属于已知噪声，已从意外 stderr 中剔除，不参与失败判定。',
  }
  results.notes = [
    'pty: shell-ready 在 spawn 后立即写入 `echo <唯一 marker>`，等待输出行首出现 marker；包含 shell 自身启动与 PowerShell profile 加载（未加 -NoProfile，与工作台行为一致）。',
    'pty: 每个 shell 先跑 1 次热身，不计入统计；useConptyDll:true 为已知异常对照项，默认不启用。',
    'pty: node-pty 的 "AttachConsole failed" 属于 console list agent 噪声，已由父进程归类，不作为失败。',
    'bundle: new Function 重复编译相同源码会命中 V8 编译缓存，正式样本每轮在源码尾部追加唯一注释。',
    'bundle: sourcemap 体积按 sourcesContent 的 UTF-8 字节聚合，不等于该包在最终 bundle 中的精确字节占比。',
    'host: 每个样本独立 node 进程；importMs 在子进程内测量，wall 包含 node 启动。',
    'prewarm: warm ready = 预热 shell 自己吐出提示符的耗时；adopt = create() 认领预热 shell（用户点新建后真正要等的时间）；cold ready = 不预热时 create 到提示符。',
  ]

  try {
    await ensureParent(options.out)
    await writeFile(options.out, `${JSON.stringify(results, null, 2)}\n`, 'utf8')
  } catch (error) {
    console.error(`[perf] 无法写出结果 JSON（${options.out}）: ${error instanceof Error ? error.stack : String(error)}`)
    process.exit(1)
  }

  printHeader(results, options)
  if (results.pty !== undefined) printPty(results.pty)
  if (results.prewarm !== undefined) printPrewarm(results.prewarm)
  if (results.bundle !== undefined) printBundle(results.bundle)
  if (results.host !== undefined) printHost(results.host)
  printDiagnostics(results)

  process.exit(results.errors.length > 0 ? 1 : 0)
}

main(process.argv.slice(2)).catch(error => {
  console.error(`[perf] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exit(1)
})
