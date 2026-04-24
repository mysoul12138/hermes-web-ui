import { beforeEach, describe, expect, it, vi } from 'vitest'

// Reset modules so run-state in-memory maps start clean each test
beforeEach(() => {
  vi.resetModules()
})

describe('run-state module', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stores and retrieves run → session mapping', async () => {
    const { setRunSession, getSessionForRun } = await import('../../packages/server/src/services/hermes/run-state')
    setRunSession('run-1', 'session-1')
    expect(getSessionForRun('run-1')).toBe('session-1')
    expect(getSessionForRun('unknown')).toBeUndefined()
  })

  it('stores and retrieves live approval by session after setting via run', async () => {
    const { setRunSession, setLivePendingApprovalForRun, getLivePendingApproval } = await import('../../packages/server/src/services/hermes/run-state')
    setRunSession('run-2', 'session-2')
    setLivePendingApprovalForRun('run-2', {
      approval_id: 'appr-2',
      command: 'rm -rf /tmp/demo',
      pending_count: 2,
    })

    expect(getLivePendingApproval('session-2')).toEqual({
      approval_id: 'appr-2',
      command: 'rm -rf /tmp/demo',
      pending_count: 2,
    })
  })

  it('clears live approval when run completes', async () => {
    const { setRunSession, setLivePendingApprovalForRun, clearLivePendingApprovalForRun, getLivePendingApproval } = await import('../../packages/server/src/services/hermes/run-state')
    setRunSession('run-3', 'session-3')
    setLivePendingApprovalForRun('run-3', { command: 'ls' })

    expect(getLivePendingApproval('session-3')).not.toBeNull()

    clearLivePendingApprovalForRun('run-3')

    expect(getLivePendingApproval('session-3')).toBeNull()
  })

  it('clears live approval by session directly', async () => {
    const { setRunSession, setLivePendingApprovalForRun, clearLivePendingApproval, getLivePendingApproval } = await import('../../packages/server/src/services/hermes/run-state')
    setRunSession('run-4', 'session-4')
    setLivePendingApprovalForRun('run-4', { command: 'cat /etc/passwd' })

    expect(getLivePendingApproval('session-4')).not.toBeNull()

    clearLivePendingApproval('session-4')

    expect(getLivePendingApproval('session-4')).toBeNull()
  })
})