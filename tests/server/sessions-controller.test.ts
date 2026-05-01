import { beforeEach, describe, expect, it, vi } from 'vitest'

const listConversationSummariesFromDbMock = vi.fn()
const getConversationDetailFromDbMock = vi.fn()
const listConversationSummariesMock = vi.fn()
const getConversationDetailMock = vi.fn()
const getSessionDetailFromDbMock = vi.fn()
const getUsageStatsFromDbMock = vi.fn()
const getSessionMock = vi.fn()
const getGroupChatServerMock = vi.fn()
const getLocalUsageStatsMock = vi.fn()
const getActiveProfileNameMock = vi.fn()
const loggerWarnMock = vi.fn()
const useLocalSessionStoreMock = vi.fn(() => false)
const localGetSessionDetailMock = vi.fn()

vi.mock('../../packages/server/src/db/hermes/conversations-db', () => ({
  listConversationSummariesFromDb: listConversationSummariesFromDbMock,
  getConversationDetailFromDb: getConversationDetailFromDbMock,
}))

vi.mock('../../packages/server/src/services/hermes/conversations', () => ({
  listConversationSummaries: listConversationSummariesMock,
  getConversationDetail: getConversationDetailMock,
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: {
    warn: loggerWarnMock,
    error: vi.fn(),
  },
}))

vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({
  listSessions: vi.fn(),
  getSession: getSessionMock,
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
}))

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  listSessionSummaries: vi.fn(),
  searchSessionSummaries: vi.fn(),
  getSessionDetailFromDb: getSessionDetailFromDbMock,
  getUsageStatsFromDb: getUsageStatsFromDbMock,
}))

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  useLocalSessionStore: useLocalSessionStoreMock,
  getSessionDetail: localGetSessionDetailMock,
  listSessions: vi.fn(),
  searchSessions: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
}))

vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({
  deleteUsage: vi.fn(),
  getUsage: vi.fn(),
  getUsageBatch: vi.fn(),
  getLocalUsageStats: getLocalUsageStatsMock,
}))

vi.mock('../../packages/server/src/routes/hermes/group-chat', () => ({
  getGroupChatServer: getGroupChatServerMock,
}))

vi.mock('../../packages/server/src/services/hermes/model-context', () => ({
  getModelContextLength: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveConfigPath: vi.fn(() => '/tmp/hermes-web-ui-test-missing-config.yml'),
  getActiveProfileName: getActiveProfileNameMock,
}))

describe('session conversations controller', () => {
  beforeEach(() => {
    vi.resetModules()
    listConversationSummariesFromDbMock.mockReset()
    getConversationDetailFromDbMock.mockReset()
    listConversationSummariesMock.mockReset()
    getConversationDetailMock.mockReset()
    getSessionDetailFromDbMock.mockReset()
    getUsageStatsFromDbMock.mockReset()
    getSessionMock.mockReset()
    getGroupChatServerMock.mockReset()
    getGroupChatServerMock.mockReturnValue(null)
    getLocalUsageStatsMock.mockReset()
    getActiveProfileNameMock.mockReset()
    getActiveProfileNameMock.mockReturnValue('default')
    loggerWarnMock.mockReset()
    useLocalSessionStoreMock.mockReset()
    useLocalSessionStoreMock.mockReturnValue(false)
    localGetSessionDetailMock.mockReset()
    delete process.env.HERMES_WEBUI_BRIDGE
  })

  it('prefers the DB-backed conversations summary path', async () => {
    listConversationSummariesFromDbMock.mockResolvedValue([{ id: 'db-conversation' }])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { humanOnly: 'true', limit: '5' }, body: null }
    await mod.listConversations(ctx)

    expect(listConversationSummariesFromDbMock).toHaveBeenCalledWith({ source: undefined, humanOnly: true, limit: 5 })
    expect(listConversationSummariesMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ sessions: [{ id: 'db-conversation' }] })
  })

  it('still uses DB-backed conversations summary when local session store mode is enabled', async () => {
    useLocalSessionStoreMock.mockReturnValue(true)
    listConversationSummariesFromDbMock.mockResolvedValue([{ id: 'db-conversation-local-mode' }])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { humanOnly: 'true' }, body: null }
    await mod.listConversations(ctx)

    expect(listConversationSummariesFromDbMock).toHaveBeenCalledWith({ source: undefined, humanOnly: true, limit: undefined })
    expect(ctx.body).toEqual({ sessions: [{ id: 'db-conversation-local-mode' }] })
  })

  it('falls back to the CLI-export conversations summary path when the DB query fails', async () => {
    listConversationSummariesFromDbMock.mockRejectedValue(new Error('db unavailable'))
    listConversationSummariesMock.mockResolvedValue([{ id: 'fallback-conversation' }])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { humanOnly: 'false' }, body: null }
    await mod.listConversations(ctx)

    expect(loggerWarnMock).toHaveBeenCalled()
    expect(listConversationSummariesMock).toHaveBeenCalledWith({ source: undefined, humanOnly: false, limit: undefined })
    expect(ctx.body).toEqual({ sessions: [{ id: 'fallback-conversation' }] })
  })

  it('prefers the DB-backed conversation detail path', async () => {
    getConversationDetailFromDbMock.mockResolvedValue({ session_id: 'root', messages: [], visible_count: 0, thread_session_count: 1 })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'root' }, query: { humanOnly: 'true' }, body: null }
    await mod.getConversationMessages(ctx)

    expect(getConversationDetailFromDbMock).toHaveBeenCalledWith('root', { source: undefined, humanOnly: true })
    expect(getConversationDetailMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ session_id: 'root', messages: [], visible_count: 0, thread_session_count: 1 })
  })

  it('still uses DB-backed conversation detail when local session store mode is enabled', async () => {
    useLocalSessionStoreMock.mockReturnValue(true)
    getConversationDetailFromDbMock.mockResolvedValue({ session_id: 'root-local-mode', messages: [], visible_count: 0, thread_session_count: 1 })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'root-local-mode' }, query: { humanOnly: 'true' }, body: null }
    await mod.getConversationMessages(ctx)

    expect(getConversationDetailFromDbMock).toHaveBeenCalledWith('root-local-mode', { source: undefined, humanOnly: true })
    expect(ctx.body).toEqual({ session_id: 'root-local-mode', messages: [], visible_count: 0, thread_session_count: 1 })
  })

  it('falls back to the CLI-export conversation detail path when the DB query throws', async () => {
    getConversationDetailFromDbMock.mockRejectedValue(new Error('db unavailable'))
    getConversationDetailMock.mockResolvedValue({ session_id: 'root', messages: [{ id: 1 }], visible_count: 1, thread_session_count: 1 })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'root' }, query: { humanOnly: 'false' }, body: null }
    await mod.getConversationMessages(ctx)

    expect(loggerWarnMock).toHaveBeenCalled()
    expect(getConversationDetailMock).toHaveBeenCalledWith('root', { source: undefined, humanOnly: false })
    expect(ctx.body).toEqual({ session_id: 'root', messages: [{ id: 1 }], visible_count: 1, thread_session_count: 1 })
  })

  it('returns an empty bridge conversation detail for local bridge sessions', async () => {
    process.env.HERMES_WEBUI_BRIDGE = 'true'
    getConversationDetailFromDbMock.mockResolvedValue(null)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'local-bridge-session' }, query: {}, body: null }
    await mod.getConversationMessages(ctx)

    expect(ctx.status).toBeUndefined()
    expect(ctx.body).toEqual({
      session_id: 'local-bridge-session',
      messages: [],
      visible_count: 0,
      thread_session_count: 1,
      branch_session_count: 0,
      branches: [],
    })
    expect(getConversationDetailMock).not.toHaveBeenCalled()
  })

  it('merges native state.db usage analytics with local Web UI usage for the requested period', async () => {
    const today = new Date().toISOString().slice(0, 10)
    getLocalUsageStatsMock.mockReturnValue({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 2,
      cache_write_tokens: 1,
      reasoning_tokens: 3,
      sessions: 1,
      by_model: [
        { model: 'local-model', input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_write_tokens: 1, reasoning_tokens: 3, sessions: 1 },
      ],
      by_day: [
        { date: today, tokens: 15, cache: 2, sessions: 1, cost: 0 },
      ],
    })
    getUsageStatsFromDbMock.mockResolvedValue({
      input_tokens: 20,
      output_tokens: 10,
      cache_read_tokens: 4,
      cache_write_tokens: 2,
      reasoning_tokens: 6,
      sessions: 2,
      cost: 0.02,
      total_api_calls: 7,
      by_model: [
        { model: 'hermes-model', input_tokens: 20, output_tokens: 10, cache_read_tokens: 4, cache_write_tokens: 2, reasoning_tokens: 6, sessions: 2 },
      ],
      by_day: [
        { date: today, tokens: 30, cache: 4, sessions: 2, cost: 0.02 },
      ],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { days: '2' }, body: null }
    await mod.usageStats(ctx)

    expect(getLocalUsageStatsMock).toHaveBeenCalledWith('default', 2)
    expect(getUsageStatsFromDbMock).toHaveBeenCalledWith(2)
    expect(ctx.body).toMatchObject({
      total_input_tokens: 30,
      total_output_tokens: 15,
      total_cache_read_tokens: 6,
      total_cache_write_tokens: 3,
      total_reasoning_tokens: 9,
      total_sessions: 3,
      total_cost: 0.02,
      total_api_calls: 7,
      period_days: 2,
    })
    expect(ctx.body.model_usage).toEqual([
      { model: 'hermes-model', input_tokens: 20, output_tokens: 10, cache_read_tokens: 4, cache_write_tokens: 2, reasoning_tokens: 6, sessions: 2 },
      { model: 'local-model', input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_write_tokens: 1, reasoning_tokens: 3, sessions: 1 },
    ])
    expect(ctx.body.daily_usage.find((row: any) => row.date === today)).toMatchObject({ tokens: 45, cache: 6, sessions: 3, cost: 0.02 })
  })

  it('serves DB-backed session detail before falling back to CLI export', async () => {
    getSessionDetailFromDbMock.mockResolvedValue({
      id: 'compressed-root',
      source: 'cli',
      user_id: null,
      model: 'gpt-5.5',
      title: 'Compressed root',
      started_at: 100,
      ended_at: 120,
      end_reason: 'compression',
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: null,
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      cost_status: '',
      preview: 'hello',
      last_active: 121,
      messages: [
        { id: 1, session_id: 'compressed-root', role: 'user', content: 'hello', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 101, token_count: null, finish_reason: null, reasoning: null },
        { id: 2, session_id: 'compressed-root-cont', role: 'assistant', content: 'world', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 121, token_count: null, finish_reason: null, reasoning: null },
      ],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'compressed-root' }, query: {}, body: null }
    await mod.get(ctx)

    expect(getSessionDetailFromDbMock).toHaveBeenCalledWith('compressed-root')
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(ctx.body.session.messages.map((message: any) => message.content)).toEqual(['hello', 'world'])
  })

  it('falls back to DB-backed session detail when local session store mode is enabled but the session is missing locally', async () => {
    useLocalSessionStoreMock.mockReturnValue(true)
    localGetSessionDetailMock.mockReturnValue(null)
    getSessionDetailFromDbMock.mockResolvedValue({
      id: 'tui-root',
      source: 'tui',
      user_id: null,
      model: 'gpt-5.5',
      title: 'TUI root',
      started_at: 100,
      ended_at: null,
      end_reason: null,
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: null,
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      cost_status: '',
      preview: 'tool run',
      last_active: 121,
      messages: [
        { id: 1, session_id: 'tui-root', role: 'user', content: 'hello', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 101, token_count: null, finish_reason: null, reasoning: null },
        { id: 2, session_id: 'tui-root', role: 'tool', content: '{"output":"ok"}', tool_call_id: 'call-1', tool_calls: null, tool_name: 'terminal', timestamp: 121, token_count: null, finish_reason: null, reasoning: null },
      ],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'tui-root' }, query: {}, body: null }
    await mod.get(ctx)

    expect(localGetSessionDetailMock).toHaveBeenCalledWith('tui-root')
    expect(getSessionDetailFromDbMock).toHaveBeenCalledWith('tui-root')
    expect(ctx.body.session.source).toBe('tui')
    expect(ctx.body.session.messages).toHaveLength(2)
  })

  it('falls back to CLI session detail when the DB detail path is unavailable', async () => {
    getSessionDetailFromDbMock.mockRejectedValue(new Error('db unavailable'))
    getSessionMock.mockResolvedValue({ id: 'legacy', messages: [{ id: 1, content: 'from cli' }] })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'legacy' }, query: {}, body: null }
    await mod.get(ctx)

    expect(loggerWarnMock).toHaveBeenCalled()
    expect(getSessionMock).toHaveBeenCalledWith('legacy')
    expect(ctx.body).toEqual({ session: { id: 'legacy', messages: [{ id: 1, content: 'from cli' }] } })
  })

  it('hides DB-backed session detail when a continuation child is pending deletion', async () => {
    getGroupChatServerMock.mockReturnValue({
      getStorage: () => ({
        getPendingDeletedSessionIds: () => new Set(['compressed-root-cont']),
      }),
    })
    getSessionDetailFromDbMock.mockResolvedValue({
      id: 'compressed-root',
      messages: [
        { id: 1, session_id: 'compressed-root', role: 'user', content: 'hello', timestamp: 101 },
        { id: 2, session_id: 'compressed-root-cont', role: 'assistant', content: 'hidden', timestamp: 121 },
      ],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'compressed-root' }, query: {}, body: null }
    await mod.get(ctx)

    expect(getSessionDetailFromDbMock).toHaveBeenCalledWith('compressed-root')
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(ctx.status).toBe(404)
    expect(ctx.body).toEqual({ error: 'Session not found' })
  })
})
