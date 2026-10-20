import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_COMPLETION_SETTINGS,
  completionSettings,
  fromConfig,
  parseRoute,
  resetCompletionSettings,
  resolveSettings,
  readSettingsFile,
  setCompletionSettings,
  settingsFilePath,
  SettingsWriteError,
  updateCompletionSettings,
  type SettingsFileIo,
} from '../src/completion/settings.ts'

/** 把数据目录指到一个空目录跑，免得读到开发机上的真实设置文件。 */
function withTemporaryHome(body: (home: string) => void): void {
  const previous = process.env['DSH_HOME']
  const home = mkdtempSync(join(tmpdir(), 'dvw-settings-'))
  process.env['DSH_HOME'] = home
  try {
    resetCompletionSettings()
    body(home)
  } finally {
    if (previous === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previous
    resetCompletionSettings()
  }
}

afterEach(() => {
  resetCompletionSettings()
})

describe('completion settings', () => {
  it('parses a provider/model route and rejects malformed values', () => {
    expect(parseRoute('our-free-model/mimo-v2.6-flash-free')).toEqual({ provider: 'our-free-model', model: 'mimo-v2.6-flash-free' })
    // 宁可回落到默认模型，也不要因为一个写错的值把补全整条打挂。
    expect(parseRoute(undefined)).toBeUndefined()
    expect(parseRoute('')).toBeUndefined()
    expect(parseRoute('no-slash')).toBeUndefined()
    expect(parseRoute('/model')).toBeUndefined()
    expect(parseRoute('provider/')).toBeUndefined()
  })

  it('reads the plugin config, accepting either shape', () => {
    expect(fromConfig({ completion: { route: 'a/b', fallback: true } })).toEqual({ route: { provider: 'a', model: 'b' }, fallback: true })
    // 直接平铺也认：profile 里那一行怎么写都不会白设。
    expect(fromConfig({ route: 'a/b' })).toEqual({ route: { provider: 'a', model: 'b' } })
    expect(fromConfig(undefined)).toEqual({})
    expect(fromConfig('nonsense')).toEqual({})
  })

  it('lets the environment override the plugin config', () => {
    const env = { DSH_COMPLETION_ROUTE: 'env-provider/env-model', DSH_COMPLETION_FALLBACK: 'local' }
    expect(resolveSettings({ completion: { route: 'cfg-provider/cfg-model', fallback: false } }, env)).toEqual({
      route: { provider: 'env-provider', model: 'env-model' },
      fallback: true,
    })
  })

  it('reads a settings file and lets the environment win over it', () => {
    // 文件是「数据目录里可编辑、又不动配置档」的那条入口。
    const read = () => JSON.stringify({ completion: { route: 'file-provider/file-model', fallback: true } })
    expect(readSettingsFile('whatever.json', read)).toEqual({ completion: { route: 'file-provider/file-model', fallback: true } })
    expect(resolveSettings(undefined, {}, readSettingsFile('whatever.json', read))).toEqual({ route: { provider: 'file-provider', model: 'file-model' }, fallback: true })
    const env = { DSH_COMPLETION_ROUTE: 'env-provider/env-model' }
    expect(resolveSettings(undefined, env, readSettingsFile('whatever.json', read)).route).toEqual({ provider: 'env-provider', model: 'env-model' })
  })

  it('treats a broken settings file as no settings', () => {
    // 一个写坏的文件绝不能让补全整体失效。
    expect(readSettingsFile('x.json', () => 'not json at all')).toBeUndefined()
    expect(resolveSettings(undefined, {}, readSettingsFile('x.json', () => 'not json at all'))).toEqual(DEFAULT_COMPLETION_SETTINGS)
  })

  it('locates the settings file from the data directory', () => {
    expect(settingsFilePath({ DSH_HOME: 'H:\\dsh-data' })).toBe('H:/dsh-data/completion.settings.json')
    expect(settingsFilePath({ DSH_HOME: 'H:\\dsh-data\\' })).toBe('H:/dsh-data/completion.settings.json')
    expect(settingsFilePath({})).toBeUndefined()
  })

  it('defaults to no route and no fallback', () => {
    // 显式传空环境，免得跑测试的机器上恰好设了这两个变量而让结论飘。
    expect(resolveSettings(undefined, {})).toEqual(DEFAULT_COMPLETION_SETTINGS)
    withTemporaryHome(() => {
      const settings = setCompletionSettings(undefined)
      expect(settings.fallback).toBe(false)
      expect(settings.route).toBeUndefined()
    })
  })

  it('picks up a settings file change without restarting', () => {
    // 桌面端重启应用代价不小，所以设置文件按周期重读：改完几秒内生效。
    withTemporaryHome(home => {
      expect(setCompletionSettings(undefined).route).toBeUndefined()
      writeFileSync(join(home, 'completion.settings.json'), JSON.stringify({ completion: { route: 'a/b' } }), 'utf8')
      // 把时间往前推过重读周期：不改盘上文件，只跳过缓存。
      expect(completionSettings(Date.now() + 5000).route).toEqual({ provider: 'a', model: 'b' })
    })
  })
})

/** 设置文件的内存实现：测试不碰真实数据目录，也能断言写进去的内容。 */
function memoryIo(initial?: unknown): { writes: unknown[]; io: SettingsFileIo } {
  const writes: unknown[] = []
  return { writes, io: { read: () => initial, write: (_path, value) => { writes.push(value) } } }
}

describe('completion settings written from the settings page', () => {
  const env = { DSH_HOME: 'X:/dvw-data' }

  it('writes the route and fallback, and applies them without a restart', () => {
    const { writes, io } = memoryIo()
    // 时间戳取在写入之前：读取时就不会触发「按周期重读真实数据目录」那条路，测试不受开发机设置影响。
    const at = Date.now()
    const view = updateCompletionSettings({ route: 'acme/fast-model', fallback: true }, env, io)
    expect(writes).toEqual([{ completion: { route: 'acme/fast-model', fallback: true } }])
    expect(view).toMatchObject({ route: 'acme/fast-model', fallback: true, routeSource: 'file', fallbackSource: 'file', file: 'X:/dvw-data/completion.settings.json' })
    // 立即生效：不必等两秒的重读周期。
    expect(completionSettings(at).route).toEqual({ provider: 'acme', model: 'fast-model' })
    expect(completionSettings(at).fallback).toBe(true)
  })

  it('clears the route back to the application default on an empty value', () => {
    const { writes, io } = memoryIo()
    const at = Date.now()
    updateCompletionSettings({ route: 'acme/fast' }, env, io)
    const view = updateCompletionSettings({ route: null, fallback: false }, env, io)
    expect(view.route).toBeNull()
    expect(view.routeSource).toBe('default')
    expect(writes.at(-1)).toEqual({ completion: { fallback: false } })
    expect(completionSettings(at).route).toBeUndefined()
  })

  it('rejects a malformed route without touching the file', () => {
    // 格式不对要当场说清楚，而不是写进去再让补全整体挂掉。
    const { writes, io } = memoryIo()
    expect(() => updateCompletionSettings({ route: 'no-slash' }, env, io)).toThrowError(SettingsWriteError)
    expect(writes).toHaveLength(0)
  })

  it('refuses to write when the data directory is unknown', () => {
    const { writes, io } = memoryIo()
    expect(() => updateCompletionSettings({ fallback: true }, {}, io)).toThrowError(/DSH_HOME/)
    expect(writes).toHaveLength(0)
  })

  it('migrates a flat hand-written file into the completion section', () => {
    // 旧文件可能是平铺的 { route, fallback }；写的时候收进 completion 下，否则旧值会被静默忽略。
    const { writes, io } = memoryIo({ route: 'old/model' })
    const view = updateCompletionSettings({ fallback: true }, env, io)
    expect(writes).toEqual([{ completion: { route: 'old/model', fallback: true } }])
    expect(view.route).toBe('old/model')
  })

  it('reports the environment variable as the winning source', () => {
    // 环境变量优先级最高：设置页里改了也不生效，所以要如实告诉用户是谁在覆盖。
    const { io } = memoryIo()
    const view = updateCompletionSettings({ route: 'acme/fast' }, { ...env, DSH_COMPLETION_ROUTE: 'env/model' }, io)
    expect(view).toMatchObject({ route: 'env/model', routeSource: 'env', envRoute: 'env/model' })
  })

  it('writes the real settings file through the host file system', () => {
    // 上面几条用的是内存替身；这条走默认实现（node:fs + 原子改名），验证真正落盘的那条路。
    withTemporaryHome(home => {
      const view = updateCompletionSettings({ route: 'disk/model', fallback: false })
      expect(view.file).toBe(`${home.replaceAll('\\', '/')}/completion.settings.json`)
      expect(JSON.parse(readFileSync(join(home, 'completion.settings.json'), 'utf8'))).toEqual({ completion: { route: 'disk/model', fallback: false } })
      // 从盘上重读也看到同一份：重启应用之后设置仍然有效。
      expect(completionSettings(Date.now() + 5000).route).toEqual({ provider: 'disk', model: 'model' })
    })
  })
})
