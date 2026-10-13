/**
 * 内容安全规则与判定（文档 6.4）。
 *
 * 文档在两个位置设卡：请求前的客户端预过滤、响应中的服务端判定。本模块负责后者的规则与匹配；
 * 命中信息以独立事件返回（含规则标识、规则名称、动作类型），两种动作都要写入审计日志。
 *
 * 规则来源：请求里可以带租户规则（文档 4.3 的「租户安全规则」），带则用租户的，不带则用这里的默认集。
 * 一条规则由「标识 + 名称 + 动作 + 模式」构成。模式是正则源码，缺省时退化为按名称做字面匹配
 * —— 那条路径是为兼容早期只传名称的调用方保留的。
 *
 * 判定对象是「到目前为止累积的候选文本」，不是单个数据块：流式输出会把一条模式切成两半，
 * 逐块匹配必然漏掉跨块的那种。
 */

export interface SecurityRule {
  id: string
  name: string
  action: 'block' | 'mask'
  /** 正则源码；缺省时按 name 做字面匹配。 */
  pattern?: string
}

export interface SecurityHit {
  action: 'block' | 'mask'
  ruleId: string
  ruleName: string
}

/**
 * 默认规则集。
 *
 * 只收「几乎不可能是正常代码」的模式：私钥块、云厂商与代码托管的固定格式令牌、硬编码凭据字面量。
 * 刻意不收宽泛的「疑似密钥」启发式 —— 那类规则会把正常代码拦下来，而误拦的代价是补全直接消失。
 */
export const DEFAULT_SECURITY_RULES: readonly SecurityRule[] = [
  { id: 'private-key-block', name: '私钥块', action: 'block', pattern: '-----BEGIN [A-Z ]*PRIVATE KEY-----' },
  { id: 'aws-access-key', name: 'AWS 访问密钥', action: 'block', pattern: '\\bAKIA[0-9A-Z]{16}\\b' },
  { id: 'github-token', name: '代码托管令牌', action: 'block', pattern: '\\bgh[pousr]_[A-Za-z0-9]{36,}\\b' },
  { id: 'generic-credential', name: '硬编码凭据', action: 'mask', pattern: '(?:api[_-]?key|secret|token|password)\\s*[:=]\\s*[\'"][^\'"]{8,}[\'"]' },
]

/** 编译一条规则；模式非法时退化为字面匹配，不让一条坏规则拖垮整轮补全。 */
export function compileRule(rule: SecurityRule): (text: string) => boolean {
  if (rule.pattern === undefined || rule.pattern === '') {
    const name = rule.name
    if (name === '') return () => false
    return text => text.includes(name)
  }
  try {
    const expression = new RegExp(rule.pattern, 'i')
    return text => expression.test(text)
  } catch {
    return text => text.includes(rule.name)
  }
}

/**
 * 判定一段文本命中了哪条规则。
 *
 * 多条命中时取更严的动作（拦截优先于脱敏）：宁可少给一次补全，也不要把拦不住的东西标成脱敏。
 * 同动作下按规则集顺序取第一条，保证结果稳定可测。
 */
export function evaluateSecurity(text: string, rules: readonly SecurityRule[]): SecurityHit | undefined {
  if (text === '') return undefined
  let masked: SecurityHit | undefined
  for (const rule of rules) {
    if (!compileRule(rule)(text)) continue
    const hit: SecurityHit = { action: rule.action, ruleId: rule.id, ruleName: rule.name }
    if (rule.action === 'block') return hit
    masked ??= hit
  }
  return masked
}

/** 请求里带租户规则时用它，否则用默认集。空数组视为「显式关闭」，不回退到默认集。 */
export function rulesForRequest(rules: { rules: readonly SecurityRule[] } | undefined): readonly SecurityRule[] {
  return rules === undefined ? DEFAULT_SECURITY_RULES : rules.rules
}
