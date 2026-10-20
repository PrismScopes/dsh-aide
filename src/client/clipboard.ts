/**
 * 剪贴板写入。
 *
 * 需要它是因为「复制路径」这类菜单项在桌面端与 Web 端落地方式不同：Electron 的自定义协议
 * (`dsh-app://`) 下 `navigator.clipboard` 可能被判定为非安全上下文而不可用，此时回落到
 * 隐藏 textarea + `document.execCommand('copy')` —— 后者虽然已标记废弃，但在两条路径里是
 * 唯一还能用的那个。两条都失败时返回 false，由调用方决定要不要提示。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch { /* 回落到 execCommand：非安全上下文或未授予权限时走这里。 */ }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    area.setSelectionRange(0, text.length)
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  } catch {
    return false
  }
}

/** 读剪贴板（终端「粘贴」用）。桌面端可能没有权限，读不到就返回 undefined。 */
export async function readClipboard(): Promise<string | undefined> {
  try {
    const value = await navigator.clipboard.readText()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}
