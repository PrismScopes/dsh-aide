import { describe, expect, it } from 'vitest'
import { DEFAULT_SECURITY_RULES, compileRule, evaluateSecurity, rulesForRequest } from '../src/completion/security.ts'

const rules = DEFAULT_SECURITY_RULES
const ids = (text: string) => evaluateSecurity(text, rules)?.ruleId

describe('content security rules', () => {
  it('blocks a private key block even when it arrives across chunk boundaries', () => {
    // 逐块匹配会漏掉这种：前半段和后半段各自都匹配不上完整模式。
    expect(evaluateSecurity('-----BEGIN ', rules)).toBeUndefined()
    expect(ids('-----BEGIN RSA PRIVATE KEY-----')).toBe('private-key-block')
  })

  it('blocks fixed-format cloud and hosting tokens', () => {
    expect(ids('key = AKIAIOSFODNN7EXAMPLE')).toBe('aws-access-key')
    expect(ids('token: ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe('github-token')
  })

  it('masks a hard-coded credential instead of blocking it', () => {
    expect(evaluateSecurity('const apiKey = "abcdef123456"', rules)).toEqual({ action: 'mask', ruleId: 'generic-credential', ruleName: '硬编码凭据' })
  })

  it('leaves ordinary code alone', () => {
    for (const text of ['const total = a + b', 'function parseSecretName() { return 1 }', 'passwordless = true', '']) {
      expect(evaluateSecurity(text, rules)).toBeUndefined()
    }
  })

  it('prefers the stricter action when several rules match', () => {
    const maskRule = { id: 'mask-first', name: '凭据', action: 'mask' as const, pattern: 'secret' }
    const blockRule = { id: 'block-later', name: '私钥', action: 'block' as const, pattern: 'secret' }
    expect(evaluateSecurity('secret', [maskRule, blockRule])).toEqual({ action: 'block', ruleId: 'block-later', ruleName: '私钥' })
    expect(evaluateSecurity('secret', [maskRule])).toEqual({ action: 'mask', ruleId: 'mask-first', ruleName: '凭据' })
  })

  it('falls back to matching the rule name when a pattern is absent or invalid', () => {
    const byName = { id: 'n', name: 'SECRET', action: 'mask' as const }
    expect(evaluateSecurity('has SECRET inside', [byName])?.ruleId).toBe('n')
    expect(evaluateSecurity('clean', [byName])).toBeUndefined()
    // 坏模式不能把整轮补全拖垮：退化为按名称匹配。
    const broken = { id: 'b', name: 'SECRET', action: 'block' as const, pattern: '([' }
    expect(compileRule(broken)('has SECRET inside')).toBe(true)
    // 连名称都没有的规则直接视为不命中。
    expect(compileRule({ id: 'e', name: '', action: 'mask' })).toBeTypeOf('function')
    expect(compileRule({ id: 'e', name: '', action: 'mask' })('anything')).toBe(false)
  })

  it('uses the tenant rules when the request carries them, including an explicit empty set', () => {
    expect(rulesForRequest(undefined)).toBe(rules)
    const tenant = [{ id: 't', name: '内部主机', action: 'mask' as const, pattern: '\\.internal\\.' }]
    expect(rulesForRequest({ rules: tenant })).toBe(tenant)
    // 空数组是「显式关闭」，不能悄悄回退到默认集。
    expect(rulesForRequest({ rules: [] })).toEqual([])
    expect(evaluateSecurity('AKIAIOSFODNN7EXAMPLE', rulesForRequest({ rules: [] }))).toBeUndefined()
  })
})
