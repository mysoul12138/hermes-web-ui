import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUpdateUsage = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({
  updateUsage: mockUpdateUsage,
}))

import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TuiBridgeService, resolveBridgeRoot } from '../../packages/server/src/services/hermes/tui-bridge'

class FakeGatewayClient extends EventEmitter {
  requests: Array<{ method: string, params: Record<string, any> }> = []
  supportsSessionSteer = false
  supportsSessionStatus = false
  sessionRunning = true
  private createdSessions = 0
  private persistentSessions: Array<{ id: string, source: string, started_at: number }> = []

  async request<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    this.requests.push({ method, params })
    if (method === 'session.steer') {
      if (this.supportsSessionSteer) return { status: 'queued', text: params.text } as T
      throw new Error('unknown method: session.steer')
    }
    if (method === 'session.status') {
      if (this.supportsSessionStatus) return { running: this.sessionRunning } as T
      throw new Error('unknown method: session.status')
    }
    if (method === 'command.dispatch') return { type: 'exec', output: 'Steer queued' } as T
    if (method === 'prompt.submit') return { ok: true } as T
    if (method === 'config.set') throw new Error('config.set should not be called during bridge runs')
    if (method === 'session.list') return { sessions: this.persistentSessions } as T
    if (method === 'session.create') {
      this.createdSessions += 1
      const session_id = `tui-session-${this.createdSessions}`
      this.persistentSessions.push({
        id: `persistent-session-${this.createdSessions}`,
        source: 'tui',
        started_at: Date.now() / 1000,
      })
      return { session_id } as T
    }
    return { status: 'ok' } as T
  }
}

describe('TuiBridgeService steer compatibility', () => {
  beforeEach(() => {
    mockUpdateUsage.mockClear()
    delete process.env.HERMES_TUI_ROOT
    delete process.env.HERMES_PYTHON_SRC_ROOT
    delete process.env.HERMES_AGENT_ROOT
    delete process.env.HERMES_HOME
  })

  it('prefers the live hermes-agent tree over the old publish snapshot by default', () => {
    const hermesHome = join(tmpdir(), `hermes-webui-bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(hermesHome, 'hermes-agent', 'tui_gateway'), { recursive: true })
    mkdirSync(join(hermesHome, 'hermes-publish.HkvvHk', 'tui_gateway'), { recursive: true })
    writeFileSync(join(hermesHome, 'hermes-agent', 'tui_gateway', 'entry.py'), '')
    writeFileSync(join(hermesHome, 'hermes-publish.HkvvHk', 'tui_gateway', 'entry.py'), '')
    process.env.HERMES_HOME = hermesHome
    try {
      expect(resolveBridgeRoot()).toBe(join(hermesHome, 'hermes-agent'))
    } finally {
      rmSync(hermesHome, { recursive: true, force: true })
    }
  })

  it('ignores stale publish HERMES_TUI_ROOT when the live hermes-agent tree exists', () => {
    const hermesHome = join(tmpdir(), `hermes-webui-bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const liveRoot = join(hermesHome, 'hermes-agent')
    const publishRoot = join(hermesHome, 'hermes-publish.HkvvHk')
    mkdirSync(join(liveRoot, 'tui_gateway'), { recursive: true })
    mkdirSync(join(publishRoot, 'tui_gateway'), { recursive: true })
    writeFileSync(join(liveRoot, 'tui_gateway', 'entry.py'), '')
    writeFileSync(join(publishRoot, 'tui_gateway', 'entry.py'), '')
    process.env.HERMES_HOME = hermesHome
    process.env.HERMES_TUI_ROOT = publishRoot
    try {
      expect(resolveBridgeRoot()).toBe(liveRoot)
    } finally {
      rmSync(hermesHome, { recursive: true, force: true })
    }
  })

  it('uses session.steer directly when the bridge supports it', async () => {
    const client = new FakeGatewayClient()
    client.supportsSessionSteer = true
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
      { method: 'session.status', params: { session_id: 'tui-session' } },
      { method: 'session.steer', params: { session_id: 'tui-session', text: 'adjust direction' } },
    ])
    ;(bridge as any).closeRun('bridge_run_1')
  })

  it('resolves persistent session ids back to the active web session before steering', async () => {
    const client = new FakeGatewayClient()
    client.supportsSessionSteer = true
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)

    ;(bridge as any).bridgeSessionsByWebSession.set('web-session', 'tui-session')
    ;(bridge as any).rememberPersistentSessionId('web-session', 'persistent-session')
    ;(bridge as any).activeRunsByBridgeSession.set('tui-session', 'bridge_run_1')
    ;(bridge as any).runs.set('bridge_run_1', {
      runId: 'bridge_run_1',
      webSessionId: 'web-session',
      bridgeSessionId: 'tui-session',
      events: [],
      waiters: [],
      closed: false,
    })

    const result = await bridge.steer('persistent-session', 'adjust direction')
    expect(result).toMatchObject({
      ok: true,
      status: 'queued',
      text: 'adjust direction',
    })
    expect(client.requests).toEqual([
      { method: 'session.status', params: { session_id: 'tui-session' } },
      { method: 'session.steer', params: { session_id: 'tui-session', text: 'adjust direction' } },
    ])
    ;(bridge as any).closeRun('bridge_run_1')
  })

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
      { method: 'session.status', params: { session_id: 'tui-session' } },
      { method: 'session.steer', params: { session_id: 'tui-session', text: 'adjust direction' } },
      { method: 'command.dispatch', params: { session_id: 'tui-session', command: '/steer adjust direction' } },
    ])
    ;(bridge as any).closeRun('bridge_run_1')
  })

  it('submits bridge runs without model validation side effects', async () => {
    const client = new FakeGatewayClient()
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)

    ;(bridge as any).bridgeSessionsByWebSession.set('web-session', 'tui-session')
    ;(bridge as any).persistentSessionsByWebSession.set('web-session', 'persistent-session')

    const result = await (bridge.startRun as any)('hello', 'web-session', [], {
      model: 'gpt-5.5',
      provider: 'openai-codex',
    })

    expect(result).toMatchObject({
      bridge: true,
      session_id: 'persistent-session',
    })
    expect(client.requests.map(request => request.method)).toEqual([
      'prompt.submit',
    ])
    expect(client.requests[0].params).toMatchObject({
      session_id: 'tui-session',
      text: 'hello',
    })
    ;(bridge as any).closeRun(result.run_id)
  })

  it('does not validate Alibaba models during bridge run creation', async () => {
    const client = new FakeGatewayClient()
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)

    ;(bridge as any).bridgeSessionsByWebSession.set('web-session', 'stale-tui-session')
    ;(bridge as any).persistentSessionsByWebSession.set('web-session', 'stale-persistent-session')

    const result = await (bridge.startRun as any)('hello', 'web-session', [], {
      model: 'qwen3.5-plus',
      provider: 'alibaba',
    })

    expect(client.requests.map(request => request.method)).toEqual([
      'prompt.submit',
    ])
    expect(client.requests[0].params).toMatchObject({
      session_id: 'stale-tui-session',
      text: 'hello',
    })
    expect(result).toMatchObject({
      bridge: true,
      session_id: 'stale-persistent-session',
      bridge_session_id: 'stale-tui-session',
    })
    ;(bridge as any).closeRun(result.run_id)
  })

  it('does not validate custom provider models during bridge run creation', async () => {
    const client = new FakeGatewayClient()
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)

    ;(bridge as any).bridgeSessionsByWebSession.set('web-session', 'tui-session')
    ;(bridge as any).persistentSessionsByWebSession.set('web-session', 'persistent-session')

    const result = await (bridge.startRun as any)('hello', 'web-session', [], {
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      provider: 'custom:llm.mathmodel.tech',
    })

    expect(client.requests.map(request => request.method)).toEqual([
      'prompt.submit',
    ])
    expect(client.requests[0].params).toMatchObject({
      session_id: 'tui-session',
      text: 'hello',
    })
    expect(result).toMatchObject({
      bridge: true,
      session_id: 'persistent-session',
      bridge_session_id: 'tui-session',
    })
    ;(bridge as any).closeRun(result.run_id)
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

  it('uses content/message fields as final output for bridge completion events', async () => {
    vi.useFakeTimers()
    const client = new FakeGatewayClient()
    client.supportsSessionStatus = true
    client.sessionRunning = false
    const bridge = new TuiBridgeService(client as any)

    ;(bridge as any).webSessionsByBridgeSession.set('tui-session', 'web-session')
    ;(bridge as any).activeRunsByBridgeSession.set('tui-session', 'bridge_run_complete')
    ;(bridge as any).runs.set('bridge_run_complete', {
      runId: 'bridge_run_complete',
      webSessionId: 'web-session',
      bridgeSessionId: 'tui-session',
      events: [],
      waiters: [],
      closed: false,
    })

    client.emit('event', {
      session_id: 'tui-session',
      type: 'message.complete',
      payload: {
        content: 'final answer from gateway',
      },
    })

    await vi.advanceTimersByTimeAsync(1600)

    const events = (bridge as any).runs.get('bridge_run_complete').events
    expect(events).toEqual([
      expect.objectContaining({
        event: 'run.completed',
        output: 'final answer from gateway',
      }),
    ])
    vi.useRealTimers()
  })

  it('keeps bridge runs steerable while gateway status is still running after message.complete', async () => {
    vi.useFakeTimers()
    const client = new FakeGatewayClient()
    client.supportsSessionSteer = true
    client.supportsSessionStatus = true
    client.sessionRunning = true
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)

    ;(bridge as any).bridgeSessionsByWebSession.set('web-session', 'tui-session')
    ;(bridge as any).activeRunsByBridgeSession.set('tui-session', 'bridge_run_running')
    ;(bridge as any).runs.set('bridge_run_running', {
      runId: 'bridge_run_running',
      webSessionId: 'web-session',
      bridgeSessionId: 'tui-session',
      events: [],
      waiters: [],
      closed: false,
      lastActivityAt: Date.now(),
    })

    client.emit('event', {
      session_id: 'tui-session',
      type: 'message.complete',
      payload: { content: 'partial assistant segment' },
    })

    await vi.advanceTimersByTimeAsync(1600)

    expect((bridge as any).runs.get('bridge_run_running').closed).toBe(false)
    expect((bridge as any).activeRunsByBridgeSession.get('tui-session')).toBe('bridge_run_running')

    const result = await bridge.steer('web-session', 'adjust direction')
    expect(result).toMatchObject({ ok: true, status: 'queued', run_id: 'bridge_run_running' })
    expect(client.requests).toContainEqual({
      method: 'session.steer',
      params: { session_id: 'tui-session', text: 'adjust direction' },
    })

    ;(bridge as any).closeRun('bridge_run_running')
    vi.useRealTimers()
  })

  it('completes bridge runs without extra delay when status RPC is unavailable', async () => {
    vi.useFakeTimers()
    const client = new FakeGatewayClient()
    client.supportsSessionSteer = true
    const bridge = new TuiBridgeService(client as any)

    ;(bridge as any).bridgeSessionsByWebSession.set('web-session', 'tui-session')
    ;(bridge as any).activeRunsByBridgeSession.set('tui-session', 'bridge_run_no_status')
    ;(bridge as any).runs.set('bridge_run_no_status', {
      runId: 'bridge_run_no_status',
      webSessionId: 'web-session',
      bridgeSessionId: 'tui-session',
      events: [],
      waiters: [],
      closed: false,
      lastActivityAt: Date.now(),
    })

    client.emit('event', {
      session_id: 'tui-session',
      type: 'message.complete',
      payload: { content: 'maybe final' },
    })

    await vi.advanceTimersByTimeAsync(1600)

    expect((bridge as any).runs.get('bridge_run_no_status').events).toEqual([
      expect.objectContaining({
        event: 'run.completed',
        output: 'maybe final',
      }),
    ])
    expect((bridge as any).runs.get('bridge_run_no_status').closed).toBe(true)
    expect((bridge as any).activeRunsByBridgeSession.has('tui-session')).toBe(false)
    vi.useRealTimers()
  })

  it('adds server-tokenizer usage when bridge completion has no provider usage', async () => {
    vi.useFakeTimers()
    const client = new FakeGatewayClient()
    client.supportsSessionStatus = true
    client.sessionRunning = false
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)

    ;(bridge as any).bridgeSessionsByWebSession.set('web-session', 'tui-session')
    ;(bridge as any).persistentSessionsByWebSession.set('web-session', 'persistent-session')

    const result = await bridge.startRun('current question', 'web-session', [
      { role: 'user', content: 'hello from earlier context' },
      { role: 'assistant', content: 'previous answer' },
    ])

    client.emit('event', {
      session_id: 'tui-session',
      type: 'message.complete',
      payload: {
        content: 'final answer from gateway',
      },
    })

    await vi.advanceTimersByTimeAsync(1600)

    const events = (bridge as any).runs.get(result.run_id).events
    const completed = events.find((event: any) => event.event === 'run.completed')
    expect(completed).toMatchObject({
      usage_source: 'server-tokenizer',
      usage: {
        source: 'server-tokenizer',
      },
    })
    expect(completed.usage.input_tokens).toBeGreaterThan(0)
    expect(completed.usage.output_tokens).toBeGreaterThan(0)
    expect(mockUpdateUsage).toHaveBeenCalledWith('web-session', expect.objectContaining({
      inputTokens: completed.usage.input_tokens,
      outputTokens: completed.usage.output_tokens,
    }))
    vi.useRealTimers()
  })

  it('emits compression feedback when a new bridge session receives context history', async () => {
    const client = new FakeGatewayClient()
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)

    const result = await bridge.startRun('current question', 'web-session-with-history', [
      { role: 'user', content: 'hello from earlier context' },
      { role: 'assistant', content: 'previous answer' },
    ])

    const events = (bridge as any).runs.get(result.run_id).events
    expect(events).toEqual([
      expect.objectContaining({ event: 'run.started' }),
      expect.objectContaining({
        event: 'compression.started',
        message_count: 2,
      }),
      expect.objectContaining({
        event: 'compression.completed',
        compressed: true,
        totalMessages: 2,
      }),
    ])
    expect(result).toMatchObject({
      bridge: true,
      context_handoff: true,
      context_message_count: 2,
    })
    expect(result.context_token_count).toBeGreaterThan(0)
    ;(bridge as any).closeRun(result.run_id)
  })

  it('preserves provider usage from bridge completion payloads', async () => {
    vi.useFakeTimers()
    const client = new FakeGatewayClient()
    client.supportsSessionStatus = true
    client.sessionRunning = false
    const bridge = new TuiBridgeService(client as any)

    ;(bridge as any).webSessionsByBridgeSession.set('tui-session', 'web-session')
    ;(bridge as any).activeRunsByBridgeSession.set('tui-session', 'bridge_run_usage')
    ;(bridge as any).runs.set('bridge_run_usage', {
      runId: 'bridge_run_usage',
      webSessionId: 'web-session',
      bridgeSessionId: 'tui-session',
      events: [],
      waiters: [],
      closed: false,
      contextInputTokens: 999,
    })

    client.emit('event', {
      session_id: 'tui-session',
      type: 'message.complete',
      payload: {
        content: 'final answer',
        usage: {
          input_tokens: 7,
          output_tokens: 3,
          total_tokens: 10,
        },
      },
    })

    await vi.advanceTimersByTimeAsync(1600)

    const events = (bridge as any).runs.get('bridge_run_usage').events
    expect(events).toEqual([
      expect.objectContaining({
        event: 'run.completed',
        usage_source: 'provider',
        usage: expect.objectContaining({
          input_tokens: 7,
          output_tokens: 3,
          total_tokens: 10,
          source: 'provider',
        }),
      }),
    ])
    expect(mockUpdateUsage).toHaveBeenCalledWith('web-session', expect.objectContaining({
      inputTokens: 7,
      outputTokens: 3,
    }))
    vi.useRealTimers()
  })
})
