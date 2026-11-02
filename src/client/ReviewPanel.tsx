import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import { Icon } from './Icon.tsx'
import type { BottomPanelProps } from './service.ts'
import { workspaceAbsolutePath } from './menus.ts'

/**
 * 「改动」底部面板：列出工作区里与基线不同的文件，打开差异、确认、还原，并管理检查点。
 *
 * 数据全部来自宿主的 `review.*` 方法：面板不自己读盘、不自己跑 git，也就不需要复制路径校验
 * 与编码处理。这里只负责把「当前状态」画出来，并把用户的决定发回去。
 *
 * 还原与回滚都是破坏性操作，点一次只进入「再次确认」状态，第二次点击才执行 —— 与 Git 面板
 * 丢弃改动同一套交互。文件变化事件来自工作台已有的文件监听，刷新合并到 400ms 一次。
 */

export const REVIEW_DIFF_EVENT = 'dvw-review-diff'

interface ReviewFileView { path: string; status: string; untracked: boolean; tracked: boolean; baseline: 'baseline' | 'none'; reviewed: boolean }
interface CheckpointView { id: string; at: number; label: string; files: number; skipped: number }
interface ReviewSnapshotView { files: ReviewFileView[]; checkpoints: CheckpointView[] }
interface ReviewDiffView { path: string; before: string; after: string; source: string; binary: boolean; tooLarge: boolean; deleted: boolean }

/** 错误统一成一句可读的话；宿主返回的是 WorkbenchError 的 message。 */
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** git status 的字符在界面里统一成一个字母；未跟踪显示为 U。 */
export function reviewStatusKey(status: string): string {
  if (status === '??' || status === '') return 'U'
  const first = status.replace(/\s/g, '').charAt(0)
  return first === '' ? 'U' : first.toUpperCase()
}

/** 检查点时间：只显示时分秒，日期放在 title 上。 */
export function checkpointTime(at: number): string {
  const date = new Date(at)
  return Number.isFinite(at) ? date.toLocaleTimeString('zh-CN', { hour12: false }) : ''
}

export function ReviewPanel(props: BottomPanelProps) {
  const [snapshot, setSnapshot] = useState<ReviewSnapshotView>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [pendingRestore, setPendingRestore] = useState<string>()
  const [pendingRollback, setPendingRollback] = useState<string>()

  const load = useCallback(async () => {
    if (props.sessionId === '') return
    try {
      setSnapshot(await api<ReviewSnapshotView>('review.list', { sessionId: props.sessionId }))
      setError(undefined)
    } catch (failure) { setError(messageOf(failure)) }
  }, [props.sessionId])

  useEffect(() => { if (props.visible) void load() }, [props.visible, load])

  // 监听工作台的文件变化：agent 写完文件后列表自己跟上，不需要用户手动刷新。
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    const onChange = () => {
      clearTimeout(timer.current)
      timer.current = setTimeout(() => void load(), 400)
    }
    window.addEventListener('dvw-files-changed', onChange)
    return () => { clearTimeout(timer.current); window.removeEventListener('dvw-files-changed', onChange) }
  }, [load])

  const run = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(key); setError(undefined)
    try { await action(); await load() } catch (failure) { setError(messageOf(failure)) } finally { setBusy(undefined) }
  }

  /** 还原/回滚之后让工作台重读受影响的标签（脏标签仍保留草稿，由工作台自己判断）。 */
  const reloadTabs = (paths: readonly string[]): void => {
    if (paths.length === 0) return
    window.dispatchEvent(new CustomEvent('dvw-reload-files', { detail: paths.map(path => workspaceAbsolutePath(props.cwd, path)) }))
  }

  const openDiff = async (file: ReviewFileView): Promise<void> => {
    setPendingRestore(undefined)
    setBusy(`diff:${file.path}`); setError(undefined)
    try {
      const diff = await api<ReviewDiffView>('review.diff', { sessionId: props.sessionId, path: file.path })
      if (diff.binary) { setError('二进制文件无法以文本方式对比'); return }
      if (diff.tooLarge) { setError('文件超过 1MB，不在面板里做文本对比'); return }
      window.dispatchEvent(new CustomEvent(REVIEW_DIFF_EVENT, { detail: { path: file.path, before: diff.before, after: diff.after } }))
    } catch (failure) { setError(messageOf(failure)) } finally { setBusy(undefined) }
  }

  const accept = (file: ReviewFileView): void => {
    setPendingRestore(undefined)
    void run(`accept:${file.path}`, () => api('review.accept', { sessionId: props.sessionId, path: file.path }))
  }

  const restore = (file: ReviewFileView): void => {
    setPendingRestore(undefined)
    void run(`restore:${file.path}`, async () => {
      const result = await api<{ restored: boolean; reason?: string }>('review.restore', { sessionId: props.sessionId, path: file.path })
      if (!result.restored && result.reason !== undefined) setError(result.reason)
      if (result.restored) reloadTabs([file.path])
    })
  }

  const acceptAll = (): void => {
    const paths = (snapshot?.files ?? []).filter(file => !file.reviewed).map(file => file.path)
    if (paths.length === 0) return
    void run('accept-all', () => api('review.acceptAll', { sessionId: props.sessionId, paths }))
  }

  const checkpoint = (): void => {
    const label = `手动检查点 ${checkpointTime(Date.now())}`
    void run('checkpoint', () => api('review.checkpoint', { sessionId: props.sessionId, label }))
  }

  const rollback = (target: CheckpointView): void => {
    setPendingRollback(undefined)
    void run(`rollback:${target.id}`, async () => {
      const result = await api<{ restored: number; skipped: number; paths: string[] }>('review.rollback', { sessionId: props.sessionId, id: target.id })
      reloadTabs(result.paths)
      if (result.skipped > 0) setError(`有 ${result.skipped} 个文件未能还原（可能已无权限或路径不存在）`)
    })
  }

  const files = snapshot?.files ?? []
  const checkpoints = snapshot?.checkpoints ?? []
  const unreviewed = files.filter(file => !file.reviewed).length
  return <div className="dvw-review">
    <header className="dvw-review-toolbar">
      <button type="button" className="dvw-review-button" onClick={checkpoint} disabled={busy !== undefined}>建立检查点</button>
      <button type="button" className="dvw-review-button" onClick={acceptAll} disabled={busy !== undefined || unreviewed === 0}>全部确认</button>
      <button type="button" className="dvw-icon" title="刷新改动列表" aria-label="刷新改动列表" onClick={() => void load()}><Icon name="refresh"/></button>
      <span className="dvw-review-count">{files.length === 0 ? '没有改动' : `${unreviewed} 个未确认 / 共 ${files.length} 个改动`}</span>
    </header>
    {error !== undefined && <div className="dvw-review-error" role="alert">{error}</div>}
    <div className="dvw-review-body">
      <div className="dvw-review-files" aria-label="工作区改动">
        {files.length === 0 && <div className="dvw-review-empty">当前工作区没有可审查的改动。</div>}
        {files.map(file => <div className="dvw-review-row" data-reviewed={file.reviewed || undefined} key={file.path}>
          <span className="dvw-review-status" data-status={reviewStatusKey(file.status)} title={file.status}>{reviewStatusKey(file.status)}</span>
          <button type="button" className="dvw-review-path" title={file.path} onClick={() => void openDiff(file)}>{file.path}</button>
          {file.baseline === 'none' && file.tracked && <span className="dvw-review-tag" title="没有打开过这个文件，还原时使用上次提交的内容">对比提交</span>}
          {file.untracked && <span className="dvw-review-tag" data-warn="true" title="未跟踪的新文件：没有基线，无法还原">新文件</span>}
          <span className="dvw-review-actions">
            <button type="button" className="dvw-review-button" onClick={() => void openDiff(file)} disabled={busy !== undefined}>差异</button>
            {pendingRestore === file.path
              ? <button type="button" className="dvw-review-button" data-danger="true" onClick={() => restore(file)} disabled={busy !== undefined}>确认还原</button>
              : <button type="button" className="dvw-review-button" onClick={() => { setPendingRestore(file.path); setPendingRollback(undefined) }} disabled={busy !== undefined || (file.baseline === 'none' && !file.tracked)}>还原</button>}
            <button type="button" className="dvw-review-button" onClick={() => accept(file)} disabled={busy !== undefined || file.reviewed}>{file.reviewed ? '已确认' : '确认'}</button>
          </span>
        </div>)}
      </div>
      <aside className="dvw-review-side" aria-label="检查点">
        <div className="dvw-review-section" title="回滚只恢复检查点里记录的文件；检查点之后新建的文件会保留">检查点</div>
        {checkpoints.length === 0 && <div className="dvw-review-empty">还没有检查点。建立检查点后可以整体回滚。</div>}
        {checkpoints.map(item => <div className="dvw-review-checkpoint" key={item.id}>
          <div className="dvw-review-checkpoint-main">
            <span className="dvw-review-checkpoint-label" title={item.label}>{item.label}</span>
            <span className="dvw-review-checkpoint-meta" title={new Date(item.at).toLocaleString('zh-CN', { hour12: false })}>{checkpointTime(item.at)} · {item.files} 个文件</span>
          </div>
          {pendingRollback === item.id
            ? <button type="button" className="dvw-review-button" data-danger="true" onClick={() => rollback(item)} disabled={busy !== undefined}>确认回滚</button>
            : <button type="button" className="dvw-review-button" onClick={() => { setPendingRollback(item.id); setPendingRestore(undefined) }} disabled={busy !== undefined}>回滚</button>}
          <button type="button" className="dvw-icon" title="删除检查点" aria-label={`删除检查点 ${item.label}`} onClick={() => void run(`delete:${item.id}`, () => api('review.checkpoint.delete', { sessionId: props.sessionId, id: item.id }))}><Icon name="trash"/></button>
        </div>)}
      </aside>
    </div>
  </div>
}
