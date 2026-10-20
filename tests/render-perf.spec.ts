import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { markTabsExternal } from '../src/client/Workbench.tsx'
import { MODEL_CACHE_LIMIT, pruneModels } from '../src/client/MonacoEditor.tsx'
import { createTextMateInstaller, TEXTMATE_MAX_CHARS, TEXTMATE_MAX_LINES, textMateSize, withinTextMateLimits } from '../src/client/textmateHighlight.ts'

/**
 * 客户端重渲染守卫 / 记忆化的**接线**测试。
 *
 * 依据运行时性能审计（_perf/audit-runtime.md 第 3、4、6、8 条与「其它」里的 GitPanel/markdown/搜索热项）：
 *   1. 每条 files.changed 都无条件 `setTabs(map(...))` → 即使没有脏标签变化也整树重渲染；
 *   2. 拖分隔条每个 pointermove 都 setLayout/setState → service.emit + 同步 localStorage.setItem + 整树重渲染；
 *   3. markdownHeadings 每次渲染都全文 split+正则（实测 300KB 文档 416µs/次）；
 *   4. 提交信息框每敲一键都重渲染 100 行提交图的 SVG（graphRows 实测 100 提交 90µs/次）；
 *   5. 每次开文件/切标签都重装 TextMate token provider，作废该语言全部模型的缓存（可见区重分词 6.7ms，
 *      165µs/行、4524 行 725ms），所以需要语言级守卫 + 大文件回退内置分词；
 *   6. 底部面板拖拽每个 pointermove 都 setPanelHeight → 整树重渲染；
 *   7. commit 之后无条件 refresh() 会白跑一次 git.status（多 2 个 git.exe）；
 *   8. Monaco 模型只 getModel/createModel、从不 dispose → 长会话内存随打开文件数线性增长。
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

  it('底部面板高度读 CSS 变量，拖动期间只写变量、只有提交时 setLayout 一次', () => {
    const source = read('Workbench.tsx')
    // 默认值作为变量 fallback 保留；变量本身由 overlay 的 inline style 初始化（无样式表改动）。
    expect(source).toContain('var(--dvw-bottom-height, ${BOTTOM_HEIGHT.default}px)')
    expect(source).toContain("'--dvw-bottom-height':`${bottomHeight}px`")
    // 拖拽手柄接上新函数，旧的内联 setState 版本已消失。
    expect(source).toContain('onPointerDown={dragBottomPanel}')
    expect(source).not.toContain('const move=(e:PointerEvent)=>setPanelHeight(')
    // 高度已经挪进 layout：Workbench 里不该再有 panelHeight 本地 state。
    expect(source).not.toContain('setPanelHeight')
    expect(source).toContain('const setBottomHeight = (value: number) => service.setLayout({ bottomHeight: value })')
    const handlerStart = source.indexOf('const dragBottomPanel=')
    expect(handlerStart).toBeGreaterThan(-1)
    const handlerEnd = source.indexOf('\n  }', handlerStart)
    const handler = source.slice(handlerStart, handlerEnd > handlerStart ? handlerEnd : handlerStart + 1400)
    // pointermove 里只写 CSS 变量：setLayout/setState 会让整棵树重渲染。
    expect(handler).toContain("overlayRef.current?.style.setProperty('--dvw-bottom-height'")
    const moveLine = handler.split('\n').find(line => line.includes('const move='))
    expect(moveLine).toBeDefined()
    expect(moveLine).not.toContain('setBottomHeight')
    // 松手与 pointercancel/失焦都提交（夹取规则不变：BOTTOM_HEIGHT.min .. bottomHeightLimit()）。
    expect(handler).toContain('pointercancel')
    expect(handler).toContain("addEventListener('blur'")
    expect(handler).toContain('Math.max(BOTTOM_HEIGHT.min,Math.min(bottomHeightLimit(),startHeight+startY-nextY))')
  })
})

/** 假模型：只记录 dispose，避免在单测里碰真 Monaco。 */
function fakeModel(uri: string) {
  let disposed = false
  return { uri, get disposed() { return disposed }, dispose() { disposed = true } }
}

describe('Monaco 模型 LRU 回收（审计第 8 项）', () => {
  it('保留「正在使用 + 仍打开的标签」，其余按最近使用只留 limit 个', () => {
    const models = Array.from({ length: 20 }, (_, index) => fakeModel(`file:///f${index}.ts`))
    // 最近使用在前：f19 最新 … f0 最旧。
    const recentOrder = [...models].reverse().map(model => model.uri)
    // f0/f1 虽然最旧，但标签还开着 → 永不回收。
    const evicted = pruneModels(models, { keep: new Set(['file:///f0.ts', 'file:///f1.ts']), recentOrder, limit: 3 })
    // 可回收的 18 个里保留最近 3 个（f19/f18/f17），回收其余 15 个。
    expect(evicted).toHaveLength(15)
    expect(models[19]!.disposed).toBe(false)
    expect(models[18]!.disposed).toBe(false)
    expect(models[17]!.disposed).toBe(false)
    expect(models[0]!.disposed).toBe(false)
    expect(models[1]!.disposed).toBe(false)
    expect(evicted).not.toContain('file:///f0.ts')
    expect(evicted).not.toContain('file:///f19.ts')
    expect(evicted).toContain('file:///f2.ts')
    // 返回值就是被 dispose 的那批 URI，调用方据此清自己的簿记。
    for (const uri of evicted) expect(models.find(model => model.uri === uri)!.disposed).toBe(true)
  })

  it('dirty 集合无条件保留（不在 keep、也不在最近使用里也一样）', () => {
    const open = fakeModel('file:///open.ts')
    const dirty = fakeModel('file:///dirty.ts')
    const stale = fakeModel('file:///stale.ts')
    const evicted = pruneModels([open, dirty, stale], {
      keep: new Set([open.uri]),
      dirty: new Set([dirty.uri]),
      recentOrder: [open.uri],
      limit: 0,
    })
    expect(evicted).toEqual([stale.uri])
    expect(dirty.disposed).toBe(false)
  })

  it('limit 为 0 时回收所有可回收模型，但绝不动 keep/dirty', () => {
    const kept = fakeModel('file:///kept.ts')
    const dirty = fakeModel('file:///dirty.ts')
    const extras = [fakeModel('file:///a.ts'), fakeModel('file:///b.ts')]
    const evicted = pruneModels([kept, dirty, ...extras], {
      keep: new Set([kept.uri]),
      dirty: new Set([dirty.uri]),
      recentOrder: [kept.uri, dirty.uri, extras[0]!.uri, extras[1]!.uri],
      limit: 0,
    })
    expect(evicted.sort()).toEqual(['file:///a.ts', 'file:///b.ts'])
    expect(kept.disposed).toBe(false)
    expect(dirty.disposed).toBe(false)
  })

  it('recentOrder 里没有的模型按「最旧」处理', () => {
    const known = fakeModel('file:///known.ts')
    const unknown = fakeModel('file:///unknown.ts')
    const evicted = pruneModels([known, unknown], { keep: new Set(), recentOrder: [known.uri], limit: 1 })
    expect(evicted).toEqual([unknown.uri])
    expect(known.disposed).toBe(false)
  })

  it('当前正在使用的模型一定不回收（调用方把它放进 keep 的契约）', () => {
    const current = fakeModel('file:///current.ts')
    const older = fakeModel('file:///older.ts')
    const evicted = pruneModels([older, current], { keep: new Set([current.uri]), recentOrder: [current.uri, older.uri], limit: 0 })
    expect(evicted).toEqual([older.uri])
    expect(current.disposed).toBe(false)
  })

  it('默认上限 MODEL_CACHE_LIMIT = 12（超出的最旧模型被回收）', () => {
    expect(MODEL_CACHE_LIMIT).toBe(12)
    const models = Array.from({ length: MODEL_CACHE_LIMIT + 2 }, (_, index) => fakeModel(`file:///g${index}.ts`))
    const evicted = pruneModels(models, { keep: new Set(), recentOrder: models.map(model => model.uri) })
    expect(evicted).toEqual([`file:///g${MODEL_CACHE_LIMIT}.ts`, `file:///g${MODEL_CACHE_LIMIT + 1}.ts`])
  })
})

describe('Monaco 模型回收接线', () => {
  const editor = read('MonacoEditor.tsx')
  const workbench = read('Workbench.tsx')

  it('只在编辑器挂载（切文件/新建模型）时回收一次，不在按键路径上', () => {
    const calls = editor.match(/evictModels\(monaco, uriText, keepPathsRef\.current, dirtyPathsRef\.current \?\? \[\]\)/g) ?? []
    expect(calls).toHaveLength(1)
    // 卸载时只销毁编辑器实例；模型的去留交给 LRU（否则「关标签再打开」会丢 tokenize 缓存）。
    expect(editor).toContain('return () => { disposed = true; editor.current?.dispose(); editor.current = undefined }')
  })

  it('只回收本组件创建的 file:/// 模型（差异编辑器模型由它自己 dispose）', () => {
    expect(editor).toContain('ownedModels.has(model.uri.toString())')
    expect(editor).toContain('models.current?.original.dispose()')
  })

  it('「打开 / 脏」集合由 Workbench 按标签算出来传入，不用全局单例', () => {
    expect(workbench).toContain('keepModelPaths={keepModelPaths}')
    expect(workbench).toContain('dirtyModelPaths={dirtyModelPaths}')
    expect(workbench).toContain("const keepModelPaths=workspace===undefined?undefined:tabs.filter(tab=>!tab.path.startsWith('diff:')).map(tab=>modelUriOf(tab.path))")
    expect(workbench).toContain("const dirtyModelPaths=workspace===undefined?undefined:tabs.filter(tab=>tab.dirty&&!tab.path.startsWith('diff:')).map(tab=>modelUriOf(tab.path))")
    // 工作区未知时传 undefined（编辑器跳过回收判定），避免把打开中的标签误回收。
    expect(editor).toContain('if (keepPathsRef.current !== undefined)')
  })
})

describe('GitPanel：commit 复用宿主返回的状态（审计「其它」）', () => {
  const source = read('GitPanel.tsx')

  it('commit 不再触发整面板 refresh（只重取提交图）', () => {
    expect(source).not.toContain("if(name==='commit')refresh()")
    // 需要重取提交图的动作现在由一个集合描述（提交 / 分支操作 / 远程动作都算）：
    // 这些动作只重取图表，仍然不会触发整面板的 status+log 刷新。
    expect(source).toContain("const RELOG_ACTIONS = new Set(['commit'")
    expect(source).toContain('if(RELOG_ACTIONS.has(name))refreshLog()')
    expect(source).toContain('const refreshLog = useCallback(')
    // 改动列表直接用动作响应更新：宿主对非 diff 动作返回最新 GitStatus。
    expect(source).toContain('setStatus(result as GitStatus)')
    // 面板刷新按钮与 files.changed 仍走完整 refresh（status + log）。
    expect(source).toContain('useEffect(refresh,[refresh])')
    expect(source).toContain('onClick={refresh}')
  })

  it('行为不变：提交成功后清空输入框（CommitBox 里）', () => {
    expect(source).toContain("void onCommit(message).then(() => setMessage(''))")
  })
})

describe('搜索截断文案（审计「其它」）', () => {
  const source = read('Workbench.tsx')

  it('读宿主的 truncated/limited，文案不再写死 2000 条', () => {
    expect(source).toContain("api<SearchResult>('search'")
    expect(source).toContain('setTruncated(result.truncated === true || result.limited === true)')
    expect(source).toContain('结果已截断，请缩小范围或用更精确的查询')
    expect(source).not.toContain('结果已截断到 2000 条')
  })

  it('宿主类型里确实暴露了 truncated（客户端只读，不改宿主行为）', () => {
    const types = readFileSync(fileURLToPath(new URL('../src/types.ts', import.meta.url)), 'utf8')
    expect(types).toContain('truncated: boolean')
  })
})
