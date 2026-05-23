import { getDb, isSqliteAvailable } from '../index'
import { SESSION_LINEAGE_SCHEMA, SESSION_LINEAGE_TABLE } from './schemas'
import { invalidateCanonicalConversationFactsCache } from './canonical-facts-cache-invalidation'

export type SessionLineageAuthority = 'explicit' | 'inferred' | 'repaired'
export type SessionLineageRelation = 'root' | 'continuation' | 'branch' | 'wrapper'

export interface SessionLineageRow {
  session_id: string
  logical_conversation_id: string
  source: string
  authority: SessionLineageAuthority
  relation_kind: SessionLineageRelation
  parent_session_id: string | null
  root_session_id: string | null
  web_session_id: string | null
  bridge_session_id: string | null
  persistent_session_id: string | null
  created_at: number
  updated_at: number
}

function mapRow(row: Record<string, unknown>): SessionLineageRow {
  return {
    session_id: String(row.session_id || ''),
    logical_conversation_id: String(row.logical_conversation_id || ''),
    source: String(row.source || 'unknown'),
    authority: String(row.authority || 'explicit') as SessionLineageAuthority,
    relation_kind: String(row.relation_kind || 'root') as SessionLineageRelation,
    parent_session_id: row.parent_session_id != null ? String(row.parent_session_id) : null,
    root_session_id: row.root_session_id != null ? String(row.root_session_id) : null,
    web_session_id: row.web_session_id != null ? String(row.web_session_id) : null,
    bridge_session_id: row.bridge_session_id != null ? String(row.bridge_session_id) : null,
    persistent_session_id: row.persistent_session_id != null ? String(row.persistent_session_id) : null,
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
  }
}

function ensureLineageTable(): void {
  const db = safeDb()
  if (!db) return
  try {
    const columns = Object.entries(SESSION_LINEAGE_SCHEMA)
      .map(([name, def]) => `"${name}" ${def}`)
      .join(', ')
    db.exec(`CREATE TABLE IF NOT EXISTS ${SESSION_LINEAGE_TABLE} (${columns})`)
  } catch {
    // Lineage is a best-effort projection aid. Read-side callers must keep
    // working even if the auxiliary registry is temporarily unavailable.
  }
}

function safeDb() {
  if (!isSqliteAvailable()) return null
  try {
    return getDb()
  } catch {
    return null
  }
}

function normalizeSessionId(value: string | null | undefined): string {
  return (value || '').trim()
}

function rowMatchesAlias(row: SessionLineageRow, sessionId: string): boolean {
  const target = normalizeSessionId(sessionId)
  if (!target) return false
  return (
    row.session_id === target
    || row.web_session_id === target
    || row.bridge_session_id === target
    || row.persistent_session_id === target
  )
}

export function getSessionLineage(sessionId: string): SessionLineageRow | null {
  const db = safeDb()
  if (!db) return null
  ensureLineageTable()
  try {
    const row = db.prepare(`
      SELECT *
      FROM ${SESSION_LINEAGE_TABLE}
      WHERE session_id = ?
    `).get(sessionId) as Record<string, unknown> | undefined
    return row ? mapRow(row) : null
  } catch {
    return null
  }
}

export function findSessionLineage(sessionId: string): SessionLineageRow | null {
  const target = normalizeSessionId(sessionId)
  if (!target) return null
  const direct = getSessionLineage(target)
  if (direct) return direct
  return listSessionLineage().find(row => rowMatchesAlias(row, target)) || null
}

export function getSessionLineageByLogicalId(logicalConversationId: string): SessionLineageRow[] {
  const db = safeDb()
  if (!db) return []
  ensureLineageTable()
  try {
    const rows = db.prepare(`
      SELECT *
      FROM ${SESSION_LINEAGE_TABLE}
      WHERE logical_conversation_id = ?
      ORDER BY created_at, session_id
    `).all(logicalConversationId) as Record<string, unknown>[]
    return rows.map(mapRow)
  } catch {
    return []
  }
}

export function listSessionLineage(source?: string): SessionLineageRow[] {
  const db = safeDb()
  if (!db) return []
  ensureLineageTable()
  try {
    const rows = source
      ? db.prepare(`
          SELECT *
          FROM ${SESSION_LINEAGE_TABLE}
          WHERE source = ?
          ORDER BY updated_at DESC, created_at DESC, session_id DESC
        `).all(source) as Record<string, unknown>[]
      : db.prepare(`
          SELECT *
          FROM ${SESSION_LINEAGE_TABLE}
          ORDER BY updated_at DESC, created_at DESC, session_id DESC
        `).all() as Record<string, unknown>[]
    return rows.map(mapRow)
  } catch {
    return []
  }
}

export function getLogicalConversationIdForSession(sessionId: string): string | null {
  const row = findSessionLineage(sessionId)
  if (!row) return null
  return row.logical_conversation_id || row.session_id
}

export function resolveCanonicalSessionId(sessionId: string): string | null {
  const row = findSessionLineage(sessionId)
  if (row?.web_session_id) return row.web_session_id
  const logicalId = row?.logical_conversation_id || getLogicalConversationIdForSession(sessionId)
  if (!logicalId) return null
  const rows = getSessionLineageByLogicalId(logicalId)
  if (!rows.length) return null

  const explicitWebRoot = rows.find(item =>
    item.web_session_id
    && item.logical_conversation_id === logicalId
    && (!item.parent_session_id || item.web_session_id === item.session_id),
  )
  if (explicitWebRoot?.web_session_id) return explicitWebRoot.web_session_id

  const explicitRoot = rows.find(row => row.relation_kind === 'root' && row.session_id)
  if (explicitRoot) return explicitRoot.session_id

  const rootBacked = rows.find(row => row.root_session_id && row.root_session_id === row.session_id)
  if (rootBacked) return rootBacked.session_id

  const parentless = rows.find(row => !row.parent_session_id)
  if (parentless) return parentless.session_id

  return rows[0].session_id
}

export function resolveLineageSeed(...sessionIds: Array<string | null | undefined>): {
  logicalConversationId: string
  rootSessionId: string
} | null {
  for (const rawId of sessionIds) {
    const target = normalizeSessionId(rawId)
    if (!target) continue
    const row = findSessionLineage(target)
    if (!row) continue
    const rootSessionId = normalizeSessionId(
      row.web_session_id
      || resolveCanonicalSessionId(row.session_id)
      || row.root_session_id
      || row.session_id,
    )
    const logicalConversationId = normalizeSessionId(row.logical_conversation_id || rootSessionId || row.session_id)
    if (!logicalConversationId || !rootSessionId) continue
    return {
      logicalConversationId,
      rootSessionId,
    }
  }
  return null
}

export function upsertSessionLineage(
  row: Omit<SessionLineageRow, 'created_at' | 'updated_at'> & { created_at?: number },
): void {
  const db = safeDb()
  if (!db) return
  ensureLineageTable()
  const now = Math.floor(Date.now() / 1000)
  try {
    db.prepare(`
      INSERT INTO ${SESSION_LINEAGE_TABLE} (
        session_id,
        logical_conversation_id,
        source,
        authority,
        relation_kind,
        parent_session_id,
        root_session_id,
        web_session_id,
        bridge_session_id,
        persistent_session_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        logical_conversation_id = excluded.logical_conversation_id,
        source = excluded.source,
        authority = excluded.authority,
        relation_kind = excluded.relation_kind,
        parent_session_id = excluded.parent_session_id,
        root_session_id = excluded.root_session_id,
        web_session_id = excluded.web_session_id,
        bridge_session_id = excluded.bridge_session_id,
        persistent_session_id = excluded.persistent_session_id,
        updated_at = excluded.updated_at
    `).run(
      row.session_id,
      row.logical_conversation_id,
      row.source,
      row.authority,
      row.relation_kind,
      row.parent_session_id,
      row.root_session_id,
      row.web_session_id,
      row.bridge_session_id,
      row.persistent_session_id,
      row.created_at ?? now,
      now,
    )
    invalidateCanonicalConversationFactsCache()
  } catch {
    // Best-effort only.
  }
}
