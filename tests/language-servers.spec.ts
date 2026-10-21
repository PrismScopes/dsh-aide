import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DetectedServer, ExternalServerDefinition } from '../src/language/servers.ts'
import { discoverServers, KNOWN_SERVERS, parseConfiguredServers, resolveExecutable, serverForLanguage } from '../src/language/servers.ts'

const isWindows = process.platform === 'win32'
const roots: string[] = []
async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dvw-servers-'))
  roots.push(root)
  return root
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

/** 造一个「可执行文件」；POSIX 上补执行位，否则 resolveExecutable 按 X_OK 判定不存在。 */
async function writeExecutable(path: string, content = isWindows ? '@echo off\r\n' : '#!/bin/sh\n'): Promise<string> {
  await writeFile(path, content, 'utf8')
  if (!isWindows) await chmod(path, 0o755)
  return path
}

/** 受限 PATH：只包含临时目录，保证不会意外发现开发机上真实安装的服务器。 */
function restrictedEnv(directory: string): NodeJS.ProcessEnv {
  return { PATH: directory, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
}

function detected(id: string, languages: string[], name = id): DetectedServer {
  const definition: ExternalServerDefinition = { id, name, languages, extensions: [], command: id, args: [] }
  return { id, name, languages, extensions: [], executable: `/fake/${id}`, args: [], definition }
}

describe('resolveExecutable', () => {
  it('finds an executable on PATH', async () => {
    const directory = await temp()
    const file = await writeExecutable(join(directory, isWindows ? 'tool-lsp.cmd' : 'tool-lsp'))
    const resolved = resolveExecutable('tool-lsp', restrictedEnv(directory))
    expect(resolved).toBeDefined()
    expect(resolved!.toLowerCase()).toBe(file.toLowerCase())
    // 环境变量的名字大小写不敏感（Windows 上常见 Path / PATH 混用）。
    expect(resolveExecutable('tool-lsp', { Path: directory })?.toLowerCase()).toBe(file.toLowerCase())
  })

  it('returns undefined for missing commands, empty PATH and empty names', async () => {
    const directory = await temp()
    expect(resolveExecutable('definitely-not-installed-lsp', restrictedEnv(directory))).toBeUndefined()
    expect(resolveExecutable('anything', { PATH: '' })).toBeUndefined()
    expect(resolveExecutable('   ', restrictedEnv(directory))).toBeUndefined()
  })

  it('checks absolute paths directly', async () => {
    const directory = await temp()
    const file = await writeExecutable(join(directory, isWindows ? 'absolute-lsp.cmd' : 'absolute-lsp'))
    expect(resolveExecutable(file, restrictedEnv(directory))?.toLowerCase()).toBe(file.toLowerCase())
    expect(resolveExecutable(join(directory, 'missing-lsp'), restrictedEnv(directory))).toBeUndefined()
  })

  it('prefers the executable bit on POSIX', async () => {
    const directory = await temp()
    if (!isWindows) {
      const plain = join(directory, 'not-executable')
      await writeFile(plain, '#!/bin/sh\n', 'utf8')
      await chmod(plain, 0o644)
      expect(resolveExecutable('not-executable', restrictedEnv(directory))).toBeUndefined()
    }
  })

  it.skipIf(!isWindows)('adds PATHEXT variants for bare names on Windows', async () => {
    const directory = await temp()
    const file = await writeExecutable(join(directory, 'pathext-lsp.cmd'))
    const resolved = resolveExecutable('pathext-lsp', { PATH: directory, PATHEXT: '.CMD' })
    expect(resolved).toBeDefined()
    expect(resolved!.toLowerCase()).toBe(file.toLowerCase())
  })
})

describe('parseConfiguredServers', () => {
  it('accepts { language: { servers } } and keeps valid fields', () => {
    const definitions = parseConfiguredServers({
      language: {
        servers: [
          { id: 'my-python', name: 'My Python', languages: ['python'], command: 'my-lsp', args: ['--stdio'], initializationOptions: { strict: true }, env: { PYTHONPATH: 'x' } },
          { command: 'derived-lsp', extensions: ['.py', 'TS'] },
        ],
      },
    })
    expect(definitions.map(definition => definition.id)).toEqual(['my-python', 'custom-derived-lsp'])
    expect(definitions[0]).toMatchObject({ name: 'My Python', languages: ['python'], command: 'my-lsp', args: ['--stdio'], initializationOptions: { strict: true }, env: { PYTHONPATH: 'x' } })
    // 只给了扩展名时用公共协议的映射反推语言 id；扩展名归一成小写去点。
    expect([...definitions[1]!.languages].sort()).toEqual(['python', 'typescript'])
    expect(definitions[1]!.extensions).toEqual(['py', 'ts'])
  })

  it('accepts a bare array and skips bad or duplicate items', () => {
    const definitions = parseConfiguredServers([
      { id: 'dup', command: 'first-lsp' },
      { id: 'dup', command: 'second-lsp' },
      { command: '' },
      { args: ['--stdio'] },
      'not-an-object',
      null,
      { command: 'third-lsp', commandCandidates: [{ command: 'fallback-lsp', args: ['--stdio'] }, { command: 42 }] },
    ])
    expect(definitions.map(definition => definition.id)).toEqual(['dup', 'custom-third-lsp'])
    expect(definitions[0]!.command).toBe('first-lsp') // 重复 id 保留第一条
    expect(definitions[1]!.commandCandidates).toEqual([{ command: 'fallback-lsp', args: ['--stdio'] }])
    expect(definitions[1]!.args).toEqual([])
  })

  it('tolerates missing/odd config shapes', () => {
    expect(parseConfiguredServers(undefined)).toEqual([])
    expect(parseConfiguredServers(null)).toEqual([])
    expect(parseConfiguredServers('nope')).toEqual([])
    expect(parseConfiguredServers({ language: { servers: 'nope' } })).toEqual([])
    expect(parseConfiguredServers({ servers: [{ command: 'top-level-lsp' }] }).map(definition => definition.id)).toEqual(['custom-top-level-lsp'])
  })
})

describe('discoverServers', () => {
  it('finds custom servers through PATH and reports known servers as missing', async () => {
    const directory = await temp()
    await writeExecutable(join(directory, isWindows ? 'fake-python.cmd' : 'fake-python'))
    const config = {
      language: {
        servers: [{ id: 'python', name: 'Custom Python', languages: ['python'], command: 'fake-python', args: ['--stdio'] }],
      },
    }
    const { available, missing } = discoverServers(restrictedEnv(directory), config)
    expect(available).toHaveLength(1)
    expect(available[0]!.name).toBe('Custom Python')
    expect(available[0]!.executable.toLowerCase()).toContain('fake-python')
    expect(available[0]!.args).toEqual(['--stdio'])
    expect(available[0]!.languages).toEqual(['python'])
    // 受限 PATH 下内置目录一个都找不到；自定义的 python 覆盖了同 id 的内置项。
    expect(missing.map(definition => definition.id)).toContain('rust')
    expect(missing.map(definition => definition.id)).not.toContain('python')
    expect(missing.length).toBe(KNOWN_SERVERS.length - 1)
    expect(discoverServers(restrictedEnv(directory)).available).toEqual([])
  })

  it('falls back to command candidates when the primary command is missing', async () => {
    const directory = await temp()
    await writeExecutable(join(directory, isWindows ? 'pylsp-fake.cmd' : 'pylsp-fake'))
    const config = {
      language: {
        servers: [{
          id: 'python',
          languages: ['python'],
          command: 'pyright-langserver-missing',
          args: ['--stdio'],
          commandCandidates: [{ command: 'pylsp-fake' }],
        }],
      },
    }
    const { available } = discoverServers(restrictedEnv(directory), config)
    expect(available).toHaveLength(1)
    expect(available[0]!.executable.toLowerCase()).toContain('pylsp-fake')
    expect(available[0]!.args).toEqual([]) // 候选没给 args
  })

  it('keeps the built-in catalog for the languages AIDE promises', () => {
    const ids = KNOWN_SERVERS.map(definition => definition.id)
    expect(ids).toEqual(expect.arrayContaining(['python', 'rust', 'go', 'c', 'yaml', 'shellscript', 'lua', 'php', 'ruby', 'dockerfile']))
    const python = KNOWN_SERVERS.find(definition => definition.id === 'python')!
    expect(python.command).toBe('pyright-langserver')
    expect(python.args).toEqual(['--stdio'])
    expect(python.commandCandidates?.map(candidate => candidate.command)).toContain('pylsp')
    const c = KNOWN_SERVERS.find(definition => definition.id === 'c')!
    expect(c.languages).toEqual(expect.arrayContaining(['c', 'cpp']))
    expect(KNOWN_SERVERS.find(definition => definition.id === 'yaml')!.args).toEqual(['--stdio'])
    expect(KNOWN_SERVERS.find(definition => definition.id === 'shellscript')!.args).toEqual(['start'])
    expect(KNOWN_SERVERS.find(definition => definition.id === 'solargraph')).toBeUndefined()
    expect(KNOWN_SERVERS.find(definition => definition.id === 'ruby')!.args).toEqual(['stdio'])
  })
})

describe('serverForLanguage', () => {
  it('picks the first matching server (custom definitions come first)', () => {
    const custom = detected('custom-python', ['python'])
    const builtin = detected('python', ['python'])
    expect(serverForLanguage('python', [custom, builtin])).toBe(custom)
    expect(serverForLanguage('python', [builtin])).toBe(builtin)
    expect(serverForLanguage('PYTHON', [custom])).toBe(custom)
    expect(serverForLanguage('ruby', [custom])).toBeUndefined()
    expect(serverForLanguage('', [custom])).toBeUndefined()
  })
})
