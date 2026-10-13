import { describe, expect, it } from 'vitest'
import { isTerminalProtocolReply } from '../src/client/terminal.ts'
import { defaultTerminalShell, REPLAY_CHUNK_CHARS, REPLAY_LINES, REPLAY_SEND_BYTES, ReplayBuffer, replayChunks, sanitizedTerminalEnv, terminalProfiles, terminalShell, terminalTitleBase, uniqueTerminalTitle } from '../src/terminal.ts'
import type { ProfileProbe } from '../src/terminal.ts'

/** 给定「文件系统里存在哪些文件」与「PATH 上能找到哪些可执行文件」。 */
function fakeProbe(existing: readonly string[], onPath: Record<string, string>): ProfileProbe {
  return { exists: candidate => existing.includes(candidate), which: file => onPath[file] }
}

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

describe('terminal replay buffer', () => {
  it('keeps what it stores bounded while output keeps arriving', () => {
    const buffer = new ReplayBuffer()
    for (let index = 0; index < 4000; index++) buffer.push(`line ${index} ${'x'.repeat(200)}\r\n`)
    // 存的上限是 512 KiB（REPLAY_STORE_BYTES）。原先每块都对整段做 byteLength 与 slice，
    // 输出越久单块越贵；这里只验证结果有界，成本由实现保证。
    expect(buffer.tail().length).toBeLessThanOrEqual(512 * 1024 + 4096)
  })

  it('sends back only the lines a terminal can display, from a line boundary', () => {
    const buffer = new ReplayBuffer()
    for (let index = 0; index < 3000; index++) buffer.push(`line-${index}\r\n`)
    const tail = buffer.tail()
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(REPLAY_SEND_BYTES)
    expect(tail.split('\n').length).toBeLessThanOrEqual(REPLAY_LINES)
    // 从行边界起算：首行应当是一条完整的 line-N，而不是半截。
    const [firstLine = ''] = tail.split('\n')
    expect(/^line-\d+\r?$/.test(firstLine)).toBe(true)
  })

  it('keeps an empty buffer empty and a short buffer intact', () => {
    const buffer = new ReplayBuffer()
    expect(buffer.tail()).toBe('')
    buffer.push('only line\r\n')
    expect(buffer.tail()).toBe('only line\r\n')
  })

  it('splits a long replay into chunks without cutting a surrogate pair', () => {
    const text = 'a'.repeat(REPLAY_CHUNK_CHARS - 1) + '\u{1F600}' + 'b'.repeat(REPLAY_CHUNK_CHARS + 10)
    const chunks = replayChunks(text)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(text)
    // 每个块的最后一个码元都不能是高代理，否则一个字符会被劈成两半。
    for (const chunk of chunks) {
      const last = chunk.charCodeAt(chunk.length - 1)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    }
  })
})

describe('terminal profiles', () => {
  const git = 'H:\\AppData\\Git\\cmd\\git.exe'
  const env = { PATH: 'C:\\Windows\\System32', COMSPEC: 'C:\\Windows\\System32\\cmd.exe', SystemRoot: 'C:\\Windows' }

  it('lists the shells a VS Code style menu would offer', () => {
    const probe = fakeProbe(
      ['H:\\AppData\\Git\\bin\\bash.exe', 'C:\\Windows\\System32\\bash.exe'],
      { 'pwsh.exe': 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'git.exe': git },
    )
    expect(terminalProfiles('win32', env, probe)).toEqual([
      { id: 'pwsh', label: 'PowerShell' },
      { id: 'git-bash', label: 'Git Bash' },
      { id: 'cmd', label: 'Command Prompt' },
      { id: 'wsl', label: 'WSL' },
    ])
  })

  it('reports only shells that are actually present', () => {
    // 没有任何探测结果时不该凭空给出条目：菜单里出现点了没反应的名字比少一项更糟。
    expect(terminalProfiles('win32', {}, fakeProbe([], {}))).toEqual([])
  })

  it('uses PowerShell 7 as the default terminal when it is installed', () => {
    const withPwsh = fakeProbe([], { 'pwsh.exe': 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' })
    expect(terminalShell(undefined, 'win32', env, withPwsh)).toEqual({ shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: [] })
    // 没装 pwsh 的机器保持原样：COMSPEC 原样启动，不会被悄悄换成别的。
    expect(terminalShell(undefined, 'win32', env, fakeProbe([], {}))).toEqual({ shell: 'C:\\Windows\\System32\\cmd.exe', args: [] })
  })

  it('resolves a profile id into the shell to spawn', () => {
    const probe = fakeProbe(
      ['H:\\AppData\\Git\\bin\\bash.exe'],
      { 'git.exe': git, 'powershell.exe': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
    )
    // 本机没有 pwsh 时，缺省落到平台默认：COMSPEC 原样启动。
    expect(terminalShell(undefined, 'win32', env, probe)).toEqual({ shell: 'C:\\Windows\\System32\\cmd.exe', args: [] })
    expect(terminalShell('git-bash', 'win32', env, probe)).toEqual({ shell: 'H:\\AppData\\Git\\bin\\bash.exe', args: ['--login', '-i'] })
    expect(terminalShell('windows-powershell', 'win32', env, probe)).toEqual({ shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: [] })
  })

  it('refuses a shell path that is not a known profile id', () => {
    // 客户端只该给 id。若接受任意路径，这个接口就成了「按调用者的意思启动任意程序」。
    const probe = fakeProbe([], {})
    expect(() => terminalShell('C:\\Windows\\System32\\cmd.exe', 'win32', env, probe)).toThrow(/unknown terminal profile/)
    expect(() => terminalShell('pwsh', 'win32', env, probe)).toThrow(/unknown terminal profile/)
  })

  it('falls back to one profile named after the platform shell', () => {
    expect(terminalProfiles('linux', { SHELL: '/usr/bin/fish' })).toEqual([{ id: 'default', label: 'fish' }])
  })
})

describe('terminal titles', () => {
  it('names a terminal after the executable without its extension', () => {
    expect(terminalTitleBase('C:\\Windows\\System32\\cmd.exe')).toBe('cmd')
    expect(terminalTitleBase('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('pwsh')
    expect(terminalTitleBase('H:\\AppData\\Git\\bin\\bash.exe')).toBe('bash')
    expect(terminalTitleBase('/bin/bash')).toBe('bash')
  })

  it('adds an index when the name is already taken', () => {
    expect(uniqueTerminalTitle('cmd', [])).toBe('cmd')
    expect(uniqueTerminalTitle('cmd', ['cmd'])).toBe('cmd (1)')
    expect(uniqueTerminalTitle('cmd', ['cmd', 'cmd (1)'])).toBe('cmd (2)')
    // 手动改过的名字只占用一个位置，不参与基础名比较。
    expect(uniqueTerminalTitle('cmd', ['我的构建终端'])).toBe('cmd')
    expect(uniqueTerminalTitle('cmd', ['cmd', '我的构建终端'])).toBe('cmd (1)')
  })
})
