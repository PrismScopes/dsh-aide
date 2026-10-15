import { appendFile } from 'node:fs/promises'
import { diagnosticLogPath } from './settings.ts'

/**
 * 追加一行补全诊断日志。
 *
 * 为什么需要：应用侧的启动窗口日志拿不到，而「没有补全」至少有三种原因 ——
 * 客户端没发请求、请求到了但选路不对、模型调用失败。这三件事只能从宿主侧区分，
 * 所以固定写进一个文件（与设置文件同级的 completion.log）。
 *
 * 日志只用于排查，不参与任何决策；写失败也不影响补全。
 */
export function noteCompletion(line: string): void {
  const path = diagnosticLogPath()
  if (path === undefined) return
  void appendFile(path, `${new Date().toISOString()} ${line}\n`, 'utf8').catch(() => {})
}
