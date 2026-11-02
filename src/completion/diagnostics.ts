import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 追加一行补全诊断日志。
 *
 * 为什么需要：应用侧的启动窗口日志拿不到，而「没有补全」至少有三种原因 ——
 * 客户端没发请求、请求到了但模型不可用、模型调用失败。这三件事只能从宿主侧区分，
 * 所以固定写进 `%DSH_HOME%/completion.log`。
 *
 * 日志只用于排查，不参与任何决策；写失败也不影响补全。
 */
export function diagnosticLogPath(env: Record<string, string | undefined> = globalThis.process?.env ?? {}): string | undefined {
  const home = env['DSH_HOME']
  if (home === undefined || home === '') return undefined
  return join(home.replace(/[\\/]+$/, ''), 'completion.log')
}

export function noteCompletion(line: string): void {
  const path = diagnosticLogPath()
  if (path === undefined) return
  void appendFile(path, `${new Date().toISOString()} ${line}\n`, 'utf8').catch(() => {})
}
