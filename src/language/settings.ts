/**
 * 语言服务的运行期设置。
 *
 * 优先级与环境变量一致：**环境变量 > 设置文件 > 插件配置 > 默认值**。
 * 与补全设置（completion/settings.ts）同样的理由分出两条路：插件配置是应用里能设的那条，
 * 环境变量是排查与临时试验用的那条，设置文件是桌面端不重启应用也能改的那条。
 *
 * 设置文件固定为 `%DSH_HOME%/language.settings.json`，形状：
 * `{ "enabled": true, "builtinTypescript": true, "servers": [{ "command": "...", ... }] }`
 * 文件不存在、不是 JSON、字段类型不对都只影响出错的那一项，绝不因此让语言服务整体失效。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { LanguageServerInfo, LanguageSettingsView } from './protocol.ts'

/** 生效的语言服务设置。 */
export interface LanguageSettings {
  /** 总开关：关闭后不生成本地诊断、不注册任何语言特性。 */
  enabled: boolean
  /** 内置 TypeScript/JavaScript 语言服务。外部 LSP 服务器不受它影响。 */
  builtinTypescript: boolean
  /** 自定义外部语言服务器（原样保存，由 servers.ts 解析校验）。 */
  servers: readonly unknown[]
}

export const DEFAULT_LANGUAGE_SETTINGS: LanguageSettings = { enabled: true, builtinTypescript: true, servers: [] }

/** 设置文件的固定文件名；与补全设置文件同级。 */
export const LANGUAGE_SETTINGS_FILE = 'language.settings.json'

/** 设置页写文件时的错误；路由把它映射成 400 而不是 500。 */
export class LanguageSettingsWriteError extends Error {}

/** 设置文件位置；数据目录未知时返回 undefined。 */
export function languageSettingsPath(env: Record<string, string | undefined> = globalThis.process?.env ?? {}): string | undefined {
  const home = env['DSH_HOME']
  if (home === undefined || home === '') return undefined
  const neat = home.replace(/[\\/]+$/, '').replaceAll('\\', '/')
  return `${neat}/${LANGUAGE_SETTINGS_FILE}`
}

/** 从一段可能存在的配置里取 language 桶；字段缺失或类型不对返回空对象。 */
function bucketOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const nested = record['language']
  if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) return nested as Record<string, unknown>
  // 兼容「整个配置就是 language 桶」的写法（插件配置与专用设置文件都用得到）。
  if ('enabled' in record || 'builtinTypescript' in record || 'servers' in record) return record
  return {}
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** 插件配置 / 设置文件给出的设置。 */
export function fromLanguageConfig(value: unknown): Partial<LanguageSettings> {
  const bucket = bucketOf(value)
  const settings: Partial<LanguageSettings> = {}
  const enabled = booleanField(bucket['enabled'])
  if (enabled !== undefined) settings.enabled = enabled
  const builtin = booleanField(bucket['builtinTypescript'])
  if (builtin !== undefined) settings.builtinTypescript = builtin
  if (Array.isArray(bucket['servers'])) settings.servers = bucket['servers'] as readonly unknown[]
  return settings
}

/** 环境变量给出的覆盖；空串视为没设。 */
export function fromLanguageEnvironment(env: Record<string, string | undefined>): Partial<LanguageSettings> {
  const settings: Partial<LanguageSettings> = {}
  const enabled = env['DSH_AIDE_LANGUAGE']
  if (enabled !== undefined && enabled !== '') settings.enabled = !['0', 'off', 'false', 'no'].includes(enabled.toLowerCase())
  const builtin = env['DSH_AIDE_LANGUAGE_BUILTIN']
  if (builtin !== undefined && builtin !== '') settings.builtinTypescript = !['0', 'off', 'false', 'no'].includes(builtin.toLowerCase())
  const servers = env['DSH_AIDE_LANGUAGE_SERVERS']
  if (servers !== undefined && servers !== '') {
    // 环境变量里直接写数组，便于临时验证；写错就当没设（不因为一行坏 JSON 让语言服务失效）。
    try {
      const parsed: unknown = JSON.parse(servers)
      if (Array.isArray(parsed)) settings.servers = parsed
    } catch { /* 忽略非法 JSON */ }
  }
  return settings
}

/** 合并来源得到生效设置；`file` 传设置文件内容（未知时不传）。 */
export function resolveLanguageSettings(config?: unknown, env: Record<string, string | undefined> = globalThis.process?.env ?? {}, file?: unknown): LanguageSettings {
  return { ...DEFAULT_LANGUAGE_SETTINGS, ...fromLanguageConfig(config), ...fromLanguageConfig(file), ...fromLanguageEnvironment(env) }
}

/* ────────────────────────────── 运行期缓存 ────────────────────────────── */

const FILE_RECHECK_MS = 2000
let pluginConfig: unknown
let fileValue: unknown
let fileCheckedAt = 0
let current: LanguageSettings = DEFAULT_LANGUAGE_SETTINGS

function readFileSettings(path: string | undefined): unknown {
  if (path === undefined) return undefined
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
}

function refresh(now: number, env: Record<string, string | undefined>): void {
  const path = languageSettingsPath(env)
  if (now - fileCheckedAt >= FILE_RECHECK_MS) {
    fileValue = readFileSettings(path)
    fileCheckedAt = now
  }
  current = resolveLanguageSettings(pluginConfig, env, fileValue)
}

/** 插件加载时写入配置；返回当时生效的设置。 */
export function setLanguageSettings(config?: unknown): LanguageSettings {
  pluginConfig = config
  refresh(Date.now(), globalThis.process?.env ?? {})
  return current
}

/** 取当前生效设置；设置文件按固定周期重读，改完几秒内生效。 */
export function languageSettings(now: number = Date.now(), env: Record<string, string | undefined> = globalThis.process?.env ?? {}): LanguageSettings {
  refresh(now, env)
  return current
}

/** 供测试与排查：恢复默认并清掉缓存。 */
export function resetLanguageSettings(): void {
  pluginConfig = undefined
  fileValue = undefined
  fileCheckedAt = 0
  current = DEFAULT_LANGUAGE_SETTINGS
}

/* ────────────────────────────── 设置页读写面 ────────────────────────────── */

export interface LanguageSettingsPatch {
  enabled?: boolean
  builtinTypescript?: boolean
}

/**
 * 设置页要展示的视图。
 *
 * `servers` 由调用方传入已发现列表（发现逻辑在 servers.ts，属于宿主侧能力）；设置文件路径与
 * 环境变量覆盖一并给出，用户排查「为什么开关不生效」时第一眼能看到优先级更高的来源。
 */
export function languageSettingsView(env: Record<string, string | undefined> = globalThis.process?.env ?? {}, servers: readonly LanguageServerInfo[] = []): LanguageSettingsView {
  refresh(Date.now(), env)
  const path = languageSettingsPath(env)
  const view: LanguageSettingsView = { enabled: current.enabled, builtinTypescript: current.builtinTypescript, servers: [...servers] }
  if (path !== undefined) view.file = path
  const envEnabled = env['DSH_AIDE_LANGUAGE']
  const envBuiltin = env['DSH_AIDE_LANGUAGE_BUILTIN']
  if ((envEnabled !== undefined && envEnabled !== '') || (envBuiltin !== undefined && envBuiltin !== '')) {
    view.env = {
      ...(envEnabled === undefined || envEnabled === '' ? {} : { enabled: envEnabled }),
      ...(envBuiltin === undefined || envBuiltin === '' ? {} : { builtinTypescript: envBuiltin }),
    }
  }
  return view
}

/** 设置文件的读写出口；测试可替换，避免碰真实数据目录。 */
export interface LanguageSettingsIo { read(path: string): unknown; write(path: string, value: unknown): void }

function systemIo(): LanguageSettingsIo {
  return {
    read: path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined } },
    write: (path, value) => {
      const separator = path.lastIndexOf('/')
      if (separator > 0) mkdirSync(path.slice(0, separator), { recursive: true })
      const temporary = `${path}.tmp`
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      renameSync(temporary, path)
    },
  }
}

/**
 * 写入语言服务设置并立刻生效。
 *
 * 只改当前文件里已有的字段：`servers` 这类由用户手写的配置必须原样保留，
 * 设置页里的两个开关不该把它们冲掉。
 */
export function updateLanguageSettings(patch: LanguageSettingsPatch, env: Record<string, string | undefined> = globalThis.process?.env ?? {}, io: LanguageSettingsIo = systemIo(), servers: readonly LanguageServerInfo[] = []): LanguageSettingsView {
  const path = languageSettingsPath(env)
  if (path === undefined) throw new LanguageSettingsWriteError('数据目录未知（未设置 DSH_HOME），无法保存语言服务设置')
  const stored = io.read(path)
  const root = typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? { ...(stored as Record<string, unknown>) } : {}
  const nested = bucketOf(root)
  // 文件是专用文件：把字段写在根上，与文档一致；读到旧版嵌套写法也照样合并。
  const next: Record<string, unknown> = { ...nested }
  if (patch.enabled !== undefined) next['enabled'] = patch.enabled
  if (patch.builtinTypescript !== undefined) next['builtinTypescript'] = patch.builtinTypescript
  io.write(path, next)
  fileValue = next
  fileCheckedAt = Date.now()
  current = resolveLanguageSettings(pluginConfig, env, fileValue)
  return languageSettingsView(env, servers)
}

/** 取用户配置的服务器数组（交给 servers.ts 解析）。 */
export function configuredLanguageServers(): readonly unknown[] {
  return languageSettings().servers
}
