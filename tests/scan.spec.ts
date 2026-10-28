import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { scanProject } from '../src/language/scan.ts'

/**
 * 工作区扫描的「一次程序、一次检查」实现。
 *
 * 这里不重复 TypeScript 的语义检查细节（provider 测试已覆盖映射），只钉住新实现与旧实现不同的
 * 关键契约：诊断按文件分组、空文件也回调（用于清旧问题）、open document 覆盖磁盘、total 与取消。
 */
async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dvw-scan-'))
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(root, name), content, 'utf8')))
  return root
}

const COMPILER_OPTIONS: import('typescript').CompilerOptions = {
  strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, noEmit: true, skipLibCheck: true,
}

describe('scanProject', () => {
  it('checks the whole program once and reports every non-declaration file', async () => {
    const root = await makeWorkspace({
      'a.ts': 'export const ok: number = 1\n',
      'b.ts': 'const bad: number = "x"\n',
      'empty.ts': '',
    })
    try {
      const totals: number[] = []
      const seen: { path: string; diagnostics: number }[] = []
      const result = await scanProject(ts, {
        workspace: root, compilerOptions: COMPILER_OPTIONS, openDocuments: [],
        rootFiles: [join(root, 'a.ts'), join(root, 'b.ts'), join(root, 'empty.ts')],
      }, (path, diagnostics) => { seen.push({ path, diagnostics: diagnostics.length }) }, undefined, total => totals.push(total))
      expect(result.checked).toBe(3)
      expect(result.errors).toBeGreaterThanOrEqual(1)
      expect(totals).toEqual([3])
      // 三个文件都必须回调（包括空诊断），否则旧问题不会被清掉。
      expect(seen).toHaveLength(3)
      expect(seen.some(file => file.path.endsWith('b.ts') && file.diagnostics > 0)).toBe(true)
      expect(seen.find(file => file.path.endsWith('a.ts'))?.diagnostics).toBe(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('uses in-memory open documents instead of disk content', async () => {
    const root = await makeWorkspace({ 'a.ts': 'export const ok: number = 1\n' })
    try {
      const seen: number[] = []
      await scanProject(ts, {
        workspace: root, compilerOptions: COMPILER_OPTIONS,
        rootFiles: [join(root, 'a.ts')],
        openDocuments: [{ path: join(root, 'a.ts'), languageId: 'typescript', version: 2, content: 'const bad: number = "x"\n' }],
      }, (_path, diagnostics) => { seen.push(diagnostics.length) })
      expect(seen[0]).toBeGreaterThan(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('honours a pre-aborted signal without checking anything', async () => {
    const root = await makeWorkspace({ 'a.ts': 'export const ok: number = 1\n' })
    try {
      const controller = new AbortController()
      controller.abort()
      const seen: string[] = []
      const result = await scanProject(ts, {
        workspace: root, compilerOptions: COMPILER_OPTIONS, openDocuments: [], rootFiles: [join(root, 'a.ts')],
      }, path => { seen.push(path) }, controller.signal)
      expect(result).toEqual({ checked: 0, errors: 0, warnings: 0 })
      expect(seen).toHaveLength(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
