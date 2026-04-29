// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mockChatApi = vi.hoisted(() => ({
  startRun: vi.fn(),
  cancelRun: vi.fn(),
  steerSession: vi.fn(),
  streamRunEvents: vi.fn(),
}))

const mockSessionsApi = vi.hoisted(() => ({
  fetchSessions: vi.fn(),
  fetchSession: vi.fn(),
  fetchSessionUsageSingle: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
}))

const mockConversationsApi = vi.hoisted(() => ({
  fetchConversationSummaries: vi.fn(),
  fetchConversationDetail: vi.fn(),
}))

const mockApprovalApi = vi.hoisted(() => ({
  getPendingApproval: vi.fn(),
  respondApproval: vi.fn(),
}))

const mockClarifyApi = vi.hoisted(() => ({
  getPendingClarify: vi.fn(),
  respondClarify: vi.fn(),
}))

vi.mock('@/api/hermes/chat', () => mockChatApi)
vi.mock('@/api/hermes/sessions', () => mockSessionsApi)
vi.mock('@/api/hermes/conversations', () => mockConversationsApi)
vi.mock('@/api/hermes/approval', () => mockApprovalApi)
vi.mock('@/api/hermes/clarify', () => mockClarifyApi)

import { useChatStore } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'
import { useAppStore } from '@/stores/hermes/app'

function makeSummary(id: string, title = 'Session') {
  return {
    id,
    source: 'api_server',
    model: 'gpt-4o',
    title,
    started_at: 1710000000,
    ended_at: 1710000001,
    message_count: 1,
    tool_call_count: 0,
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: 'openai',
    estimated_cost_usd: 0,
    actual_cost_usd: 0,
    cost_status: 'estimated',
  }
}

function makeDetail(id: string, messages: Array<Record<string, any>>) {
  return {
    ...makeSummary(id),
    messages,
  }
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

const PROFILE = 'default'
const ACTIVE_SESSION_KEY = `hermes_active_session_${PROFILE}`
const SESSIONS_CACHE_KEY = `hermes_sessions_cache_v1_${PROFILE}`
const LEGACY_ACTIVE_SESSION_KEY = 'hermes_active_session'
const LEGACY_SESSIONS_CACHE_KEY = 'hermes_sessions_cache_v1'
const bridgeLocalSessionKey = (sessionId: string) => `hermes_bridge_local_session_v1_${PROFILE}_${sessionId}`
const bridgePersistentSessionKey = (sessionId: string) => `hermes_bridge_persistent_session_v1_${PROFILE}_${sessionId}`
const branchSessionMetaKey = `hermes_branch_session_meta_v1_${PROFILE}`
const sessionModelOverrideKey = (sessionId: string) => `hermes_session_model_override_v1_${PROFILE}_${sessionId}`
const sessionMessagesKey = (sessionId: string) => `hermes_session_msgs_v1_${PROFILE}_${sessionId}_`
const inFlightKey = (sessionId: string) => `hermes_in_flight_v1_${PROFILE}_${sessionId}`
const legacySessionMessagesKey = (sessionId: string) => `hermes_session_msgs_v1_${sessionId}`

describe('Chat Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.useRealTimers()
    window.localStorage.clear()
    mockSessionsApi.fetchSessions.mockResolvedValue([])
    mockSessionsApi.fetchSession.mockResolvedValue(null)
    mockSessionsApi.fetchSessionUsageSingle.mockResolvedValue(null)
    mockSessionsApi.deleteSession.mockResolvedValue(true)
    mockSessionsApi.renameSession.mockResolvedValue(true)
    mockConversationsApi.fetchConversationSummaries.mockRejectedValue(new Error('conversation summaries unavailable'))
    mockConversationsApi.fetchConversationDetail.mockRejectedValue(new Error('conversation detail unavailable'))
    mockApprovalApi.getPendingApproval.mockResolvedValue({ pending: null, pending_count: 0 })
    mockApprovalApi.respondApproval.mockResolvedValue({ ok: true, choice: 'once' })
    mockClarifyApi.getPendingClarify.mockResolvedValue({ pending: null, pending_count: 0 })
    mockClarifyApi.respondClarify.mockResolvedValue({ ok: true, answer: 'ok' })
    mockChatApi.startRun.mockResolvedValue({ run_id: 'run-1', status: 'queued' })
    mockChatApi.cancelRun.mockResolvedValue(undefined)
    mockChatApi.steerSession.mockResolvedValue({ ok: true, status: 'queued', bridge: true, run_id: 'run-1' })
    mockChatApi.streamRunEvents.mockImplementation(() => ({
      abort: vi.fn(),
    }))
  })

  it('hydrates cached active session immediately and preserves local-only sessions after refresh', async () => {
    const cachedSession = {
      id: 'local-1',
      title: 'Local Draft',
      source: 'api_server',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    }
    const cachedMessages = [
      { id: 'm1', role: 'user', content: 'draft', timestamp: 1 },
    ]

    window.localStorage.setItem(ACTIVE_SESSION_KEY, 'local-1')
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([cachedSession]))
    window.localStorage.setItem(sessionMessagesKey('local-1'), JSON.stringify(cachedMessages))
    // Mark local-1 as in-flight so loadSessions preserves it
    window.localStorage.setItem(inFlightKey('local-1'), JSON.stringify({ runId: 'run-1', startedAt: Date.now() }))

    mockSessionsApi.fetchSessions.mockResolvedValue([makeSummary('remote-1', 'Remote Session')])
    mockSessionsApi.fetchSession.mockResolvedValue(null)

    const store = useChatStore()
    const loadPromise = store.loadSessions()

    expect(store.activeSessionId).toBe('local-1')
    expect(store.messages.map(m => m.content)).toEqual(['draft'])

    await loadPromise

    expect(store.sessions.map(s => s.id)).toEqual(['local-1', 'remote-1'])
    expect(store.activeSession?.id).toBe('local-1')
    expect(store.messages.map(m => m.content)).toEqual(['draft'])
  })

  it('does not let a stale server refresh erase a newer local assistant reply', async () => {
    const cachedMessages = [
      { id: 'u1', role: 'user', content: 'expensive task', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'final answer that already streamed', timestamp: 2 },
    ]

    window.localStorage.setItem(ACTIVE_SESSION_KEY, 'sess-stale')
    window.localStorage.setItem(
      SESSIONS_CACHE_KEY,
      JSON.stringify([
        {
          id: 'sess-stale',
          title: 'Stale refresh',
          source: 'api_server',
          messages: [],
          createdAt: 1,
          updatedAt: 2,
        },
      ]),
    )
    window.localStorage.setItem(sessionMessagesKey('sess-stale'), JSON.stringify(cachedMessages))

    mockSessionsApi.fetchSessions.mockResolvedValue([makeSummary('sess-stale', 'Stale refresh')])
    mockSessionsApi.fetchSession.mockResolvedValue(makeDetail('sess-stale', [
      {
        id: 1,
        session_id: 'sess-stale',
        role: 'user',
        content: 'expensive task',
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 1710000000,
        token_count: null,
        finish_reason: null,
        reasoning: null,
      },
    ]))

    const store = useChatStore()
    await store.loadSessions()
    expect(store.messages.map(m => m.content)).toEqual(['expensive task', 'final answer that already streamed'])

    await store.refreshActiveSession()

    expect(store.messages.map(m => m.content)).toEqual(['expensive task', 'final answer that already streamed'])
    const persistedMessages = JSON.parse(window.localStorage.getItem(sessionMessagesKey('sess-stale')) || '[]')
    expect(persistedMessages.map((m: any) => m.content)).toEqual(['expensive task', 'final answer that already streamed'])
  })

  it('does not let stale resume polling erase a newer local assistant reply', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-22T19:00:00.000Z'))

    const cachedMessages = [
      { id: 'u0', role: 'user', content: 'previous task', timestamp: 1 },
      { id: 'a0', role: 'assistant', content: 'a much longer previous assistant answer', timestamp: 2 },
      { id: 'u1', role: 'user', content: 'long task', timestamp: 3 },
      { id: 'a1', role: 'assistant', content: 'local final answer', timestamp: 4 },
    ]

    window.localStorage.setItem(ACTIVE_SESSION_KEY, 'sess-poll-stale')
    window.localStorage.setItem(
      SESSIONS_CACHE_KEY,
      JSON.stringify([
        {
          id: 'sess-poll-stale',
          title: 'Polling stale refresh',
          source: 'api_server',
          messages: [],
          createdAt: 1,
          updatedAt: 2,
        },
      ]),
    )
    window.localStorage.setItem(sessionMessagesKey('sess-poll-stale'), JSON.stringify(cachedMessages))
    window.localStorage.setItem(inFlightKey('sess-poll-stale'), JSON.stringify({ runId: 'run-1', startedAt: Date.now() }))

    mockSessionsApi.fetchSessions.mockResolvedValue([makeSummary('sess-poll-stale', 'Polling stale refresh')])
    mockSessionsApi.fetchSession.mockResolvedValue(makeDetail('sess-poll-stale', [
      {
        id: 1,
        session_id: 'sess-poll-stale',
        role: 'user',
        content: 'previous task',
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 1710000000,
        token_count: null,
        finish_reason: null,
        reasoning: null,
      },
      {
        id: 2,
        session_id: 'sess-poll-stale',
        role: 'assistant',
        content: 'a much longer previous assistant answer',
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 1710000001,
        token_count: null,
        finish_reason: 'stop',
        reasoning: null,
      },
      {
        id: 3,
        session_id: 'sess-poll-stale',
        role: 'user',
        content: 'long task',
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 1710000002,
        token_count: null,
        finish_reason: null,
        reasoning: null,
      },
    ]))

    const store = useChatStore()
    await store.loadSessions()
    expect(store.messages.map(m => m.content)).toEqual([
      'previous task',
      'a much longer previous assistant answer',
      'long task',
      'local final answer',
    ])

    await vi.advanceTimersByTimeAsync(9000)
    await flushPromises()

    expect(store.messages.map(m => m.content)).toEqual([
      'previous task',
      'a much longer previous assistant answer',
      'long task',
      'local final answer',
    ])
    expect(store.isRunActive).toBe(false)
    expect(window.localStorage.getItem(inFlightKey('sess-poll-stale'))).toBeNull()
  })

  it('persists the user message immediately before any SSE delta arrives', async () => {
    const store = useChatStore()

    await flushPromises()
    await store.sendMessage('hello world')

    const sid = store.activeSessionId
    expect(sid).toBeTruthy()
    expect(window.localStorage.getItem(ACTIVE_SESSION_KEY)).toBe(sid)

    const cachedMessages = JSON.parse(
      window.localStorage.getItem(sessionMessagesKey(sid!)) || '[]',
    )
    expect(cachedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'hello world',
        }),
      ]),
    )
  })

  it('captures live tool payloads so tool cards can expand details', async () => {
    const store = useChatStore()

    await flushPromises()
    await store.sendMessage('run tests')
    await flushPromises()

    const onEvent = mockChatApi.streamRunEvents.mock.calls[0]?.[1] as ((event: Record<string, unknown>) => void)
    expect(typeof onEvent).toBe('function')

    onEvent({
      event: 'tool.started',
      tool: 'terminal',
      preview: 'npm run test',
      arguments: { command: 'npm run test' },
    })

    let toolMessage = store.messages.find(m => m.role === 'tool')
    expect(toolMessage).toMatchObject({
      toolName: 'terminal',
      toolPreview: 'npm run test',
      toolStatus: 'running',
      toolArgs: JSON.stringify({ command: 'npm run test' }),
    })

    onEvent({
      event: 'tool.progress',
      tool: 'terminal',
      stdout: 'running tests',
    })

    toolMessage = store.messages.find(m => m.role === 'tool')
    expect(toolMessage?.toolResult).toBe(JSON.stringify({ stdout: 'running tests' }))

    onEvent({
      event: 'tool.completed',
      tool: 'terminal',
      stdout: 'all passed',
      output_tail: [{ text: 'all passed' }],
      files_written: ['coverage.txt'],
      exit_code: 0,
    })

    toolMessage = store.messages.find(m => m.role === 'tool')
    expect(toolMessage).toMatchObject({
      toolStatus: 'done',
    })
    expect(toolMessage?.toolResult).toContain(JSON.stringify({ stdout: 'running tests' }))
    expect(toolMessage?.toolResult).toContain('"stdout":"all passed"')
    expect(toolMessage?.toolResult).toContain('"output_tail":[{"text":"all passed"}]')
    expect(toolMessage?.toolResult).toContain('"files_written":["coverage.txt"]')
    expect(toolMessage?.toolResult).toContain('"exit_code":0')

    onEvent({
      event: 'tool.started',
      tool: 'terminal',
      preview: "python3 - <<'PY' import subprocess status = subprocess.check_output(['git','s...",
      arguments: {
        command: "python3 - <<'PY'\nimport subprocess\nstatus = subprocess.check_output(['git','status','--short'])\nprint(status.decode())\nPY",
      },
    })

    let latestToolMessage = store.messages.filter(m => m.role === 'tool').at(-1)
    expect(latestToolMessage?.toolPreview).toBe(
      "python3 - <<'PY'\nimport subprocess\nstatus = subprocess.check_output(['git','status','--short'])\nprint(status.decode())\nPY",
    )
    expect(latestToolMessage?.toolArgs).toContain("git','status','--short")

    onEvent({
      event: 'tool.started',
      tool: 'terminal',
      preview: "python3 - <<'PY' import subprocess status = subprocess.check_output(['git','s...",
      context: "python3 - <<'PY' import subprocess status = subprocess.check_output(['git','s...",
    })

    latestToolMessage = store.messages.filter(m => m.role === 'tool').at(-1)
    expect(latestToolMessage?.toolPreview).toContain('python3')
    expect(latestToolMessage?.toolArgs).toBeUndefined()
  })

  it('backfills live tool details from session polling without replacing streamed text', async () => {
    vi.useFakeTimers()

    const store = useChatStore()
    await store.sendMessage('inspect working tree')
    await flushPromises()

    const sid = store.activeSessionId
    expect(sid).toBeTruthy()

    const onEvent = mockChatApi.streamRunEvents.mock.calls[0]?.[1] as ((event: Record<string, unknown>) => void)
    expect(typeof onEvent).toBe('function')

    onEvent({
      event: 'tool.started',
      tool: 'terminal',
      call_id: 'call_1',
      preview: "python3 - <<'PY' import subprocess status = subprocess.check_output(['git','s...",
    })
    onEvent({ event: 'message.delta', delta: 'local streamed answer' })

    mockSessionsApi.fetchSession.mockResolvedValue(makeDetail(sid!, [
      {
        id: 1,
        session_id: sid,
        role: 'user',
        content: 'inspect working tree',
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 1710000000,
        token_count: null,
        finish_reason: null,
        reasoning: null,
      },
      {
        id: 2,
        session_id: sid,
        role: 'assistant',
        content: '',
        tool_call_id: null,
        tool_calls: [
          {
            id: 'item_1',
            call_id: 'call_1',
            function: {
              name: 'terminal',
              arguments: JSON.stringify({
                command: "python3 - <<'PY'\nimport subprocess\nstatus = subprocess.check_output(['git','status','--short'])\nprint(status.decode())\nPY",
              }),
            },
          },
        ],
        tool_name: null,
        timestamp: 1710000001,
        token_count: null,
        finish_reason: 'tool_calls',
        reasoning: null,
      },
      {
        id: 3,
        session_id: sid,
        role: 'tool',
        content: JSON.stringify({ output: ' M packages/client/src/stores/hermes/chat.ts\n', exit_code: 0, error: null }),
        tool_call_id: 'call_1',
        tool_calls: null,
        tool_name: null,
        timestamp: 1710000002,
        token_count: null,
        finish_reason: null,
        reasoning: null,
      },
    ]))

    await vi.advanceTimersByTimeAsync(2100)
    await flushPromises()

    const toolMessage = store.messages.find(message => message.role === 'tool')
    expect(toolMessage).toMatchObject({
      toolName: 'terminal',
      toolCallId: 'call_1',
      toolStatus: 'done',
    })
    expect(toolMessage?.toolArgs).toContain("git','status','--short")
    expect(toolMessage?.toolResult).toContain('packages/client/src/stores/hermes/chat.ts')
    expect(store.messages.find(message => message.role === 'assistant')?.content).toBe('local streamed answer')
  })

  it('keeps Hermes DB token usage when the WebUI usage cache is empty', async () => {
    const detail = {
      ...makeDetail('session-with-usage', [
        {
          id: 1,
          session_id: 'session-with-usage',
          role: 'user',
          content: 'long prior context',
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          timestamp: 1710000000,
          token_count: null,
          finish_reason: null,
          reasoning: null,
        },
      ]),
      input_tokens: 12345,
      output_tokens: 678,
    }

    mockSessionsApi.fetchSessions.mockResolvedValue([detail])
    mockSessionsApi.fetchSession.mockResolvedValue(detail)
    mockSessionsApi.fetchSessionUsageSingle.mockResolvedValue({ input_tokens: 0, output_tokens: 0 })

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()

    expect(store.activeSession?.inputTokens).toBe(12345)
    expect(store.activeSession?.outputTokens).toBe(678)
  })

  it('does not replace cumulative session usage with single-run usage while streaming', async () => {
    let onEvent!: (event: any) => void
    mockChatApi.streamRunEvents.mockImplementation((_runId: string, cb: (event: any) => void) => {
      onEvent = cb
      return { abort: vi.fn() }
    })

    const initialDetail = {
      ...makeDetail('session-with-live-usage', []),
      input_tokens: 12345,
      output_tokens: 678,
    }
    const refreshedDetail = {
      ...initialDetail,
      input_tokens: 13000,
      output_tokens: 700,
    }

    mockSessionsApi.fetchSessions.mockResolvedValue([initialDetail])
    mockSessionsApi.fetchSession.mockResolvedValueOnce(initialDetail).mockResolvedValue(refreshedDetail)
    mockSessionsApi.fetchSessionUsageSingle.mockResolvedValue({ input_tokens: 0, output_tokens: 0 })

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()

    await store.sendMessage('continue')
    await flushPromises()

    onEvent({
      event: 'run.completed',
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    })

    expect(store.activeSession?.inputTokens).toBe(12345)
    expect(store.activeSession?.outputTokens).toBe(678)

    await flushPromises()

    expect(store.activeSession?.inputTokens).toBe(13000)
    expect(store.activeSession?.outputTokens).toBe(700)
  })

  it('sends the currently selected model instead of the model captured at session creation', async () => {
    const appStore = useAppStore()
    appStore.selectedModel = 'old-model'
    appStore.selectedProvider = 'old-provider'

    const store = useChatStore()
    store.newChat()
    expect(store.activeSession?.model).toBe('old-model')

    appStore.selectedModel = 'new-model'
    appStore.selectedProvider = 'new-provider'
    await store.sendMessage('use the latest model')

    expect(mockChatApi.startRun).toHaveBeenCalledWith(expect.objectContaining({
      model: 'new-model',
      provider: 'new-provider',
    }))
    expect(store.activeSession?.model).toBe('new-model')
    expect(store.activeSession?.provider).toBe('new-provider')
  })

  it('does not pair a custom model with a stale global provider that does not list it', async () => {
    const appStore = useAppStore()
    appStore.modelGroups = [
      {
        provider: 'openai-codex',
        label: 'OpenAI Codex',
        base_url: '',
        models: ['gpt-5.4'],
        api_key: '',
      },
      {
        provider: 'custom:llm.mathmodel.tech',
        label: 'llm.mathmodel.tech',
        base_url: 'https://llm.mathmodel.tech/v1',
        models: ['deepseek-ai/DeepSeek-V4-Pro'],
        api_key: 'set',
      },
    ]
    appStore.selectedModel = 'deepseek-ai/DeepSeek-V4-Pro'
    appStore.selectedProvider = 'openai-codex'

    const store = useChatStore()
    store.newChat()
    await store.sendMessage('use custom deepseek')

    expect(mockChatApi.startRun).toHaveBeenCalledWith(expect.objectContaining({
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      provider: 'custom:llm.mathmodel.tech',
    }))
    expect(store.activeSession?.provider).toBe('custom:llm.mathmodel.tech')
  })

  it('renders a completed bridge response when the final text is carried in content', async () => {
    let onEvent!: (event: any) => void
    mockChatApi.streamRunEvents.mockImplementation((_runId: string, cb: (event: any) => void) => {
      onEvent = cb
      return { abort: vi.fn() }
    })

    const store = useChatStore()
    await store.sendMessage('hello')
    await flushPromises()

    onEvent({
      event: 'run.completed',
      content: 'final answer from bridge',
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    })

    expect(store.messages.some(m => m.role === 'assistant' && m.content === 'final answer from bridge')).toBe(true)
  })

  it('keeps the locally selected model when stale session detail still reports the old model', async () => {
    window.localStorage.setItem(sessionModelOverrideKey('sess-model'), JSON.stringify({
      model: 'new-model',
      provider: 'new-provider',
      updatedAt: Date.now(),
    }))
    window.localStorage.setItem(ACTIVE_SESSION_KEY, 'sess-model')
    mockSessionsApi.fetchSessions.mockResolvedValue([
      { ...makeSummary('sess-model'), model: 'old-model', billing_provider: 'old-provider' },
    ])
    mockSessionsApi.fetchSession.mockResolvedValue({
      ...makeDetail('sess-model', []),
      model: 'old-model',
      billing_provider: 'old-provider',
    })

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()

    expect(store.activeSession?.model).toBe('new-model')
    expect(store.activeSession?.provider).toBe('new-provider')
  })

  it('persists streamed messages for a background session after switching away', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-22T19:00:00.000Z'))

    let onEvent!: (event: any) => void
    mockChatApi.streamRunEvents.mockImplementation((_runId: string, cb: (event: any) => void) => {
      onEvent = cb
      return { abort: vi.fn() }
    })

    mockSessionsApi.fetchSessions.mockResolvedValue([
      makeSummary('sess-1', 'First'),
      makeSummary('sess-2', 'Second'),
    ])
    mockSessionsApi.fetchSession.mockImplementation(async (id: string) => makeDetail(id, []))

    const store = useChatStore()
    await store.loadSessions()
    await store.switchSession('sess-1')
    await store.sendMessage('background run')
    await store.switchSession('sess-2')

    onEvent({ event: 'message.delta', delta: 'background answer' })
    await vi.advanceTimersByTimeAsync(900)

    const persisted = JSON.parse(window.localStorage.getItem(sessionMessagesKey('sess-1')) || '[]')
    expect(persisted.some((message: any) => message.content === 'background answer')).toBe(true)
  })

  it('queues busy input and sends it after the current run completes', async () => {
    const settings = useSettingsStore()
    settings.display.busy_input_mode = 'interrupt'
    const store = useChatStore()

    await flushPromises()
    await store.sendMessage('start task')
    await flushPromises()

    const sid = store.activeSessionId
    expect(sid).toBeTruthy()
    expect(store.isStreaming).toBe(true)

    await store.sendMessage('adjust direction')
    await flushPromises()

    expect(mockChatApi.startRun).toHaveBeenCalledTimes(1)
    expect(mockChatApi.steerSession).not.toHaveBeenCalled()
    expect(store.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'adjust direction',
          queued: true,
        }),
      ]),
    )

    const onDone = mockChatApi.streamRunEvents.mock.calls[0]?.[2]
    expect(typeof onDone).toBe('function')
    onDone()
    await flushPromises()

    expect(mockChatApi.startRun).toHaveBeenCalledTimes(2)
    expect(store.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'adjust direction',
          queued: false,
        }),
      ]),
    )
  })

  it('hydrates from default-profile legacy cache and migrates bulky storage to new keys only', async () => {
    const cachedSession = {
      id: 'legacy-1',
      title: 'Legacy Draft',
      source: 'api_server',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    }
    const cachedMessages = [
      { id: 'm1', role: 'user', content: 'legacy draft', timestamp: 1 },
    ]

    window.localStorage.setItem(LEGACY_ACTIVE_SESSION_KEY, 'legacy-1')
    window.localStorage.setItem(LEGACY_SESSIONS_CACHE_KEY, JSON.stringify([cachedSession]))
    window.localStorage.setItem(legacySessionMessagesKey('legacy-1'), JSON.stringify(cachedMessages))

    mockSessionsApi.fetchSessions.mockResolvedValue([makeSummary('legacy-1', 'Legacy Draft')])
    mockSessionsApi.fetchSession.mockResolvedValue(makeDetail('legacy-1', cachedMessages))

    const store = useChatStore()
    await store.loadSessions()

    expect(store.activeSessionId).toBe('legacy-1')
    expect(store.messages.map(m => m.content)).toEqual(['legacy draft'])

    expect(window.localStorage.getItem(ACTIVE_SESSION_KEY)).toBe('legacy-1')
    expect(window.localStorage.getItem(SESSIONS_CACHE_KEY)).toBeTruthy()
    expect(window.localStorage.getItem(sessionMessagesKey('legacy-1'))).toBeTruthy()

    expect(window.localStorage.getItem(LEGACY_ACTIVE_SESSION_KEY)).toBeNull()
    expect(window.localStorage.getItem(LEGACY_SESSIONS_CACHE_KEY)).toBeNull()
    expect(window.localStorage.getItem(legacySessionMessagesKey('legacy-1'))).toBeNull()
  })

  it('persists explicit bridge-to-tui mapping when fetchSession returns the real Hermes session id', async () => {
    const localBridgeSessionId = 'moga25sfztsjc0'
    const persistentSessionId = '20260425_203959_a51166'

    window.localStorage.setItem(ACTIVE_SESSION_KEY, localBridgeSessionId)
    window.localStorage.setItem(
      SESSIONS_CACHE_KEY,
      JSON.stringify([
        {
          id: localBridgeSessionId,
          title: '',
          source: 'tui',
          messages: [],
          createdAt: new Date('2026-04-25T20:39:50+08:00').getTime(),
          updatedAt: new Date('2026-04-25T20:40:10+08:00').getTime(),
        },
      ]),
    )
    window.localStorage.setItem(
      sessionMessagesKey(localBridgeSessionId),
      JSON.stringify([
        { id: 'u1', role: 'user', content: 'fix test', timestamp: 1 },
        { id: 't1', role: 'tool', content: '', timestamp: 2, toolName: 'terminal', toolPreview: 'echo "fix test"', toolResult: '{"summary":"fix test 20:40:03"}', toolStatus: 'done' },
      ]),
    )
    window.localStorage.setItem(`hermes_bridge_local_session_v1_default_${localBridgeSessionId}`, '1')

    mockSessionsApi.fetchSession.mockImplementation(async (id: string) => {
      if (id === localBridgeSessionId) {
        return {
          ...makeDetail(persistentSessionId, [
            {
              id: 11,
              session_id: persistentSessionId,
              role: 'user',
              content: 'fix test',
              tool_call_id: null,
              tool_calls: null,
              tool_name: null,
              timestamp: 1,
              token_count: null,
              finish_reason: null,
              reasoning: null,
            },
            {
              id: 12,
              session_id: persistentSessionId,
              role: 'assistant',
              content: '',
              tool_call_id: null,
              tool_calls: [{ id: 'call_1', function: { name: 'terminal', arguments: '{"command":"echo \\"fix test\\"","workdir":"/tmp"}' } }],
              tool_name: null,
              timestamp: 2,
              token_count: null,
              finish_reason: 'tool_calls',
              reasoning: null,
            },
            {
              id: 13,
              session_id: persistentSessionId,
              role: 'tool',
              content: '{"output":"fix test 20:40:03","exit_code":0,"error":null}',
              tool_call_id: 'call_1',
              tool_calls: null,
              tool_name: null,
              timestamp: 3,
              token_count: null,
              finish_reason: null,
              reasoning: null,
            },
          ]),
          source: 'tui',
          id: persistentSessionId,
          tool_call_count: 1,
        }
      }
      return null
    })

    const store = useChatStore()
    await store.loadSessions()
    await store.refreshActiveSession()

    const toolMessage = store.messages.find(message => message.role === 'tool')
    expect(toolMessage?.toolArgs).toContain('"command":"echo \\"fix test\\""')
    expect(toolMessage?.toolResult).toContain('"output":"fix test 20:40:03"')
    expect(window.localStorage.getItem(`hermes_bridge_persistent_session_v1_default_${localBridgeSessionId}`)).toBe(persistentSessionId)
  })

  it('keeps a bridged branch session attached to its root after refresh', async () => {
    const rootId = 'root-session'
    const localBranchId = 'local-branch'
    const persistentBranchId = 'tui-branch'
    const cachedRoot = {
      id: rootId,
      title: 'Root',
      source: 'tui',
      messages: [],
      createdAt: 1,
      updatedAt: 2,
      branchSessionCount: 1,
    }
    const cachedBranch = {
      id: localBranchId,
      title: 'Branch task',
      source: 'tui',
      messages: [],
      createdAt: 2,
      updatedAt: 3,
      parentSessionId: rootId,
      rootSessionId: rootId,
      isBranchSession: true,
    }

    window.localStorage.setItem(ACTIVE_SESSION_KEY, localBranchId)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([cachedBranch, cachedRoot]))
    window.localStorage.setItem(sessionMessagesKey(localBranchId), JSON.stringify([
      { id: 'u1', role: 'user', content: 'Branch task', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'Local branch answer', timestamp: 2 },
    ]))
    window.localStorage.setItem(bridgeLocalSessionKey(localBranchId), '1')
    window.localStorage.setItem(bridgePersistentSessionKey(localBranchId), persistentBranchId)

    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      { ...makeSummary(rootId, 'Root'), source: 'tui', branch_session_count: 1 },
      { ...makeSummary(persistentBranchId, 'Branch task'), source: 'webui-bridge', started_at: 1710000002, last_active: 1710000003 },
    ])
    mockConversationsApi.fetchConversationDetail.mockResolvedValue({
      session_id: rootId,
      messages: [],
      visible_count: 0,
      thread_session_count: 1,
      branch_session_count: 1,
      branches: [{
        session_id: persistentBranchId,
        parent_session_id: rootId,
        source: 'tui',
        model: 'gpt-4o',
        title: 'Branch task',
        started_at: 1710000002,
        ended_at: null,
        last_active: 1710000003,
        is_active: false,
        messages: [
          { id: 1, session_id: persistentBranchId, role: 'user', content: 'Branch task', timestamp: 1710000002 },
          { id: 2, session_id: persistentBranchId, role: 'assistant', content: 'Persisted branch answer', timestamp: 1710000003 },
        ],
        visible_count: 2,
        thread_session_count: 1,
        branches: [],
      }],
    })
    mockSessionsApi.fetchSession.mockResolvedValue({
      ...makeDetail(persistentBranchId, [
      { id: 1, session_id: persistentBranchId, role: 'user', content: 'Branch task', timestamp: 1710000002 },
      { id: 2, session_id: persistentBranchId, role: 'assistant', content: 'Persisted branch answer', timestamp: 1710000003 },
      ]),
      source: 'tui',
    })

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()

    expect(store.activeSessionId).toBe(persistentBranchId)
    const branchSession = store.sessions.find(session => session.id === persistentBranchId)
    expect(branchSession).toMatchObject({
      isBranchSession: true,
      rootSessionId: rootId,
      parentSessionId: rootId,
      source: 'tui',
    })
    expect(store.sessions.some(session => session.id === localBranchId)).toBe(false)
  })

  it('applies cached branch metadata before remote summaries resolve', async () => {
    const rootId = 'root-session'
    const branchId = 'tui-branch'
    let resolveSummaries: (value: any[]) => void = () => {}

    window.localStorage.setItem(ACTIVE_SESSION_KEY, rootId)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([
      {
        id: branchId,
        title: 'Branch task',
        source: 'tui',
        messages: [],
        createdAt: 2,
        updatedAt: 3,
      },
      {
        id: rootId,
        title: 'Root',
        source: 'tui',
        messages: [],
        createdAt: 1,
        updatedAt: 2,
      },
    ]))
    window.localStorage.setItem(branchSessionMetaKey, JSON.stringify({
      [branchId]: {
        parentSessionId: rootId,
        rootSessionId: rootId,
        branchSessionCount: 0,
      },
    }))
    mockConversationsApi.fetchConversationSummaries.mockReturnValue(new Promise(resolve => {
      resolveSummaries = resolve
    }))

    const store = useChatStore()
    const loading = store.loadSessions()

    expect(store.sessions.find(session => session.id === branchId)).toMatchObject({
      isBranchSession: true,
      rootSessionId: rootId,
      parentSessionId: rootId,
    })

    resolveSummaries([
      { ...makeSummary(rootId, 'Root'), source: 'tui', branch_session_count: 1 },
      { ...makeSummary(branchId, 'Branch task'), source: 'tui' },
    ])
    await loading
  })

  it('rehydrates cached tool cards with full historical arguments and results', async () => {
    window.localStorage.setItem(ACTIVE_SESSION_KEY, 'sess-tool-detail')
    window.localStorage.setItem(
      SESSIONS_CACHE_KEY,
      JSON.stringify([
        {
          id: 'sess-tool-detail',
          title: 'Tool detail',
          source: 'api_server',
          messages: [],
          createdAt: 1,
          updatedAt: 2,
        },
      ]),
    )
    window.localStorage.setItem(
      sessionMessagesKey('sess-tool-detail'),
      JSON.stringify([
        { id: 'u1', role: 'user', content: 'check status', timestamp: 1 },
        { id: 'old-tool', role: 'tool', content: '', timestamp: 2, toolName: 'tool', toolStatus: 'done' },
      ]),
    )

    mockSessionsApi.fetchSessions.mockResolvedValue([makeSummary('sess-tool-detail', 'Tool detail')])
    mockSessionsApi.fetchSession.mockResolvedValue(makeDetail('sess-tool-detail', [
      {
        id: 1,
        session_id: 'sess-tool-detail',
        role: 'user',
        content: 'check status',
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 1710000000,
        token_count: null,
        finish_reason: null,
        reasoning: null,
      },
      {
        id: 2,
        session_id: 'sess-tool-detail',
        role: 'assistant',
        content: '',
        tool_call_id: null,
        tool_calls: [
          {
            id: 'item_1',
            call_id: 'call_1',
            type: 'function',
            function: {
              name: 'terminal',
              arguments: JSON.stringify({
                command: "python3 - <<'PY'\nimport subprocess\nstatus = subprocess.check_output(['git','status','--short'])\nprint(status.decode())\nPY",
              }),
            },
          },
        ],
        tool_name: null,
        timestamp: 1710000001,
        token_count: null,
        finish_reason: 'tool_calls',
        reasoning: null,
      },
      {
        id: 3,
        session_id: 'sess-tool-detail',
        role: 'tool',
        content: JSON.stringify({ output: ' M packages/client/src/stores/hermes/chat.ts\n', exit_code: 0, error: null }),
        tool_call_id: 'call_1',
        tool_calls: null,
        tool_name: null,
        timestamp: 1710000002,
        token_count: null,
        finish_reason: null,
        reasoning: null,
      },
    ]))

    const store = useChatStore()
    await store.loadSessions()

    const toolMessage = store.messages.find(message => message.role === 'tool')
    expect(toolMessage).toMatchObject({
      toolName: 'terminal',
      toolCallId: 'call_1',
      toolStatus: 'done',
    })
    expect(toolMessage?.toolArgs).toContain("git','status','--short")
    expect(toolMessage?.toolResult).toContain('packages/client/src/stores/hermes/chat.ts')
    expect(toolMessage?.toolPreview).toContain('packages/client/src/stores/hermes/chat.ts')
  })

  it('does not mark server sessions live from last_active alone', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-22T19:00:00.000Z'))

    mockSessionsApi.fetchSessions.mockResolvedValue([
      {
        ...makeSummary('remote-live', 'Remote Live'),
        ended_at: null,
        last_active: Math.floor(Date.now() / 1000) - 60,
      },
      {
        ...makeSummary('remote-idle', 'Remote Idle'),
        ended_at: Math.floor(Date.now() / 1000) - 600,
        last_active: Math.floor(Date.now() / 1000) - 600,
      },
    ])

    const store = useChatStore()
    await store.loadSessions()

    expect(store.isSessionLive('remote-live')).toBe(false)
    expect(store.isSessionLive('remote-idle')).toBe(false)
  })

  it('silently refreshes from server on SSE error instead of appending a fake error bubble', async () => {
    vi.useFakeTimers()

    window.localStorage.setItem(ACTIVE_SESSION_KEY, 'sess-1')
    window.localStorage.setItem(
      SESSIONS_CACHE_KEY,
      JSON.stringify([
        {
          id: 'sess-1',
          title: 'Recovered Chat',
          source: 'api_server',
          messages: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    )
    window.localStorage.setItem(
      sessionMessagesKey('sess-1'),
      JSON.stringify([
        { id: 'old-user', role: 'user', content: 'old prompt', timestamp: 1 },
      ]),
    )

    mockSessionsApi.fetchSessions.mockResolvedValue([makeSummary('sess-1', 'Recovered Chat')])

    let fetchSessionCalls = 0
    mockSessionsApi.fetchSession.mockImplementation(async () => {
      fetchSessionCalls += 1
      if (fetchSessionCalls === 1) return null
      return makeDetail('sess-1', [
        {
          id: 1,
          session_id: 'sess-1',
          role: 'user',
          content: 'old prompt',
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          timestamp: 1710000000,
          token_count: null,
          finish_reason: null,
          reasoning: null,
        },
        {
          id: 2,
          session_id: 'sess-1',
          role: 'user',
          content: 'check this',
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          timestamp: 1710000001,
          token_count: null,
          finish_reason: null,
          reasoning: null,
        },
        {
          id: 3,
          session_id: 'sess-1',
          role: 'assistant',
          content: 'final answer',
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          timestamp: 1710000002,
          token_count: null,
          finish_reason: 'stop',
          reasoning: null,
        },
      ])
    })

    mockChatApi.streamRunEvents.mockImplementation((
      _runId: string,
      _onEvent: (event: unknown) => void,
      _onDone: () => void,
      onError: (err: Error) => void,
    ) => {
      setTimeout(() => {
        onError(new Error('SSE connection error'))
      }, 0)
      return { abort: vi.fn() }
    })

    const store = useChatStore()
    await flushPromises()
    await store.sendMessage('check this')
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()

    await vi.advanceTimersByTimeAsync(9000)
    await flushPromises()

    expect(store.messages.some(m => m.role === 'system' && m.content.includes('SSE connection error'))).toBe(false)
    expect(store.messages.some(m => m.role === 'assistant' && m.content === 'final answer')).toBe(true)
    expect(store.isRunActive).toBe(false)
    expect(window.localStorage.getItem(inFlightKey('sess-1'))).toBeNull()
  })

  it('updates an open subagent branch while the parent run is still streaming', async () => {
    let onEvent: ((event: Record<string, any>) => void) | null = null
    mockChatApi.streamRunEvents.mockImplementation((
      _runId: string,
      eventHandler: (event: Record<string, any>) => void,
    ) => {
      onEvent = eventHandler
      return { abort: vi.fn() }
    })

    const store = useChatStore()
    await store.sendMessage('review the branch')
    const rootId = store.activeSessionId!

    onEvent?.({
      event: 'subagent.start',
      subagent_id: 'subagent-1',
      parent_id: rootId,
      goal: 'Review branch',
      text: 'Starting review',
      depth: 1,
    })
    await store.switchBranchSession(rootId, 'subagent-1')

    expect(store.activeSessionId).toBe('subagent-1')
    expect(store.messages.some(m => m.content.includes('#### Progress'))).toBe(true)
    expect(store.messages.some(m => m.content.includes('Starting review'))).toBe(true)
    expect(store.isRunActive).toBe(true)

    onEvent?.({
      event: 'subagent.progress',
      subagent_id: 'subagent-1',
      parent_id: rootId,
      goal: 'Review branch',
      text: 'Inspecting files',
      depth: 1,
    })

    expect(store.messages.some(m => m.content.includes('Inspecting files'))).toBe(true)

    onEvent?.({
      event: 'subagent.complete',
      subagent_id: 'subagent-1',
      parent_id: rootId,
      goal: 'Review branch',
      summary: 'Review complete',
      output_tail: [{ role: 'assistant', content: 'No issues found' }],
      depth: 1,
    })

    expect(store.messages.some(m => m.content.includes('No issues found'))).toBe(true)
    expect(store.isSessionLive('subagent-1')).toBe(false)
  })

  it('merges a live subagent placeholder into its persisted tui branch', async () => {
    let onEvent: ((event: Record<string, any>) => void) | null = null
    mockChatApi.streamRunEvents.mockImplementation((
      _runId: string,
      eventHandler: (event: Record<string, any>) => void,
    ) => {
      onEvent = eventHandler
      return { abort: vi.fn() }
    })

    const store = useChatStore()
    await store.sendMessage('review the branch')
    const rootId = store.activeSessionId!

    mockConversationsApi.fetchConversationDetail.mockRejectedValueOnce(new Error('not ready'))

    onEvent?.({
      event: 'subagent.start',
      subagent_id: 'subagent-1',
      parent_id: rootId,
      goal: 'Review branch',
      text: 'Starting review',
      depth: 1,
    })
    await store.switchBranchSession(rootId, 'subagent-1')
    expect(store.activeSessionId).toBe('subagent-1')

    mockConversationsApi.fetchConversationDetail.mockResolvedValue({
      session_id: rootId,
      messages: [],
      visible_count: 0,
      thread_session_count: 1,
      branch_session_count: 1,
      branches: [{
        session_id: 'tui-branch-1',
        parent_session_id: rootId,
        source: 'tui',
        model: 'gpt-5.5',
        title: 'Review branch',
        started_at: Date.now() / 1000,
        ended_at: null,
        last_active: Date.now() / 1000,
        is_active: true,
        visible_count: 0,
        thread_session_count: 1,
        messages: [],
        branches: [],
      }],
    })
    mockSessionsApi.fetchSession.mockImplementation(async (id: string) => {
      if (id !== 'tui-branch-1') return null
      return makeDetail('tui-branch-1', [
        { id: 1, session_id: 'tui-branch-1', role: 'user', content: 'Review branch', timestamp: 1710000100 },
        { id: 2, session_id: 'tui-branch-1', role: 'assistant', content: 'Full hydrated markdown **rendered** answer', timestamp: 1710000101 },
      ])
    })

    onEvent?.({
      event: 'subagent.progress',
      subagent_id: 'subagent-1',
      parent_id: rootId,
      goal: 'Review branch',
      text: 'Inspecting files',
      depth: 1,
    })
    await flushPromises()

    expect(store.sessionBranches(rootId).map(branch => branch.session_id)).toEqual(['tui-branch-1'])
    expect(store.activeSessionId).toBe('tui-branch-1')
    expect(store.isSessionLive('tui-branch-1')).toBe(true)
    expect(store.messages.map(m => m.content)).toEqual([
      'Review branch',
      'Full hydrated markdown **rendered** answer',
    ])

    onEvent?.({ event: 'run.completed', output: '' })
    await flushPromises()

    expect(store.isSessionLive('tui-branch-1')).toBe(false)
    expect(store.messages.map(m => m.content)).toEqual([
      'Review branch',
      'Full hydrated markdown **rendered** answer',
    ])
  })

  it('does not merge a live subagent placeholder into a persisted branch from another parent', async () => {
    let onEvent: ((event: Record<string, any>) => void) | null = null
    mockChatApi.streamRunEvents.mockImplementation((
      _runId: string,
      eventHandler: (event: Record<string, any>) => void,
    ) => {
      onEvent = eventHandler
      return { abort: vi.fn() }
    })

    const store = useChatStore()
    await store.sendMessage('review the branch')
    const rootId = store.activeSessionId!

    mockConversationsApi.fetchConversationDetail.mockResolvedValue({
      session_id: rootId,
      messages: [],
      visible_count: 0,
      thread_session_count: 1,
      branch_session_count: 1,
      branches: [{
        session_id: 'unrelated-tui-branch',
        parent_session_id: 'other-root',
        source: 'tui',
        model: 'gpt-5.5',
        title: 'Review branch',
        started_at: Date.now() / 1000,
        ended_at: null,
        last_active: Date.now() / 1000,
        is_active: true,
        visible_count: 0,
        thread_session_count: 1,
        messages: [],
        branches: [],
      }],
    })

    onEvent?.({
      event: 'subagent.start',
      subagent_id: 'subagent-1',
      parent_id: rootId,
      goal: 'Review branch',
      text: 'Starting review',
      depth: 1,
    })
    await flushPromises()

    expect(store.sessionBranches(rootId).map(branch => branch.session_id).sort()).toEqual([
      'subagent-1',
      'unrelated-tui-branch',
    ])
    await store.switchBranchSession(rootId, 'subagent-1')
    expect(store.activeSessionId).toBe('subagent-1')
  })

  it('drops stale cached branch sessions when the refreshed root has no branches', async () => {
    const cachedSessions = [
      {
        id: 'root',
        title: 'Root',
        source: 'tui',
        messages: [],
        createdAt: 1,
        updatedAt: 1,
        branchSessionCount: 0,
      },
      {
        id: 'stale-child',
        title: 'Stale child',
        source: 'tui',
        messages: [],
        createdAt: 2,
        updatedAt: 2,
        isBranchSession: true,
        parentSessionId: 'root',
        rootSessionId: 'root',
      },
    ]
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify(cachedSessions))
    window.localStorage.setItem(branchSessionMetaKey, JSON.stringify({
      'stale-child': {
        parentSessionId: 'root',
        rootSessionId: 'root',
        branchSessionCount: 0,
      },
    }))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      { ...makeSummary('root', 'Root'), source: 'tui', branch_session_count: 0 },
    ])
    mockConversationsApi.fetchConversationDetail.mockResolvedValue({
      session_id: 'root',
      messages: [],
      visible_count: 0,
      thread_session_count: 1,
      branch_session_count: 0,
      branches: [],
    })

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()
    await store.refreshSessionBranches('root')

    expect(store.sessions.map(session => session.id)).toEqual(['root'])
    expect(JSON.parse(window.localStorage.getItem(branchSessionMetaKey) || '{}')).toEqual({})
    expect(store.sessionBranchCount('root')).toBe(0)
  })

  it('shows and responds to live clarify prompts', async () => {
    let onEvent: ((event: Record<string, any>) => void) | null = null
    mockChatApi.streamRunEvents.mockImplementation((
      _runId: string,
      eventHandler: (event: Record<string, any>) => void,
    ) => {
      onEvent = eventHandler
      return { abort: vi.fn() }
    })

    const store = useChatStore()
    await store.sendMessage('clean disk')
    const sid = store.activeSessionId!

    onEvent?.({
      event: 'clarify',
      request_id: 'clarify-1',
      question: 'Continue cleanup?',
      choices: ['stop', 'delete cache'],
      timestamp: 1710000100,
    })

    expect(store.activeClarify?.pending?.question).toBe('Continue cleanup?')
    expect(store.activeClarify?.pending?.choices).toEqual(['stop', 'delete cache'])

    await store.respondClarify('delete cache')

    expect(mockClarifyApi.respondClarify).toHaveBeenCalledWith({
      session_id: sid,
      request_id: 'clarify-1',
      answer: 'delete cache',
    })
    expect(store.activeClarify).toBeNull()
  })
})
