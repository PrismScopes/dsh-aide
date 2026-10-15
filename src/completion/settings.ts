/**
 * 补全的运行期设置。
 *
 * 两个来源，优先级：**环境变量 > 插件配置 > 默认值**。
 *
 * 为什么要两条路：插件配置是应用里能设的那条（改配置不必重启进程就能重读），环境变量是排查与临时
 * 试验用的那条。两边都缺时保持既有行为 —— 补全用应用的默认模型，模型失败就报错，不悄悄降级。
 */

export interface CompletionSettings {
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

function defaultReadFile(path: string): string {
  // 动态取用，避免把 node:fs 带进浏览器侧的打包。
  const load = (globalThis.process as unknown as { getBuiltinModule?: (name: string) => { readFileSync?: (path: string, encoding: string) => string } } | undefined)?.getBuiltinModule
  const fs = load?.('node:fs')
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
