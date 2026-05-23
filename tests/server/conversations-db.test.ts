import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const profileDirState = vi.hoisted(() => ({ value: '' }))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileDir: () => profileDirState.value,
}))

vi.mock('../../packages/server/src/services/hermes/tui-live', () => ({
  listLiveTuiSessionKeys: vi.fn().mockResolvedValue(new Set()),
}))

function ensureSqliteAvailable() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 5)) {
    throw new Error(`node:sqlite requires Node >= 22.5, current: ${process.versions.node}`)
  }
}

function createSchema(db: any) {
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      user_id TEXT,
      model TEXT,
      model_config TEXT,
      system_prompt TEXT,
      parent_session_id TEXT,
      started_at REAL NOT NULL,
      ended_at REAL,
      end_reason TEXT,
      message_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      billing_provider TEXT,
      billing_base_url TEXT,
      billing_mode TEXT,
      estimated_cost_usd REAL,
      actual_cost_usd REAL,
      cost_status TEXT,
      cost_source TEXT,
      pricing_version TEXT,
      title TEXT,
      api_call_count INTEGER DEFAULT 0,
      FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
    );

    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL,
      content TEXT,
      tool_call_id TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      timestamp REAL NOT NULL,
      token_count INTEGER,
      finish_reason TEXT,
      reasoning TEXT,
      reasoning_details TEXT,
      codex_reasoning_items TEXT,
      reasoning_content TEXT
    );
  `)
}

function createLineageSchema(db: any) {
  db.exec(`
    CREATE TABLE conversation_threads (
      conversation_id TEXT PRIMARY KEY,
      root_session_id TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE conversation_session_edges (
      edge_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      parent_session_id TEXT,
      child_session_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      confidence TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      superseded_at INTEGER
    );

    CREATE TABLE conversation_ui_events (
      event_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      source_session_id TEXT,
      anchor_session_id TEXT,
      anchor_message_id TEXT,
      anchor_after_message_id TEXT,
      content TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      superseded_at INTEGER
    );
  `)
}

function insertConversationThread(db: any, thread: Record<string, unknown>) {
  db.prepare(`
    INSERT INTO conversation_threads (
      conversation_id, root_session_id, title, status, created_at, updated_at, schema_version
    ) VALUES (
      @conversation_id, @root_session_id, @title, @status, @created_at, @updated_at, @schema_version
    )
  `).run({
    title: null,
    status: 'active',
    created_at: 1,
    updated_at: 1,
    schema_version: 1,
    ...thread,
  })
}

function insertConversationEdge(db: any, edge: Record<string, unknown>) {
  db.prepare(`
    INSERT INTO conversation_session_edges (
      edge_id, conversation_id, parent_session_id, child_session_id,
      edge_type, confidence, created_by, created_at, superseded_at
    ) VALUES (
      @edge_id, @conversation_id, @parent_session_id, @child_session_id,
      @edge_type, @confidence, @created_by, @created_at, @superseded_at
    )
  `).run({
    parent_session_id: null,
    confidence: 'explicit',
    created_by: 'test',
    superseded_at: null,
    ...edge,
  })
}

function insertConversationUiEvent(db: any, event: Record<string, unknown>) {
  db.prepare(`
    INSERT INTO conversation_ui_events (
      event_id, conversation_id, event_type, source_session_id,
      anchor_session_id, anchor_message_id, anchor_after_message_id,
      content, metadata_json, created_at, superseded_at
    ) VALUES (
      @event_id, @conversation_id, @event_type, @source_session_id,
      @anchor_session_id, @anchor_message_id, @anchor_after_message_id,
      @content, @metadata_json, @created_at, @superseded_at
    )
  `).run({
    source_session_id: null,
    anchor_session_id: null,
    anchor_message_id: null,
    anchor_after_message_id: null,
    content: null,
    metadata_json: null,
    superseded_at: null,
    ...event,
  })
}

function insertSession(db: any, session: Record<string, unknown>) {
  db.prepare(`
    INSERT INTO sessions (
      id, source, user_id, model, model_config, system_prompt, parent_session_id,
      started_at, ended_at, end_reason, message_count, tool_call_count,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      reasoning_tokens, billing_provider, billing_base_url, billing_mode,
      estimated_cost_usd, actual_cost_usd, cost_status, cost_source,
      pricing_version, title, api_call_count
    ) VALUES (
      @id, @source, @user_id, @model, @model_config, @system_prompt, @parent_session_id,
      @started_at, @ended_at, @end_reason, @message_count, @tool_call_count,
      @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens,
      @reasoning_tokens, @billing_provider, @billing_base_url, @billing_mode,
      @estimated_cost_usd, @actual_cost_usd, @cost_status, @cost_source,
      @pricing_version, @title, @api_call_count
    )
  `).run({
    user_id: null,
    model_config: null,
    system_prompt: null,
    billing_base_url: null,
    billing_mode: null,
    cost_source: null,
    pricing_version: null,
    api_call_count: 0,
    ...session,
  })
}

function insertMessage(db: any, message: Record<string, unknown>) {
  db.prepare(`
    INSERT INTO messages (
      id, session_id, role, content, tool_call_id, tool_calls, tool_name,
      timestamp, token_count, finish_reason, reasoning, reasoning_details,
      codex_reasoning_items, reasoning_content
    ) VALUES (
      @id, @session_id, @role, @content, @tool_call_id, @tool_calls, @tool_name,
      @timestamp, @token_count, @finish_reason, @reasoning, @reasoning_details,
      @codex_reasoning_items, @reasoning_content
    )
  `).run({
    tool_call_id: null,
    tool_calls: null,
    tool_name: null,
    token_count: null,
    finish_reason: null,
    reasoning: null,
    reasoning_details: null,
    codex_reasoning_items: null,
    reasoning_content: null,
    ...message,
  })
}

describe('conversation DB service', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-20T00:00:00Z'))
    profileDirState.value = mkdtempSync(join(tmpdir(), 'hwui-conversations-db-'))
  })

  afterEach(() => {
    vi.useRealTimers()
    if (profileDirState.value) rmSync(profileDirState.value, { recursive: true, force: true })
  })

  it('folds parentless bridge context continuations back into the root conversation', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 100,
      ended_at: null,
      end_reason: null,
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 1,
      output_tokens: 2,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'cont-1',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 200,
      ended_at: null,
      end_reason: null,
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 3,
      output_tokens: 4,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'cont-2',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 260,
      ended_at: null,
      end_reason: null,
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 5,
      output_tokens: 6,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'root', role: 'user', content: 'root request', timestamp: 101 })
    insertMessage(db, { id: 2, session_id: 'root', role: 'assistant', content: 'root answer', timestamp: 190 })
    insertMessage(db, {
      id: 3,
      session_id: 'cont-1',
      role: 'user',
      content: 'Previous conversation context:\nassistant: root answer\n\nCurrent user message:\ncontinue one',
      timestamp: 201,
    })
    insertMessage(db, { id: 4, session_id: 'cont-1', role: 'assistant', content: 'continuation one answer', timestamp: 250 })
    insertMessage(db, {
      id: 5,
      session_id: 'cont-2',
      role: 'user',
      content: 'Previous conversation context:\nassistant: continuation one answer\n\nCurrent user message:\ncontinue two',
      timestamp: 261,
    })
    insertMessage(db, { id: 6, session_id: 'cont-2', role: 'assistant', content: 'continuation two answer', timestamp: 262 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['root'])

    const detail = await mod.getConversationDetailFromDb('root', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      'root request',
      'root answer',
      'continue one',
      'continuation one answer',
      'continue two',
      'continuation two answer',
    ])
    expect(detail?.branches || []).toEqual([])
  })

  it('keeps tool calls and removes replayed history when aggregating inferred continuations', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'Root',
      started_at: 100,
      ended_at: 200,
      end_reason: 'compression',
      message_count: 4,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'cont',
      parent_session_id: 'root',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'Root #2',
      started_at: 201,
      ended_at: 260,
      end_reason: null,
      message_count: 6,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'root', role: 'user', content: 'original question', timestamp: 101 })
    insertMessage(db, {
      id: 2,
      session_id: 'root',
      role: 'assistant',
      content: 'checking',
      tool_calls: JSON.stringify([{ id: 'call_1', function: { name: 'shell', arguments: '{"cmd":"pwd"}' } }]),
      timestamp: 102,
    })
    insertMessage(db, { id: 3, session_id: 'root', role: 'tool', content: '{"output":"/tmp"}', tool_call_id: 'call_1', timestamp: 103 })
    insertMessage(db, { id: 4, session_id: 'root', role: 'assistant', content: 'root answer', timestamp: 104 })

    insertMessage(db, { id: 5, session_id: 'cont', role: 'user', content: 'original question', timestamp: 201 })
    insertMessage(db, {
      id: 6,
      session_id: 'cont',
      role: 'assistant',
      content: 'checking',
      tool_calls: JSON.stringify([{ id: 'call_1', function: { name: 'shell', arguments: '{"cmd":"pwd"}' } }]),
      timestamp: 202,
    })
    insertMessage(db, { id: 7, session_id: 'cont', role: 'tool', content: '[Duplicate tool output]', tool_call_id: 'call_1', timestamp: 203 })
    insertMessage(db, { id: 8, session_id: 'cont', role: 'assistant', content: 'root answer', timestamp: 204 })
    insertMessage(db, { id: 11, session_id: 'cont', role: 'assistant', content: '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below.', timestamp: 204.5 })
    insertMessage(db, { id: 9, session_id: 'cont', role: 'user', content: 'new continuation request', timestamp: 205 })
    insertMessage(db, { id: 10, session_id: 'cont', role: 'assistant', content: 'continued answer', timestamp: 206 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const detail = await mod.getConversationDetailFromDb('root', { source: 'tui', humanOnly: true })

    expect(detail?.thread_session_count).toBe(2)
    expect(detail?.messages.map((message: any) => `${message.session_id}:${message.role}:${message.content}`)).toEqual([
      'root:user:original question',
      'root:assistant:checking',
      'root:tool:{"output":"/tmp"}',
      'root:assistant:root answer',
      'cont:user:new continuation request',
      'cont:assistant:continued answer',
    ])
    expect(detail?.messages[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call_1', function: { name: 'shell', arguments: '{"cmd":"pwd"}' } }],
    })
    expect(detail?.messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_1',
    })
  })

  it('infers parentless bridge continuations from full parent message history when the parent tail moved on', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 100,
      ended_at: 500,
      end_reason: 'tui_shutdown',
      message_count: 5,
      tool_call_count: 1,
      input_tokens: 1,
      output_tokens: 2,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'continuation',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 300,
      ended_at: 360,
      end_reason: 'tui_shutdown',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 3,
      output_tokens: 4,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'root', role: 'user', content: '我要测试/steer 功能', timestamp: 101 })
    insertMessage(db, { id: 2, session_id: 'root', role: 'assistant', content: '第一轮正常：todo 返回空列表。', timestamp: 200 })
    insertMessage(db, { id: 3, session_id: 'root', role: 'assistant', content: '后面又继续产生的新尾部内容，子会话历史里不会包含。', timestamp: 450 })
    insertMessage(db, {
      id: 4,
      session_id: 'continuation',
      role: 'user',
      content: 'Previous conversation context:\nassistant: 第一轮正常：todo 返回空列表。\n\nCurrent user message:\n再测一次',
      timestamp: 301,
    })
    insertMessage(db, { id: 5, session_id: 'continuation', role: 'assistant', content: '继续测试完成。', timestamp: 350 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['root'])
    expect(summaries[0]).toMatchObject({
      thread_session_count: 2,
      branch_session_count: 0,
    })

    const detail = await mod.getConversationDetailFromDb('root', { humanOnly: true })
    expect(detail?.messages.map((message: any) => `${message.session_id}:${message.content}`)).toEqual([
      'root:我要测试/steer 功能',
      'root:第一轮正常：todo 返回空列表。',
      'continuation:再测一次',
      'continuation:继续测试完成。',
      'root:后面又继续产生的新尾部内容，子会话历史里不会包含。',
    ])
  })

  it('does not fold adjacent bridge context sessions when the child context references different history', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'previous-context-session',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 100,
      ended_at: null,
      end_reason: null,
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 1,
      output_tokens: 2,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'next-context-session',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 200.2,
      ended_at: null,
      end_reason: null,
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 3,
      output_tokens: 4,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, {
      id: 7,
      session_id: 'previous-context-session',
      role: 'user',
      content: 'Previous conversation context:\nassistant: browser tab crashes when loading this session\n\nCurrent user message:\ncontinue debugging render crash',
      timestamp: 101,
    })
    insertMessage(db, { id: 8, session_id: 'previous-context-session', role: 'assistant', content: 'Inspecting the render crash', timestamp: 200 })
    insertMessage(db, {
      id: 9,
      session_id: 'next-context-session',
      role: 'user',
      content: 'Previous conversation context:\nassistant: fast thinking stream overloads the UI\n\nCurrent user message:\nopen this project path',
      timestamp: 200.2,
    })
    insertMessage(db, { id: 10, session_id: 'next-context-session', role: 'assistant', content: 'Reviewing your changes', timestamp: 201 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual([
      'next-context-session',
      'previous-context-session',
    ])

    const detail = await mod.getConversationDetailFromDb('next-context-session', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      'open this project path',
      'Reviewing your changes',
    ])
    expect(detail?.branches || []).toEqual([])
  })

  it('does not report branch_session_count for a bridge-context continuation without real child branches', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'Root',
      started_at: 100,
      ended_at: 110,
      end_reason: null,
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'continuation',
      parent_session_id: 'root',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'Continuation',
      started_at: 120,
      ended_at: null,
      end_reason: null,
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'root', role: 'assistant', content: 'older answer', timestamp: 101 })
    insertMessage(db, {
      id: 2,
      session_id: 'continuation',
      role: 'user',
      content: 'Previous conversation context:\nassistant: older answer\n\nCurrent user message:\ncontinue here',
      timestamp: 120,
    })
    insertMessage(db, { id: 3, session_id: 'continuation', role: 'assistant', content: 'continued answer', timestamp: 121 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['root'])
    expect(summaries[0]?.branch_session_count).toBe(0)

    const detail = await mod.getConversationDetailFromDb('root', { humanOnly: true })
    expect(detail?.branch_session_count).toBe(0)
    expect(detail?.branches || []).toEqual([])
  })

  it('aggregates a compression continuation without using full CLI export', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'root',
      parent_session_id: null,
      source: 'cli',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 100,
      ended_at: 110,
      end_reason: 'compression',
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 5,
      output_tokens: 8,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0.1,
      actual_cost_usd: 0.1,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'root-cont',
      parent_session_id: 'root',
      source: 'cli',
      model: 'openai/gpt-5.4',
      title: 'Continuation',
      started_at: 110,
      ended_at: 111,
      end_reason: null,
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 3,
      output_tokens: 4,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0.2,
      actual_cost_usd: 0.2,
      cost_status: 'final',
    })

    insertMessage(db, { id: 1, session_id: 'root', role: 'user', content: 'Start here', timestamp: 101 })
    insertMessage(db, { id: 2, session_id: 'root', role: 'assistant', content: 'Assistant reply', timestamp: 102 })
    insertMessage(db, { id: 3, session_id: 'root-cont', role: 'user', content: 'Continue with more detail', timestamp: 110 })
    insertMessage(db, { id: 4, session_id: 'root-cont', role: 'assistant', content: 'Continued answer', timestamp: 111 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toEqual(expect.objectContaining({
      id: 'root',
      started_at: 100,
      thread_session_count: 2,
      branch_session_count: 0,
      ended_at: 111,
      cost_status: 'mixed',
      actual_cost_usd: 0.30000000000000004,
    }))

    const detailFromRoot = await mod.getConversationDetailFromDb('root', { humanOnly: true })
    expect(detailFromRoot?.session_id).toBe('root')
    expect(detailFromRoot?.thread_session_count).toBe(2)
    expect(detailFromRoot?.messages.map((message: any) => message.content)).toEqual([
      'Start here',
      'Assistant reply',
      'Continue with more detail',
      'Continued answer',
    ])
    expect(detailFromRoot?.branches ?? []).toEqual([])
  })

  it('keeps explicit tui compression continuations in the main conversation instead of the branch tree', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'root-skill',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: '更新合并指南 Skill',
      started_at: 100,
      ended_at: 200,
      end_reason: 'compression',
      message_count: 4,
      tool_call_count: 2,
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'skill-2',
      parent_session_id: 'root-skill',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: '更新合并指南 Skill #2',
      started_at: 180,
      ended_at: 220,
      end_reason: 'tui_shutdown',
      message_count: 4,
      tool_call_count: 1,
      input_tokens: 8,
      output_tokens: 12,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'skill-3',
      parent_session_id: 'root-skill',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: '更新合并指南 Skill #3',
      started_at: 200.01,
      ended_at: null,
      end_reason: null,
      message_count: 3,
      tool_call_count: 1,
      input_tokens: 8,
      output_tokens: 12,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'root-skill', role: 'user', content: '我把指南更新了   你现在把合并指南skill 更新一下', timestamp: 101 })
    insertMessage(db, { id: 2, session_id: 'root-skill', role: 'assistant', content: '我先定位现有的合并指南 skill 和你更新后的指南来源，然后按 skill 安全规范做最小更新。', timestamp: 102 })
    insertMessage(db, { id: 3, session_id: 'root-skill', role: 'assistant', content: '开始更新 skill。', timestamp: 150 })

    insertMessage(db, { id: 4, session_id: 'skill-2', role: 'user', content: '我把指南更新了   你现在把合并指南skill 更新一下', timestamp: 181 })
    insertMessage(db, { id: 5, session_id: 'skill-2', role: 'assistant', content: '我先定位现有的合并指南 skill 和你更新后的指南来源，然后按 skill 安全规范做最小更新。', timestamp: 182 })
    insertMessage(db, { id: 6, session_id: 'skill-2', role: 'user', content: '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below.', timestamp: 183 })
    insertMessage(db, { id: 7, session_id: 'skill-2', role: 'assistant', content: '开始更新 skill：我会新增一个“从项目开发指南同步的合并约束”章节。', timestamp: 184 })

    insertMessage(db, { id: 8, session_id: 'skill-3', role: 'user', content: '我把指南更新了   你现在把合并指南skill 更新一下', timestamp: 200.02 })
    insertMessage(db, { id: 9, session_id: 'skill-3', role: 'assistant', content: '我先读取你上传的新版 SKILL.md 和现有 skill。', timestamp: 200.03 })
    insertMessage(db, { id: 10, session_id: 'skill-3', role: 'assistant', content: '我看到上传的新版 SKILL.md 不是简单覆盖版。', timestamp: 200.04 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['root-skill'])
    expect(summaries[0]?.branch_session_count).toBe(0)

    const detail = await mod.getConversationDetailFromDb('root-skill', { humanOnly: true })
    expect(detail?.branches ?? []).toEqual([])
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      '我把指南更新了   你现在把合并指南skill 更新一下',
      '我先定位现有的合并指南 skill 和你更新后的指南来源，然后按 skill 安全规范做最小更新。',
      '开始更新 skill。',
      '我把指南更新了   你现在把合并指南skill 更新一下',
      '开始更新 skill：我会新增一个“从项目开发指南同步的合并约束”章节。',
      '我把指南更新了   你现在把合并指南skill 更新一下',
      '我先读取你上传的新版 SKILL.md 和现有 skill。',
      '我看到上传的新版 SKILL.md 不是简单覆盖版。',
    ])
  })

  it('keeps explicit tui handoff continuations out of the branch tree even when the parent ends as tui_shutdown', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'stability-root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'WebUI稳定性打磨',
      started_at: 100,
      ended_at: 500,
      end_reason: 'tui_shutdown',
      message_count: 20,
      tool_call_count: 8,
      input_tokens: 100,
      output_tokens: 200,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'stability-cont',
      parent_session_id: 'stability-root',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'WebUI稳定性打磨 #2',
      started_at: 300,
      ended_at: null,
      end_reason: null,
      message_count: 10,
      tool_call_count: 4,
      input_tokens: 50,
      output_tokens: 80,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'stability-root', role: 'user', content: '小七 我终于把webui 修的比较好用了', timestamp: 101 })
    insertMessage(db, { id: 2, session_id: 'stability-root', role: 'assistant', content: '挺好，这一步很关键：先稳定、顺手，再谈“大厂级体验”。', timestamp: 102 })
    insertMessage(db, { id: 3, session_id: 'stability-root', role: 'user', content: '现在帮我查一下 daily-weather-clothing-advice webui-release-watcher', timestamp: 120 })
    insertMessage(db, { id: 4, session_id: 'stability-root', role: 'assistant', content: '我先按“三段链路”查：任务配置 → 调度执行记录 → 投递/会话日志。', timestamp: 130 })

    insertMessage(db, { id: 5, session_id: 'stability-cont', role: 'user', content: '小七 我终于把webui 修的比较好用了  虽然还是比不上大厂出的UI', timestamp: 301 })
    insertMessage(db, { id: 6, session_id: 'stability-cont', role: 'assistant', content: '挺好，这一步很关键：先稳定、顺手，再谈“大厂级体验”。', timestamp: 302 })
    insertMessage(db, { id: 7, session_id: 'stability-cont', role: 'user', content: '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below.', timestamp: 303 })
    insertMessage(db, { id: 8, session_id: 'stability-cont', role: 'user', content: '现在给我一个新流程的 5月13号的天气  通知到微信上', timestamp: 304 })
    insertMessage(db, { id: 9, session_id: 'stability-cont', role: 'assistant', content: '我按“新流程”跑一遍：先用脚本拿 Open‑Meteo 补充数据，再用高德作为主天气源整理。', timestamp: 305 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['stability-root'])
    expect(summaries[0]?.branch_session_count).toBe(0)

    const detail = await mod.getConversationDetailFromDb('stability-root', { humanOnly: true })
    expect(detail?.branches ?? []).toEqual([])
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      '小七 我终于把webui 修的比较好用了',
      '挺好，这一步很关键：先稳定、顺手，再谈“大厂级体验”。',
      '现在帮我查一下 daily-weather-clothing-advice webui-release-watcher',
      '我先按“三段链路”查：任务配置 → 调度执行记录 → 投递/会话日志。',
      '小七 我终于把webui 修的比较好用了  虽然还是比不上大厂出的UI',
      '挺好，这一步很关键：先稳定、顺手，再谈“大厂级体验”。',
      '现在给我一个新流程的 5月13号的天气  通知到微信上',
      '我按“新流程”跑一遍：先用脚本拿 Open‑Meteo 补充数据，再用高德作为主天气源整理。',
    ])
  })

  it('drops compaction handoff notes and replayed historical turns from aggregated detail', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'root-clean',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'Adding engineering code standard skill',
      started_at: 100,
      ended_at: 200,
      end_reason: 'compression',
      message_count: 8,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'cont-clean',
      parent_session_id: 'root-clean',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'Adding engineering code standard skill #2',
      started_at: 200.01,
      ended_at: null,
      end_reason: null,
      message_count: 9,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'root-clean', role: 'user', content: '添加一个skill 以后只要涉及写代码就要加载这个skill', timestamp: 101 })
    insertMessage(db, { id: 2, session_id: 'root-clean', role: 'assistant', content: 'root assistant', timestamp: 102 })
    insertMessage(db, { id: 3, session_id: 'root-clean', role: 'user', content: '先看看我这次 指南更新 是否包括了今天的源码改动', timestamp: 103 })
    insertMessage(db, { id: 4, session_id: 'root-clean', role: 'assistant', content: '指南已覆盖今天的源码改动。', timestamp: 104 })
    insertMessage(db, { id: 5, session_id: 'root-clean', role: 'user', content: '更新指南skill', timestamp: 105 })
    insertMessage(db, { id: 6, session_id: 'root-clean', role: 'assistant', content: 'skill 已更新。', timestamp: 106 })
    insertMessage(db, { id: 7, session_id: 'cont-clean', role: 'user', content: '添加一个skill 以后只要涉及写代码就要加载这个skill', timestamp: 201 })
    insertMessage(db, { id: 8, session_id: 'cont-clean', role: 'assistant', content: 'root assistant', timestamp: 202 })
    insertMessage(db, { id: 9, session_id: 'cont-clean', role: 'assistant', content: '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below.', timestamp: 203 })
    insertMessage(db, { id: 10, session_id: 'cont-clean', role: 'user', content: '先看看我这次 指南更新 是否包括了今天的源码改动', timestamp: 204 })
    insertMessage(db, { id: 11, session_id: 'cont-clean', role: 'assistant', content: '指南已覆盖今天的源码改动。', timestamp: 205 })
    insertMessage(db, { id: 12, session_id: 'cont-clean', role: 'user', content: '更新指南skill', timestamp: 206 })
    insertMessage(db, { id: 13, session_id: 'cont-clean', role: 'assistant', content: 'skill 已更新。', timestamp: 207 })
    insertMessage(db, {
      id: 14,
      session_id: 'cont-clean',
      role: 'user',
      content: 'Previous conversation context:\nassistant: skill 已更新。\n\nCurrent user message:\n增加一条记忆规则 以后创建skill 或者安装skill 时 一定要做场景匹配',
      timestamp: 208,
    })
    insertMessage(db, { id: 15, session_id: 'cont-clean', role: 'assistant', content: 'new assistant answer', timestamp: 209 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const detail = await mod.getConversationDetailFromDb('root-clean', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      '添加一个skill 以后只要涉及写代码就要加载这个skill',
      'root assistant',
      '先看看我这次 指南更新 是否包括了今天的源码改动',
      '指南已覆盖今天的源码改动。',
      '更新指南skill',
      'skill 已更新。',
      '增加一条记忆规则 以后创建skill 或者安装skill 时 一定要做场景匹配',
      'new assistant answer',
    ])
  })

  it('hides todo reinjection notes from human-only aggregated detail without affecting continuation folding', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'todo-root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'Phase 2 bridge refactor',
      started_at: 100,
      ended_at: 200,
      end_reason: 'compression',
      message_count: 3,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'todo-tip',
      parent_session_id: 'todo-root',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'Phase 2 bridge refactor #2',
      started_at: 200.01,
      ended_at: null,
      end_reason: null,
      message_count: 3,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'todo-root', role: 'user', content: '继续做 Phase 2', timestamp: 101 })
    insertMessage(db, { id: 2, session_id: 'todo-root', role: 'assistant', content: '我先拆状态机和测试面。', timestamp: 102 })
    insertMessage(db, { id: 3, session_id: 'todo-tip', role: 'user', content: '[Your active task list was preserved across context compression]\n- [ ] t5. update skill\n- [>] t6. migrate state machine', timestamp: 201 })
    insertMessage(db, { id: 4, session_id: 'todo-tip', role: 'user', content: '继续，把 Phase 2 做完', timestamp: 202 })
    insertMessage(db, { id: 5, session_id: 'todo-tip', role: 'assistant', content: '继续推进。', timestamp: 203 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['todo-root'])

    const detail = await mod.getConversationDetailFromDb('todo-root', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      '继续做 Phase 2',
      '我先拆状态机和测试面。',
      '继续，把 Phase 2 做完',
      '继续推进。',
    ])
  })

  it('aggregates an orphan continuation without showing it as a separate conversation', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'root',
      parent_session_id: null,
      source: 'cli',
      model: 'openai/gpt-5.4',
      title: 'Root',
      started_at: 100,
      ended_at: 110,
      end_reason: 'compression',
      message_count: 1,
      tool_call_count: 0,
      input_tokens: 5,
      output_tokens: 8,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'orphan-cont',
      parent_session_id: null,
      source: 'cli',
      model: 'openai/gpt-5.4',
      title: 'Continuation',
      started_at: 111,
      ended_at: null,
      end_reason: null,
      message_count: 1,
      tool_call_count: 0,
      input_tokens: 3,
      output_tokens: 4,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 11, session_id: 'root', role: 'user', content: 'Start here', timestamp: 101 })
    insertMessage(db, { id: 12, session_id: 'orphan-cont', role: 'assistant', content: 'Continued answer', timestamp: 112 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['root'])
    expect(summaries[0]).toMatchObject({
      started_at: 100,
      thread_session_count: 2,
      branch_session_count: 0,
      input_tokens: 3,
      output_tokens: 4,
    })

    const detail = await mod.getConversationDetailFromDb('root', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.session_id)).toEqual(['root', 'orphan-cont'])
    expect(detail?.branches ?? []).toEqual([])
  })

  it('aggregates a delayed orphan continuation when the visible content is duplicated', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'root',
      parent_session_id: null,
      source: 'cli',
      model: 'openai/gpt-5.4',
      title: 'Duplicated chat',
      started_at: 100,
      ended_at: 110,
      end_reason: 'compression',
      message_count: 1,
      tool_call_count: 0,
      input_tokens: 5,
      output_tokens: 8,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'duplicate-cont',
      parent_session_id: null,
      source: 'cli',
      model: 'openai/gpt-5.4',
      title: 'Duplicated chat',
      started_at: 200,
      ended_at: 201,
      end_reason: null,
      message_count: 1,
      tool_call_count: 0,
      input_tokens: 3,
      output_tokens: 4,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 21, session_id: 'root', role: 'user', content: 'same visible conversation', timestamp: 101 })
    insertMessage(db, { id: 22, session_id: 'duplicate-cont', role: 'user', content: 'same visible conversation', timestamp: 200 })
    insertMessage(db, { id: 23, session_id: 'duplicate-cont', role: 'assistant', content: 'new continuation answer', timestamp: 201 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['root'])
    expect(summaries[0]).toMatchObject({
      started_at: 100,
      thread_session_count: 2,
      branch_session_count: 0,
    })

    const detail = await mod.getConversationDetailFromDb('root', { humanOnly: true })
    expect(detail?.messages.map((message: any) => `${message.session_id}:${message.content}`)).toEqual([
      'root:same visible conversation',
      'duplicate-cont:same visible conversation',
      'duplicate-cont:new continuation answer',
    ])
    expect(detail?.branches ?? []).toEqual([])
  })

  it('folds bridge context prompt duplicates into compressed TUI conversation branches', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 100,
      ended_at: 420,
      end_reason: 'compression',
      message_count: 1,
      tool_call_count: 0,
      input_tokens: 1,
      output_tokens: 2,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'tip',
      parent_session_id: 'root',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 200.1,
      ended_at: null,
      end_reason: null,
      message_count: 1,
      tool_call_count: 0,
      input_tokens: 3,
      output_tokens: 4,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'bridge-duplicate',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 260,
      ended_at: null,
      end_reason: null,
      message_count: 1,
      tool_call_count: 0,
      input_tokens: 5,
      output_tokens: 6,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 31, session_id: 'root', role: 'user', content: 'before compression', timestamp: 101 })
    insertMessage(db, { id: 32, session_id: 'tip', role: 'user', content: 'after compression', timestamp: 201 })
    insertMessage(db, {
      id: 33,
      session_id: 'bridge-duplicate',
      role: 'user',
      content: 'Previous conversation context:\nassistant: after compression\n\nCurrent user message:\ncontinue',
      timestamp: 261,
    })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['root'])
    expect(summaries[0]).toMatchObject({
      thread_session_count: 2,
      branch_session_count: 0,
      input_tokens: 3,
      output_tokens: 4,
    })

    const detail = await mod.getConversationDetailFromDb('root', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.session_id)).toEqual(['root', 'tip', 'bridge-duplicate'])
    expect(detail?.branches ?? []).toEqual([])
  })

  it('folds parentless bridge context sessions into existing branch placeholders', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 100,
      ended_at: null,
      end_reason: null,
      message_count: 1,
      tool_call_count: 0,
      input_tokens: 1,
      output_tokens: 2,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'branch-placeholder',
      parent_session_id: 'root',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 200,
      ended_at: null,
      end_reason: null,
      message_count: 1,
      tool_call_count: 0,
      input_tokens: 3,
      output_tokens: 4,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'context-continuation',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 260,
      ended_at: null,
      end_reason: null,
      message_count: 1,
      tool_call_count: 0,
      input_tokens: 5,
      output_tokens: 6,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 41, session_id: 'root', role: 'user', content: 'root request', timestamp: 101 })
    insertMessage(db, { id: 42, session_id: 'branch-placeholder', role: 'assistant', content: 'branch work before compaction', timestamp: 201 })
    insertMessage(db, {
      id: 43,
      session_id: 'context-continuation',
      role: 'user',
      content: 'Previous conversation context:\nassistant: branch work before compaction\n\nCurrent user message:\ncontinue branch',
      timestamp: 261,
    })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['root'])

    const rootDetail = await mod.getConversationDetailFromDb('root', { humanOnly: true })
    expect(rootDetail?.messages.map((message: any) => message.content)).toEqual([
      'root request',
      'continue branch',
    ])
    expect(rootDetail?.branches?.map((branch: any) => branch.session_id)).toEqual(['branch-placeholder'])
  })

  it('folds branched children back into the root conversation', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'root',
      parent_session_id: null,
      source: 'cli',
      model: 'openai/gpt-5.4',
      title: 'Root',
      started_at: 100,
      ended_at: 200,
      end_reason: 'branched',
      message_count: 1,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'branch-child',
      parent_session_id: 'root',
      source: 'cli',
      model: 'openai/gpt-5.4',
      title: 'Branch child',
      started_at: 201,
      ended_at: 210,
      end_reason: null,
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'root', role: 'user', content: 'Root prompt', timestamp: 101 })
    insertMessage(db, { id: 2, session_id: 'branch-child', role: 'user', content: 'Branch prompt', timestamp: 202 })
    insertMessage(db, { id: 3, session_id: 'branch-child', role: 'assistant', content: 'Branch answer', timestamp: 203 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['root'])

    const detail = await mod.getConversationDetailFromDb('root', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual(['Root prompt', 'Branch prompt', 'Branch answer'])
    expect(detail?.branches ?? []).toEqual([])
  })

  it('does not expose active child tui branches as top-level conversations', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'root',
      parent_session_id: null,
      source: 'tui',
      model: 'gpt-5.5',
      title: 'Root',
      started_at: 100,
      ended_at: null,
      end_reason: null,
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'child',
      parent_session_id: 'root',
      source: 'tui',
      model: 'gpt-5.5',
      title: 'Child branch',
      started_at: 101,
      ended_at: null,
      end_reason: null,
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertMessage(db, { id: 1, session_id: 'root', role: 'user', content: 'Root prompt', timestamp: 100 })
    insertMessage(db, { id: 2, session_id: 'root', role: 'assistant', content: 'Root answer', timestamp: 100.5 })
    insertMessage(db, { id: 3, session_id: 'child', role: 'user', content: 'Child prompt', timestamp: 101 })
    insertMessage(db, { id: 4, session_id: 'child', role: 'assistant', content: 'Child answer', timestamp: 101.5 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })

    expect(summaries.map((summary: any) => summary.id)).toEqual(['root'])
  })

  it('folds non-branch child sessions into their parent conversation', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'parent',
      parent_session_id: null,
      source: 'cli',
      model: 'openai/gpt-5.4',
      title: 'Parent',
      started_at: 100,
      ended_at: 150,
      end_reason: null,
      message_count: 1,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'review-child',
      parent_session_id: 'parent',
      source: 'cli',
      model: 'openai/gpt-5.4',
      title: 'Independent review',
      started_at: 300,
      ended_at: 320,
      end_reason: null,
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'parent', role: 'user', content: 'Parent prompt', timestamp: 101 })
    insertMessage(db, { id: 2, session_id: 'review-child', role: 'user', content: 'Review prompt', timestamp: 301 })
    insertMessage(db, { id: 3, session_id: 'review-child', role: 'assistant', content: 'Review answer', timestamp: 302 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['parent'])

    const detail = await mod.getConversationDetailFromDb('parent', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual(['Parent prompt', 'Review prompt', 'Review answer'])
    expect(detail?.branches ?? []).toEqual([])
  })

  it('excludes synthetic-only roots from human-only summaries and details', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'synthetic-root',
      parent_session_id: null,
      source: 'cli',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 100,
      ended_at: 101,
      end_reason: null,
      message_count: 1,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertMessage(db, {
      id: 1,
      session_id: 'synthetic-root',
      role: 'user',
      content: "You've reached the maximum number of tool-calling iterations allowed.",
      timestamp: 100,
    })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    const detail = await mod.getConversationDetailFromDb('synthetic-root', { humanOnly: true })

    expect(summaries).toEqual([])
    expect(detail).toBeNull()
  })

  it('keeps tool-only conversations visible in human-only mode', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'tool-only-root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 100,
      ended_at: 101,
      end_reason: null,
      message_count: 1,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertMessage(db, {
      id: 1,
      session_id: 'tool-only-root',
      role: 'tool',
      content: '{"output":"ok"}',
      tool_call_id: 'call-1',
      tool_calls: null,
      tool_name: 'terminal',
      timestamp: 100,
    })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    const detail = await mod.getConversationDetailFromDb('tool-only-root', { humanOnly: true })

    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      id: 'tool-only-root',
      source: 'tui',
      tool_call_count: 1,
    })
    expect(detail).not.toBeNull()
    expect(detail?.session_id).toBe('tool-only-root')
  })

  it('loads only non-empty user and assistant messages into visible conversation detail', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'visible-root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'Visible root',
      started_at: 100,
      ended_at: 110,
      end_reason: null,
      message_count: 5,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertMessage(db, { id: 1, session_id: 'visible-root', role: 'user', content: 'visible user', timestamp: 101 })
    insertMessage(db, { id: 2, session_id: 'visible-root', role: 'assistant', content: 'visible assistant', timestamp: 102 })
    insertMessage(db, { id: 3, session_id: 'visible-root', role: 'tool', content: '{"output":"hidden"}', tool_name: 'terminal', timestamp: 103 })
    insertMessage(db, { id: 4, session_id: 'visible-root', role: 'assistant', content: '', timestamp: 104 })
    insertMessage(db, { id: 5, session_id: 'visible-root', role: 'system', content: 'hidden system', timestamp: 105 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const detail = await mod.getConversationDetailFromDb('visible-root', { humanOnly: true })

    expect(detail?.title).toBe('Visible root')
    expect(detail?.messages.map(message => `${message.role}:${message.content}`)).toEqual([
      'user:visible user',
      'assistant:visible assistant',
    ])
    expect(detail?.visible_count).toBe(2)
  })

  it('returns an empty detail payload for non-human-only sessions with no visible messages', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'assistant-empty',
      parent_session_id: null,
      source: 'cli',
      model: 'openai/gpt-5.4',
      title: 'Empty detail',
      started_at: 200,
      ended_at: null,
      end_reason: null,
      message_count: 0,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const detail = await mod.getConversationDetailFromDb('assistant-empty', { humanOnly: false })

    expect(detail).toEqual({
      session_id: 'assistant-empty',
      title: 'Empty detail',
      messages: [],
      visible_count: 0,
      thread_session_count: 1,
    })
  })

  it('folds root-level continuation prompt tui sessions back into the previous real root', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'real-root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'Subagent Deduplication Failure Analysis',
      started_at: 100,
      ended_at: 150,
      end_reason: 'tui_shutdown',
      message_count: 4,
      tool_call_count: 2,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'continuation-root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'Subagent Deduplication Failure Analysis',
      started_at: 151,
      ended_at: null,
      end_reason: null,
      message_count: 3,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'real-root', role: 'assistant', content: '让我看最近一次合并提交改了哪些关键文件。', timestamp: 101 })
    insertMessage(db, {
      id: 2,
      session_id: 'continuation-root',
      role: 'user',
      content: 'Previous conversation context:\nassistant: 让我看最近一次合并提交改了哪些关键文件。\n\nCurrent user message:\n继续',
      timestamp: 151,
    })
    insertMessage(db, { id: 3, session_id: 'continuation-root', role: 'assistant', content: '继续排查。', timestamp: 152 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['real-root'])

    const detail = await mod.getConversationDetailFromDb('real-root', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      '让我看最近一次合并提交改了哪些关键文件。',
      '继续',
      '继续排查。',
    ])
  })

  it('folds root-level continuation prompt tui sessions back into the previous real root even when title matching alone is insufficient', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'anchor-root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'Subagent Deduplication Failure Analysis',
      started_at: 100,
      ended_at: 150,
      end_reason: 'tui_shutdown',
      message_count: 4,
      tool_call_count: 2,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'anchor-continuation-root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: '继续排查',
      started_at: 151,
      ended_at: null,
      end_reason: null,
      message_count: 3,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'anchor-root', role: 'assistant', content: '子 agent 找到了关键线索。根因最可能是 parent_session_id 不匹配。', timestamp: 101 })
    insertMessage(db, {
      id: 2,
      session_id: 'anchor-continuation-root',
      role: 'user',
      content: 'Previous conversation context:\nassistant: 子 agent 找到了关键线索。根因最可能是 parent_session_id 不匹配。\n\nCurrent user message:\n继续',
      timestamp: 151,
    })
    insertMessage(db, { id: 3, session_id: 'anchor-continuation-root', role: 'assistant', content: '继续排查。', timestamp: 152 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['anchor-root'])

    const detail = await mod.getConversationDetailFromDb('anchor-root', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      '子 agent 找到了关键线索。根因最可能是 parent_session_id 不匹配。',
      '继续',
      '继续排查。',
    ])
  })

  it('falls back on an anchor middle-fragment match for root-level continuation prompts when exact prefix matching misses', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'middle-anchor-root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'Root A',
      started_at: 100,
      ended_at: 150,
      end_reason: 'tui_shutdown',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'middle-anchor-cont',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'Unrelated display title',
      started_at: 151,
      ended_at: null,
      end_reason: null,
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'middle-anchor-root', role: 'assistant', content: '浏览器引用号刷新了，我先重新抓页面状态，再继续自己登录。', timestamp: 101 })
    insertMessage(db, {
      id: 2,
      session_id: 'middle-anchor-cont',
      role: 'user',
      content: 'Previous conversation context:\nassistant: 我先重新抓页面状态，再继续自己登录。\n\nCurrent user message:\n继续',
      timestamp: 151,
    })
    insertMessage(db, { id: 3, session_id: 'middle-anchor-cont', role: 'assistant', content: '继续后续排查。', timestamp: 152 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['middle-anchor-root'])

    const detail = await mod.getConversationDetailFromDb('middle-anchor-root', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      '浏览器引用号刷新了，我先重新抓页面状态，再继续自己登录。',
      '继续',
      '继续后续排查。',
    ])
  })

  it('hides empty tui stub sessions from human-only summaries and details', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'empty-tui-stub',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 100,
      ended_at: null,
      end_reason: null,
      message_count: 0,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries).toEqual([])

    const detail = await mod.getConversationDetailFromDb('empty-tui-stub', { humanOnly: true })
    expect(detail).toBeNull()
  })

  it('bridges a parentless empty compression pivot back to the prior compression chain', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'seraphine-root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 100,
      ended_at: 200,
      end_reason: 'compression',
      message_count: 4,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'empty-pivot',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 260,
      ended_at: 300,
      end_reason: 'compression',
      message_count: 0,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'pivot-child',
      parent_session_id: 'empty-pivot',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 300,
      ended_at: 360,
      end_reason: 'tui_shutdown',
      message_count: 4,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'seraphine-root', role: 'user', content: 'E:\\Seraphine 理解这个项目', timestamp: 110 })
    insertMessage(db, { id: 2, session_id: 'seraphine-root', role: 'assistant', content: '这是一个 LoL 桌面辅助工具。', timestamp: 120 })
    insertMessage(db, { id: 5, session_id: 'seraphine-root', role: 'assistant', content: '父会话晚于空压缩 pivot 才结束。', timestamp: 400 })
    insertMessage(db, {
      id: 3,
      session_id: 'pivot-child',
      role: 'user',
      content: 'Previous conversation context:\nassistant: 这是一个 LoL 桌面辅助工具。\n\nCurrent user message:\n继续分析',
      timestamp: 310,
    })
    insertMessage(db, { id: 4, session_id: 'pivot-child', role: 'assistant', content: '继续分析模式筛选逻辑。', timestamp: 320 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['seraphine-root'])
    expect(summaries[0]?.represented_session_ids).toEqual(['seraphine-root', 'empty-pivot', 'pivot-child'])

    const detail = await mod.getConversationDetailFromDb('seraphine-root', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      'E:\\Seraphine 理解这个项目',
      '这是一个 LoL 桌面辅助工具。',
      '继续分析',
      '继续分析模式筛选逻辑。',
      '父会话晚于空压缩 pivot 才结束。',
    ])
  })

  it('keeps a bridge-linked empty compression pivot on the mainline after a non-compression tui parent', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'long-running-parent',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 100,
      ended_at: 600,
      end_reason: 'tui_shutdown',
      message_count: 4,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'orphan-empty-pivot',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 300,
      ended_at: 360,
      end_reason: 'compression',
      message_count: 0,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'deep-empty-pivot',
      parent_session_id: 'orphan-empty-pivot',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 360,
      ended_at: 420,
      end_reason: 'compression',
      message_count: 0,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'bridge-continuation',
      parent_session_id: 'deep-empty-pivot',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 420,
      ended_at: 500,
      end_reason: 'tui_shutdown',
      message_count: 4,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'long-running-parent', role: 'user', content: 'E:\\Seraphine 理解这个项目', timestamp: 110 })
    insertMessage(db, { id: 2, session_id: 'long-running-parent', role: 'assistant', content: '这是一个 LoL 桌面辅助工具。', timestamp: 120 })
    insertMessage(db, {
      id: 3,
      session_id: 'bridge-continuation',
      role: 'user',
      content: 'Previous conversation context:\nassistant: 这是一个 LoL 桌面辅助工具。\n\nCurrent user message:\n继续修分类',
      timestamp: 430,
    })
    insertMessage(db, { id: 4, session_id: 'bridge-continuation', role: 'assistant', content: '继续修分类补拉逻辑。', timestamp: 440 })
    insertMessage(db, { id: 5, session_id: 'long-running-parent', role: 'assistant', content: '父会话后续收尾。', timestamp: 590 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['long-running-parent'])
    expect(summaries[0]?.represented_session_ids).toEqual([
      'long-running-parent',
      'orphan-empty-pivot',
      'deep-empty-pivot',
      'bridge-continuation',
    ])

    const detail = await mod.getConversationDetailFromDb('long-running-parent', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      'E:\\Seraphine 理解这个项目',
      '这是一个 LoL 桌面辅助工具。',
      '继续修分类',
      '继续修分类补拉逻辑。',
      '父会话后续收尾。',
    ])
  })

  it('does not treat ambiguous empty compression pivots as non-compression tui continuations', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'parent',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 100,
      ended_at: 600,
      end_reason: 'tui_shutdown',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'ambiguous-pivot',
      parent_session_id: 'parent',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 300,
      ended_at: 360,
      end_reason: 'compression',
      message_count: 0,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'child-a',
      parent_session_id: 'ambiguous-pivot',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 361,
      ended_at: 400,
      end_reason: 'tui_shutdown',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'child-b',
      parent_session_id: 'ambiguous-pivot',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 362,
      ended_at: 410,
      end_reason: 'tui_shutdown',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'parent', role: 'user', content: '分析 Seraphine', timestamp: 110 })
    insertMessage(db, { id: 2, session_id: 'parent', role: 'assistant', content: '这是一个 LoL 桌面辅助工具。', timestamp: 120 })
    insertMessage(db, {
      id: 3,
      session_id: 'child-a',
      role: 'user',
      content: 'Previous conversation context:\nassistant: 这是一个 LoL 桌面辅助工具。\n\nCurrent user message:\n继续 A',
      timestamp: 370,
    })
    insertMessage(db, { id: 4, session_id: 'child-a', role: 'assistant', content: 'A 分支。', timestamp: 380 })
    insertMessage(db, {
      id: 5,
      session_id: 'child-b',
      role: 'user',
      content: 'Previous conversation context:\nassistant: 这是一个 LoL 桌面辅助工具。\n\nCurrent user message:\n继续 B',
      timestamp: 372,
    })
    insertMessage(db, { id: 6, session_id: 'child-b', role: 'assistant', content: 'B 分支。', timestamp: 390 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    const parent = summaries.find((summary: any) => summary.id === 'parent')
    expect(parent?.represented_session_ids).toEqual(['parent'])

    const detail = await mod.getConversationDetailFromDb('parent', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      '分析 Seraphine',
      '这是一个 LoL 桌面辅助工具。',
    ])
  })

  it('does not treat empty compression pivots as continuations when the descendant context lacks parent evidence', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'parent',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 100,
      ended_at: 600,
      end_reason: 'tui_shutdown',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'empty-pivot',
      parent_session_id: 'parent',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 300,
      ended_at: 360,
      end_reason: 'compression',
      message_count: 0,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'unrelated-context',
      parent_session_id: 'empty-pivot',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 361,
      ended_at: 400,
      end_reason: 'tui_shutdown',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'parent', role: 'user', content: '分析 Seraphine', timestamp: 110 })
    insertMessage(db, { id: 2, session_id: 'parent', role: 'assistant', content: '这是一个 LoL 桌面辅助工具。', timestamp: 120 })
    insertMessage(db, {
      id: 3,
      session_id: 'unrelated-context',
      role: 'user',
      content: 'Previous conversation context:\nassistant: 完全不同项目的旧上下文。\n\nCurrent user message:\n继续',
      timestamp: 370,
    })
    insertMessage(db, { id: 4, session_id: 'unrelated-context', role: 'assistant', content: '继续另一个项目。', timestamp: 380 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const detail = await mod.getConversationDetailFromDb('parent', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      '分析 Seraphine',
      '这是一个 LoL 桌面辅助工具。',
    ])
  })

  it('does not fold a one-message bridge context stub into an unrelated conversation', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'seraphine-root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 100,
      ended_at: 200,
      end_reason: 'compression',
      message_count: 4,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'queue-stub',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 260,
      ended_at: 500,
      end_reason: 'tui_shutdown',
      message_count: 1,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'seraphine-root', role: 'user', content: 'E:\\Seraphine 理解这个项目', timestamp: 110 })
    insertMessage(db, { id: 2, session_id: 'seraphine-root', role: 'assistant', content: '这是一个 LoL 桌面辅助工具。', timestamp: 120 })
    insertMessage(db, {
      id: 3,
      session_id: 'queue-stub',
      role: 'user',
      content: 'Previous conversation context:\nassistant: 我先把设置页的“队列筛选卡”完整看一遍。\nassistant: 现在对齐模式索引实现。\n\nCurrent user message:\n你好',
      timestamp: 270,
    })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['seraphine-root'])
    const seraphine = summaries.find((summary: any) => summary.id === 'seraphine-root')
    expect(seraphine?.represented_session_ids).toEqual(['seraphine-root'])

    const detail = await mod.getConversationDetailFromDb('seraphine-root', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      'E:\\Seraphine 理解这个项目',
      '这是一个 LoL 桌面辅助工具。',
    ])

    const queueStubDetail = await mod.getConversationDetailFromDb('queue-stub', { humanOnly: true })
    expect(queueStubDetail).toBeNull()
  })

  it('prefers explicit bridge continuation links over inferred root-level prompt matching', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'linked-root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'Push Source Code Changes',
      started_at: 100,
      ended_at: 1000,
      end_reason: 'tui_shutdown',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'linked-child',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'Subagent Deduplication Failure Analysis',
      started_at: 1010,
      ended_at: 1020,
      end_reason: 'tui_shutdown',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'linked-root', role: 'assistant', content: '让我看最近一次合并提交改了哪些关键文件。', timestamp: 900 })
    insertMessage(db, {
      id: 2,
      session_id: 'linked-child',
      role: 'user',
      content: 'Previous conversation context:\nassistant: 让我看最近一次合并提交改了哪些关键文件。\n\nCurrent user message:\n继续',
      timestamp: 1010,
    })
    insertMessage(db, { id: 3, session_id: 'linked-child', role: 'assistant', content: '继续排查。', timestamp: 1011 })
    db.close()

    const linksDb = new DatabaseSync(join(profileDirState.value, 'webui-bridge-links.db'))
    linksDb.exec(`
      CREATE TABLE IF NOT EXISTS bridge_continuation_links (
        child_session_id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL
      )
    `)
    linksDb.prepare(`
      INSERT INTO bridge_continuation_links (child_session_id, parent_session_id)
      VALUES (?, ?)
    `).run('linked-child', 'linked-root')
    linksDb.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['linked-root'])

    const detail = await mod.getConversationDetailFromDb('linked-root', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      '让我看最近一次合并提交改了哪些关键文件。',
      '继续',
      '继续排查。',
    ])
    expect(detail?.continuation_edges).toEqual([
      {
        child_session_id: 'linked-child',
        parent_session_id: 'linked-root',
        kind: 'explicit_bridge_link',
      },
    ])
  })

  it('does not fold an explicit bridge-linked wrapper-only child when its context does not match the linked parent', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'seraphine-root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'Seraphine Project Overview',
      started_at: 100,
      ended_at: 200,
      end_reason: 'tui_shutdown',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'wrong-wrapper-child',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 300,
      ended_at: null,
      end_reason: null,
      message_count: 1,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'seraphine-root', role: 'user', content: 'E:\\Seraphine 理解这个项目', timestamp: 110 })
    insertMessage(db, { id: 2, session_id: 'seraphine-root', role: 'assistant', content: '这是一个 LoL 桌面辅助工具。', timestamp: 120 })
    insertMessage(db, {
      id: 3,
      session_id: 'wrong-wrapper-child',
      role: 'user',
      content: 'Previous conversation context:\nassistant: 我先把生涯页补拉逻辑接进去，并保持最小改动。\n\nCurrent user message:\n现在依然只是 全部分类 和 海克斯大乱斗分类有战绩数据',
      timestamp: 300,
    })
    db.close()

    const linksDb = new DatabaseSync(join(profileDirState.value, 'webui-bridge-links.db'))
    linksDb.exec(`
      CREATE TABLE IF NOT EXISTS bridge_continuation_links (
        child_session_id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL
      )
    `)
    linksDb.prepare(`
      INSERT INTO bridge_continuation_links (child_session_id, parent_session_id)
      VALUES (?, ?)
    `).run('wrong-wrapper-child', 'seraphine-root')
    linksDb.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const detail = await mod.getConversationDetailFromDb('seraphine-root', { humanOnly: true })
    expect(detail?.thread_session_count).toBe(1)
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      'E:\\Seraphine 理解这个项目',
      '这是一个 LoL 桌面辅助工具。',
    ])
    expect(detail?.continuation_edges).toEqual([])
  })

  it('does not fold a real explicit bridge-linked child when its bridge context belongs to another session', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    for (const [id, startedAt, firstMessage] of [
      ['skill-root', 100, '我更新了 skill 并完成验证。'],
      ['actual-context-root', 200, '构建已通过，现在执行替换 dist 脚本。'],
      ['wrong-linked-child', 300, 'Previous conversation context:\nassistant: 构建已通过，现在执行替换 dist 脚本。\n\nCurrent user message:\n我又更新了 skill'],
    ] as const) {
      insertSession(db, {
        id,
        parent_session_id: null,
        source: 'tui',
        model: 'openai/gpt-5.4',
        title: null,
        started_at: startedAt,
        ended_at: startedAt + 20,
        end_reason: 'tui_shutdown',
        message_count: 2,
        tool_call_count: id === 'wrong-linked-child' ? 1 : 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openai',
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
        cost_status: 'estimated',
      })
      insertMessage(db, { id: startedAt, session_id: id, role: 'user', content: firstMessage, timestamp: startedAt })
      insertMessage(db, { id: startedAt + 1, session_id: id, role: 'assistant', content: `${id} answer`, timestamp: startedAt + 1 })
    }
    db.close()

    const linksDb = new DatabaseSync(join(profileDirState.value, 'webui-bridge-links.db'))
    linksDb.exec(`
      CREATE TABLE IF NOT EXISTS bridge_continuation_links (
        child_session_id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL
      )
    `)
    linksDb.prepare(`
      INSERT INTO bridge_continuation_links (child_session_id, parent_session_id)
      VALUES (?, ?)
    `).run('wrong-linked-child', 'skill-root')
    linksDb.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const detail = await mod.getConversationDetailFromDb('skill-root', { humanOnly: true })
    expect(detail?.thread_session_count).toBe(1)
    expect(detail?.messages.map((message: any) => message.session_id)).toEqual(['skill-root', 'skill-root'])
    expect(detail?.continuation_edges).toEqual([])

    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    const skillSummary = summaries.find((summary: any) => summary.id === 'skill-root')
    expect(skillSummary?.represented_session_ids).toEqual(['skill-root'])
  })

  it('merges the 20260521_010637 and 20260521_162954 bridge continuation pair into one conversation', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: '20260521_010637_f388c9',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 1779296813.16795,
      ended_at: 1779298433.9293,
      end_reason: 'compression',
      message_count: 16,
      tool_call_count: 8,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: '20260521_162954_ec7b91',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 1779352209.750183,
      ended_at: 1779374907.8455565,
      end_reason: 'tui_shutdown',
      message_count: 30,
      tool_call_count: 15,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertMessage(db, {
      id: 1,
      session_id: '20260521_010637_f388c9',
      role: 'assistant',
      content: '我已完成验证并更新了 skill。',
      timestamp: 1779298430,
    })
    insertMessage(db, {
      id: 2,
      session_id: '20260521_162954_ec7b91',
      role: 'user',
      content: 'Previous conversation context:\nassistant: 我已完成验证并更新了 skill。\n\nCurrent user message:\n我又更新了 skill',
      timestamp: 1779352666,
    })
    insertMessage(db, {
      id: 3,
      session_id: '20260521_162954_ec7b91',
      role: 'assistant',
      content: '继续处理这次 skill 更新。',
      timestamp: 1779352667,
    })
    db.close()

    const linksDb = new DatabaseSync(join(profileDirState.value, 'webui-bridge-links.db'))
    linksDb.exec(`
      CREATE TABLE IF NOT EXISTS bridge_continuation_links (
        child_session_id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL
      )
    `)
    linksDb.prepare(`
      INSERT INTO bridge_continuation_links (child_session_id, parent_session_id)
      VALUES (?, ?)
    `).run('20260521_162954_ec7b91', '20260521_010637_f388c9')
    linksDb.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['20260521_010637_f388c9'])
    expect(summaries[0]?.represented_session_ids).toEqual([
      '20260521_010637_f388c9',
      '20260521_162954_ec7b91',
    ])

    const detail = await mod.getConversationDetailFromDb('20260521_010637_f388c9', { humanOnly: true })
    expect(detail?.thread_session_count).toBe(2)
    expect(detail?.messages.map((message: any) => message.session_id)).toEqual([
      '20260521_010637_f388c9',
      '20260521_162954_ec7b91',
      '20260521_162954_ec7b91',
    ])
    expect(detail?.continuation_edges).toEqual([
      {
        child_session_id: '20260521_162954_ec7b91',
        parent_session_id: '20260521_010637_f388c9',
        kind: 'explicit_bridge_link',
      },
    ])
  })

  it('merges the 20260520_093333 long bridge/native continuation chain into one conversation', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: '20260520_093333_3c3fc9',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 1779240000,
      ended_at: 1779240300,
      end_reason: 'compression',
      message_count: 20,
      tool_call_count: 5,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertMessage(db, {
      id: 1,
      session_id: '20260520_093333_3c3fc9',
      role: 'assistant',
      content: '这是一个 LoL 桌面辅助工具。',
      timestamp: 1779240010,
    })
    insertSession(db, {
      id: '20260520_094805_7da759',
      parent_session_id: '20260520_093333_3c3fc9',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 1779240300.005,
      ended_at: 1779240400,
      end_reason: 'compression',
      message_count: 0,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: '20260520_113325_fc6bb5',
      parent_session_id: '20260520_094805_7da759',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 1779240400.005,
      ended_at: 1779251306,
      end_reason: 'tui_shutdown',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertMessage(db, {
      id: 2,
      session_id: '20260520_113325_fc6bb5',
      role: 'assistant',
      content: '我先把生涯页补拉逻辑接进去，并保持最小改动：',
      timestamp: 1779240410,
    })
    insertSession(db, {
      id: 'wrapper-only-noise',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 1779327805,
      ended_at: 1779329851,
      end_reason: 'tui_shutdown',
      message_count: 1,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertMessage(db, {
      id: 3,
      session_id: 'wrapper-only-noise',
      role: 'user',
      content: 'Previous conversation context:\nassistant: 我先把生涯页补拉逻辑接进去，并保持最小改动：\n\nCurrent user message:\n排队中的 wrapper',
      timestamp: 1779327839,
    })

    for (const [id, startedAt, content, assistantText, toolCount] of [
      ['20260521_104358_93df6b', 1779331453.4812186, 'Previous conversation context:\nassistant: 我先把生涯页补拉逻辑接进去，并保持最小改动：\n\nCurrent user message:\n现在依然只是 全部分类 和 海克斯大乱斗分类有战绩数据', '确认到了：`getSummonerGamesByPuuid` 返回的是 match-history 里的 `games` 外层对象，里面有 `games` 和 `gameCount`，`gameCount` 可作为继续分页的总数。', 38],
      ['20260521_112836_60efe9', 1779334131.96097, 'Previous conversation context:\nassistant: 确认到了：`getSummonerGamesByPuuid` 返回的是 match-history 里的 `games` 外层对象，里面有 `games` 和 `gameCount`，`gameCount` 可作为继续分页的总数。\n\nCurrent user message:\n还是不行  其他分类还是没有战绩数据', '结论：你的判断是对的，这次我已经把“只补拉最近几批”的限制修掉了。', 63],
      ['20260521_163829_126d61', 1779352724.72178, 'Previous conversation context:\nassistant: 验证通过了。我再做一次 diff 自检，确认这次只动了加载提示和对应测试，没有碰其它无关逻辑。\n\nCurrent user message:\n继续', '结论：已在正确项目路径 `E:\\BaiduNetdiskDownload\\Seraphine-main3\\Seraphine-main` 修复这两个崩溃风险。', 44],
    ] as const) {
      insertSession(db, {
        id,
        parent_session_id: null,
        source: 'tui',
        model: 'openai/gpt-5.4',
        title: null,
        started_at: startedAt,
        ended_at: startedAt + 60,
        end_reason: 'compression',
        message_count: 2,
        tool_call_count: toolCount,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openai',
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
        cost_status: 'estimated',
      })
      insertMessage(db, { id: Math.floor(startedAt), session_id: id, role: 'user', content, timestamp: startedAt })
      if (id === '20260521_104358_93df6b') {
        insertMessage(db, {
          id: Math.floor(startedAt) + 1,
          session_id: id,
          role: 'assistant',
          content: assistantText,
          tool_calls: JSON.stringify([{ id: 'call-1', type: 'function', function: { name: 'terminal', arguments: '{"command":"echo ok"}' } }]),
          finish_reason: 'tool_calls',
          timestamp: startedAt + 1,
        })
        insertMessage(db, { id: Math.floor(startedAt) + 2, session_id: id, role: 'tool', content: '{"output":"ok"}', tool_call_id: 'call-1', timestamp: startedAt + 2 })
        insertMessage(db, { id: Math.floor(startedAt) + 3, session_id: id, role: 'assistant', content: '我继续查真实代码链路和测试数据。', timestamp: startedAt + 3 })
      } else {
        insertMessage(db, { id: Math.floor(startedAt) + 1, session_id: id, role: 'assistant', content: assistantText, timestamp: startedAt + 1 })
      }
    }
    insertSession(db, {
      id: '20260521_120834_978995',
      parent_session_id: '20260521_112836_60efe9',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 1779336514.26016,
      ended_at: 1779337339.41401,
      end_reason: 'compression',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: '20260521_122219_0769a5',
      parent_session_id: '20260521_120834_978995',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 1779337339.41898,
      ended_at: 1779337761.25051,
      end_reason: 'compression',
      message_count: 0,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: '20260521_141328_90d2af',
      parent_session_id: '20260521_122219_0769a5',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 1779337761.25445,
      ended_at: 1779346468.20947,
      end_reason: 'tui_shutdown',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertMessage(db, {
      id: 1779336514,
      session_id: '20260521_120834_978995',
      role: 'assistant',
      content: '日志显示 loaded_source 一直等于 20。',
      timestamp: 1779336515,
    })
    insertMessage(db, {
      id: 1779337761,
      session_id: '20260521_141328_90d2af',
      role: 'assistant',
      content: '验证通过了。我再做一次 diff 自检，确认这次只动了加载提示和对应测试，没有碰其它无关逻辑。',
      timestamp: 1779337762,
    })
    db.close()

    const linksDb = new DatabaseSync(join(profileDirState.value, 'webui-bridge-links.db'))
    linksDb.exec(`
      CREATE TABLE IF NOT EXISTS bridge_continuation_links (
        child_session_id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL
      )
    `)
    linksDb.prepare(`
      INSERT INTO bridge_continuation_links (child_session_id, parent_session_id)
      VALUES (?, ?)
    `).run('20260521_104358_93df6b', '20260520_093333_3c3fc9')
    linksDb.prepare(`
      INSERT INTO bridge_continuation_links (child_session_id, parent_session_id)
      VALUES (?, ?)
    `).run('20260521_112836_60efe9', '20260520_093333_3c3fc9')
    linksDb.prepare(`
      INSERT INTO bridge_continuation_links (child_session_id, parent_session_id)
      VALUES (?, ?)
    `).run('20260521_163829_126d61', '20260520_093333_3c3fc9')
    linksDb.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['20260520_093333_3c3fc9'])
    expect(summaries[0]?.represented_session_ids).toEqual([
      '20260520_093333_3c3fc9',
      '20260520_094805_7da759',
      '20260520_113325_fc6bb5',
      '20260521_104358_93df6b',
      '20260521_112836_60efe9',
      '20260521_120834_978995',
      '20260521_122219_0769a5',
      '20260521_141328_90d2af',
      '20260521_163829_126d61',
    ])

    const detail = await mod.getConversationDetailFromDb('20260520_093333_3c3fc9', { humanOnly: true })
    expect(detail?.thread_session_count).toBe(9)
    expect(detail?.continuation_edges).toEqual([
      {
        child_session_id: '20260520_094805_7da759',
        parent_session_id: '20260520_093333_3c3fc9',
        kind: 'native_parent',
      },
      {
        child_session_id: '20260520_113325_fc6bb5',
        parent_session_id: '20260520_094805_7da759',
        kind: 'native_parent',
      },
      {
        child_session_id: '20260521_104358_93df6b',
        parent_session_id: '20260520_113325_fc6bb5',
        kind: 'fallback_inference',
      },
      {
        child_session_id: '20260521_112836_60efe9',
        parent_session_id: '20260521_104358_93df6b',
        kind: 'fallback_inference',
      },
      {
        child_session_id: '20260521_120834_978995',
        parent_session_id: '20260521_112836_60efe9',
        kind: 'native_parent',
      },
      {
        child_session_id: '20260521_122219_0769a5',
        parent_session_id: '20260521_120834_978995',
        kind: 'native_parent',
      },
      {
        child_session_id: '20260521_141328_90d2af',
        parent_session_id: '20260521_122219_0769a5',
        kind: 'native_parent',
      },
      {
        child_session_id: '20260521_163829_126d61',
        parent_session_id: '20260521_141328_90d2af',
        kind: 'fallback_inference',
      },
    ])
    expect(detail?.messages.map((message: any) => message.session_id)).toEqual([
      '20260520_093333_3c3fc9',
      '20260520_113325_fc6bb5',
      '20260521_104358_93df6b',
      '20260521_104358_93df6b',
      '20260521_104358_93df6b',
      '20260521_104358_93df6b',
      '20260521_112836_60efe9',
      '20260521_112836_60efe9',
      '20260521_120834_978995',
      '20260521_141328_90d2af',
      '20260521_163829_126d61',
      '20260521_163829_126d61',
    ])
    expect(detail?.messages.some((message: any) => message.role === 'tool')).toBe(true)
  })

  it('does not include an empty legacy bridge-linked child in detail edges or represented_session_ids', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: '20260521_010637_f388c9',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 100,
      ended_at: 120,
      end_reason: 'compression',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: '20260521_013353_5c5063',
      parent_session_id: '20260521_010637_f388c9',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 121,
      ended_at: 140,
      end_reason: 'compression',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: '20260522_201335_b99765',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 300,
      ended_at: 320,
      end_reason: 'compression',
      message_count: 0,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: '20260521_010637_f388c9', role: 'user', content: '我更新了 skill', timestamp: 101 })
    insertMessage(db, { id: 2, session_id: '20260521_010637_f388c9', role: 'assistant', content: 'skill 已更新。', timestamp: 102 })
    insertMessage(db, {
      id: 3,
      session_id: '20260521_013353_5c5063',
      role: 'user',
      content: 'Previous conversation context:\nassistant: skill 已更新。\n\nCurrent user message:\n继续',
      timestamp: 121,
    })
    insertMessage(db, { id: 4, session_id: '20260521_013353_5c5063', role: 'assistant', content: '继续验证。', timestamp: 122 })
    db.close()

    const linksDb = new DatabaseSync(join(profileDirState.value, 'webui-bridge-links.db'))
    linksDb.exec(`
      CREATE TABLE IF NOT EXISTS bridge_continuation_links (
        child_session_id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL
      )
    `)
    linksDb.prepare(`
      INSERT INTO bridge_continuation_links (child_session_id, parent_session_id)
      VALUES (?, ?)
    `).run('20260522_201335_b99765', '20260521_010637_f388c9')
    linksDb.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const detail = await mod.getConversationDetailFromDb('20260521_010637_f388c9', { humanOnly: true })
    expect(detail?.thread_session_count).toBe(2)
    expect(detail?.messages.map((message: any) => message.session_id)).toEqual([
      '20260521_010637_f388c9',
      '20260521_010637_f388c9',
      '20260521_013353_5c5063',
      '20260521_013353_5c5063',
    ])
    expect(detail?.continuation_edges).toEqual([
      {
        child_session_id: '20260521_013353_5c5063',
        parent_session_id: '20260521_010637_f388c9',
        kind: 'native_parent',
      },
    ])

    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    const summary = summaries.find((item: any) => item.id === '20260521_010637_f388c9')
    expect(summary?.represented_session_ids).toEqual([
      '20260521_010637_f388c9',
      '20260521_013353_5c5063',
    ])
  })

  it('includes explicit bridge-linked continuation child ids in represented_session_ids even when the root stayed open', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'open-root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 100,
      ended_at: null,
      end_reason: null,
      message_count: 4,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'late-child',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 160,
      ended_at: null,
      end_reason: null,
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'open-root', role: 'assistant', content: 'Root answer before user follow-up', timestamp: 120 })
    insertMessage(db, { id: 2, session_id: 'open-root', role: 'user', content: 'Why did you skip the memory bootstrap?', timestamp: 130 })
    insertMessage(db, { id: 3, session_id: 'open-root', role: 'assistant', content: 'I should have loaded memory first.', timestamp: 131 })
    insertMessage(db, {
      id: 4,
      session_id: 'late-child',
      role: 'user',
      content: 'Previous conversation context:\nassistant: I should have loaded memory first.\n\nCurrent user message:\ncontinue',
      timestamp: 160,
    })
    insertMessage(db, { id: 5, session_id: 'late-child', role: 'assistant', content: 'Continuing from the earlier session.', timestamp: 161 })
    db.close()

    const linksDb = new DatabaseSync(join(profileDirState.value, 'webui-bridge-links.db'))
    linksDb.exec(`
      CREATE TABLE IF NOT EXISTS bridge_continuation_links (
        child_session_id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL
      )
    `)
    linksDb.prepare(`
      INSERT INTO bridge_continuation_links (child_session_id, parent_session_id)
      VALUES (?, ?)
    `).run('late-child', 'open-root')
    linksDb.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })

    expect(summaries.map((summary: any) => summary.id)).toEqual(['open-root'])
    expect(summaries[0]?.represented_session_ids).toEqual(['open-root', 'late-child'])

    const detail = await mod.getConversationDetailFromDb('open-root', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      'Root answer before user follow-up',
      'Why did you skip the memory bootstrap?',
      'I should have loaded memory first.',
      'continue',
      'Continuing from the earlier session.',
    ])
    expect(detail?.continuation_edges).toEqual([
      {
        child_session_id: 'late-child',
        parent_session_id: 'open-root',
        kind: 'explicit_bridge_link',
      },
    ])
  })

  it('uses explicit bridge continuation links as stronger evidence than raw parent_session_id', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'true-root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'True Root',
      started_at: 100,
      ended_at: 120,
      end_reason: 'tui_shutdown',
      message_count: 1,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'wrong-parent',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'Wrong Parent',
      started_at: 130,
      ended_at: 140,
      end_reason: 'tui_shutdown',
      message_count: 1,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'linked-child-overrides-parent',
      parent_session_id: 'wrong-parent',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'Child',
      started_at: 150,
      ended_at: 160,
      end_reason: 'tui_shutdown',
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'true-root', role: 'assistant', content: 'true root answer', timestamp: 110 })
    insertMessage(db, { id: 2, session_id: 'wrong-parent', role: 'assistant', content: 'wrong parent answer', timestamp: 135 })
    insertMessage(db, { id: 3, session_id: 'linked-child-overrides-parent', role: 'user', content: 'continue true root', timestamp: 150 })
    insertMessage(db, { id: 4, session_id: 'linked-child-overrides-parent', role: 'assistant', content: 'continued under true root', timestamp: 151 })
    db.close()

    const linksDb = new DatabaseSync(join(profileDirState.value, 'webui-bridge-links.db'))
    linksDb.exec(`
      CREATE TABLE IF NOT EXISTS bridge_continuation_links (
        child_session_id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL
      )
    `)
    linksDb.prepare(`
      INSERT INTO bridge_continuation_links (child_session_id, parent_session_id)
      VALUES (?, ?)
    `).run('linked-child-overrides-parent', 'true-root')
    linksDb.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const detail = await mod.getConversationDetailFromDb('true-root', { humanOnly: true })

    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      'true root answer',
      'continue true root',
      'continued under true root',
    ])
    expect(detail?.continuation_edges).toEqual([
      {
        child_session_id: 'linked-child-overrides-parent',
        parent_session_id: 'true-root',
        kind: 'explicit_bridge_link',
      },
    ])

    const wrongParentDetail = await mod.getConversationDetailFromDb('wrong-parent', { humanOnly: true })
    expect(wrongParentDetail?.messages.map((message: any) => message.content)).toEqual(['wrong parent answer'])
  })

  it('does not fallback-infer a bridge prompt child when its explicit bridge link points to a missing web id', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'nearby-root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'Seraphine',
      started_at: 100,
      ended_at: 200,
      end_reason: 'compression',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'prompt-child-with-bad-link',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: null,
      started_at: 250,
      ended_at: 300,
      end_reason: 'tui_shutdown',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'nearby-root', role: 'assistant', content: 'Seraphine 是 LoL 桌面辅助工具。', timestamp: 110 })
    insertMessage(db, {
      id: 2,
      session_id: 'prompt-child-with-bad-link',
      role: 'user',
      content: 'Previous conversation context:\nassistant: Seraphine 是 LoL 桌面辅助工具。\n\nCurrent user message:\n你好',
      timestamp: 250,
    })
    insertMessage(db, { id: 3, session_id: 'prompt-child-with-bad-link', role: 'assistant', content: '你好。', timestamp: 251 })
    db.close()

    const linksDb = new DatabaseSync(join(profileDirState.value, 'webui-bridge-links.db'))
    linksDb.exec(`
      CREATE TABLE IF NOT EXISTS bridge_continuation_links (
        child_session_id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL
      )
    `)
    linksDb.prepare(`
      INSERT INTO bridge_continuation_links (child_session_id, parent_session_id)
      VALUES (?, ?)
    `).run('prompt-child-with-bad-link', 'mpf55a809fa3ij')
    linksDb.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const rootDetail = await mod.getConversationDetailFromDb('nearby-root', { humanOnly: true })
    const childDetail = await mod.getConversationDetailFromDb('prompt-child-with-bad-link', { humanOnly: true })

    expect(rootDetail?.messages.map((message: any) => message.content)).toEqual([
      'Seraphine 是 LoL 桌面辅助工具。',
    ])
    expect(childDetail?.messages.map((message: any) => message.content)).toEqual([
      '你好',
      '你好。',
    ])
  })

  it('does not trust native tui empty-pivot parent chains without descendant bridge evidence', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'test-root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: '中文问候与协助',
      started_at: 100,
      ended_at: 200,
      end_reason: 'compression',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'empty-pivot',
      parent_session_id: 'test-root',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: '中文问候与协助 #2',
      started_at: 201,
      ended_at: 260,
      end_reason: 'compression',
      message_count: 0,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'unrelated-child',
      parent_session_id: 'empty-pivot',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: '中文问候与协助 #3',
      started_at: 261,
      ended_at: 320,
      end_reason: 'tui_shutdown',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'test-root', role: 'user', content: '你好', timestamp: 110 })
    insertMessage(db, { id: 2, session_id: 'test-root', role: 'assistant', content: '你好，我是小七。', timestamp: 120 })
    insertMessage(db, { id: 3, session_id: 'unrelated-child', role: 'user', content: '看看 mysoul/session-aggregation-hardening 分支', timestamp: 270 })
    insertMessage(db, { id: 4, session_id: 'unrelated-child', role: 'assistant', content: '开始检查分支。', timestamp: 271 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const rootDetail = await mod.getConversationDetailFromDb('test-root', { humanOnly: true })
    const childDetail = await mod.getConversationDetailFromDb('unrelated-child', { humanOnly: true })

    expect(rootDetail?.messages.map((message: any) => message.content)).toEqual([
      '你好',
      '你好，我是小七。',
    ])
    expect(childDetail?.messages.map((message: any) => message.content)).toEqual([
      '看看 mysoul/session-aggregation-hardening 分支',
      '开始检查分支。',
    ])
  })

  it('folds long-gap native tui continuations with a unique explicit parent edge into the root mainline', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'native-root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: '看看 mysoul/session-aggregation-hardening',
      started_at: 100,
      ended_at: 200,
      end_reason: 'compression',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'near-cont',
      parent_session_id: 'native-root',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'xAI OAuth',
      started_at: 201,
      ended_at: 260,
      end_reason: 'compression',
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'late-cont',
      parent_session_id: 'native-root',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: '看看 mysoul/session-aggregation-hardening',
      started_at: 12123,
      ended_at: 12200,
      end_reason: 'compression',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertSession(db, {
      id: 'late-grandchild',
      parent_session_id: 'late-cont',
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: '构建验证',
      started_at: 12200.008,
      ended_at: 12300,
      end_reason: 'tui_shutdown',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })

    insertMessage(db, { id: 1, session_id: 'native-root', role: 'user', content: '看看 mysoul/session-aggregation-hardening 分支', timestamp: 110 })
    insertMessage(db, { id: 2, session_id: 'native-root', role: 'assistant', content: '开始检查分支。', timestamp: 120 })
    insertMessage(db, { id: 3, session_id: 'near-cont', role: 'user', content: 'xAI OAuth 怎么接', timestamp: 202 })
    insertMessage(db, { id: 4, session_id: 'near-cont', role: 'assistant', content: 'xAI OAuth 说明。', timestamp: 203 })
    insertMessage(db, { id: 5, session_id: 'late-cont', role: 'user', content: '继续看这个分支', timestamp: 12124 })
    insertMessage(db, { id: 6, session_id: 'late-cont', role: 'assistant', content: '继续检查并修复。', timestamp: 12125 })
    insertMessage(db, {
      id: 7,
      session_id: 'late-grandchild',
      role: 'user',
      content: 'Previous conversation context:\nassistant: 开始检查分支。\nassistant: 继续检查并修复。\n\nCurrent user message:\n继续验证',
      timestamp: 12201,
    })
    insertMessage(db, { id: 8, session_id: 'late-grandchild', role: 'assistant', content: '构建通过。', timestamp: 12202 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['native-root'])
    expect(summaries[0]?.represented_session_ids).toEqual(['native-root', 'near-cont', 'late-cont', 'late-grandchild'])

    const rootDetail = await mod.getConversationDetailFromDb('native-root', { humanOnly: true })
    const childDetail = await mod.getConversationDetailFromDb('late-cont', { humanOnly: true })
    expect(rootDetail?.messages.map((message: any) => message.content)).toEqual([
      '看看 mysoul/session-aggregation-hardening 分支',
      '开始检查分支。',
      'xAI OAuth 怎么接',
      'xAI OAuth 说明。',
      '继续看这个分支',
      '继续检查并修复。',
      '继续验证',
      '构建通过。',
    ])
    expect(childDetail?.messages.map((message: any) => message.content)).toEqual(rootDetail?.messages.map((message: any) => message.content))
    expect(rootDetail?.continuation_edges).toEqual([
      { child_session_id: 'near-cont', parent_session_id: 'native-root', kind: 'native_parent' },
      { child_session_id: 'late-cont', parent_session_id: 'native-root', kind: 'native_parent' },
      { child_session_id: 'late-grandchild', parent_session_id: 'late-cont', kind: 'native_parent' },
    ])
    expect(rootDetail?.branches ?? []).toEqual([])
  })

  it('does not fold ambiguous long-gap native tui siblings without stronger evidence', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)

    insertSession(db, {
      id: 'ambiguous-root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'root',
      started_at: 100,
      ended_at: 200,
      end_reason: 'compression',
      message_count: 2,
      tool_call_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    for (const [id, startedAt, text] of [
      ['late-a', 2000, '第一个长间隔会话'],
      ['late-b', 3000, '第二个长间隔会话'],
    ] as const) {
      insertSession(db, {
        id,
        parent_session_id: 'ambiguous-root',
        source: 'tui',
        model: 'openai/gpt-5.4',
        title: text,
        started_at: startedAt,
        ended_at: startedAt + 100,
        end_reason: 'tui_shutdown',
        message_count: 2,
        tool_call_count: 1,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openai',
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
        cost_status: 'estimated',
      })
    }

    insertMessage(db, { id: 1, session_id: 'ambiguous-root', role: 'user', content: 'root request', timestamp: 110 })
    insertMessage(db, { id: 2, session_id: 'ambiguous-root', role: 'assistant', content: 'root answer', timestamp: 120 })
    insertMessage(db, { id: 3, session_id: 'late-a', role: 'user', content: '第一个长间隔会话', timestamp: 2001 })
    insertMessage(db, { id: 4, session_id: 'late-a', role: 'assistant', content: '第一个回复', timestamp: 2002 })
    insertMessage(db, { id: 5, session_id: 'late-b', role: 'user', content: '第二个长间隔会话', timestamp: 3001 })
    insertMessage(db, { id: 6, session_id: 'late-b', role: 'assistant', content: '第二个回复', timestamp: 3002 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['late-b', 'late-a', 'ambiguous-root'])

    const rootDetail = await mod.getConversationDetailFromDb('ambiguous-root', { humanOnly: true })
    expect(rootDetail?.messages.map((message: any) => message.content)).toEqual([
      'root request',
      'root answer',
    ])
  })

  it('uses explicit conversation edges for mainline order without timestamp fallback', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)
    createLineageSchema(db)

    for (const [id, startedAt, title] of [
      ['edge-root', 300, 'Root title'],
      ['edge-cont', 100, 'Continuation should be second'],
      ['edge-cont-2', 200, 'Continuation should be third'],
    ] as const) {
      insertSession(db, {
        id,
        parent_session_id: null,
        source: 'tui',
        model: 'openai/gpt-5.4',
        title,
        started_at: startedAt,
        ended_at: startedAt + 10,
        end_reason: 'tui_shutdown',
        message_count: 2,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openai',
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
        cost_status: 'estimated',
      })
    }
    insertConversationThread(db, { conversation_id: 'edge-root', root_session_id: 'edge-root' })
    insertConversationEdge(db, { edge_id: 'root-edge', conversation_id: 'edge-root', child_session_id: 'edge-root', edge_type: 'root', created_at: 1 })
    insertConversationEdge(db, { edge_id: 'cont-edge', conversation_id: 'edge-root', parent_session_id: 'edge-root', child_session_id: 'edge-cont', edge_type: 'continues', created_at: 2 })
    insertConversationEdge(db, { edge_id: 'cont-edge-2', conversation_id: 'edge-root', parent_session_id: 'edge-cont', child_session_id: 'edge-cont-2', edge_type: 'continues', created_at: 3 })

    insertMessage(db, { id: 1, session_id: 'edge-root', role: 'user', content: 'root user', timestamp: 300 })
    insertMessage(db, { id: 2, session_id: 'edge-root', role: 'assistant', content: 'root assistant', timestamp: 301 })
    insertMessage(db, { id: 3, session_id: 'edge-cont', role: 'user', content: 'cont user', timestamp: 100 })
    insertMessage(db, { id: 4, session_id: 'edge-cont', role: 'assistant', content: 'cont assistant', timestamp: 101 })
    insertMessage(db, { id: 5, session_id: 'edge-cont-2', role: 'user', content: 'cont2 user', timestamp: 200 })
    insertMessage(db, { id: 6, session_id: 'edge-cont-2', role: 'assistant', content: 'cont2 assistant', timestamp: 201 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['edge-root'])
    expect(summaries[0]?.represented_session_ids).toEqual(['edge-root', 'edge-cont', 'edge-cont-2'])

    const detail = await mod.getConversationDetailFromDb('edge-cont-2', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      'root user',
      'root assistant',
      'cont user',
      'cont assistant',
      'cont2 user',
      'cont2 assistant',
    ])
    expect(detail?.continuation_edges).toEqual([
      { child_session_id: 'edge-cont', parent_session_id: 'edge-root', kind: 'explicit_bridge_link' },
      { child_session_id: 'edge-cont-2', parent_session_id: 'edge-cont', kind: 'explicit_bridge_link' },
    ])
    expect(detail?.branches ?? []).toEqual([])
  })

  it('hides legacy compression continuation child replay of the root opening user message', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)
    for (const [id, parent, startedAt, title, endedAt, endReason] of [
      ['replay-root', null, 100, 'Version check', 200, 'compression'],
      ['replay-cont', 'replay-root', 201, 'Version check #2', null, null],
    ] as const) {
      insertSession(db, {
        id,
        parent_session_id: parent,
        source: 'tui',
        model: 'openai/gpt-5.4',
        title,
        started_at: startedAt,
        ended_at: endedAt,
        end_reason: endReason,
        message_count: 2,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openai',
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
        cost_status: 'estimated',
      })
    }
    insertMessage(db, { id: 1, session_id: 'replay-root', role: 'user', content: '看看hindsight 和hermes agent 有没有发布新版本', timestamp: 101 })
    insertMessage(db, {
      id: 2,
      session_id: 'replay-root',
      role: 'assistant',
      content: '我先查真实来源。',
      tool_calls: JSON.stringify([{ id: 'call_root', function: { name: 'shell', arguments: '{"cmd":"pwd"}' } }]),
      finish_reason: 'tool_calls',
      timestamp: 102,
    })
    insertMessage(db, { id: 20, session_id: 'replay-root', role: 'tool', content: '{"output":"/repo"}', tool_call_id: 'call_root', timestamp: 103 })
    insertMessage(db, { id: 3, session_id: 'replay-cont', role: 'user', content: '看看hindsight 和hermes agent 有没有发布新版本', timestamp: 201 })
    insertMessage(db, {
      id: 4,
      session_id: 'replay-cont',
      role: 'assistant',
      content: '我先查真实来源。',
      tool_calls: JSON.stringify([{ id: 'call_root', function: { name: 'shell', arguments: '{"cmd":"pwd"}' } }]),
      finish_reason: 'tool_calls',
      timestamp: 202,
    })
    insertMessage(db, { id: 21, session_id: 'replay-cont', role: 'tool', content: '[Duplicate tool output — same content as a more recent call]', tool_call_id: 'call_root', timestamp: 202.5 })
    insertMessage(db, { id: 5, session_id: 'replay-cont', role: 'assistant', content: '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below.', timestamp: 203 })
    insertMessage(db, { id: 6, session_id: 'replay-cont', role: 'user', content: '把主 Hermes venv 的 Hindsight 升到 0.6.2', timestamp: 204 })
    insertMessage(db, { id: 7, session_id: 'replay-cont', role: 'assistant', content: '继续升级并验证。', timestamp: 205 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const detail = await mod.getConversationDetailFromDb('replay-cont', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      '看看hindsight 和hermes agent 有没有发布新版本',
      '我先查真实来源。',
      '{"output":"/repo"}',
      '把主 Hermes venv 的 Hindsight 升到 0.6.2',
      '继续升级并验证。',
    ])
    expect(detail?.messages[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call_root', function: { name: 'shell', arguments: '{"cmd":"pwd"}' } }],
      finish_reason: 'tool_calls',
    })
    expect(detail?.messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_root',
    })
  })

  it('keeps a real new user message at the start of an explicit continuation child', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)
    createLineageSchema(db)

    for (const [id, parent, startedAt] of [
      ['real-user-root', null, 100],
      ['real-user-cont', 'real-user-root', 200],
    ] as const) {
      insertSession(db, {
        id,
        parent_session_id: parent,
        source: 'tui',
        model: 'openai/gpt-5.4',
        title: id,
        started_at: startedAt,
        ended_at: startedAt + 10,
        end_reason: 'tui_shutdown',
        message_count: 2,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openai',
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
        cost_status: 'estimated',
      })
    }
    insertConversationThread(db, { conversation_id: 'real-user-root', root_session_id: 'real-user-root' })
    insertConversationEdge(db, { edge_id: 'real-user-root-edge', conversation_id: 'real-user-root', child_session_id: 'real-user-root', edge_type: 'root', created_at: 1 })
    insertConversationEdge(db, { edge_id: 'real-user-cont-edge', conversation_id: 'real-user-root', parent_session_id: 'real-user-root', child_session_id: 'real-user-cont', edge_type: 'continues', created_at: 2 })

    insertMessage(db, { id: 1, session_id: 'real-user-root', role: 'user', content: 'root opening question', timestamp: 101 })
    insertMessage(db, { id: 2, session_id: 'real-user-root', role: 'assistant', content: 'root answer', timestamp: 102 })
    insertMessage(db, { id: 3, session_id: 'real-user-cont', role: 'user', content: 'new follow-up question', timestamp: 201 })
    insertMessage(db, { id: 4, session_id: 'real-user-cont', role: 'assistant', content: 'new follow-up answer', timestamp: 202 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const detail = await mod.getConversationDetailFromDb('real-user-cont', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      'root opening question',
      'root answer',
      'new follow-up question',
      'new follow-up answer',
    ])
  })

  it('inserts persisted steer UI events after their explicit graph anchor', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)
    createLineageSchema(db)

    for (const [id, startedAt] of [
      ['steer-root', 100],
      ['steer-cont', 200],
    ] as const) {
      insertSession(db, {
        id,
        parent_session_id: null,
        source: 'tui',
        model: 'openai/gpt-5.4',
        title: id,
        started_at: startedAt,
        ended_at: startedAt + 10,
        end_reason: 'tui_shutdown',
        message_count: 2,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openai',
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
        cost_status: 'estimated',
      })
    }
    insertConversationThread(db, { conversation_id: 'steer-root', root_session_id: 'steer-root' })
    insertConversationEdge(db, { edge_id: 'steer-root-edge', conversation_id: 'steer-root', child_session_id: 'steer-root', edge_type: 'root', created_at: 1 })
    insertConversationEdge(db, { edge_id: 'steer-cont-edge', conversation_id: 'steer-root', parent_session_id: 'steer-root', child_session_id: 'steer-cont', edge_type: 'continues', created_at: 2 })
    insertMessage(db, { id: 1, session_id: 'steer-root', role: 'user', content: 'root user', timestamp: 101 })
    insertMessage(db, { id: 2, session_id: 'steer-root', role: 'assistant', content: 'root assistant', timestamp: 102 })
    insertMessage(db, { id: 3, session_id: 'steer-cont', role: 'user', content: 'cont user', timestamp: 201 })
    insertMessage(db, { id: 4, session_id: 'steer-cont', role: 'assistant', content: 'cont assistant', timestamp: 202 })
    insertConversationUiEvent(db, {
      event_id: 'steer-event-1',
      conversation_id: 'steer-root',
      event_type: 'steer',
      source_session_id: 'steer-cont',
      anchor_session_id: 'steer-cont',
      anchor_after_message_id: '3',
      content: '调整方向',
      created_at: 203,
    })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const rootDetail = await mod.getConversationDetailFromDb('steer-root', { humanOnly: true })
    const childDetail = await mod.getConversationDetailFromDb('steer-cont', { humanOnly: true })
    expect(rootDetail?.messages.map((message: any) => message.content)).toEqual([
      'root user',
      'root assistant',
      'cont user',
      '调整方向',
      'cont assistant',
    ])
    expect(childDetail?.messages).toEqual(rootDetail?.messages)
    const steer = rootDetail?.messages.find((message: any) => message.content === '调整方向') as any
    expect(steer).toMatchObject({
      id: 'ui.steer.steer-event-1',
      role: 'user',
      session_id: 'steer-cont',
      steered: true,
      ui_event_id: 'steer-event-1',
    })
  })

  it('keeps multiple persisted steer UI events with the same anchor in stable order', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)
    createLineageSchema(db)
    insertSession(db, {
      id: 'multi-steer-root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'multi',
      started_at: 100,
      ended_at: 200,
      end_reason: 'tui_shutdown',
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertConversationThread(db, { conversation_id: 'multi-steer-root', root_session_id: 'multi-steer-root' })
    insertConversationEdge(db, { edge_id: 'multi-root-edge', conversation_id: 'multi-steer-root', child_session_id: 'multi-steer-root', edge_type: 'root', created_at: 1 })
    insertMessage(db, { id: 1, session_id: 'multi-steer-root', role: 'user', content: 'user', timestamp: 101 })
    insertMessage(db, { id: 2, session_id: 'multi-steer-root', role: 'assistant', content: 'assistant', timestamp: 102 })
    insertConversationUiEvent(db, {
      event_id: 'steer-b',
      conversation_id: 'multi-steer-root',
      event_type: 'steer',
      source_session_id: 'multi-steer-root',
      anchor_session_id: 'multi-steer-root',
      anchor_after_message_id: '1',
      content: 'second steer',
      created_at: 104,
    })
    insertConversationUiEvent(db, {
      event_id: 'steer-a',
      conversation_id: 'multi-steer-root',
      event_type: 'steer',
      source_session_id: 'multi-steer-root',
      anchor_session_id: 'multi-steer-root',
      anchor_after_message_id: '1',
      content: 'first steer',
      created_at: 103,
    })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const detail = await mod.getConversationDetailFromDb('multi-steer-root', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      'user',
      'first steer',
      'second steer',
      'assistant',
    ])
  })

  it('places persisted steer UI events at the source segment end when anchor is hidden or missing', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)
    createLineageSchema(db)
    insertSession(db, {
      id: 'hidden-anchor-root',
      parent_session_id: null,
      source: 'tui',
      model: 'openai/gpt-5.4',
      title: 'hidden',
      started_at: 100,
      ended_at: 200,
      end_reason: 'tui_shutdown',
      message_count: 3,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: 'openai',
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      cost_status: 'estimated',
    })
    insertConversationThread(db, { conversation_id: 'hidden-anchor-root', root_session_id: 'hidden-anchor-root' })
    insertConversationEdge(db, { edge_id: 'hidden-root-edge', conversation_id: 'hidden-anchor-root', child_session_id: 'hidden-anchor-root', edge_type: 'root', created_at: 1 })
    insertMessage(db, { id: 1, session_id: 'hidden-anchor-root', role: 'user', content: 'visible user', timestamp: 101 })
    insertMessage(db, { id: 2, session_id: 'hidden-anchor-root', role: 'assistant', content: 'visible assistant', timestamp: 102 })
    insertMessage(db, { id: 3, session_id: 'hidden-anchor-root', role: 'user', content: '[system: hidden anchor]', timestamp: 103 })
    insertConversationUiEvent(db, {
      event_id: 'hidden-steer',
      conversation_id: 'hidden-anchor-root',
      event_type: 'steer',
      source_session_id: 'hidden-anchor-root',
      anchor_session_id: 'hidden-anchor-root',
      anchor_after_message_id: '3',
      content: 'hidden anchor steer',
      created_at: 104,
    })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const detail = await mod.getConversationDetailFromDb('hidden-anchor-root', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      'visible user',
      'visible assistant',
      'hidden anchor steer',
    ])
  })

  it('does not mix similar parentless bridge prompts into an explicit graph', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)
    createLineageSchema(db)

    for (const [id, startedAt, title] of [
      ['explicit-root', 100, 'shared title'],
      ['explicit-cont', 200, 'shared title'],
      ['similar-prompt', 210, 'shared title'],
    ] as const) {
      insertSession(db, {
        id,
        parent_session_id: null,
        source: 'tui',
        model: 'openai/gpt-5.4',
        title,
        started_at: startedAt,
        ended_at: startedAt + 10,
        end_reason: 'tui_shutdown',
        message_count: 2,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openai',
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
        cost_status: 'estimated',
      })
    }
    insertConversationThread(db, { conversation_id: 'explicit-root', root_session_id: 'explicit-root' })
    insertConversationEdge(db, { edge_id: 'explicit-root-edge', conversation_id: 'explicit-root', child_session_id: 'explicit-root', edge_type: 'root', created_at: 1 })
    insertConversationEdge(db, { edge_id: 'explicit-cont-edge', conversation_id: 'explicit-root', parent_session_id: 'explicit-root', child_session_id: 'explicit-cont', edge_type: 'continues', created_at: 2 })

    insertMessage(db, { id: 1, session_id: 'explicit-root', role: 'user', content: 'root request', timestamp: 101 })
    insertMessage(db, { id: 2, session_id: 'explicit-root', role: 'assistant', content: 'root answer', timestamp: 102 })
    insertMessage(db, {
      id: 7,
      session_id: 'explicit-root',
      role: 'assistant',
      content: '',
      tool_calls: JSON.stringify([{ id: 'call-explicit-1', type: 'function', function: { name: 'terminal', arguments: '{"command":"pwd"}' } }]),
      finish_reason: 'tool_calls',
      reasoning_content: 'checking workspace',
      timestamp: 103,
    })
    insertMessage(db, {
      id: 8,
      session_id: 'explicit-root',
      role: 'tool',
      content: '{"output":"/repo","exit_code":0}',
      tool_call_id: 'call-explicit-1',
      tool_name: 'terminal',
      timestamp: 104,
    })
    insertMessage(db, { id: 3, session_id: 'explicit-cont', role: 'user', content: 'continue request', timestamp: 201 })
    insertMessage(db, { id: 4, session_id: 'explicit-cont', role: 'assistant', content: 'continue answer', timestamp: 202 })
    insertMessage(db, {
      id: 5,
      session_id: 'similar-prompt',
      role: 'user',
      content: 'Previous conversation context:\nassistant: root answer\n\nCurrent user message:\nwrong prompt',
      timestamp: 211,
    })
    insertMessage(db, { id: 6, session_id: 'similar-prompt', role: 'assistant', content: 'wrong answer', timestamp: 212 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const rootDetail = await mod.getConversationDetailFromDb('explicit-root', { humanOnly: true })
    const promptDetail = await mod.getConversationDetailFromDb('similar-prompt', { humanOnly: true })
    expect(rootDetail?.messages.map((message: any) => message.content)).toEqual([
      'root request',
      'root answer',
      '',
      '{"output":"/repo","exit_code":0}',
      'continue request',
      'continue answer',
    ])
    expect(rootDetail?.messages[2]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call-explicit-1', type: 'function', function: { name: 'terminal', arguments: '{"command":"pwd"}' } }],
      finish_reason: 'tool_calls',
      reasoning: 'checking workspace',
    })
    expect(rootDetail?.messages[3]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-explicit-1',
      tool_name: 'terminal',
      content: '{"output":"/repo","exit_code":0}',
    })
    expect(promptDetail?.messages.map((message: any) => message.content)).toEqual([
      'wrong prompt',
      'wrong answer',
    ])
  })

  it('falls back when explicit graph is incomplete or cyclic', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)
    createLineageSchema(db)

    for (const id of ['fallback-root', 'fallback-child']) {
      insertSession(db, {
        id,
        parent_session_id: id === 'fallback-child' ? 'fallback-root' : null,
        source: 'tui',
        model: 'openai/gpt-5.4',
        title: id,
        started_at: id === 'fallback-root' ? 100 : 201,
        ended_at: id === 'fallback-root' ? 200 : 300,
        end_reason: 'compression',
        message_count: 2,
        tool_call_count: 1,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openai',
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
        cost_status: 'estimated',
      })
    }
    insertConversationThread(db, { conversation_id: 'fallback-root', root_session_id: 'fallback-root' })
    insertConversationEdge(db, { edge_id: 'fallback-root-edge', conversation_id: 'fallback-root', child_session_id: 'fallback-root', edge_type: 'root', created_at: 1 })
    insertConversationEdge(db, { edge_id: 'missing-edge', conversation_id: 'fallback-root', parent_session_id: 'fallback-root', child_session_id: 'missing-child', edge_type: 'continues', created_at: 2 })
    insertMessage(db, { id: 1, session_id: 'fallback-root', role: 'user', content: 'fallback root', timestamp: 101 })
    insertMessage(db, { id: 2, session_id: 'fallback-root', role: 'assistant', content: 'fallback root answer', timestamp: 102 })
    insertMessage(db, { id: 3, session_id: 'fallback-child', role: 'user', content: 'fallback child', timestamp: 202 })
    insertMessage(db, { id: 4, session_id: 'fallback-child', role: 'assistant', content: 'fallback child answer', timestamp: 203 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const detail = await mod.getConversationDetailFromDb('fallback-root', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      'fallback root',
      'fallback root answer',
      'fallback child',
      'fallback child answer',
    ])
  })

  it('rejects explicit graphs with double parent or double continues child and falls back', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)
    createLineageSchema(db)

    for (const id of ['double-root', 'double-a', 'double-b']) {
      insertSession(db, {
        id,
        parent_session_id: null,
        source: 'tui',
        model: 'openai/gpt-5.4',
        title: id,
        started_at: id === 'double-root' ? 100 : id === 'double-a' ? 201 : 301,
        ended_at: id === 'double-root' ? 200 : id === 'double-a' ? 250 : 350,
        end_reason: 'tui_shutdown',
        message_count: 2,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openai',
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
        cost_status: 'estimated',
      })
      insertMessage(db, { id: id === 'double-root' ? 1 : id === 'double-a' ? 3 : 5, session_id: id, role: 'user', content: `${id} user`, timestamp: id === 'double-root' ? 101 : id === 'double-a' ? 202 : 302 })
      insertMessage(db, { id: id === 'double-root' ? 2 : id === 'double-a' ? 4 : 6, session_id: id, role: 'assistant', content: `${id} assistant`, timestamp: id === 'double-root' ? 102 : id === 'double-a' ? 203 : 303 })
    }
    insertConversationThread(db, { conversation_id: 'double-root', root_session_id: 'double-root' })
    insertConversationEdge(db, { edge_id: 'double-root-edge', conversation_id: 'double-root', child_session_id: 'double-root', edge_type: 'root', created_at: 1 })
    insertConversationEdge(db, { edge_id: 'double-a-edge', conversation_id: 'double-root', parent_session_id: 'double-root', child_session_id: 'double-a', edge_type: 'continues', created_at: 2 })
    insertConversationEdge(db, { edge_id: 'double-b-edge', conversation_id: 'double-root', parent_session_id: 'double-root', child_session_id: 'double-b', edge_type: 'continues', created_at: 3 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const detail = await mod.getConversationDetailFromDb('double-root', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      'double-root user',
      'double-root assistant',
    ])
  })

  it('keeps explicit branch edges out of the mainline', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)
    createLineageSchema(db)

    for (const [id, source, parent] of [
      ['branch-root', 'tui', null],
      ['branch-cont', 'tui', null],
      ['branch-agent', 'subagent', 'branch-root'],
    ] as const) {
      insertSession(db, {
        id,
        parent_session_id: parent,
        source,
        model: 'openai/gpt-5.4',
        title: id,
        started_at: id === 'branch-root' ? 100 : id === 'branch-cont' ? 200 : 150,
        ended_at: id === 'branch-root' ? 180 : id === 'branch-cont' ? 260 : 170,
        end_reason: 'tui_shutdown',
        message_count: 2,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openai',
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
        cost_status: 'estimated',
      })
    }
    insertConversationThread(db, { conversation_id: 'branch-root', root_session_id: 'branch-root' })
    insertConversationEdge(db, { edge_id: 'branch-root-edge', conversation_id: 'branch-root', child_session_id: 'branch-root', edge_type: 'root', created_at: 1 })
    insertConversationEdge(db, { edge_id: 'branch-cont-edge', conversation_id: 'branch-root', parent_session_id: 'branch-root', child_session_id: 'branch-cont', edge_type: 'continues', created_at: 2 })
    insertConversationEdge(db, { edge_id: 'branch-agent-edge', conversation_id: 'branch-root', parent_session_id: 'branch-root', child_session_id: 'branch-agent', edge_type: 'subagent', created_at: 3 })
    insertMessage(db, { id: 1, session_id: 'branch-root', role: 'user', content: 'root user', timestamp: 101 })
    insertMessage(db, { id: 2, session_id: 'branch-root', role: 'assistant', content: 'root assistant', timestamp: 102 })
    insertMessage(db, { id: 3, session_id: 'branch-cont', role: 'user', content: 'cont user', timestamp: 201 })
    insertMessage(db, { id: 4, session_id: 'branch-cont', role: 'assistant', content: 'cont assistant', timestamp: 202 })
    insertMessage(db, { id: 5, session_id: 'branch-agent', role: 'user', content: 'agent user', timestamp: 151 })
    insertMessage(db, { id: 6, session_id: 'branch-agent', role: 'assistant', content: 'agent assistant', timestamp: 152 })
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const detail = await mod.getConversationDetailFromDb('branch-cont', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      'root user',
      'root assistant',
      'cont user',
      'cont assistant',
    ])
    expect(detail?.branches?.map((branch: any) => branch.session_id)).toEqual(['branch-agent'])
    expect(detail?.branch_session_count).toBe(1)
  })
})
