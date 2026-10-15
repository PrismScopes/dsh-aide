import { describe, expect, it } from 'vitest'
import { fallbackProvider } from '../src/completion/fallback.ts'
import { localProvider, type CompletionProvider, type CompletionChunk } from '../src/completion/provider.ts'
import { DEFAULT_COMPLETION_PARAMS } from '../src/completion/params.ts'

const context = {
  signal: new AbortController().signal,
  sessionId: 'test-session',
  language: 'typescript',
  params: DEFAULT_COMPLETION_PARAMS,
  prefix: 'const a = useState(0)\nconst b = useSt',
  suffix: '',
}

const failing = (message = 'upstream down'): CompletionProvider => ({
  id: 'dsh',
  model: 'test-model',
  async *complete(): AsyncIterable<CompletionChunk> { throw new Error(message) },
})

const emitting = (chunks: CompletionChunk[]): CompletionProvider => ({
  id: 'dsh',
  model: 'test-model',
  async *complete(): AsyncIterable<CompletionChunk> { for (const chunk of chunks) yield chunk },
})

const collect = async (provider: CompletionProvider): Promise<string> => {
  const texts: string[] = []
  for await (const chunk of provider.complete('prompt', context)) if (!chunk.done) texts.push(chunk.text)
  return texts.join('')
}

describe('completion fallback', () => {
  it('falls back to the secondary when the primary throws, and reports why', async () => {
    const reported: string[] = []
    const provider = fallbackProvider(failing('transport failed'), localProvider(DEFAULT_COMPLETION_PARAMS), {
      onFallback: failure => reported.push(`${failure.provider}/${failure.model}: ${failure.error}`),
    })
    // 光标前是 useSt，文档里有 useState —— 本地兜底应当补出 ate。
    expect(await collect(provider)).toBe('ate')
    expect(reported).toEqual(['dsh/test-model: transport failed'])
  })

  it('does not fall back when the primary succeeds with nothing', async () => {
    // 模型认为这里没有可补的内容，是有效结果；回落会把「模型说没有」变成「本地硬塞一条」。
    const reported: string[] = []
    const provider = fallbackProvider(emitting([{ text: '', done: true }]), localProvider(DEFAULT_COMPLETION_PARAMS), {
      onFallback: () => reported.push('不该发生'),
    })
    expect(await collect(provider)).toBe('')
    expect(reported).toEqual([])
  })

  it('does not fall back after the primary already emitted text', async () => {
    // 半条候选之后接上另一家的文本只会得到一段拼接垃圾：这种情况把失败抛出去。
    const partial: CompletionProvider = {
      id: 'dsh',
      model: 'test-model',
      async *complete(): AsyncIterable<CompletionChunk> {
        yield { text: 'const', done: false }
        throw new Error('stream broke')
      },
    }
    const provider = fallbackProvider(partial, localProvider(DEFAULT_COMPLETION_PARAMS), { onFallback: () => undefined })
    await expect(collect(provider)).rejects.toThrow('stream broke')
  })

  it('keeps the primary model name for telemetry', () => {
    const provider = fallbackProvider(failing(), localProvider(DEFAULT_COMPLETION_PARAMS))
    expect(provider.model).toBe('test-model')
  })
})
