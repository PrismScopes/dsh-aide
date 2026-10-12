import type { HostContext } from './context.ts'
import { createEntry, cwdFor, deleteEntry, gitAction, gitStatus, listFiles, readDocument, renameEntry, saveDocument, searchWorkspace, uploadFile, workspacePreviewFile } from './host.ts'
import type { SearchRequest } from './types.ts'
import { WorkbenchError, stringField } from './wire.ts'

/**
 * 把客户端发来的方法名分发到具体的宿主操作。
 * 从 index.ts 拆出：这里只做「方法名 → 实现」的映射与参数取值，与路由注册无关。
 */
export async function dispatch(ctx: HostContext, method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const sessionId = stringField(body, 'sessionId'); const cwd = cwdFor(ctx, sessionId)
  switch (method) {
    case 'workspace': return { cwd, name: cwd.split(/[\\/]/).at(-1) || cwd }
    case 'fs.list': return listFiles(cwd, stringField(body, 'path'))
    case 'fs.read': return readDocument(cwd, stringField(body, 'path'))
    case 'fs.save': return saveDocument(cwd, stringField(body, 'path'), stringField(body, 'content'), stringField(body, 'revision'))
    case 'fs.create': return createEntry(cwd, stringField(body, 'path'), body.kind === 'directory' ? 'directory' : 'file').then(() => ({ ok: true }))
    case 'fs.rename': return renameEntry(cwd, stringField(body, 'path'), stringField(body, 'nextPath')).then(() => ({ ok: true }))
    case 'fs.delete': return deleteEntry(cwd, stringField(body, 'path')).then(() => ({ ok: true }))
    case 'search': return searchWorkspace(cwd, body as unknown as SearchRequest, signal)
    case 'git.status': return gitStatus(cwd)
    case 'git.action': return gitAction(cwd, stringField(body, 'action'), typeof body.path === 'string' ? body.path : undefined, typeof body.value === 'string' ? body.value : undefined)
    default: throw new WorkbenchError('not-found', `unknown workbench API method ${method}`, 404)
  }
}
