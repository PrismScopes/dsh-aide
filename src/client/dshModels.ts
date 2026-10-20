/**
 * 设置页用的模型目录客户端。
 *
 * 宿主侧 `GET /dsh-vscode/model-routes` 返回统一的 `{ ok, value }` 信封；这里只做两件事：
 * 取回来、归一成设置页要的形状。**任何失败都退化空列表、绝不抛错** —— 设置页要能在
 * 还没有这个端点的旧宿主（或宿主暂时不可达）上照常打开，只是没有下拉候选。
 */

interface DshModelRoute { route: string; label: string; provider: string; model: string }
interface DshModelRoutes { default: string | null; routes: DshModelRoute[] }

const ENDPOINT = '/dsh-vscode/model-routes'

/** 空目录每次返回新对象：调用方可能就地排序或修改，不能共享同一份可变状态。 */
function emptyRoutes(): DshModelRoutes {
  return { default: null, routes: [] }
}

export async function listDshModelRoutes(signal?: AbortSignal): Promise<DshModelRoutes> {
  try {
    const response = await fetch(ENDPOINT, { cache: 'no-store', ...(signal === undefined ? {} : { signal }) })
    if (!response.ok) return emptyRoutes()
    const answer = await response.json() as unknown
    // 信封读不懂（旧宿主返回 HTML、代理返回错误页）时等同于没有目录。
    if (!isRecord(answer) || answer['ok'] !== true) return emptyRoutes()
    return readValue(answer['value'])
  } catch {
    // 网络失败、请求被 abort、JSON 解析失败：设置页不该因此显示错误或白屏。
    return emptyRoutes()
  }
}

/** 归一 `{ default, routes }`；宿主升级前后形状略有差异时只丢坏条目，不丢整份列表。 */
function readValue(value: unknown): DshModelRoutes {
  if (!isRecord(value)) return emptyRoutes()
  const routes: DshModelRoute[] = []
  const listed = value['routes']
  if (Array.isArray(listed)) {
    for (const entry of listed) {
      if (!isRecord(entry)) continue
      const route = stringValue(entry['route'])
      const provider = stringValue(entry['provider'])
      const model = stringValue(entry['model'])
      // 三个字段缺一不可：设置页要按 provider/model 写回设置，route 只是展示与比较用的键。
      if (route === undefined || provider === undefined || model === undefined) continue
      routes.push({ route, provider, model, label: stringValue(entry['label']) ?? model })
    }
  }
  return { default: stringValue(value['default']) ?? null, routes }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}
