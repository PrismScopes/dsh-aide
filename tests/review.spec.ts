import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { run } from '../src/host.ts'
import {
  acceptAllReview,
  acceptReview,
  baselineOf,
  clearWorkspaceBaselines,
  createCheckpoint,
  reviewDiff,
  reviewCount,
  reviewList,
  restoreReview,
  rollbackCheckpoint,
} from '../src/review.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) { clearWorkspaceBaselines(root); await rm(root, { recursive: true, force: true }) }
})

async function temp() { const value = await mkdtemp(join(tmpdir(), 'dvw-review-')); roots.push(value); return value }

async function git(root: string, ...args: string[]) {
  const result = await run('git', args, root)
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

/** 建一个有初始提交的仓库：a.txt = one，b.txt = bee。 */
async function repository() {
  const root = await temp()
  await git(root, 'init')
  await git(root, 'config', 'user.email', 'test@example.com')
  await git(root, 'config', 'user.name', 'Test')
  await git(root, 'config', 'core.autocrlf', 'false')
  await writeFile(join(root, 'a.txt'), 'one\n')
  await writeFile(join(root, 'b.txt'), 'bee\n')
  await git(root, 'add', '.')
  await git(root, 'commit', '-m', 'init')
  return root
}

describe('review list and baseline', () => {
  it('diffs against git HEAD and flips to reviewed after acceptance', async () => {
    const root = await repository()
    await writeFile(join(root, 'a.txt'), 'two\n')
    const first = await reviewList(root)
    const file = first.files.find(row => row.path === 'a.txt')
    expect(file).toMatchObject({ status: 'M', baseline: 'none', tracked: true, reviewed: false })
    // 打开文件时也会记基线：这里模拟一次读取。
    await acceptReview(root, 'a.txt')
    const accepted = await reviewList(root)
    expect(accepted.files.find(row => row.path === 'a.txt')?.reviewed).toBe(true)
    await writeFile(join(root, 'a.txt'), 'three\n')
    expect((await reviewList(root)).files.find(row => row.path === 'a.txt')?.reviewed).toBe(false)
  })

  it('uses an in-memory baseline when the file was read by the workbench', async () => {
    const root = await repository()
    // 先记下当前内容，再制造变化：基线与磁盘不同，diff 应该以记忆中的内容为准。
    const { rememberBaseline } = await import('../src/review.ts')
    rememberBaseline(root, 'a.txt', 'one\n')
    await writeFile(join(root, 'a.txt'), 'two\n')
    const diff = await reviewDiff(root, 'a.txt')
    expect(diff.source).toBe('baseline')
    expect(diff.before).toBe('one\n')
    expect(diff.after).toBe('two\n')
    expect(diff.deleted).toBe(false)
  })

  it('restores a deleted file and reports the deletion diff', async () => {
    const root = await repository()
    await unlink(join(root, 'a.txt'))
    const diff = await reviewDiff(root, 'a.txt')
    expect(diff.deleted).toBe(true)
    expect(diff.after).toBe('')
    expect(diff.before).toBe('one\n')
    const restored = await restoreReview(root, 'a.txt')
    expect(restored.restored).toBe(true)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\n')
  })

  it('treats an untracked file as a new file with an empty baseline', async () => {
    const root = await repository()
    await writeFile(join(root, 'new.ts'), 'export const x = 1\n')
    const diff = await reviewDiff(root, 'new.ts')
    expect(diff.before).toBe('')
    expect(diff.after).toBe('export const x = 1\n')
    const reviewed = await acceptReview(root, 'new.ts')
    expect(reviewed.reviewed).toBe(true)
    expect((await reviewList(root)).files.find(row => row.path === 'new.ts')?.reviewed).toBe(true)
  })

  it('returns an empty list outside a git repository', async () => {
    const root = await temp()
    expect(await reviewList(root)).toEqual({ files: [], checkpoints: [] })
  })

  it('confirms a batch only for existing files', async () => {
    const root = await repository()
    await writeFile(join(root, 'a.txt'), 'two\n')
    const result = await acceptAllReview(root, ['a.txt', 'missing.txt'])
    expect(result.reviewed).toBe(2)
    expect(baselineOf(root, 'a.txt')).toBe('two\n')
  })

  it('counts changed and unreviewed files for the status bar', async () => {
    const root = await repository()
    await writeFile(join(root, 'a.txt'), 'two\n')
    expect(await reviewCount(root)).toEqual({ total: 1, unreviewed: 1 })
    await acceptReview(root, 'a.txt')
    expect(await reviewCount(root)).toEqual({ total: 1, unreviewed: 0 })
  })
})

describe('checkpoints', () => {
  it('stores changed files, rolls back, and keeps a pre-rollback safety copy', async () => {
    const root = await repository()
    await writeFile(join(root, 'a.txt'), 'two\n')
    const checkpoint = await createCheckpoint(root, 'before edit')
    expect(checkpoint.files).toBe(1)

    await writeFile(join(root, 'a.txt'), 'three\n')
    const rollback = await rollbackCheckpoint(root, checkpoint.id)
    expect(rollback.restored).toBe(1)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('two\n')
    expect(rollback.paths).toEqual(['a.txt'])

    const list = await reviewList(root)
    expect(list.checkpoints[0]?.label).toBe('回滚前自动备份')
    expect(list.checkpoints.some(item => item.id === checkpoint.id)).toBe(true)
  })

  it('rolls back to a checkpoint after a file is deleted', async () => {
    const root = await repository()
    await writeFile(join(root, 'a.txt'), 'two\n')
    const checkpoint = await createCheckpoint(root, 'keep two')
    await unlink(join(root, 'a.txt'))
    await rollbackCheckpoint(root, checkpoint.id)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('two\n')
  })

  it('rejects an unknown checkpoint id', async () => {
    const root = await repository()
    await expect(rollbackCheckpoint(root, 'nope')).rejects.toThrow(/检查点不存在/)
  })
})
