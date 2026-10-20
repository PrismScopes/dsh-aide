/**
 * 补全的运行期设置。
 *
 * 两个来源，优先级：**环境变量 > 插件配置 > 默认值**。
 *
 * 为什么要两条路：插件配置是应用里能设的那条（改配置不必重启进程就能重读），环境变量是排查与临时
 * 试验用的那条。两边都缺时保持既有行为 —— 补全用应用的默认模型，模型失败就报错，不悄悄降级。
 */

interface CompletionSettings {
  /** 补全单独使用的模型路由（`provider/model`）；不设则跟随应用默认模型。 */
  route?: { provider: string; model: string }
  /** 模型失败时是否回落本地兜底。默认不回落：故障应当显式暴露。 */
  fallback: boolean
}

export const DEFAULT_COMPLETION_SETTINGS: CompletionSettings = { fallback: false }

let current: CompletionSettings = DEFAULT_COMPLETION_SETTINGS

/** 重读设置文件的间隔：够短，改完几乎立刻生效；够长，不至于每次补全都读盘。 */
const FILE_RECHECK_MS = 2000
let fileCheckedAt = 0
let fileValue: unknown

/** 解析「provider/model」；空值、缺斜杠、任一侧为空串都视为没配。 */
export function parseRoute(raw: string | undefined): { provider: string; model: string } | undefined {
  if (raw === undefined || raw === '') return undefined
  const at = raw.indexOf('/')
  if (at <= 0 || at === raw.length - 1) return undefined
  return { provider: raw.slice(0, at), model: raw.slice(at + 1) }
}

/** 环境变量给出的覆盖；没有则返回空对象。 */
function fromEnvironment(env: Record<string, string | undefined>): Partial<CompletionSettings> {
  const override: Partial<CompletionSettings> = {}
  const route = parseRoute(env['DSH_COMPLETION_ROUTE'])
  if (route !== undefined) override.route = route
  if ((env['DSH_COMPLETION_FALLBACK'] ?? '').toLowerCase() === 'local') override.fallback = true
  return override
}

/** 插件配置给出的设置；字段缺失或不合法就当作没设。 */
export function fromConfig(config: unknown): Partial<CompletionSettings> {
  if (typeof config !== 'object' || config === null) return {}
  const record = config as Record<string, unknown>
  const completion = typeof record['completion'] === 'object' && record['completion'] !== null
    ? (record['completion'] as Record<string, unknown>)
    : record
  const settings: Partial<CompletionSettings> = {}
  const route = parseRoute(typeof completion['route'] === 'string' ? completion['route'] : undefined)
  if (route !== undefined) settings.route = route
  if (completion['fallback'] === true) settings.fallback = true
  if (completion['fallback'] === false) settings.fallback = false
  return settings
}

/** 生效的设置：默认值 + 插件配置 + 设置文件 + 环境变量。 */
export function resolveSettings(config?: unknown, env: Record<string, string | undefined> = globalThis.process?.env ?? {}, file?: unknown): CompletionSettings {
  return { ...DEFAULT_COMPLETION_SETTINGS, ...fromConfig(config), ...fromConfig(file), ...fromEnvironment(env) }
}

/**
 * 从数据目录读设置文件。
 *
 * 为什么需要它：当前 DSH 版本里，bundle patch 的 `config` 送不到插件的 `apply`（同类插件的配置同样
 * 送不到，实测过）。而桌面端应用不方便设环境变量，所以留一个用户可编辑、又不动配置档的入口：
 * `%DSH_HOME%/completion.settings.json`，形如 `{ "completion": { "route": "provider/model", "fallback": true } }`。
 * 文件不存在、不是 JSON、字段不合法，一律当作没设 —— 绝不因为一个写错的文件让补全整体失效。
 */
export function readSettingsFile(path: string, readFile: (path: string) => string = defaultReadFile): unknown {
  try {
    return JSON.parse(readFile(path))
  } catch {
    return undefined
  }
}

/**
 * `node:fs` 的最小面。
 *
 * 动态取用而不是 `import 'node:fs'`：本模块被宿主与测试共用，但设置文件属于宿主侧实现，
 * 静态引入会让浏览器侧打包把它一起带进来。取不到（非 Node 环境）时按「没有文件系统」处理。
 */
interface NodeFsSubset {
  readFileSync?(path: string, encoding: 'utf8'): string
  writeFileSync?(path: string, data: string, encoding: 'utf8'): void
  mkdirSync?(path: string, options: { recursive: boolean }): void
  renameSync?(from: string, to: string): void
}

function nodeFs(): NodeFsSubset | undefined {
  const load = (globalThis.process as unknown as { getBuiltinModule?: (name: string) => NodeFsSubset } | undefined)?.getBuiltinModule
  return load?.('node:fs')
}

function defaultReadFile(path: string): string {
  const fs = nodeFs()
  if (fs?.readFileSync === undefined) throw new Error('readFileSync unavailable')
  return fs.readFileSync(path, 'utf8')
}

/** 设置文件的位置：数据目录下固定名字。数据目录未知时返回 undefined。 */
/**
 * 补全诊断日志的路径：与设置文件同级（%DSH_HOME% 下），便于在应用侧排查「没有补全」类问题。
 *
 * 记录请求是否到达、用的是模型还是本地兜底、以及失败原因 —— 这三件事决定了问题出在客户端、
 * 选路还是模型调用。日志只用于排查，不参与任何决策。
 */
export function diagnosticLogPath(env: Record<string, string | undefined> = globalThis.process?.env ?? {}): string | undefined {
  return settingsFilePath(env)?.replace(/completion\.settings\.json$/, 'completion.log')
}

export function settingsFilePath(env: Record<string, string | undefined> = globalThis.process?.env ?? {}): string | undefined {
  const home = env['DSH_HOME']
  if (home === undefined || home === '') return undefined
  const neat = home.replace(/[\\/]+$/, '').replaceAll('\\', '/')
  return `${neat}/completion.settings.json`
}

let pluginConfig: unknown

/** 插件加载时写入一次；同时在每次取用时按周期重读设置文件。 */
export function setCompletionSettings(config?: unknown): CompletionSettings {
  pluginConfig = config
  return refreshSettings()
}

/**
 * 取当前生效的设置。
 *
 * 设置文件按 `FILE_RECHECK_MS` 的周期重读：用户在编辑器旁边改完 JSON，几秒内生效，不必重启应用。
 * 读盘失败或内容不合法都退回「当作没设」，不影响已有设置。
 */
export function completionSettings(now: number = Date.now()): CompletionSettings {
  if (now - fileCheckedAt >= FILE_RECHECK_MS) refreshSettings(now)
  return current
}

function refreshSettings(now: number = Date.now()): CompletionSettings {
  const env = globalThis.process?.env ?? {}
  const path = settingsFilePath(env)
  if (path !== undefined) fileValue = readSettingsFile(path)
  fileCheckedAt = now
  current = resolveSettings(pluginConfig, env, fileValue)
  return current
}

/** 供测试与排查：把设置还原成默认值。 */
export function resetCompletionSettings(): void {
  current = DEFAULT_COMPLETION_SETTINGS
  pluginConfig = undefined
  fileValue = undefined
  fileCheckedAt = 0
}

/* ────────────────────────────── 设置页的读写面 ────────────────────────────── */

/** 某一项最终由谁给出。顺序即优先级：环境变量 > 设置文件 > 插件配置 > 默认值。 */
type SettingsSource = 'env' | 'file' | 'config' | 'default'

export interface CompletionSettingsView {
  /** 生效的模型路由（`provider/model`）；null 表示跟随应用的默认模型。 */
  route: string | null
  fallback: boolean
  routeSource: SettingsSource
  fallbackSource: SettingsSource
  /** 设置文件路径。数据目录未知时缺省 —— 那种部署里改不动，设置页会提示只读。 */
  file?: string
  /** 环境变量给出的路由；非空说明它会压过设置页里的值。 */
  envRoute: string | null
}

/** 设置页提交的改动。字段缺省表示「这一项不改」。 */
export interface CompletionSettingsPatch {
  /** `provider/model`；null 或空串表示清除，回到跟随应用默认模型。 */
  route?: string | null
  fallback?: boolean
}

/**
 * 写设置时的问题。
 *
 * 单独一个类型是为了让 HTTP 路由能把它映射成 400（用户输入问题）而不是 500（宿主故障）：
 * 路由写错格式与文件写不进去，是两件该给用户不同提示的事。
 */
export class SettingsWriteError extends Error {}

const processEnv = (): Record<string, string | undefined> => globalThis.process?.env ?? {}

function routeSource(env: Record<string, string | undefined>): SettingsSource {
  if (parseRoute(env['DSH_COMPLETION_ROUTE']) !== undefined) return 'env'
  if (fromConfig(fileValue).route !== undefined) return 'file'
  if (fromConfig(pluginConfig).route !== undefined) return 'config'
  return 'default'
}

function fallbackSource(env: Record<string, string | undefined>): SettingsSource {
  if ((env['DSH_COMPLETION_FALLBACK'] ?? '').toLowerCase() === 'local') return 'env'
  if (typeof fromConfig(fileValue).fallback === 'boolean') return 'file'
  if (typeof fromConfig(pluginConfig).fallback === 'boolean') return 'config'
  return 'default'
}

/** 用当前内存里的设置算视图，不读盘 —— 写入之后走这条，免得再读一次刚写的文件。 */
function settingsViewOf(env: Record<string, string | undefined>): CompletionSettingsView {
  const path = settingsFilePath(env)
  return {
    route: current.route === undefined ? null : `${current.route.provider}/${current.route.model}`,
    fallback: current.fallback,
    routeSource: routeSource(env),
    fallbackSource: fallbackSource(env),
    ...(path === undefined ? {} : { file: path }),
    envRoute: env['DSH_COMPLETION_ROUTE'] ?? null,
  }
}

/** 设置页打开时读一次：立刻重读设置文件，不等两秒的重读周期。 */
export function completionSettingsView(env: Record<string, string | undefined> = processEnv()): CompletionSettingsView {
  refreshSettings()
  return settingsViewOf(env)
}

/** 设置文件的读写出口；测试用内存实现替换，避免碰真实数据目录。 */
export interface SettingsFileIo { read(path: string): unknown; write(path: string, value: unknown): void }

/** 原子写：先写临时文件再改名，中途断电也不会留下半份 JSON。 */
function systemSettingsIo(): SettingsFileIo {
  const fs = nodeFs()
  return {
    read: path => {
      try { return JSON.parse(defaultReadFile(path)) } catch { return undefined }
    },
    write: (path, value) => {
      if (fs?.writeFileSync === undefined || fs.renameSync === undefined) throw new SettingsWriteError('宿主文件系统不可用，无法保存补全设置')
      const separator = path.lastIndexOf('/')
      if (separator > 0) fs.mkdirSync?.(path.slice(0, separator), { recursive: true })
      const temporary = `${path}.tmp`
      fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      fs.renameSync(temporary, path)
    },
  }
}

/**
 * 把设置文件归一成 `{ completion: { route, fallback } }` 这一种形状。
 *
 * 早前的文件可能是平铺的 `{ route, fallback }`（`fromConfig` 两种都认）。写的时候统一收进
 * `completion` 下面，否则一旦出现 `completion` 字段，平铺的旧值就会被 `fromConfig` 忽略而静默失效。
 */
function takeSettingsBucket(root: Record<string, unknown>): Record<string, unknown> {
  const existing = root['completion']
  if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
    return { ...(existing as Record<string, unknown>) }
  }
  const nested: Record<string, unknown> = {}
  for (const key of ['route', 'fallback']) {
    if (key in root) { nested[key] = root[key]; delete root[key] }
  }
  return nested
}

/**
 * 写入补全设置并立刻生效。
 *
 * 为什么写文件而不是只改内存：模型路由与兜底开关由宿主执行，进程重启后必须还在；而这个文件正是
 * 本插件既有的设置入口（设置页只是把它从「手改 JSON」变成可点的控件）。写完立刻重算一次，
 * 用户不必等两秒的重读周期，更不必重启应用。
 */
export function updateCompletionSettings(patch: CompletionSettingsPatch, env: Record<string, string | undefined> = processEnv(), io: SettingsFileIo = systemSettingsIo()): CompletionSettingsView {
  const path = settingsFilePath(env)
  if (path === undefined) throw new SettingsWriteError('数据目录未知（未设置 DSH_HOME），无法保存补全设置')
  const stored = io.read(path)
  const root = typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? { ...(stored as Record<string, unknown>) } : {}
  const nested = takeSettingsBucket(root)
  if (patch.route !== undefined) {
    const raw = (patch.route ?? '').trim()
    if (raw === '') delete nested['route']
    else {
      const route = parseRoute(raw)
      if (route === undefined) throw new SettingsWriteError('模型路由要写成 provider/model，例如 our-free-model/mimo-v2.6-flash-free')
      nested['route'] = `${route.provider}/${route.model}`
    }
  }
  if (patch.fallback !== undefined) nested['fallback'] = patch.fallback
  const next: Record<string, unknown> = { ...root, completion: nested }
  // 两项都清掉时不留一个空对象：文件回到「什么都没设」的样子。
  if (Object.keys(nested).length === 0) delete next['completion']
  io.write(path, next)
  fileValue = next
  fileCheckedAt = Date.now()
  current = resolveSettings(pluginConfig, env, fileValue)
  return settingsViewOf(env)
}
