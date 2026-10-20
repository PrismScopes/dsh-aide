import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { markTabsExternal } from '../src/client/Workbench.tsx'
import { createTextMateInstaller, TEXTMATE_MAX_CHARS, TEXTMATE_MAX_LINES, textMateSize, withinTextMateLimits } from '../src/client/textmateHighlight.ts'

/**
 * 客户端重渲染守卫 / 记忆化的**接线**测试。
 *
 * 依据运行时性能审计（_perf/audit-runtime.md 第 3、4、6 条与「其它」里的 GitPanel/markdown 热项）：
 *   1. 每条 files.changed 都无条件 `setTabs(map(...))` → 即使没有脏标签变化也整树重渲染；
 *   2. 拖分隔条每个 pointermove 都 setLayout/setState → service.emit + 同步 localStorage.setItem + 整树重渲染；
 *   3. markdownHeadings 每次渲染都全文 split+正则（实测 300KB 文档 416µs/次）；
 *   4. 提交信息框每敲一键都重渲染 100 行提交图的 SVG（graphRows 实测 100 提交 90µs/次）；
 *   5. 每次开文件/切标签都重装 TextMate token provider，作废该语言全部模型的缓存（可见区重分词 6.7ms，
 *      165µs/行、4524 行 725ms），所以需要语言级守卫 + 大文件回退内置分词；
 *   6. 底部面板拖拽每个 pointermove 都 setPanelHeight → 整树重渲染。
 *
 * 组件本身没有 jsdom 可渲染，所以行为用纯函数断言、接线用源码静态断言钉住 —— 与
 * close-prompt.spec.ts / panel-resize.spec.ts 的既有风格一致。
 */
const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../src/client/${path}`, import.meta.url)), 'utf8')

/** 只关心守卫用到的三个字段；其余字段（path/revision…）用它验证「一个都不该丢」。 */
type TabLike = { path: string; dirty?: boolean; external?: boolean; revision?: string }

describe('markTabsExternal：磁盘变更标记的守卫', () => {
  it('没有任何脏标签时返回原数组（React 直接 bail out，不重渲染）', () => {
    const tabs: TabLike[] = [{ path: 'a.ts' }, { path: 'b.ts', revision: 'r1' }]
    expect(markTabsExternal(tabs)).toBe(tabs)
  })

  it('脏标签都已经标记过时同样返回原数组', () => {
    const tabs: TabLike[] = [{ path: 'a.ts', dirty: true, external: true }]
    expect(markTabsExternal(tabs)).toBe(tabs)
  })

  it('只给未标记的脏标签打 external，其余标签保持同一个对象引用', () => {
    const dirty: TabLike = { path: 'a.ts', dirty: true }
    const clean: TabLike = { path: 'b.ts' }
    const already: TabLike = { path: 'c.ts', dirty: true, external: true }
    const next = markTabsExternal([dirty, clean, already])
    expect(next).not.toBe([dirty, clean, already])
    expect(next[0]).toEqual({ path: 'a.ts', dirty: true, external: true })
    expect(next[0]).not.toBe(dirty)
    expect(next[1]).toBe(clean)
    expect(next[2]).toBe(already)
  })

  it('不丢其它字段：只新增 external', () => {
    const next = markTabsExternal<TabLike>([{ path: 'a.ts', dirty: true, revision: 'r1' }])
    expect(next[0]).toEqual({ path: 'a.ts', dirty: true, revision: 'r1', external: true })
  })

  it('空列表也返回原数组', () => {
    const empty: TabLike[] = []
    expect(markTabsExternal(empty)).toBe(empty)
  })
})

describe('Workbench 的重渲染接线', () => {
  const source = read('Workbench.tsx')

  it('files.changed 走 markTabsExternal 守卫，不再无条件 map 出新数组', () => {
    expect(source).toContain('setTabs(markTabsExternal)')
    expect(source).not.toContain('setTabs(current => current.map(tab => tab.dirty ? { ...tab, external: true } : tab))')
  })

  it('拖动分隔条期间只写 CSS 变量，pointerup/pointercancel/失焦才落库一次', () => {
    // 视觉跟随：只写 overlay 上的两个变量，不经过 setLayout（否则每个 pointermove 都 emit + 写 localStorage）。
    expect(source).toContain('const overlayRef=useRef<HTMLDivElement>(null)')
    expect(source).toContain('overlayRef.current?.style.setProperty(cssName,`${value}px`)')
    // 内嵌的 DSH 对话栏是 fixed 定位、不在 overlay 子树里，拖动时必须同步写它自己的变量。
    expect(source).toContain("document.querySelector<HTMLElement>('[data-dvw-conversation-panel]')?.style.setProperty(cssName,`${value}px`)")
    // 两个分隔条都接上了 onPreview。
    expect(source).toContain("onPreview={previewPanelWidth('sideWidth')}")
    expect(source).toContain("onPreview={previewPanelWidth('chatWidth')}")
    // pointermove 只调预览，pointerup 与 cancel/blur 都提交（cancel 也提交：宽度已经视觉生效）。
    expect(source).toContain('(onPreview ?? onWidth)(widthAt(lastX))')
    expect(source).toContain('const cancel = () => cleanup(true)')
    // 键盘与双击恢复默认仍走 onWidth（一次提交）。
    expect(source).toContain('onDoubleClick={() => onWidth(defaultWidth)}')
  })

  it('markdownHeadings 用 useMemo，且 hooks 位于提前返回之前', () => {
    expect(source).toContain('const headings=useMemo(()=>markdownSource===undefined?[]:markdownHeadings(markdownSource),[markdownSource])')
    const memoAt = source.indexOf('const headings=useMemo(')
    const earlyReturnAt = source.indexOf('if(!snapshot.visible)return null')
    expect(memoAt).toBeGreaterThan(-1)
    expect(earlyReturnAt).toBeGreaterThan(-1)
    // 依赖只有源文本：hooks 不能放在条件分支之后，所以这段必须挪到 return null 之前。
    expect(memoAt).toBeLessThan(earlyReturnAt)
    expect(source).toContain('const markdownSource=markdownPreview&&activeTab!==undefined?(activeTab.diff?.modified??activeTab.draft):undefined')
  })
})

describe('GitPanel 的提交图/输入框接线', () => {
  const source = read('GitPanel.tsx')

  it('graphRows 只在 commits 变化时重算', () => {
    expect(source).toContain('const rows = useMemo(() => graphRows(commits), [commits])')
    expect(source).not.toContain('graphRows(commits).map(')
  })

  it('提交图与行级 SVG 都是 memo 组件（行对象身份稳定时跳过重画）', () => {
    expect(source).toContain('export const CommitGraph = memo(function CommitGraph(')
    expect(source).toContain('const GraphTracks = memo(GraphTracksBase)')
    expect(source).toContain('const GraphContinuation = memo(GraphContinuationBase)')
  })

  it('提交信息输入框独立成组件：message 状态只在 CommitBox 里', () => {
    expect(source).toContain('<CommitBox busy={busy} branch={status.branch}')
    expect(source.match(/const \[message, setMessage\] = useState\(''\)/g) ?? []).toHaveLength(1)
    const commitBoxAt = source.indexOf('function CommitBox(')
    const messageStateAt = source.indexOf("const [message, setMessage] = useState('')")
    const gitAt = source.indexOf('export function Git(')
    expect(commitBoxAt).toBeGreaterThan(-1)
    expect(messageStateAt).toBeGreaterThan(commitBoxAt)
    expect(messageStateAt).toBeLessThan(gitAt)
    // 原来的内联输入框不能再出现（那会让每次按键重渲染整个面板）。
    expect(source).not.toContain("onChange={event=>setMessage(event.target.value)}")
  })

  it('提交图回调有稳定标识，否则 memo(CommitGraph) 等于没做', () => {
    for (const binding of ['onToggle={graphOnToggle}', 'onOpenFile={graphOnOpenFile}', 'onMenu={graphOnMenu}', 'onFileMenu={graphOnFileMenu}']) {
      expect(source).toContain(binding)
    }
    expect(source).toContain('const graphOnMenu=useCallback(')
    expect(source).toContain('const graphOnFileMenu=useCallback(')
    expect(source).toContain('const toggleCommit=useCallback(')
    expect(source).toContain('const openCommitFile=useCallback(')
    // onDiff 由 Workbench 每次渲染新建，必须用 ref 持有，否则依赖一变提交图的 memo 就失效。
    expect(source).toContain('const onDiffRef=useRef(props.onDiff);onDiffRef.current=props.onDiff')
    expect(source).toMatch(/onDiffRef\.current\(`commit:\$\{commit\.hash\}/)
  })
})

describe('Markdown 预览不重复渲染', () => {
  it('渲染结果按 [source,sessionId,path] 记忆化（marked + DOMPurify 只跑一次）', () => {
    const preview = read('MarkdownPreview.tsx')
    expect(preview).toContain('const html=useMemo(')
    expect(preview).toMatch(/\[source,sessionId,path\]/)
  })
})

/** 假语法：安装器只要求「能 tokenizeLine」，不碰真 oniguruma。 */
const fakeGrammar = { tokenizeLine: () => ({ ruleStack: {}, tokens: [] }) }

describe('TextMate 安装守卫：语言级幂等', () => {
  function setup() {
    const registered: string[] = []
    const installer = createTextMateInstaller({
      compile: async () => fakeGrammar,
      register: languageId => { registered.push(languageId) },
    })
    return { installer, registered }
  }

  it('同一语言第二次 install 不再注册（否则每次开文件都作废该语言全部模型的 tokenize 缓存）', async () => {
    const { installer, registered } = setup()
    expect(await installer.install(['typescript'])).toEqual({ installed: ['typescript'], skipped: false })
    // 第二次（切标签 / 重开文件）必须退化成空操作。
    expect(await installer.install(['typescript'])).toEqual({ installed: [], skipped: false })
    expect(registered).toEqual(['typescript'])
    expect(installer.installed('typescript')).toBe(true)
  })

  it('同一语言的并发安装只注册一次（同时打开两个同语言文件）', async () => {
    let releaseCompile: (() => void) | undefined
    const gate = new Promise<void>(resolve => { releaseCompile = resolve })
    const registered: string[] = []
    let compileCalls = 0
    const installer = createTextMateInstaller({
      compile: async () => { compileCalls++; await gate; return fakeGrammar },
      register: languageId => { registered.push(languageId) },
    })
    const first = installer.install(['typescript'])
    const second = installer.install(['typescript'])
    releaseCompile?.()
    await Promise.all([first, second])
    expect(compileCalls).toBe(1)
    expect(registered).toEqual(['typescript'])
  })

  it('一次传多个语言时按语言去重后再装', async () => {
    const { installer, registered } = setup()
    expect(await installer.install(['typescript', 'json', 'typescript'])).toEqual({ installed: ['typescript', 'json'], skipped: false })
    expect(registered).toEqual(['typescript', 'json'])
  })
})

describe('TextMate 大文件回退', () => {
  it('超过行数阈值的大文件整体跳过，且不会把语言记成已安装', async () => {
    const registered: string[] = []
    const installer = createTextMateInstaller({
      compile: async () => fakeGrammar,
      register: languageId => { registered.push(languageId) },
    })
    expect(await installer.install(['typescript'], { lines: TEXTMATE_MAX_LINES + 1, chars: 10 })).toEqual({ installed: [], skipped: true })
    expect(registered).toEqual([])
    expect(installer.installed('typescript')).toBe(false)
    // 同类型的小文件之后仍然要装：跳过不能被缓存成「已安装」。
    expect(await installer.install(['typescript'], { lines: 100, chars: 1000 })).toEqual({ installed: ['typescript'], skipped: false })
    expect(registered).toEqual(['typescript'])
  })

  it('单行超长（压缩 JSON）也跳过：行数判不出来，靠字符数上限', async () => {
    const registered: string[] = []
    const installer = createTextMateInstaller({
      compile: async () => fakeGrammar,
      register: languageId => { registered.push(languageId) },
    })
    expect(await installer.install(['json'], { lines: 1, chars: TEXTMATE_MAX_CHARS + 1 })).toEqual({ installed: [], skipped: true })
    expect(registered).toEqual([])
  })

  it('不支持的语言不 compile、语法加载失败时不记成已安装', async () => {
    const registered: string[] = []
    const compiled: string[] = []
    const installer = createTextMateInstaller({
      compile: async languageId => { compiled.push(languageId); return undefined },
      register: languageId => { registered.push(languageId) },
    })
    expect(await installer.install(['plaintext', 'typescript'])).toEqual({ installed: [], skipped: false })
    expect(compiled).toEqual(['typescript'])   // plaintext 不在语法表里，连 compile 都不该发生
    expect(registered).toEqual([])
    expect(installer.installed('typescript')).toBe(false)
  })

  it('阈值常量与边界：3000 行 / 200000 字符，先到者', () => {
    expect(TEXTMATE_MAX_LINES).toBe(3000)
    expect(TEXTMATE_MAX_CHARS).toBe(200_000)
    // 没提供规模时保持旧行为（要装）—— 直接调用旧签名的调用方不会突然失去高亮。
    expect(withinTextMateLimits(undefined)).toBe(true)
    expect(withinTextMateLimits({ lines: TEXTMATE_MAX_LINES, chars: TEXTMATE_MAX_CHARS })).toBe(true)
    expect(withinTextMateLimits({ lines: TEXTMATE_MAX_LINES + 1, chars: 0 })).toBe(false)
    expect(withinTextMateLimits({ lines: 1, chars: TEXTMATE_MAX_CHARS + 1 })).toBe(false)
  })

  it('textMateSize 只用 O(1) 计数器（getLineCount/getValueLength），不复制正文', () => {
    expect(textMateSize({ getLineCount: () => 12, getValueLength: () => 345 })).toEqual({ lines: 12, chars: 345 })
  })
})

describe('TextMate / 底部面板的接线', () => {
  it('两条 installTextMate 调用都带上模型规模（大文件才会走回退）', () => {
    const editor = read('MonacoEditor.tsx')
    expect(editor).toContain('installTextMate(monaco, [model.getLanguageId()], textMateSize(model))')
    expect(editor).toContain('installTextMate(monaco, [original.getLanguageId()], textMateSize(original))')
  })

  it('底部面板高度读 CSS 变量，拖动期间只写变量、只有提交时 setState', () => {
    const source = read('Workbench.tsx')
    // 默认值 260px 作为变量 fallback 保留；变量本身由 overlay 的 inline style 初始化（无样式表改动）。
    expect(source).toContain("height:'var(--dvw-bottom-height, 260px)'")
    expect(source).toContain("'--dvw-bottom-height':`${panelHeight}px`")
    // 拖拽手柄接上新函数，旧的内联 setState 版本已消失。
    expect(source).toContain('onPointerDown={dragBottomPanel}')
    expect(source).not.toContain('const move=(e:PointerEvent)=>setPanelHeight(')
    // 整个文件里 setPanelHeight 只出现一次：就是提交那一次。
    expect(source.match(/setPanelHeight\(/g) ?? []).toHaveLength(1)
    const handlerStart = source.indexOf('const dragBottomPanel=')
    expect(handlerStart).toBeGreaterThan(-1)
    const handlerEnd = source.indexOf('\n  }', handlerStart)
    const handler = source.slice(handlerStart, handlerEnd > handlerStart ? handlerEnd : handlerStart + 1200)
    // pointermove 里只写 CSS 变量：setState 会让整棵树（含提交图/资源管理器/终端面板）重渲染。
    expect(handler).toContain("overlayRef.current?.style.setProperty('--dvw-bottom-height'")
    const moveLine = handler.split('\n').find(line => line.includes('const move='))
    expect(moveLine).toBeDefined()
    expect(moveLine).not.toContain('setPanelHeight')
    // 松手与 pointercancel/失焦都提交（夹取规则不变：120 .. innerHeight-160）。
    expect(handler).toContain('pointercancel')
    expect(handler).toContain("addEventListener('blur'")
    expect(handler).toContain('Math.max(120,Math.min(window.innerHeight-160,startHeight+startY-nextY))')
  })
})
