import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockUpdateUsage = vi.hoisted(() => vi.fn())
const mockIsSessionCompressionEnded = vi.hoisted(() => vi.fn())
const mockWriteBridgeContinuationLink = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({
  updateUsage: mockUpdateUsage,
}))

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  isSessionCompressionEnded: mockIsSessionCompressionEnded,
}))

vi.mock('../../packages/server/src/services/hermes/bridge-continuation-links', () => ({
  writeBridgeContinuationLink: mockWriteBridgeContinuationLink,
}))

import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TuiBridgeService, resolveBridgeRoot } from '../../packages/server/src/services/hermes/tui-bridge'
import { closeDb } from '../../packages/server/src/db'
import { getSessionLineage } from '../../packages/server/src/db/hermes/session-lineage'
import { getLivePendingApproval } from '../../packages/server/src/services/hermes/run-state'

class FakeGatewayClient extends EventEmitter {
  requests: Array<{ method: string, params: Record<string, any> }> = []
  supportsSessionSteer = false
  supportsSessionStatus = false
  sessionStatusOutput: string | null = null
  sessionRunning = true
  configSetError: Error | null = null
  busyPromptSessions = new Set<string>()
  private createdSessions = 0
  private persistentSessions: Array<{ id: string, source: string, started_at: number }> = []

  async request<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    this.requests.push({ method, params })
    if (method === 'session.steer') {
      if (this.supportsSessionSteer) return { status: 'queued', text: params.text } as T
      throw new Error('unknown method: session.steer')
    }
    if (method === 'session.status') {
      if (this.sessionStatusOutput != null) return { output: this.sessionStatusOutput } as T
      if (this.supportsSessionStatus) return { running: this.sessionRunning } as T
      throw new Error('unknown method: session.status')
    }
    if (method === 'command.dispatch') return { type: 'exec', output: 'Steer queued' } as T
    if (method === 'prompt.submit') {
      if (this.busyPromptSessions.has(String(params.session_id || ''))) {
        throw new Error('session busy')
      }
      return { ok: true } as T
    }
    if (method === 'config.set') {
      if (this.configSetError) throw this.configSetError
      return { key: params.key, value: String(params.value || ''), warning: '' } as T
    }
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
    mockIsSessionCompressionEnded.mockReset()
    mockWriteBridgeContinuationLink.mockClear()
    mockIsSessionCompressionEnded.mockResolvedValue(false)
    delete process.env.HERMES_TUI_ROOT
    delete process.env.HERMES_PYTHON_SRC_ROOT
    delete process.env.HERMES_AGENT_ROOT
    delete process.env.HERMES_HOME
    delete process.env.NODE_ENV
    process.env.VITEST = 'true'
    closeDb()
  })

  afterEach(() => {
    closeDb()
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

  it('ignores stale publish source-root env when the live hermes-agent tree exists', () => {
    const hermesHome = join(tmpdir(), `hermes-webui-bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const liveRoot = join(hermesHome, 'hermes-agent')
    const publishRoot = join(hermesHome, 'hermes-publish.HkvvHk')
    mkdirSync(join(liveRoot, 'tui_gateway'), { recursive: true })
    mkdirSync(join(publishRoot, 'tui_gateway'), { recursive: true })
    writeFileSync(join(liveRoot, 'tui_gateway', 'entry.py'), '')
    writeFileSync(join(publishRoot, 'tui_gateway', 'entry.py'), '')
    process.env.HERMES_HOME = hermesHome
    process.env.HERMES_TUI_ROOT = publishRoot
    process.env.HERMES_PYTHON_SRC_ROOT = publishRoot
    process.env.HERMES_AGENT_ROOT = publishRoot
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
      { method: 'session.steer', params: { session_id: 'tui-session', text: 'adjust direction' } },
      { method: 'command.dispatch', params: { session_id: 'tui-session', name: 'steer', arg: 'adjust direction' } },
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
      'config.set',
      'prompt.submit',
    ])
    expect(client.requests[0].params).toMatchObject({
      session_id: 'tui-session',
      key: 'model',
      value: 'gpt-5.5 --provider openai-codex',
    })
    expect(client.requests[1].params).toMatchObject({
      session_id: 'tui-session',
      text: 'hello',
    })
    ;(bridge as any).closeRun(result.run_id)
  })

  it('does not add model switch latency for a brand new bridge session', async () => {
    const client = new FakeGatewayClient()
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)

    const result = await (bridge.startRun as any)('hello', 'new-web-session', [], {
      model: 'gpt-5.5',
      provider: 'openai-codex',
    })

    expect(client.requests.map(request => request.method)).toEqual([
      'session.list',
      'session.create',
      'session.list',
      'prompt.submit',
    ])
    expect(client.requests.at(-1)?.params).toMatchObject({
      text: 'hello',
    })
    ;(bridge as any).closeRun(result.run_id)
  })

  it('does not resume compression-ended persistent sessions before submitting the latest user input', async () => {
    const client = new FakeGatewayClient()
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)
    mockIsSessionCompressionEnded.mockResolvedValue(true)

    const result = await bridge.startRun('latest real request', '20260514_184636_6eac27', [
      { role: 'user', content: 'historical request that must not become current' },
      { role: 'assistant', content: 'historical answer' },
    ])

    expect(client.requests.map(request => request.method)).toEqual([
      'session.list',
      'session.create',
      'session.list',
      'prompt.submit',
    ])
    expect(client.requests.some(request => request.method === 'session.resume')).toBe(false)
    expect(client.requests.at(-1)?.params.text).toBe(
      'Previous conversation context:\nuser: historical request that must not become current\n\nassistant: historical answer\n\nCurrent user message:\nlatest real request',
    )
    expect(result).toMatchObject({
      bridge: true,
      context_handoff: true,
    })
    ;(bridge as any).closeRun(result.run_id)
  })

  it('writes continuation lineage against the previous persistent session during bridge handoff', async () => {
    const client = new FakeGatewayClient()
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)

    ;(bridge as any).persistentSessionsByWebSession.set('root-web-session', 'persistent-session-root')

    const result = await bridge.startRun('follow-up request', 'root-web-session', [
      { role: 'user', content: 'older request' },
      { role: 'assistant', content: 'older answer' },
    ])

    const persistentLineage = getSessionLineage('persistent-session-1')
    expect(result).toMatchObject({
      bridge: true,
      context_handoff: true,
      session_id: 'persistent-session-1',
    })
    expect(persistentLineage).toMatchObject({
      session_id: 'persistent-session-1',
      relation_kind: 'continuation',
      parent_session_id: 'persistent-session-root',
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
      'config.set',
      'prompt.submit',
    ])
    expect(client.requests[0].params).toMatchObject({
      session_id: 'stale-tui-session',
      key: 'model',
      value: 'qwen3.5-plus --provider alibaba',
    })
    expect(client.requests[1].params).toMatchObject({
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
      'config.set',
      'prompt.submit',
    ])
    expect(client.requests[0].params).toMatchObject({
      session_id: 'tui-session',
      key: 'model',
      value: 'deepseek-ai/DeepSeek-V4-Pro --provider custom:llm.mathmodel.tech',
    })
    expect(client.requests[1].params).toMatchObject({
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

  it('continues a bridge run when custom provider model listing verification is unavailable', async () => {
    const client = new FakeGatewayClient()
    client.configSetError = new Error("Note: could not reach this custom endpoint's model listing at https://ai.warp2pans.online/v1/models. Hermes will still save gpt-5.4, but the endpoint should expose /models for verification.\n If this server expects /v1, try base URL: https://ai.warp2pans.online")
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)

    ;(bridge as any).bridgeSessionsByWebSession.set('web-session', 'tui-session')
    ;(bridge as any).persistentSessionsByWebSession.set('web-session', 'persistent-session')

    const result = await (bridge.startRun as any)('hello after model switch', 'web-session', [], {
      model: 'gpt-5.4',
      provider: 'custom:ai.warp2pans.online',
    })

    expect(client.requests.map(request => request.method)).toEqual([
      'config.set',
      'prompt.submit',
    ])
    expect(client.requests[1].params).toMatchObject({
      session_id: 'tui-session',
      text: 'hello after model switch',
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
        inline_diff: '--- a/coverage.txt\n+++ b/coverage.txt\n@@\n-old\n+all passed',
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
        inline_diff: '--- a/coverage.txt\n+++ b/coverage.txt\n@@\n-old\n+all passed',
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

  it('does not locally close a bridge run when interrupt was sent but session is still running', async () => {
    vi.useFakeTimers()
    const client = new FakeGatewayClient()
    client.supportsSessionStatus = true
    client.sessionRunning = true
    const bridge = new TuiBridgeService(client as any)

    ;(bridge as any).bridgeSessionsByWebSession.set('web-session', 'tui-session')
    ;(bridge as any).activeRunsByBridgeSession.set('tui-session', 'bridge_run_cancel_pending')
    ;(bridge as any).runs.set('bridge_run_cancel_pending', {
      runId: 'bridge_run_cancel_pending',
      webSessionId: 'web-session',
      bridgeSessionId: 'tui-session',
      events: [],
      waiters: [],
      closed: false,
      lastActivityAt: Date.now(),
    })

    const cancelPromise = bridge.cancelRun('bridge_run_cancel_pending')
    await vi.advanceTimersByTimeAsync(5200)
    const result = await cancelPromise

    expect(result).toMatchObject({
      ok: false,
      cancelled: false,
      status: 'interrupt_sent',
      bridge: true,
    })
    expect((bridge as any).runs.get('bridge_run_cancel_pending').closed).toBe(false)
    expect((bridge as any).activeRunsByBridgeSession.get('tui-session')).toBe('bridge_run_cancel_pending')
    vi.useRealTimers()
  })

  it('parses text session.status output when cancelling a bridge run', async () => {
    vi.useFakeTimers()
    const client = new FakeGatewayClient()
    client.sessionStatusOutput = [
      'Hermes TUI Status',
      '',
      'Session ID: tui-session',
      'Agent Running: No',
    ].join('\n')
    const bridge = new TuiBridgeService(client as any)

    ;(bridge as any).bridgeSessionsByWebSession.set('web-session', 'tui-session')
    ;(bridge as any).activeRunsByBridgeSession.set('tui-session', 'bridge_run_cancel_text_status')
    ;(bridge as any).runs.set('bridge_run_cancel_text_status', {
      runId: 'bridge_run_cancel_text_status',
      webSessionId: 'web-session',
      bridgeSessionId: 'tui-session',
      events: [],
      waiters: [],
      closed: false,
      lastActivityAt: Date.now(),
    })

    const result = await bridge.cancelRun('bridge_run_cancel_text_status')

    expect(result).toMatchObject({
      ok: true,
      cancelled: true,
      bridge: true,
    })
    expect((bridge as any).runs.get('bridge_run_cancel_text_status').closed).toBe(true)
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
    expect(completed.contextTokens).toBe(completed.usage.input_tokens)
    expect(completed.usage.context_tokens).toBe(completed.usage.input_tokens)
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
        contextTokens: result.context_token_count,
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

  it('fails a bridge run when the TUI session stops without a terminal event', async () => {
    vi.useFakeTimers()
    const client = new FakeGatewayClient()
    client.supportsSessionStatus = true
    client.sessionRunning = true
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)

    const result = await bridge.startRun('current question', 'web-session', [])
    client.sessionRunning = false
    await vi.advanceTimersByTimeAsync(16000)

    const events = (bridge as any).runs.get(result.run_id).events
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'run.failed',
        error: expect.stringContaining('Bridge session stopped before reporting completion'),
      }),
    ]))
    expect((bridge as any).runs.get(result.run_id).closed).toBe(true)
    vi.useRealTimers()
  })

  it('emits a session.resolved event when the persistent session id is discovered after startRun returns', async () => {
    vi.useFakeTimers()
    const client = new FakeGatewayClient()
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)
    vi.spyOn(bridge as any, 'waitForNewPersistentSessionId').mockResolvedValueOnce(undefined)

    const result = await bridge.startRun('current question', 'web-session-late-persistent', [])
    await vi.advanceTimersByTimeAsync(600)

    const events = (bridge as any).runs.get(result.run_id).events
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'session.resolved',
        web_session_id: 'web-session-late-persistent',
        session_id: 'persistent-session-1',
        persistent_session_id: 'persistent-session-1',
      }),
    ]))
    ;(bridge as any).closeRun(result.run_id)
    vi.useRealTimers()
  })

  it('keeps simultaneous bridge runs isolated across web and TUI sessions', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeGatewayClient()
      client.supportsSessionStatus = true
      client.sessionRunning = false
      const bridge = new TuiBridgeService(client as any)
      vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)

      const [first, second] = await Promise.all([
        bridge.startRun('first question', 'web-session-a', []),
        bridge.startRun('second question', 'web-session-b', []),
      ])

      expect(first.bridge_session_id).not.toBe(second.bridge_session_id)

      client.emit('event', {
        session_id: first.bridge_session_id,
        type: 'message.delta',
        payload: { content: 'alpha delta' },
      })
      client.emit('event', {
        session_id: second.bridge_session_id,
        type: 'message.delta',
        payload: { content: 'beta delta' },
      })
      client.emit('event', {
        session_id: first.bridge_session_id,
        type: 'approval.request',
        payload: {
          approval_id: 'approval-alpha',
          description: 'Approve alpha',
          command: 'printf alpha',
          pending_count: 1,
        },
      })
      client.emit('event', {
        session_id: second.bridge_session_id,
        type: 'approval.request',
        payload: {
          approval_id: 'approval-beta',
          description: 'Approve beta',
          command: 'printf beta',
          pending_count: 2,
        },
      })

      expect(getLivePendingApproval('web-session-a')).toMatchObject({
        approval_id: 'approval-alpha',
        command: 'printf alpha',
        pending_count: 1,
      })
      expect(getLivePendingApproval('web-session-b')).toMatchObject({
        approval_id: 'approval-beta',
        command: 'printf beta',
        pending_count: 2,
      })

      client.emit('event', {
        session_id: first.bridge_session_id,
        type: 'message.complete',
        payload: { content: 'alpha complete' },
      })
      client.emit('event', {
        session_id: second.bridge_session_id,
        type: 'message.complete',
        payload: { content: 'beta complete' },
      })

      await vi.advanceTimersByTimeAsync(1600)

      const firstEvents = (bridge as any).runs.get(first.run_id).events
      const secondEvents = (bridge as any).runs.get(second.run_id).events
      expect(firstEvents.filter((event: any) => event.event === 'message.delta').map((event: any) => event.delta)).toEqual(['alpha delta'])
      expect(secondEvents.filter((event: any) => event.event === 'message.delta').map((event: any) => event.delta)).toEqual(['beta delta'])
      expect(firstEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: 'approval', approval_id: 'approval-alpha', command: 'printf alpha' }),
        expect.objectContaining({ event: 'run.completed', output: 'alpha complete' }),
      ]))
      expect(secondEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: 'approval', approval_id: 'approval-beta', command: 'printf beta' }),
        expect.objectContaining({ event: 'run.completed', output: 'beta complete' }),
      ]))
      expect(firstEvents).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ approval_id: 'approval-beta' }),
        expect.objectContaining({ output: 'beta complete' }),
      ]))
      expect(secondEvents).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ approval_id: 'approval-alpha' }),
        expect.objectContaining({ output: 'alpha complete' }),
      ]))
      expect(getLivePendingApproval('web-session-a')).toBeNull()
      expect(getLivePendingApproval('web-session-b')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('recreates the TUI bridge session for a same-web-session start when the current one is busy', async () => {
    const client = new FakeGatewayClient()
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)

    const first = await bridge.startRun('first request', 'web-session-rebuild', [])
    client.busyPromptSessions.add(first.bridge_session_id)

    const second = await bridge.startRun('second request', 'web-session-rebuild', [])

    expect(second).toMatchObject({
      status: 'queued',
      bridge: true,
    })
    expect(second.bridge_session_id).not.toBe(first.bridge_session_id)
    expect(second.session_id).not.toBe(first.session_id)
    expect((bridge as any).bridgeSessionsByWebSession.get('web-session-rebuild')).toBe(second.bridge_session_id)
    expect((bridge as any).activeRunsByBridgeSession.has(first.bridge_session_id)).toBe(false)
    expect((bridge as any).activeRunsByBridgeSession.get(second.bridge_session_id)).toBe(second.run_id)
    expect(client.requests.filter(request => request.method === 'prompt.submit')).toEqual([
      {
        method: 'prompt.submit',
        params: { session_id: first.bridge_session_id, text: 'first request' },
      },
      {
        method: 'prompt.submit',
        params: { session_id: first.bridge_session_id, text: 'second request' },
      },
      {
        method: 'prompt.submit',
        params: { session_id: second.bridge_session_id, text: 'second request' },
      },
    ])

    ;(bridge as any).closeRun(first.run_id)
    ;(bridge as any).closeRun(second.run_id)
  })

  it('writes lineage and continuation links when a delayed persistent session id resolves under a lineage root', async () => {
    vi.useFakeTimers()
    closeDb()
    const runtimeDir = join(tmpdir(), `hermes-webui-late-link-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    process.env.HERMES_HOME = runtimeDir
    const client = new FakeGatewayClient()
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)
    vi.spyOn(bridge as any, 'waitForNewPersistentSessionId').mockResolvedValueOnce(undefined)

    const result = await bridge.startRun('current question', 'root-web-session', [], {
      lineageRootSessionId: 'root-web-session',
    })
    await vi.advanceTimersByTimeAsync(600)

    const persistent = getSessionLineage('persistent-session-1')
    expect(persistent).toMatchObject({
      logical_conversation_id: 'root-web-session',
      root_session_id: 'root-web-session',
      parent_session_id: 'root-web-session',
      relation_kind: 'continuation',
    })
    expect(mockWriteBridgeContinuationLink).toHaveBeenCalledWith('persistent-session-1', 'root-web-session')

    ;(bridge as any).closeRun(result.run_id)
    rmSync(runtimeDir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  it('keeps a stable logical lineage root across bridge context handoff continuations', async () => {
    closeDb()
    const runtimeDir = join(tmpdir(), `hermes-webui-lineage-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    process.env.HERMES_HOME = runtimeDir
    const client = new FakeGatewayClient()
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)

    const first = await bridge.startRun('first request', 'root-web-session', [])
    ;(bridge as any).closeRun(first.run_id)

    const second = await bridge.startRun('follow-up request', 'continued-web-session', [
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'first answer' },
    ], {
      lineageParentSessionId: 'root-web-session',
      lineageRootSessionId: 'root-web-session',
    })
    ;(bridge as any).closeRun(second.run_id)

    const rootWeb = getSessionLineage('root-web-session')
    const continuedWeb = getSessionLineage('continued-web-session')
    const firstPersistent = getSessionLineage('persistent-session-1')
    const secondPersistent = getSessionLineage('persistent-session-2')
    expect(rootWeb).toMatchObject({
      root_session_id: 'root-web-session',
    })
    expect(continuedWeb).toMatchObject({
      logical_conversation_id: 'root-web-session',
      root_session_id: 'root-web-session',
    })
    expect(firstPersistent).toMatchObject({
      logical_conversation_id: 'root-web-session',
      root_session_id: 'root-web-session',
      relation_kind: 'continuation',
    })
    expect(secondPersistent).toMatchObject({
      logical_conversation_id: 'root-web-session',
      root_session_id: 'root-web-session',
      relation_kind: 'continuation',
      parent_session_id: 'root-web-session',
    })
    expect(mockWriteBridgeContinuationLink).toHaveBeenCalledWith('persistent-session-2', 'root-web-session')
    rmSync(runtimeDir, { recursive: true, force: true })
  })

  it('writes explicit bridge continuation links when a new bridge session has a lineage parent but no context handoff', async () => {
    closeDb()
    const runtimeDir = join(tmpdir(), `hermes-webui-link-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    process.env.HERMES_HOME = runtimeDir
    const client = new FakeGatewayClient()
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)

    const result = await bridge.startRun('follow-up request', 'continued-web-session', [], {
      lineageParentSessionId: 'root-web-session',
      lineageRootSessionId: 'root-web-session',
    })
    ;(bridge as any).closeRun(result.run_id)

    expect(mockWriteBridgeContinuationLink).toHaveBeenCalledWith('persistent-session-1', 'root-web-session')
    rmSync(runtimeDir, { recursive: true, force: true })
  })

  it('filters synthetic compaction and continuation wrapper history before building bridge prompts', async () => {
    const client = new FakeGatewayClient()
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)

    const result = await bridge.startRun('latest real request', 'web-session-with-filtered-history', [
      { role: 'user', content: 'real earlier question' },
      { role: 'assistant', content: 'real earlier answer' },
      { role: 'user', content: '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below.' },
      { role: 'user', content: '[Your active task list was preserved across context compression]\n- [ ] t5. update skill\n- [>] t6. migrate state machine' },
      { role: 'assistant', content: 'Summary generation was unavailable. 51 message(s) were removed to free context space but could not be summarized.' },
      { role: 'user', content: 'Previous conversation context:\nassistant: older answer\n\nCurrent user message:\ncontinue here' },
    ])

    expect(client.requests.at(-1)).toMatchObject({
      method: 'prompt.submit',
      params: {
        text: 'Previous conversation context:\nuser: real earlier question\n\nassistant: real earlier answer\n\nCurrent user message:\nlatest real request',
      },
    })
    expect(result).toMatchObject({
      bridge: true,
      context_handoff: true,
      context_message_count: 6,
    })
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
          context_tokens: 7,
          source: 'provider',
        }),
        contextTokens: 7,
      }),
    ])
    expect(mockUpdateUsage).toHaveBeenCalledWith('web-session', expect.objectContaining({
      inputTokens: 7,
      outputTokens: 3,
    }))
    vi.useRealTimers()
  })
})
