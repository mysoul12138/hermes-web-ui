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
  fetchHermesSessions: vi.fn(),
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

const mockConfigApi = vi.hoisted(() => ({
  fetchConfig: vi.fn(),
  updateConfigSection: vi.fn(),
}))

const mockCompletionSound = vi.hoisted(() => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

vi.mock('@/api/hermes/chat', () => mockChatApi)
vi.mock('@/api/hermes/sessions', () => mockSessionsApi)
vi.mock('@/api/hermes/conversations', () => mockConversationsApi)
vi.mock('@/api/hermes/approval', () => mockApprovalApi)
vi.mock('@/api/hermes/clarify', () => mockClarifyApi)
vi.mock('@/api/hermes/config', () => mockConfigApi)
vi.mock('@/utils/completion-sound', () => mockCompletionSound)

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
    billing_base_url: null,
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
const steerHistoryKey = (sessionId: string) => `hermes_steer_history_v1_${PROFILE}_${sessionId}`
const legacySessionMessagesKey = (sessionId: string) => `hermes_session_msgs_v1_${sessionId}`

describe('Chat Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.useRealTimers()
    window.localStorage.clear()
    mockSessionsApi.fetchSessions.mockResolvedValue([])
    mockSessionsApi.fetchHermesSessions.mockResolvedValue([])
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
    mockConfigApi.fetchConfig.mockResolvedValue({ display: {} })
    mockConfigApi.updateConfigSection.mockResolvedValue(undefined)
    mockCompletionSound.primeCompletionSound.mockClear()
    mockCompletionSound.playCompletionSound.mockClear()
    mockChatApi.startRun.mockResolvedValue({ run_id: 'run-1', status: 'queued' })
    mockChatApi.cancelRun.mockResolvedValue({ ok: true, cancelled: true })
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

  it('does not treat a stale persisted in-flight record as active when the hydrated active session already ended', async () => {
    window.localStorage.setItem(ACTIVE_SESSION_KEY, 'sess-ended')
    window.localStorage.setItem(
      SESSIONS_CACHE_KEY,
      JSON.stringify([
        {
          id: 'sess-ended',
          title: 'Ended Session',
          source: 'api_server',
          messages: [],
          createdAt: 1,
          updatedAt: 2,
          endedAt: 1710000001000,
        },
      ]),
    )
    window.localStorage.setItem(inFlightKey('sess-ended'), JSON.stringify({ runId: 'run-stale', startedAt: Date.now() }))
    mockSessionsApi.fetchSessions.mockResolvedValue([])
    mockSessionsApi.fetchSession.mockResolvedValue(null)

    const store = useChatStore()
    const loadPromise = store.loadSessions()
    expect(store.activeSessionId).toBe('sess-ended')
    expect(store.activeSession?.endedAt).toBe(1710000001000)
    expect(store.isRunActive).toBe(false)

    await loadPromise
    expect(store.isRunActive).toBe(false)
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

  it('marks the run active while waiting for a slow startRun response', async () => {
    let resolveStartRun: (value: { run_id: string; status: string }) => void = () => {}
    mockChatApi.startRun.mockImplementationOnce(() => new Promise(resolve => {
      resolveStartRun = resolve
    }))

    const store = useChatStore()
    const sendPromise = store.sendMessage('slow cold start')
    await flushPromises()

    expect(store.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'slow cold start',
        }),
      ]),
    )
    expect(store.isRunActive).toBe(true)
    expect(mockChatApi.streamRunEvents).not.toHaveBeenCalled()

    resolveStartRun({ run_id: 'run-slow-start', status: 'queued' })
    await sendPromise
    await flushPromises()

    expect(mockChatApi.streamRunEvents).toHaveBeenCalledWith(
      'run-slow-start',
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    )
    expect(store.isRunActive).toBe(true)

    const onDone = mockChatApi.streamRunEvents.mock.calls[0]?.[2]
    expect(typeof onDone).toBe('function')
    onDone()
    await flushPromises()
    expect(store.isRunActive).toBe(false)
  })

  it('keeps live bridge messages visible after the persistent TUI session id resolves asynchronously', async () => {
    const webSessionId = 'mpe9nzbl762q5t'
    const persistentSessionId = '20260521_002116_0d8340'

    let capturedWebSessionId = ''
    mockChatApi.startRun.mockResolvedValueOnce({
      run_id: 'bridge-run-late-session-id',
      status: 'queued',
      bridge: true,
      session_id: undefined,
    })
    mockSessionsApi.fetchSession.mockImplementation(async (id: string) => {
      if (id === persistentSessionId) return makeDetail(persistentSessionId, [])
      return null
    })

    const store = useChatStore()
    store.newChat()
    capturedWebSessionId = store.activeSessionId!
    await store.sendMessage('hello from bridge')
    await flushPromises()
    expect(store.messages.map(message => message.content)).toEqual(['hello from bridge'])

    const onEvent = mockChatApi.streamRunEvents.mock.calls[0]?.[1] as ((event: Record<string, unknown>) => void)
    expect(typeof onEvent).toBe('function')

    onEvent({
      event: 'session.resolved',
      web_session_id: capturedWebSessionId,
      persistent_session_id: persistentSessionId,
      session_id: persistentSessionId,
    })
    expect(window.localStorage.getItem(bridgePersistentSessionKey(capturedWebSessionId))).toBe(persistentSessionId)
    onEvent({ event: 'message.delta', delta: 'streamed answer' })
    await flushPromises()
    expect(store.messages.map(message => message.content)).toEqual([
      'hello from bridge',
      'streamed answer',
    ])

    await store.switchSession(persistentSessionId)
    await flushPromises()

    expect(window.localStorage.getItem(bridgePersistentSessionKey(capturedWebSessionId))).toBe(persistentSessionId)
    expect(store.activeSessionId).toBe(persistentSessionId)
    expect(store.isRunActive).toBe(true)
    expect(store.messages.map(message => message.content)).toEqual([
      'hello from bridge',
      'streamed answer',
    ])
  })

  it('dedupes adjacent assistant messages after a temp bridge session resolves and the server snapshot catches up', async () => {
    const persistentSessionId = '20260523_012546_caf8ff'
    const answer = 'same streamed answer'

    mockChatApi.startRun.mockResolvedValueOnce({
      run_id: 'bridge-run-duplicate-assistant',
      status: 'queued',
      bridge: true,
      session_id: undefined,
    })
    mockSessionsApi.fetchSession.mockImplementation(async (id: string) => {
      if (id !== persistentSessionId) return null
      return makeDetail(persistentSessionId, [
        { id: 1, session_id: persistentSessionId, role: 'user', content: 'hello from bridge', timestamp: 1710000010 },
        { id: 2, session_id: persistentSessionId, role: 'assistant', content: answer, timestamp: 1710000011 },
        { id: 3, session_id: persistentSessionId, role: 'assistant', content: answer, timestamp: 1710000012 },
      ])
    })

    const store = useChatStore()
    store.newChat()
    const webSessionId = store.activeSessionId!
    await store.sendMessage('hello from bridge')
    await flushPromises()

    const onEvent = mockChatApi.streamRunEvents.mock.calls[0]?.[1] as ((event: Record<string, unknown>) => void)
    onEvent({
      event: 'session.resolved',
      web_session_id: webSessionId,
      persistent_session_id: persistentSessionId,
      session_id: persistentSessionId,
    })
    onEvent({ event: 'message.delta', delta: answer })
    await flushPromises()
    const onDone = mockChatApi.streamRunEvents.mock.calls[0]?.[2] as (() => void)
    onDone()
    await flushPromises()

    await store.switchSession(persistentSessionId)
    await flushPromises()

    expect(store.activeSessionId).toBe(persistentSessionId)
    expect(store.messages.filter(message => message.role === 'assistant' && message.content === answer)).toHaveLength(1)
    expect(store.messages.map(message => message.content)).toEqual(['hello from bridge', answer])
  })

  it('keeps an existing TUI conversation root when a persistent session resolves', async () => {
    const webSessionId = '20260520_093333_3c3fc9'
    const persistentSessionId = '20260521_092252_fb9174'

    mockChatApi.startRun.mockResolvedValueOnce({
      run_id: 'bridge-run-resolved-session',
      status: 'queued',
      bridge: true,
      session_id: undefined,
    })

    const store = useChatStore()
    store.sessions = [{
      id: webSessionId,
      title: 'Running bridge',
      source: 'tui',
      messages: [{ id: 'u1', role: 'user', content: 'same content', timestamp: 1 }],
      createdAt: 1,
      updatedAt: 1,
    }]
    store.activeSessionId = webSessionId
    store.activeSession = store.sessions[0]

    await store.sendMessage('same content')
    const onEvent = mockChatApi.streamRunEvents.mock.calls[0]?.[1] as ((event: Record<string, unknown>) => void)
    onEvent({
      event: 'session.resolved',
      web_session_id: webSessionId,
      persistent_session_id: persistentSessionId,
      session_id: persistentSessionId,
    })

    expect(store.activeSessionId).toBe(webSessionId)
    expect(store.sessions.map(session => session.id)).toEqual([webSessionId])
    expect(store.sessions[0].representedSessionIds).toEqual([webSessionId, persistentSessionId])
    expect(store.messages.map(message => message.content)).toContain('same content')

    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([{
      ...makeSummary(webSessionId, 'Resolved session'),
      source: 'tui',
      represented_session_ids: [webSessionId, persistentSessionId],
    }])
    mockSessionsApi.fetchHermesSessions.mockResolvedValue([
      { ...makeSummary(persistentSessionId, 'Resolved session'), source: 'tui' },
    ])

    await store.loadSessions()

    expect(store.sessions.map(session => session.id)).toEqual([webSessionId])
    expect(store.activeSessionId).toBe(webSessionId)
  })

  it('carries steer history from a temporary bridge session to the resolved persistent TUI session', async () => {
    const webSessionId = 'mpe-steer-temp'
    const persistentSessionId = '20260521_231218_46312e'

    mockChatApi.startRun.mockResolvedValueOnce({
      run_id: 'bridge-run-resolved-steer',
      status: 'queued',
      bridge: true,
      session_id: undefined,
    })

    const store = useChatStore()
    store.sessions = [{
      id: webSessionId,
      title: 'Running bridge',
      source: 'tui',
      messages: [{ id: 'u1', role: 'user', content: 'start task', timestamp: 1710000010000 }],
      createdAt: 1710000010000,
      updatedAt: 1710000010000,
    }]
    store.activeSessionId = webSessionId
    store.activeSession = store.sessions[0]

    await store.sendMessage('start task')
    await store.sendMessage('/steer 收到停止')
    await flushPromises()

    const onEvent = mockChatApi.streamRunEvents.mock.calls[0]?.[1] as ((event: Record<string, unknown>) => void)
    onEvent({
      event: 'session.resolved',
      web_session_id: webSessionId,
      persistent_session_id: persistentSessionId,
      session_id: persistentSessionId,
    })

    const persistentSteerHistory = JSON.parse(window.localStorage.getItem(steerHistoryKey(persistentSessionId)) || '[]')
    expect(persistentSteerHistory).toEqual([
      expect.objectContaining({ content: '收到停止' }),
    ])

    setActivePinia(createPinia())
    window.localStorage.setItem(ACTIVE_SESSION_KEY, persistentSessionId)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: persistentSessionId,
      title: 'Resolved steer',
      source: 'tui',
      messages: [],
      createdAt: 1710000010000,
      updatedAt: 1710000012000,
    }]))
    window.localStorage.removeItem(sessionMessagesKey(persistentSessionId))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([{
      ...makeSummary(persistentSessionId, 'Resolved steer'),
      source: 'tui',
    }])
    mockSessionsApi.fetchHermesSessions.mockResolvedValue([{
      ...makeSummary(persistentSessionId, 'Resolved steer'),
      source: 'tui',
    }])
    mockSessionsApi.fetchSession.mockResolvedValue({
      id: persistentSessionId,
      source: 'tui',
      title: 'Resolved steer',
      messages: [
        { id: 'u1', role: 'user', content: 'start task', timestamp: 1710000010 },
        { id: 'server-steer', role: 'user', content: '收到停止', timestamp: Date.now() / 1000 },
      ],
    } as any)

    const reloadedStore = useChatStore()
    await reloadedStore.loadSessions()
    await reloadedStore.switchSession(persistentSessionId)
    await flushPromises()

    expect(reloadedStore.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'server-steer',
          role: 'user',
          content: '收到停止',
          steered: true,
        }),
      ]),
    )
  })

  it('cancels a slow-start run when stop is clicked before the run id arrives', async () => {
    let resolveStartRun: (value: { run_id: string; status: string }) => void = () => {}
    mockChatApi.startRun.mockImplementationOnce(() => new Promise(resolve => {
      resolveStartRun = resolve
    }))

    const store = useChatStore()
    const sendPromise = store.sendMessage('stop before run id')
    await flushPromises()

    expect(store.isRunActive).toBe(true)
    await store.stopStreaming()
    expect(store.isRunActive).toBe(false)

    resolveStartRun({ run_id: 'run-stop-before-id', status: 'queued' })
    await sendPromise
    await flushPromises()

    expect(mockChatApi.cancelRun).toHaveBeenCalledWith('run-stop-before-id')
    expect(mockChatApi.streamRunEvents).not.toHaveBeenCalledWith(
      'run-stop-before-id',
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    )
    expect(store.isRunActive).toBe(false)
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
      inline_diff: '\u001b[90m┊ review diff\u001b[0m\n--- a/coverage.txt\n+++ b/coverage.txt\n@@\n-old\n+all passed',
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
    expect(toolMessage?.toolResult).not.toContain('inline_diff')
    expect(toolMessage?.toolInlineDiff).toBe('--- a/coverage.txt\n+++ b/coverage.txt\n@@\n-old\n+all passed')

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

  it('plays the completion bell when the display setting is enabled', async () => {
    const settings = useSettingsStore()
    settings.display.bell_on_complete = true
    settings.loaded = true
    const store = useChatStore()

    await store.sendMessage('notify when done')
    await flushPromises()

    expect(mockCompletionSound.primeCompletionSound).toHaveBeenCalledTimes(1)

    const onEvent = mockChatApi.streamRunEvents.mock.calls[0]?.[1] as ((event: Record<string, unknown>) => void)
    onEvent({ event: 'message.delta', delta: 'done' })
    onEvent({ event: 'run.completed' })

    expect(mockCompletionSound.playCompletionSound).toHaveBeenCalledTimes(1)
  })

  it('does not play the completion bell when the display setting is disabled', async () => {
    const settings = useSettingsStore()
    settings.display.bell_on_complete = false
    settings.loaded = true
    const store = useChatStore()

    await store.sendMessage('finish silently')
    await flushPromises()

    const onEvent = mockChatApi.streamRunEvents.mock.calls[0]?.[1] as ((event: Record<string, unknown>) => void)
    onEvent({ event: 'message.delta', delta: 'done' })
    onEvent({ event: 'run.completed' })

    expect(mockCompletionSound.playCompletionSound).not.toHaveBeenCalled()
  })

  it('tracks context compression progress from run events', async () => {
    const store = useChatStore()

    await flushPromises()
    await store.sendMessage('summarize the long context')
    await flushPromises()

    const onEvent = mockChatApi.streamRunEvents.mock.calls[0]?.[1] as ((event: Record<string, unknown>) => void)
    expect(typeof onEvent).toBe('function')

    onEvent({
      event: 'compression.started',
      message_count: 24,
      token_count: 120000,
    })

    expect(store.activeCompression).toMatchObject({
      status: 'started',
      messageCount: 24,
      tokenCount: 120000,
    })

    onEvent({
      event: 'compression.completed',
      compressed: true,
      totalMessages: 24,
      resultMessages: 8,
      beforeTokens: 120000,
      afterTokens: 18000,
      summaryTokens: 4200,
    })

    expect(store.activeCompression).toMatchObject({
      status: 'completed',
      totalMessages: 24,
      resultMessages: 8,
      beforeTokens: 120000,
      afterTokens: 18000,
      summaryTokens: 4200,
    })
  })

  it('shows bridge context handoff feedback from run creation', async () => {
    mockChatApi.startRun.mockResolvedValue({
      run_id: 'bridge_run_context',
      status: 'queued',
      bridge: true,
      session_id: '20260502_120953_713358',
      context_handoff: true,
      context_message_count: 8,
      context_token_count: 42000,
    })

    const store = useChatStore()
    await store.sendMessage('continue with context')

    expect(store.activeCompression).toMatchObject({
      mode: 'bridge_handoff',
      status: 'completed',
      messageCount: 8,
      tokenCount: 42000,
    })
  })

  it('cancels a bridge run on the first stop click', async () => {
    const store = useChatStore()
    await flushPromises()
    await store.sendMessage('cancel this run')
    await flushPromises()

    expect(store.activeSessionId).toBeTruthy()
    expect(store.isRunActive).toBe(true)

    await store.stopStreaming()

    expect(mockChatApi.cancelRun).toHaveBeenCalledWith('run-1')
    expect(store.isRunActive).toBe(false)
  })

  it('keeps the run active when bridge cancel only reports interrupt_sent', async () => {
    mockChatApi.cancelRun.mockResolvedValueOnce({
      ok: false,
      cancelled: false,
      bridge: true,
      status: 'interrupt_sent',
    })

    const store = useChatStore()
    await flushPromises()
    await store.sendMessage('cancel still running')
    await flushPromises()

    expect(store.isRunActive).toBe(true)
    await store.stopStreaming()

    expect(mockChatApi.cancelRun).toHaveBeenCalledWith('run-1')
    expect(store.isRunActive).toBe(true)
  })

  it('ignores repeated stop clicks while a cancel is already in progress', async () => {
    let resolveCancel: (() => void) | null = null
    mockChatApi.cancelRun.mockImplementationOnce(() => new Promise(resolve => {
      resolveCancel = resolve
    }))

    const store = useChatStore()
    await flushPromises()
    await store.sendMessage('cancel once')
    await flushPromises()

    const firstStop = store.stopStreaming()
    const secondStop = store.stopStreaming()
    await flushPromises()

    expect(store.isAborting).toBe(true)
    expect(mockChatApi.cancelRun).toHaveBeenCalledTimes(1)

    resolveCancel?.()
    await firstStop
    await secondStop
    await flushPromises()

    expect(store.isAborting).toBe(false)
  })

  it('does not show compression feedback for a newly mapped bridge session', async () => {
    mockChatApi.startRun.mockResolvedValue({
      run_id: 'bridge_run_new_session',
      status: 'queued',
      bridge: true,
      session_id: '20260502_120953_713358',
    })

    const store = useChatStore()
    await store.sendMessage('start a new chat')

    expect(store.activeCompression).toBeNull()
  })

  it('does not show compression feedback for a normal continued bridge turn without handoff', async () => {
    mockChatApi.startRun.mockResolvedValue({
      run_id: 'bridge_run_continue',
      status: 'queued',
      bridge: true,
      session_id: '20260503_111538_c59066',
    })

    const store = useChatStore()
    store.newChat()
    store.activeSession!.messages.push(
      { id: 'u1', role: 'user', content: 'original prompt', timestamp: Date.now() - 2000 },
      { id: 'a1', role: 'assistant', content: 'original answer', timestamp: Date.now() - 1000 },
    )

    await store.sendMessage('continue normally')

    expect(mockChatApi.startRun).toHaveBeenCalledWith(expect.objectContaining({
      conversation_history: expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'original prompt' }),
        expect.objectContaining({ role: 'assistant', content: 'original answer' }),
      ]),
    }))
    expect(store.activeCompression).toBeNull()
  })

  it('filters compaction and continuation wrapper text out of bridge conversation history', async () => {
    mockChatApi.startRun.mockResolvedValue({
      run_id: 'bridge_run_filtered_history',
      status: 'queued',
      bridge: true,
      session_id: '20260514_184636_6eac27',
    })

    const store = useChatStore()
    store.newChat()
    store.activeSession!.messages.push(
      { id: 'u1', role: 'user', content: 'real earlier question', timestamp: Date.now() - 5000 },
      { id: 'a1', role: 'assistant', content: 'real earlier answer', timestamp: Date.now() - 4000 },
      { id: 'u2', role: 'user', content: '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below.', timestamp: Date.now() - 3000 },
      { id: 'u2b', role: 'user', content: '[Your active task list was preserved across context compression]\n- [ ] t5. update skill\n- [>] t6. migrate state machine', timestamp: Date.now() - 2800 },
      { id: 'a2', role: 'assistant', content: 'Summary generation was unavailable. 51 message(s) were removed to free context space but could not be summarized.', timestamp: Date.now() - 2500 },
      { id: 'u3', role: 'user', content: 'Previous conversation context:\nassistant: older answer\n\nCurrent user message:\ncontinue here', timestamp: Date.now() - 2000 },
    )

    await store.sendMessage('latest real request')

    expect(mockChatApi.startRun).toHaveBeenCalledWith(expect.objectContaining({
      input: 'latest real request',
      conversation_history: [
        expect.objectContaining({ role: 'user', content: 'real earlier question' }),
        expect.objectContaining({ role: 'assistant', content: 'real earlier answer' }),
      ],
    }))
  })

  it('does not fetch a persistent continuation root through a bridge backing session', async () => {
    const continuationId = '20260502_135857_2f594e'
    const backingId = '20260502_120953_713358'
    mockChatApi.startRun.mockResolvedValue({
      run_id: 'bridge_run_continuation',
      status: 'queued',
      bridge: true,
      session_id: backingId,
    })
    mockConversationsApi.fetchConversationDetail.mockResolvedValue({
      session_id: continuationId,
      messages: [],
      visible_count: 0,
      thread_session_count: 2,
      branch_session_count: 1,
      branches: [{
        session_id: backingId,
        parent_session_id: continuationId,
        source: 'tui',
        model: 'gpt-4o',
        title: 'Earlier context',
        started_at: 1710000000,
        ended_at: 1710000100,
        last_active: 1710000100,
        is_active: false,
        messages: [],
        visible_count: 0,
        thread_session_count: 1,
        branches: [],
      }],
    })

    const store = useChatStore()
    const session = {
      id: continuationId,
      title: 'Continuation',
      source: 'tui',
      messages: [],
      createdAt: 1,
      updatedAt: 2,
      branchSessionCount: 1,
    }
    store.sessions = [session]
    store.activeSessionId = continuationId
    store.activeSession = session

    await store.sendMessage('keep going')
    await flushPromises()

    expect(window.localStorage.getItem(bridgePersistentSessionKey(continuationId))).toBe(backingId)
    expect(mockConversationsApi.fetchConversationDetail).toHaveBeenCalledWith(continuationId, { humanOnly: true })
    expect(mockConversationsApi.fetchConversationDetail).not.toHaveBeenCalledWith(backingId, { humanOnly: true })
    expect(store.activeSessionId).toBe(continuationId)
    expect(store.sessionBranchCount(continuationId)).toBe(1)
  })

  it('keeps a persistent continuation session instead of replacing it with its bridge backing session', async () => {
    const continuationId = '20260502_135857_2f594e'
    const backingId = '20260502_120953_713358'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, continuationId)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: continuationId,
      title: 'Continuation',
      source: 'tui',
      messages: [],
      createdAt: 1,
      updatedAt: 2,
      branchSessionCount: 1,
    }]))
    window.localStorage.setItem(bridgeLocalSessionKey(continuationId), '1')
    window.localStorage.setItem(bridgePersistentSessionKey(continuationId), backingId)
    window.localStorage.setItem(inFlightKey(continuationId), JSON.stringify({ runId: 'bridge_run_continuation', startedAt: Date.now() }))

    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      { ...makeSummary(backingId, 'Earlier context'), source: 'tui', branch_session_count: 0 },
    ])
    mockConversationsApi.fetchConversationDetail.mockResolvedValue({
      session_id: continuationId,
      messages: [],
      visible_count: 0,
      thread_session_count: 1,
      branch_session_count: 0,
      branches: [],
    })
    mockSessionsApi.fetchSession.mockResolvedValue(makeDetail(continuationId, []))

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()

    expect(store.activeSessionId).toBe(continuationId)
    expect(store.sessions.some(session => session.id === continuationId)).toBe(true)
    expect(store.sessions.some(session => session.id === backingId)).toBe(false)
  })

  it('drops stale cached persistent bridge sessions that are no longer visible summaries', async () => {
    const staleId = '20260502_120953_713358'
    const visibleId = '20260502_135857_2f594e'
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: staleId,
      title: 'Earlier continuation',
      source: 'tui',
      messages: [],
      createdAt: 1,
      updatedAt: 2,
    }]))
    window.localStorage.setItem(bridgeLocalSessionKey(staleId), '1')

    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      { ...makeSummary(visibleId, 'Latest continuation'), source: 'tui', branch_session_count: 1 },
    ])
    mockConversationsApi.fetchConversationDetail.mockResolvedValue({
      session_id: visibleId,
      messages: [],
      visible_count: 0,
      thread_session_count: 1,
      branch_session_count: 0,
      branches: [],
    })
    mockSessionsApi.fetchSession.mockResolvedValue(makeDetail(visibleId, []))

    const store = useChatStore()
    await store.loadSessions()

    expect(store.sessions.map(session => session.id)).toEqual([visibleId])
    expect(window.localStorage.getItem(bridgeLocalSessionKey(staleId))).toBeNull()
  })

  it('deduplicates continuation split sessions when conversation summaries expose represented session ids', async () => {
    const logicalId = '20260502_135857_2f594e'
    const historyId = '20260502_120953_713358'

    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      {
        ...makeSummary(logicalId, 'Continuation'),
        source: 'tui',
        branch_session_count: 1,
        represented_session_ids: [logicalId, historyId],
      },
    ])
    mockSessionsApi.fetchSessions.mockResolvedValue([
      { ...makeSummary(logicalId, 'Continuation'), source: 'tui' },
      { ...makeSummary(historyId, 'History'), source: 'tui' },
    ])
    mockConversationsApi.fetchConversationDetail.mockResolvedValue({
      session_id: logicalId,
      messages: [],
      visible_count: 0,
      thread_session_count: 1,
      branch_session_count: 0,
      branches: [],
    })
    mockSessionsApi.fetchSession.mockResolvedValue(makeDetail(logicalId, []))

    const store = useChatStore()
    await store.loadSessions()

    expect(store.sessions.map(session => session.id)).toEqual([logicalId])
    expect(store.sessions[0].representedSessionIds).toEqual([logicalId, historyId])
  })

  it('supplements missing tui sessions from the raw session list when conversation summaries omit them', async () => {
    const visibleId = 'visible-tui'
    const missingId = 'missing-tui'

    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      { ...makeSummary(visibleId, 'Visible'), source: 'tui', branch_session_count: 0 },
    ])
    mockSessionsApi.fetchHermesSessions.mockResolvedValue([
      { ...makeSummary(visibleId, 'Visible'), source: 'tui' },
      { ...makeSummary(missingId, 'Missing but real'), source: 'tui' },
    ])
    mockConversationsApi.fetchConversationDetail.mockResolvedValue({
      session_id: visibleId,
      messages: [],
      visible_count: 0,
      thread_session_count: 1,
      branch_session_count: 0,
      branches: [],
    })
    mockSessionsApi.fetchSession.mockImplementation(async (id: string) => makeDetail(id, []))

    const store = useChatStore()
    await store.loadSessions()

    expect(store.sessions.map(session => session.id)).toEqual([visibleId, missingId])
  })

  it('does not hide raw tui sessions based on stale represented ids from the previous cache', async () => {
    const rootId = 'root-tui'
    const staleRepresentedId = 'stale-child-tui'

    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: rootId,
      title: 'Cached aggregate',
      source: 'tui',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      representedSessionIds: [rootId, staleRepresentedId],
    }]))

    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      {
        ...makeSummary(rootId, 'Fresh root'),
        source: 'tui',
        represented_session_ids: [rootId],
      },
    ])
    mockSessionsApi.fetchHermesSessions.mockResolvedValue([
      { ...makeSummary(rootId, 'Fresh root'), source: 'tui' },
      { ...makeSummary(staleRepresentedId, 'Real TUI session'), source: 'tui' },
    ])
    mockSessionsApi.fetchSession.mockImplementation(async (id: string) => makeDetail(id, []))

    const store = useChatStore()
    await store.loadSessions()

    expect(store.sessions.map(session => session.id)).toEqual([rootId, staleRepresentedId])
  })

  it('does not remove a session locally when single delete fails on the server', async () => {
    mockSessionsApi.deleteSession.mockResolvedValue(false)

    const store = useChatStore()
    store.sessions = [{
      id: 'delete-me',
      title: 'Delete me',
      source: 'tui',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    }]
    store.activeSessionId = 'delete-me'
    store.activeSession = store.sessions[0]

    const ok = await store.deleteSession('delete-me')

    expect(ok).toBe(false)
    expect(store.sessions.map(session => session.id)).toEqual(['delete-me'])
  })

  it('clears caches for all represented session ids when deleting a logical session', async () => {
    const logicalId = 'logical-tui'
    const historyId = 'history-tui'
    window.localStorage.setItem(sessionMessagesKey(logicalId), JSON.stringify([{ id: '1' }]))
    window.localStorage.setItem(sessionMessagesKey(historyId), JSON.stringify([{ id: '2' }]))

    const store = useChatStore()
    store.sessions = [{
      id: logicalId,
      title: 'Logical',
      source: 'tui',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      representedSessionIds: [logicalId, historyId],
    }]
    store.activeSessionId = logicalId
    store.activeSession = store.sessions[0]

    const ok = await store.deleteSession(logicalId)

    expect(ok).toBe(true)
    expect(window.localStorage.getItem(sessionMessagesKey(logicalId))).toBeNull()
    expect(window.localStorage.getItem(sessionMessagesKey(historyId))).toBeNull()
  })

  it('does not poll full session detail while an SSE stream is active', async () => {
    vi.useFakeTimers()

    const store = useChatStore()
    await store.sendMessage('inspect working tree')
    await flushPromises()

    const sid = store.activeSessionId
    expect(sid).toBeTruthy()
    mockSessionsApi.fetchSession.mockClear()

    const onEvent = mockChatApi.streamRunEvents.mock.calls[0]?.[1] as ((event: Record<string, unknown>) => void)
    expect(typeof onEvent).toBe('function')

    onEvent({
      event: 'tool.started',
      tool: 'terminal',
      call_id: 'call_1',
      preview: "python3 - <<'PY' import subprocess status = subprocess.check_output(['git','s...",
    })
    onEvent({ event: 'message.delta', delta: 'local streamed answer' })

    await vi.advanceTimersByTimeAsync(2100)
    await flushPromises()

    const toolMessage = store.messages.find(message => message.role === 'tool')
    expect(toolMessage).toMatchObject({
      toolName: 'terminal',
      toolCallId: 'call_1',
      toolStatus: 'running',
    })
    expect(mockSessionsApi.fetchSession).not.toHaveBeenCalled()
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

  it('updates active session usage from live usage.updated events', async () => {
    let onEvent!: (event: any) => void
    mockChatApi.streamRunEvents.mockImplementation((_runId: string, cb: (event: any) => void) => {
      onEvent = cb
      return { abort: vi.fn() }
    })

    const store = useChatStore()
    await store.sendMessage('count live context')
    await flushPromises()

    onEvent({
      event: 'usage.updated',
      inputTokens: 321,
      outputTokens: 12,
      contextTokens: 9001,
    })

    expect(store.activeSession?.inputTokens).toBe(321)
    expect(store.activeSession?.outputTokens).toBe(12)
    expect(store.activeSession?.contextTokens).toBe(9001)
  })

  it('updates active session context tokens from completed usage events', async () => {
    let onEvent!: (event: any) => void
    mockChatApi.streamRunEvents.mockImplementation((_runId: string, cb: (event: any) => void) => {
      onEvent = cb
      return { abort: vi.fn() }
    })

    const store = useChatStore()
    await store.sendMessage('finish with context usage')
    await flushPromises()

    onEvent({
      event: 'run.completed',
      usage: { input_tokens: 123, output_tokens: 45, total_tokens: 168, context_tokens: 4321 },
      output: 'done',
    })

    expect(store.activeSession?.contextTokens).toBe(4321)
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
    expect(window.localStorage.getItem(sessionModelOverrideKey(store.activeSession!.id))).toBeNull()
  })

  it('clears stale session model overrides so old sessions follow the global model', async () => {
    const appStore = useAppStore()
    appStore.selectedModel = 'global-model'
    appStore.selectedProvider = 'global-provider'
    window.localStorage.setItem(sessionModelOverrideKey('old-session'), JSON.stringify({
      model: 'stale-session-model',
      provider: 'stale-session-provider',
      updatedAt: Date.now() - 1000,
    }))
    window.localStorage.setItem(ACTIVE_SESSION_KEY, 'old-session')
    mockSessionsApi.fetchSessions.mockResolvedValue([
      { ...makeSummary('old-session'), model: 'json-model', billing_provider: 'json-provider' },
    ])

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()
    expect(store.activeSession?.model).toBe('stale-session-model')

    await store.sendMessage('follow global after switch')

    expect(mockChatApi.startRun).toHaveBeenCalledWith(expect.objectContaining({
      model: 'global-model',
      provider: 'global-provider',
    }))
    expect(store.activeSession?.model).toBe('global-model')
    expect(store.activeSession?.provider).toBe('global-provider')
    expect(window.localStorage.getItem(sessionModelOverrideKey('old-session'))).toBeNull()
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

  it('uses billing base url to recover the provider for older sessions without billing_provider', async () => {
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
    window.localStorage.setItem(ACTIVE_SESSION_KEY, 'legacy-session')
    mockSessionsApi.fetchSessions.mockResolvedValue([
      {
        ...makeSummary('legacy-session'),
        model: 'deepseek-ai/DeepSeek-V4-Pro',
        billing_provider: null,
        billing_base_url: 'https://llm.mathmodel.tech/v1',
      },
    ])

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()
    await store.sendMessage('continue on recovered custom provider')

    expect(mockChatApi.startRun).toHaveBeenCalledWith(expect.objectContaining({
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      provider: 'custom:llm.mathmodel.tech',
    }))
  })

  it('does not send a stale provider when no provider supports the selected model', async () => {
    const appStore = useAppStore()
    appStore.modelGroups = [
      {
        provider: 'openai-codex',
        label: 'OpenAI Codex',
        base_url: '',
        models: ['gpt-5.4'],
        api_key: '',
      },
    ]
    appStore.selectedModel = 'deepseek-ai/DeepSeek-V4-Pro'
    appStore.selectedProvider = 'openai-codex'

    const store = useChatStore()
    store.newChat()
    await store.sendMessage('avoid mismatched provider')

    expect(mockChatApi.startRun).toHaveBeenCalledWith(expect.objectContaining({
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      provider: undefined,
    }))
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
    expect(persisted.some((message: any) => message.isStreaming)).toBe(false)
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

  it('steers busy input for a resumed active bridge session', async () => {
    const settings = useSettingsStore()
    settings.display.busy_input_mode = 'steer'
    settings.loaded = true
    const sid = 'web-session'
    const backingId = '20260502_203836_1522aa'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, sid)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: sid,
      title: 'Running bridge session',
      source: 'tui',
      messages: [{ id: 'u1', role: 'user', content: 'start task', timestamp: Date.now() }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]))
    window.localStorage.setItem(bridgeLocalSessionKey(sid), '1')
    window.localStorage.setItem(bridgePersistentSessionKey(sid), backingId)
    window.localStorage.setItem(inFlightKey(sid), JSON.stringify({ runId: 'bridge_run_resumed', startedAt: Date.now() }))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([])

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()

    expect(store.isRunActive).toBe(true)

    await store.sendMessage('adjust direction')

    expect(store.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'adjust direction',
          steered: true,
        }),
      ]),
    )
    await flushPromises()

    expect(mockChatApi.steerSession).toHaveBeenCalledWith(sid, 'adjust direction', expect.objectContaining({
      client_message_id: expect.any(String),
      client_timestamp: expect.any(Number),
    }))
    expect(mockChatApi.startRun).not.toHaveBeenCalled()
    expect(store.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'adjust direction',
          steered: true,
        }),
      ]),
    )
    expect(store.messages.some(message => message.queued)).toBe(false)
  })

  it('steers busy input from the visible aggregate session when the run belongs to a represented session', async () => {
    const settings = useSettingsStore()
    settings.display.busy_input_mode = 'steer'
    settings.loaded = true
    const rootId = '20260520_113017_a8ef31'
    const childId = '20260520_125149_77f613'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, rootId)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: rootId,
      title: 'Visible aggregate',
      source: 'tui',
      representedSessionIds: [rootId, childId],
      messages: [{ id: 'u1', role: 'user', content: 'start task', timestamp: Date.now() }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]))
    window.localStorage.setItem(inFlightKey(childId), JSON.stringify({ runId: 'bridge_run_child', startedAt: Date.now() }))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([{
      id: rootId,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'Visible aggregate',
      started_at: Date.now() / 1000,
      ended_at: null,
      last_active: Date.now() / 1000,
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      billing_base_url: null,
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      cost_status: 'estimated',
      preview: 'start task',
      is_active: true,
      thread_session_count: 2,
      branch_session_count: 0,
      represented_session_ids: [rootId, childId],
    } as any])

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()

    expect(store.activeSessionId).toBe(rootId)
    expect(store.isRunActive).toBe(true)

    await store.sendMessage('adjust direction')
    await flushPromises()

    expect(mockChatApi.steerSession).toHaveBeenCalledWith(childId, 'adjust direction', expect.objectContaining({
      conversation_id: rootId,
      source_session_id: childId,
      client_message_id: expect.any(String),
      client_timestamp: expect.any(Number),
    }))
    expect(mockChatApi.startRun).not.toHaveBeenCalled()
    expect(store.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'adjust direction',
          steered: true,
        }),
      ]),
    )
    expect(store.messages.some(message => message.queued)).toBe(false)
  })

  it('treats explicit /steer input as steer even when busy input mode is queue', async () => {
    const settings = useSettingsStore()
    settings.display.busy_input_mode = 'queue'
    settings.loaded = true
    const sid = 'web-session'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, sid)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: sid,
      title: 'Running bridge session',
      source: 'tui',
      messages: [{ id: 'u1', role: 'user', content: 'start task', timestamp: Date.now() }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]))
    window.localStorage.setItem(bridgeLocalSessionKey(sid), '1')
    window.localStorage.setItem(inFlightKey(sid), JSON.stringify({ runId: 'bridge_run_resumed', startedAt: Date.now() }))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([])

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()

    await store.sendMessage('/steer adjust direction')
    await flushPromises()

    expect(mockChatApi.steerSession).toHaveBeenCalledWith(sid, 'adjust direction', expect.objectContaining({
      client_message_id: expect.any(String),
      client_timestamp: expect.any(Number),
    }))
    expect(mockChatApi.startRun).not.toHaveBeenCalled()
    expect(store.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'adjust direction',
          steered: true,
        }),
      ]),
    )
    expect(store.messages.some(message => message.content === '/steer adjust direction')).toBe(false)
    expect(store.messages.some(message => message.queued)).toBe(false)
  })

  it('clears stale wrapper-only cached messages when server returns an empty bridge fallback detail', async () => {
    const sid = '20260520_113007_08c81e'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, sid)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: sid,
      title: '你好',
      source: 'tui',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]))
    window.localStorage.setItem(sessionMessagesKey(sid), JSON.stringify([
      {
        id: 'cached-wrapper',
        role: 'user',
        content: 'Previous conversation context:\nassistant: stale history\n\nCurrent user message:\n你好',
        timestamp: Date.now(),
      },
    ]))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([{
      id: sid,
      source: 'tui',
      model: 'deepseek-v4-flash',
      title: '你好',
      started_at: Date.now() / 1000,
      ended_at: null,
      last_active: Date.now() / 1000,
      message_count: 1,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'deepseek',
      billing_base_url: null,
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      cost_status: 'estimated',
      preview: '你好',
      is_active: false,
      thread_session_count: 1,
      branch_session_count: 0,
      represented_session_ids: [sid],
    } as any])
    mockSessionsApi.fetchSession.mockResolvedValue({
      id: sid,
      source: 'webui-bridge',
      model: '',
      title: null,
      started_at: Date.now() / 1000,
      ended_at: null,
      message_count: 0,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: null,
      billing_base_url: null,
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      cost_status: 'unknown',
      messages: [],
    } as any)

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()

    expect(store.activeSessionId).toBe(sid)
    expect(store.messages).toEqual([])
    expect(window.localStorage.getItem(sessionMessagesKey(sid))).toBe('[]')
  })

  it('sends a new turn instead of queueing when bridge steer reports the run is already done', async () => {
    const settings = useSettingsStore()
    settings.display.busy_input_mode = 'steer'
    settings.loaded = true
    const sid = 'web-session'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, sid)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: sid,
      title: 'Finished bridge session',
      source: 'tui',
      messages: [{ id: 'u1', role: 'user', content: 'start task', timestamp: Date.now() }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]))
    window.localStorage.setItem(bridgeLocalSessionKey(sid), '1')
    window.localStorage.setItem(inFlightKey(sid), JSON.stringify({ runId: 'bridge_run_resumed', startedAt: Date.now() }))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([])
    mockChatApi.steerSession.mockRejectedValue(new Error('API Error 502: {"error":{"message":"Bridge steer error: session is not running"}}'))
    mockChatApi.startRun.mockResolvedValueOnce({
      run_id: 'run-after-stale-steer',
      status: 'queued',
      bridge: true,
      session_id: sid,
    })

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()

    const pending = store.sendMessage('new request after finished run')
    expect(store.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'new request after finished run',
          steered: true,
        }),
      ]),
    )
    await pending
    await flushPromises()

    expect(mockChatApi.steerSession).toHaveBeenCalledWith(sid, 'new request after finished run', expect.objectContaining({
      client_message_id: expect.any(String),
      client_timestamp: expect.any(Number),
    }))
    expect(mockChatApi.startRun).toHaveBeenCalledWith(expect.objectContaining({
      input: 'new request after finished run',
      session_id: sid,
    }))
    expect(store.messages.some(message => message.steered && message.content === 'new request after finished run')).toBe(false)
    expect(store.messages.some(message => message.queued)).toBe(false)
  })

  it('preserves the steered badge after server refresh returns the same user text', async () => {
    const settings = useSettingsStore()
    settings.display.busy_input_mode = 'steer'
    settings.loaded = true
    const sid = 'web-session'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, sid)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: sid,
      title: 'Running bridge session',
      source: 'tui',
      messages: [{ id: 'u1', role: 'user', content: 'start task', timestamp: Date.now() }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]))
    window.localStorage.setItem(bridgeLocalSessionKey(sid), '1')
    window.localStorage.setItem(inFlightKey(sid), JSON.stringify({ runId: 'bridge_run_resumed', startedAt: Date.now() }))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([])
    mockSessionsApi.fetchSession.mockResolvedValue({
      id: sid,
      source: 'tui',
      title: 'Running bridge session',
      messages: [
        { id: 'u1', role: 'user', content: 'start task', timestamp: Date.now() - 1000 },
        { id: 'u2', role: 'user', content: 'adjust direction', timestamp: Date.now() },
      ],
    })

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()

    await store.sendMessage('adjust direction')
    await flushPromises()
    await store.switchSession(sid)
    await flushPromises()

    expect(store.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'adjust direction',
          steered: true,
        }),
      ]),
    )
  })

  it('loads display settings before deciding whether busy input should steer', async () => {
    mockConfigApi.fetchConfig.mockResolvedValue({ display: { busy_input_mode: 'steer' } })
    const sid = 'web-session'
    const backingId = '20260502_203836_1522aa'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, sid)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: sid,
      title: 'Running bridge session',
      source: 'tui',
      messages: [{ id: 'u1', role: 'user', content: 'start task', timestamp: Date.now() }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]))
    window.localStorage.setItem(bridgeLocalSessionKey(sid), '1')
    window.localStorage.setItem(bridgePersistentSessionKey(sid), backingId)
    window.localStorage.setItem(inFlightKey(sid), JSON.stringify({ runId: 'bridge_run_resumed', startedAt: Date.now() }))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([])

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()

    await store.sendMessage('adjust direction')
    await flushPromises()

    expect(mockConfigApi.fetchConfig).toHaveBeenCalled()
    expect(mockChatApi.steerSession).toHaveBeenCalledWith(sid, 'adjust direction', expect.objectContaining({
      client_message_id: expect.any(String),
      client_timestamp: expect.any(Number),
    }))
    expect(store.messages.some(message => message.queued)).toBe(false)
  })

  it('reloads display settings before busy input even when a stale default queue value exists', async () => {
    const settings = useSettingsStore()
    settings.display.busy_input_mode = 'queue'
    mockConfigApi.fetchConfig.mockResolvedValue({ display: { busy_input_mode: 'steer' } })
    const sid = 'web-session'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, sid)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: sid,
      title: 'Running bridge session',
      source: 'tui',
      messages: [{ id: 'u1', role: 'user', content: 'start task', timestamp: Date.now() }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]))
    window.localStorage.setItem(bridgeLocalSessionKey(sid), '1')
    window.localStorage.setItem(inFlightKey(sid), JSON.stringify({ runId: 'bridge_run_resumed', startedAt: Date.now() }))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([])

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()

    await store.sendMessage('adjust direction')
    await flushPromises()

    expect(mockConfigApi.fetchConfig).toHaveBeenCalled()
    expect(mockChatApi.steerSession).toHaveBeenCalledWith(sid, 'adjust direction', expect.objectContaining({
      client_message_id: expect.any(String),
      client_timestamp: expect.any(Number),
    }))
    expect(store.messages.some(message => message.queued)).toBe(false)
  })

  it('treats a retained in-flight bridge run as active even after the SSE controller is gone', async () => {
    mockConfigApi.fetchConfig.mockResolvedValue({ display: { busy_input_mode: 'steer' } })
    let dropStream: (() => void) | null = null
    mockChatApi.streamRunEvents.mockImplementation((
      _runId: string,
      _eventHandler: (event: Record<string, any>) => void,
      _doneHandler: () => void,
      errorHandler: (error: Error) => void,
    ) => {
      dropStream = () => errorHandler(new Error('SSE connection error'))
      return { abort: vi.fn() }
    })
    const sid = 'web-session'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, sid)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: sid,
      title: 'Recovering bridge session',
      source: 'tui',
      messages: [{ id: 'u1', role: 'user', content: 'start task', timestamp: Date.now() }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]))
    window.localStorage.setItem(bridgeLocalSessionKey(sid), '1')
    window.localStorage.setItem(inFlightKey(sid), JSON.stringify({ runId: 'bridge_run_recovering', startedAt: Date.now() }))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([])

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()
    dropStream?.()
    await flushPromises()

    expect(store.isRunActive).toBe(true)

    await store.sendMessage('adjust direction while recovering')
    await flushPromises()

    expect(mockChatApi.steerSession).toHaveBeenCalledWith(sid, 'adjust direction while recovering', expect.objectContaining({
      client_message_id: expect.any(String),
      client_timestamp: expect.any(Number),
    }))
    expect(mockChatApi.startRun).not.toHaveBeenCalled()
    expect(store.messages.some(message => message.queued)).toBe(false)
  })

  it('does not treat a persisted steer bubble as an active run after refresh', async () => {
    const sid = 'steer-ended-session'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, sid)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: sid,
      title: 'Ended steer',
      source: 'tui',
      messages: [
        { id: 'u1', role: 'user', content: 'start task', timestamp: 1710000010000 },
        { id: 'a1', role: 'assistant', content: 'done', timestamp: 1710000011000 },
        { id: 'local-steer', role: 'user', content: '收到停止', timestamp: 1710000012000, steered: true },
      ],
      createdAt: 1710000010000,
      updatedAt: 1710000012000,
      endedAt: 1710000013000,
    }]))
    window.localStorage.setItem(steerHistoryKey(sid), JSON.stringify([
      { content: '收到停止', timestamp: 1710000012000, previousMessageId: 'a1' },
    ]))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      { ...makeSummary(sid, 'Ended steer'), source: 'tui', ended_at: 1710000013 },
    ])
    mockSessionsApi.fetchSession.mockResolvedValue({
      id: sid,
      source: 'tui',
      title: 'Ended steer',
      ended_at: 1710000013,
      messages: [
        { id: 'u1', role: 'user', content: 'start task', timestamp: 1710000010 },
        { id: 'a1', role: 'assistant', content: 'done', timestamp: 1710000011 },
      ],
    } as any)

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()

    expect(store.isRunActive).toBe(false)
    expect(store.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'local-steer',
          role: 'user',
          content: '收到停止',
          steered: true,
        }),
      ]),
    )
    expect(mockChatApi.streamRunEvents).not.toHaveBeenCalled()
  })

  it('coalesces rapid stream deltas before updating the active message', async () => {
    vi.useFakeTimers()
    let onEvent: ((event: Record<string, any>) => void) | null = null
    mockChatApi.streamRunEvents.mockImplementation((
      _runId: string,
      eventHandler: (event: Record<string, any>) => void,
    ) => {
      onEvent = eventHandler
      return { abort: vi.fn() }
    })

    const store = useChatStore()
    await store.sendMessage('think fast')
    await flushPromises()

    onEvent?.({ event: 'reasoning.delta', text: 'A' })
    onEvent?.({ event: 'reasoning.delta', text: 'B' })
    onEvent?.({ event: 'reasoning.delta', text: 'C' })

    expect(store.messages.find(message => message.role === 'assistant')?.reasoning).toBe('A')

    await vi.advanceTimersByTimeAsync(119)
    expect(store.messages.find(message => message.role === 'assistant')?.reasoning).toBe('A')

    await vi.advanceTimersByTimeAsync(1)
    expect(store.messages.find(message => message.role === 'assistant')?.reasoning).toBe('ABC')
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

  it('does not let a slower previous session detail overwrite the active session title', async () => {
    const slowId = 'slow-session'
    const fastId = 'fast-session'
    let phase: 'initial' | 'race' = 'initial'

    window.localStorage.setItem(ACTIVE_SESSION_KEY, fastId)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([
      { id: slowId, title: 'Slow Cached', source: 'tui', messages: [], createdAt: 1, updatedAt: 1 },
      { id: fastId, title: 'Fast Cached', source: 'tui', messages: [], createdAt: 2, updatedAt: 2 },
    ]))

    let resolveSlow: ((value: any) => void) | null = null
    let resolveFast: ((value: any) => void) | null = null
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      makeSummary(slowId, 'Slow Server', { source: 'tui' }),
      makeSummary(fastId, 'Fast Server', { source: 'tui' }),
    ])
    mockSessionsApi.fetchSession.mockImplementation((id: string) => {
      if (phase === 'initial' && id === fastId) {
        return Promise.resolve(makeDetail(fastId, [{ id: 'u2', role: 'user', content: 'fast', timestamp: 2 }])) as any
      }
      if (id === slowId) {
        return new Promise(resolve => {
          resolveSlow = resolve
        }) as any
      }
      if (id === fastId) {
        return new Promise(resolve => {
          resolveFast = resolve
        }) as any
      }
      return Promise.resolve(null) as any
    })

    const store = useChatStore()
    await store.loadSessions()
    phase = 'race'
    const slowSwitch = store.switchSession(slowId)
    const fastSwitch = store.switchSession(fastId)

    resolveFast?.(makeDetail(fastId, [{ id: 'u2', role: 'user', content: 'fast', timestamp: 2 }]))
    resolveSlow?.(makeDetail(slowId, [{ id: 'u1', role: 'user', content: 'slow', timestamp: 1 }]))
    await Promise.all([slowSwitch, fastSwitch])
    await flushPromises()

    expect(store.activeSessionId).toBe(fastId)
    expect(store.activeSession?.title).not.toBe('Slow Server')
    expect(store.activeSession?.messages.map(message => message.id)).toEqual(['u2'])
  })

  it('does not let an older switchSession detail response overwrite the current active title', async () => {
    const sessionA = 'race-a'
    const sessionB = 'race-b'

    let resolveA: ((value: any) => void) | null = null
    let resolveB: ((value: any) => void) | null = null
    mockSessionsApi.fetchSession.mockImplementation((id: string) => {
      if (id === sessionA) {
        return new Promise(resolve => {
          resolveA = resolve
        }) as any
      }
      if (id === sessionB) {
        return new Promise(resolve => {
          resolveB = resolve
        }) as any
      }
      return Promise.resolve(null) as any
    })

    const store = useChatStore()
    store.sessions.push(
      { id: sessionA, title: 'Title A', source: 'tui', messages: [], createdAt: 1, updatedAt: 1 } as any,
      { id: sessionB, title: 'Title B', source: 'tui', messages: [], createdAt: 2, updatedAt: 2 } as any,
    )
    store.activeSessionId = sessionA as any
    store.activeSession = store.sessions.find((session: any) => session.id === sessionA) as any
    const switchA = store.switchSession(sessionA)
    const switchB = store.switchSession(sessionB)

    resolveB?.({ ...makeDetail(sessionB, [{ id: 'b1', role: 'user', content: 'B', timestamp: 2 }]), title: 'Title B' })
    await switchB
    resolveA?.({ ...makeDetail(sessionA, [{ id: 'a1', role: 'user', content: 'A', timestamp: 1 }]), title: 'Title A' })
    await switchA
    await flushPromises()

    expect(store.activeSessionId).toBe(sessionB)
    expect(store.activeSession?.title).toBe('Title B')
    expect(store.messages.map(message => message.id)).toEqual(['b1'])
  })

  it('rebinds the active session object immediately after sessions list refresh', async () => {
    const sid = 'active-session'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, sid)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([
      { id: sid, title: 'Old Cached Title', source: 'tui', messages: [], createdAt: 1, updatedAt: 1 },
    ]))

    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      makeSummary(sid, 'Fresh Summary Title', { source: 'tui' }),
    ])
    mockSessionsApi.fetchSession.mockResolvedValue({
      ...makeDetail(sid, [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }]),
      title: '',
    })

    const store = useChatStore()
    await store.loadSessions()

    expect(store.activeSessionId).toBe(sid)
    expect(store.activeSession?.title).toBe('Fresh Summary Title')
  })

  it('does not let a continuation prompt detail title overwrite a better summary title', async () => {
    const sid = '20260430_080229_bb620b'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, sid)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([
      { id: sid, title: 'diff 里我又看到一个很小的 Windows path normalizati...', source: 'tui', messages: [], createdAt: 1, updatedAt: 1 },
    ]))

    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      makeSummary(sid, 'diff 里我又看到一个很小的 Windows path normalizati...', { source: 'tui' }),
    ])
    mockSessionsApi.fetchSession.mockResolvedValue({
      ...makeDetail(sid, [{ id: 'u1', role: 'user', content: '继续', timestamp: 1 }]),
      title: 'Previous conversation context: assistant: ...',
    })

    const store = useChatStore()
    await store.loadSessions()

    expect(store.activeSessionId).toBe(sid)
    expect(store.activeSession?.title).toBe('diff 里我又看到一个很小的 Windows path normalizati...')
  })

  it('does not replay steer history from a slower previous session into the newly active session', async () => {
    const oldId = '20260511_183658_f5976a'
    const newId = '20260512_140104_229161'
    let phase: 'initial' | 'race' = 'initial'

    window.localStorage.setItem(ACTIVE_SESSION_KEY, newId)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([
      { id: oldId, title: 'Old Session', source: 'tui', messages: [], createdAt: 1, updatedAt: 1 },
      { id: newId, title: 'New Session', source: 'tui', messages: [], createdAt: 2, updatedAt: 2 },
    ]))
    window.localStorage.setItem(`hermes_steer_history_v1_default_${oldId}`, JSON.stringify([
      { content: '/steer from old', timestamp: 1000, previousMessageId: 'old-a1' },
    ]))

    let resolveOld: ((value: any) => void) | null = null
    let resolveNew: ((value: any) => void) | null = null
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      makeSummary(oldId, 'Old Session', { source: 'tui' }),
      makeSummary(newId, 'New Session', { source: 'tui' }),
    ])
    mockSessionsApi.fetchSession.mockImplementation((id: string) => {
      if (phase === 'initial' && id === newId) {
        return Promise.resolve(makeDetail(newId, [{ id: 'new-u1', role: 'user', content: 'new content', timestamp: 2 }])) as any
      }
      if (id === oldId) {
        return new Promise(resolve => {
          resolveOld = resolve
        }) as any
      }
      if (id === newId) {
        return new Promise(resolve => {
          resolveNew = resolve
        }) as any
      }
      return Promise.resolve(null) as any
    })

    const store = useChatStore()
    await store.loadSessions()
    phase = 'race'
    const oldSwitch = store.switchSession(oldId)
    const newSwitch = store.switchSession(newId)

    resolveNew?.(makeDetail(newId, [{ id: 'new-u1', role: 'user', content: 'new content', timestamp: 2 }]))
    resolveOld?.(makeDetail(oldId, [{ id: 'old-a1', role: 'assistant', content: 'old assistant', timestamp: 1 }]))
    await Promise.all([oldSwitch, newSwitch])
    await flushPromises()

    expect(store.activeSessionId).toBe(newId)
    expect(store.messages.some(message => message.content === '/steer from old')).toBe(false)
    expect(store.messages.map(message => message.id)).toEqual(['new-u1'])
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

  it('preserves local tool detail when a caught-up server snapshot is less detailed', async () => {
    window.localStorage.setItem(ACTIVE_SESSION_KEY, 'sess-tool-merge')
    window.localStorage.setItem(
      SESSIONS_CACHE_KEY,
      JSON.stringify([
        {
          id: 'sess-tool-merge',
          title: 'Tool merge',
          source: 'api_server',
          messages: [],
          createdAt: 1,
          updatedAt: 2,
        },
      ]),
    )
    window.localStorage.setItem(
      sessionMessagesKey('sess-tool-merge'),
      JSON.stringify([
        { id: 'u1', role: 'user', content: 'check status', timestamp: 1 },
        {
          id: 't1',
          role: 'tool',
          content: '',
          timestamp: 2,
          toolName: 'terminal',
          toolPreview: 'git status --short',
          toolArgs: JSON.stringify({ command: 'git status --short' }),
          toolResult: JSON.stringify({ output: 'M packages/client/src/stores/hermes/chat.ts', exit_code: 0 }),
          toolStatus: 'done',
        },
      ]),
    )

    mockSessionsApi.fetchSessions.mockResolvedValue([makeSummary('sess-tool-merge', 'Tool merge')])
    mockSessionsApi.fetchSession.mockResolvedValue(makeDetail('sess-tool-merge', [
      {
        id: 1,
        session_id: 'sess-tool-merge',
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
        session_id: 'sess-tool-merge',
        role: 'assistant',
        content: 'done',
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
        session_id: 'sess-tool-merge',
        role: 'tool',
        content: '',
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
    await store.refreshActiveSession()

    const toolMessage = store.messages.find(message => message.role === 'tool')
    expect(toolMessage?.toolName).toBe('terminal')
    expect(toolMessage?.toolArgs).toContain('"command":"git status --short"')
    expect(toolMessage?.toolResult).toContain('packages/client/src/stores/hermes/chat.ts')
  })

  it('keeps branch tool details when branch metadata refresh is less detailed', async () => {
    const rootId = 'root-tool-branch'
    const branchId = 'branch-tool-detail'
    const detailedToolArgs = JSON.stringify({ command: 'git status --short' })
    const detailedToolResult = JSON.stringify({ output: 'M packages/client/src/stores/hermes/chat.ts', exit_code: 0 })

    window.localStorage.setItem(ACTIVE_SESSION_KEY, rootId)
    window.localStorage.setItem(
      SESSIONS_CACHE_KEY,
      JSON.stringify([
        {
          id: rootId,
          title: 'Root',
          source: 'tui',
          messages: [],
          createdAt: 1,
          updatedAt: 2,
          branchSessionCount: 1,
        },
        {
          id: branchId,
          title: 'Branch task',
          source: 'tui',
          messages: [
            { id: 'u1', role: 'user', content: 'Branch task', timestamp: 2 },
            { id: 'a1', role: 'assistant', content: 'Working', timestamp: 3 },
            {
              id: 't1',
              role: 'tool',
              content: '',
              timestamp: 4,
              toolName: 'terminal',
              toolPreview: 'git status --short',
              toolArgs: detailedToolArgs,
              toolResult: detailedToolResult,
              toolStatus: 'done',
            },
          ],
          createdAt: 2,
          updatedAt: 4,
          parentSessionId: rootId,
          rootSessionId: rootId,
          isBranchSession: true,
        },
      ]),
    )
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      { ...makeSummary(rootId, 'Root'), source: 'tui', branch_session_count: 1 },
    ])
    mockConversationsApi.fetchConversationDetail.mockResolvedValue({
      session_id: rootId,
      messages: [],
      visible_count: 0,
      thread_session_count: 1,
      branch_session_count: 1,
      branches: [{
        session_id: branchId,
        parent_session_id: rootId,
        source: 'tui',
        model: 'gpt-4o',
        title: 'Branch task',
        started_at: 1710000002,
        ended_at: null,
        last_active: 1710000003,
        is_active: false,
        messages: [
          { id: 1, session_id: branchId, role: 'user', content: 'Branch task', timestamp: 1710000002 },
          { id: 2, session_id: branchId, role: 'assistant', content: 'Working', timestamp: 1710000003 },
          { id: 3, session_id: branchId, role: 'tool', content: '', timestamp: 1710000004 },
        ],
        visible_count: 3,
        thread_session_count: 1,
        branches: [],
      }],
    })
    mockSessionsApi.fetchSession.mockResolvedValue(makeDetail(rootId, []))

    const store = useChatStore()
    await store.loadSessions()
    await store.refreshSessionBranches(rootId)

    const branchSession = store.sessions.find(session => session.id === branchId)
    const toolMessage = branchSession?.messages.find(message => message.role === 'tool')
    expect(toolMessage).toMatchObject({
      toolName: 'terminal',
      toolPreview: 'git status --short',
      toolArgs: detailedToolArgs,
      toolResult: detailedToolResult,
      toolStatus: 'done',
    })
  })

  it('preserves branch tool details when switching into a branch backed by less detailed branch messages', async () => {
    const rootId = 'root-switch-tool-branch'
    const branchId = 'branch-switch-tool-detail'
    const detailedToolArgs = JSON.stringify({ command: 'git status --short' })
    const detailedToolResult = JSON.stringify({ output: 'M packages/client/src/stores/hermes/chat.ts', exit_code: 0 })

    window.localStorage.setItem(ACTIVE_SESSION_KEY, rootId)
    window.localStorage.setItem(
      SESSIONS_CACHE_KEY,
      JSON.stringify([
        {
          id: rootId,
          title: 'Root',
          source: 'tui',
          messages: [],
          createdAt: 1,
          updatedAt: 2,
          branchSessionCount: 1,
        },
        {
          id: branchId,
          title: 'Branch task',
          source: 'tui',
          messages: [
            { id: 'u1', role: 'user', content: 'Branch task', timestamp: 2 },
            { id: 'a1', role: 'assistant', content: 'Working', timestamp: 3 },
            {
              id: 't1',
              role: 'tool',
              content: '',
              timestamp: 4,
              toolName: 'terminal',
              toolPreview: 'git status --short',
              toolArgs: detailedToolArgs,
              toolResult: detailedToolResult,
              toolStatus: 'done',
              toolCallId: 'call_1',
            },
          ],
          createdAt: 2,
          updatedAt: 4,
          parentSessionId: rootId,
          rootSessionId: rootId,
          isBranchSession: true,
        },
      ]),
    )
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      { ...makeSummary(rootId, 'Root'), source: 'tui', branch_session_count: 1 },
    ])
    mockConversationsApi.fetchConversationDetail.mockResolvedValue({
      session_id: rootId,
      messages: [],
      visible_count: 0,
      thread_session_count: 1,
      branch_session_count: 1,
      branches: [{
        session_id: branchId,
        parent_session_id: rootId,
        source: 'tui',
        model: 'gpt-4o',
        title: 'Branch task',
        started_at: 1710000002,
        ended_at: null,
        last_active: 1710000003,
        is_active: false,
        messages: [
          { id: 1, session_id: branchId, role: 'user', content: 'Branch task', timestamp: 1710000002 },
          { id: 2, session_id: branchId, role: 'assistant', content: 'Working', timestamp: 1710000003 },
        ],
        visible_count: 2,
        thread_session_count: 1,
        branches: [],
      }],
    })
    mockSessionsApi.fetchSession.mockImplementation(async (id: string) => {
      if (id === rootId) return makeDetail(rootId, [])
      if (id === branchId) return null
      return null
    })

    const store = useChatStore()
    await store.loadSessions()
    await store.refreshSessionBranches(rootId)
    await store.switchBranchSession(rootId, branchId)

    const branchSession = store.sessions.find(session => session.id === branchId)
    const toolMessage = branchSession?.messages.find(message => message.role === 'tool')
    expect(toolMessage).toMatchObject({
      toolName: 'terminal',
      toolPreview: 'git status --short',
      toolArgs: detailedToolArgs,
      toolResult: detailedToolResult,
      toolStatus: 'done',
      toolCallId: 'call_1',
    })
  })

  it('preserves a steered user bubble when switching into a branch with matching fetched detail', async () => {
    const rootId = 'root-steered-branch'
    const branchId = 'branch-steered'

    window.localStorage.setItem(ACTIVE_SESSION_KEY, rootId)
    window.localStorage.setItem(
      SESSIONS_CACHE_KEY,
      JSON.stringify([
        {
          id: rootId,
          title: 'Root',
          source: 'tui',
          messages: [],
          createdAt: 1,
          updatedAt: 2,
          branchSessionCount: 1,
        },
      ]),
    )

    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      makeSummary(rootId, 'Root', {
        source: 'tui',
        branch_session_count: 1,
        branches: [{
          session_id: branchId,
          parent_session_id: rootId,
          source: 'tui',
          model: 'gpt-4o',
          title: 'Branch steered',
          started_at: 1710000002,
          ended_at: null,
          last_active: 1710000003,
          is_active: false,
          messages: [
            { id: 1, session_id: branchId, role: 'user', content: 'adjust direction', timestamp: 1710000002 },
          ],
          visible_count: 1,
          thread_session_count: 1,
          branches: [],
        }],
      }),
    ])
    mockSessionsApi.fetchSession.mockImplementation(async (id: string) => {
      if (id === rootId) return makeDetail(rootId, [])
      if (id === branchId) {
        return {
          id: branchId,
          source: 'tui',
          title: 'Branch steered',
          messages: [
            { id: 1, role: 'user', content: 'adjust direction', timestamp: 1710000002 },
          ],
        } as any
      }
      return null
    })

    const store = useChatStore()
    await store.loadSessions()
    await store.refreshSessionBranches(rootId)

    store.sessions.push({
      id: branchId,
      title: 'Branch steered',
      source: 'tui',
      messages: [
        { id: 'local-steer', role: 'user', content: 'adjust direction', timestamp: 1710000002, steered: true },
      ],
      createdAt: 1710000002000,
      updatedAt: 1710000003000,
      isBranchSession: true,
      rootSessionId: rootId,
    } as any)

    await store.switchBranchSession(rootId, branchId)

    const branchSession = store.sessions.find(session => session.id === branchId)
    expect(branchSession?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'adjust direction',
          steered: true,
        }),
      ]),
    )
  })

  it('reapplies a persisted steer record even when the local steered message was already lost', async () => {
    const sid = 'steer-history-session'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, sid)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: sid,
      title: 'Steer History',
      source: 'tui',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]))
    window.localStorage.setItem(`hermes_steer_history_v1_default_${sid}`, JSON.stringify([
      { content: 'adjust direction', timestamp: Date.now() - 1000 },
    ]))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      makeSummary(sid, 'Steer History', { source: 'tui' }),
    ])
    mockSessionsApi.fetchSession.mockResolvedValue({
      id: sid,
      source: 'tui',
      title: 'Steer History',
      messages: [
        { id: 'u1', role: 'user', content: 'adjust direction', timestamp: Date.now() - 1000 },
      ],
    })

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()

    expect(store.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'adjust direction',
          steered: true,
        }),
      ]),
    )
  })

  it('hydrates steered badges from cache before the first session render', async () => {
    const sid = 'cached-steer-session'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, sid)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: sid,
      title: 'Cached Steer',
      source: 'tui',
      messages: [
        { id: 'u1', role: 'user', content: 'adjust direction', timestamp: Date.now() - 1000 },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]))
    window.localStorage.setItem(`hermes_steer_history_v1_default_${sid}`, JSON.stringify([
      { content: 'adjust direction', timestamp: Date.now() - 1000 },
    ]))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([])
    mockSessionsApi.fetchSession.mockResolvedValue(null)

    const store = useChatStore()
    await store.loadSessions()

    expect(store.activeSession?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'adjust direction',
          steered: true,
        }),
      ]),
    )
  })

  it('keeps a pending local steered bubble when switching sessions before the server records it', async () => {
    const sid = 'steer-pending-session'
    const otherSid = 'another-session'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, otherSid)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([
      {
        id: sid,
        title: 'Pending Steer',
        source: 'tui',
        messages: [
          { id: 'local-steer', role: 'user', content: 'adjust direction', timestamp: 1710000015000, steered: true },
          { id: 'a1', role: 'assistant', content: 'working', timestamp: 1710000016000 },
        ],
        createdAt: 1710000010000,
        updatedAt: 1710000016000,
      },
      {
        id: otherSid,
        title: 'Other',
        source: 'tui',
        messages: [],
        createdAt: 1710000000000,
        updatedAt: 1710000001000,
      },
    ]))
    window.localStorage.setItem(`hermes_steer_history_v1_default_${sid}`, JSON.stringify([
      { content: 'adjust direction', timestamp: 1710000015000 },
    ]))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      makeSummary(sid, 'Pending Steer', { source: 'tui' }),
      makeSummary(otherSid, 'Other', { source: 'tui' }),
    ])
    mockSessionsApi.fetchSession.mockImplementation(async (id: string) => {
      if (id === sid) {
        return {
          id: sid,
          source: 'tui',
          title: 'Pending Steer',
          messages: [
            { id: 'a1', role: 'assistant', content: 'working', timestamp: 1710000016000 },
          ],
        } as any
      }
      if (id === otherSid) return makeDetail(otherSid, [])
      return null
    })

    const store = useChatStore()
    await store.loadSessions()
    await store.switchSession(sid)

    expect(store.activeSession?.messages).toEqual([
      expect.objectContaining({
        id: 'local-steer',
        role: 'user',
        content: 'adjust direction',
        steered: true,
      }),
      expect.objectContaining({
        id: 'a1',
        role: 'assistant',
        content: 'working',
      }),
    ])
  })

  it('keeps a pending local steer bubble after its local predecessor when rehydrating a session', async () => {
    const sid = 'steer-after-history-session'
    const otherSid = 'another-session'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, otherSid)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([
      {
        id: sid,
        title: 'Pending Steer After History',
        source: 'tui',
        messages: [
          { id: 'u1', role: 'user', content: 'first request', timestamp: 1710000010000 },
          { id: 'a1', role: 'assistant', content: 'first answer', timestamp: 1710000011000 },
          { id: 'local-steer', role: 'user', content: 'adjust direction', timestamp: 1710000012000, steered: true },
        ],
        createdAt: 1710000010000,
        updatedAt: 1710000012000,
      },
      {
        id: otherSid,
        title: 'Other',
        source: 'tui',
        messages: [],
        createdAt: 1710000000000,
        updatedAt: 1710000001000,
      },
    ]))
    window.localStorage.setItem(`hermes_steer_history_v1_default_${sid}`, JSON.stringify([
      { content: 'adjust direction', timestamp: 1710000012000, previousMessageId: 'a1' },
    ]))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      makeSummary(sid, 'Pending Steer After History', { source: 'tui' }),
      makeSummary(otherSid, 'Other', { source: 'tui' }),
    ])
    mockSessionsApi.fetchSession.mockImplementation(async (id: string) => {
      if (id === sid) {
        return {
          id: sid,
          source: 'tui',
          title: 'Pending Steer After History',
          messages: [
            { id: 'u1', role: 'user', content: 'first request', timestamp: 1710000010 },
            { id: 'a1', role: 'assistant', content: 'first answer', timestamp: 1710000011 },
          ],
        } as any
      }
      if (id === otherSid) return makeDetail(otherSid, [])
      return null
    })

    const store = useChatStore()
    await store.loadSessions()
    await store.switchSession(sid)

    expect(store.activeSession?.messages.map(message => message.id)).toEqual(['u1', 'a1', 'local-steer'])
    expect(store.activeSession?.messages[2]).toMatchObject({
      id: 'local-steer',
      role: 'user',
      content: 'adjust direction',
      steered: true,
    })
  })

  it('keeps a recorded steer bubble at its original local position after server refresh', async () => {
    const sid = 'steer-recorded-position-session'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, sid)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: sid,
      title: 'Recorded Steer Position',
      source: 'tui',
      messages: [
        { id: 'u1', role: 'user', content: 'run three tools', timestamp: 1710000010000 },
        { id: 'tool-1', role: 'tool', content: '', toolName: 'terminal', toolCallId: 'call-1', toolStatus: 'done', timestamp: 1710000011000 },
        { id: 'local-steer', role: 'user', content: '收到停止', timestamp: 1710000012000, steered: true },
        { id: 'tool-2', role: 'tool', content: '', toolName: 'terminal', toolCallId: 'call-2', toolStatus: 'done', timestamp: 1710000013000 },
        { id: 'a1', role: 'assistant', content: 'stopped', timestamp: 1710000014000 },
      ],
      createdAt: 1710000010000,
      updatedAt: 1710000014000,
    }]))
    window.localStorage.setItem(`hermes_steer_history_v1_default_${sid}`, JSON.stringify([
      { content: '收到停止', timestamp: 1710000012000, previousMessageId: 'tool-1' },
    ]))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      makeSummary(sid, 'Recorded Steer Position', { source: 'tui' }),
    ])
    mockSessionsApi.fetchSession.mockResolvedValue({
      id: sid,
      source: 'tui',
      title: 'Recorded Steer Position',
      messages: [
        { id: 'u1', role: 'user', content: 'run three tools', timestamp: 1710000010 },
        { id: 'tool-1', role: 'tool', content: '', tool_name: 'terminal', tool_call_id: 'call-1', timestamp: 1710000011 },
        { id: 'tool-2', role: 'tool', content: '', tool_name: 'terminal', tool_call_id: 'call-2', timestamp: 1710000013 },
        { id: 'a1', role: 'assistant', content: 'stopped', timestamp: 1710000014 },
        { id: 'server-steer', role: 'user', content: '收到停止', timestamp: 1710000012 },
      ],
    } as any)

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()

    expect(store.messages.map(message => message.id)).toEqual(['u1', 'tool-1', 'server-steer', 'tool-2', 'a1'])
    expect(store.messages[2]).toMatchObject({
      id: 'server-steer',
      role: 'user',
      content: '收到停止',
      steered: true,
    })
  })

  it('hydrates server-persisted steer bubbles without local steer history', async () => {
    const sid = 'steer-server-source-session'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, sid)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: sid,
      title: 'Server Steer',
      source: 'tui',
      messages: [],
      createdAt: 1710000010000,
      updatedAt: 1710000013000,
    }]))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      makeSummary(sid, 'Server Steer', { source: 'tui' }),
    ])
    mockSessionsApi.fetchSession.mockResolvedValue({
      id: sid,
      source: 'tui',
      title: 'Server Steer',
      messages: [
        { id: 'u1', role: 'user', content: 'start task', timestamp: 1710000010 },
        { id: 'ui.steer.evt-1', role: 'user', content: '收到停止', timestamp: 1710000012, steered: true, ui_event_id: 'evt-1' },
        { id: 'a1', role: 'assistant', content: 'stopped', timestamp: 1710000013 },
      ],
    } as any)

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()

    expect(store.messages.map(message => message.id)).toEqual(['u1', 'ui.steer.evt-1', 'a1'])
    expect(store.messages[1]).toMatchObject({
      role: 'user',
      content: '收到停止',
      steered: true,
      ui_event_id: 'evt-1',
    })
  })

  it('drops matching local steer fallback once server-persisted steer bubble exists', async () => {
    const sid = 'steer-server-dedup-session'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, sid)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: sid,
      title: 'Server Steer Dedup',
      source: 'tui',
      messages: [
        { id: 'u1', role: 'user', content: 'start task', timestamp: 1710000010000 },
        { id: 'local-steer', role: 'user', content: '收到停止', timestamp: 1710000012000, steered: true },
      ],
      createdAt: 1710000010000,
      updatedAt: 1710000013000,
    }]))
    window.localStorage.setItem(steerHistoryKey(sid), JSON.stringify([
      { content: '收到停止', timestamp: 1710000012000, previousMessageId: 'u1' },
    ]))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      makeSummary(sid, 'Server Steer Dedup', { source: 'tui' }),
    ])
    mockSessionsApi.fetchSession.mockResolvedValue({
      id: sid,
      source: 'tui',
      title: 'Server Steer Dedup',
      messages: [
        { id: 'u1', role: 'user', content: 'start task', timestamp: 1710000010 },
        { id: 'ui.steer.evt-2', role: 'user', content: '收到停止', timestamp: 1710000012, steered: true, ui_event_id: 'evt-2' },
        { id: 'a1', role: 'assistant', content: 'stopped', timestamp: 1710000013 },
      ],
    } as any)

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()

    expect(store.messages.map(message => message.id)).toEqual(['u1', 'ui.steer.evt-2', 'a1'])
    expect(store.messages.filter(message => message.content === '收到停止')).toHaveLength(1)
    expect(store.messages[1]).toMatchObject({
      steered: true,
      ui_event_id: 'evt-2',
    })
  })

  it('converges optimistic steer bubble id to returned server ui_event_id', async () => {
    const settings = useSettingsStore()
    settings.display.busy_input_mode = 'steer'
    settings.loaded = true
    const sid = 'steer-ui-event-converge-session'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, sid)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: sid,
      title: 'Running bridge session',
      source: 'tui',
      messages: [{ id: 'u1', role: 'user', content: 'start task', timestamp: 1710000010000 }],
      createdAt: 1710000010000,
      updatedAt: 1710000010000,
    }]))
    window.localStorage.setItem(bridgeLocalSessionKey(sid), '1')
    window.localStorage.setItem(inFlightKey(sid), JSON.stringify({ runId: 'bridge_run_resumed', startedAt: Date.now() }))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([])
    mockChatApi.steerSession.mockResolvedValue({ ok: true, status: 'queued', bridge: true, run_id: 'run-1', ui_event_id: 'evt-3' })

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()

    await store.sendMessage('adjust direction')
    await flushPromises()

    expect(mockChatApi.steerSession).toHaveBeenCalledWith(sid, 'adjust direction', expect.objectContaining({
      client_message_id: expect.any(String),
      client_timestamp: expect.any(Number),
    }))
    expect(store.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'ui.steer.evt-3',
          role: 'user',
          content: 'adjust direction',
          steered: true,
          ui_event_id: 'evt-3',
        }),
      ]),
    )
    const history = JSON.parse(window.localStorage.getItem(steerHistoryKey(sid)) || '[]')
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: 'adjust direction',
          uiEventId: 'evt-3',
          clientMessageId: expect.any(String),
        }),
      ]),
    )
  })

  it('restores a local-only steer bubble from history anchors even when cache had drifted to the end', async () => {
    const sid = 'steer-local-only-drifted-position-session'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, sid)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: sid,
      title: 'Local Only Steer Position',
      source: 'tui',
      messages: [
        { id: 'u1', role: 'user', content: 'run three tools', timestamp: 1710000010000 },
        { id: 'tool-1', role: 'tool', content: '', toolName: 'terminal', toolCallId: 'call-1', toolStatus: 'done', timestamp: 1710000011000 },
        { id: 'tool-2', role: 'tool', content: '', toolName: 'terminal', toolCallId: 'call-2', toolStatus: 'done', timestamp: 1710000013000 },
        { id: 'a1', role: 'assistant', content: 'stopped', timestamp: 1710000014000 },
        { id: 'local-steer', role: 'user', content: '收到停止', timestamp: 1710000012000, steered: true },
      ],
      createdAt: 1710000010000,
      updatedAt: 1710000014000,
    }]))
    window.localStorage.setItem(`hermes_steer_history_v1_default_${sid}`, JSON.stringify([
      { content: '收到停止', timestamp: 1710000012000, previousMessageId: 'tool-1' },
    ]))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      makeSummary(sid, 'Local Only Steer Position', { source: 'tui' }),
    ])
    mockSessionsApi.fetchSession.mockResolvedValue({
      id: sid,
      source: 'tui',
      title: 'Local Only Steer Position',
      messages: [
        { id: 'u1', role: 'user', content: 'run three tools', timestamp: 1710000010 },
        { id: 'tool-1', role: 'tool', content: '', tool_name: 'terminal', tool_call_id: 'call-1', timestamp: 1710000011 },
        { id: 'tool-2', role: 'tool', content: '', tool_name: 'terminal', tool_call_id: 'call-2', timestamp: 1710000013 },
        { id: 'a1', role: 'assistant', content: 'stopped', timestamp: 1710000014 },
      ],
    } as any)

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()

    expect(store.messages.map(message => message.id)).toEqual(['u1', 'tool-1', 'local-steer', 'tool-2', 'a1'])
    expect(store.messages[2]).toMatchObject({
      id: 'local-steer',
      role: 'user',
      content: '收到停止',
      steered: true,
    })
  })

  it('does not group multiple local-only steer bubbles with the same text after refresh', async () => {
    const sid = 'steer-local-only-duplicate-text-position-session'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, sid)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: sid,
      title: 'Duplicate Steer Position',
      source: 'tui',
      messages: [
        { id: 'u1', role: 'user', content: 'run many tools', timestamp: 1710000010000 },
        { id: 'tool-1', role: 'tool', content: '', toolName: 'terminal', toolCallId: 'call-1', toolStatus: 'done', timestamp: 1710000011000 },
        { id: 'tool-2', role: 'tool', content: '', toolName: 'terminal', toolCallId: 'call-2', toolStatus: 'done', timestamp: 1710000013000 },
        { id: 'tool-3', role: 'tool', content: '', toolName: 'terminal', toolCallId: 'call-3', toolStatus: 'done', timestamp: 1710000015000 },
        { id: 'a1', role: 'assistant', content: 'stopped', timestamp: 1710000017000 },
        { id: 'local-steer-1', role: 'user', content: '收到停止', timestamp: 1710000012000, steered: true },
        { id: 'local-steer-2', role: 'user', content: '收到停止', timestamp: 1710000014000, steered: true },
      ],
      createdAt: 1710000010000,
      updatedAt: 1710000017000,
    }]))
    window.localStorage.setItem(`hermes_steer_history_v1_default_${sid}`, JSON.stringify([
      { content: '收到停止', timestamp: 1710000012000, previousMessageId: 'tool-1' },
      { content: '收到停止', timestamp: 1710000014000, previousMessageId: 'tool-2' },
    ]))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      makeSummary(sid, 'Duplicate Steer Position', { source: 'tui' }),
    ])
    mockSessionsApi.fetchSession.mockResolvedValue({
      id: sid,
      source: 'tui',
      title: 'Duplicate Steer Position',
      messages: [
        { id: 'u1', role: 'user', content: 'run many tools', timestamp: 1710000010 },
        { id: 'tool-1', role: 'tool', content: '', tool_name: 'terminal', tool_call_id: 'call-1', timestamp: 1710000011 },
        { id: 'tool-2', role: 'tool', content: '', tool_name: 'terminal', tool_call_id: 'call-2', timestamp: 1710000013 },
        { id: 'tool-3', role: 'tool', content: '', tool_name: 'terminal', tool_call_id: 'call-3', timestamp: 1710000015 },
        { id: 'a1', role: 'assistant', content: 'stopped', timestamp: 1710000017 },
      ],
    } as any)

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()

    expect(store.messages.map(message => message.id)).toEqual([
      'u1',
      'tool-1',
      'local-steer-1',
      'tool-2',
      'local-steer-2',
      'tool-3',
      'a1',
    ])
  })

  it('does not group duplicate local-only steer bubbles when server timestamps are missing', async () => {
    const sid = 'steer-local-only-duplicate-text-no-server-timestamps-session'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, sid)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: sid,
      title: 'Duplicate Steer No Timestamp Position',
      source: 'tui',
      messages: [
        { id: 'u1', role: 'user', content: 'run many tools', timestamp: 1710000010000 },
        { id: 'tool-1', role: 'tool', content: '', toolName: 'terminal', toolCallId: 'call-1', toolStatus: 'done', timestamp: 1710000011000 },
        { id: 'local-steer-1', role: 'user', content: '收到停止', timestamp: 1710000012000, steered: true },
        { id: 'tool-2', role: 'tool', content: '', toolName: 'terminal', toolCallId: 'call-2', toolStatus: 'done', timestamp: 1710000013000 },
        { id: 'local-steer-2', role: 'user', content: '收到停止', timestamp: 1710000014000, steered: true },
        { id: 'tool-3', role: 'tool', content: '', toolName: 'terminal', toolCallId: 'call-3', toolStatus: 'done', timestamp: 1710000015000 },
        { id: 'a1', role: 'assistant', content: 'stopped', timestamp: 1710000017000 },
      ],
      createdAt: 1710000010000,
      updatedAt: 1710000017000,
    }]))
    window.localStorage.setItem(`hermes_steer_history_v1_default_${sid}`, JSON.stringify([
      { content: '收到停止', timestamp: 1710000012000 },
      { content: '收到停止', timestamp: 1710000014000 },
    ]))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      makeSummary(sid, 'Duplicate Steer No Timestamp Position', { source: 'tui' }),
    ])
    mockSessionsApi.fetchSession.mockResolvedValue({
      id: sid,
      source: 'tui',
      title: 'Duplicate Steer No Timestamp Position',
      messages: [
        { id: 'u1', role: 'user', content: 'run many tools', timestamp: 0 },
        { id: 'tool-1', role: 'tool', content: '', tool_name: 'terminal', tool_call_id: 'call-1', timestamp: 0 },
        { id: 'tool-2', role: 'tool', content: '', tool_name: 'terminal', tool_call_id: 'call-2', timestamp: 0 },
        { id: 'tool-3', role: 'tool', content: '', tool_name: 'terminal', tool_call_id: 'call-3', timestamp: 0 },
        { id: 'a1', role: 'assistant', content: 'stopped', timestamp: 0 },
      ],
    } as any)

    const store = useChatStore()
    await store.loadSessions()
    await flushPromises()

    expect(store.messages.map(message => message.id)).toEqual([
      'u1',
      'tool-1',
      'local-steer-1',
      'tool-2',
      'local-steer-2',
      'tool-3',
      'a1',
    ])
  })

  it('does not move a steer badge onto an older duplicate user message', async () => {
    const sid = 'steer-duplicate-session'
    window.localStorage.setItem(ACTIVE_SESSION_KEY, sid)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([{
      id: sid,
      title: 'Duplicate Text',
      source: 'tui',
      messages: [],
      createdAt: 1710000000000,
      updatedAt: 1710000025000,
    }]))
    window.localStorage.setItem(`hermes_steer_history_v1_default_${sid}`, JSON.stringify([
      { content: 'same text', timestamp: 1710000020000 },
    ]))
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      makeSummary(sid, 'Duplicate Text', { source: 'tui' }),
    ])
    mockSessionsApi.fetchSession.mockResolvedValue({
      id: sid,
      source: 'tui',
      title: 'Duplicate Text',
      messages: [
        { id: 'u1', role: 'user', content: 'same text', timestamp: 1710000010 },
        { id: 'u2', role: 'user', content: 'same text', timestamp: 1710000020 },
      ],
    } as any)

    const store = useChatStore()
    await store.loadSessions()

    expect(store.messages[0]).toMatchObject({
      id: 'u1',
      role: 'user',
      content: 'same text',
    })
    expect(store.messages[0]).not.toHaveProperty('steered')
    expect(store.messages[1]).toMatchObject({
      id: 'u2',
      role: 'user',
      content: 'same text',
      steered: true,
    })
  })

  it('keeps full branch detail when switching into a branch with equivalent fetched detail', async () => {
    const rootId = 'root-branch-equivalent'
    const branchId = 'branch-equivalent'

    window.localStorage.setItem(ACTIVE_SESSION_KEY, rootId)
    window.localStorage.setItem(
      SESSIONS_CACHE_KEY,
      JSON.stringify([
        {
          id: rootId,
          title: 'Root',
          source: 'tui',
          messages: [],
          createdAt: 1,
          updatedAt: 2,
          branchSessionCount: 1,
        },
        {
          id: branchId,
          title: 'Branch task',
          source: 'tui',
          messages: [
            { id: 'u1', role: 'user', content: 'Branch task', timestamp: 2 },
            { id: 'a1', role: 'assistant', content: 'Working', timestamp: 3 },
            {
              id: 't1',
              role: 'tool',
              content: '',
              timestamp: 4,
              toolName: 'terminal',
              toolPreview: 'git status --short',
              toolArgs: JSON.stringify({ command: 'git status --short' }),
              toolResult: JSON.stringify({ output: 'ok', exit_code: 0 }),
              toolStatus: 'done',
              toolCallId: 'call_1',
            },
            { id: 'a2', role: 'assistant', content: 'Done', timestamp: 5 },
          ],
          createdAt: 2,
          updatedAt: 5,
          parentSessionId: rootId,
          rootSessionId: rootId,
          isBranchSession: true,
        },
      ]),
    )
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      { ...makeSummary(rootId, 'Root'), source: 'tui', branch_session_count: 1 },
    ])
    mockConversationsApi.fetchConversationDetail.mockResolvedValue({
      session_id: rootId,
      messages: [],
      visible_count: 0,
      thread_session_count: 1,
      branch_session_count: 1,
      branches: [{
        session_id: branchId,
        parent_session_id: rootId,
        source: 'tui',
        model: 'gpt-4o',
        title: 'Branch task',
        started_at: 1710000002,
        ended_at: null,
        last_active: 1710000005,
        is_active: false,
        messages: [
          { id: 1, session_id: branchId, role: 'user', content: 'Branch task', timestamp: 1710000002 },
          { id: 2, session_id: branchId, role: 'assistant', content: 'Working', timestamp: 1710000003 },
        ],
        visible_count: 2,
        thread_session_count: 1,
        branches: [],
      }],
    })
    mockSessionsApi.fetchSession.mockImplementation(async (id: string) => {
      if (id === rootId) return makeDetail(rootId, [])
      if (id === branchId) {
        return makeDetail(branchId, [
          {
            id: 1,
            session_id: branchId,
            role: 'user',
            content: 'Branch task',
            tool_call_id: null,
            tool_calls: null,
            tool_name: null,
            timestamp: 1710000002,
            token_count: null,
            finish_reason: null,
            reasoning: null,
          },
          {
            id: 2,
            session_id: branchId,
            role: 'assistant',
            content: '',
            tool_call_id: null,
            tool_calls: [{ id: 'call_1', function: { name: 'terminal', arguments: '{"command":"git status --short"}' } }],
            tool_name: null,
            timestamp: 1710000003,
            token_count: null,
            finish_reason: 'tool_calls',
            reasoning: null,
          },
          {
            id: 3,
            session_id: branchId,
            role: 'tool',
            content: '{"output":"ok","exit_code":0}',
            tool_call_id: 'call_1',
            tool_calls: null,
            tool_name: null,
            timestamp: 1710000004,
            token_count: null,
            finish_reason: null,
            reasoning: null,
          },
          {
            id: 4,
            session_id: branchId,
            role: 'assistant',
            content: 'Done',
            tool_call_id: null,
            tool_calls: null,
            tool_name: null,
            timestamp: 1710000005,
            token_count: null,
            finish_reason: 'stop',
            reasoning: null,
          },
        ])
      }
      return null
    })

    const store = useChatStore()
    await store.loadSessions()
    await store.refreshSessionBranches(rootId)
    const branchSession = store.sessions.find(session => session.id === branchId)!
    await store.switchBranchSession(rootId, branchId)

    expect(store.activeSession?.messages).toHaveLength(3)
    const toolMessage = store.activeSession?.messages.find(message => message.role === 'tool')
    expect(toolMessage).toMatchObject({
      toolName: 'terminal',
      toolArgs: JSON.stringify({ command: 'git status --short' }),
      toolResult: JSON.stringify({ output: 'ok', exit_code: 0 }),
      toolCallId: 'call_1',
      toolStatus: 'done',
    })
    expect(store.activeSession?.messages.map(message => message.role)).toEqual(['user', 'tool', 'assistant'])
  })

  it('uses a prefetched branch detail to switch directly into full branch content', async () => {
    const rootId = 'root-prefetch-branch'
    const branchId = 'branch-prefetch-detail'
    let branchFetches = 0

    window.localStorage.setItem(ACTIVE_SESSION_KEY, rootId)
    window.localStorage.setItem(
      SESSIONS_CACHE_KEY,
      JSON.stringify([
        {
          id: rootId,
          title: 'Root',
          source: 'tui',
          messages: [],
          createdAt: 1,
          updatedAt: 2,
          branchSessionCount: 1,
        },
      ]),
    )
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      { ...makeSummary(rootId, 'Root'), source: 'tui', branch_session_count: 1 },
    ])
    mockConversationsApi.fetchConversationDetail.mockResolvedValue({
      session_id: rootId,
      messages: [],
      visible_count: 0,
      thread_session_count: 1,
      branch_session_count: 1,
      branches: [{
        session_id: branchId,
        parent_session_id: rootId,
        source: 'tui',
        model: 'gpt-4o',
        title: 'Branch task',
        started_at: 1710000002,
        ended_at: null,
        last_active: 1710000005,
        is_active: false,
        messages: [
          { id: 1, session_id: branchId, role: 'user', content: 'Branch task', timestamp: 1710000002 },
        ],
        visible_count: 1,
        thread_session_count: 1,
        branches: [],
      }],
    })
    mockSessionsApi.fetchSession.mockImplementation(async (id: string) => {
      if (id === rootId) return makeDetail(rootId, [])
      if (id === branchId) {
        branchFetches += 1
        return makeDetail(branchId, [
          {
            id: 1,
            session_id: branchId,
            role: 'user',
            content: 'Branch task',
            tool_call_id: null,
            tool_calls: null,
            tool_name: null,
            timestamp: 1710000002,
            token_count: null,
            finish_reason: null,
            reasoning: null,
          },
          {
            id: 2,
            session_id: branchId,
            role: 'assistant',
            content: 'Done',
            tool_call_id: null,
            tool_calls: null,
            tool_name: null,
            timestamp: 1710000003,
            token_count: null,
            finish_reason: 'stop',
            reasoning: null,
          },
        ])
      }
      return null
    })

    const store = useChatStore()
    await store.loadSessions()
    await store.refreshSessionBranches(rootId)
    await store.switchBranchSession(rootId, branchId)

    expect(branchFetches).toBeGreaterThanOrEqual(1)
    expect(store.activeSession?.messages.map(message => message.content)).toEqual(['Branch task', 'Done'])
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

  it('does not replace active branch messages when branch hydration returns equivalent content', async () => {
    const rootId = 'root-stable-branch'
    const branchId = 'tui-stable-branch'
    const detailMessages = [
      { id: 1, session_id: branchId, role: 'user', content: 'Review branch', timestamp: 1710000100 },
      {
        id: 2,
        session_id: branchId,
        role: 'assistant',
        content: 'Full hydrated markdown **rendered** answer\n\n'.repeat(80),
        timestamp: 1710000101,
      },
    ]

    window.localStorage.setItem(ACTIVE_SESSION_KEY, rootId)
    window.localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify([
      {
        id: rootId,
        title: 'Root',
        source: 'tui',
        messages: [],
        createdAt: 1,
        updatedAt: 2,
        branchSessionCount: 1,
      },
    ]))

    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      { ...makeSummary(rootId, 'Root'), source: 'tui', branch_session_count: 1 },
    ])
    mockConversationsApi.fetchConversationDetail.mockResolvedValue({
      session_id: rootId,
      messages: [],
      visible_count: 0,
      thread_session_count: 1,
      branch_session_count: 1,
      branches: [{
        session_id: branchId,
        parent_session_id: rootId,
        source: 'tui',
        model: 'gpt-5.5',
        title: 'Review branch',
        started_at: 1710000100,
        ended_at: 1710000102,
        last_active: 1710000102,
        is_active: false,
        visible_count: detailMessages.length,
        thread_session_count: 1,
        messages: detailMessages,
        branches: [],
      }],
    })
    mockSessionsApi.fetchSession.mockImplementation(async (id: string) => {
      if (id === branchId) return makeDetail(branchId, detailMessages)
      return makeDetail(rootId, [])
    })

    const store = useChatStore()
    await store.loadSessions()
    await store.refreshSessionBranches(rootId)
    await store.switchBranchSession(rootId, branchId)

    const messagesRef = store.messages
    const assistantRef = store.messages[1]

    await store.refreshSessionBranches(rootId)

    expect(store.activeSessionId).toBe(branchId)
    expect(store.messages).toBe(messagesRef)
    expect(store.messages[1]).toBe(assistantRef)
  })

  it('does not downgrade the active hydrated branch to branch summary while full detail is pending', async () => {
    const rootId = 'root-summary-downgrade'
    const branchId = 'tui-summary-downgrade'
    const fullMessages = [
      { id: 'u1', role: 'user' as const, content: 'Review branch', timestamp: 1710000100000 },
      {
        id: 'a1',
        role: 'assistant' as const,
        content: 'Full hydrated markdown **rendered** answer\n\n'.repeat(80),
        timestamp: 1710000101000,
      },
    ]
    let resolveDetail: (value: any) => void = () => {}
    const pendingDetail = new Promise(resolve => {
      resolveDetail = resolve
    })

    mockConversationsApi.fetchConversationDetail.mockResolvedValue({
      session_id: rootId,
      messages: [],
      visible_count: 0,
      thread_session_count: 1,
      branch_session_count: 1,
      branches: [{
        session_id: branchId,
        parent_session_id: rootId,
        source: 'tui',
        model: 'gpt-5.5',
        title: 'Review branch',
        started_at: 1710000100,
        ended_at: 1710000102,
        last_active: 1710000102,
        is_active: false,
        visible_count: 2,
        thread_session_count: 1,
        messages: [
          { id: 1, session_id: branchId, role: 'user', content: 'Review branch', timestamp: 1710000100 },
          { id: 2, session_id: branchId, role: 'assistant', content: 'Summary only', timestamp: 1710000101 },
        ],
        branches: [],
      }],
    })
    mockSessionsApi.fetchSession.mockReturnValue(pendingDetail)

    const store = useChatStore()
    const branchSession = {
      id: branchId,
      title: 'Review branch',
      source: 'tui',
      messages: fullMessages,
      createdAt: 1710000100000,
      updatedAt: 1710000101000,
      parentSessionId: rootId,
      rootSessionId: rootId,
      isBranchSession: true,
    }
    store.sessions = [
      {
        id: rootId,
        title: 'Root',
        source: 'tui',
        messages: [],
        createdAt: 1710000000000,
        updatedAt: 1710000102000,
        branchSessionCount: 1,
      },
      branchSession,
    ]
    store.activeSessionId = branchId
    store.activeSession = branchSession

    const messagesRef = store.messages
    const assistantRef = store.messages[1]
    const refresh = store.refreshSessionBranches(rootId)
    await flushPromises()

    expect(store.messages).toBe(messagesRef)
    expect(store.messages[1]).toBe(assistantRef)
    expect(store.messages[1].content).toContain('Full hydrated markdown')
    expect(store.messages[1].content).not.toBe('Summary only')

    resolveDetail(makeDetail(branchId, [
      { id: 1, session_id: branchId, role: 'user', content: 'Review branch', timestamp: 1710000100 },
      { id: 2, session_id: branchId, role: 'assistant', content: fullMessages[1].content, timestamp: 1710000101 },
    ]))
    await refresh
  })

  it('keeps lineage branch messages when session detail resolves to continuation root content', async () => {
    const rootId = '20260502_135857_2f594e'
    const historyId = '20260502_120953_713358'

    mockConversationsApi.fetchConversationDetail.mockResolvedValue({
      session_id: rootId,
      messages: [
        { id: 10, session_id: rootId, role: 'user', content: 'Continue after compression', timestamp: 1710000200 },
        { id: 11, session_id: rootId, role: 'assistant', content: 'Continuation answer', timestamp: 1710000201 },
      ],
      visible_count: 2,
      thread_session_count: 1,
      branch_session_count: 1,
      branches: [{
        session_id: historyId,
        parent_session_id: rootId,
        source: 'tui',
        model: 'gpt-5.5',
        title: 'Compressed history',
        started_at: 1710000100,
        ended_at: 1710000102,
        last_active: 1710000102,
        is_active: false,
        visible_count: 2,
        thread_session_count: 1,
        messages: [
          { id: 1, session_id: historyId, role: 'user', content: 'Original question before compression', timestamp: 1710000100 },
          { id: 2, session_id: historyId, role: 'assistant', content: 'Original answer before compression', timestamp: 1710000101 },
        ],
        branches: [],
      }],
    })
    mockSessionsApi.fetchSession.mockResolvedValue(makeDetail(rootId, [
      { id: 10, session_id: rootId, role: 'user', content: 'Continue after compression', timestamp: 1710000200 },
      { id: 11, session_id: rootId, role: 'assistant', content: 'Continuation answer', timestamp: 1710000201 },
    ]))

    const store = useChatStore()
    store.sessions = [{
      id: rootId,
      title: 'Continuation',
      source: 'tui',
      messages: [],
      createdAt: 1710000200000,
      updatedAt: 1710000201000,
      branchSessionCount: 1,
    }]
    store.activeSessionId = rootId
    store.activeSession = store.sessions[0]

    await store.refreshSessionBranches(rootId)
    await store.switchBranchSession(rootId, historyId)

    expect(store.activeSessionId).toBe(historyId)
    expect(store.messages.map(message => message.content)).toEqual([
      'Original question before compression',
      'Original answer before compression',
    ])
  })

  it('refreshes continuation summaries after a bridge run settles', async () => {
    let onEvent: ((event: Record<string, any>) => void) | null = null
    const localId = 'local-continuation'
    const persistentId = '20260502_135857_2f594e'
    const historyId = '20260502_120953_713358'

    mockChatApi.startRun.mockResolvedValue({
      run_id: 'bridge_run_settled',
      status: 'queued',
      bridge: true,
      session_id: persistentId,
      context_handoff: true,
      context_message_count: 12,
      context_token_count: 42000,
    })
    mockChatApi.streamRunEvents.mockImplementation((
      _runId: string,
      eventHandler: (event: Record<string, any>) => void,
    ) => {
      onEvent = eventHandler
      return { abort: vi.fn() }
    })
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      { ...makeSummary(persistentId, 'Continuation'), source: 'tui', branch_session_count: 1 },
    ])
    mockConversationsApi.fetchConversationDetail.mockResolvedValue({
      session_id: persistentId,
      messages: [
        { id: 10, session_id: persistentId, role: 'user', content: 'Continue', timestamp: 1710000200 },
        { id: 11, session_id: persistentId, role: 'assistant', content: 'Done', timestamp: 1710000201 },
      ],
      visible_count: 2,
      thread_session_count: 1,
      branch_session_count: 1,
      branches: [{
        session_id: historyId,
        parent_session_id: persistentId,
        source: 'tui',
        model: 'gpt-5.5',
        title: 'Compressed history',
        started_at: 1710000100,
        ended_at: 1710000102,
        last_active: 1710000102,
        is_active: false,
        visible_count: 2,
        thread_session_count: 1,
        messages: [
          { id: 1, session_id: historyId, role: 'user', content: 'Before compression', timestamp: 1710000100 },
          { id: 2, session_id: historyId, role: 'assistant', content: 'History answer', timestamp: 1710000101 },
        ],
        branches: [],
      }],
    })
    mockSessionsApi.fetchSession.mockResolvedValue(makeDetail(persistentId, [
      { id: 10, session_id: persistentId, role: 'user', content: 'Continue', timestamp: 1710000200 },
      { id: 11, session_id: persistentId, role: 'assistant', content: 'Done', timestamp: 1710000201 },
    ]))

    const store = useChatStore()
    store.sessions = [{
      id: localId,
      title: 'Local continuation',
      source: 'tui',
      messages: [],
      createdAt: 1710000000000,
      updatedAt: 1710000000000,
    }]
    store.activeSessionId = localId
    store.activeSession = store.sessions[0]

    await store.sendMessage('Continue')
    onEvent?.({ event: 'message.delta', delta: 'Done' })
    onEvent?.({ event: 'run.completed', content: 'Done' })
    await flushPromises()
    await flushPromises()

    expect(store.activeSessionId).toBe(persistentId)
    expect(store.sessionBranchCount(persistentId)).toBe(1)
    expect(store.sessionBranches(persistentId).map(branch => branch.session_id)).toEqual([historyId])
  })

  it('merges a live subagent branch into its persisted tui branch when the live title has a Subagent prefix', async () => {
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

    onEvent?.({
      event: 'subagent.start',
      subagent_id: 'subagent-prefixed',
      parent_id: rootId,
      goal: 'Review branch',
      text: 'Starting review',
      depth: 1,
    })
    await flushPromises()

    // Simulate a live branch title carrying the historical "Subagent L1:" prefix.
    const liveBranch = store.sessionBranches(rootId).find(branch => branch.session_id === 'subagent-prefixed')
    if (liveBranch) liveBranch.title = 'Subagent L1: Review branch'

    onEvent?.({
      event: 'subagent.progress',
      subagent_id: 'subagent-prefixed',
      parent_id: rootId,
      goal: 'Review branch',
      text: 'Inspecting files',
      depth: 1,
    })
    await flushPromises()

    expect(store.sessionBranches(rootId).map(branch => branch.session_id)).toEqual(['tui-branch-1'])
  })

  it('merges a live subagent branch into a persisted tui branch that has no title or visible messages yet', async () => {
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
    const startedAt = Date.now() / 1000

    mockConversationsApi.fetchConversationDetail.mockResolvedValue({
      session_id: rootId,
      messages: [],
      visible_count: 0,
      thread_session_count: 1,
      branch_session_count: 1,
      branches: [{
        session_id: 'tui-branch-empty',
        parent_session_id: rootId,
        source: 'tui',
        model: 'gpt-5.5',
        title: null,
        started_at: startedAt,
        ended_at: null,
        last_active: startedAt + 2,
        is_active: true,
        visible_count: 0,
        thread_session_count: 1,
        messages: [],
        branches: [],
      }],
    })

    onEvent?.({
      event: 'subagent.start',
      subagent_id: 'subagent-empty-persisted',
      parent_id: rootId,
      goal: 'Review branch',
      text: 'Starting review',
      depth: 1,
    })
    await flushPromises()

    expect(store.sessionBranches(rootId).map(branch => branch.session_id)).toEqual(['tui-branch-empty'])
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

  it('does not restore cached subagent sessions on reload', async () => {
    window.localStorage.setItem(
      SESSIONS_CACHE_KEY,
      JSON.stringify([
        {
          id: 'root',
          title: 'Root',
          source: 'tui',
          messages: [],
          createdAt: 1,
          updatedAt: 1,
          branchSessionCount: 1,
        },
        {
          id: 'subagent-ghost',
          title: 'Subagent L1: Review branch',
          source: 'subagent',
          messages: [],
          createdAt: 2,
          updatedAt: 2,
          isBranchSession: true,
          parentSessionId: 'root',
          rootSessionId: 'root',
        },
      ]),
    )
    mockConversationsApi.fetchConversationSummaries.mockResolvedValue([
      { ...makeSummary('root', 'Root'), source: 'tui', branch_session_count: 1 },
    ])
    mockConversationsApi.fetchConversationDetail.mockResolvedValue({
      session_id: 'root',
      messages: [],
      visible_count: 0,
      thread_session_count: 1,
      branch_session_count: 1,
      branches: [],
    })
    mockSessionsApi.fetchSession.mockResolvedValue(makeDetail('root', []))

    const store = useChatStore()
    await store.loadSessions()

    expect(store.sessions.some(session => session.id === 'subagent-ghost')).toBe(false)
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
