/**
 * 用 TextMate 语法替换 Monaco 内置分词，使高亮与 VS Code 同源。
 *
 * 为什么需要它：Monaco 默认用内置的 Monarch / worker 语义分词，token 分类比 VS Code 粗
 * （例如把 number、string、boolean 这些类型关键字一并归入 keyword，把变量与函数统一归入
 * identifier），所以即使配色规则照抄 VS Code，颜色也对不上。这里改为用 VS Code 自己使用的
 * TextMate 引擎（vscode-textmate + vscode-oniguruma）逐行分词，产出的 scope 名与 VS Code
 * 完全一致，主题里的 scope→颜色规则即可原样生效。
 */
import * as oniguruma from 'vscode-oniguruma'
import * as vsctm from 'vscode-textmate'
import type * as MonacoNamespace from 'monaco-editor'

interface GrammarLike { scopeName: string }

/** @shikijs/langs 每个语言模块导出的是 LanguageRegistration 数组（通常只有一个元素）。 */
type GrammarModule = { default: GrammarLike[] }

/**
 * 语言标识（Monaco 的语言 id）→ 语法模块的动态导入。
 * 用动态 import 是为了让未用到的语言的语法不进 bundle。
 */
const GRAMMAR_BY_LANGUAGE: Record<string, () => Promise<GrammarModule>> = {
  typescript: () => import('@shikijs/langs/typescript'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  less: () => import('@shikijs/langs/less'),
  html: () => import('@shikijs/langs/html'),
  xml: () => import('@shikijs/langs/xml'),
  markdown: () => import('@shikijs/langs/markdown'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  python: () => import('@shikijs/langs/python'),
  shell: () => import('@shikijs/langs/shellscript'),
  powershell: () => import('@shikijs/langs/powershell'),
  bat: () => import('@shikijs/langs/bat'),
  go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'),
  java: () => import('@shikijs/langs/java'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  scala: () => import('@shikijs/langs/scala'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  objective_c: () => import('@shikijs/langs/objective-cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  fsharp: () => import('@shikijs/langs/fsharp'),
  php: () => import('@shikijs/langs/php'),
  ruby: () => import('@shikijs/langs/ruby'),
  swift: () => import('@shikijs/langs/swift'),
  dart: () => import('@shikijs/langs/dart'),
  lua: () => import('@shikijs/langs/lua'),
  perl: () => import('@shikijs/langs/perl'),
  r: () => import('@shikijs/langs/r'),
  julia: () => import('@shikijs/langs/julia'),
  sql: () => import('@shikijs/langs/sql'),
  graphql: () => import('@shikijs/langs/graphql'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  makefile: () => import('@shikijs/langs/makefile'),
  ini: () => import('@shikijs/langs/ini'),
  nix: () => import('@shikijs/langs/nix'),
  zig: () => import('@shikijs/langs/zig'),
  elixir: () => import('@shikijs/langs/elixir'),
  haskell: () => import('@shikijs/langs/haskell'),
  clojure: () => import('@shikijs/langs/clojure'),
  vue: () => import('@shikijs/langs/vue'),
  svelte: () => import('@shikijs/langs/svelte'),
  terraform: () => import('@shikijs/langs/terraform'),
  protobuf: () => import('@shikijs/langs/protobuf'),
  diff: () => import('@shikijs/langs/diff'),
  log: () => import('@shikijs/langs/log'),
  tex: () => import('@shikijs/langs/tex'),
  restructuredtext: () => import('@shikijs/langs/rst')
}

/**
 * scopeName → 加载器。TextMate 语法之间会互相 include（例如 vue 引用 source.css），
 * registry 按 scopeName 索取依赖语法时要有办法把它取回来。
 */
const LOADER_BY_SCOPE: Record<string, () => Promise<GrammarModule>> = {
  'source.ts': () => import('@shikijs/langs/typescript'),
  'source.tsx': () => import('@shikijs/langs/tsx'),
  'source.js': () => import('@shikijs/langs/javascript'),
  'source.js.jsx': () => import('@shikijs/langs/jsx'),
  'source.json': () => import('@shikijs/langs/json'),
  'source.css': () => import('@shikijs/langs/css'),
  'source.css.scss': () => import('@shikijs/langs/scss'),
  'source.css.less': () => import('@shikijs/langs/less'),
  'text.html.basic': () => import('@shikijs/langs/html'),
  'text.xml': () => import('@shikijs/langs/xml'),
  'text.html.markdown': () => import('@shikijs/langs/markdown'),
  'source.yaml': () => import('@shikijs/langs/yaml'),
  'source.toml': () => import('@shikijs/langs/toml'),
  'source.python': () => import('@shikijs/langs/python'),
  'source.shell': () => import('@shikijs/langs/shellscript'),
  'source.powershell': () => import('@shikijs/langs/powershell'),
  'source.batchfile': () => import('@shikijs/langs/bat'),
  'source.go': () => import('@shikijs/langs/go'),
  'source.rust': () => import('@shikijs/langs/rust'),
  'source.java': () => import('@shikijs/langs/java'),
  'source.kotlin': () => import('@shikijs/langs/kotlin'),
  'source.scala': () => import('@shikijs/langs/scala'),
  'source.c': () => import('@shikijs/langs/c'),
  'source.cpp': () => import('@shikijs/langs/cpp'),
  'source.css.mss': () => import('@shikijs/langs/objective-cpp'),
  'source.cs': () => import('@shikijs/langs/csharp'),
  'source.fsharp': () => import('@shikijs/langs/fsharp'),
  'source.php': () => import('@shikijs/langs/php'),
  'source.ruby': () => import('@shikijs/langs/ruby'),
  'source.swift': () => import('@shikijs/langs/swift'),
  'source.dart': () => import('@shikijs/langs/dart'),
  'source.lua': () => import('@shikijs/langs/lua'),
  'source.perl': () => import('@shikijs/langs/perl'),
  'source.r': () => import('@shikijs/langs/r'),
  'source.julia': () => import('@shikijs/langs/julia'),
  'source.sql': () => import('@shikijs/langs/sql'),
  'source.graphql': () => import('@shikijs/langs/graphql'),
  'source.dockerfile': () => import('@shikijs/langs/dockerfile'),
  'source.makefile': () => import('@shikijs/langs/makefile'),
  'source.ini': () => import('@shikijs/langs/ini'),
  'source.nix': () => import('@shikijs/langs/nix'),
  'source.zig': () => import('@shikijs/langs/zig'),
  'source.elixir': () => import('@shikijs/langs/elixir'),
  'source.haskell': () => import('@shikijs/langs/haskell'),
  'source.clojure': () => import('@shikijs/langs/clojure'),
  'source.vue': () => import('@shikijs/langs/vue'),
  'source.svelte': () => import('@shikijs/langs/svelte'),
  'source.hcl.terraform': () => import('@shikijs/langs/terraform'),
  'source.proto': () => import('@shikijs/langs/protobuf'),
  'source.diff': () => import('@shikijs/langs/diff'),
  'text.log': () => import('@shikijs/langs/log'),
  'text.tex.latex': () => import('@shikijs/langs/tex'),
  'source.rst': () => import('@shikijs/langs/rst')
}

let onigLibPromise: Promise<vsctm.IOnigLib> | undefined

/** 加载 oniguruma 的 WASM（由宿主路由提供），只做一次。 */
function loadOnigLib(): Promise<vsctm.IOnigLib> {
  onigLibPromise ??= (async () => {
    const response = await fetch('/dsh-vscode/onig/onig.wasm')
    if (!response.ok) throw new Error(`oniguruma wasm: HTTP ${response.status}`)
    await oniguruma.loadWASM(await response.arrayBuffer())
    return {
      createOnigScanner: (patterns: string[]) => new oniguruma.OnigScanner(patterns),
      createOnigString: (text: string) => new oniguruma.OnigString(text)
    }
  })()
  return onigLibPromise
}

const grammarByScope = new Map<string, GrammarLike>()

/**
 * 一个共享的 registry：它由 TextMate 语法内部的 include 关系驱动，
 * 语法之间会互相索取（vue 要 source.css 等），所以缓存必须跨语言共用。
 */
let registry: vsctm.Registry | undefined
/**
 * TextMate 语法会互相 include（vue 要 source.css 之类），registry 因此必须全局共用，
 * 并在索取依赖 scope 时按需把对应语言的语法加载进来。
 */
function getRegistry(): vsctm.Registry {
  registry ??= new vsctm.Registry({
    onigLib: loadOnigLib(),
    loadGrammar: async (scopeName: string) => {
      const cached = grammarByScope.get(scopeName)
      if (cached !== undefined) return cached as never
      const loader = LOADER_BY_SCOPE[scopeName]
      if (loader === undefined) return null
      const grammar = (await loader()).default[0]
      if (grammar === undefined) return null
      grammarByScope.set(scopeName, grammar)
      return grammar as never
    }
  })
  return registry
}

/** 把语法登记进 scope 索引，供 registry 内部解析 include 时取用。 */
async function grammarFor(languageId: string): Promise<GrammarLike | undefined> {
  const loader = GRAMMAR_BY_LANGUAGE[languageId]
  if (loader === undefined) return undefined
  const grammar = (await loader()).default[0]
  if (grammar === undefined) return undefined
  grammarByScope.set(grammar.scopeName, grammar)
  return grammar
}

interface TextMateToken { startIndex: number; scopes: string[] }

/**
 * 预热 TextMate：提前加载 oniguruma WASM、建立 registry，并（可选）编译若干语言的语法。
 *
 * 首次装分词器要花约 100ms（实测），主要是 WASM 加载与语法编译。这次开销如果落在用户点开
 * 文件的时刻，就表现为「点开卡一下」。工作台打开时调用本函数，把这段开销挪到用户不敏感的时刻。
 *
 * 刻意不 await、也不抛错：预热失败不影响后续流程，真正装分词器时还会再走一遍同样的路径。
 */
export function preloadTextMate(languageIds: string[] = []): void {
  void (async () => {
    try {
      const registry = getRegistry()
      await loadOnigLib()
      for (const languageId of languageIds) {
        const grammar = await grammarFor(languageId)
        if (grammar === undefined) continue
        await registry.loadGrammar(grammar.scopeName)
      }
    } catch { /* 预热失败无所谓，installTextMate 会再试 */ }
  })()
}

/**
 * 为指定语言装上 TextMate 分词器，替换 Monaco 内置实现。
 * 语言不在支持表内、或 WASM / 语法加载失败时静默跳过 —— 该语言继续用内置分词，
 * 高亮会退回上一版的近似配色，而不是让编辑器报错。
 */
export async function installTextMate(monaco: typeof MonacoNamespace, languageIds: string[]): Promise<void> {
  const registry = getRegistry()
  const wanted = [...new Set(languageIds)].filter((id) => GRAMMAR_BY_LANGUAGE[id] !== undefined)
  for (const languageId of wanted) {
    const grammar = await grammarFor(languageId)
    if (grammar === undefined) continue
    // loadGrammar 收的是 scopeName，语法本体由上面的 loadGrammar 回调按 scope 取回。
    const loaded = await registry.loadGrammar(grammar.scopeName)
    if (loaded === null) continue
    monaco.languages.setTokensProvider(languageId, {
      getInitialState: () => vsctm.INITIAL,
      tokenize: (line: string, state: vsctm.StateStack): { endState: vsctm.StateStack; tokens: { startIndex: number; scopes: string }[] } => {
        const result = loaded.tokenizeLine(line, state)
        return {
          endState: result.ruleStack,
          tokens: result.tokens.map((token: TextMateToken) => ({
            startIndex: token.startIndex,
            // TextMate 给的是空格分隔的 scope 链（如 "source.ts meta.import.ts keyword.control.import.ts"），
            // 而 Monaco 的 token 名只能是点分层级、匹配不了带空格的串，会让所有规则失效。
            // 因此取最具体的那一段；VS Code 主题的规则基本都按最具体 scope 写，前缀匹配即可命中。
            scopes: token.scopes[token.scopes.length - 1] ?? ''
          }))
        }
      }
    })
  }
}
