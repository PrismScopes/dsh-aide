import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Search } from '../src/client/Workbench.tsx'
import type { VscodeWorkbench } from '../src/client/service.ts'

/**
 * 搜索面板的静态渲染：只断言「VS Code 那几件东西在不在」，
 * 交互（防抖、F4、替换）由 searchView.spec.ts 的纯函数与 host.spec.ts 的替换用例覆盖。
 * SSR 下 useEffect 不执行，所以传一个空 service 就够。
 */
const html = renderToStaticMarkup(<Search sessionId="session" service={{} as VscodeWorkbench} onOpen={() => {}} />)

describe('搜索面板', () => {
  it('提供大小写、全字、正则三个 VS Code 开关', () => {
    expect(html).toContain('placeholder="搜索"')
    expect(html).toContain('aria-label="区分大小写"')
    expect(html).toContain('aria-label="全字匹配"')
    expect(html).toContain('aria-label="使用正则表达式"')
    expect(html).toContain('codicon-case-sensitive')
    expect(html).toContain('codicon-whole-word')
    expect(html).toContain('codicon-regex')
    // 三个开关默认都是关闭的。
    expect(html).not.toContain('aria-pressed="true"')
  })

  it('把包含/排除文件收进「更多选项」而不是常驻两行输入', () => {
    expect(html).toContain('aria-label="包含/排除文件"')
    expect(html).not.toContain('要包含的文件')
    expect(html).not.toContain('要排除的文件')
  })

  it('替换行默认折叠，只留下展开按钮', () => {
    expect(html).toContain('aria-label="显示替换"')
    expect(html).not.toContain('placeholder="替换"')
    expect(html).not.toContain('aria-label="全部替换"')
  })

  it('没有查询时不显示「未找到结果」而是空列表', () => {
    expect(html).not.toContain('未找到结果')
    expect(html).not.toContain('个结果')
    expect(html).toContain('aria-label="搜索结果"')
  })

  it('工具条带刷新、折叠、清除三个入口', () => {
    expect(html).toContain('aria-label="刷新搜索结果"')
    expect(html).toContain('aria-label="全部折叠"')
    expect(html).toContain('aria-label="清除搜索结果"')
  })
})
