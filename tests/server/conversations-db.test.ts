import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const profileDirState = vi.hoisted(() => ({ value: '' }))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileDir: () => profileDirState.value,
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

  it('folds parentless bridge context continuations into the latest continuation conversation', async () => {
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
    expect(summaries.map((summary: any) => summary.id)).toEqual(['cont-2'])

    const detail = await mod.getConversationDetailFromDb('cont-2', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual(['continue two', 'continuation two answer'])
    expect(detail?.branches?.map((branch: any) => branch.session_id)).toEqual(['cont-1'])
    expect(detail?.branches?.[0]?.messages.map((message: any) => message.content)).toEqual([
      'continue one',
      'continuation one answer',
    ])
    expect(detail?.branches?.[0]?.branches?.map((branch: any) => branch.session_id)).toEqual(['root'])
    expect(detail?.branches?.[0]?.branches?.[0]?.messages.map((message: any) => message.content)).toEqual([
      'root request',
      'root answer',
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
      id: 'root-cont',
      title: 'Continuation',
      started_at: 110,
      thread_session_count: 1,
      branch_session_count: 1,
      ended_at: 111,
      cost_status: 'final',
      actual_cost_usd: 0.2,
    }))

    const detailFromTip = await mod.getConversationDetailFromDb('root-cont', { humanOnly: true })
    expect(detailFromTip?.session_id).toBe('root-cont')
    expect(detailFromTip?.thread_session_count).toBe(1)
    expect(detailFromTip?.messages.map((message: any) => message.content)).toEqual([
      'Continue with more detail',
      'Continued answer',
    ])
    expect(detailFromTip?.branches?.map((branch: any) => branch.session_id)).toEqual(['root'])
    expect(detailFromTip?.branches?.[0]?.messages.map((message: any) => message.content)).toEqual([
      'Start here',
      'Assistant reply',
    ])

    const detailFromRoot = await mod.getConversationDetailFromDb('root', { humanOnly: true })
    expect(detailFromRoot).toBeNull()
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
    expect(summaries.map((summary: any) => summary.id)).toEqual(['orphan-cont'])
    expect(summaries[0]).toMatchObject({
      started_at: 111,
      thread_session_count: 1,
      branch_session_count: 1,
      input_tokens: 3,
      output_tokens: 4,
    })

    const detail = await mod.getConversationDetailFromDb('orphan-cont', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.session_id)).toEqual(['orphan-cont'])
    expect(detail?.branches?.map((branch: any) => branch.session_id)).toEqual(['root'])
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
    db.close()

    const mod = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await mod.listConversationSummariesFromDb({ humanOnly: true })
    expect(summaries.map((summary: any) => summary.id)).toEqual(['duplicate-cont'])
    expect(summaries[0]).toMatchObject({
      started_at: 200,
      thread_session_count: 1,
      branch_session_count: 1,
    })

    const detail = await mod.getConversationDetailFromDb('duplicate-cont', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.session_id)).toEqual(['duplicate-cont'])
    expect(detail?.branches?.map((branch: any) => branch.session_id)).toEqual(['root'])
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
      ended_at: 200,
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
    expect(summaries.map((summary: any) => summary.id)).toEqual(['tip'])
    expect(summaries[0]).toMatchObject({
      thread_session_count: 1,
      branch_session_count: 2,
      input_tokens: 3,
      output_tokens: 4,
    })

    const detail = await mod.getConversationDetailFromDb('tip', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.session_id)).toEqual(['tip'])
    expect(detail?.branches?.map((branch: any) => branch.session_id)).toEqual(['root', 'bridge-duplicate'])
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
    expect(summaries.map((summary: any) => summary.id)).toEqual(['context-continuation'])

    const rootDetail = await mod.getConversationDetailFromDb('root', { humanOnly: true })
    expect(rootDetail).toBeNull()

    const detail = await mod.getConversationDetailFromDb('context-continuation', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual(['continue branch'])
    expect(detail?.branches?.map((branch: any) => branch.session_id)).toEqual(['branch-placeholder'])
    expect(detail?.branches?.[0]?.messages.map((message: any) => message.content)).toEqual([
      'branch work before compaction',
    ])
    expect(detail?.branches?.[0]?.branches?.map((branch: any) => branch.session_id)).toEqual(['root'])
    expect(detail?.branches?.[0]?.branches?.[0]?.messages.map((message: any) => message.content)).toEqual([
      'root request',
    ])
  })

  it('treats branched children as their own visible conversations', async () => {
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
    expect(summaries.map((summary: any) => summary.id)).toEqual(['branch-child', 'root'])

    const detail = await mod.getConversationDetailFromDb('branch-child', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual(['Branch prompt', 'Branch answer'])
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

  it('keeps non-compression child sessions visible instead of hiding them under their parent', async () => {
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

    const detail = await mod.getConversationDetailFromDb('review-child', { humanOnly: true })
    expect(detail).toBeNull()
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
      messages: [],
      visible_count: 0,
      thread_session_count: 1,
    })
  })
})
