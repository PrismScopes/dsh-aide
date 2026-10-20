/**
 * 客户端包基准：
 *   1. lib/*.js 与 *.map 的原始体积、gzip/brotli 体积、sha256
 *   2. Node 端 new Function(client.js) 的编译耗时（近似浏览器/WASM 之外
 *      的解析+编译成本）
 *   3. sourcemap 里 sourcesContent 的按包聚合体积（top N）
 *
 * 说明：重复编译完全相同的源码会被 V8 的编译缓存命中（实测从 ~38ms 掉到 ~2ms），
 * 因此正式样本在源码尾部追加一条唯一注释，确保每轮都是真正的解析+编译。
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib'
import { round, stats, toErrorRecord } from './util.mjs'

const TARGET_FILES = ['lib/client.js', 'lib/client.js.map', 'lib/index.js', 'lib/index.js.map']
const TOP_PACKAGES = 15

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function compressMetrics(buffer) {
  const gzipStarted = performance.now()
  const gzip = gzipSync(buffer, { level: 9 })
  const gzipMs = performance.now() - gzipStarted

  const brotliStarted = performance.now()
  const brotli = brotliCompressSync(buffer, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } })
  const brotliMs = performance.now() - brotliStarted

  return {
    gzip: { bytes: gzip.length, ratio: round(gzip.length / buffer.length, 4), ms: round(gzipMs) },
    brotli: { bytes: brotli.length, ratio: round(brotli.length / buffer.length, 4), ms: round(brotliMs) },
  }
}

/**
 * 从 sourcemap 的 source 路径推断「包」：
 *   ../node_modules/.pnpm/@xterm+xterm@5.5.0/node_modules/@xterm/xterm/lib/xterm.js
 *     → @xterm/xterm@5.5.0
 *   ../src/client/xxx.ts → workspace:src/client
 *   ../src/host.ts       → workspace:src
 */
export function packageOfSource(source) {
  const lastNodeModules = source.lastIndexOf('/node_modules/')
  if (lastNodeModules >= 0) {
    const rest = source.slice(lastNodeModules + '/node_modules/'.length)
    const parts = rest.split('/')
    const packageName = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
    const pnpmMarker = 'node_modules/.pnpm/'
    const pnpmIndex = source.indexOf(pnpmMarker)
    let version = ''
    if (pnpmIndex >= 0) {
      const encoded = source.slice(pnpmIndex + pnpmMarker.length).split('/')[0]
      const at = encoded.lastIndexOf('@')
      if (at > 0) version = encoded.slice(at + 1)
    }
    return version === '' ? packageName : `${packageName}@${version}`
  }
  if (source.startsWith('../src/')) {
    const rest = source.slice('../src/'.length)
    return rest.startsWith('client/') ? 'workspace:src/client' : 'workspace:src'
  }
  return 'external'
}

/** 按 packageOfSource 聚合 sourcesContent 的 UTF-8 字节数。 */
function aggregateSourcemap(map) {
  const packages = new Map()
  const topSources = []
  let totalSourceBytes = 0
  map.sources.forEach((source, index) => {
    const content = map.sourcesContent?.[index] ?? ''
    const bytes = Buffer.byteLength(content)
    totalSourceBytes += bytes
    const key = packageOfSource(source)
    const entry = packages.get(key) ?? { package: key, bytes: 0, files: 0 }
    entry.bytes += bytes
    entry.files += 1
    packages.set(key, entry)
    topSources.push({ source, package: key, bytes })
  })
  const packageList = [...packages.values()]
    .map(entry => ({ ...entry, share: totalSourceBytes === 0 ? 0 : round(entry.bytes / totalSourceBytes, 4) }))
    .sort((left, right) => right.bytes - left.bytes)
  topSources.sort((left, right) => right.bytes - left.bytes)
  return {
    sourceCount: map.sources.length,
    sourcesWithContent: map.sourcesContent?.length ?? 0,
    totalSourceBytes,
    packages: packageList,
    topPackages: packageList.slice(0, TOP_PACKAGES),
    topSources: topSources.slice(0, TOP_PACKAGES),
    firstPartyBytes: packageList
      .filter(entry => entry.package.startsWith('workspace:'))
      .reduce((sum, entry) => sum + entry.bytes, 0),
  }
}

async function measureFile(repoRoot, relativePath) {
  const absolutePath = join(repoRoot, relativePath)
  const buffer = await readFile(absolutePath)
  const compression = compressMetrics(buffer)
  return {
    file: relativePath,
    bytes: buffer.length,
    sha256: sha256(buffer),
    ...compression,
    buffer,
  }
}

/**
 * new Function 编译耗时。coldMs 是第一次、未经任何缓存时的完整编译；
 * warmSamples 每轮追加唯一注释，避免 V8 对相同源码命中编译缓存。
 */
export function measureCompile(source, rounds) {
  const coldStarted = performance.now()
  new Function(source)
  const coldMs = performance.now() - coldStarted

  const samples = []
  for (let index = 0; index < rounds; index += 1) {
    // 唯一注释让每轮的源码字符串不同，绕过 V8 的 compilation cache。
    const uniqueSource = `${source}\n// perf-compile-round-${index}-${process.pid}-${Date.now()}`
    const started = performance.now()
    new Function(uniqueSource)
    samples.push(performance.now() - started)
  }

  return {
    coldMs: round(coldMs),
    samples: samples.map(value => round(value)),
    stats: stats(samples),
    note: '重复编译相同源码会被 V8 编译缓存命中，故每轮追加唯一注释后计时；编译结果不执行。',
  }
}

/**
 * @param {{repoRoot: string, rounds: number}} options
 */
export async function runBundleSuite({ repoRoot, rounds }) {
  const errors = []
  const warnings = []
  const files = {}

  for (const relativePath of TARGET_FILES) {
    try {
      const metrics = await measureFile(repoRoot, relativePath)
      delete metrics.buffer
      files[relativePath] = metrics
    } catch (error) {
      errors.push(toErrorRecord('bundle', 'file-read-failed', error, { file: relativePath }))
    }
  }

  let compile = null
  try {
    const clientSource = await readFile(join(repoRoot, 'lib/client.js'), 'utf8')
    compile = {
      target: 'lib/client.js',
      sourceBytes: Buffer.byteLength(clientSource),
      ...measureCompile(clientSource, rounds),
    }
  } catch (error) {
    errors.push(toErrorRecord('bundle', 'compile-measure-failed', error, { file: 'lib/client.js' }))
  }

  const sourcemaps = {}
  for (const mapFile of ['lib/client.js.map', 'lib/index.js.map']) {
    try {
      const raw = await readFile(join(repoRoot, mapFile), 'utf8')
      const parseStarted = performance.now()
      const map = JSON.parse(raw)
      const parseMs = performance.now() - parseStarted
      sourcemaps[mapFile.replace('lib/', '').replace('.js.map', '')] = {
        file: mapFile,
        mapBytes: Buffer.byteLength(raw),
        parseMs: round(parseMs),
        ...aggregateSourcemap(map),
      }
    } catch (error) {
      errors.push(toErrorRecord('bundle', 'sourcemap-failed', error, { file: mapFile }))
    }
  }

  const totalBundleBytes = ['lib/client.js', 'lib/index.js'].reduce((sum, file) => sum + (files[file]?.bytes ?? 0), 0)

  return {
    suite: 'bundle',
    meta: {
      repoRoot,
      rounds,
      topPackages: TOP_PACKAGES,
      node: process.version,
      note: 'sourcemap 体积按 sourcesContent 的 UTF-8 字节聚合，表示各包的源码负载，不等于其在最终 bundle 中的精确占比。',
    },
    files,
    totalBundleBytes,
    compile,
    sourcemaps,
    errors,
    warnings,
  }
}
