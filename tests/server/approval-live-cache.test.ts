import { beforeEach, describe, expect, it, vi } from 'vitest'

// Reset run-state module between tests so in-memory maps are clean
beforeEach(() => {
  vi.resetModules()
})

// Mock hermes-cli — should NOT be called when live cache has data
const getSessionMock = vi.fn()
vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({
  getSession: getSessionMock,
}))

// Mock hermes (sendInstruction) — not used in pending tests
vi.mock('../../packages/server/src/services/hermes/hermes', () => ({
  sendInstruction: vi.fn(),
}))

describe('approval service — live cache priority', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns live approval from SSE cache before session messages are flushed', async () => {
    // Set up run → session mapping + live approval in the shared run-state
    const { setRunSession, setLivePendingApprovalForRun } = await import('../../packages/server/src/services/hermes/run-state')
    setRunSession('run-live-1', 'session-live-1')
    setLivePendingApprovalForRun('run-live-1', {
      approval_id: 'appr-early',
      description: 'Run rm -rf /tmp/old',
      command: 'rm -rf /tmp/old',
      pending_count: 1,
    })

    // Import approval service AFTER run-state is populated
    const { getPendingApproval } = await import('../../packages/server/src/services/hermes/approval')

    const result = await getPendingApproval('session-live-1')

    // Live cache should be returned immediately, no hermes-cli call
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(result.pending).toEqual({
      approval_id: 'appr-early',
      description: 'Run rm -rf /tmp/old',
      command: 'rm -rf /tmp/old',
      pattern_key: undefined,
      pattern_keys: undefined,
    })
    expect(result.pending_count).toBe(1)
  })

  it('falls back to session messages when no live approval exists', async () => {
    // No live approval set for this session
    getSessionMock.mockResolvedValue({
      messages: [
        { role: 'user', content: 'delete temp files' },
        { role: 'tool', content: JSON.stringify({ status: 'approval_required', command: 'rm -rf /tmp/old', approval_id: 'appr-late' }), tool_status: 'completed' },
      ],
    })

    const { getPendingApproval } = await import('../../packages/server/src/services/hermes/approval')

    const result = await getPendingApproval('session-no-live')

    expect(getSessionMock).toHaveBeenCalledWith('session-no-live')
    expect(result.pending).toEqual({
      approval_id: 'appr-late',
      description: undefined,
      command: 'rm -rf /tmp/old',
      pattern_key: undefined,
      pattern_keys: undefined,
    })
    expect(result.pending_count).toBe(1)
  })

  it('returns null when live cache is cleared by run.completed', async () => {
    const { setRunSession, setLivePendingApprovalForRun, clearLivePendingApprovalForRun } = await import('../../packages/server/src/services/hermes/run-state')
    setRunSession('run-clear-1', 'session-clear-1')
    setLivePendingApprovalForRun('run-clear-1', {
      approval_id: 'appr-clear',
      command: 'ls /tmp',
      pending_count: 1,
    })

    // Simulate run.completed clearing the live approval
    clearLivePendingApprovalForRun('run-clear-1')

    // Session messages also have no pending approval (run finished normally)
    getSessionMock.mockResolvedValue({
      messages: [
        { role: 'user', content: 'list temp files' },
        { role: 'assistant', content: 'Here are the files:\nfile1.txt\nfile2.txt' },
      ],
    })

    const { getPendingApproval } = await import('../../packages/server/src/services/hermes/approval')

    const result = await getPendingApproval('session-clear-1')

    expect(result.pending).toBeNull()
    expect(result.pending_count).toBe(0)
  })
})