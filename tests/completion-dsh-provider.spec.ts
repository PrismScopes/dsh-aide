import { describe, expect, it } from 'vitest'
import { dshProvider, type DshLlmService, type DshStreamChunk } from '../src/completion/dshProvider.ts'
import { DEFAULT_COMPLETION_PARAMS } from '../src/completion/params.ts'

/**
 * 只回放给定 chunk 的假模型服务，同时记录它收到的调用参数。
 *
 * 补全走的是服务级 stream（对任何适配器都可用）；prepareCall 一并提供，只为满足类型。
 */
function fakeLlm(chunks: DshStreamChunk[], resolved?: Record<string, unknown>) {
  const calls: { config: Record<string, unknown>; options: Record<string, unknown> } = { config: {}, options: {} }
  const llm: DshLlmService = {
    stream(options) {
      calls.config = { ...options }
      calls.options = { ...options, ...resolved }
      return (async function* () { for (const chunk of chunks) yield chunk })()
    },
    async prepareCall(config) {
      return {
        config: { ...config, ...resolved },
        stream: llm.stream,
      }
    },
  }
  return { llm, calls }
}

const selection = { provider: 'test', model: 'test-model' }
const defaultModel = { currentSelection: () => selection }
const context = { signal: new AbortController().signal, language: 'typescript', params: DEFAULT_COMPLETION_PARAMS, prefix: 'const a = useSt', suffix: '' }

const collect = async (provider: ReturnType<typeof dshProvider>): Promise<string[]> => {
  const texts: string[] = []
  for await (const chunk of provider.complete('prompt', context)) if (!chunk.done) texts.push(chunk.text)
  return texts
}

describe('dsh model provider', () => {
  it('streams text deltas and stops at the finish chunk', async () => {
    const { llm } = fakeLlm([
      { type: 'block-start' },
      { type: 'text-delta', text: 'ate' },
      { type: 'text-delta', text: '(0)' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(await collect(dshProvider(llm, defaultModel))).toEqual(['ate', '(0)'])
  })

  it('passes the resolved call config back into the request', async () => {
    // DSH 在派发前会校验两者一致；prepareCall 补上的默认值必须原样出现在请求里。
    const { llm, calls } = fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }], { reasoningEffort: 'minimal' })
    await collect(dshProvider(llm, defaultModel))
    expect(calls.options['reasoningEffort']).toBe('minimal')
    expect(calls.options['provider']).toBe('test')
    expect(calls.options['stop']).toEqual(calls.config['stop'])
  })

  it('turns a failed finish into a thrown error instead of an empty result', async () => {
    const { llm } = fakeLlm([{ type: 'finish', reason: { kind: 'error', failure: { message: 'transport failed', code: 'TRANSPORT' } } }])
    // 信息里要能看出是哪条路由断的：否则诊断只能靠猜。
    await expect(collect(dshProvider(llm, defaultModel))).rejects.toThrow('completion upstream failed (test/test-model): transport failed')
  })

  it('returns quietly when the upstream reports an abort', async () => {
    const { llm } = fakeLlm([{ type: 'finish', reason: { kind: 'aborted' } }])
    expect(await collect(dshProvider(llm, defaultModel))).toEqual([])
  })

  it('sends a single user message carrying the prompt', async () => {
    const { llm, calls } = fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }])
    await collect(dshProvider(llm, defaultModel))
    expect(calls.options['messages']).toEqual([{ role: 'user', content: 'prompt' }])
  })
})
