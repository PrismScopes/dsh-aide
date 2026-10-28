/**
 * 工作区扫描 worker。
 *
 * 宿主把 rootFiles/编译设置/打开文档传进来，worker 自己加载一份 TypeScript、跑完程序级诊断，
 * 再把结果逐文件发回。CPU 密集检查完全离开宿主事件循环，补全、Git、终端、HTTP 路由都不会被扫描
 * 卡住。
 *
 * 只在生产构建里作为 `lib/scan-worker.js` 存在；源码测试环境走 provider 的进程内回退
 * （同一个 `scanProject` 实现）。
 */
import { parentPort, workerData } from 'node:worker_threads'
import ts from 'typescript'
import { scanProject, type ScanFileResult, type ScanOptions } from './scan.ts'

interface ScanWorkerData extends ScanOptions {}

export type ScanWorkerMessage =
  | { type: 'total'; total: number }
  | { type: 'files'; files: ScanFileResult[] }
  | { type: 'done'; result: { checked: number; errors: number; warnings: number } }
  | { type: 'error'; message: string }

if (parentPort !== null) {
  const port = parentPort
  const data = workerData as ScanWorkerData
  void (async () => {
    try {
      let batch: ScanFileResult[] = []
      const flush = (): void => {
        if (batch.length === 0) return
        port.postMessage({ type: 'files', files: batch } satisfies ScanWorkerMessage)
        batch = []
      }
      const result = await scanProject(ts, data, (path, diagnostics) => {
        batch.push({ path, diagnostics })
        // 批量回传：数千个文件逐个 postMessage 会把结果消息和宿主回调都放大成洪峰。
        if (batch.length >= 48) flush()
      }, undefined, total => {
        port.postMessage({ type: 'total', total } satisfies ScanWorkerMessage)
      })
      flush()
      port.postMessage({ type: 'done', result } satisfies ScanWorkerMessage)
    } catch (error) {
      port.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) } satisfies ScanWorkerMessage)
    }
  })()
}
