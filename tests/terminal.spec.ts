import { describe, expect, it } from 'vitest'
import { isTerminalProtocolReply } from '../src/client/terminal.ts'
import { defaultTerminalShell, sanitizedTerminalEnv } from '../src/terminal.ts'

describe('terminal host settings', () => {
  it('keeps normal shell variables while removing credentials', () => {
    expect(sanitizedTerminalEnv({ PATH: '/bin', LANG: 'zh_CN.UTF-8', DEEPSEEK_API_KEY: 'secret', TOKEN: 'secret', EMPTY: undefined })).toEqual({ PATH: '/bin', LANG: 'zh_CN.UTF-8' })
  })

  it('selects the platform interactive shell', () => {
    expect(defaultTerminalShell('linux', { SHELL: '/usr/bin/fish' })).toEqual({ shell: '/usr/bin/fish', args: ['-l'] })
    // Windows 上 COMSPEC 原样启动。原先这里会把 cmd 换成 powershell.exe -NoLogo，
    // 于是用户的 cmd 环境与启动横幅（Microsoft Windows [版本 …]）永远看不到 ——
    // 终端应当呈现用户自己的环境。
    expect(defaultTerminalShell('win32', { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' })).toEqual({ shell: 'C:\\Windows\\System32\\cmd.exe', args: [] })
    expect(defaultTerminalShell('win32', { COMSPEC: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' })).toEqual({ shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: [] })
    // 只有 COMSPEC 缺失时才回退。
    expect(defaultTerminalShell('win32', {})).toEqual({ shell: 'powershell.exe', args: [] })
  })

  it('identifies terminal protocol replies emitted while replaying output', () => {
    expect(isTerminalProtocolReply('\x1b]11;rgb:1313/1414/1717\x1b\\')).toBe(true)
    expect(isTerminalProtocolReply('\x1b[?62;1;2;6;7;8;9c')).toBe(true)
    expect(isTerminalProtocolReply('git status\r')).toBe(false)
  })
})
