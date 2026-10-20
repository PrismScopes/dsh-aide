/**
 * 采纳率埋点与聚合（文档七：以采纳率为主指标，配合首字节延迟与请求取消率）。
 *
 * 三个计数构成全部指标：
 * - `shown`：给出过候选的次数（采纳率的分母）
 * - `accepted`：被采纳的次数（分子）
 * - `cancelled`：因选择变化而取消的次数（取消率的分母与分子）
 *
 * 聚合按「语言 + 实验分组」分桶：不分桶的采纳率会掩盖分组差异，那正是分组要观测的东西。
 * 分桶数量有上限，超出后并入 `other` —— 埋点是旁路，不能让它自己变成内存泄漏。
 */

export interface CompletionTelemetryEvent {
  kind: 'shown' | 'accepted' | 'cancelled' | 'failed'
  sessionId: string
  language: string
  model?: string
  experiment?: string
  /** 首字节延迟，仅 `shown` 有意义。 */
  firstByteMs?: number
  candidateCount?: number
  /** 失败原因，仅 `failed` 有意义。 */
  error?: string
}

interface CompletionStats {
  shown: number
  accepted: number
  cancelled: number
  /** 上游失败次数：与「没有补全」不同，这一项不为零就说明链路有问题。 */
  failed: number
  /** 采纳率 = 采纳次数 / 给出次数；没有给出过时为 null（不是 0，避免把「无数据」当成「零采纳」）。 */
  acceptanceRate: number | null
  /** 取消率 = 取消次数 / 给出次数。 */
  cancelRate: number | null
  /** 首字节延迟均值（毫秒），没有样本时为 null。 */
  averageFirstByteMs: number | null
}

interface Bucket {
  shown: number
  accepted: number
  cancelled: number
  failed: number
  firstByteTotal: number
  firstByteSamples: number
}

const MAX_BUCKETS = 200
const OTHER_BUCKET = 'other'

const emptyBucket = (): Bucket => ({ shown: 0, accepted: 0, cancelled: 0, failed: 0, firstByteTotal: 0, firstByteSamples: 0 })

function statsOf(bucket: Bucket): CompletionStats {
  const ratio = (value: number): number | null => (bucket.shown === 0 ? null : value / bucket.shown)
  return {
    shown: bucket.shown,
    accepted: bucket.accepted,
    cancelled: bucket.cancelled,
    failed: bucket.failed,
    acceptanceRate: ratio(bucket.accepted),
    cancelRate: ratio(bucket.cancelled),
    averageFirstByteMs: bucket.firstByteSamples === 0 ? null : Math.round(bucket.firstByteTotal / bucket.firstByteSamples),
  }
}

/** 分桶聚合器。纯内存、无依赖，便于单测与替换。 */
export class TelemetryAggregator {
  private readonly buckets = new Map<string, Bucket>()
  /** 最近一次失败原因。诊断时要的就是它，而不是「失败过几次」。 */
  private lastFailure: string | undefined

  /** 记一次事件。未知的语言或分组归入 other，不丢弃 —— 事件丢掉了就再也补不回来。 */
  record(event: CompletionTelemetryEvent): void {
    const key = this.keyOf(event)
    let bucket = this.buckets.get(key)
    if (bucket === undefined) {
      if (this.buckets.size >= MAX_BUCKETS) bucket = this.buckets.get(OTHER_BUCKET)
      if (bucket === undefined) bucket = emptyBucket()
      this.buckets.set(key === OTHER_BUCKET || this.buckets.size < MAX_BUCKETS ? key : OTHER_BUCKET, bucket)
    }
    if (event.kind === 'shown') {
      bucket.shown += 1
      if (event.firstByteMs !== undefined && Number.isFinite(event.firstByteMs)) {
        bucket.firstByteTotal += event.firstByteMs
        bucket.firstByteSamples += 1
      }
    } else if (event.kind === 'accepted') bucket.accepted += 1
    else if (event.kind === 'failed') {
      bucket.failed += 1
      if (event.error !== undefined && event.error !== '') this.lastFailure = event.error
    } else bucket.cancelled += 1
  }

  /**
   * 取分桶统计。给 `language` / `experiment` 就只算匹配的那些桶。
   *
   * 汇总不是「把各桶的比率再平均」——那会让样本少的桶权重过大；这里把计数加总后再算比率。
   */
  stats(filter: { language?: string; experiment?: string } = {}): CompletionStats {
    const total = emptyBucket()
    for (const [key, bucket] of this.buckets) {
      const [language, experiment] = key.split('\u0000')
      if (filter.language !== undefined && filter.language !== language) continue
      if (filter.experiment !== undefined && filter.experiment !== experiment) continue
      total.shown += bucket.shown
      total.accepted += bucket.accepted
      total.cancelled += bucket.cancelled
      total.failed += bucket.failed
      total.firstByteTotal += bucket.firstByteTotal
      total.firstByteSamples += bucket.firstByteSamples
    }
    return statsOf(total)
  }

  /** 每个分组的统计，按分组名排序，便于直接展示对照。 */
  byExperiment(): Array<{ experiment: string; stats: CompletionStats }> {
    const groups = new Set<string>()
    for (const key of this.buckets.keys()) groups.add(key.split('\u0000')[1] ?? '')
    return [...groups]
      .sort()
      .map(experiment => ({ experiment, stats: this.stats({ experiment }) }))
  }

  /** 最近一次失败原因，没有失败时为 undefined。 */
  failure(): string | undefined {
    return this.lastFailure
  }

  reset(): void {
    this.buckets.clear()
    this.lastFailure = undefined
  }

  private keyOf(event: CompletionTelemetryEvent): string {
    const language = event.language === '' ? OTHER_BUCKET : event.language
    const experiment = event.experiment === undefined || event.experiment === '' ? OTHER_BUCKET : event.experiment
    return `${language}\u0000${experiment}`
  }
}
