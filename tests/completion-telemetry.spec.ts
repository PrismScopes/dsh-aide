import { describe, expect, it } from 'vitest'
import { COMPLETION_EXPERIMENT_GROUPS, groupForSession, paramsForGroup } from '../src/completion/experiment.ts'
import { TelemetryAggregator, type CompletionTelemetryEvent } from '../src/completion/telemetry.ts'
import { DEFAULT_COMPLETION_PARAMS } from '../src/completion/params.ts'

const shown = (over: Partial<CompletionTelemetryEvent> = {}): CompletionTelemetryEvent => ({ kind: 'shown', sessionId: 's', language: 'typescript', ...over })

describe('telemetry aggregation', () => {
  it('derives both rates from counts rather than averaging per-bucket rates', () => {
    const aggregator = new TelemetryAggregator()
    // 大样本桶：10 次展示 5 次采纳；小样本桶：1 次展示 0 次采纳。
    for (let index = 0; index < 10; index++) aggregator.record(shown({ language: 'typescript' }))
    for (let index = 0; index < 5; index++) aggregator.record({ kind: 'accepted', sessionId: 's', language: 'typescript' })
    aggregator.record(shown({ language: 'python' }))
    // 若按桶求平均会得到 (0.5 + 0)/2 = 0.25；按计数加总算应是 5/11。
    expect(aggregator.stats().acceptanceRate).toBeCloseTo(5 / 11)
    expect(aggregator.stats({ language: 'python' }).acceptanceRate).toBe(0)
  })

  it('reports null instead of zero when nothing was shown', () => {
    const aggregator = new TelemetryAggregator()
    expect(aggregator.stats()).toEqual({ shown: 0, accepted: 0, cancelled: 0, failed: 0, acceptanceRate: null, cancelRate: null, averageFirstByteMs: null })
    aggregator.record({ kind: 'accepted', sessionId: 's', language: 'typescript' })
    // 有采纳但没有展示：比率无意义，仍为 null，而不是 Infinity 或 0。
    expect(aggregator.stats().acceptanceRate).toBeNull()
    expect(aggregator.stats().accepted).toBe(1)
  })

  it('counts upstream failures and remembers why, so a broken path is visible', () => {
    // 上游失败如果只表现为「没有补全」，第二天只能靠猜。
    const aggregator = new TelemetryAggregator()
    aggregator.record(shown({}))
    aggregator.record({ kind: 'failed', sessionId: 's', language: 'typescript', error: 'deepseek messages transport failed' })
    aggregator.record({ kind: 'failed', sessionId: 's', language: 'typescript', error: 'timeout' })
    const stats = aggregator.stats()
    expect(stats.failed).toBe(2)
    // 失败不算展示，因此不影响采纳率的分母。
    expect(stats.shown).toBe(1)
    expect(aggregator.failure()).toBe('timeout')
    aggregator.record({ kind: 'failed', sessionId: 's', language: 'typescript', error: '' })
    expect(aggregator.failure()).toBe('timeout')
    aggregator.reset()
    expect(aggregator.failure()).toBeUndefined()
  })

  it('splits buckets by language and experiment group', () => {
    const aggregator = new TelemetryAggregator()
    aggregator.record(shown({ language: 'typescript', experiment: 'control' }))
    aggregator.record({ kind: 'accepted', sessionId: 's', language: 'typescript', experiment: 'control' })
    aggregator.record(shown({ language: 'typescript', experiment: 'treatment' }))
    const groups = aggregator.byExperiment()
    expect(groups.map(group => group.experiment)).toEqual(['control', 'treatment'])
    expect(groups[0]?.stats.acceptanceRate).toBe(1)
    expect(groups[1]?.stats.acceptanceRate).toBe(0)
    expect(aggregator.stats({ experiment: 'control' }).shown).toBe(1)
  })

  it('averages first-byte latency only over the samples that carry one', () => {
    const aggregator = new TelemetryAggregator()
    aggregator.record(shown({ firstByteMs: 100 }))
    aggregator.record(shown({ firstByteMs: 200 }))
    aggregator.record(shown())
    expect(aggregator.stats().averageFirstByteMs).toBe(150)
  })

  it('folds overflow into a single other bucket instead of dropping events', () => {
    const aggregator = new TelemetryAggregator()
    for (let index = 0; index < 260; index++) aggregator.record(shown({ language: `lang-${index}` }))
    // 事件不能丢：展示总数必须等于写入次数。
    expect(aggregator.stats().shown).toBe(260)
    const others = aggregator.byExperiment().filter(group => group.experiment === 'other')
    expect(others[0]?.stats.shown).toBeGreaterThan(0)
  })

  it('treats a missing language or group as its own bucket', () => {
    const aggregator = new TelemetryAggregator()
    aggregator.record(shown({ language: '' }))
    expect(aggregator.stats({ language: 'other' }).shown).toBe(1)
  })
})

describe('experiment groups', () => {
  it('keeps one session in the same group across calls', () => {
    const first = groupForSession('session-abc')
    for (let index = 0; index < 20; index++) expect(groupForSession('session-abc')).toBe(first)
    expect(COMPLETION_EXPERIMENT_GROUPS).toContain(first)
  })

  it('spreads distinct sessions across the groups', () => {
    const seen = new Set<string>()
    for (let index = 0; index < 200; index++) seen.add(groupForSession(`session-${index}`))
    expect(seen.size).toBe(COMPLETION_EXPERIMENT_GROUPS.length)
  })

  it('falls back to the first group when only one is configured', () => {
    expect(groupForSession('anything', ['only'])).toBe('only')
  })

  it('hands control the documented starting values and treatment a different set', () => {
    expect(paramsForGroup('control')).toBe(DEFAULT_COMPLETION_PARAMS)
    const treatment = paramsForGroup('treatment')
    expect(treatment.debounceFastMs).toBeLessThan(DEFAULT_COMPLETION_PARAMS.debounceFastMs)
    expect(treatment.snippetCount).toBeGreaterThan(DEFAULT_COMPLETION_PARAMS.snippetCount)
    // 未知分组退回起点值，不能悄悄给出一套没定义过的参数。
    expect(paramsForGroup('mystery')).toBe(DEFAULT_COMPLETION_PARAMS)
  })
})
