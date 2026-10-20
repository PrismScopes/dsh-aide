import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { listFiles, moveEntry } from '../src/host.ts'

/**
 * 资源管理器「剪切 → 粘贴」的宿主实现（`fs.move`）。
 *
 * 单独一个文件而不是塞进 host.spec.ts：host.spec.ts 里有一条本机必然失败的 Windows symlink 用例，
 * 混在一起跑会让人分不清失败到底是哪边的问题。这里只覆盖 moveEntry 的四个约束。
 */
const roots: string[] = []
async function temp(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'dvw-move-')); roots.push(value); return value }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('workspace move (cut → paste)', () => {
  it('moves a file into another existing directory while keeping its name', async () => {
    const root = await temp()
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'src', 'a.ts'), 'one')
    const entry = await moveEntry(root, 'src/a.ts', 'docs')
    expect(entry).toMatchObject({ name: 'a.ts', path: 'docs/a.ts', kind: 'file', size: 3 })
    expect(await readFile(join(root, 'docs', 'a.ts'), 'utf8')).toBe('one')
    // 剪切语义：源目录里不再有这一项。
    expect((await listFiles(root, 'src')).map(row => row.name)).toEqual([])
  })

  it('moves a directory with its contents', async () => {
    const root = await temp()
    await mkdir(join(root, 'packages', 'app'), { recursive: true })
    await writeFile(join(root, 'packages', 'app', 'index.ts'), 'x')
    await mkdir(join(root, 'vendor'))
    const entry = await moveEntry(root, 'packages/app', 'vendor')
    expect(entry).toMatchObject({ name: 'app', path: 'vendor/app', kind: 'directory' })
    expect((await listFiles(root, 'vendor/app')).map(row => row.name)).toEqual(['index.ts'])
    expect((await listFiles(root, 'packages')).map(row => row.name)).toEqual([])
  })

  it('refuses to overwrite an existing target with 409 target-exists', async () => {
    const root = await temp()
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'src', 'a.ts'), 'one')
    await writeFile(join(root, 'docs', 'a.ts'), 'two')
    await expect(moveEntry(root, 'src/a.ts', 'docs')).rejects.toMatchObject({ code: 'target-exists' })
    // 拒绝时不能已经动过源文件：这条保证「粘错了还能救」。
    expect(await readFile(join(root, 'src', 'a.ts'), 'utf8')).toBe('one')
    expect(await readFile(join(root, 'docs', 'a.ts'), 'utf8')).toBe('two')
  })

  it('treats pasting back into the same directory as target-exists', async () => {
    const root = await temp()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'a.ts'), 'one')
    // 剪切后粘回原目录：目标就是源文件，报「目标已存在」比报「移入自身」准确。
    await expect(moveEntry(root, 'src/a.ts', 'src')).rejects.toMatchObject({ code: 'target-exists' })
  })

  it('refuses to move a directory into itself or a descendant with 400 copy-into-self', async () => {
    const root = await temp()
    await mkdir(join(root, 'packages', 'app', 'child'), { recursive: true })
    // 目标目录就是它自己（目标子路径尚不存在，所以能走到「移入自身」这条判断）。
    await expect(moveEntry(root, 'packages/app', 'packages/app')).rejects.toMatchObject({ code: 'copy-into-self' })
    // 目标在它自己的子树里，rename 会把整棵树连自己一起搬走。
    await expect(moveEntry(root, 'packages', 'packages/app/child')).rejects.toMatchObject({ code: 'copy-into-self' })
  })

  it('requires the target directory to exist and rejects an empty source', async () => {
    const root = await temp()
    await writeFile(join(root, 'a.ts'), 'one')
    await expect(moveEntry(root, 'a.ts', 'missing')).rejects.toMatchObject({ code: 'parent-missing' })
    await expect(moveEntry(root, 'a.ts', 'missing/deep')).rejects.toMatchObject({ code: 'parent-missing' })
    await expect(moveEntry(root, '', '')).rejects.toMatchObject({ code: 'path-invalid' })
    await expect(moveEntry(root, 'nope.txt', '')).rejects.toMatchObject({ code: 'not-found' })
  })
})
