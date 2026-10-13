/**
 * 补全系统的参数与语言分档。
 *
 * 取值来自《行内代码补全系统实现文档》第七节的建议起点。文档明确说这些值要按实际数据实验确定，
 * 所以集中放在这里：后续要做实验分组时，只改这一处就能整体下发，不必翻遍调用点。
 */
export interface CompletionParams {
  /** 快档防抖：动态类型语言与模板类语言，语法容错高。 */
  debounceFastMs: number
  /** 慢档防抖：其余语言。 */
  debounceSlowMs: number
  /** 随请求发送的文档文本上限（按行与字符双重封顶，取先到者）。 */
  documentLines: number
  documentChars: number
  /** FIM 前缀上限。 */
  prefixChars: number
  prefixLines: number
  /** FIM 后缀上限。 */
  suffixChars: number
  suffixLines: number
  /** 送入模型的 token 上限。本地不做真实分词，按字符数近似换算后再比。 */
  promptTokens: number
  /** 注入的检索片段条数与单条上限（第二期用，这里先定型参数）。 */
  snippetCount: number
  snippetChars: number
  /**
   * 相似度下限。
   *
   * 文档建议 0.7 起步，那是针对真实嵌入模型的尺度。本地哈希嵌入（只嵌代码正文）实测：
   * 短查询（半行）相关 0.21、无关 0.06；长查询（约 20 行）相关 0.51、无关 0.06。
   * 默认取 0.15 —— 正好卡在两簇之间。换成真实嵌入模型时应按同样的方法重新实测。
   */
  similarityThreshold: number
  /** 单次返回的候选数上限。 */
  candidateLimit: number
  completionTimeoutMs: number
  locateTimeoutMs: number
}

export const DEFAULT_COMPLETION_PARAMS: CompletionParams = {
  debounceFastMs: 90,
  debounceSlowMs: 125,
  documentLines: 700,
  documentChars: 100_000,
  prefixChars: 7000,
  prefixLines: 700,
  suffixChars: 4000,
  suffixLines: 400,
  promptTokens: 3950,
  snippetCount: 4,
  snippetChars: 3000,
  similarityThreshold: 0.15,
  candidateLimit: 3,
  completionTimeoutMs: 15_000,
  locateTimeoutMs: 5_000,
}

/**
 * 用短防抖的语言。
 *
 * 判据是文档给的那条：动态类型与模板类语言的语法容错高。放成一张表而不是按「是不是脚本语言」
 * 现算 —— 表可以随时按实测调整，也不必每次都推一遍判断逻辑。
 */
const FAST_DEBOUNCE_LANGUAGES = new Set([
  'javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'vue', 'svelte', 'astro',
  'python', 'ruby', 'php', 'lua', 'perl', 'shell', 'bash', 'sh', 'zsh', 'powershell',
  'yaml', 'json', 'jsonc', 'toml', 'html', 'css', 'scss', 'less', 'markdown', 'plaintext',
])

export function usesFastDebounce(language: string): boolean {
  return FAST_DEBOUNCE_LANGUAGES.has(language.trim().toLowerCase())
}

/** 编辑到触发请求的间隔；返回 0 表示立即触发。 */
export function debounceFor(language: string, params: CompletionParams = DEFAULT_COMPLETION_PARAMS): number {
  return usesFastDebounce(language) ? params.debounceFastMs : params.debounceSlowMs
}

/**
 * token 预算换算成字符预算。
 *
 * 文档给的是 token 上限，而本地要判的是字符长度。代码的中文注释与标识符密度决定了比例不固定，
 * 取 4 字符/token 这个通用经验值起步，并在换算处标注它是近似 —— 真正的 token 计数要等接入
 * 具体模型的分词器，届时只替换这一个函数。
 */
export const CHARS_PER_TOKEN = 4

export function charBudgetForPrompt(params: CompletionParams = DEFAULT_COMPLETION_PARAMS): number {
  return params.promptTokens * CHARS_PER_TOKEN
}
