import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const profileDirState = vi.hoisted(() => ({ value: '' }))
const profileNameState = vi.hoisted(() => ({ value: 'default' }))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileDir: () => profileDirState.value,
  getActiveProfileName: () => profileNameState.value,
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
      api_call_count INTEGER DEFAULT 0
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
    model: 'openai/gpt-5.4',
    model_config: null,
    system_prompt: null,
    parent_session_id: null,
    ended_at: null,
    end_reason: null,
    message_count: 0,
    tool_call_count: 0,
    input_tokens: 1,
    output_tokens: 1,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: 'openai',
    billing_base_url: null,
    billing_mode: null,
    estimated_cost_usd: 0,
    actual_cost_usd: 0,
    cost_status: 'estimated',
    cost_source: null,
    pricing_version: null,
    title: null,
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

function seedRootAndContinuation(db: any, rootId = '20260523_015558_parent', childId = '20260523_023356_child') {
  insertSession(db, {
    id: rootId,
    source: 'tui',
    title: 'lineage root',
    started_at: 1000,
    ended_at: 1100,
    end_reason: 'tui_shutdown',
    message_count: 2,
  })
  insertMessage(db, {
    id: 1,
    session_id: rootId,
    role: 'user',
    content: 'start lineage repair',
    timestamp: 1001,
  })
  insertMessage(db, {
    id: 2,
    session_id: rootId,
    role: 'assistant',
    content: 'anchor reply uniquely belongs to the 015558 parent session',
    timestamp: 1002,
  })

  insertSession(db, {
    id: childId,
    source: 'tui',
    title: 'lineage child',
    started_at: 1200,
    ended_at: 1300,
    end_reason: 'tui_shutdown',
    message_count: 2,
  })
  insertMessage(db, {
    id: 3,
    session_id: childId,
    role: 'user',
    content: 'Previous conversation context:\nassistant: anchor reply uniquely belongs to the 015558 parent session\n\nCurrent user message:\ncontinue from 023356',
    timestamp: 1201,
  })
  insertMessage(db, {
    id: 4,
    session_id: childId,
    role: 'assistant',
    content: '023356 continuation content',
    timestamp: 1202,
  })
}

function seedCompressionParentStubAndContinuation(
  db: any,
  options: {
    parentEndReason?: string
    stubMessageCount?: number
    stubToolCallCount?: number
    stubTitle?: string | null
    stubMessages?: Array<Record<string, unknown>>
    descendant?: boolean
  } = {},
) {
  insertSession(db, {
    id: '20260524_015558_parent',
    source: 'tui',
    title: 'compression parent',
    started_at: 1000,
    ended_at: 1100,
    end_reason: options.parentEndReason ?? 'compression',
    message_count: 2,
  })
  insertMessage(db, {
    id: 10,
    session_id: '20260524_015558_parent',
    role: 'user',
    content: 'start compression parent',
    timestamp: 1001,
  })
  insertMessage(db, {
    id: 11,
    session_id: '20260524_015558_parent',
    role: 'assistant',
    content: 'native compression anchor reply uniquely identifies parent 015558',
    timestamp: 1002,
  })
  insertSession(db, {
    id: '20260524_024035_9ac600',
    source: 'tui',
    title: options.stubTitle ?? null,
    parent_session_id: '20260524_015558_parent',
    started_at: 1100.5,
    ended_at: 1101,
    end_reason: 'tui_shutdown',
    message_count: options.stubMessageCount ?? 0,
    tool_call_count: options.stubToolCallCount ?? 0,
  })
  for (const [index, message] of (options.stubMessages ?? []).entries()) {
    insertMessage(db, {
      id: 20 + index,
      session_id: '20260524_024035_9ac600',
      role: 'assistant',
      content: 'stub content',
      timestamp: 1100.6 + index,
      ...message,
    })
  }
  if (options.descendant) {
    insertSession(db, {
      id: '20260524_stub_descendant',
      source: 'tui',
      parent_session_id: '20260524_024035_9ac600',
      started_at: 1102,
      ended_at: 1103,
      end_reason: 'tui_shutdown',
      message_count: 1,
    })
    insertMessage(db, {
      id: 30,
      session_id: '20260524_stub_descendant',
      role: 'assistant',
      content: 'stub descendant content',
      timestamp: 1102,
    })
  }
  insertSession(db, {
    id: '20260524_repair_child',
    source: 'tui',
    title: 'lineage repair child',
    started_at: 1200,
    ended_at: 1300,
    end_reason: 'tui_shutdown',
    message_count: 2,
  })
  insertMessage(db, {
    id: 40,
    session_id: '20260524_repair_child',
    role: 'user',
    content: 'Previous conversation context:\nassistant: native compression anchor reply uniquely identifies parent 015558\n\nCurrent user message:\ncontinue after empty native stub',
    timestamp: 1201,
  })
  insertMessage(db, {
    id: 41,
    session_id: '20260524_repair_child',
    role: 'assistant',
    content: 'repair child continuation content',
    timestamp: 1202,
  })
}

describe('server-side lineage audit repair', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-24T00:00:00Z'))
    profileNameState.value = 'default'
    profileDirState.value = mkdtempSync(join(tmpdir(), 'hwui-lineage-audit-'))
    process.env.HERMES_TEST_DB_DIR = join(profileDirState.value, 'webui-db')
    mkdirSync(process.env.HERMES_TEST_DB_DIR, { recursive: true })
  })

  afterEach(async () => {
    vi.useRealTimers()
    delete process.env.HERMES_TEST_DB_DIR
    try {
      const conversationsDbModule = await import('../../packages/server/src/db/hermes/conversations-db')
      conversationsDbModule.clearCanonicalConversationFactsCache()
      conversationsDbModule.resetCanonicalConversationFactsCacheStats()
    } catch {
      // Best-effort cleanup for tests that never imported the conversation DB.
    }
    try {
      const dbModule = await import('../../packages/server/src/db')
      dbModule.closeDb()
    } catch {
      // Best-effort cleanup for tests that never touched the WebUI DB.
    }
    if (profileDirState.value) rmSync(profileDirState.value, { recursive: true, force: true })
  })

  it('audits a repairable parentless TUI bridge-context continuation without writing DB facts by default', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)
    seedRootAndContinuation(db)
    db.close()

    const { auditTuiContinuationLineage } = await import('../../packages/server/src/services/hermes/lineage-audit-repair')
    const result = auditTuiContinuationLineage({ childSessionId: '20260523_023356_child' })

    expect(result).toMatchObject({
      status: 'repairable',
      dryRun: true,
      childSessionId: '20260523_023356_child',
      parentSessionId: '20260523_015558_parent',
      conversationId: '20260523_015558_parent',
    })

    const { listSessionLineage } = await import('../../packages/server/src/db/hermes/session-lineage')
    expect(listSessionLineage()).toEqual([])
    const { readBridgeContinuationLinks } = await import('../../packages/server/src/services/hermes/bridge-continuation-links')
    expect(readBridgeContinuationLinks()).toEqual({})
  })

  it('refuses repair when the bridge context strongly matches multiple candidate parents', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)
    seedRootAndContinuation(db)
    insertSession(db, {
      id: '20260523_015558_duplicate',
      source: 'tui',
      title: 'duplicate lineage root',
      started_at: 900,
      ended_at: 950,
      end_reason: 'tui_shutdown',
      message_count: 1,
    })
    insertMessage(db, {
      id: 5,
      session_id: '20260523_015558_duplicate',
      role: 'assistant',
      content: 'anchor reply uniquely belongs to the 015558 parent session',
      timestamp: 901,
    })
    db.close()

    const { repairTuiContinuationLineage } = await import('../../packages/server/src/services/hermes/lineage-audit-repair')
    const result = repairTuiContinuationLineage({ childSessionId: '20260523_023356_child', dryRun: false })

    expect(result).toMatchObject({
      status: 'rejected',
      dryRun: false,
      reason: 'multiple-anchor-candidates',
      childSessionId: '20260523_023356_child',
    })
  })

  it('allows an empty native compression stub without treating it as a branch conflict', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)
    seedCompressionParentStubAndContinuation(db)
    db.close()

    const { auditTuiContinuationLineage } = await import('../../packages/server/src/services/hermes/lineage-audit-repair')
    const result = auditTuiContinuationLineage({ childSessionId: '20260524_repair_child' })

    expect(result).toMatchObject({
      status: 'repairable',
      childSessionId: '20260524_repair_child',
      parentSessionId: '20260524_015558_parent',
      conversationId: '20260524_015558_parent',
    })
  })

  it('requires manual review when the anchor parent has raw tool activity after the child starts', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)
    seedRootAndContinuation(db)
    db.prepare(`
      UPDATE sessions
      SET ended_at = 1300, tool_call_count = 1, message_count = 3
      WHERE id = ?
    `).run('20260523_015558_parent')
    insertMessage(db, {
      id: 5,
      session_id: '20260523_015558_parent',
      role: 'tool',
      content: '{"ok":true}',
      tool_call_id: 'call-after-child-start',
      tool_name: 'shell',
      timestamp: 1250,
    })
    db.close()

    const { repairTuiContinuationLineage } = await import('../../packages/server/src/services/hermes/lineage-audit-repair')
    const result = repairTuiContinuationLineage({
      childSessionId: '20260523_023356_child',
      dryRun: false,
      nowSeconds: 1779588000,
    })

    expect(result).toMatchObject({
      status: 'rejected',
      dryRun: false,
      reason: 'manual-review-required',
      diagnostic: 'overlap-with-parent-activity',
      childSessionId: '20260523_023356_child',
      parentSessionId: '20260523_015558_parent',
      evidence: {
        anchorParentSessionId: '20260523_015558_parent',
        childStartedAt: 1200,
        parentEndedAt: 1300,
        parentLastVisibleDbMessageAt: 1002,
        parentRawJsonActivityAfterChildStart: true,
        parentRawJsonActivityAfterChildStartAt: 1250,
        parentToolActivityAfterChildStart: true,
        parentToolActivityAfterChildStartAt: 1250,
      },
    })

    const { listSessionLineage } = await import('../../packages/server/src/db/hermes/session-lineage')
    expect(listSessionLineage()).toEqual([])
    const { readBridgeContinuationLinks } = await import('../../packages/server/src/services/hermes/bridge-continuation-links')
    expect(readBridgeContinuationLinks()).toEqual({})
  })

  it('rejects a non-empty native child as a branch conflict', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)
    seedCompressionParentStubAndContinuation(db, {
      stubMessageCount: 1,
      stubMessages: [{ content: 'real native child content' }],
    })
    db.close()

    const { auditTuiContinuationLineage } = await import('../../packages/server/src/services/hermes/lineage-audit-repair')
    const result = auditTuiContinuationLineage({ childSessionId: '20260524_repair_child' })

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'branch-or-subagent-conflict',
      childSessionId: '20260524_repair_child',
    })
  })

  it('rejects an empty native compression stub with descendants as a branch conflict', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)
    seedCompressionParentStubAndContinuation(db, { descendant: true })
    db.close()

    const { auditTuiContinuationLineage } = await import('../../packages/server/src/services/hermes/lineage-audit-repair')
    const result = auditTuiContinuationLineage({ childSessionId: '20260524_repair_child' })

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'branch-or-subagent-conflict',
      childSessionId: '20260524_repair_child',
    })
  })

  it('rejects an empty native stub without a compression parent as a branch conflict', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)
    seedCompressionParentStubAndContinuation(db, { parentEndReason: 'tui_shutdown' })
    db.close()

    const { auditTuiContinuationLineage } = await import('../../packages/server/src/services/hermes/lineage-audit-repair')
    const result = auditTuiContinuationLineage({ childSessionId: '20260524_repair_child' })

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'branch-or-subagent-conflict',
      childSessionId: '20260524_repair_child',
    })
  })

  it('writes explicit lineage facts so summary and detail merge the 023356 continuation into the 015558 root', async () => {
    ensureSqliteAvailable()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(profileDirState.value, 'state.db'))
    createSchema(db)
    seedRootAndContinuation(db)
    db.close()

    const { repairTuiContinuationLineage } = await import('../../packages/server/src/services/hermes/lineage-audit-repair')
    const repair = repairTuiContinuationLineage({
      childSessionId: '20260523_023356_child',
      dryRun: false,
      nowSeconds: 1779588000,
    })

    expect(repair).toMatchObject({
      status: 'repaired',
      dryRun: false,
      parentSessionId: '20260523_015558_parent',
      conversationId: '20260523_015558_parent',
    })

    const { listSessionLineage } = await import('../../packages/server/src/db/hermes/session-lineage')
    expect(listSessionLineage()).toEqual([
      expect.objectContaining({
        session_id: '20260523_023356_child',
        logical_conversation_id: '20260523_015558_parent',
        authority: 'explicit',
        relation_kind: 'continuation',
        parent_session_id: '20260523_015558_parent',
        root_session_id: '20260523_015558_parent',
      }),
    ])

    const { readBridgeContinuationLinks } = await import('../../packages/server/src/services/hermes/bridge-continuation-links')
    expect(readBridgeContinuationLinks()).toEqual({
      '20260523_023356_child': '20260523_015558_parent',
    })

    const conversationsDb = await import('../../packages/server/src/db/hermes/conversations-db')
    const summaries = await conversationsDb.listConversationSummariesFromDb({ source: 'tui', humanOnly: true })
    expect(summaries.map(summary => summary.id)).toEqual(['20260523_015558_parent'])
    expect(summaries[0]?.represented_session_ids).toEqual([
      '20260523_015558_parent',
      '20260523_023356_child',
    ])

    const detail = await conversationsDb.getConversationDetailFromDb('20260523_015558_parent', { source: 'tui', humanOnly: true })
    expect(detail?.represented_session_ids).toEqual([
      '20260523_015558_parent',
      '20260523_023356_child',
    ])
    expect(detail?.messages.map(message => message.content)).toContain('023356 continuation content')
  })
})
