import { beforeEach, describe, expect, it, vi } from 'vitest'

const listConversationSummariesFromDbMock = vi.fn()
const getConversationDetailFromDbMock = vi.fn()
const listConversationSummariesMock = vi.fn()
const getConversationDetailMock = vi.fn()
const getSessionDetailFromDbMock = vi.fn()
const listSessionSummariesMock = vi.fn()
const getUsageStatsFromDbMock = vi.fn()
const getSessionMock = vi.fn()
const deleteSessionMock = vi.fn()
const localSearchSessionsMock = vi.fn()
const getGroupChatServerMock = vi.fn()
const getLocalUsageStatsMock = vi.fn()
const getActiveProfileNameMock = vi.fn()
const loggerWarnMock = vi.fn()
const loggerInfoMock = vi.fn()
const getCompressionSnapshotMock = vi.fn()
const getPersistentSessionIdMock = vi.fn()
const localDeleteSessionMock = vi.fn()
const useLocalSessionStoreState = vi.hoisted(() => ({ value: false }))

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
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: vi.fn(),
  },
}))

vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({
  listSessions: vi.fn(),
  getSession: getSessionMock,
  deleteSession: deleteSessionMock,
  renameSession: vi.fn(),
}))

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  listSessionSummaries: listSessionSummariesMock,
  searchSessionSummaries: vi.fn(),
  getSessionDetailFromDb: getSessionDetailFromDbMock,
  getUsageStatsFromDb: getUsageStatsFromDbMock,
}))

// Mock useLocalSessionStore toggleable per-test
vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  useLocalSessionStore: () => useLocalSessionStoreState.value,
  deleteSession: localDeleteSessionMock,
  searchSessions: localSearchSessionsMock,
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
  getActiveProfileName: getActiveProfileNameMock,
}))

vi.mock('../../packages/server/src/db/hermes/compression-snapshot', () => ({
  getCompressionSnapshot: getCompressionSnapshotMock,
}))

vi.mock('../../packages/server/src/lib/context-compressor/export-compressor', () => ({
  ExportCompressor: class {
    async compress(messages: any[]) {
      return {
        messages,
        meta: { totalMessages: messages.length, compressed: true, llmCompressed: true, summaryTokenEstimate: 100, verbatimCount: 0, compressedStartIndex: -1 },
      }
    }
  },
}))

vi.mock('../../packages/server/src/services/gateway-bootstrap', () => ({
  getGatewayManagerInstance: () => null,
}))

vi.mock('../../packages/server/src/services/hermes/tui-bridge', () => ({
  tuiBridge: {
    getPersistentSessionId: getPersistentSessionIdMock,
  },
}))

describe('session conversations controller', () => {
  beforeEach(() => {
    vi.resetModules()
    listConversationSummariesFromDbMock.mockReset()
    getConversationDetailFromDbMock.mockReset()
    listConversationSummariesMock.mockReset()
    getConversationDetailMock.mockReset()
    getSessionDetailFromDbMock.mockReset()
    listSessionSummariesMock.mockReset()
    getUsageStatsFromDbMock.mockReset()
    localSearchSessionsMock.mockReset()
    getSessionMock.mockReset()
    deleteSessionMock.mockReset()
    localDeleteSessionMock.mockReset()
    useLocalSessionStoreState.value = false
    getGroupChatServerMock.mockReset()
    getGroupChatServerMock.mockReturnValue(null)
    getLocalUsageStatsMock.mockReset()
    getActiveProfileNameMock.mockReset()
    getActiveProfileNameMock.mockReturnValue('default')
    loggerWarnMock.mockReset()
    loggerInfoMock.mockReset()
    getCompressionSnapshotMock.mockReset()
    getPersistentSessionIdMock.mockReset()
  })

  it('prefers the DB-backed conversations summary path', async () => {
    listConversationSummariesFromDbMock.mockResolvedValue([{ id: 'db-conversation', represented_session_ids: ['db-conversation', 'history-1'] }])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { humanOnly: 'true', limit: '5' }, body: null }
    await mod.listConversations(ctx)

    expect(listConversationSummariesFromDbMock).toHaveBeenCalledWith({ source: undefined, humanOnly: true, limit: 5 })
    expect(listConversationSummariesMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ sessions: [{ id: 'db-conversation', represented_session_ids: ['db-conversation', 'history-1'] }] })
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

  it('falls back to Hermes deletion when local session-store miss occurs', async () => {
    useLocalSessionStoreState.value = true
    localDeleteSessionMock.mockReturnValue(false)
    deleteSessionMock.mockResolvedValue(true)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'tui-session-1' }, body: null }
    await mod.remove(ctx)

    expect(localDeleteSessionMock).toHaveBeenCalledWith('tui-session-1')
    expect(deleteSessionMock).toHaveBeenCalledWith('tui-session-1')
    expect(ctx.body).toEqual({ ok: true })
  })

  it('falls back to Hermes batch deletion when local session-store misses', async () => {
    useLocalSessionStoreState.value = true
    localDeleteSessionMock.mockReturnValue(false)
    deleteSessionMock.mockResolvedValue(true)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { request: { body: { ids: ['tui-a', 'tui-b'] } }, body: null }
    await mod.batchRemove(ctx)

    expect(localDeleteSessionMock).toHaveBeenCalledTimes(2)
    expect(deleteSessionMock).toHaveBeenCalledTimes(2)
    expect(ctx.body).toMatchObject({ ok: true, deleted: 2, failed: 0 })
  })

  it('returns an empty fallback for wrapper-only TUI detail instead of leaking raw continuation context', async () => {
    getSessionDetailFromDbMock.mockResolvedValue(null)
    getSessionMock.mockResolvedValue({
      id: 'wrapper-only',
      source: 'tui',
      title: 'Wrapper only',
      messages: [
        {
          id: 1,
          session_id: 'wrapper-only',
          role: 'user',
          content: 'Previous conversation context:\nassistant: old work\n\nCurrent user message:\n你好',
          timestamp: 1,
        },
      ],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'wrapper-only' }, body: null }
    await mod.get(ctx)

    expect(getSessionMock).toHaveBeenCalledWith('wrapper-only')
    expect(ctx.status).toBeUndefined()
    expect(ctx.body.session).toMatchObject({
      id: 'wrapper-only',
      source: 'webui-bridge',
      messages: [],
      message_count: 0,
    })
  })

  it('does not replace a DB wrapper-only TUI detail with aggregated root conversation content', async () => {
    getSessionDetailFromDbMock.mockResolvedValue({
      id: 'wrapper-only-db',
      source: 'tui',
      model: 'deepseek-v4-flash',
      title: 'Wrapper only',
      started_at: 1,
      ended_at: 2,
      last_active: 2,
      message_count: 1,
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
      cost_status: '',
      preview: 'Previous conversation context: assistant: old work Current user message: 你好',
      messages: [
        {
          id: 1,
          session_id: 'wrapper-only-db',
          role: 'user',
          content: 'Previous conversation context:\nassistant: old work\n\nCurrent user message:\n你好',
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          timestamp: 1,
          token_count: null,
          finish_reason: null,
          reasoning: null,
        },
      ],
      thread_session_count: 1,
    })
    getConversationDetailFromDbMock.mockResolvedValue({
      session_id: 'root',
      messages: [
        { id: 1, session_id: 'root', role: 'user', content: 'root prompt', timestamp: 1 },
        { id: 2, session_id: 'root', role: 'assistant', content: 'root answer', timestamp: 2 },
      ],
      visible_count: 2,
      thread_session_count: 2,
      branch_session_count: 0,
      branches: [],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'wrapper-only-db' }, body: null }
    await mod.get(ctx)

    expect(getConversationDetailFromDbMock).not.toHaveBeenCalled()
    expect(ctx.body.session).toMatchObject({
      id: 'wrapper-only-db',
      source: 'webui-bridge',
      messages: [],
      message_count: 0,
    })
  })

  it('returns aggregated conversation messages for TUI session detail requests', async () => {
    getSessionDetailFromDbMock.mockResolvedValue({
      id: 'root',
      source: 'tui',
      model: 'deepseek-v4-flash',
      title: 'Root',
      started_at: 1,
      ended_at: null,
      last_active: 2,
      message_count: 1,
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
      cost_status: '',
      preview: 'root prompt',
      messages: [
        {
          id: 1,
          session_id: 'root',
          role: 'user',
          content: 'root prompt',
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          timestamp: 1,
          token_count: null,
          finish_reason: null,
          reasoning: null,
        },
      ],
      thread_session_count: 1,
    })
    getConversationDetailFromDbMock.mockResolvedValue({
      session_id: 'root',
      messages: [
        { id: 1, session_id: 'root', role: 'user', content: 'root prompt', timestamp: 1 },
        { id: 2, session_id: 'continuation', role: 'assistant', content: 'continued answer', timestamp: 2 },
      ],
      visible_count: 2,
      thread_session_count: 2,
      branch_session_count: 0,
      branches: [],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'root' }, body: null }
    await mod.get(ctx)

    expect(getConversationDetailFromDbMock).toHaveBeenCalledWith('root', { source: 'tui', humanOnly: true })
    expect(ctx.body.session.messages.map((message: any) => message.content)).toEqual(['root prompt', 'continued answer'])
    expect(ctx.body.session.message_count).toBe(2)
    expect(ctx.body.session.thread_session_count).toBe(2)
  })

  it('uses the conversation root title when merging TUI session detail', async () => {
    getSessionDetailFromDbMock.mockResolvedValue({
      id: 'child-continuation',
      source: 'tui',
      model: 'deepseek-v4-flash',
      title: 'Child raw title',
      started_at: 10,
      ended_at: null,
      last_active: 20,
      message_count: 1,
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
      cost_status: '',
      preview: 'child preview',
      messages: [
        { id: 10, session_id: 'child-continuation', role: 'assistant', content: 'child-only raw message', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 10, token_count: null, finish_reason: null, reasoning: null },
      ],
      thread_session_count: 1,
    })
    getConversationDetailFromDbMock.mockResolvedValue({
      session_id: 'child-continuation',
      title: 'Stable root title',
      messages: [
        { id: 1, session_id: 'root', role: 'user', content: 'root prompt', timestamp: 1 },
        { id: 2, session_id: 'child-continuation', role: 'assistant', content: 'continued answer', timestamp: 2 },
      ],
      visible_count: 2,
      thread_session_count: 2,
      branch_session_count: 0,
      branches: [],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'child-continuation' }, body: null }
    await mod.get(ctx)

    expect(getConversationDetailFromDbMock).toHaveBeenCalledWith('child-continuation', { source: 'tui', humanOnly: true })
    expect(ctx.body.session.title).toBe('Stable root title')
    expect(ctx.body.session.messages.map((message: any) => message.content)).toEqual(['root prompt', 'continued answer'])
  })

  it('prefers cleaner conversation detail for TUI sessions even when raw DB detail has more messages', async () => {
    getSessionDetailFromDbMock.mockResolvedValue({
      id: 'dirty-root',
      source: 'tui',
      model: 'deepseek-v4-flash',
      title: 'Dirty root',
      started_at: 1,
      ended_at: null,
      last_active: 10,
      message_count: 4,
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
      cost_status: '',
      preview: 'root prompt',
      messages: [
        { id: 1, session_id: 'dirty-root', role: 'user', content: 'root prompt', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 1, token_count: null, finish_reason: null, reasoning: null },
        { id: 2, session_id: 'dirty-root', role: 'assistant', content: 'root answer', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 2, token_count: null, finish_reason: null, reasoning: null },
        { id: 3, session_id: 'unrelated', role: 'user', content: 'unrelated prompt', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 3, token_count: null, finish_reason: null, reasoning: null },
        { id: 4, session_id: 'unrelated', role: 'assistant', content: 'unrelated answer', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 4, token_count: null, finish_reason: null, reasoning: null },
      ],
      thread_session_count: 3,
    })
    getConversationDetailFromDbMock.mockResolvedValue({
      session_id: 'dirty-root',
      messages: [
        { id: 1, session_id: 'dirty-root', role: 'user', content: 'root prompt', timestamp: 1 },
        { id: 2, session_id: 'dirty-root', role: 'assistant', content: 'root answer', timestamp: 2 },
      ],
      visible_count: 2,
      thread_session_count: 1,
      branch_session_count: 0,
      branches: [],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'dirty-root' }, body: null }
    await mod.get(ctx)

    expect(getConversationDetailFromDbMock).toHaveBeenCalledWith('dirty-root', { source: 'tui', humanOnly: true })
    expect(ctx.body.session.messages.map((message: any) => message.session_id)).toEqual(['dirty-root', 'dirty-root'])
    expect(ctx.body.session.messages.map((message: any) => message.content)).not.toContain('unrelated prompt')
    expect(ctx.body.session.message_count).toBe(2)
    expect(ctx.body.session.thread_session_count).toBe(1)
  })

  it('keeps non-TUI session detail on the raw DB path', async () => {
    getSessionDetailFromDbMock.mockResolvedValue({
      id: 'api-session',
      source: 'api_server',
      model: 'gpt-5.4',
      title: 'API',
      started_at: 1,
      ended_at: null,
      last_active: 1,
      message_count: 1,
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
      cost_status: '',
      preview: 'api',
      messages: [],
      thread_session_count: 1,
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'api-session' }, body: null }
    await mod.get(ctx)

    expect(getConversationDetailFromDbMock).not.toHaveBeenCalled()
    expect(ctx.body.session.id).toBe('api-session')
    expect(ctx.body.session.source).toBe('api_server')
  })

  it('uses aggregated child detail when opening an empty compression pivot directly', async () => {
    getSessionDetailFromDbMock.mockResolvedValue({
      id: 'pivot-session',
      source: 'tui',
      model: 'deepseek-v4-flash',
      title: 'Compaction pivot',
      started_at: 1,
      ended_at: 2,
      last_active: 2,
      end_reason: 'compression',
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
      cost_status: '',
      preview: '',
      messages: [],
      thread_session_count: 1,
    })
    getConversationDetailFromDbMock.mockResolvedValue({
      session_id: 'pivot-session',
      title: 'Child conversation',
      messages: [
        { id: 10, session_id: 'pivot-child', role: 'user', content: '继续', timestamp: 3 },
        { id: 11, session_id: 'pivot-child', role: 'assistant', content: 'child answer', timestamp: 4 },
      ],
      visible_count: 2,
      thread_session_count: 2,
      branch_session_count: 0,
      represented_session_ids: ['pivot-session', 'pivot-child'],
      branches: [],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'pivot-session' }, body: null }
    await mod.get(ctx)

    expect(getConversationDetailFromDbMock).toHaveBeenCalledWith('pivot-session', { source: 'tui', humanOnly: true })
    expect(ctx.body.session.id).toBe('pivot-session')
    expect(ctx.body.session.messages.map((message: any) => message.session_id)).toEqual(['pivot-child', 'pivot-child'])
    expect(ctx.body.session.messages.map((message: any) => message.content)).toEqual(['继续', 'child answer'])
    expect(ctx.body.session.message_count).toBe(2)
    expect(ctx.body.session.thread_session_count).toBe(2)
    expect(ctx.body.session.represented_session_ids).toEqual(['pivot-session', 'pivot-child'])
  })

  it('uses aggregated detail for a temp web session mapped to an empty compression pivot', async () => {
    getSessionDetailFromDbMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'pivot-session',
        source: 'tui',
        model: 'deepseek-v4-flash',
        title: 'Compaction pivot',
        started_at: 1,
        ended_at: 2,
        last_active: 2,
        end_reason: 'compression',
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
        cost_status: '',
        preview: '',
        messages: [],
        thread_session_count: 1,
      })
    getPersistentSessionIdMock.mockReturnValue('pivot-session')
    getConversationDetailFromDbMock.mockResolvedValue({
      session_id: 'pivot-session',
      title: 'Child conversation',
      messages: [
        { id: 10, session_id: 'pivot-child', role: 'user', content: '继续', timestamp: 3 },
        { id: 11, session_id: 'pivot-child', role: 'assistant', content: 'child answer', timestamp: 4 },
      ],
      visible_count: 2,
      thread_session_count: 2,
      branch_session_count: 0,
      represented_session_ids: ['pivot-session', 'pivot-child'],
      branches: [],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'web-temp-session' }, body: null }
    await mod.get(ctx)

    expect(getPersistentSessionIdMock).toHaveBeenCalledWith('web-temp-session')
    expect(getConversationDetailFromDbMock).toHaveBeenCalledWith('pivot-session', { source: 'tui', humanOnly: true })
    expect(ctx.body.session.id).toBe('pivot-session')
    expect(ctx.body.session.messages.map((message: any) => message.session_id)).toEqual(['pivot-child', 'pivot-child'])
    expect(ctx.body.session.messages.map((message: any) => message.content)).toEqual(['继续', 'child answer'])
    expect(ctx.body.session.message_count).toBe(2)
    expect(ctx.body.session.thread_session_count).toBe(2)
    expect(ctx.body.session.represented_session_ids).toEqual(['pivot-session', 'pivot-child'])
  })

  it('supplements local session-store search results with tui sessions from state.db', async () => {
    useLocalSessionStoreState.value = true
    getActiveProfileNameMock.mockReturnValue('default')

    localSearchSessionsMock.mockReturnValue([
      {
        id: 'api-hit',
        source: 'api_server',
        model: 'gpt-5.4',
        title: 'API match',
        started_at: 100,
        ended_at: 110,
        last_active: 110,
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'api preview',
        workspace: null,
        snippet: 'api preview',
        matched_message_id: null,
      },
    ] as any)
    listSessionSummariesMock.mockResolvedValue([
      {
        id: 'tui-child',
        source: 'tui',
        model: 'gpt-5.4',
        title: 'TUI match child',
        started_at: 200,
        ended_at: 210,
        last_active: 210,
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: 'tui match preview',
        matched_message_id: null,
        snippet: 'tui preview',
        rank: 0,
      },
    ] as any)
    listConversationSummariesFromDbMock.mockResolvedValue([
      {
        id: 'tui-root',
        source: 'tui',
        model: 'gpt-5.4',
        title: 'TUI match',
        started_at: 190,
        ended_at: 210,
        last_active: 210,
        message_count: 1,
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
        cost_status: '',
        preview: 'tui preview',
        is_active: false,
        thread_session_count: 2,
        branch_session_count: 0,
        represented_session_ids: ['tui-root', 'tui-child'],
      },
    ] as any)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { q: 'match' }, body: null }
    await mod.search(ctx)

    expect(listSessionSummariesMock).toHaveBeenCalledWith('tui', 2000)
    expect(listConversationSummariesFromDbMock).toHaveBeenCalledWith({ source: 'tui', humanOnly: true, limit: 2000 })
    expect(ctx.body.results.map((item: any) => item.id)).toEqual(['tui-root', 'api-hit'])
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
        { date: today, input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_write_tokens: 1, sessions: 1, errors: 0, cost: 0 },
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
        { date: today, input_tokens: 20, output_tokens: 10, cache_read_tokens: 4, cache_write_tokens: 2, sessions: 2, errors: 0, cost: 0.02 },
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
    expect(ctx.body.daily_usage.find((row: any) => row.date === today)).toMatchObject({
      input_tokens: 30,
      output_tokens: 15,
      cache_read_tokens: 6,
      cache_write_tokens: 3,
      sessions: 3,
      cost: 0.02,
    })
  })

  it('keeps blank model usage under an unknown bucket', async () => {
    getLocalUsageStatsMock.mockReturnValue({
      input_tokens: 3,
      output_tokens: 1,
      cache_read_tokens: 2,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      sessions: 1,
      by_model: [
        { model: '', input_tokens: 3, output_tokens: 1, cache_read_tokens: 2, cache_write_tokens: 0, reasoning_tokens: 0, sessions: 1 },
      ],
      by_day: [],
    })
    getUsageStatsFromDbMock.mockResolvedValue({
      input_tokens: 2,
      output_tokens: 1,
      cache_read_tokens: 1,
      cache_write_tokens: 1,
      reasoning_tokens: 0,
      sessions: 1,
      cost: 0,
      total_api_calls: 0,
      by_model: [
        { model: ' ', input_tokens: 2, output_tokens: 1, cache_read_tokens: 1, cache_write_tokens: 1, reasoning_tokens: 0, sessions: 1 },
      ],
      by_day: [],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { days: '2' }, body: null }
    await mod.usageStats(ctx)

    expect(ctx.body.model_usage).toEqual([
      { model: 'unknown', input_tokens: 5, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 1, reasoning_tokens: 0, sessions: 2 },
    ])
  })

  describe('exportSession', () => {
    it('returns session as JSON download with correct headers (full mode)', async () => {
      const sessionData = { id: 'abc-123', title: 'Test Session', messages: [{ id: 1, role: 'user', content: 'hello' }] }
      getSessionDetailFromDbMock.mockResolvedValue(sessionData)

      const mod = await import('../../packages/server/src/controllers/hermes/sessions')
      const setMock = vi.fn()
      const ctx: any = { params: { id: 'abc-123' }, query: {}, set: setMock, body: null }

      await mod.exportSession(ctx)

      expect(getSessionDetailFromDbMock).toHaveBeenCalledWith('abc-123')
      expect(setMock).toHaveBeenCalledWith('Content-Disposition', expect.stringContaining('abc-123'))
      expect(setMock).toHaveBeenCalledWith('Content-Type', 'application/json')
      expect(ctx.status).toBeUndefined()
      expect(JSON.parse(ctx.body)).toMatchObject({ id: 'abc-123', title: 'Test Session' })
    })

    it('returns full TXT export', async () => {
      const sessionData = {
        id: 'txt-123',
        title: 'Text Export',
        messages: [
          { id: 1, role: 'user', content: 'hello', timestamp: 1700000000 },
          { id: 2, role: 'assistant', content: 'hi', timestamp: 1700000001 },
        ],
      }
      getSessionDetailFromDbMock.mockResolvedValue(sessionData)

      const mod = await import('../../packages/server/src/controllers/hermes/sessions')
      const setMock = vi.fn()
      const ctx: any = { params: { id: 'txt-123' }, query: { mode: 'full', ext: 'txt' }, set: setMock, body: null }

      await mod.exportSession(ctx)

      expect(setMock).toHaveBeenCalledWith('Content-Type', 'text/plain; charset=utf-8')
      expect(ctx.body).toContain('# Text Export')
      expect(ctx.body).toContain('[user]')
      expect(ctx.body).toContain('hello')
      expect(ctx.body).toContain('[assistant]')
      expect(ctx.body).toContain('hi')
    })

    it('returns 404 when session not found', async () => {
      getSessionDetailFromDbMock.mockResolvedValue(null)
      getSessionMock.mockResolvedValue(null)

      const mod = await import('../../packages/server/src/controllers/hermes/sessions')
      const ctx: any = { params: { id: 'not-found' }, query: {}, set: vi.fn(), body: null }

      await mod.exportSession(ctx)

      expect(ctx.status).toBe(404)
      expect(ctx.body).toEqual({ error: 'Session not found' })
    })

    it('falls back to CLI when DB query fails', async () => {
      const sessionData = { id: 'cli-123', title: 'CLI Session', messages: [] }
      getSessionDetailFromDbMock.mockRejectedValue(new Error('db unavailable'))
      getSessionMock.mockResolvedValue(sessionData)

      const mod = await import('../../packages/server/src/controllers/hermes/sessions')
      const setMock = vi.fn()
      const ctx: any = { params: { id: 'cli-123' }, query: {}, set: setMock, body: null }

      await mod.exportSession(ctx)

      expect(getSessionMock).toHaveBeenCalledWith('cli-123')
      expect(JSON.parse(ctx.body)).toMatchObject({ id: 'cli-123' })
    })
  })
})
