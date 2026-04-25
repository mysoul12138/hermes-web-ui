// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mockChatApi = vi.hoisted(() => ({
  startRun: vi.fn(),
  streamRunEvents: vi.fn(),
}))

const mockSessionsApi = vi.hoisted(() => ({
  fetchSessions: vi.fn(),
  fetchSession: vi.fn(),
  fetchSessionUsageSingle: vi.fn(),
  deleteSession: vi.fn(),
}))

const mockApprovalApi = vi.hoisted(() => ({
  getPendingApproval: vi.fn(),
  respondApproval: vi.fn(),
}))

vi.mock('@/api/hermes/chat', () => mockChatApi)
vi.mock('@/api/hermes/sessions', () => mockSessionsApi)
vi.mock('@/api/hermes/approval', () => mockApprovalApi)

import { useChatStore } from '@/stores/hermes/chat'

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('Chat Store approvals', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.useRealTimers()
    localStorage.clear()
    mockChatApi.startRun.mockResolvedValue({ run_id: 'run-1', status: 'queued' })
    mockSessionsApi.fetchSessions.mockResolvedValue([])
    mockSessionsApi.fetchSession.mockResolvedValue(null)
    mockSessionsApi.fetchSessionUsageSingle.mockResolvedValue(null)
    mockSessionsApi.deleteSession.mockResolvedValue(true)
    mockApprovalApi.getPendingApproval.mockResolvedValue({ pending: null, pending_count: 0 })
    mockApprovalApi.respondApproval.mockResolvedValue({ ok: true, choice: 'once' })
  })

  it('tracks the active approval and responds with approval_id', async () => {
    let onEvent!: (event: any) => void
    mockChatApi.streamRunEvents.mockImplementation((_runId: string, cb: (event: any) => void) => {
      onEvent = cb
      return { abort: vi.fn() }
    })

    const store = useChatStore()
    await store.sendMessage('please run the dangerous command')

    onEvent({
      event: 'approval',
      approval_id: 'approval-1',
      description: 'Need permission',
      command: 'rm -rf /tmp/demo',
      pending_count: 2,
    })
    await flushPromises()

    expect(store.activeApproval?.pending.approval_id).toBe('approval-1')
    expect(store.activeApproval?.pendingCount).toBe(2)

    await store.respondApproval('once')

    expect(mockApprovalApi.respondApproval).toHaveBeenCalledWith({
      session_id: store.activeSessionId,
      choice: 'once',
      approval_id: 'approval-1',
    })
  })

  it('keeps approval state isolated per session', async () => {
    let onEvent!: (event: any) => void
    mockChatApi.streamRunEvents.mockImplementation((_runId: string, cb: (event: any) => void) => {
      onEvent = cb
      return { abort: vi.fn() }
    })

    const store = useChatStore()
    store.newChat()
    const sid1 = store.activeSessionId!
    store.newChat()
    const sid2 = store.activeSessionId!

    await store.switchSession(sid1)
    await store.sendMessage('first session')

    onEvent({ event: 'approval', approval_id: 'approval-1', description: 'first' })
    await flushPromises()

    expect(store.activeApproval?.pending.approval_id).toBe('approval-1')

    await store.switchSession(sid2)
    expect(store.activeApproval).toBeNull()

    await store.switchSession(sid1)
    expect(store.activeApproval?.pending.approval_id).toBe('approval-1')
  })

  it('hydrates approval state from session messages when the session is still blocked on approval', async () => {
    const store = useChatStore()
    store.newChat()
    const sid = store.activeSessionId!

    mockApprovalApi.getPendingApproval.mockResolvedValue({
      pending: {
        approval_id: 'approval-1',
        command: 'bash -lc "printf approval_replay"',
        description: 'shell command via -c/-lc flag',
        pattern_key: 'shell command via -c/-lc flag',
      },
      pending_count: 1,
    })

    mockSessionsApi.fetchSession.mockResolvedValue({
      id: sid,
      source: 'api_server',
      model: 'gpt-5.4',
      title: 'approval replay',
      started_at: 1776925868,
      ended_at: null,
      last_active: 1776925894,
      message_count: 4,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'custom',
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      cost_status: 'unknown',
      messages: [
        {
          id: 1,
          session_id: sid,
          role: 'user',
          content: 'run dangerous command',
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          timestamp: 1776925894,
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
              id: 'call_1',
              type: 'function',
              function: {
                name: 'terminal',
                arguments: '{"command":"bash -lc \\\"printf approval_replay\\\"","timeout":180}',
              },
            },
          ],
          tool_name: null,
          timestamp: 1776925894.1,
          token_count: null,
          finish_reason: null,
          reasoning: null,
        },
        {
          id: 3,
          session_id: sid,
          role: 'tool',
          content: JSON.stringify({
            output: '',
            exit_code: -1,
            error: 'approval required',
            status: 'approval_required',
            command: 'bash -lc "printf approval_replay"',
            description: 'shell command via -c/-lc flag',
            pattern_key: 'shell command via -c/-lc flag',
          }),
          tool_call_id: 'call_1',
          tool_calls: null,
          tool_name: null,
          timestamp: 1776925894.2,
          token_count: null,
          finish_reason: null,
          reasoning: null,
        },
        {
          id: 4,
          session_id: sid,
          role: 'assistant',
          content: 'blocked：terminal 工具返回了 approval_required',
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          timestamp: 1776925894.3,
          token_count: null,
          finish_reason: null,
          reasoning: null,
        },
      ],
    })

    await store.switchSession(sid)

    expect(store.activeApproval?.pending.command).toBe('bash -lc "printf approval_replay"')
    expect(store.activeApproval?.pending.description).toBe('shell command via -c/-lc flag')
    expect(store.activeApproval?.pending.pattern_key).toBe('shell command via -c/-lc flag')
    expect(store.activeApproval?.pendingCount).toBe(1)
  })

  it('does not resurrect the same approval immediately after a successful response', async () => {
    const store = useChatStore()
    store.newChat()
    const sid = store.activeSessionId!

    mockApprovalApi.getPendingApproval.mockResolvedValue({
      pending: {
        approval_id: 'approval-1',
        description: 'Need approval',
        command: 'rm -rf /tmp/demo',
      },
      pending_count: 1,
    })

    mockSessionsApi.fetchSession.mockResolvedValue({
      id: sid,
      source: 'api_server',
      model: 'gpt-5.4',
      title: 'approval replay',
      started_at: 1776925868,
      ended_at: null,
      last_active: 1776925894,
      message_count: 4,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'custom',
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      cost_status: 'unknown',
      messages: [
        {
          id: 1,
          session_id: sid,
          role: 'user',
          content: 'run dangerous command',
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          timestamp: 1776925894,
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
              id: 'call_1',
              type: 'function',
              function: {
                name: 'terminal',
                arguments: '{"command":"rm -rf /tmp/demo","timeout":180}',
              },
            },
          ],
          tool_name: null,
          timestamp: 1776925894.1,
          token_count: null,
          finish_reason: null,
          reasoning: null,
        },
        {
          id: 3,
          session_id: sid,
          role: 'tool',
          content: JSON.stringify({
            output: '',
            exit_code: -1,
            error: 'approval required',
            status: 'approval_required',
            command: 'rm -rf /tmp/demo',
            description: 'Need approval',
            approval_id: 'approval-1',
          }),
          tool_call_id: 'call_1',
          tool_calls: null,
          tool_name: null,
          timestamp: 1776925894.2,
          token_count: null,
          finish_reason: null,
          reasoning: null,
        },
      ],
    })

    await store.switchSession(sid)
    expect(store.activeApproval?.pending.approval_id).toBe('approval-1')

    await store.respondApproval('once')

    expect(mockApprovalApi.respondApproval).toHaveBeenCalledWith({
      session_id: sid,
      choice: 'once',
      approval_id: 'approval-1',
    })
    expect(store.activeApproval).toBeNull()
  })

  it('stops approval polling after the run completes', async () => {
    vi.useFakeTimers()

    let onEvent!: (event: any) => void
    mockChatApi.streamRunEvents.mockImplementation((_runId: string, cb: (event: any) => void) => {
      onEvent = cb
      return { abort: vi.fn() }
    })

    const store = useChatStore()
    await store.sendMessage('dangerous command')

    onEvent({ event: 'approval', approval_id: 'approval-1', description: 'Need approval' })
    await vi.advanceTimersByTimeAsync(1600)
    expect(mockApprovalApi.getPendingApproval).toHaveBeenCalledTimes(2)

    onEvent({ event: 'run.completed' })
    await vi.advanceTimersByTimeAsync(3200)
    expect(mockApprovalApi.getPendingApproval).toHaveBeenCalledTimes(2)
    expect(store.activeApproval).toBeNull()
  })

  it('continues streaming the resumed run after approval response returns a new run_id', async () => {
    let firstRunOnEvent!: (event: any) => void
    let resumedRunOnEvent!: (event: any) => void

    mockChatApi.streamRunEvents
      .mockImplementationOnce((_runId: string, cb: (event: any) => void) => {
        firstRunOnEvent = cb
        return { abort: vi.fn() }
      })
      .mockImplementationOnce((_runId: string, cb: (event: any) => void) => {
        resumedRunOnEvent = cb
        return { abort: vi.fn() }
      })

    mockApprovalApi.respondApproval.mockResolvedValue({
      ok: true,
      choice: 'once',
      run_id: 'run-2',
      status: 'queued',
    })

    const store = useChatStore()
    await store.sendMessage('dangerous command')

    firstRunOnEvent({
      event: 'approval',
      approval_id: 'approval-1',
      description: 'Need approval',
      command: 'rm -rf /tmp/demo',
    })
    await flushPromises()

    await store.respondApproval('once')

    expect(mockChatApi.streamRunEvents).toHaveBeenCalledTimes(2)
    expect(mockChatApi.streamRunEvents).toHaveBeenLastCalledWith(
      'run-2',
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    )

    resumedRunOnEvent({ event: 'message.delta', delta: 'approved output' })
    resumedRunOnEvent({ event: 'run.completed' })
    await flushPromises()

    expect(store.messages.at(-1)?.role).toBe('assistant')
    expect(store.messages.at(-1)?.content).toContain('approved output')
  })

  it('does not send slash approval commands for optimistic terminal prompts', async () => {
    vi.useFakeTimers()

    let onEvent!: (event: any) => void
    mockChatApi.streamRunEvents.mockImplementation((_runId: string, cb: (event: any) => void) => {
      onEvent = cb
      return { abort: vi.fn() }
    })

    const store = useChatStore()
    await store.sendMessage('please run terminal')

    onEvent({
      event: 'tool.started',
      tool: 'terminal',
      preview: 'terminal bash -lc "printf approval_map_variant"',
    })
    await vi.advanceTimersByTimeAsync(1300)

    expect(store.activeApproval?.pending._optimistic).toBe(true)

    await store.respondApproval('once')

    expect(mockApprovalApi.respondApproval).not.toHaveBeenCalled()
    expect(store.activeApproval).toBeNull()
  })

  it('does not show stale approval cards after refresh when the approval endpoint reports no pending approval', async () => {
    const store = useChatStore()
    store.newChat()
    const sid = store.activeSessionId!

    const staleDetail = {
      id: sid,
      source: 'api_server',
      model: 'gpt-5.4',
      title: 'approval replay',
      started_at: 1776925868,
      ended_at: null,
      last_active: 1776925895,
      message_count: 3,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'custom',
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      cost_status: 'unknown',
      messages: [
        {
          id: 1,
          session_id: sid,
          role: 'user',
          content: 'run dangerous command',
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          timestamp: 1776925894,
          token_count: null,
          finish_reason: null,
          reasoning: null,
        },
        {
          id: 2,
          session_id: sid,
          role: 'tool',
          content: JSON.stringify({
            status: 'approval_required',
            command: 'rm -rf /tmp/demo',
            description: 'Need approval',
            approval_id: 'approval-1',
          }),
          tool_call_id: 'call_1',
          tool_calls: null,
          tool_name: 'terminal',
          timestamp: 1776925894.2,
          token_count: null,
          finish_reason: null,
          reasoning: null,
        },
        {
          id: 3,
          session_id: sid,
          role: 'assistant',
          content: 'done after approval',
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          timestamp: 1776925895,
          token_count: null,
          finish_reason: null,
          reasoning: null,
        },
      ],
    }

    mockSessionsApi.fetchSession.mockResolvedValue(staleDetail)
    mockApprovalApi.getPendingApproval.mockResolvedValue({ pending: null, pending_count: 0 })

    await store.switchSession(sid)
    expect(store.activeApproval).toBeNull()

    await store.refreshActiveSession()

    expect(store.activeApproval).toBeNull()
  })
})
