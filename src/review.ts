/**
 * 工作区改动审查与检查点。
 *
 * 职责边界：本模块只回答「磁盘上现在和上次见过的时候相比，改了什么」以及「怎么把这些改动退回去」。
 * 它不判断改动来自 DSH Agent 还是用户手改 —— 两者都写同一批文件，宿主没有可信的来源标注，
 * 与其猜，不如把语义说清楚：这里是**工作区改动**，不是「Agent 改动」。
 *
 * 基线来源有两层：
 *   - 工作台读/存过的文件：进程内记住内容（打开过的文件都在这一层，diff 最精确）；
 *   - 没读过的受版本控制文件：退回 `git show HEAD:<path>`（改动多来自 agent 时，这一层覆盖最广）。
 * 两层都没有（新文件、无 git）时返回空基线，客户端显示为新增文件而不是「无法对比」。
 *
 * 检查点写在 `.dsh-workbench/checkpoints.json`（该目录自带 `*` 的 .gitignore）：
 * 回滚前自动把当前状态再存一份，回滚本身因此可撤销。
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { gitStatus, restoreDocument, run, workspacePath } from './host.ts'
import type { FileDocument } from './types.ts'

/** 基线内存表的上限：工作台打开过的文件通常远小于它，超出按最旧淘汰。 */
const BASELINE_LIMIT = 300
/** 单个文件基线/检查点内容的字符上限；再大就不进内存、也不进检查点。 */
const FILE_MAX_CHARS = 1_000_000
/** 一次 `review.list` 为了判断「已审查」最多读多少字符；超预算的文件标记为未确认。 */
const REVIEW_READ_BUDGET = 16_000_000
/** 检查点保留条数与总字符上限（JSON 落盘，太大会拖慢每一次建立检查点）。 */
const CHECKPOINT_LIMIT = 20
const CHECKPOINT_TOTAL_CHARS = 8_000_000
/** 整个检查点库的上限：20 个满额检查点会到 160MB，必须按总量再收一次。 */
const CHECKPOINTS_STORE_CHARS = 16_000_000
const CHECKPOINT_DIR = '.dsh-workbench'
const CHECKPOINT_FILE = 'checkpoints.json'

function checkpointChars(checkpoint: StoredCheckpoint): number {
  return checkpoint.entries.reduce((total, entry) => total + (entry.content?.length ?? 0), 0)
}

interface BaselineEntry { content: string; at: number }
const baselines = new Map<string, BaselineEntry>()
/** 用户已确认的删除：文件已不在磁盘上，没有内容可作基线，只能单独记一笔。 */
const confirmedDeletes = new Set<string>()

function baselineKey(cwd: string, path: string): string { return `${normalize(cwd)}\0${path}` }

/** 记住一个文件的当前内容，作为下一次改动的对比基线。 */
export function rememberBaseline(cwd: string, path: string, content: string): void {
  if (content.length > FILE_MAX_CHARS) return
  const key = baselineKey(cwd, path)
  baselines.delete(key)
  baselines.set(key, { content, at: Date.now() })
  while (baselines.size > BASELINE_LIMIT) {
    const oldest = baselines.keys().next()
    if (oldest.done === true) break
    baselines.delete(oldest.value)
  }
}

/** 当前基线；没有时返回 undefined。 */
export function baselineOf(cwd: string, path: string): string | undefined { return baselines.get(baselineKey(cwd, path))?.content }

/** 测试/切换工作区时清空。 */
export function forgetBaselines(): void { baselines.clear(); confirmedDeletes.clear() }

/** 一个改动文件在审查列表里的形状。 */
export interface ReviewFile {
  path: string
  /** git status 的工作区状态字母；未跟踪是 `??`。 */
  status: string
  untracked: boolean
  /** 受版本控制（非未跟踪文件）：没有内存基线时仍可从 HEAD 还原。 */
  tracked: boolean
  /** 基线来源：进程内记忆，或还没有基线。 */
  baseline: 'baseline' | 'none'
  /** 基线内容与磁盘内容一致（用户已经确认过这次改动）。 */
  reviewed: boolean
}

export interface ReviewSnapshot { files: ReviewFile[]; checkpoints: CheckpointSummary[] }

export interface CheckpointSummary { id: string; at: number; label: string; files: number; skipped: number }

interface StoredCheckpoint extends CheckpointSummary { entries: Array<{ path: string; content: string | null }> }

/** 读磁盘上的改动内容；文件不存在（被删）返回 null。 */
async function readOptional(cwd: string, path: string): Promise<string | null> {
  let absolute: string
  try {
    ({ absolute } = await workspacePath(cwd, path))
  } catch {
    return null
  }
  try {
    const info = await stat(absolute)
    if (!info.isFile() || info.size > FILE_MAX_CHARS * 4) return null
    return await readFile(absolute, 'utf8')
  } catch { return null }
}

/** 文件是否真的在磁盘上（区分「被删除」与「太大/读不了」）。 */
async function fileExists(cwd: string, path: string): Promise<boolean> {
  try {
    const { absolute } = await workspacePath(cwd, path)
    return (await stat(absolute)).isFile()
  } catch { return false }
}

/** `git show HEAD:<path>`：受版本控制文件的「上次提交」内容；不跟踪/无 HEAD 时返回 undefined。 */
async function gitHeadContent(cwd: string, path: string): Promise<string | undefined> {
  try {
    const result = await run('git', ['show', `HEAD:${path}`], cwd, 10_000)
    return result.code === 0 ? result.stdout : undefined
  } catch { return undefined }
}

/** 当前工作区改动清单（只算 git 状态，不读文件内容）。
 *
 * `git status` 是一次进程调用（Windows 上约 100–200ms）；文件变化事件成串到达时，
 * 400ms 合并窗口叠加面板刷新仍可能连续触发多次。这里按工作区缓存 1.5 秒，
 * 还原/回滚这类真的改变了状态的操作会主动清掉缓存。
 */
const STATUS_TTL_MS = 1_500
const statusCache = new Map<string, { at: number; value: Promise<Array<{ path: string; status: string; untracked: boolean }>> }>()

function changedFiles(cwd: string): Promise<Array<{ path: string; status: string; untracked: boolean }>> {
  const key = normalize(cwd)
  const cached = statusCache.get(key)
  if (cached !== undefined && Date.now() - cached.at <= STATUS_TTL_MS) return cached.value
  const value = loadChangedFiles(cwd)
  value.catch(() => { if (statusCache.get(key)?.value === value) statusCache.delete(key) })
  statusCache.set(key, { at: Date.now(), value })
  return value
}

/** 文件状态真的变了之后清缓存（还原/回滚/切换工作区）。 */
export function invalidateReviewStatus(cwd?: string): void {
  if (cwd === undefined) statusCache.clear()
  else statusCache.delete(normalize(cwd))
}

async function loadChangedFiles(cwd: string): Promise<Array<{ path: string; status: string; untracked: boolean }>> {
  try {
    const status = await gitStatus(cwd)
    return status.changes.map(change => ({
      path: change.path,
      status: change.untracked ? '??' : (change.worktree !== ' ' ? change.worktree : change.index),
      untracked: change.untracked,
    }))
  } catch {
    // 不是 git 仓库：退回「所有工作台见过但内容变了的文件」也可以，但这里不做全盘扫描，
    // 返回空列表，客户端显示一句「当前工作区没有可审查的改动」。
    return []
  }
}

/**
 * 列出改动并标出「已确认」。
 *
 * 这里**不**为每个文件去读 `git show HEAD`：那是一次进程调用，几十个改动文件就会把面板刷新
 * 拖到几秒。清单只需要回答「有没有看过」，内存基线足够；HEAD 内容在打开差异与点还原时再取。
 */
export async function reviewList(cwd: string): Promise<ReviewSnapshot> {
  const files = await changedFiles(cwd)
  const rows: ReviewFile[] = []
  let budget = REVIEW_READ_BUDGET
  for (const file of files) {
    const confirmedDelete = confirmedDeletes.has(baselineKey(cwd, file.path))
    const baseline = baselineOf(cwd, file.path)
    let reviewed = false
    if (baseline !== undefined && baseline.length <= budget) {
      const current = await readOptional(cwd, file.path)
      if (current !== null) {
        budget -= Math.min(baseline.length, current.length)
        reviewed = current === baseline
      } else if (file.status === 'D' && confirmedDelete) {
        // 删除没有可存的内容：用户点过「确认删除」才算已审查，否则一直提醒。
        reviewed = true
      }
    }
    rows.push({ path: file.path, status: file.status, untracked: file.untracked, tracked: !file.untracked, baseline: baseline === undefined ? 'none' : 'baseline', reviewed })
  }
  rows.sort((left, right) => Number(left.reviewed) - Number(right.reviewed) || left.path.localeCompare(right.path))
  return { files: rows, checkpoints: (await readCheckpoints(cwd)).map(summaryOf) }
}

/** 一次 diff 的内容；二进制文件只给标记，不带正文。 */
export interface ReviewDiff {
  path: string
  before: string
  after: string
  /** 基线来源：进程内记忆、git HEAD，或完全没有基线（新文件）。 */
  source: 'baseline' | 'git' | 'none'
  binary: boolean
  /** 文件过大（超过 1MB）：不把正文塞进响应，面板给一句提示。 */
  tooLarge: boolean
  /** 文件已从磁盘删除：after 为空串，仍可还原。 */
  deleted: boolean
}

export async function reviewDiff(cwd: string, path: string): Promise<ReviewDiff> {
  let before = baselineOf(cwd, path)
  let source: ReviewDiff['source'] = before === undefined ? 'none' : 'baseline'
  if (before === undefined) {
    before = await gitHeadContent(cwd, path)
    if (before !== undefined) { rememberBaseline(cwd, path, before); source = 'git' }
  }
  const after = await readOptional(cwd, path)
  const binary = (before ?? '').includes('\0') || (after ?? '').includes('\0')
  const tooLarge = (before?.length ?? 0) > FILE_MAX_CHARS || (after?.length ?? 0) > FILE_MAX_CHARS
  return { path, before: tooLarge ? '' : before ?? '', after: tooLarge ? '' : after ?? '', source, binary, tooLarge, deleted: after === null && !(await fileExists(cwd, path)) }
}

/** 确认一次改动：把当前内容记为新的基线；文件已删除时记一笔「已确认删除」。 */
export async function acceptReview(cwd: string, path: string): Promise<{ reviewed: true }> {
  const current = await readOptional(cwd, path)
  if (current === null) { confirmedDeletes.add(baselineKey(cwd, path)); return { reviewed: true } }
  confirmedDeletes.delete(baselineKey(cwd, path))
  rememberBaseline(cwd, path, current)
  return { reviewed: true }
}

/** 确认列表里的全部改动（客户端批量操作）。 */
export async function acceptAllReview(cwd: string, paths: readonly string[]): Promise<{ reviewed: number }> {
  let reviewed = 0
  for (const path of paths) {
    const current = await readOptional(cwd, path)
    if (current === null) { confirmedDeletes.add(baselineKey(cwd, path)); reviewed++; continue }
    confirmedDeletes.delete(baselineKey(cwd, path))
    rememberBaseline(cwd, path, current)
    reviewed++
  }
  return { reviewed }
}

/**
 * 把文件还原到基线（或从基线删除）。
 *
 * 删除的文件（基线存在、磁盘没有）会被重新写出来；没有基线的文件拒绝还原 —— 没有「原样」可用。
 * 还原成功之后基线被同步成写回去的内容，列表里这条会变成已确认。
 */
export async function restoreReview(cwd: string, path: string): Promise<{ restored: boolean; reason?: string }> {
  let before = baselineOf(cwd, path)
  // 没打开过的受版本控制文件：第一次还原时才去取 HEAD 内容（一次进程调用，只在用户点的时候发生）。
  if (before === undefined) before = await gitHeadContent(cwd, path)
  if (before === undefined) return { restored: false, reason: '没有可用的基线（文件可能尚未提交），无法还原' }
  const after = await readOptional(cwd, path)
  if (after === before) return { restored: false, reason: '文件与基线一致，无需还原' }
  // 还原会覆盖磁盘上的当前内容：先自动备份一份（失败不阻断 —— 用户已经明确要求还原）。
  await createCheckpoint(cwd, `还原前自动备份：${path}`, [path]).catch(() => undefined)
  if (after !== null) rememberBaseline(cwd, path, after)
  await restoreDocument(cwd, path, before)
  invalidateReviewStatus(cwd)
  confirmedDeletes.delete(baselineKey(cwd, path))
  rememberBaseline(cwd, path, before)
  return { restored: true }
}

//#region 检查点

/** 检查点文件路径；顺带保证目录存在并自带忽略规则。 */
async function checkpointPath(cwd: string): Promise<string> {
  const directory = join(cwd, CHECKPOINT_DIR)
  await mkdir(directory, { recursive: true }).catch(() => undefined)
  await writeFile(join(directory, '.gitignore'), '*\n', 'utf8').catch(() => undefined)
  return join(directory, CHECKPOINT_FILE)
}

async function readCheckpoints(cwd: string): Promise<StoredCheckpoint[]> {
  try {
    const raw = await readFile(await checkpointPath(cwd), 'utf8')
    const value = JSON.parse(raw) as { version?: unknown; checkpoints?: unknown }
    if (value === null || typeof value !== 'object' || !Array.isArray(value.checkpoints)) return []
    return value.checkpoints.filter(isStoredCheckpoint)
  } catch { return [] }
}

function isStoredCheckpoint(value: unknown): value is StoredCheckpoint {
  if (value === null || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return typeof row['id'] === 'string' && typeof row['at'] === 'number' && typeof row['label'] === 'string' && Array.isArray(row['entries'])
}

async function writeCheckpoints(cwd: string, list: StoredCheckpoint[]): Promise<void> {
  const kept = list.slice(0, CHECKPOINT_LIMIT)
  // 按总量从最旧的开始丢：宁可少留几个历史检查点，也不要把检查点文件写成几十 MB。
  let total = kept.reduce((sum, checkpoint) => sum + checkpointChars(checkpoint), 0)
  while (kept.length > 1 && total > CHECKPOINTS_STORE_CHARS) {
    const removed = kept.pop()
    if (removed === undefined) break
    total -= checkpointChars(removed)
  }
  const target = await checkpointPath(cwd)
  // 先写临时文件再 rename：中途崩溃不会留下半截 JSON，否则下次读取会把整个检查点库当成坏数据。
  const temp = `${target}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(temp, JSON.stringify({ version: 1, checkpoints: kept }), 'utf8')
  await rename(temp, target)
}

function summaryOf(checkpoint: StoredCheckpoint): CheckpointSummary {
  return { id: checkpoint.id, at: checkpoint.at, label: checkpoint.label, files: checkpoint.entries.length, skipped: checkpoint.skipped }
}

/**
 * 建立检查点：把当前所有改动文件的内容存一份。
 *
 * 超过单文件或总量上限时整次拒绝而不是悄悄少存：一个不完整的检查点会在回滚时造成
 * 「一半文件退回去、一半没退」，比没有检查点更危险。
 */
export async function createCheckpoint(cwd: string, label: string, extraPaths: readonly string[] = []): Promise<CheckpointSummary> {
  const files = await changedFiles(cwd)
  const paths = [...new Set([...files.map(file => file.path), ...extraPaths])]
  const entries: Array<{ path: string; content: string | null }> = []
  let total = 0
  for (const path of paths) {
    const content = await readOptional(cwd, path)
    if (content !== null && content.length > FILE_MAX_CHARS) {
      throw new Error(`文件 ${path} 超过 1MB，无法建立完整检查点`)
    }
    const size = content?.length ?? 0
    if (total + size > CHECKPOINT_TOTAL_CHARS) throw new Error('工作区改动过大，无法建立检查点（超过 8MB）')
    total += size
    entries.push({ path, content })
  }
  const checkpoint: StoredCheckpoint = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    label,
    files: entries.length,
    skipped: 0,
    entries,
  }
  const list = await readCheckpoints(cwd)
  await writeCheckpoints(cwd, [checkpoint, ...list])
  return summaryOf(checkpoint)
}

/** 回滚到某个检查点；回滚前自动把当前状态存为「回滚前」检查点，所以回滚本身可撤销。 */
export async function rollbackCheckpoint(cwd: string, id: string): Promise<{ restored: number; skipped: number; checkpoint: CheckpointSummary | null; paths: string[] }> {
  const list = await readCheckpoints(cwd)
  const target = list.find(checkpoint => checkpoint.id === id)
  if (target === undefined) throw new Error('检查点不存在或已被清理')
  const safety = await createCheckpoint(cwd, '回滚前自动备份', target.entries.map(entry => entry.path))
  let restored = 0
  let skipped = 0
  for (const entry of target.entries) {
    try {
      await restoreDocument(cwd, entry.path, entry.content)
      if (entry.content !== null) rememberBaseline(cwd, entry.path, entry.content)
      restored++
    } catch { skipped++ }
  }
  invalidateReviewStatus(cwd)
  return { restored, skipped, checkpoint: safety, paths: target.entries.map(entry => entry.path) }
}

/** 删除一个检查点。 */
export async function deleteCheckpoint(cwd: string, id: string): Promise<{ deleted: boolean }> {
  const list = await readCheckpoints(cwd)
  const next = list.filter(checkpoint => checkpoint.id !== id)
  if (next.length === list.length) return { deleted: false }
  await writeCheckpoints(cwd, next)
  return { deleted: true }
}

//#endregion

/** 供 api.ts 在 fs.read/fs.save 之后记录基线；只记录文本内容。 */
export function rememberDocumentBaseline(cwd: string, document: FileDocument): void {
  if (document.binary || document.tooLarge) return
  rememberBaseline(cwd, document.path, document.content)
}

/** 清空某个工作区的基线（工作区切换/测试用）。 */
export function clearWorkspaceBaselines(cwd: string): void {
  const prefix = `${normalize(cwd)}\0`
  for (const key of [...baselines.keys()]) if (key.startsWith(prefix)) baselines.delete(key)
  for (const key of [...confirmedDeletes]) if (key.startsWith(prefix)) confirmedDeletes.delete(key)
  invalidateReviewStatus(cwd)
}
