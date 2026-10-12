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
const GRAMMAR_BY_LANGUAGE: Record<string, string> = {
  typescript: 'typescript.mjs',
  javascript: 'javascript.mjs',
  json: 'json.mjs',
  jsonc: 'jsonc.mjs',
  css: 'css.mjs',
  scss: 'scss.mjs',
  less: 'less.mjs',
  html: 'html.mjs',
  xml: 'xml.mjs',
  markdown: 'markdown.mjs',
  yaml: 'yaml.mjs',
  toml: 'toml.mjs',
  python: 'python.mjs',
  shell: 'shellscript.mjs',
  powershell: 'powershell.mjs',
  bat: 'bat.mjs',
  go: 'go.mjs',
  rust: 'rust.mjs',
  java: 'java.mjs',
  kotlin: 'kotlin.mjs',
  scala: 'scala.mjs',
  c: 'c.mjs',
  cpp: 'cpp.mjs',
  objective_c: 'objective-cpp.mjs',
  csharp: 'csharp.mjs',
  fsharp: 'fsharp.mjs',
  php: 'php.mjs',
  ruby: 'ruby.mjs',
  swift: 'swift.mjs',
  dart: 'dart.mjs',
  lua: 'lua.mjs',
  perl: 'perl.mjs',
  r: 'r.mjs',
  julia: 'julia.mjs',
  sql: 'sql.mjs',
  graphql: 'graphql.mjs',
  dockerfile: 'dockerfile.mjs',
  makefile: 'makefile.mjs',
  ini: 'ini.mjs',
  nix: 'nix.mjs',
  zig: 'zig.mjs',
  elixir: 'elixir.mjs',
  haskell: 'haskell.mjs',
  clojure: 'clojure.mjs',
  vue: 'vue.mjs',
  svelte: 'svelte.mjs',
  terraform: 'terraform.mjs',
  protobuf: 'protobuf.mjs',
  diff: 'diff.mjs',
  log: 'log.mjs',
  tex: 'tex.mjs',
  restructuredtext: 'rst.mjs'
}

/**
 * scopeName → 加载器。TextMate 语法之间会互相 include（例如 vue 引用 source.css），
 * registry 按 scopeName 索取依赖语法时要有办法把它取回来。
 */
const LOADER_BY_SCOPE: Record<string, string> = {
  'source.ts': 'typescript.mjs',
  'source.tsx': 'tsx.mjs',
  'source.js': 'javascript.mjs',
  'source.js.jsx': 'jsx.mjs',
  'source.json': 'json.mjs',
  'source.css': 'css.mjs',
  'source.css.scss': 'scss.mjs',
  'source.css.less': 'less.mjs',
  'text.html.basic': 'html.mjs',
  'text.xml': 'xml.mjs',
  'text.html.markdown': 'markdown.mjs',
  'source.yaml': 'yaml.mjs',
  'source.toml': 'toml.mjs',
  'source.python': 'python.mjs',
  'source.shell': 'shellscript.mjs',
  'source.powershell': 'powershell.mjs',
  'source.batchfile': 'bat.mjs',
  'source.go': 'go.mjs',
  'source.rust': 'rust.mjs',
  'source.java': 'java.mjs',
  'source.kotlin': 'kotlin.mjs',
  'source.scala': 'scala.mjs',
  'source.c': 'c.mjs',
  'source.cpp': 'cpp.mjs',
  'source.css.mss': 'objective-cpp.mjs',
  'source.cs': 'csharp.mjs',
  'source.fsharp': 'fsharp.mjs',
  'source.php': 'php.mjs',
  'source.ruby': 'ruby.mjs',
  'source.swift': 'swift.mjs',
  'source.dart': 'dart.mjs',
  'source.lua': 'lua.mjs',
  'source.perl': 'perl.mjs',
  'source.r': 'r.mjs',
  'source.julia': 'julia.mjs',
  'source.sql': 'sql.mjs',
  'source.graphql': 'graphql.mjs',
  'source.dockerfile': 'dockerfile.mjs',
  'source.makefile': 'makefile.mjs',
  'source.ini': 'ini.mjs',
  'source.nix': 'nix.mjs',
  'source.zig': 'zig.mjs',
  'source.elixir': 'elixir.mjs',
  'source.haskell': 'haskell.mjs',
  'source.clojure': 'clojure.mjs',
  'source.vue': 'vue.mjs',
  'source.svelte': 'svelte.mjs',
  'source.hcl.terraform': 'terraform.mjs',
  'source.proto': 'protobuf.mjs',
  'source.diff': 'diff.mjs',
  'text.log': 'log.mjs',
  'text.tex.latex': 'tex.mjs',
  'source.rst': 'rst.mjs'
}

/**
 * 取一份 TextMate 语法。
 *
 * 语法数据留在宿主侧按需提供（全部语法合计约 2.5MB，cpp 一份就有 521KB），不进客户端 bundle；
 * 响应带 immutable 缓存，同一份语法只会真正下载一次。这与 oniguruma WASM 的取法一致。
 */
async function loadGrammar(file: string): Promise<GrammarLike> {
  const response = await fetch(`/dsh-vscode/grammar/${file}`)
  if (!response.ok) throw new Error(`grammar ${file}: HTTP ${response.status}`)
  return await response.json() as GrammarLike
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
      const grammar = await loadGrammar(loader)
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
  const grammar = await loadGrammar(loader)
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
