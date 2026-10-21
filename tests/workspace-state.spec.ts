import { describe, expect, it } from 'vitest'
import { WorkspaceRequestScope } from '../src/client/workspaceState.ts'

describe('workspace request scoping', () => {
  it('rejects responses issued for an earlier workspace', () => {
    const scope = new WorkspaceRequestScope()
    const first = scope.begin()
    expect(scope.isCurrent(first)).toBe(true)
    const second = scope.begin()
    expect(scope.isCurrent(first)).toBe(false)
    expect(scope.isCurrent(second)).toBe(true)
    scope.invalidate(second)
    expect(scope.isCurrent(second)).toBe(false)
  })
})
