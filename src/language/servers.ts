/**
 * 外部语言服务器目录与可执行文件发现。
 *
 * 这里不启动进程，只回答三个问题：本机装了哪些服务器、某个语言该用哪个、用户配置里的服务器
 * 长什么样。真正的启动在 `lsp/external.ts`，这样「发现」可以在没有工作区、没有语言服务管理器的
 * 情况下单测。
 */
import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { languageIdForPath } from './protocol.ts'

/** 一个命令候选；`args` 缺省为空。 */
export interface ExternalServerCommand {
  command: string
  args?: readonly string[]
}

/** 一条外部语言服务器定义（内置目录或用户配置都归一到这个形状）。 */
export interface ExternalServerDefinition {
  id: string
  name: string
  /** 负责的 Monaco 语言 id（小写）。 */
  languages: readonly string[]
  /** 负责的文件扩展名（不含点，小写）；没有扩展名约定的文件（Dockerfile）为空。 */
  extensions: readonly string[]
  /** 首选的启动命令；在 PATH 上找不到时才尝试 commandCandidates。 */
  command: string
  args: readonly string[]
  /** 备选命令，例如 python 的 pyright 换成 pylsp。 */
  commandCandidates?: readonly ExternalServerCommand[]
  /** initialize 请求里的 initializationOptions。 */
  initializationOptions?: unknown
  /** 追加给子进程的环境变量。 */
  env?: Readonly<Record<string, string>>
}

/** 已定位到真实可执行文件的服务器（发现结果的 available 项）。 */
export interface DetectedServer {
  id: string
  name: string
  languages: readonly string[]
  extensions: readonly string[]
  /** 解析出的可执行文件路径（绝对路径或 PATH 上找到的完整路径）。 */
  executable: string
  args: readonly string[]
  /** 原始定义：initializationOptions / env 这类只有启动时才用的字段从这里取。 */
  definition: ExternalServerDefinition
}

/** 内置目录：覆盖 AIDE 打出诊断/跳转承诺的语言。顺序不重要（按语言匹配）。 */
export const KNOWN_SERVERS: readonly ExternalServerDefinition[] = [
  {
    id: 'python',
    name: 'Python (Pyright / Pylsp)',
    languages: ['python'],
    extensions: ['py', 'pyi', 'pyw'],
    command: 'pyright-langserver',
    args: ['--stdio'],
    commandCandidates: [{ command: 'pylsp' }],
  },
  { id: 'rust', name: 'Rust (rust-analyzer)', languages: ['rust'], extensions: ['rs'], command: 'rust-analyzer', args: [] },
  { id: 'go', name: 'Go (gopls)', languages: ['go'], extensions: ['go'], command: 'gopls', args: [] },
  {
    id: 'c',
    name: 'C/C++ (clangd)',
    languages: ['c', 'cpp'],
    extensions: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx'],
    command: 'clangd',
    args: [],
  },
  { id: 'yaml', name: 'YAML', languages: ['yaml'], extensions: ['yaml', 'yml'], command: 'yaml-language-server', args: ['--stdio'] },
  { id: 'shellscript', name: 'Shell (bash-language-server)', languages: ['shellscript'], extensions: ['sh', 'bash', 'zsh'], command: 'bash-language-server', args: ['start'] },
  { id: 'lua', name: 'Lua', languages: ['lua'], extensions: ['lua'], command: 'lua-language-server', args: [] },
  { id: 'php', name: 'PHP (Intelephense)', languages: ['php'], extensions: ['php'], command: 'intelephense', args: ['--stdio'] },
  { id: 'ruby', name: 'Ruby (Solargraph)', languages: ['ruby'], extensions: ['rb'], command: 'solargraph', args: ['stdio'] },
  { id: 'dockerfile', name: 'Dockerfile', languages: ['dockerfile'], extensions: [], command: 'docker-langserver', args: ['--stdio'] },
  { id: 'makefile', name: 'Makefile', languages: ['makefile'], extensions: ['mk'], command: 'make-language-server', args: [] },
]

const WINDOWS_PATHEXT = '.COM;.EXE;.BAT;.CMD'
const WINDOWS_PATH_SEPARATOR = ';'
const POSIX_PATH_SEPARATOR = ':'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 大小写不敏感地读环境变量：Windows 上 PATH/Path/PATHEXT/PathExt 的写法不统一。 */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const target = name.toLowerCase()
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() !== target) continue
    const value = env[key]
    return typeof value === 'string' ? value : undefined
  }
  return undefined
}

function isUsableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false
    // POSIX 上「存在但不可执行」不算找到；Windows 没有执行位，只看扩展名。
    if (platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch { return false }
}

/** 给一个不带扩展名的路径补出 Windows 的 PATHEXT 候选（POSIX 上原样一个候选）。 */
function executableCandidates(base: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'win32') return [base]
  const extensions = (envValue(env, 'PATHEXT') ?? WINDOWS_PATHEXT).split(';').map(value => value.trim()).filter(value => value !== '')
  const lower = base.toLowerCase()
  const candidates = [base]
  for (const extension of extensions) {
    if (!lower.endsWith(extension.toLowerCase())) candidates.push(base + extension)
  }
  return candidates
}

function firstUsable(candidates: readonly string[], platform: NodeJS.Platform): string | undefined {
  return candidates.find(candidate => isUsableFile(candidate, platform))
}

/**
 * 在 PATH（或给定的绝对/相对路径）上定位可执行文件。
 *
 * - 绝对路径与带分隔符的相对路径直接检查，不再走 PATH；
 * - 裸名字按 PATH 目录逐个尝试，Windows 再按 PATHEXT 补 `.exe/.cmd/...`；
 * - 找不到返回 undefined（调用方据此把服务器标成 missing）。
 */
export function resolveExecutable(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const trimmed = command.trim()
  if (trimmed === '') return undefined
  const hasSeparator = trimmed.includes('/') || trimmed.includes('\\')
  if (isAbsolute(trimmed) || (platform === 'win32' && /^[a-zA-Z]:[\\/]/.test(trimmed))) {
    return firstUsable(executableCandidates(trimmed, platform, env), platform)
  }
  if (hasSeparator) return firstUsable(executableCandidates(resolve(trimmed), platform, env), platform)
  const pathValue = envValue(env, 'PATH')
  if (pathValue === undefined) return undefined
  const separator = platform === 'win32' ? WINDOWS_PATH_SEPARATOR : POSIX_PATH_SEPARATOR
  for (const directory of pathValue.split(separator)) {
    if (directory.trim() === '') continue
    const found = firstUsable(executableCandidates(join(directory, trimmed), platform, env), platform)
    if (found !== undefined) return found
  }
  return undefined
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(item => item !== '')
}

function optionalStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && key.trim() !== '') result[key] = item
  }
  return Object.keys(result).length === 0 ? undefined : result
}

/** 扩展名归一：去掉前导点、转小写。 */
function normalizeExtensions(value: unknown): string[] {
  return stringArray(value).map(item => item.replace(/^\.+/, '').toLowerCase()).filter(item => item !== '')
}

/** 只有扩展名没有语言 id 时，用公共协议里的扩展名映射反推语言 id。 */
function languagesFromExtensions(extensions: readonly string[]): string[] {
  const languages: string[] = []
  for (const extension of extensions) {
    const languageId = languageIdForPath(`file.${extension}`)
    if (languageId !== undefined && !languages.includes(languageId)) languages.push(languageId)
  }
  return languages
}

function parseCommandCandidates(value: unknown): ExternalServerCommand[] {
  if (!Array.isArray(value)) return []
  const candidates: ExternalServerCommand[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const command = typeof item.command === 'string' ? item.command.trim() : ''
    if (command === '') continue
    candidates.push({ command, args: stringArray(item.args) })
  }
  return candidates
}

function parseServerDefinition(item: unknown): ExternalServerDefinition | undefined {
  if (!isRecord(item)) return undefined
  const command = typeof item.command === 'string' ? item.command.trim() : ''
  if (command === '') return undefined
  const extensions = normalizeExtensions(item.extensions)
  const languages = stringArray(item.languages).map(language => language.toLowerCase())
  for (const language of languagesFromExtensions(extensions)) if (!languages.includes(language)) languages.push(language)
  const commandCandidates = parseCommandCandidates(item.commandCandidates)
  const env = optionalStringRecord(item.env)
  const id = typeof item.id === 'string' && item.id.trim() !== '' ? item.id.trim() : `custom-${command.split(/[\\/]/).at(-1) ?? command}`
  return {
    id,
    name: typeof item.name === 'string' && item.name.trim() !== '' ? item.name.trim() : id,
    languages,
    extensions,
    command,
    args: stringArray(item.args),
    ...(commandCandidates.length === 0 ? {} : { commandCandidates }),
    ...(env === undefined ? {} : { env }),
    ...(item.initializationOptions === undefined ? {} : { initializationOptions: item.initializationOptions }),
  }
}

/** 从配置里取出服务器条目数组：支持 `{ language: { servers: [...] } }`、`{ servers: [...] }` 与裸数组。 */
function configuredItems(config: unknown): unknown[] {
  if (Array.isArray(config)) return config
  if (!isRecord(config)) return []
  if (Array.isArray(config.servers)) return config.servers
  const language = config.language
  if (isRecord(language) && Array.isArray(language.servers)) return language.servers
  return []
}

/**
 * 解析插件配置里的自定义服务器。
 *
 * 宽松：坏项（没有 command、不是对象、id 重复）直接跳过而不是整份配置作废 —— 用户手写 JSON
 * 很容易有笔误，一个坏项不该让其它能用的服务器全部失效。
 */
export function parseConfiguredServers(config: unknown): ExternalServerDefinition[] {
  const definitions: ExternalServerDefinition[] = []
  const ids = new Set<string>()
  for (const item of configuredItems(config)) {
    const definition = parseServerDefinition(item)
    if (definition === undefined || ids.has(definition.id)) continue
    ids.add(definition.id)
    definitions.push(definition)
  }
  return definitions
}

/** 一组候选：首选命令 + 备选命令。 */
function commandChoices(definition: ExternalServerDefinition): ExternalServerCommand[] {
  return [{ command: definition.command, args: definition.args }, ...(definition.commandCandidates ?? [])]
}

/**
 * 探测本机可用的外部服务器。
 *
 * 顺序是「自定义 → 内置」，且自定义与内置同 id 时自定义覆盖内置（同一个 id 就是同一个服务器，
 * 用户配置里的 command 应当优先）；`serverForLanguage` 按这个顺序取第一个匹配。
 */
export function discoverServers(env: NodeJS.ProcessEnv = process.env, config?: unknown): { available: DetectedServer[]; missing: ExternalServerDefinition[] } {
  const definitions: ExternalServerDefinition[] = []
  const seen = new Set<string>()
  for (const definition of [...parseConfiguredServers(config), ...KNOWN_SERVERS]) {
    if (seen.has(definition.id)) continue
    seen.add(definition.id)
    definitions.push(definition)
  }
  const available: DetectedServer[] = []
  const missing: ExternalServerDefinition[] = []
  for (const definition of definitions) {
    const choice = commandChoices(definition)
      .map(candidate => ({ candidate, executable: resolveExecutable(candidate.command, env) }))
      .find(item => item.executable !== undefined)
    if (choice === undefined || choice.executable === undefined) { missing.push(definition); continue }
    available.push({
      id: definition.id,
      name: definition.name,
      languages: definition.languages,
      extensions: definition.extensions,
      executable: choice.executable,
      args: choice.candidate.args ?? [],
      definition,
    })
  }
  return { available, missing }
}

/** 按语言 id 选服务器：调用方按优先级排好序（discoverServers 的 available 即自定义优先）。 */
export function serverForLanguage(languageId: string, servers: readonly DetectedServer[]): DetectedServer | undefined {
  const target = languageId.trim().toLowerCase()
  return servers.find(server => server.definition.languages.some(language => language.toLowerCase() === target))
}
