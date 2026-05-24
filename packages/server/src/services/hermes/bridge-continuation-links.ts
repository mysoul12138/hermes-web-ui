import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getActiveProfileDir } from './hermes-profile'
import { invalidateCanonicalConversationFactsCache } from '../../db/hermes/canonical-facts-cache-invalidation'

const DB_FILE = 'webui-bridge-links.db'
const TABLE = 'bridge_continuation_links'

function dbPath(): string {
  return join(getActiveProfileDir(), DB_FILE)
}

function openDb(): DatabaseSync {
  mkdirSync(getActiveProfileDir(), { recursive: true })
  const db = new DatabaseSync(dbPath())
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      child_session_id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL
    )
  `)
  return db
}

export function readBridgeContinuationLinks(): Record<string, string> {
  if (!existsSync(dbPath())) return {}
  const db = openDb()
  try {
    const rows = db.prepare(`SELECT child_session_id, parent_session_id FROM ${TABLE}`).all() as Array<Record<string, unknown>>
    const out: Record<string, string> = {}
    for (const row of rows) {
      const child = String(row.child_session_id || '').trim()
      const parent = String(row.parent_session_id || '').trim()
      if (!child || !parent || child === parent) continue
      out[child] = parent
    }
    return out
  } finally {
    db.close()
  }
}

export function readBridgeContinuationParent(sessionId: string): string | null {
  const child = sessionId.trim()
  if (!child) return null
  if (!existsSync(dbPath())) return null
  const db = openDb()
  try {
    const row = db.prepare(`SELECT parent_session_id FROM ${TABLE} WHERE child_session_id = ?`).get(child) as { parent_session_id?: string } | undefined
    const parent = String(row?.parent_session_id || '').trim()
    return parent || null
  } finally {
    db.close()
  }
}

export function writeBridgeContinuationLink(childSessionId: string, parentSessionId: string) {
  const child = childSessionId.trim()
  const parent = parentSessionId.trim()
  if (!child || !parent || child === parent) return
  const db = openDb()
  try {
    db.prepare(`
      INSERT INTO ${TABLE} (child_session_id, parent_session_id)
      VALUES (?, ?)
      ON CONFLICT(child_session_id) DO UPDATE SET parent_session_id = excluded.parent_session_id
    `).run(child, parent)
    invalidateCanonicalConversationFactsCache()
  } finally {
    db.close()
  }
}
