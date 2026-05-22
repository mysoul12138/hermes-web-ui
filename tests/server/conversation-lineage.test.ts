import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('conversation lineage store', () => {
  let db: import('node:sqlite').DatabaseSync | null = null

  beforeEach(async () => {
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
  })

  afterEach(() => {
    db?.close()
    db = null
  })

  function getDb(): import('node:sqlite').DatabaseSync {
    if (!db) throw new Error('test db not initialized')
    return db
  }

  it('initializes lightweight lineage tables without body projection tables', async () => {
    const {
      ensureConversationLineageTables,
    } = await import('../../packages/server/src/db/hermes/conversation-lineage')

    ensureConversationLineageTables(getDb())

    const tableNames = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row: any) => row.name)

    expect(tableNames).toContain('conversation_threads')
    expect(tableNames).toContain('conversation_session_edges')
    expect(tableNames).toContain('conversation_ui_events')
    expect(tableNames).toContain('conversation_display_rules')
    expect(tableNames).not.toContain('conversation_events')
    expect(tableNames).not.toContain('conversation_projection_meta')
  })

  it('upserts threads and session edges idempotently by child/type', async () => {
    const {
      listConversationSessionEdges,
      upsertConversationSessionEdge,
      upsertConversationThread,
    } = await import('../../packages/server/src/db/hermes/conversation-lineage')

    upsertConversationThread(getDb(), {
      conversation_id: 'conv-root',
      root_session_id: 'root',
      title: 'Root conversation',
      created_at: 10,
      updated_at: 11,
    })

    const first = upsertConversationSessionEdge(getDb(), {
      edge_id: 'edge-1',
      conversation_id: 'conv-root',
      parent_session_id: 'root',
      child_session_id: 'child',
      edge_type: 'continues',
      confidence: 'explicit',
      created_by: 'bridge',
      created_at: 20,
    })
    const second = upsertConversationSessionEdge(getDb(), {
      edge_id: 'edge-duplicate',
      conversation_id: 'conv-root',
      parent_session_id: 'root-updated',
      child_session_id: 'child',
      edge_type: 'continues',
      confidence: 'explicit',
      created_by: 'bridge',
      created_at: 30,
    })

    expect(second.edge_id).toBe(first.edge_id)
    expect(second.parent_session_id).toBe('root')
    expect(listConversationSessionEdges(getDb(), 'conv-root')).toHaveLength(1)
  })

  it('does not let inferred edges overwrite explicit facts', async () => {
    const {
      listConversationSessionEdges,
      upsertConversationSessionEdge,
      upsertConversationThread,
    } = await import('../../packages/server/src/db/hermes/conversation-lineage')

    upsertConversationThread(getDb(), {
      conversation_id: 'conv-root',
      root_session_id: 'root',
      created_at: 1,
      updated_at: 1,
    })

    upsertConversationSessionEdge(getDb(), {
      edge_id: 'explicit-edge',
      conversation_id: 'conv-root',
      parent_session_id: 'root',
      child_session_id: 'child',
      edge_type: 'continues',
      confidence: 'explicit',
      created_by: 'bridge',
      created_at: 2,
    })

    const afterInference = upsertConversationSessionEdge(getDb(), {
      edge_id: 'inferred-edge',
      conversation_id: 'conv-root',
      parent_session_id: 'wrong-parent',
      child_session_id: 'child',
      edge_type: 'continues',
      confidence: 'inferred_migrated',
      created_by: 'migration',
      created_at: 3,
    })

    expect(afterInference.edge_id).toBe('explicit-edge')
    expect(afterInference.parent_session_id).toBe('root')
    expect(afterInference.confidence).toBe('explicit')
    expect(listConversationSessionEdges(getDb(), 'conv-root')).toHaveLength(1)
  })

  it('persists UI event anchors idempotently', async () => {
    const {
      appendConversationUiEvent,
      listConversationUiEvents,
      upsertConversationThread,
    } = await import('../../packages/server/src/db/hermes/conversation-lineage')

    upsertConversationThread(getDb(), {
      conversation_id: 'conv-root',
      root_session_id: 'root',
      created_at: 1,
      updated_at: 1,
    })

    appendConversationUiEvent(getDb(), {
      event_id: 'steer-1',
      conversation_id: 'conv-root',
      event_type: 'steer',
      source_session_id: 'child',
      anchor_session_id: 'child',
      anchor_after_message_id: '42',
      content: 'Please stop this direction',
      metadata_json: '{"source":"test"}',
      created_at: 10,
    })
    appendConversationUiEvent(getDb(), {
      event_id: 'steer-1',
      conversation_id: 'conv-root',
      event_type: 'steer',
      source_session_id: 'child',
      anchor_session_id: 'child',
      anchor_after_message_id: '99',
      content: 'duplicate ignored',
      created_at: 11,
    })

    const events = listConversationUiEvents(getDb(), 'conv-root')
    expect(events).toHaveLength(1)
    expect(events[0].anchor_after_message_id).toBe('42')
    expect(events[0].content).toBe('Please stop this direction')
  })

  it('appends steer UI events with stable client ids', async () => {
    const {
      appendSteerUiEvent,
      ensureConversationLineageTables,
      listConversationUiEvents,
    } = await import('../../packages/server/src/db/hermes/conversation-lineage')
    const index = await import('../../packages/server/src/db/index')
    const availableSpy = vi.spyOn(index, 'isSqliteAvailable').mockReturnValue(true)
    const getDbSpy = vi.spyOn(index, 'getDb').mockReturnValue(getDb() as any)

    ensureConversationLineageTables(getDb())
    const first = appendSteerUiEvent({
      conversation_id: 'conv-root',
      source_session_id: 'child',
      anchor_session_id: 'child',
      anchor_after_message_id: '42',
      content: '收到停止',
      client_message_id: 'local-steer-1',
      created_at: 10,
    })
    const duplicate = appendSteerUiEvent({
      conversation_id: 'conv-root',
      source_session_id: 'child',
      anchor_session_id: 'child',
      anchor_after_message_id: '99',
      content: 'duplicate ignored',
      client_message_id: 'local-steer-1',
      created_at: 11,
    })

    expect(first?.event_id).toBe('ui.steer.conv-root.local-steer-1')
    expect(duplicate?.event_id).toBe(first?.event_id)
    const events = listConversationUiEvents(getDb(), 'conv-root')
    expect(events).toHaveLength(1)
    expect(events[0].anchor_after_message_id).toBe('42')
    availableSpy.mockRestore()
    getDbSpy.mockRestore()
  })

  it('records steer as UI-only truth without writing Hermes messages', async () => {
    const {
      appendSteerUiEvent,
      ensureConversationLineageTables,
      listConversationUiEvents,
    } = await import('../../packages/server/src/db/hermes/conversation-lineage')
    const index = await import('../../packages/server/src/db/index')
    const availableSpy = vi.spyOn(index, 'isSqliteAvailable').mockReturnValue(true)
    const getDbSpy = vi.spyOn(index, 'getDb').mockReturnValue(getDb() as any)

    getDb().exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        timestamp REAL NOT NULL
      )
    `)
    ensureConversationLineageTables(getDb())
    appendSteerUiEvent({
      conversation_id: 'conv-root',
      source_session_id: 'child',
      content: 'UI-only steer',
      client_message_id: 'local-steer-1',
      created_at: 10,
    })

    expect(listConversationUiEvents(getDb(), 'conv-root')).toHaveLength(1)
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM messages').get()).toMatchObject({ count: 0 })
    availableSpy.mockRestore()
    getDbSpy.mockRestore()
  })

  it('upserts and lists enabled and disabled display rules', async () => {
    const {
      listConversationDisplayRules,
      upsertConversationDisplayRule,
    } = await import('../../packages/server/src/db/hermes/conversation-lineage')

    upsertConversationDisplayRule(getDb(), {
      rule_id: 'hide-compaction',
      conversation_id: 'conv-root',
      rule_type: 'hide_compaction_summary',
      pattern: '[CONTEXT COMPACTION',
      enabled: true,
      created_at: 1,
    })
    upsertConversationDisplayRule(getDb(), {
      rule_id: 'hide-wrapper',
      conversation_id: 'conv-root',
      rule_type: 'hide_context_wrapper',
      pattern: 'Previous conversation context:',
      enabled: false,
      created_at: 2,
    })
    upsertConversationDisplayRule(getDb(), {
      rule_id: 'hide-wrapper',
      conversation_id: 'conv-root',
      rule_type: 'hide_context_wrapper',
      pattern: 'Previous conversation context:',
      enabled: true,
      created_at: 3,
    })

    const rules = listConversationDisplayRules(getDb(), 'conv-root')
    expect(rules).toHaveLength(2)
    expect(rules.map((rule) => [rule.rule_id, rule.enabled])).toEqual([
      ['hide-compaction', 1],
      ['hide-wrapper', 1],
    ])
  })
})
