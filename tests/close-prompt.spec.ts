import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ClosePrompt,
  closePromptLabels,
  closePromptMode,
  closePromptSummary,
  dirtyCloseTabs,
  needsClosePrompt,
} from '../src/client/ClosePrompt.tsx'
import { autoSaveSettings } from '../src/client/Workbench.tsx'
import { DEFAULT_PREFERENCES } from '../src/client/preferences.ts'

/**
 * 关闭确认对话框的纯逻辑 + 接线静态断言。
 *
 * 这里**不渲染 React**（测试环境是 node）：对话框长什么样由 `.dvw-confirm*` 样式决定，真正需要
 * 守住的是「会不会弹」「弹哪种文案」「Workbench 有没有把各个关闭入口接上」这些容易回归的点。
 * 组件本体用源码静态断言：原生 `confirm(` 必须消失，`service.hide()` 不能绕过确认直接出现。
 */

const readSource = (file: string): string => readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')
const HAS_CHINESE = /[\u4e00-\u9fff]/

/** 只带路径与 dirty 的标签形状：ClosePrompt 不依赖 Tab 的其它字段。 */
interface CloseCandidate { path: string; dirty?: boolean }

describe('close prompt decision helpers', () => {
  it('uses the single-file wording for one file and the batch wording for several', () => {
    expect(closePromptMode(1)).toBe('single')
    // 0 个脏文件根本不该弹框；真被调用时也按单个文案处理，避免批量文案说「以下 0 个文件」。
    expect(closePromptMode(0)).toBe('single')
    expect(closePromptMode(2)).toBe('multiple')
    expect(closePromptMode(9)).toBe('multiple')
  })

  it('only counts tabs whose dirty flag is literally true', () => {
    const tabs: CloseCandidate[] = [
      { path: 'src/a.ts', dirty: true },
      { path: 'src/b.ts', dirty: false },
      { path: 'src/c.ts', dirty: true },
      { path: 'src/d.ts' },
    ]
    expect(dirtyCloseTabs(tabs).map(tab => tab.path)).toEqual(['src/a.ts', 'src/c.ts'])
    expect(needsClosePrompt(tabs)).toBe(true)
    expect(needsClosePrompt([{ path: 'src/b.ts', dirty: false }, { path: 'src/d.ts' }])).toBe(false)
    expect(needsClosePrompt([])).toBe(false)
    // 非布尔的真值（旧数据/手写本地存储）不算脏：与 Tab.dirty 的类型语义保持一致。
    expect(needsClosePrompt([{ dirty: 1 } as unknown as CloseCandidate])).toBe(false)
  })

  it('writes a Chinese summary that names the file for a single close and counts for a batch', () => {
    const single = closePromptSummary(['src/client/Workbench.tsx'])
    expect(single).toContain('src/client/Workbench.tsx')
    expect(single).toContain('未保存')
    expect(single).toMatch(HAS_CHINESE)

    const several = closePromptSummary(['src/a.ts', 'src/b.ts', 'src/c.ts'])
    expect(several).toContain('3')
    expect(several).toContain('个文件')
    expect(several).toContain('未保存')
    expect(several).toMatch(HAS_CHINESE)
    // 多文件时摘要只给数量，具体路径由对话框列表展示（避免一行塞进几十个路径）。
    expect(several).not.toContain('src/a.ts')

    expect(closePromptSummary([])).toMatch(HAS_CHINESE)
  })

  it('labels the buttons like VS Code (save / discard / cancel)', () => {
    expect(closePromptLabels('single')).toEqual({ save: '保存', discard: '不保存', cancel: '取消' })
    expect(closePromptLabels('multiple')).toEqual({ save: '全部保存', discard: '不保存全部', cancel: '取消' })
  })

  it('is a presentation component: three callbacks and no api/service access', () => {
    expect(typeof ClosePrompt).toBe('function')
    const source = readSource('ClosePrompt.tsx')
    expect(source).toMatch(/onSave\(\)/)
    expect(source).toMatch(/onDiscard\(\)/)
    expect(source).toMatch(/onCancel\(\)/)
    // 纯展示：不能自己保存或关闭，决定必须交回 Workbench。
    expect(source).not.toMatch(/from '\.\/(?:api|service)\.ts'/)
  })

  it('is an accessible modal: alertdialog, aria wiring, initial focus and Esc to cancel', () => {
    const source = readSource('ClosePrompt.tsx')
    expect(source).toMatch(/role="alertdialog"/)
    expect(source).toMatch(/aria-modal="true"/)
    expect(source).toMatch(/aria-labelledby=\{TITLE_ID\}/)
    expect(source).toMatch(/aria-describedby=\{DESC_ID\}/)
    expect(source).toMatch(/event\.key === 'Escape'/)
    expect(source).toMatch(/saveButton\.current\?\.focus\(\)/)
    // 批量列表最多显示可见高度，超出滚动。
    expect(source).toMatch(/overflowY: 'auto'/)
    expect(source).toMatch(/maxHeight: 180/)
    // 复用现有确认框样式，不新增全局 CSS。
    expect(source).toMatch(/className="dvw-confirm-backdrop"/)
    expect(source).toMatch(/className="dvw-confirm"/)
  })
})

describe('auto save policy', () => {
  it('follows the preferences contract: off by default, afterDelay opts in with the configured delay', () => {
    expect(autoSaveSettings({ editorAutoSave: 'off', editorAutoSaveDelayMs: 1000 })).toEqual({ enabled: false, delayMs: 1000 })
    expect(autoSaveSettings({ editorAutoSave: 'afterDelay', editorAutoSaveDelayMs: 1500 })).toEqual({ enabled: true, delayMs: 1500 })
    expect(autoSaveSettings(DEFAULT_PREFERENCES)).toEqual({ enabled: false, delayMs: 1000 })
  })
})

describe('workbench wiring', () => {
  const source = readSource('Workbench.tsx')

  it('replaces every native confirm() for tab closing with the ClosePrompt dialog', () => {
    // 关闭标签不再弹浏览器原生确认框：单个/批量都走同一个页内对话框。
    expect(source).not.toMatch(/\bconfirm\s*\(/)
    expect(source).toMatch(/from '\.\/ClosePrompt\.tsx'/)
    expect(source).toMatch(/<ClosePrompt\b/)
    expect(source).toMatch(/pendingClose/)
  })

  it('routes the close button, batch close commands and every close entry through requestCloseTabs', () => {
    // × 按钮、关闭其他/右侧/已保存、全部关闭，全部先算路径再交给同一个请求函数。
    expect(source).toMatch(/requestCloseTabs\(\[tab\.path\]\)/)
    expect(source).toMatch(/const closeAll=\(\)=>requestCloseTabs\(/)
    expect(source).toMatch(/const closeOtherTabs=\(path:string\)=>requestCloseTabs\(/)
    expect(source).toMatch(/const closeRightTabs=\(path:string\)=>\{[\s\S]*?requestCloseTabs\(/)
    expect(source).toMatch(/const closeSavedTabs=\(\)=>requestCloseTabs\(/)
    expect(source).toMatch(/close:\(\)=>requestCloseTabs\(\[menu\.path\]\)/)
    expect(source.match(/requestCloseTabs\(/g)?.length ?? 0).toBeGreaterThanOrEqual(6)
  })

  it('asks before hiding the workbench and only hides after saving succeeds', () => {
    expect(source).toMatch(/const hideWorkbench=/)
    expect(source).not.toMatch(/onClick=\{\(\)=>service\.hide\(\)\}/)
    // 三个「返回 DSH」入口（空会话、活动栏、状态栏）都要经过 hideWorkbench。
    expect(source.match(/hideWorkbench\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
    // 「保存失败则不隐藏」：hide 分支只有在没有失败时才调用 service.hide()。
    expect(source).toMatch(/if\(failed\.size===0\)service\.hide\(\)/)
  })

  it('wires auto save to the preferences store and reuses the existing save()', () => {
    expect(source).toMatch(/usePreferences\(\)/)
    expect(source).toMatch(/autoSaveSettings\(preferences\)/)
    expect(source).toMatch(/editorAutoSave/)
    // 自动保存只是给现有 save() 排定时器，不能另写一套写盘逻辑。
    expect(source.match(/void saveRef\.current\(latest\)/g)?.length ?? 0).toBe(1)
    // 关掉自动保存或工作台隐藏时清理定时器。
    expect(source).toMatch(/if\(!snapshot\.visible\|\|!autoSave\.enabled\)\{stopAll\(\);return\}/)
  })
})
