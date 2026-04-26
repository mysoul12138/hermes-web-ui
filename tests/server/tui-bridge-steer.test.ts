import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import { TuiBridgeService } from '../../packages/server/src/services/hermes/tui-bridge'

class FakeGatewayClient extends EventEmitter {
  requests: Array<{ method: string, params: Record<string, any> }> = []

  async request<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    this.requests.push({ method, params })
    if (method === 'session.steer') throw new Error('unknown method: session.steer')
    if (method === 'command.dispatch') return { type: 'exec', output: 'Steer queued' } as T
    return { status: 'ok' } as T
  }
}

describe('TuiBridgeService steer compatibility', () => {
  it('falls back to command.dispatch /steer when the bridge lacks session.steer', async () => {
    const client = new FakeGatewayClient()
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)

    ;(bridge as any).bridgeSessionsByWebSession.set('web-session', 'tui-session')
    ;(bridge as any).activeRunsByBridgeSession.set('tui-session', 'bridge_run_1')
    ;(bridge as any).runs.set('bridge_run_1', {
      runId: 'bridge_run_1',
      webSessionId: 'web-session',
      bridgeSessionId: 'tui-session',
      events: [],
      waiters: [],
      closed: false,
    })

    const result = await bridge.steer('web-session', 'adjust direction')
    expect(result).toMatchObject({
      ok: true,
      status: 'queued',
      text: 'adjust direction',
    })
    expect(client.requests).toEqual([
      { method: 'session.steer', params: { session_id: 'tui-session', text: 'adjust direction' } },
      { method: 'command.dispatch', params: { session_id: 'tui-session', command: '/steer adjust direction' } },
    ])
    ;(bridge as any).closeRun('bridge_run_1')
  })

  it('forwards tool arguments, progress, and result payloads to WebUI events', () => {
    const client = new FakeGatewayClient()
    const bridge = new TuiBridgeService(client as any)

    ;(bridge as any).webSessionsByBridgeSession.set('tui-session', 'web-session')
    ;(bridge as any).activeRunsByBridgeSession.set('tui-session', 'bridge_run_tool')
    ;(bridge as any).runs.set('bridge_run_tool', {
      runId: 'bridge_run_tool',
      webSessionId: 'web-session',
      bridgeSessionId: 'tui-session',
      events: [],
      waiters: [],
      closed: false,
    })

    client.emit('event', {
      session_id: 'tui-session',
      type: 'tool.start',
      payload: {
        name: 'terminal',
        preview: 'npm test',
        arguments: { command: 'npm test' },
      },
    })
    client.emit('event', {
      session_id: 'tui-session',
      type: 'tool.progress',
      payload: {
        name: 'terminal',
        stdout: 'running tests',
      },
    })
    client.emit('event', {
      session_id: 'tui-session',
      type: 'tool.complete',
      payload: {
        name: 'terminal',
        stdout: 'all passed',
        output_tail: [{ text: 'all passed' }],
        files_written: ['coverage.txt'],
        exit_code: 0,
        duration_s: 1.2,
      },
    })

    const events = (bridge as any).runs.get('bridge_run_tool').events
    expect(events).toEqual([
      expect.objectContaining({
        event: 'tool.started',
        tool: 'terminal',
        preview: 'npm test',
        arguments: { command: 'npm test' },
      }),
      expect.objectContaining({
        event: 'tool.progress',
        tool: 'terminal',
        stdout: 'running tests',
      }),
      expect.objectContaining({
        event: 'tool.completed',
        tool: 'terminal',
        stdout: 'all passed',
        output_tail: [{ text: 'all passed' }],
        files_written: ['coverage.txt'],
        exit_code: 0,
        duration: 1.2,
        duration_s: 1.2,
      }),
    ])
    ;(bridge as any).closeRun('bridge_run_tool')
  })
})
