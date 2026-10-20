import type { HostContext } from './context.ts'
import { copyEntry, createEntry, cwdFor, deleteEntry, gitAction, gitStatus, listFiles, moveEntry, readDocument, renameEntry, saveDocument, searchWorkspace } from './host.ts'
import type { SearchRequest } from './types.ts'
import { completionIndexFor, completionTelemetry, resolveProvider } from './completion/register.ts'
import { completionSettings } from './completion/settings.ts'
import { groupForSession, paramsForGroup } from './completion/experiment.ts'
import { DEFAULT_SECURITY_RULES } from './completion/security.ts'
import { WorkbenchError, stringField } from './wire.ts'

/**
 * 把客户端发来的方法名分发到具体的宿主操作。
 * 从 index.ts 拆出：这里只做「方法名 → 实现」的映射与参数取值，与路由注册无关。
 */
export async function dispatch(ctx: HostContext, method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const sessionId = stringField(body, 'sessionId'); const cwd = cwdFor(ctx, sessionId)
  switch (method) {
    case 'workspace': return { cwd, name: cwd.split(/[\\/]/).at(-1) || cwd }
    // 补全参数与提供方由宿主下发，客户端不写死这些值（文档第七节的要求）。
    // 索引状态与刷新（文档 5.1 要求上下文服务暴露这两个操作）。
    case 'completion.index.status': return completionIndexFor(cwd).then(index => index.status())
    case 'completion.index.refresh': return completionIndexFor(cwd).then(index => index.refresh())
    case 'completion.config': {
      const resolved = resolveProvider(ctx)
      const experiment = groupForSession(sessionId)
      // 安全规则一并下发：客户端要用它在请求前预过滤（文档 6.4 的请求前一道），
      // 两处设卡必须用同一套规则，否则会出现「拦了但没脱敏」这类不一致。
      // 生效的设置也一并暴露：排查时第一件事就是确认「现在按什么配置在跑」，
      // 而不是去猜环境变量与设置文件谁赢了。
      const settings = completionSettings()
      return {
        source: resolved.source, model: resolved.model, profile: resolved.profile.id, experiment,
        params: paramsForGroup(experiment), security: { rules: DEFAULT_SECURITY_RULES },
        endpoint: '/dsh-vscode/completion',
        settings: {
          route: settings.route === undefined ? null : `${settings.route.provider}/${settings.route.model}` ,
          fallback: settings.fallback,
        },
      }
    }
    case 'completion.telemetry': {
      const kind = stringField(body, 'kind')
      if (kind !== 'shown' && kind !== 'accepted' && kind !== 'cancelled' && kind !== 'failed') throw new WorkbenchError('invalid-argument', `unknown telemetry kind ${kind}`)
      completionTelemetry.record({
        kind, sessionId, language: stringField(body, 'language'),
        ...(typeof body.model === 'string' && body.model !== '' ? { model: body.model } : {}),
        ...(typeof body.experiment === 'string' && body.experiment !== '' ? { experiment: body.experiment } : {}),
        ...(typeof body.firstByteMs === 'number' && Number.isFinite(body.firstByteMs) ? { firstByteMs: body.firstByteMs } : {}),
        ...(typeof body.candidateCount === 'number' && Number.isFinite(body.candidateCount) ? { candidateCount: body.candidateCount } : {}),
        ...(typeof body.error === 'string' && body.error !== '' ? { error: body.error } : {}),
      })
      return { recorded: true }
    }
    case 'completion.stats': return { overall: completionTelemetry.stats(), byExperiment: completionTelemetry.byExperiment(), lastFailure: completionTelemetry.failure() }
    case 'fs.list': return listFiles(cwd, stringField(body, 'path'))
    case 'fs.read': return readDocument(cwd, stringField(body, 'path'), body.force === true)
    case 'fs.save': return saveDocument(cwd, stringField(body, 'path'), stringField(body, 'content'), stringField(body, 'revision'))
    case 'fs.create': return createEntry(cwd, stringField(body, 'path'), body.kind === 'directory' ? 'directory' : 'file').then(() => ({ ok: true }))
    case 'fs.rename': return renameEntry(cwd, stringField(body, 'path'), stringField(body, 'nextPath')).then(() => ({ ok: true }))
    case 'fs.delete': return deleteEntry(cwd, stringField(body, 'path')).then(() => ({ ok: true }))
    // 资源管理器的「粘贴（复制）」：目标目录里保持原名，已存在则 409 由客户端提示。
    case 'fs.copy': return copyEntry(cwd, stringField(body, 'path'), stringField(body, 'directory'))
    // 「粘贴（剪切）」：同样是保持原名，只是成功后源条目消失（宿主用原子 rename 实现）。
    case 'fs.move': return moveEntry(cwd, stringField(body, 'path'), stringField(body, 'directory'))
    case 'search': return searchWorkspace(cwd, body as unknown as SearchRequest, signal)
    case 'git.status': return gitStatus(cwd)
    case 'git.action': return gitAction(cwd, stringField(body, 'action'), typeof body.path === 'string' ? body.path : undefined, typeof body.value === 'string' ? body.value : undefined)
    default: throw new WorkbenchError('not-found', `unknown workbench API method ${method}`, 404)
  }
}
