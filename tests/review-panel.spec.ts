import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkpointTime, reviewStatusKey } from '../src/client/ReviewPanel.tsx'

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')
}

const api = read('src/api.ts')
const host = read('src/host.ts')
const workbench = read('src/client/Workbench.tsx')
const index = read('src/client/index.tsx')
const styles = read('src/client/styles.ts')

describe('review panel helpers', () => {
  it('maps git status codes to one-letter badges', () => {
    expect(reviewStatusKey('??')).toBe('U')
    expect(reviewStatusKey('')).toBe('U')
    expect(reviewStatusKey(' M')).toBe('M')
    expect(reviewStatusKey('M')).toBe('M')
    expect(reviewStatusKey(' D')).toBe('D')
    expect(reviewStatusKey('R')).toBe('R')
  })

  it('formats checkpoint time without the date', () => {
    expect(checkpointTime(Date.now())).toMatch(/\d{1,2}:\d{2}:\d{2}/)
    expect(checkpointTime(Number.NaN)).toBe('')
  })
})

describe('review wiring', () => {
  it('exposes review methods on the host API', () => {
    for (const method of ['review.list', 'review.diff', 'review.accept', 'review.acceptAll', 'review.restore', 'review.checkpoint', 'review.rollback', 'review.checkpoint.delete']) {
      expect(api).toContain(`case '${method}'`)
    }
    expect(host).toContain('export async function restoreDocument(')
  })

  it('registers the bottom panel and opens it from the palette', () => {
    expect(index).toContain("registerBottomPanel({ id: 'review', title: '改动', component: ReviewPanel })")
    expect(workbench).toContain("{ id: 'review', label: '改动' }")
    expect(workbench).toContain("add('view.review','查看工作区改动'")
    expect(workbench).toContain("panel.id==='review'")
  })

  it('opens review diffs through the same diff tab as git', () => {
    expect(workbench).toContain('REVIEW_DIFF_EVENT')
    expect(workbench).toContain('openDiffTabRef.current(detail.path')
  })

  it('exposes a status-bar entry with the unreviewed count', () => {
    expect(workbench).toContain("api<{total:number;unreviewed:number}>('review.count'")
    expect(workbench).toContain('className="dvw-status-review"')
    expect(workbench).toContain('个未确认')
  })

  it('ships the panel styles', () => {
    const reviewStyles = read('src/client/reviewStyles.ts')
    for (const selector of ['.dvw-review{', '.dvw-review-row{', '.dvw-review-status{', '.dvw-review-checkpoint{']) {
      expect(reviewStyles).toContain(selector)
    }
    // 样式由 styles.ts 插值，不是复制一份规则。
    expect(styles).toContain('${REVIEW_STYLES}')
  })
})
