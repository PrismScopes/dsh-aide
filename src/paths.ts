/**
 * 工作区 / 包目录的路径判定。
 *
 * 从 host.ts 抽出：assets.ts 需要 `inside()`，host.ts 又 re-export assets 的解析函数，
 * 两边因此形成循环 import。现在 `inside` 与「相对路径 → 工作区绝对路径」的统一校验都放在这里，
 * 依赖方向变为单向：paths.ts ← host.ts / assets.ts / terminal.ts（paths 只依赖 wire.ts 的错误类型）。
 *
 * 校验顺序固定（两处调用方原本就是这个顺序，逐字保持）：
 *   1. 词法解析：`resolve(root, raw)`，落在 root 之外即拒绝；
 *   2. `realpath` 展开符号链接；
 *   3. 展开后的目标仍在 root 之内（防止 symlink 逃逸）；
 *   4. 存在性（use 模式）或父目录存在性（create 模式）；
 *   5. 按需要求目标是目录。
 *
 * 错误码与消息不写死在这里：文件 API（`path-outside`/`not-found`，英文机器文案）与终端
 * （`directory-outside`/`directory-not-found`，面向用户的中文文案）共用同一套算法但对外表现
 * 不同，所以由调用方传入 `WorkspacePathErrors`。这是唯一允许的差异，校验强度不允许不同。
 */
import { realpath as realpathAsync, stat as statAsync } from 'node:fs/promises'
import { realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { WorkbenchError } from './wire.ts'

/** target 是否落在 root 之内（含 root 本身）。原先在 host.ts，assets.ts 也用它守卫包目录。 */
export function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** 调用方的错误构造器：同一算法、不同错误码/文案。 */
export interface WorkspacePathErrors {
  /** 词法解析后落在工作区之外。 */
  outside(raw: string): WorkbenchError
  /** realpath 展开后落在工作区之外（符号链接逃逸）。 */
  symlinkOutside(raw: string): WorkbenchError
  /** 目标（或 create 模式下的父目录）不存在，或 realpath/stat 失败。 */
  missing(raw: string): WorkbenchError
  /** `kind: 'directory'` 时目标存在但不是目录。 */
  notDirectory?(raw: string): WorkbenchError
}

export interface ExistingPathOptions {
  /** `directory`：realpath 之后还要求确实是目录（终端「在终端中打开」用）。 */
  kind?: 'any' | 'directory'
}

export interface ResolvedExistingPath {
  /** 词法解析后的绝对路径（未展开符号链接），写操作用它。 */
  absolute: string
  /** realpath 展开后的实际路径；`kind: 'directory'` 时已确认是目录。 */
  actual: string
}

export interface ResolvedCreatablePath {
  absolute: string
}

/** 词法越界检查（两种模式共用）：`raw` 为空表示 root 本身。 */
function lexicalPath(root: string, raw: string, errors: WorkspacePathErrors): string {
  const absolute = resolve(root, raw === '' ? '.' : raw)
  if (!inside(root, absolute)) throw errors.outside(raw)
  return absolute
}

function notDirectory(errors: WorkspacePathErrors, raw: string): WorkbenchError {
  return errors.notDirectory?.(raw) ?? new WorkbenchError('not-a-directory', `${raw} is not a directory`)
}

/**
 * 解析一个**必须已存在**的工作区相对路径（读/删/重命名源等）。
 * 同步版给终端用（TerminalManager 是同步 API），异步版给文件 API 用；算法与判定顺序一致。
 */
export async function resolveExistingWorkspacePath(root: string, raw: string, errors: WorkspacePathErrors, options: ExistingPathOptions = {}): Promise<ResolvedExistingPath> {
  const absolute = lexicalPath(root, raw, errors)
  let actual: string
  try { actual = await realpathAsync(absolute) } catch { throw errors.missing(raw) }
  if (!inside(root, actual)) throw errors.symlinkOutside(raw)
  if (options.kind === 'directory') {
    let isDirectory: boolean
    try { isDirectory = (await statAsync(actual)).isDirectory() } catch { throw errors.missing(raw) }
    if (!isDirectory) throw notDirectory(errors, raw)
  }
  return { absolute, actual }
}

export function resolveExistingWorkspacePathSync(root: string, raw: string, errors: WorkspacePathErrors, options: ExistingPathOptions = {}): ResolvedExistingPath {
  const absolute = lexicalPath(root, raw, errors)
  let actual: string
  try { actual = realpathSync(absolute) } catch { throw errors.missing(raw) }
  if (!inside(root, actual)) throw errors.symlinkOutside(raw)
  if (options.kind === 'directory') {
    let isDirectory: boolean
    try { isDirectory = statSync(actual).isDirectory() } catch { throw errors.missing(raw) }
    if (!isDirectory) throw notDirectory(errors, raw)
  }
  return { absolute, actual }
}

/**
 * 解析一个**允许不存在**的目标（新建/上传/重命名目标等）：只要求父目录存在且仍在工作区内，
 * 目标本身留给后续 open/mkdir/rename 去创建。父目录经 realpath 展开，防止借符号链接越界。
 */
export async function resolveCreatableWorkspacePath(root: string, raw: string, errors: WorkspacePathErrors): Promise<ResolvedCreatablePath> {
  const absolute = lexicalPath(root, raw, errors)
  let parent: string
  try { parent = await realpathAsync(dirname(absolute)) } catch { throw errors.missing(raw) }
  if (!inside(root, parent)) throw errors.symlinkOutside(raw)
  return { absolute }
}
