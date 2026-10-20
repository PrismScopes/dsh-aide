import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveTerminalDirectory, TerminalManager } from '../src/terminal.ts'
import { WorkbenchError } from '../src/wire.ts'

/**
 * 「在终端中打开」的目录解析。
 *
 * 这里测的是宿主侧的边界：客户端只给工作区相对路径，真正的绝对路径与合法性由宿主决定。
 * 不启动 pty —— 起真 shell 的用例在 CI/无终端环境里不可靠（而且会留下进程）；目录校验完全
 * 可以先于 spawn 完成，因此用一个抛错的目录就能证明 TerminalManager 走的是这套校验。
 */
describe('terminal directory resolution', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'dvw-terminal-directory-'))
    mkdirSync(join(root, 'src', 'nested'), { recursive: true })
    writeFileSync(join(root, 'file.txt'), 'x')
  })

  afterAll(() => { rmSync(root, { recursive: true, force: true }) })

  it('falls back to the workspace root when no directory is given', () => {
    expect(resolveTerminalDirectory(root)).toBe(realpathSync(root))
    // 空字符串与缺省等价：资源管理器在根目录上点「在终端中打开」时给的就是空路径。
    expect(resolveTerminalDirectory(root, '')).toBe(realpathSync(root))
  })

  it('resolves a workspace-relative directory to the real absolute directory', () => {
    expect(resolveTerminalDirectory(root, 'src')).toBe(realpathSync(join(root, 'src')))
    // 客户端路径用 '/' 分隔（文件树本来就用它），宿主必须自己归一化。
    expect(resolveTerminalDirectory(root, 'src/nested')).toBe(realpathSync(join(root, 'src', 'nested')))
  })

  it('rejects an absolute path instead of pinning the shell anywhere on disk', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows' : '/tmp'
    const error = (() => { try { resolveTerminalDirectory(root, outside) } catch (value) { return value } return undefined })()
    expect(error).toBeInstanceOf(WorkbenchError)
    expect((error as WorkbenchError).code).toBe('directory-invalid')
    expect((error as WorkbenchError).status).toBe(400)
  })

  it('rejects traversal outside the workspace', () => {
    for (const candidate of ['..', `..${sep}..`, 'src/../../outside']) {
      const error = (() => { try { resolveTerminalDirectory(root, candidate) } catch (value) { return value } return undefined })()
      expect(error).toBeInstanceOf(WorkbenchError)
      expect((error as WorkbenchError).code).toBe('directory-outside')
      expect((error as WorkbenchError).status).toBe(400)
      expect((error as WorkbenchError).message).toContain('工作区')
    }
  })

  it('reports a readable error for a directory that does not exist', () => {
    const error = (() => { try { resolveTerminalDirectory(root, 'missing-directory') } catch (value) { return value } return undefined })()
    expect(error).toBeInstanceOf(WorkbenchError)
    expect((error as WorkbenchError).code).toBe('directory-not-found')
    expect((error as WorkbenchError).status).toBe(400)
    expect((error as WorkbenchError).message).toContain('missing-directory')
  })

  it('rejects a path that is a file', () => {
    const error = (() => { try { resolveTerminalDirectory(root, 'file.txt') } catch (value) { return value } return undefined })()
    expect(error).toBeInstanceOf(WorkbenchError)
    expect((error as WorkbenchError).code).toBe('directory-invalid')
    expect((error as WorkbenchError).status).toBe(400)
  })

  it('rejects a symlink whose target lies outside the workspace', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dvw-terminal-outside-'))
    try {
      const link = join(root, 'escape')
      try {
        // Windows 上用 junction：创建目录链接不需要管理员权限；其它平台用普通目录链接。
        symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
      } catch {
        // 该环境不允许建链接（权限/文件系统），跳过这条 —— 校验逻辑本身不依赖它。
        return
      }
      const error = (() => { try { resolveTerminalDirectory(root, 'escape') } catch (value) { return value } return undefined })()
      expect(error).toBeInstanceOf(WorkbenchError)
      expect((error as WorkbenchError).code).toBe('directory-outside')
      expect((error as WorkbenchError).status).toBe(400)
    } finally { rmSync(outside, { recursive: true, force: true }) }
  })

  it('checks the directory before spawning a pty', () => {
    // TerminalManager.create 在 spawn 之前就要拒绝非法目录：用错误目录调用不能留下任何终端。
    const manager = new TerminalManager()
    expect(() => manager.create(root, undefined, undefined, '../escape')).toThrow(/工作区/)
    expect(() => manager.create(root, undefined, undefined, 'missing-directory')).toThrow(/不存在/)
    expect(manager.list(root)).toEqual([])
  })

  // 没有「真起 pty」的用例：本机跑 conpty 时，测试进程退出会触发
  // `conpty_console_list_agent` 的 AttachConsole 报错，而且 shell 还占着临时目录句柄，
  // afterAll 的清理会 EPERM。目录校验在 spawn 之前完成，上面这些用例已经覆盖了全部边界；
  // 「pty 的 cwd 就是解析结果」由 create 里唯一一处 pty.spawn 的 cwd 参数保证。
})
