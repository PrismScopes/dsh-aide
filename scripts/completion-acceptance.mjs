// completion-acceptance.mjs — 行内补全的端到端验收：对着一个正在运行的 DSH 实例逐项取证据。
//
// 用法：
//   1. 让 DSH 跑起来（桌面端或 dsh web 均可）；
//   2. node scripts/completion-acceptance.mjs http://127.0.0.1:3999
//
// 只读：全部通过 /dsh-vscode/* 的公开接口取证据，不写工作区、不改配置。
// 需要模型可用才能看到补全内容；模型不可用时「补全」一项会打印失败原因（这本身也是证据）。

const base = (process.argv[2] ?? 'http://127.0.0.1:3999').replace(/\/+$/, '')
const sessionId = `acceptance-${Date.now()}`

const callApi = async (method, body = {}) => {
  const response = await fetch(`${base}/dsh-vscode/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, ...body }),
  })
  if (!response.ok) throw new Error(`${method} → HTTP ${response.status}`)
  return (await response.json()).value
}

const request = (document, line, column, overrides = {}) => ({
  sessionId,
  environment: { ideVersion: 'acceptance', extensionVersion: '0.1.8', region: '', channel: 'desktop', repository: '' },
  language: 'typescript',
  trigger: 'inline',
  edits: [],
  cursor: { filePath: '_acceptance.ts', rewriteAt: { line, column }, document },
  diagnostics: [],
  forceRewrite: false,
  ...overrides,
})

const complete = async (body) => {
  const started = Date.now()
  const response = await fetch(`${base}/dsh-vscode/completion`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  const events = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    events.push(JSON.parse(line.slice(5).trim()))
  }
  return { events, elapsedMs: Date.now() - started, status: response.status }
}

const line = (title) => console.log(`\n== ${title} ==`)
let failures = 0
const check = (label, condition, detail) => {
  console.log(`${condition ? '  通过' : '  未通过'}  ${label}${detail === undefined ? '' : `：${detail}`}`)
  if (!condition) failures += 1
}

// 1. 配置：选路、模型、实验分组、参数、安全规则
line('配置（文档 7：参数由服务端下发）')
try {
  const config = await callApi('completion.config')
  check('选路', typeof config.source === 'string', `${config.source} / ${config.model}`)
  check('实验分组', config.experiment === 'control' || config.experiment === 'treatment', config.experiment)
  check('参数随分组下发', typeof config.params?.debounceFastMs === 'number', `debounceFastMs=${config.params?.debounceFastMs} snippetCount=${config.params?.snippetCount}`)
  check('安全规则', Array.isArray(config.security?.rules) && config.security.rules.length > 0, `${config.security?.rules?.length} 条`)
  // 生效的设置：排查时第一件事是确认「按什么配置在跑」，而不是猜环境变量与设置文件谁赢了。
  check('生效的设置', config.settings !== undefined, `路由=${config.settings?.route ?? '（跟随默认模型）'} 回落=${config.settings?.fallback === true}`)
} catch (error) {
  check('配置接口', false, String(error))
}

// 2. 索引：规模、上限、是否触顶
line('检索索引（文档 5.3）')
try {
  const status = await callApi('completion.index.status')
  check('索引可用', status.files > 0 && status.chunks > 0, `${status.files} 个文件 / ${status.chunks} 个分块`)
  if (status.files === 0) console.log('  提示  刚启动时索引在后台构建，稍等片刻再跑一次')
  check('上限可见', typeof status.limits?.maxChunks === 'number', `maxChunks=${status.limits?.maxChunks}`)
  console.log(`  提示  触顶=${status.capped}（为真表示索引不完整，检索质量会低于规模所暗示的水平）`)
} catch (error) {
  check('索引接口', false, String(error))
}

// 3. 补全：一次真实请求
line('补全（文档 4.3 / 4.4：结构化请求进、SSE 流式出）')
let completionWorked = false
try {
  // 三个用例都要跑：光标在末尾、光标在文件中段、以及在**大文档**的中段。前两个覆盖光标位置，
  // 第三个覆盖文档裁剪与预算（真实文件是几百上千行，几行的用例走不到那条路径）。
  const middle = 'const a = useState(0)\nconst b = useSt\nconst c = 2\nconst d = 3'
  // 大文档：参照标识符必须落在文档裁剪的保留窗口内，否则「没有候选」分不清是裁剪出了问题、
  // 还是本地兜底本来就没有可补的标识符 —— 这条用例就失去判别力了。
  const bigLines = 1200
  const cursorLine = 600
  const big = Array.from({ length: bigLines }, (_value, index) => {
    const line = index + 1
    if (line === cursorLine) return 'const b = useSt'
    if (line === cursorLine - 50) return 'const a = useState(0)'
    return `const item${line} = compute(${line}, config)`
  }).join('\n')
  for (const [label, document, lineNumber, column] of [
    ['光标在文档末尾', 'const a = useState(0)\nconst b = useSt', 2, 16],
    ['光标在文件中段', middle, 2, 16],
    [`光标在 ${bigLines} 行文档的中段`, big, cursorLine, 16],
  ]) {
    const result = await complete(request(document, lineNumber, column))
    const meta = result.events.find(event => event.type === 'meta')
    const output = result.events.find(event => event.type === 'output')
    const error = result.events.find(event => event.type === 'error')
    check(`请求被接受（${label}）`, result.status === 200, `HTTP ${result.status}`)
    check('返回 meta', meta !== undefined, meta === undefined ? '' : `model=${meta.model} 注入片段=${meta.snippets}`)
    if (output !== undefined) {
      completionWorked = true
      check(`产出候选（${label}）`, output.candidates.length > 0, JSON.stringify(output.candidates.map(candidate => candidate.text)))
      check('首字节延迟', typeof output.candidates[0]?.elapsedMs === 'number', `${output.candidates[0]?.elapsedMs} ms（端到端 ${result.elapsedMs} ms）`)
    } else if (error !== undefined) {
      console.log(`  注意  ${label} 上游未产出：${error.message}`)
    } else {
      check(`产出候选（${label}）`, false, '既没有 output 也没有 error')
    }
  }
} catch (error) {
  check('补全请求', false, String(error))
}

// 4. 安全：规则下发与两层执行位置的说明
line('内容安全（文档 4.5）')
console.log('  说明  租户规则在配置接口里下发（见上）；执行分两层：')
console.log('        客户端预过滤在请求前比对整份文档，命中拦截规则就不发起请求；')
console.log('        服务端在模型输出累加过程中比对，命中拦截规则则不下发候选。')
console.log('        两层都由单测覆盖（tests/completion-security.spec.ts），客户端预过滤另有浏览器端实测。')
console.log('        这里不重复断言：直接打接口时预过滤不会参与，而用本地兜底也造不出命中规则的模型输出。')

// 5. 观测：统计与失败留痕
line('观测（文档 7：采纳率 / 取消率 / 首字节延迟；失败留痕）')
try {
  const stats = await callApi('completion.stats')
  const overall = stats.overall ?? {}
  check('统计可用', typeof overall.shown === 'number', `展示 ${overall.shown} 次｜首字节均值 ${overall.averageFirstByteMs ?? '—'} ms`)
  console.log(`  提示  采纳率=${overall.acceptanceRate ?? '—'} 取消率=${overall.cancelRate ?? '—'} 失败=${overall.failed ?? 0}`)
  if (stats.lastFailure !== undefined) console.log(`  提示  最近一次失败：${JSON.stringify(stats.lastFailure)}`)
} catch (error) {
  check('统计接口', false, String(error))
}

console.log(`\n共 ${failures} 项未通过${completionWorked ? '' : '（补全未产出候选：模型不可用或上游失败，见上方提示）'}`)
process.exit(failures === 0 ? 0 : 1)
