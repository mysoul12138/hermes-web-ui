/**
 * Centralized schema definitions for all Hermes SQLite tables.
 * All table schemas are defined here for unified management and migration.
 */

// ============================================================================
// Usage Store (usage-store.ts)
// ============================================================================

export const USAGE_TABLE = 'session_usage'

export const USAGE_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  session_id: 'TEXT NOT NULL',
  input_tokens: 'INTEGER NOT NULL DEFAULT 0',
  output_tokens: 'INTEGER NOT NULL DEFAULT 0',
  cache_read_tokens: 'INTEGER NOT NULL DEFAULT 0',
  cache_write_tokens: 'INTEGER NOT NULL DEFAULT 0',
  reasoning_tokens: 'INTEGER NOT NULL DEFAULT 0',
  model: "TEXT NOT NULL DEFAULT ''",
  profile: "TEXT NOT NULL DEFAULT 'default'",
  created_at: 'INTEGER NOT NULL DEFAULT 0',
  updated_at: 'INTEGER NOT NULL DEFAULT 0',
}

// ============================================================================
// Session Store (session-store.ts)
// ============================================================================

export const SESSIONS_TABLE = 'sessions'

export const SESSIONS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  profile: 'TEXT NOT NULL DEFAULT \'default\'',
  source: 'TEXT NOT NULL DEFAULT \'api_server\'',
  user_id: 'TEXT',
  model: 'TEXT NOT NULL DEFAULT \'\'',
  title: 'TEXT',
  started_at: 'INTEGER NOT NULL',
  ended_at: 'INTEGER',
  end_reason: 'TEXT',
  message_count: 'INTEGER NOT NULL DEFAULT 0',
  tool_call_count: 'INTEGER NOT NULL DEFAULT 0',
  input_tokens: 'INTEGER NOT NULL DEFAULT 0',
  output_tokens: 'INTEGER NOT NULL DEFAULT 0',
  cache_read_tokens: 'INTEGER NOT NULL DEFAULT 0',
  cache_write_tokens: 'INTEGER NOT NULL DEFAULT 0',
  reasoning_tokens: 'INTEGER NOT NULL DEFAULT 0',
  billing_provider: 'TEXT',
  estimated_cost_usd: 'REAL NOT NULL DEFAULT 0',
  actual_cost_usd: 'REAL',
  cost_status: 'TEXT NOT NULL DEFAULT \'\'',
  preview: 'TEXT NOT NULL DEFAULT \'\'',
  last_active: 'INTEGER NOT NULL',
  workspace: 'TEXT',
}

export const MESSAGES_TABLE = 'messages'

export const MESSAGES_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  session_id: 'TEXT NOT NULL',
  role: 'TEXT NOT NULL',
  content: 'TEXT NOT NULL DEFAULT \'\'',
  tool_call_id: 'TEXT',
  tool_calls: 'TEXT',
  tool_name: 'TEXT',
  timestamp: 'INTEGER NOT NULL',
  token_count: 'INTEGER',
  finish_reason: 'TEXT',
  reasoning: 'TEXT',
  reasoning_details: 'TEXT',
  reasoning_content: 'TEXT',
  codex_reasoning_items: 'TEXT',
}

export const MESSAGES_INDEX = 'CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)'

// ============================================================================
// Compression Snapshot (compression-snapshot.ts)
// ============================================================================

export const COMPRESSION_SNAPSHOT_TABLE = 'chat_compression_snapshots'

export const COMPRESSION_SNAPSHOT_SCHEMA: Record<string, string> = {
  session_id: 'TEXT PRIMARY KEY',
  summary: 'TEXT NOT NULL DEFAULT \'\'',
  last_message_index: 'INTEGER NOT NULL DEFAULT 0',
  message_count_at_time: 'INTEGER NOT NULL DEFAULT 0',
  updated_at: 'INTEGER NOT NULL',
}

// ============================================================================
// Model Context (model-context.ts)
// ============================================================================

export const MODEL_CONTEXT_TABLE = 'model_context'

export const MODEL_CONTEXT_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  provider: 'TEXT NOT NULL',
  model: 'TEXT NOT NULL',
  context_limit: 'INTEGER NOT NULL',
}

export const MODEL_CONTEXT_INDEX = 'CREATE UNIQUE INDEX IF NOT EXISTS idx_model_context_provider_model ON model_context(provider, model)'

// ============================================================================
// Group Chat (services/hermes/group-chat/index.ts)
// ============================================================================

export const GC_ROOMS_TABLE = 'gc_rooms'

export const GC_ROOMS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  name: 'TEXT NOT NULL',
  inviteCode: 'TEXT UNIQUE',
  triggerTokens: 'INTEGER NOT NULL DEFAULT 100000',
  maxHistoryTokens: 'INTEGER NOT NULL DEFAULT 32000',
  tailMessageCount: 'INTEGER NOT NULL DEFAULT 10',
  totalTokens: 'INTEGER NOT NULL DEFAULT 0',
}

export const GC_MESSAGES_TABLE = 'gc_messages'

export const GC_MESSAGES_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  roomId: 'TEXT NOT NULL',
  senderId: 'TEXT NOT NULL',
  senderName: 'TEXT NOT NULL',
  content: 'TEXT NOT NULL',
  timestamp: 'INTEGER NOT NULL',
}

export const GC_ROOM_AGENTS_TABLE = 'gc_room_agents'

export const GC_ROOM_AGENTS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  roomId: 'TEXT NOT NULL',
  agentId: 'TEXT NOT NULL',
  profile: 'TEXT NOT NULL',
  name: 'TEXT NOT NULL',
  description: "TEXT NOT NULL DEFAULT ''",
  invited: 'INTEGER NOT NULL DEFAULT 0',
}

export const GC_CONTEXT_SNAPSHOTS_TABLE = 'gc_context_snapshots'

export const GC_CONTEXT_SNAPSHOTS_SCHEMA: Record<string, string> = {
  roomId: 'TEXT PRIMARY KEY',
  summary: 'TEXT NOT NULL DEFAULT \'\'',
  lastMessageId: 'TEXT NOT NULL',
  lastMessageTimestamp: 'INTEGER NOT NULL',
  updatedAt: 'INTEGER NOT NULL',
}

export const GC_ROOM_MEMBERS_TABLE = 'gc_room_members'

export const GC_ROOM_MEMBERS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  roomId: 'TEXT NOT NULL',
  userId: 'TEXT NOT NULL',
  userName: 'TEXT NOT NULL',
  description: "TEXT NOT NULL DEFAULT ''",
  joinedAt: 'INTEGER NOT NULL',
  updatedAt: 'INTEGER NOT NULL',
}

export const GC_PENDING_SESSION_DELETES_TABLE = 'gc_pending_session_deletes'

export const GC_PENDING_SESSION_DELETES_SCHEMA: Record<string, string> = {
  session_id: 'TEXT PRIMARY KEY',
  profile_name: 'TEXT NOT NULL',
  status: "TEXT NOT NULL DEFAULT 'pending'",
  attempt_count: 'INTEGER NOT NULL DEFAULT 0',
  last_error: 'TEXT',
  created_at: 'INTEGER NOT NULL',
  updated_at: 'INTEGER NOT NULL',
  next_attempt_at: 'INTEGER NOT NULL DEFAULT 0',
}

export const GC_SESSION_PROFILES_TABLE = 'gc_session_profiles'

export const GC_SESSION_PROFILES_SCHEMA: Record<string, string> = {
  session_id: 'TEXT PRIMARY KEY',
  room_id: 'TEXT NOT NULL',
  agent_id: 'TEXT NOT NULL',
  profile_name: 'TEXT NOT NULL',
  created_at: 'INTEGER NOT NULL',
}

// ============================================================================
// Session Lineage Registry
// ============================================================================

export const SESSION_LINEAGE_TABLE = 'session_lineage'

export const SESSION_LINEAGE_SCHEMA: Record<string, string> = {
  session_id: 'TEXT PRIMARY KEY',
  logical_conversation_id: 'TEXT NOT NULL',
  source: "TEXT NOT NULL DEFAULT 'unknown'",
  authority: "TEXT NOT NULL DEFAULT 'explicit'",
  relation_kind: "TEXT NOT NULL DEFAULT 'root'",
  parent_session_id: 'TEXT',
  root_session_id: 'TEXT',
  web_session_id: 'TEXT',
  bridge_session_id: 'TEXT',
  persistent_session_id: 'TEXT',
  created_at: 'INTEGER NOT NULL',
  updated_at: 'INTEGER NOT NULL',
}

// ============================================================================
// Lightweight Conversation Lineage
// ============================================================================

export const CONVERSATION_THREADS_TABLE = 'conversation_threads'

export const CONVERSATION_THREADS_SCHEMA: Record<string, string> = {
  conversation_id: 'TEXT PRIMARY KEY',
  root_session_id: 'TEXT NOT NULL',
  title: 'TEXT',
  status: "TEXT NOT NULL DEFAULT 'active'",
  created_at: 'INTEGER NOT NULL',
  updated_at: 'INTEGER NOT NULL',
  schema_version: 'INTEGER NOT NULL DEFAULT 1',
}

export const CONVERSATION_SESSION_EDGES_TABLE = 'conversation_session_edges'

export const CONVERSATION_SESSION_EDGES_SCHEMA: Record<string, string> = {
  edge_id: 'TEXT PRIMARY KEY',
  conversation_id: 'TEXT NOT NULL',
  parent_session_id: 'TEXT',
  child_session_id: 'TEXT NOT NULL',
  edge_type: 'TEXT NOT NULL',
  confidence: 'TEXT NOT NULL',
  created_by: 'TEXT NOT NULL',
  created_at: 'INTEGER NOT NULL',
  superseded_at: 'INTEGER',
}

export const CONVERSATION_UI_EVENTS_TABLE = 'conversation_ui_events'

export const CONVERSATION_UI_EVENTS_SCHEMA: Record<string, string> = {
  event_id: 'TEXT PRIMARY KEY',
  conversation_id: 'TEXT NOT NULL',
  event_type: 'TEXT NOT NULL',
  source_session_id: 'TEXT',
  anchor_session_id: 'TEXT',
  anchor_message_id: 'TEXT',
  anchor_after_message_id: 'TEXT',
  content: 'TEXT',
  metadata_json: 'TEXT',
  created_at: 'INTEGER NOT NULL',
  superseded_at: 'INTEGER',
}

export const CONVERSATION_DISPLAY_RULES_TABLE = 'conversation_display_rules'

export const CONVERSATION_DISPLAY_RULES_SCHEMA: Record<string, string> = {
  rule_id: 'TEXT PRIMARY KEY',
  conversation_id: 'TEXT',
  rule_type: 'TEXT NOT NULL',
  pattern: 'TEXT',
  enabled: 'INTEGER NOT NULL DEFAULT 1',
  created_at: 'INTEGER NOT NULL',
}

export const CONVERSATION_LINEAGE_INDEXES: Record<string, string> = {
  idx_conversation_session_edges_conversation:
    'CREATE INDEX IF NOT EXISTS idx_conversation_session_edges_conversation ON conversation_session_edges(conversation_id, created_at, edge_id)',
  idx_conversation_session_edges_unique_child_edge:
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_session_edges_unique_child_edge ON conversation_session_edges(conversation_id, child_session_id, edge_type)',
  idx_conversation_ui_events_conversation:
    'CREATE INDEX IF NOT EXISTS idx_conversation_ui_events_conversation ON conversation_ui_events(conversation_id, created_at, event_id)',
  idx_conversation_ui_events_anchor:
    'CREATE INDEX IF NOT EXISTS idx_conversation_ui_events_anchor ON conversation_ui_events(conversation_id, anchor_session_id, anchor_message_id, anchor_after_message_id)',
  idx_conversation_display_rules_conversation:
    'CREATE INDEX IF NOT EXISTS idx_conversation_display_rules_conversation ON conversation_display_rules(conversation_id, rule_type, enabled)',
}

// ============================================================================
// Schema Sync Utilities
// ============================================================================

import { getDb, getStoragePath } from '../index'

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

/**
 * 检查表是否存在
 */
function tableExists(db: NonNullable<ReturnType<typeof getDb>>, tableName: string): boolean {
  const result = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(tableName)
  return !!result
}

/**
 * 创建表（带完整 schema）
 */
function createTable(
  db: NonNullable<ReturnType<typeof getDb>>,
  tableName: string,
  schema: Record<string, string>,
  primaryKey?: string
): void {
  const colDefs = Object.entries(schema).map(([col, def]) => `${quoteIdentifier(col)} ${def}`)

  // 只在 schema 中没有主键时才添加复合主键
  const hasPrimaryKeyInSchema = Object.values(schema).some((def) =>
    def.toUpperCase().includes("PRIMARY KEY")
  )

  if (primaryKey && !hasPrimaryKeyInSchema) {
    colDefs.push(`PRIMARY KEY (${primaryKey})`)
  }

  db.exec(`CREATE TABLE ${quoteIdentifier(tableName)} (${colDefs.join(', ')})`)
}

function canAddColumnToExistingTable(schemaDef: string): boolean {
  const normalized = schemaDef.toUpperCase()
  if (normalized.includes('PRIMARY KEY')) return false
  if (normalized.includes('NOT NULL') && !normalized.includes('DEFAULT')) return false
  return true
}

function getTableColumns(
  db: NonNullable<ReturnType<typeof getDb>>,
  tableName: string,
): Array<{ name: string; type: string; pk: number; notnull: number; dflt_value: unknown }> {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name: string }>
  return columns as Array<{ name: string; type: string; pk: number; notnull: number; dflt_value: unknown }>
}

function addMissingSafeColumns(
  db: NonNullable<ReturnType<typeof getDb>>,
  tableName: string,
  schema: Record<string, string>,
): void {
  const columns = getTableColumns(db, tableName)
  const existingColumns = new Set(columns.map(col => col.name))

  for (const [columnName, columnDef] of Object.entries(schema)) {
    if (existingColumns.has(columnName)) continue
    if (!canAddColumnToExistingTable(columnDef)) {
      console.warn(`[Schema] ${tableName}.${columnName} cannot be added safely to existing table; skipping`)
      continue
    }
    db.exec(`ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${quoteIdentifier(columnName)} ${columnDef}`)
  }
}

export function ensureUsageTableSchema(): void {
  const db = getDb()
  if (!db) return

  if (!tableExists(db, USAGE_TABLE)) {
    createTable(db, USAGE_TABLE, USAGE_SCHEMA, 'id')
    return
  }

  const columns = getTableColumns(db, USAGE_TABLE)
  const columnMap = new Map(columns.map(col => [col.name, col]))
  const idColumn = columnMap.get('id')
  const mustRebuild = !idColumn || idColumn.pk !== 1

  if (!mustRebuild) {
    addMissingSafeColumns(db, USAGE_TABLE, USAGE_SCHEMA)
    return
  }

  const tempTable = `${USAGE_TABLE}_schema_migration_${Date.now()}`
  const sourceColumns = new Set(columns.map(col => col.name))
  const insertColumns = Object.keys(USAGE_SCHEMA).filter(column => column !== 'id')
  const selectColumns = insertColumns.map((column) => {
    if (sourceColumns.has(column)) return quoteIdentifier(column)
    if (column === 'profile') return `'default'`
    if (column === 'model') return `''`
    return '0'
  })

  db.exec('BEGIN')
  try {
    createTable(db, tempTable, USAGE_SCHEMA, 'id')
    db.exec(
      `INSERT INTO ${quoteIdentifier(tempTable)} (${insertColumns.map(quoteIdentifier).join(', ')})
       SELECT ${selectColumns.join(', ')} FROM ${quoteIdentifier(USAGE_TABLE)}`
    )
    db.exec(`DROP TABLE ${quoteIdentifier(USAGE_TABLE)}`)
    db.exec(`ALTER TABLE ${quoteIdentifier(tempTable)} RENAME TO ${quoteIdentifier(USAGE_TABLE)}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * 主同步函数
 * - 表不存在：创建
 * - 表存在：只追加安全的新列，不删除、不重建、不修改主键/类型
 */
export function syncTable(
  tableName: string,
  schema: Record<string, string>,
  options?: {
    primaryKey?: string  // 主键定义，如 "roomId, agentId" 或 "id"
    indexes?: Record<string, string>  // 索引定义
  }
): void {
  const db = getDb()
  if (!db) return

  // 1. 表不存在 → 直接创建
  if (!tableExists(db, tableName)) {
    createTable(db, tableName, schema, options?.primaryKey)

    // 创建索引
    if (options?.indexes) {
      for (const indexSQL of Object.values(options.indexes)) {
        db.exec(indexSQL)
      }
    }
    return
  }

  addMissingSafeColumns(db, tableName, schema)
}

// ============================================================================
// Unified Initializer
// ============================================================================

/**
 * Initialize missing Hermes SQLite tables with proper schemas.
 * Existing tables only receive safe additive columns.
 * Call this once at application bootstrap.
 */
export function initAllHermesTables(): void {
  const db = getDb()
  if (!db) return

  try {
    // Usage store
    ensureUsageTableSchema()

    // Session store
    syncTable(SESSIONS_TABLE, SESSIONS_SCHEMA)
    syncTable(MESSAGES_TABLE, MESSAGES_SCHEMA)
    db.exec(MESSAGES_INDEX)

    // Compression snapshot
    syncTable(COMPRESSION_SNAPSHOT_TABLE, COMPRESSION_SNAPSHOT_SCHEMA)

    // Model context
    syncTable(MODEL_CONTEXT_TABLE, MODEL_CONTEXT_SCHEMA, {
      indexes: {
        idx_model_context_provider_model: MODEL_CONTEXT_INDEX,
      }
    })

    // Group chat - basic tables
    syncTable(GC_ROOMS_TABLE, GC_ROOMS_SCHEMA)
    syncTable(GC_MESSAGES_TABLE, GC_MESSAGES_SCHEMA)
    syncTable(GC_CONTEXT_SNAPSHOTS_TABLE, GC_CONTEXT_SNAPSHOTS_SCHEMA)
    syncTable(GC_PENDING_SESSION_DELETES_TABLE, GC_PENDING_SESSION_DELETES_SCHEMA)
    syncTable(GC_SESSION_PROFILES_TABLE, GC_SESSION_PROFILES_SCHEMA)
    syncTable(SESSION_LINEAGE_TABLE, SESSION_LINEAGE_SCHEMA)

    // Lightweight conversation lineage
    syncTable(CONVERSATION_THREADS_TABLE, CONVERSATION_THREADS_SCHEMA)
    syncTable(CONVERSATION_SESSION_EDGES_TABLE, CONVERSATION_SESSION_EDGES_SCHEMA)
    syncTable(CONVERSATION_UI_EVENTS_TABLE, CONVERSATION_UI_EVENTS_SCHEMA)
    syncTable(CONVERSATION_DISPLAY_RULES_TABLE, CONVERSATION_DISPLAY_RULES_SCHEMA)
    for (const indexSQL of Object.values(CONVERSATION_LINEAGE_INDEXES)) {
      db.exec(indexSQL)
    }

    // Group chat - single-column primary key tables (PRIMARY KEY in column definition)
    syncTable(GC_ROOM_AGENTS_TABLE, GC_ROOM_AGENTS_SCHEMA, {
      indexes: {
        idx_gc_room_agents_profile: 'CREATE INDEX idx_gc_room_agents_profile ON gc_room_agents(profile)',
      }
    })

    syncTable(GC_ROOM_MEMBERS_TABLE, GC_ROOM_MEMBERS_SCHEMA, {
      indexes: {
        idx_gc_room_members_user: 'CREATE INDEX idx_gc_room_members_user ON gc_room_members(userId)',
      }
    })
  } catch (e) {
    console.error('Error initializing Hermes SQLite tables:', e)
    console.error(`[Schema] Database initialization failed. Existing database was left untouched: ${getStoragePath()}`)
    throw e
  }
}
