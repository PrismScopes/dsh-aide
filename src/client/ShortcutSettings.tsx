import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon.tsx'
import {
  bindingConflict,
  bindingFromEvent,
  formatBinding,
  modifiedShortcutCount,
  resetAllKeyBindings,
  resetKeyBinding,
  searchShortcutRows,
  setKeyBinding,
  useKeybindings,
  type CommandId,
  type ShortcutRow,
} from './keybindings.ts'

/**
 * 设置页里的「快捷键」入口与面板。
 *
 * 与 DSH 自己的快捷键设置同一套形式：设置页只留**一行**入口（标题 + 说明 + 「查看」按钮），
 * 点开的是一个独立面板（对话框），里面才是搜索、分组列表与就地录制。不再把二十来行键位
 * 平铺在设置页里 —— 那会把一页设置撑得又长又难扫。
 */
export function ShortcutSettingsRow() {
  const [open, setOpen] = useState(false)
  const opener = useRef<HTMLButtonElement | null>(null)
  const close = () => {
    setOpen(false)
    // 关掉面板后把焦点还给入口按钮，键盘用户不会掉到页面顶部。
    opener.current?.focus()
  }
  return <>
    <div className="dvw-set-row">
      <div className="dvw-set-text">
        <span className="dvw-set-title">快捷键面板</span>
        <span className="dvw-set-desc">打开快捷键面板：可按命令名或键帽搜索，点键帽就地录制新的组合键；编辑器内置键位（查找、替换等）只读。</span>
      </div>
      <div className="dvw-set-control">
        <button ref={opener} type="button" className="dvw-set-button" aria-label="打开快捷键设置" onClick={() => setOpen(true)}>查看</button>
      </div>
    </div>
    {open && <ShortcutDialog onClose={close}/>}
  </>
}

/** 快捷键面板：挂到 body 上，避免被设置页的滚动容器裁剪。 */
export function ShortcutDialog({ onClose }: { onClose(): void }) {
  return createPortal(<ShortcutDialogContent onClose={onClose}/>, document.body)
}

/** 面板内容（不含 portal，便于静态渲染测试）。 */
export function ShortcutDialogContent({ onClose }: { onClose(): void }) {
  const overrides = useKeybindings()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | undefined>(undefined)
  const [resetArmed, setResetArmed] = useState(false)
  const search = useRef<HTMLInputElement | null>(null)
  // 录制器要自己吃掉 Esc；对话框的 Esc 处理需要知道「现在是在录制」，用 ref 避开同一次
  // keydown 里 state 还没提交的竞态。
  const editingRef = useRef<string | undefined>(undefined)
  editingRef.current = editing
  useEffect(() => {
    search.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.code !== 'Escape') return
      if (event.ctrlKey || event.altKey || event.shiftKey) return
      // 正在录制：交给录制器取消（它自己会 stopPropagation），不要顺手把面板也关掉。
      if (editingRef.current !== undefined) return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const rows = searchShortcutRows(query, overrides)
  // 分组顺序取行出现的顺序：定义表里的顺序就是面板想要的顺序，不另维护一份分组表。
  const groups = [...new Set(rows.map(row => row.group))]
  const modified = modifiedShortcutCount(overrides)
  return <div className="dvw-shortcut-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="dvw-shortcut-dialog" role="dialog" aria-modal="true" aria-label="快捷键">
      <header className="dvw-shortcut-dialog-head">
        <span className="dvw-shortcut-dialog-title">快捷键</span>
        <button type="button" className="dvw-icon dvw-shortcut-dialog-close" aria-label="关闭快捷键设置" onClick={onClose}><Icon name="close"/></button>
      </header>
      <div className="dvw-shortcut-dialog-search">
        <input ref={search} className="dvw-set-input" type="search" aria-label="搜索快捷键" placeholder="搜索命令或键帽"
          value={query} onChange={event => { setQuery(event.target.value); setEditing(undefined) }}/>
      </div>
      <div className="dvw-shortcut-dialog-list">
        {groups.map(group => <div className="dvw-set-shortcut-group" key={group}>
          <h4 className="dvw-set-subgroup">{group}</h4>
          {rows.filter(row => row.group === group).map(row => <ShortcutRowView key={row.id} row={row} editing={editing === row.id}
            onEdit={() => setEditing(row.id)} onDone={() => setEditing(undefined)}/>)}
        </div>)}
        {rows.length === 0 && <div className="dvw-set-row">
          <div className="dvw-set-text"><span className="dvw-set-desc">没有匹配的快捷键。</span></div>
        </div>}
      </div>
      <footer className="dvw-shortcut-dialog-foot">
        <span className="dvw-set-desc">{modified === 0 ? '当前没有改过的快捷键' : `已修改 ${modified} 项`}（编辑器内置键位不参与恢复）</span>
        {resetArmed
          ? <>
            <button type="button" className="dvw-set-button dvw-set-button-danger" onClick={() => { resetAllKeyBindings(); setResetArmed(false); setEditing(undefined) }}>确认恢复</button>
            <button type="button" className="dvw-set-button dvw-set-button-secondary" onClick={() => setResetArmed(false)}>取消</button>
          </>
          : <button type="button" className="dvw-set-button" disabled={modified === 0} onClick={() => setResetArmed(true)}>恢复全部默认</button>}
      </footer>
    </div>
  </div>
}

/** 一行快捷键：可改命令点键帽进录制，固定键位只展示键帽。 */
function ShortcutRowView({ row, editing, onEdit, onDone }: { row: ShortcutRow; editing: boolean; onEdit(): void; onDone(): void }) {
  // 固定键位与「未绑定」没有冲突可言；其余用当前生效键位与全部命令（含固定项）比较。
  const conflict = row.fixed || row.binding === null ? undefined : bindingConflict(row.binding, row.id as CommandId)
  return <div className="dvw-set-row dvw-set-shortcut">
    <div className="dvw-set-text">
      <span className="dvw-set-title">{row.label}</span>
      {conflict !== undefined && <span className="dvw-set-desc dvw-set-conflict">与「{conflict.label}」冲突</span>}
    </div>
    <div className="dvw-set-control">
      {editing && !row.fixed
        ? <ShortcutRecorder id={row.id as CommandId} label={row.label} onDone={onDone}/>
        : <button type="button" className="dvw-set-shortcut-keys" data-fixed={row.fixed || undefined} disabled={row.fixed}
            aria-label={row.fixed ? `快捷键（编辑器内置，不可修改）：${row.label}` : `修改快捷键：${row.label}`}
            title={row.fixed ? '编辑器内置快捷键，不可修改' : '点击录制新的组合键'}
            onClick={() => { if (!row.fixed) onEdit() }}>
            {!row.fixed && <span className="dvw-set-shortcut-edit" aria-hidden="true">✎</span>}
            {row.binding === null
              ? <span className="dvw-set-unbound">未绑定</span>
              : formatBinding(row.binding).map(key => <kbd className="dvw-set-keycap" key={key}>{key}</kbd>)}
          </button>}
    </div>
  </div>
}

/**
 * 就地录制：按下组合键立即保存。
 *
 * 焦点必须留在录制按钮上 —— 点走或 Esc 就取消，避免用户以为还在录制时把查找框里的输入吃掉。
 * 与 DSH 一致：录制期间直接接管 keydown 捕获，不经过任何其它快捷键处理。
 */
function ShortcutRecorder({ id, label, onDone }: { id: CommandId; label: string; onDone(): void }) {
  const recorder = useRef<HTMLButtonElement | null>(null)
  const [message, setMessage] = useState('')
  useEffect(() => {
    recorder.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return
      if (document.activeElement !== recorder.current) { onDone(); return }
      if (event.code === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        onDone()
        return
      }
      const binding = bindingFromEvent(event)
      if (binding === undefined) return
      event.preventDefault()
      event.stopPropagation()
      // 不允许光秃秃的字母数字键：那会把编辑器里的正常输入变成命令。
      if (binding.ctrl !== true && binding.alt !== true && binding.shift !== true && !/^F\d{1,2}$/.test(binding.code)) {
        setMessage('请配合 Ctrl/Alt/Shift，或使用 F1–F12')
        return
      }
      const conflict = bindingConflict(binding, id)
      if (conflict !== undefined) {
        setMessage(`与「${conflict.label}」冲突，换一个组合键`)
        return
      }
      setKeyBinding(id, binding)
      onDone()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [id, onDone])
  return <div className="dvw-set-recorder-group">
    <button ref={recorder} type="button" className="dvw-set-recorder" data-recording="true"
      aria-label={`为「${label}」录制快捷键`} onClick={() => { setMessage('') }}>按下组合键…</button>
    <button type="button" className="dvw-set-button dvw-set-button-secondary dvw-set-button-small"
      onClick={() => { resetKeyBinding(id); onDone() }}>恢复默认</button>
    <button type="button" className="dvw-set-button dvw-set-button-secondary dvw-set-button-small"
      onClick={() => { setKeyBinding(id, null); onDone() }}>清除</button>
    {message !== '' && <span className="dvw-set-desc dvw-set-conflict" role="alert">{message}</span>}
  </div>
}
