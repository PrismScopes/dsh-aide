/**
 * 提交说明的文本处理：emoji 短代码、Issue 链接、Pull Request 链接。
 *
 * 都是纯函数 —— 原版 Git Graph 的这几项分别来自 emoji-shortcodes 包与仓库设置里的
 * 「Issue Linking / Pull Request Creation」配置，这里用最小实现覆盖同样的用户可见行为，
 * 不引入新依赖。
 */

export type IssueProvider = 'none' | 'github' | 'gitlab' | 'bitbucket'

/** 常见 gitmoji 短代码（Git Graph 用的是同一套）：未知短代码原样保留。 */
const EMOJI: Record<string, string> = {
  bug: '🐛', sparkles: '✨', tada: '🎉', fire: '🔥', art: '🎨', zap: '⚡', bookmark: '🔖',
  memo: '📝', rocket: '🚀', white_check_mark: '✅', wrench: '🔧', recycle: '♻️', lipstick: '💄',
  ambulance: '🚑', lock: '🔒', arrow_up: '⬆️', arrow_down: '⬇️', construction: '🚧', green_heart: '💚',
  heavy_plus_sign: '➕', heavy_minus_sign: '➖', pencil2: '✏️', rotating_light: '🚨', rewind: '⏪',
  package: '📦', alien: '👽', poop: '💩', globe_with_meridians: '🌐', busts_in_silhouette: '👥',
  children_crossing: '🚸', card_file_box: '🗃️', thread: '🧵', goal_net: '🥅',
}

/** 把 `:bug:` 这类短代码换成 emoji；不认识的短代码保持原样（不能把用户的文本吃掉）。 */
export function replaceEmojiShortcodes(text: string): string {
  return text.replace(/:([a-z0-9_+-]+):/gi, (whole, name: string) => EMOJI[name.toLowerCase()] ?? whole)
}

const PROVIDERS: IssueProvider[] = ['github', 'gitlab', 'bitbucket']
const HOSTS: Record<string, IssueProvider> = { 'github.com': 'github', 'gitlab.com': 'gitlab', 'bitbucket.org': 'bitbucket' }

/**
 * 从 git 远程 URL 推断托管方与浏览器仓库地址。
 *
 * 支持 https、`git@host:owner/repo` 的 scp 写法与 `ssh://git@host/owner/repo`；
 * 只认 GitHub / GitLab / Bitbucket 三家（与 Git Graph 内置的 provider 一致），
 * 自建域名返回 undefined（客户端会当作「未配置 Issue 链接」）。
 */
export function parseRemoteUrl(url: string): { provider: IssueProvider; repoUrl: string } | undefined {
  const trimmed = url.trim()
  if (trimmed === '') return undefined
  let host = ''
  let path = ''
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(trimmed)
  if (scp !== null) { host = scp[1] ?? ''; path = scp[2] ?? '' }
  else {
    try {
      const parsed = new URL(trimmed)
      host = parsed.hostname
      path = parsed.pathname.replace(/^\/+/, '')
    } catch { return undefined }
  }
  const provider = HOSTS[host.toLowerCase()]
  if (provider === undefined) return undefined
  const repo = path.replace(/\.git$/i, '').replace(/\/+$/, '')
  if (repo === '') return undefined
  return { provider, repoUrl: 'https://' + host.toLowerCase() + '/' + repo }
}

const ISSUE_PATHS: Record<IssueProvider, string> = {
  none: '', github: '/issues/', gitlab: '/-/issues/', bitbucket: '/issues/',
}

/** Issue 编号链接：`#123` → issue 页；`a#1` 这种紧贴字母数字的不算（避免误伤哈希/代码）。 */
export function issueSegments(text: string, provider: IssueProvider, repoUrl: string | undefined): Array<{ text: string; url?: string }> {
  const linkable = provider !== 'none' && repoUrl !== undefined && repoUrl !== ''
  if (!linkable) return [{ text }]
  const pattern = /(^|[^A-Za-z0-9_])#(\d+)\b/g
  const segments: Array<{ text: string; url?: string }> = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const prefix = match[1] ?? ''
    const digits = match[2] ?? ''
    const start = match.index + prefix.length
    if (start > cursor) segments.push({ text: text.slice(cursor, start) })
    segments.push({ text: '#' + digits, url: repoUrl + ISSUE_PATHS[provider] + digits })
    cursor = start + digits.length + 1
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) })
  return segments.length === 0 ? [{ text }] : segments
}

/**
 * Pull Request 创建链接。
 *
 * 与原版 Git Graph 的 provider 模板一致：GitHub 用 compare 页、GitLab 用 merge_requests/new、
 * Bitbucket 用 pull-requests/new。分支名必须 URL 编码（`feature/x` 里的斜杠不能当路径分隔符）。
 */
export function pullRequestUrl(provider: IssueProvider, repoUrl: string | undefined, source: string, target: string): string | undefined {
  if (provider === 'none' || repoUrl === undefined || repoUrl === '') return undefined
  const from = source.trim()
  const to = target.trim()
  if (from === '' || to === '' || from === to) return undefined
  const sourcePart = encodeURIComponent(from)
  const targetPart = encodeURIComponent(to)
  if (provider === 'github') return repoUrl + '/compare/' + targetPart + '...' + sourcePart + '?expand=1'
  if (provider === 'gitlab') return repoUrl + '/-/merge_requests/new?merge_request%5Bsource_branch%5D=' + sourcePart + '&merge_request%5Btarget_branch%5D=' + targetPart
  return repoUrl + '/pull-requests/new?source=' + sourcePart + '&dest=' + targetPart
}

/** 兼容旧调用：只判断 URL 是否可解析成受支持的托管方。 */
export function isSupportedRemote(url: string): boolean {
  return parseRemoteUrl(url) !== undefined
}

export { PROVIDERS }

/** Issue 链接配置：`auto` 表示按远程 URL 自动推断托管方；repoUrl 可手动覆盖。 */
export interface IssueLinkConfig { provider: IssueProvider | 'auto'; repoUrl: string }

/** 宽松解析仓库设置里的 Issue 配置；坏数据回落 auto + 空地址。 */
export function parseIssueLinkConfig(raw: string | null): IssueLinkConfig {
  const fallback: IssueLinkConfig = { provider: 'auto', repoUrl: '' }
  if (raw === null || raw === '') return fallback
  let value: unknown
  try { value = JSON.parse(raw) } catch { return fallback }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fallback
  const source = value as Record<string, unknown>
  const provider = source.provider === 'github' || source.provider === 'gitlab' || source.provider === 'bitbucket' || source.provider === 'none' ? source.provider : 'auto'
  return { provider, repoUrl: typeof source.repoUrl === 'string' ? source.repoUrl.trim() : '' }
}

/** 按仓库保存 Issue 链接配置。 */
export function issueLinkStorageKey(repository: string): string {
  return 'dvw:git-issues:v1:' + repository
}

/**
 * 解析出实际使用的托管方与仓库地址：手动配置优先，否则从远程 URL 自动推断。
 * 手动填了 repoUrl 但 provider 仍是 auto 时，再从 repoUrl 反推托管方。
 */
export function resolveIssueLinks(config: IssueLinkConfig, remoteUrl: string | undefined): { provider: IssueProvider; repoUrl: string | undefined } {
  if (config.provider !== 'auto') return { provider: config.provider, repoUrl: config.repoUrl === '' ? undefined : config.repoUrl }
  const source = config.repoUrl !== '' ? config.repoUrl : remoteUrl
  const parsed = parseRemoteUrl(source ?? '')
  return { provider: parsed?.provider ?? 'none', repoUrl: parsed?.repoUrl }
}
