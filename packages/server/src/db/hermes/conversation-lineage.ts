import type { DatabaseSync } from 'node:sqlite'
import { getDb, isSqliteAvailable } from '../index'
import {
  CONVERSATION_DISPLAY_RULES_SCHEMA,
  CONVERSATION_DISPLAY_RULES_TABLE,
  CONVERSATION_LINEAGE_INDEXES,
  CONVERSATION_SESSION_EDGES_SCHEMA,
  CONVERSATION_SESSION_EDGES_TABLE,
  CONVERSATION_THREADS_SCHEMA,
  CONVERSATION_THREADS_TABLE,
  CONVERSATION_UI_EVENTS_SCHEMA,
  CONVERSATION_UI_EVENTS_TABLE,
} from './schemas'

export type ConversationEdgeType = 'root' | 'continues' | 'branches' | 'subagent' | 'import'
export type ConversationEdgeConfidence = 'explicit' | 'inferred_migrated' | 'repaired'
export type ConversationEdgeCreatedBy = 'bridge' | 'migration' | 'repair_tool' | 'test'
export type ConversationUiEventType = 'steer' | 'approval' | 'pending' | 'notice'
export type ConversationDisplayRuleType = 'hide_compaction_summary' | 'hide_context_wrapper' | 'custom'

export interface ConversationThreadRow {
  conversation_id: string
  root_session_id: string
  title: string | null
  status: string
  created_at: number
  updated_at: number
  schema_version: number
}

export interface ConversationSessionEdgeRow {
  edge_id: string
  conversation_id: string
  parent_session_id: string | null
  child_session_id: string
  edge_type: ConversationEdgeType
  confidence: ConversationEdgeConfidence
  created_by: ConversationEdgeCreatedBy
  created_at: number
  superseded_at: number | null
}

export interface ConversationUiEventRow {
  event_id: string
  conversation_id: string
  event_type: ConversationUiEventType
  source_session_id: string | null
  anchor_session_id: string | null
  anchor_message_id: string | null
  anchor_after_message_id: string | null
  content: string | null
  metadata_json: string | null
  created_at: number
  superseded_at: number | null
}

export interface ConversationDisplayRuleRow {
  rule_id: string
  conversation_id: string | null
  rule_type: ConversationDisplayRuleType
  pattern: string | null
  enabled: number
  created_at: number
}

export type UpsertConversationThreadInput = {
  conversation_id: string
  root_session_id: string
  title?: string | null
  status?: string
  created_at?: number
  updated_at?: number
  schema_version?: number
}

export type UpsertConversationSessionEdgeInput = {
  edge_id: string
  conversation_id: string
  parent_session_id?: string | null
  child_session_id: string
  edge_type: ConversationEdgeType
  confidence: ConversationEdgeConfidence
  created_by: ConversationEdgeCreatedBy
  created_at?: number
  superseded_at?: number | null
}

export type AppendConversationUiEventInput = {
  event_id: string
  conversation_id: string
  event_type: ConversationUiEventType
  source_session_id?: string | null
  anchor_session_id?: string | null
  anchor_message_id?: string | null
  anchor_after_message_id?: string | null
  content?: string | null
  metadata_json?: string | null
  created_at?: number
  superseded_at?: number | null
}

export type AppendSteerUiEventInput = {
  conversation_id: string
  source_session_id?: string | null
  anchor_session_id?: string | null
  anchor_message_id?: string | null
  anchor_after_message_id?: string | null
  content: string
  metadata_json?: string | null
  client_message_id?: string | null
  created_at?: number
}

export type UpsertConversationDisplayRuleInput = {
  rule_id: string
  conversation_id?: string | null
  rule_type: ConversationDisplayRuleType
  pattern?: string | null
  enabled?: boolean | number
  created_at?: number
}

export type RecordBridgeConversationLineageInput = {
  conversation_id: string
  root_session_id: string
  child_session_id: string
  parent_session_id?: string | null
  title?: string | null
  status?: string
  created_at?: number
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function createTableIfMissing(
  db: DatabaseSync,
  tableName: string,
  schema: Record<string, string>,
): void {
  const columns = Object.entries(schema)
    .map(([name, def]) => `${quoteIdentifier(name)} ${def}`)
    .join(', ')
  db.exec(`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (${columns})`)
}

function normalizeNullable(value: string | null | undefined): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  return trimmed || null
}

function safeDb(): DatabaseSync | null {
  if (!isSqliteAvailable()) return null
  try {
    return getDb()
  } catch {
    return null
  }
}

function edgeIdForBridgeLineage(
  conversationId: string,
  edgeType: ConversationEdgeType,
  childSessionId: string,
): string {
  return `bridge:${conversationId}:${edgeType}:${childSessionId}`
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table'
      AND name = ?
    LIMIT 1
  `).get(tableName) as Record<string, unknown> | undefined
  return !!row
}

function normalizeEnabled(value: boolean | number | undefined): number {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return value ? 1 : 0
  return 1
}

function mapThreadRow(row: Record<string, unknown>): ConversationThreadRow {
  return {
    conversation_id: String(row.conversation_id),
    root_session_id: String(row.root_session_id),
    title: row.title == null ? null : String(row.title),
    status: String(row.status || 'active'),
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
    schema_version: Number(row.schema_version || 1),
  }
}

function mapEdgeRow(row: Record<string, unknown>): ConversationSessionEdgeRow {
  return {
    edge_id: String(row.edge_id),
    conversation_id: String(row.conversation_id),
    parent_session_id: row.parent_session_id == null ? null : String(row.parent_session_id),
    child_session_id: String(row.child_session_id),
    edge_type: String(row.edge_type) as ConversationEdgeType,
    confidence: String(row.confidence) as ConversationEdgeConfidence,
    created_by: String(row.created_by) as ConversationEdgeCreatedBy,
    created_at: Number(row.created_at || 0),
    superseded_at: row.superseded_at == null ? null : Number(row.superseded_at),
  }
}

function mapUiEventRow(row: Record<string, unknown>): ConversationUiEventRow {
  return {
    event_id: String(row.event_id),
    conversation_id: String(row.conversation_id),
    event_type: String(row.event_type) as ConversationUiEventType,
    source_session_id: row.source_session_id == null ? null : String(row.source_session_id),
    anchor_session_id: row.anchor_session_id == null ? null : String(row.anchor_session_id),
    anchor_message_id: row.anchor_message_id == null ? null : String(row.anchor_message_id),
    anchor_after_message_id: row.anchor_after_message_id == null ? null : String(row.anchor_after_message_id),
    content: row.content == null ? null : String(row.content),
    metadata_json: row.metadata_json == null ? null : String(row.metadata_json),
    created_at: Number(row.created_at || 0),
    superseded_at: row.superseded_at == null ? null : Number(row.superseded_at),
  }
}

function mapDisplayRuleRow(row: Record<string, unknown>): ConversationDisplayRuleRow {
  return {
    rule_id: String(row.rule_id),
    conversation_id: row.conversation_id == null ? null : String(row.conversation_id),
    rule_type: String(row.rule_type) as ConversationDisplayRuleType,
    pattern: row.pattern == null ? null : String(row.pattern),
    enabled: Number(row.enabled ?? 1),
    created_at: Number(row.created_at || 0),
  }
}

export function ensureConversationLineageTables(db: DatabaseSync): void {
  createTableIfMissing(db, CONVERSATION_THREADS_TABLE, CONVERSATION_THREADS_SCHEMA)
  createTableIfMissing(db, CONVERSATION_SESSION_EDGES_TABLE, CONVERSATION_SESSION_EDGES_SCHEMA)
  createTableIfMissing(db, CONVERSATION_UI_EVENTS_TABLE, CONVERSATION_UI_EVENTS_SCHEMA)
  createTableIfMissing(db, CONVERSATION_DISPLAY_RULES_TABLE, CONVERSATION_DISPLAY_RULES_SCHEMA)
  for (const indexSQL of Object.values(CONVERSATION_LINEAGE_INDEXES)) {
    db.exec(indexSQL)
  }
}

export function upsertConversationThread(
  db: DatabaseSync,
  input: UpsertConversationThreadInput,
): ConversationThreadRow {
  ensureConversationLineageTables(db)
  const now = nowSeconds()
  const createdAt = input.created_at ?? now
  const updatedAt = input.updated_at ?? now
  db.prepare(`
    INSERT INTO ${CONVERSATION_THREADS_TABLE} (
      conversation_id,
      root_session_id,
      title,
      status,
      created_at,
      updated_at,
      schema_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      root_session_id = excluded.root_session_id,
      title = excluded.title,
      status = excluded.status,
      updated_at = excluded.updated_at,
      schema_version = excluded.schema_version
  `).run(
    input.conversation_id,
    input.root_session_id,
    input.title ?? null,
    input.status ?? 'active',
    createdAt,
    updatedAt,
    input.schema_version ?? 1,
  )
  return getConversationThread(db, input.conversation_id)!
}

export function getConversationThread(
  db: DatabaseSync,
  conversationId: string,
): ConversationThreadRow | null {
  ensureConversationLineageTables(db)
  const row = db.prepare(`
    SELECT *
    FROM ${CONVERSATION_THREADS_TABLE}
    WHERE conversation_id = ?
  `).get(conversationId) as Record<string, unknown> | undefined
  return row ? mapThreadRow(row) : null
}

function getConversationSessionEdgeByNaturalKey(
  db: DatabaseSync,
  conversationId: string,
  childSessionId: string,
  edgeType: ConversationEdgeType,
): ConversationSessionEdgeRow | null {
  const row = db.prepare(`
    SELECT *
    FROM ${CONVERSATION_SESSION_EDGES_TABLE}
    WHERE conversation_id = ?
      AND child_session_id = ?
      AND edge_type = ?
  `).get(conversationId, childSessionId, edgeType) as Record<string, unknown> | undefined
  return row ? mapEdgeRow(row) : null
}

export function upsertConversationSessionEdge(
  db: DatabaseSync,
  input: UpsertConversationSessionEdgeInput,
): ConversationSessionEdgeRow {
  ensureConversationLineageTables(db)
  const existing = getConversationSessionEdgeByNaturalKey(
    db,
    input.conversation_id,
    input.child_session_id,
    input.edge_type,
  )
  if (existing?.confidence === 'explicit') {
    return existing
  }

  const createdAt = input.created_at ?? nowSeconds()
  if (!existing) {
    db.prepare(`
      INSERT INTO ${CONVERSATION_SESSION_EDGES_TABLE} (
        edge_id,
        conversation_id,
        parent_session_id,
        child_session_id,
        edge_type,
        confidence,
        created_by,
        created_at,
        superseded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.edge_id,
      input.conversation_id,
      normalizeNullable(input.parent_session_id),
      input.child_session_id,
      input.edge_type,
      input.confidence,
      input.created_by,
      createdAt,
      input.superseded_at ?? null,
    )
    return getConversationSessionEdge(db, input.edge_id)!
  }

  db.prepare(`
    UPDATE ${CONVERSATION_SESSION_EDGES_TABLE}
    SET
      parent_session_id = ?,
      confidence = ?,
      created_by = ?,
      superseded_at = ?
    WHERE edge_id = ?
  `).run(
    normalizeNullable(input.parent_session_id),
    input.confidence,
    input.created_by,
    input.superseded_at ?? null,
    existing.edge_id,
  )
  return getConversationSessionEdge(db, existing.edge_id)!
}

export function getConversationSessionEdge(
  db: DatabaseSync,
  edgeId: string,
): ConversationSessionEdgeRow | null {
  ensureConversationLineageTables(db)
  const row = db.prepare(`
    SELECT *
    FROM ${CONVERSATION_SESSION_EDGES_TABLE}
    WHERE edge_id = ?
  `).get(edgeId) as Record<string, unknown> | undefined
  return row ? mapEdgeRow(row) : null
}

export function listConversationSessionEdges(
  db: DatabaseSync,
  conversationId: string,
): ConversationSessionEdgeRow[] {
  ensureConversationLineageTables(db)
  const rows = db.prepare(`
    SELECT *
    FROM ${CONVERSATION_SESSION_EDGES_TABLE}
    WHERE conversation_id = ?
      AND superseded_at IS NULL
    ORDER BY created_at, edge_id
  `).all(conversationId) as Record<string, unknown>[]
  return rows.map(mapEdgeRow)
}

export function listActiveExplicitConversationSessionEdges(
  db: DatabaseSync,
): ConversationSessionEdgeRow[] {
  if (!tableExists(db, CONVERSATION_SESSION_EDGES_TABLE)) return []
  const rows = db.prepare(`
    SELECT *
    FROM ${CONVERSATION_SESSION_EDGES_TABLE}
    WHERE confidence = 'explicit'
      AND superseded_at IS NULL
    ORDER BY conversation_id, created_at, edge_id
  `).all() as Record<string, unknown>[]
  return rows.map(mapEdgeRow)
}

export function listConversationThreadsReadOnly(
  db: DatabaseSync,
): ConversationThreadRow[] {
  if (!tableExists(db, CONVERSATION_THREADS_TABLE)) return []
  const rows = db.prepare(`
    SELECT *
    FROM ${CONVERSATION_THREADS_TABLE}
    ORDER BY updated_at DESC, conversation_id
  `).all() as Record<string, unknown>[]
  return rows.map(mapThreadRow)
}

export function supersedeConversationSessionEdge(
  db: DatabaseSync,
  edgeId: string,
  supersededAt = nowSeconds(),
): ConversationSessionEdgeRow | null {
  ensureConversationLineageTables(db)
  db.prepare(`
    UPDATE ${CONVERSATION_SESSION_EDGES_TABLE}
    SET superseded_at = ?
    WHERE edge_id = ?
  `).run(supersededAt, edgeId)
  return getConversationSessionEdge(db, edgeId)
}

export function appendConversationUiEvent(
  db: DatabaseSync,
  input: AppendConversationUiEventInput,
): ConversationUiEventRow {
  ensureConversationLineageTables(db)
  const createdAt = input.created_at ?? nowSeconds()
  db.prepare(`
    INSERT OR IGNORE INTO ${CONVERSATION_UI_EVENTS_TABLE} (
      event_id,
      conversation_id,
      event_type,
      source_session_id,
      anchor_session_id,
      anchor_message_id,
      anchor_after_message_id,
      content,
      metadata_json,
      created_at,
      superseded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.event_id,
    input.conversation_id,
    input.event_type,
    normalizeNullable(input.source_session_id),
    normalizeNullable(input.anchor_session_id),
    normalizeNullable(input.anchor_message_id),
    normalizeNullable(input.anchor_after_message_id),
    input.content ?? null,
    input.metadata_json ?? null,
    createdAt,
    input.superseded_at ?? null,
  )
  return getConversationUiEvent(db, input.event_id)!
}

export function getConversationUiEvent(
  db: DatabaseSync,
  eventId: string,
): ConversationUiEventRow | null {
  ensureConversationLineageTables(db)
  const row = db.prepare(`
    SELECT *
    FROM ${CONVERSATION_UI_EVENTS_TABLE}
    WHERE event_id = ?
  `).get(eventId) as Record<string, unknown> | undefined
  return row ? mapUiEventRow(row) : null
}

export function listConversationUiEvents(
  db: DatabaseSync,
  conversationId: string,
): ConversationUiEventRow[] {
  ensureConversationLineageTables(db)
  const rows = db.prepare(`
    SELECT *
    FROM ${CONVERSATION_UI_EVENTS_TABLE}
    WHERE conversation_id = ?
      AND superseded_at IS NULL
    ORDER BY created_at, event_id
  `).all(conversationId) as Record<string, unknown>[]
  return rows.map(mapUiEventRow)
}

export function listConversationUiEventsReadOnly(
  db: DatabaseSync,
  conversationId: string,
): ConversationUiEventRow[] {
  if (!tableExists(db, CONVERSATION_UI_EVENTS_TABLE)) return []
  const rows = db.prepare(`
    SELECT *
    FROM ${CONVERSATION_UI_EVENTS_TABLE}
    WHERE conversation_id = ?
      AND superseded_at IS NULL
    ORDER BY created_at, event_id
  `).all(conversationId) as Record<string, unknown>[]
  return rows.map(mapUiEventRow)
}

function steerUiEventId(input: AppendSteerUiEventInput): string {
  const clientId = normalizeNullable(input.client_message_id)
  if (clientId) return `ui.steer.${input.conversation_id}.${clientId}`
  const createdAt = input.created_at ?? nowSeconds()
  return `ui.steer.${input.conversation_id}.${createdAt}.${Math.random().toString(36).slice(2, 10)}`
}

export function appendSteerUiEvent(input: AppendSteerUiEventInput): ConversationUiEventRow | null {
  const db = safeDb()
  const conversationId = normalizeNullable(input.conversation_id)
  const content = normalizeNullable(input.content)
  if (!db || !conversationId || !content) return null
  return appendConversationUiEvent(db, {
    event_id: steerUiEventId({ ...input, conversation_id: conversationId, content }),
    conversation_id: conversationId,
    event_type: 'steer',
    source_session_id: input.source_session_id,
    anchor_session_id: input.anchor_session_id,
    anchor_message_id: input.anchor_message_id,
    anchor_after_message_id: input.anchor_after_message_id,
    content,
    metadata_json: input.metadata_json,
    created_at: input.created_at,
  })
}

export function upsertConversationDisplayRule(
  db: DatabaseSync,
  input: UpsertConversationDisplayRuleInput,
): ConversationDisplayRuleRow {
  ensureConversationLineageTables(db)
  const createdAt = input.created_at ?? nowSeconds()
  db.prepare(`
    INSERT INTO ${CONVERSATION_DISPLAY_RULES_TABLE} (
      rule_id,
      conversation_id,
      rule_type,
      pattern,
      enabled,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(rule_id) DO UPDATE SET
      conversation_id = excluded.conversation_id,
      rule_type = excluded.rule_type,
      pattern = excluded.pattern,
      enabled = excluded.enabled
  `).run(
    input.rule_id,
    normalizeNullable(input.conversation_id),
    input.rule_type,
    input.pattern ?? null,
    normalizeEnabled(input.enabled),
    createdAt,
  )
  return getConversationDisplayRule(db, input.rule_id)!
}

export function getConversationDisplayRule(
  db: DatabaseSync,
  ruleId: string,
): ConversationDisplayRuleRow | null {
  ensureConversationLineageTables(db)
  const row = db.prepare(`
    SELECT *
    FROM ${CONVERSATION_DISPLAY_RULES_TABLE}
    WHERE rule_id = ?
  `).get(ruleId) as Record<string, unknown> | undefined
  return row ? mapDisplayRuleRow(row) : null
}

export function listConversationDisplayRules(
  db: DatabaseSync,
  conversationId?: string | null,
): ConversationDisplayRuleRow[] {
  ensureConversationLineageTables(db)
  const rows = conversationId == null
    ? db.prepare(`
        SELECT *
        FROM ${CONVERSATION_DISPLAY_RULES_TABLE}
        WHERE conversation_id IS NULL
        ORDER BY created_at, rule_id
      `).all() as Record<string, unknown>[]
    : db.prepare(`
        SELECT *
        FROM ${CONVERSATION_DISPLAY_RULES_TABLE}
        WHERE conversation_id = ?
        ORDER BY created_at, rule_id
      `).all(conversationId) as Record<string, unknown>[]
  return rows.map(mapDisplayRuleRow)
}

export function recordBridgeConversationLineage(
  input: RecordBridgeConversationLineageInput,
): ConversationSessionEdgeRow | null {
  const db = safeDb()
  const conversationId = normalizeNullable(input.conversation_id)
  const rootSessionId = normalizeNullable(input.root_session_id)
  const childSessionId = normalizeNullable(input.child_session_id)
  if (!db || !conversationId || !rootSessionId || !childSessionId) return null

  const parentSessionId = normalizeNullable(input.parent_session_id)
  const edgeType: ConversationEdgeType = parentSessionId && parentSessionId !== childSessionId
    ? 'continues'
    : 'root'
  const edgeParentSessionId = edgeType === 'root' ? null : parentSessionId
  const createdAt = input.created_at ?? nowSeconds()

  ensureConversationLineageTables(db)
  db.exec('BEGIN IMMEDIATE')
  try {
    upsertConversationThread(db, {
      conversation_id: conversationId,
      root_session_id: rootSessionId,
      title: input.title ?? null,
      status: input.status ?? 'active',
      created_at: createdAt,
      updated_at: createdAt,
    })
    const edge = upsertConversationSessionEdge(db, {
      edge_id: edgeIdForBridgeLineage(conversationId, edgeType, childSessionId),
      conversation_id: conversationId,
      parent_session_id: edgeParentSessionId,
      child_session_id: childSessionId,
      edge_type: edgeType,
      confidence: 'explicit',
      created_by: 'bridge',
      created_at: createdAt,
    })
    db.exec('COMMIT')
    return edge
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Ignore rollback failures; lineage is best-effort write-through metadata.
    }
    throw error
  }
}
