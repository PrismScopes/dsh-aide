import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_LANGUAGE_SETTINGS,
  fromLanguageConfig,
  fromLanguageEnvironment,
  languageSettings,
  languageSettingsPath,
  languageSettingsView,
  resetLanguageSettings,
  resolveLanguageSettings,
  setLanguageSettings,
  updateLanguageSettings,
  type LanguageSettingsIo,
} from '../src/language/settings.ts'

/**
 * 语言服务设置：环境变量 > 设置文件 > 插件配置 > 默认值。
 * 这里不碰真实 DSH_HOME（除最后一个用例显式验证默认路径），
 * 写入面用注入的内存 IO，读路径用临时目录。
 */
describe('语言服务设置', () => {
  beforeEach(() => { resetLanguageSettings() })
  afterEach(() => { resetLanguageSettings(); delete process.env.DSH_HOME; delete process.env.DSH_AIDE_LANGUAGE; delete process.env.DSH_AIDE_LANGUAGE_BUILTIN; delete process.env.DSH_AIDE_LANGUAGE_SERVERS })

  it('parses nested buckets, flat buckets and rejects unknown types', () => {
    expect(fromLanguageConfig({ language: { enabled: false, builtinTypescript: false } })).toEqual({ enabled: false, builtinTypescript: false })
    expect(fromLanguageConfig({ enabled: true, builtinTypescript: true })).toEqual({ enabled: true, builtinTypescript: true })
    expect(fromLanguageConfig({ language: { enabled: 'no', builtinTypescript: 1 } })).toEqual({})
    expect(fromLanguageConfig({ language: { servers: [{ command: 'x' }, 'bad'] } })).toMatchObject({ servers: [{ command: 'x' }, 'bad'] })
  })

  it('reads environment overrides with the usual truthy spellings', () => {
    expect(fromLanguageEnvironment({ DSH_AIDE_LANGUAGE: '0' })).toEqual({ enabled: false })
    expect(fromLanguageEnvironment({ DSH_AIDE_LANGUAGE: 'off' })).toEqual({ enabled: false })
    expect(fromLanguageEnvironment({ DSH_AIDE_LANGUAGE: '1', DSH_AIDE_LANGUAGE_BUILTIN: 'false' })).toEqual({ enabled: true, builtinTypescript: false })
    expect(fromLanguageEnvironment({ DSH_AIDE_LANGUAGE_SERVERS: '[{"command":"x"}]' })).toMatchObject({ servers: [{ command: 'x' }] })
    expect(fromLanguageEnvironment({ DSH_AIDE_LANGUAGE_SERVERS: 'not json' })).toEqual({})
  })

  it('merges sources in priority order', () => {
    expect(resolveLanguageSettings({ language: { enabled: false } }, {}, { language: { enabled: true, builtinTypescript: false } }))
      .toEqual({ enabled: true, builtinTypescript: false, servers: [] })
    expect(resolveLanguageSettings({ language: { enabled: false } }, { DSH_AIDE_LANGUAGE: '1' }, {}))
      .toEqual({ enabled: true, builtinTypescript: true, servers: [] })
    expect(resolveLanguageSettings()).toEqual(DEFAULT_LANGUAGE_SETTINGS)
  })

  it('caches the settings file for the recheck window and resets cleanly', () => {
    const file = { enabled: false, builtinTypescript: false }
    expect(resolveLanguageSettings(undefined, {}, file)).toMatchObject({ enabled: false })
    setLanguageSettings({ language: { enabled: false } })
    expect(languageSettings()).toMatchObject({ enabled: false })
    resetLanguageSettings()
    expect(languageSettings()).toEqual(DEFAULT_LANGUAGE_SETTINGS)
  })

  it('writes only its own fields and keeps user-defined servers', () => {
    const writes: { path: string; value: unknown }[] = []
    const io: LanguageSettingsIo = {
      read: () => ({ enabled: true, builtinTypescript: false, servers: [{ command: 'pyright-langserver' }] }),
      write: (path, value) => { writes.push({ path, value }) },
    }
    const view = updateLanguageSettings({ enabled: false, builtinTypescript: true }, { DSH_HOME: 'C:/data' }, io, [])
    expect(writes).toHaveLength(1)
    expect(writes[0]?.value).toEqual({ enabled: false, builtinTypescript: true, servers: [{ command: 'pyright-langserver' }] })
    expect(view).toMatchObject({ enabled: false, builtinTypescript: true, file: 'C:/data/language.settings.json' })
  })

  it('reports environment overrides and the settings file in the view', () => {
    const view = languageSettingsView({ DSH_HOME: 'H:/dsh-data', DSH_AIDE_LANGUAGE: '0' }, [])
    expect(view.file).toBe('H:/dsh-data/language.settings.json')
    expect(view.env).toEqual({ enabled: '0' })
    expect(languageSettingsPath({ DSH_HOME: 'H:/dsh-data/' })).toBe('H:/dsh-data/language.settings.json')
    expect(languageSettingsPath({})).toBeUndefined()
  })

  it('round-trips through a real file and tolerates a broken file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dvw-language-settings-'))
    process.env.DSH_HOME = root
    try {
      resetLanguageSettings()
      updateLanguageSettings({ enabled: false })
      expect(JSON.parse(await readFile(join(root, 'language.settings.json'), 'utf8'))).toEqual({ enabled: false })
      resetLanguageSettings()
      expect(languageSettings().enabled).toBe(false)
      // 写坏文件：只当没设，不抛错。
      await writeFile(join(root, 'language.settings.json'), '{bad json', 'utf8')
      resetLanguageSettings()
      expect(languageSettings().enabled).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
