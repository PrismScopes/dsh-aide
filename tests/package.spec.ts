import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { WORKBENCH_VERSION } from '../src/client/version.ts'

describe('published plugin assembly', () => {
  it('keeps the client version in sync with package.json', async () => {
    // 客户端不能 import package.json，所以版本号在 src/client/version.ts 有一份常量；
    // 这里钉住两处一致，发版时漏改会直接失败。
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(WORKBENCH_VERSION).toBe(manifest.version)
  })

  it('loads the host plugin when installed as a standalone bundle', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
      files?: string[]
    }

    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.files).toContain('cordis.patch.yml')
    expect((manifest as { dependencies?: Record<string, string> }).dependencies).toMatchObject({ 'node-pty': '^1.1.0', '@xterm/xterm': '^5.5.0', '@xterm/addon-fit': '^0.11.0' })

    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain('name: dsh-vscode-workbench')
  })
})
