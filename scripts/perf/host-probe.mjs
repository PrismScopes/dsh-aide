/**
 * 宿主入口探针：在一个全新的 node 进程里 import lib/index.js，把进程内测得的
 * import 耗时以一行 JSON 写到 stdout。
 *
 * 单独成进程的原因：宿主入口会加载 node-pty/ws/chokidar，且以后可能带入更多
 * 原生模块；独立进程既隔离 stderr 噪声，也避免污染主基准进程的模块缓存。
 */
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const target = process.argv[2]
if (target === undefined || target === '') {
  process.stderr.write('usage: node scripts/perf/host-probe.mjs <absolute path to lib/index.js>\n')
  process.exit(2)
}

const started = performance.now()
try {
  const module = await import(pathToFileURL(target).href)
  const importMs = performance.now() - started
  const exportNames = Object.keys(module)
  const payload = {
    ok: true,
    importMs: Math.round(importMs * 100) / 100,
    exportCount: exportNames.length,
    exports: exportNames.slice(0, 20),
    node: process.version,
    platform: process.platform,
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`, () => process.exit(0))
} catch (error) {
  const importMs = performance.now() - started
  const payload = {
    ok: false,
    importMs: Math.round(importMs * 100) / 100,
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`, () => process.exit(1))
}
