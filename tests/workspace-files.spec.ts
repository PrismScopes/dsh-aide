import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listWorkspaceFiles, resetWorkspaceFileListCache } from '../src/host.ts'

const roots: string[] = []
async function temp() { const value = await mkdtemp(join(tmpdir(), 'dvw-files-')); roots.push(value); return value }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); resetWorkspaceFileListCache() })

describe('workspace file list for quick open', () => {
  it('walks nested directories and skips dependency, git and cache directories', async () => {
    const root = await temp()
    await mkdir(join(root, 'src', 'client'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(join(root, 'target'), { recursive: true })
    await writeFile(join(root, 'src', 'client', 'a.ts'), '')
    await writeFile(join(root, 'README.md'), '')
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), '')
    await writeFile(join(root, '.git', 'config'), '')
    await writeFile(join(root, 'target', 'bundle.js'), '')
    const value = await listWorkspaceFiles(root)
    expect(value.files).toEqual(['README.md', 'src/client/a.ts'])
    expect(value.truncated).toBe(false)
  })

  it('caches one scan per workspace for the TTL and rescans afterwards', async () => {
    const root = await temp()
    await writeFile(join(root, 'a.ts'), '')
    const first = listWorkspaceFiles(root, 1_000)
    const second = listWorkspaceFiles(root, 2_000)
    // 同一个 promise：TTL 内不重复遍历。
    expect(second).toBe(first)
    await writeFile(join(root, 'b.ts'), '')
    const third = listWorkspaceFiles(root, 1_000 + 5_001)
    expect(third).not.toBe(first)
    expect((await third).files).toEqual(['a.ts', 'b.ts'])
  })
})
