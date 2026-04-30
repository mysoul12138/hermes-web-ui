import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import * as configHelpers from '../../packages/server/src/services/config-helpers'
import { TuiBridgeService } from '../../packages/server/src/services/hermes/tui-bridge'

class FakeGatewayClient extends EventEmitter {
  requests: Array<{ method: string, params: Record<string, any> }> = []

  async request<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    this.requests.push({ method, params })
    if (method === 'session.steer') throw new Error('unknown method: session.steer')
    if (method === 'command.dispatch') return { type: 'exec', output: 'Steer queued' } as T
    if (method === 'prompt.submit') return { ok: true } as T
    if (method === 'config.set') return { value: params.value } as T
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

  it('syncs the requested model globally and into the active bridge session before prompt submit', async () => {
    const client = new FakeGatewayClient()
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)

    ;(bridge as any).bridgeSessionsByWebSession.set('web-session', 'tui-session')
    ;(bridge as any).persistentSessionsByWebSession.set('web-session', 'persistent-session')

    const result = await bridge.startRun('hello', 'web-session', [], {
      model: 'gpt-5.5',
      provider: 'openai-codex',
    })

    expect(result).toMatchObject({
      bridge: true,
      session_id: 'persistent-session',
    })
    expect(client.requests.map(request => request.method)).toEqual([
      'config.set',
      'config.set',
      'prompt.submit',
    ])
    expect(client.requests[0].params).toMatchObject({
      key: 'model',
      value: 'gpt-5.5 --provider openai-codex',
    })
    expect(client.requests[1].params).toMatchObject({
      key: 'model',
      session_id: 'tui-session',
      value: 'gpt-5.5 --provider openai-codex',
    })
    expect(client.requests[2].params).toMatchObject({
      session_id: 'tui-session',
      text: 'hello',
    })
    ;(bridge as any).closeRun(result.run_id)
  })

  it('passes custom providers to Hermes as provider keys for model switching', async () => {
    const client = new FakeGatewayClient()
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)
    const readSpy = vi.spyOn(configHelpers, 'readConfigYaml').mockResolvedValue({})
    const writeSpy = vi.spyOn(configHelpers, 'writeConfigYaml').mockResolvedValue()
    const listSpy = vi.spyOn(configHelpers, 'listUserProviders').mockReturnValue([
      {
        providerKey: 'custom:ai.warp2pans.online',
        slug: 'ai.warp2pans.online',
        label: 'Ai.warp2pans.online',
        base_url: 'https://ai.warp2pans.online/v1',
        model: 'gpt-5.4',
        api_key: 'secret',
        models: ['gpt-5.4'],
      },
    ] as any)
    const fetchSpy = vi.spyOn(configHelpers, 'fetchProviderModels').mockResolvedValue(['openai/gpt-5.4'])

    ;(bridge as any).bridgeSessionsByWebSession.set('web-session', 'tui-session')
    ;(bridge as any).persistentSessionsByWebSession.set('web-session', 'persistent-session')

    const result = await bridge.startRun('hello', 'web-session', [], {
      model: 'gpt-5.4',
      provider: 'custom:ai.warp2pans.online',
    })

    expect(client.requests.map(request => request.method)).toEqual([
      'config.set',
      'prompt.submit',
    ])
    expect(client.requests[0].params).toMatchObject({
      key: 'model',
      session_id: 'tui-session',
      value: 'openai/gpt-5.4 --provider ai.warp2pans.online',
    })
    expect(readSpy).toHaveBeenCalled()
    expect(writeSpy).toHaveBeenCalled()
    expect(listSpy).toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalledWith('https://ai.warp2pans.online/v1', 'secret')
    readSpy.mockRestore()
    writeSpy.mockRestore()
    listSpy.mockRestore()
    fetchSpy.mockRestore()
    ;(bridge as any).closeRun(result.run_id)
  })

  it('continues when Hermes saves a custom model but warns that /models is unreachable', async () => {
    const client = new FakeGatewayClient()
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)
    const readSpy = vi.spyOn(configHelpers, 'readConfigYaml').mockResolvedValue({})
    const writeSpy = vi.spyOn(configHelpers, 'writeConfigYaml').mockResolvedValue()
    const listSpy = vi.spyOn(configHelpers, 'listUserProviders').mockReturnValue([
      {
        providerKey: 'custom:llm.mathmodel.tech',
        slug: 'llm.mathmodel.tech',
        label: 'llm.mathmodel.tech',
        base_url: 'https://llm.mathmodel.tech/v1',
        model: 'deepseek-ai/DeepSeek-V4-Pro',
        api_key: 'secret',
        models: ['deepseek-ai/DeepSeek-V4-Pro'],
      },
    ] as any)
    const fetchSpy = vi.spyOn(configHelpers, 'fetchProviderModels').mockRejectedValue(new Error('probe failed'))
    const requestSpy = vi.spyOn(client, 'request')
    requestSpy.mockImplementation(async function (this: FakeGatewayClient, method: string, params: Record<string, any> = {}) {
      this.requests.push({ method, params })
      if (method === 'config.set') {
        throw new Error("Note: could not reach this custom endpoint's model listing at `https://llm.mathmodel.tech/v1/models`. Hermes will still save `deepseek-ai/DeepSeek-V4-Pro`, but the endpoint should expose `/models` for verification.")
      }
      if (method === 'prompt.submit') return { ok: true }
      return { status: 'ok' }
    })

    ;(bridge as any).bridgeSessionsByWebSession.set('web-session', 'tui-session')
    ;(bridge as any).persistentSessionsByWebSession.set('web-session', 'persistent-session')

    const result = await bridge.startRun('hello', 'web-session', [], {
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      provider: 'custom:llm.mathmodel.tech',
    })

    expect(result).toMatchObject({ bridge: true, session_id: 'persistent-session' })
    expect(client.requests.map(request => request.method)).toEqual([
      'config.set',
      'prompt.submit',
    ])
    readSpy.mockRestore()
    writeSpy.mockRestore()
    listSpy.mockRestore()
    fetchSpy.mockRestore()
    requestSpy.mockRestore()
    ;(bridge as any).closeRun(result.run_id)
  })

  it('continues when Hermes warns that a hidden custom model is absent from /models', async () => {
    const client = new FakeGatewayClient()
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)
    const readSpy = vi.spyOn(configHelpers, 'readConfigYaml').mockResolvedValue({})
    const writeSpy = vi.spyOn(configHelpers, 'writeConfigYaml').mockResolvedValue()
    const listSpy = vi.spyOn(configHelpers, 'listUserProviders').mockReturnValue([
      {
        providerKey: 'custom:llm.mathmodel.tech',
        slug: 'llm.mathmodel.tech',
        label: 'llm.mathmodel.tech',
        base_url: 'https://llm.mathmodel.tech/v1',
        model: 'deepseek-ai/DeepSeek-V4-Pro',
        api_key: 'secret',
        models: ['deepseek-ai/DeepSeek-V4-Pro'],
      },
    ] as any)
    const fetchSpy = vi.spyOn(configHelpers, 'fetchProviderModels').mockResolvedValue(['deepseek/deepseek-v4-pro'])
    const requestSpy = vi.spyOn(client, 'request')
    requestSpy.mockImplementation(async function (this: FakeGatewayClient, method: string, params: Record<string, any> = {}) {
      this.requests.push({ method, params })
      if (method === 'config.set') {
        throw new Error("Note: `deepseek-ai/DeepSeek-V4-Pro` was not found in this custom endpoint's model listing (https://openrouter.ai/api/v1/models). It may still work if the server supports hidden or aliased models.")
      }
      if (method === 'prompt.submit') return { ok: true }
      return { status: 'ok' }
    })

    ;(bridge as any).bridgeSessionsByWebSession.set('web-session', 'tui-session')
    ;(bridge as any).persistentSessionsByWebSession.set('web-session', 'persistent-session')

    const result = await bridge.startRun('hello', 'web-session', [], {
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      provider: 'custom:llm.mathmodel.tech',
    })

    expect(result).toMatchObject({ bridge: true, session_id: 'persistent-session' })
    expect(client.requests.map(request => request.method)).toEqual([
      'config.set',
      'prompt.submit',
    ])
    readSpy.mockRestore()
    writeSpy.mockRestore()
    listSpy.mockRestore()
    fetchSpy.mockRestore()
    requestSpy.mockRestore()
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
})
