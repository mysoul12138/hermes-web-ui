import { describe, expect, it, vi } from 'vitest'
import { TuiBridgeService } from '../../packages/server/src/services/hermes/tui-bridge'

class FakeGatewayClient {
  on = vi.fn()
  request = vi.fn()
}

describe('TuiBridgeService runtime snapshot', () => {
  it('summarizes bridge mappings and active run state without mutating runs', () => {
    const bridge = new TuiBridgeService(new FakeGatewayClient() as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)
    const startedAt = Date.now() - 5000
    const runId = `bridge_run_${startedAt.toString(36)}_abc123`

    ;(bridge as any).bridgeSessionsByWebSession.set('web-a', 'tui-a')
    ;(bridge as any).persistentSessionsByWebSession.set('web-a', '20260523_120000_abcdef')
    ;(bridge as any).activeRunsByBridgeSession.set('tui-a', runId)
    ;(bridge as any).runs.set(runId, {
      runId,
      webSessionId: 'web-a',
      bridgeSessionId: 'tui-a',
      events: [
        { event: 'run.started', run_id: runId, timestamp: startedAt / 1000 },
        { event: 'approval', run_id: runId, timestamp: Date.now() / 1000 },
      ],
      waiters: [],
      closed: false,
      lastActivityAt: startedAt + 1000,
      pendingApproval: true,
      contextInputTokens: 42,
    })

    const snapshot = bridge.getRuntimeSnapshot()

    expect(snapshot.bridge).toMatchObject({
      enabled: true,
      activeRuns: 1,
      trackedRuns: 1,
      trackedWebSessions: 1,
      persistentSessions: 1,
    })
    expect(snapshot.sessions).toEqual([
      {
        webSessionId: 'web-a',
        bridgeSessionId: 'tui-a',
        persistentSessionId: '20260523_120000_abcdef',
        activeRunId: runId,
      },
    ])
    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.runs[0]).toMatchObject({
      runId,
      webSessionId: 'web-a',
      bridgeSessionId: 'tui-a',
      persistentSessionId: '20260523_120000_abcdef',
      status: 'awaiting_approval',
      eventCount: 2,
      lastEvent: 'approval',
      pendingApproval: true,
      pendingClarify: false,
      contextInputTokens: 42,
    })
    expect(snapshot.runs[0].ageMs).toBeGreaterThanOrEqual(0)
    expect(snapshot.runs[0].idleMs).toBeGreaterThanOrEqual(0)
    expect((bridge as any).runs.has(runId)).toBe(true)
  })
})
