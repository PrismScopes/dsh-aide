import { watch } from 'node:fs'
import { join, relative, sep } from 'node:path'
import chokidar from 'chokidar'

/**
 * 与前端展示无关的重目录。node_modules 在仓库根就有 6 千多个文件，不排除的话监听要先白扫一遍。
 * 与旧实现（chokidar 的 ignored）保持同一套规则。
 */
const IGNORED = /(^|[/\\])(\.git|node_modules|\.next|\.nuxt|\.turbo|\.vite|coverage)([/\\]|$)/

/** 监听句柄需要的最小能力；WorkspaceWatch 与测试都用它。 */
export interface WatchHandle {
  on(event: 'all', handler: (event: string, changed: string) => void): unknown
  off(event: 'all', handler: (event: string, changed: string) => void): unknown
  close(): unknown
}

/**
 * 建工作区监听。
 *
 * 优先用操作系统的递归监听：一次系统调用覆盖整棵树，不需要先遍历。实测同一个工作区
 * （约 1.8 万个非 node_modules 文件）原生递归监听建起来只要 0.19ms，而 chokidar 要先遍历
 * 一遍、ready 要 3443ms。那 3.4 秒全在宿主进程里 —— 工作台一打开就把共用的宿主占住，
 * 实测插件 API 往返延迟从 2ms 冲到 146ms，终端的响应跟着一起抖。
 *
 * 平台不支持递归监听时（老版本 Node 在 Linux 上会抛 ERR_FEATURE_UNAVAILABLE_ON_PLATFORM）
 * 退回 chokidar，行为与以前一致。
 */
export function createWorkspaceWatcher(workspace: string): WatchHandle {
  try {
    const native = watch(workspace, { recursive: true, persistent: true })
    const listeners = new Set<(event: string, changed: string) => void>()
    native.on('change', (event, filename) => {
      if (typeof filename !== 'string' || filename === '') return
      const changed = relative(workspace, join(workspace, filename))
      if (changed === '' || IGNORED.test(changed.split(sep).join('/'))) return
      for (const listener of [...listeners]) listener(event, join(workspace, filename))
    })
    // 目录被删掉之类的瞬态错误：忽略。下一轮事件会把状态补回来，没必要把整条连接打断。
    native.on('error', () => {})
    return {
      on: (_event, handler) => { listeners.add(handler) },
      off: (_event, handler) => { listeners.delete(handler) },
      close: () => { listeners.clear(); native.close() },
    }
  } catch { /* 平台不支持递归监听，走下面的 chokidar */ }
  return chokidar.watch(workspace, { ignoreInitial: true, ignored: IGNORED, awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 } }) as unknown as WatchHandle
}
