import { describe, expect, it } from 'vitest'
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
} from '../src/completion/settings.ts'

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
    const settings = setCompletionSettings(undefined)
    expect(settings.fallback).toBe(false)
    expect(settings.route).toBeUndefined()
    resetCompletionSettings()
    expect(completionSettings()).toEqual(DEFAULT_COMPLETION_SETTINGS)
  })
})
