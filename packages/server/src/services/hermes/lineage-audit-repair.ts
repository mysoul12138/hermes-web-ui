import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'
import { getDb } from '../../db'
import {
  listActiveExplicitConversationSessionEdges,
  recordBridgeConversationLineage,
} from '../../db/hermes/conversation-lineage'
import { invalidateCanonicalConversationFactsCache } from '../../db/hermes/canonical-facts-cache-invalidation'
import { listSessionLineage, upsertSessionLineage } from '../../db/hermes/session-lineage'
import { getActiveProfileDir } from './hermes-profile'
import {
  readBridgeContinuationLinks,
  writeBridgeContinuationLink,
} from './bridge-continuation-links'

const BRIDGE_CONTEXT_PROMPT_PREFIX = 'previous conversation context:'
const BRIDGE_CURRENT_USER_MARKER = 'current user message:'
const STRONG_ANCHOR_MIN_LENGTH = 24
const EMPTY_COMPRESSION_STUB_MAX_GAP_SECONDS = 5

type LineageAuditStatus = 'repairable' | 'rejected' | 'repaired'

export type LineageAuditRejectReason =
  | 'child-not-found'
  | 'child-not-parentless-tui'
  | 'first-visible-user-not-bridge-context'
  | 'existing-native-parent'
  | 'existing-explicit-parent'
  | 'existing-bridge-parent'
  | 'no-anchor-candidate'
  | 'multiple-anchor-candidates'
  | 'branch-or-subagent-conflict'
  | 'manual-review-required'
  | 'write-failed'

export type LineageAuditDiagnostic = 'overlap-with-parent-activity'

export interface LineageAuditEvidence {
  anchorParentSessionId: string
  childStartedAt: number
  parentEndedAt: number | null
  parentLastVisibleDbMessageAt: number | null
  parentRawJsonActivityAfterChildStart: boolean
  parentRawJsonActivityAfterChildStartAt: number | null
  parentToolActivityAfterChildStart: boolean
  parentToolActivityAfterChildStartAt: number | null
}

export interface LineageAuditRepairOptions {
  childSessionId: string
  dryRun?: boolean
  nowSeconds?: number
}

export interface LineageAuditRepairResult {
  status: LineageAuditStatus
  dryRun: boolean
  childSessionId: string
  parentSessionId: string | null
  conversationId: string | null
  rootSessionId: string | null
  reason?: LineageAuditRejectReason
  diagnostic?: LineageAuditDiagnostic
  evidence?: LineageAuditEvidence
  matchedAnchor?: string
}

interface AuditSessionRow {
  id: string
  source: string
  parent_session_id: string | null
  started_at: number
  ended_at: number | null
  end_reason: string | null
  title: string | null
  message_count: number
  tool_call_count: number
}

interface VisibleMessageRow {
  id: number
  session_id: string
  role: string
  content: string
  timestamp: number
}

interface ParentCandidate {
  session: AuditSessionRow
  anchor: string
}

interface ParentOverlapActivity {
  rawJsonActivityAfterChildStart: boolean
  rawJsonActivityAfterChildStartAt: number | null
  toolActivityAfterChildStart: boolean
  toolActivityAfterChildStartAt: number | null
}

function stateDbPath(): string {
  return join(getActiveProfileDir(), 'state.db')
}

function openStateDbReadOnly(): DatabaseSync | null {
  const path = stateDbPath()
  if (!existsSync(path)) return null
  return new DatabaseSync(path, { open: true, readOnly: true })
}

function normalizeNullable(value: unknown): string | null {
  if (value == null) return null
  const text = String(value).trim()
  return text || null
}

function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function mapSession(row: Record<string, unknown>): AuditSessionRow {
  return {
    id: String(row.id || ''),
    source: String(row.source || ''),
    parent_session_id: normalizeNullable(row.parent_session_id),
    started_at: Number(row.started_at || 0),
    ended_at: row.ended_at == null ? null : Number(row.ended_at),
    end_reason: normalizeNullable(row.end_reason),
    title: normalizeNullable(row.title),
    message_count: Number(row.message_count || 0),
    tool_call_count: Number(row.tool_call_count || 0),
  }
}

function mapMessage(row: Record<string, unknown>): VisibleMessageRow {
  return {
    id: Number(row.id || 0),
    session_id: String(row.session_id || ''),
    role: String(row.role || ''),
    content: String(row.content || ''),
    timestamp: Number(row.timestamp || 0),
  }
}

function dbTableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table'
      AND name = ?
    LIMIT 1
  `).get(tableName) as Record<string, unknown> | undefined
  return !!row
}

function loadSessions(db: DatabaseSync): AuditSessionRow[] {
  const rows = db.prepare(`
    SELECT id, source, parent_session_id, started_at, ended_at, end_reason, title, message_count, tool_call_count
    FROM sessions
    WHERE source != 'tool'
    ORDER BY started_at, id
  `).all() as Record<string, unknown>[]
  return rows.map(mapSession)
}

function loadVisibleMessages(db: DatabaseSync): VisibleMessageRow[] {
  const rows = db.prepare(`
    SELECT id, session_id, role, content, timestamp
    FROM messages
    WHERE content IS NOT NULL
      AND content != ''
      AND (
        role = 'assistant'
        OR (
          role = 'user'
          AND LOWER(content) NOT LIKE '[system:%'
          AND LOWER(content) NOT LIKE 'you''ve reached the maximum number of tool-calling iterations allowed.%'
          AND LOWER(content) NOT LIKE 'you have reached the maximum number of tool-calling iterations allowed.%'
        )
      )
    ORDER BY timestamp, id
  `).all() as Record<string, unknown>[]
  return rows.map(mapMessage)
}

function firstVisibleUser(messages: VisibleMessageRow[], sessionId: string): VisibleMessageRow | null {
  return messages.find(message => message.session_id === sessionId && message.role === 'user') || null
}

function bridgeContextHistory(prompt: string): string {
  const text = prompt.trim()
  const normalized = text.toLowerCase()
  if (!normalized.startsWith(BRIDGE_CONTEXT_PROMPT_PREFIX)) return ''
  const markerIndex = normalized.lastIndexOf(BRIDGE_CURRENT_USER_MARKER)
  const history = markerIndex >= 0 ? text.slice(0, markerIndex) : text
  return normalizeText(history.replace(/^previous conversation context:\s*/i, ''))
}

function hasExistingExplicitParent(childId: string): boolean {
  const lineageParent = listSessionLineage().some(row =>
    row.session_id === childId
    && row.authority === 'explicit'
    && !!row.parent_session_id
  )
  if (lineageParent) return true

  const webuiDb = getDb()
  if (webuiDb) {
    if (listActiveExplicitConversationSessionEdges(webuiDb).some(edge =>
      edge.child_session_id === childId
      && edge.edge_type !== 'root'
      && !!edge.parent_session_id
    )) return true
  }

  return false
}

function sessionHasAnyLineageRow(sessionId: string): boolean {
  return listSessionLineage().some(row =>
    row.session_id === sessionId
    || row.parent_session_id === sessionId
    || row.root_session_id === sessionId
    || row.logical_conversation_id === sessionId
    || row.web_session_id === sessionId
    || row.bridge_session_id === sessionId
    || row.persistent_session_id === sessionId
  )
}

function sessionHasAnyConversationEdge(sessionId: string): boolean {
  const webuiDb = getDb()
  if (!webuiDb || !dbTableExists(webuiDb, 'conversation_session_edges')) return false
  const row = webuiDb.prepare(`
    SELECT 1
    FROM conversation_session_edges
    WHERE superseded_at IS NULL
      AND (
        conversation_id = ?
        OR parent_session_id = ?
        OR child_session_id = ?
      )
    LIMIT 1
  `).get(sessionId, sessionId, sessionId) as Record<string, unknown> | undefined
  return !!row
}

function sessionHasAnyConversationUiEvent(sessionId: string): boolean {
  const webuiDb = getDb()
  if (!webuiDb || !dbTableExists(webuiDb, 'conversation_ui_events')) return false
  const row = webuiDb.prepare(`
    SELECT 1
    FROM conversation_ui_events
    WHERE superseded_at IS NULL
      AND (
        conversation_id = ?
        OR source_session_id = ?
        OR anchor_session_id = ?
      )
    LIMIT 1
  `).get(sessionId, sessionId, sessionId) as Record<string, unknown> | undefined
  return !!row
}

function sessionHasAnyBridgeLink(sessionId: string): boolean {
  const links = readBridgeContinuationLinks()
  if (links[sessionId]) return true
  return Object.values(links).some(parentId => parentId === sessionId)
}

function sessionHasExplicitLineageEdgeBridgeOrUiEvent(sessionId: string): boolean {
  return sessionHasAnyLineageRow(sessionId)
    || sessionHasAnyConversationEdge(sessionId)
    || sessionHasAnyBridgeLink(sessionId)
    || sessionHasAnyConversationUiEvent(sessionId)
}

function sessionMessages(messages: VisibleMessageRow[], sessionId: string): VisibleMessageRow[] {
  return messages.filter(message => message.session_id === sessionId)
}

function anchorSnippetsForParent(parentMessages: VisibleMessageRow[]): string[] {
  const snippets = new Set<string>()
  const visible = parentMessages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .map(message => `${message.role}: ${message.content}`)
    .map(normalizeText)
    .filter(text => text.length >= STRONG_ANCHOR_MIN_LENGTH)

  for (const text of visible) snippets.add(text)
  const tail = visible.at(-1)
  if (tail) snippets.add(tail)
  const full = visible.join(' ')
  if (full.length >= STRONG_ANCHOR_MIN_LENGTH) snippets.add(full)
  return [...snippets]
}

function countDbMessages(db: DatabaseSync, sessionId: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM messages
    WHERE session_id = ?
  `).get(sessionId) as { count?: number } | undefined
  return Number(row?.count || 0)
}

function parentLastVisibleDbMessageAt(messages: VisibleMessageRow[], parentId: string): number | null {
  const timestamp = sessionMessages(messages, parentId).at(-1)?.timestamp
  return timestamp == null ? null : timestamp
}

function detectParentOverlapActivity(
  db: DatabaseSync,
  parent: AuditSessionRow,
  child: AuditSessionRow,
): ParentOverlapActivity {
  const rawRow = db.prepare(`
    SELECT MIN(timestamp) AS timestamp
    FROM messages
    WHERE session_id = ?
      AND timestamp >= ?
      AND (
        content IS NOT NULL
        OR tool_calls IS NOT NULL
        OR tool_name IS NOT NULL
        OR tool_call_id IS NOT NULL
      )
  `).get(parent.id, child.started_at) as { timestamp?: number | null } | undefined
  const toolRow = db.prepare(`
    SELECT MIN(timestamp) AS timestamp
    FROM messages
    WHERE session_id = ?
      AND timestamp >= ?
      AND (
        role = 'tool'
        OR tool_calls IS NOT NULL
        OR tool_name IS NOT NULL
        OR tool_call_id IS NOT NULL
      )
  `).get(parent.id, child.started_at) as { timestamp?: number | null } | undefined
  const rawJsonActivityAfterChildStartAt = rawRow?.timestamp == null ? null : Number(rawRow.timestamp)
  const toolActivityAfterChildStartAt = toolRow?.timestamp == null ? null : Number(toolRow.timestamp)
  return {
    rawJsonActivityAfterChildStart: rawJsonActivityAfterChildStartAt != null,
    rawJsonActivityAfterChildStartAt,
    toolActivityAfterChildStart: toolActivityAfterChildStartAt != null,
    toolActivityAfterChildStartAt,
  }
}

function parentOverlapEvidence(
  db: DatabaseSync,
  parent: AuditSessionRow,
  child: AuditSessionRow,
  messages: VisibleMessageRow[],
): LineageAuditEvidence | null {
  const activity = detectParentOverlapActivity(db, parent, child)
  const parentEndsAfterChildStarts = parent.ended_at == null || child.started_at < parent.ended_at
  if (!parentEndsAfterChildStarts && !activity.rawJsonActivityAfterChildStart && !activity.toolActivityAfterChildStart) {
    return null
  }
  return {
    anchorParentSessionId: parent.id,
    childStartedAt: child.started_at,
    parentEndedAt: parent.ended_at,
    parentLastVisibleDbMessageAt: parentLastVisibleDbMessageAt(messages, parent.id),
    parentRawJsonActivityAfterChildStart: activity.rawJsonActivityAfterChildStart,
    parentRawJsonActivityAfterChildStartAt: activity.rawJsonActivityAfterChildStartAt,
    parentToolActivityAfterChildStart: activity.toolActivityAfterChildStart,
    parentToolActivityAfterChildStartAt: activity.toolActivityAfterChildStartAt,
  }
}

function hasCompressionEndReason(session: AuditSessionRow): boolean {
  const reason = normalizeText(session.end_reason)
  return reason === 'compression' || reason === 'compressed'
}

function hasCloseCompressionHandoff(parent: AuditSessionRow, child: AuditSessionRow): boolean {
  if (!hasCompressionEndReason(parent)) return false
  if (parent.ended_at == null) return false
  return Math.abs(child.started_at - parent.ended_at) <= EMPTY_COMPRESSION_STUB_MAX_GAP_SECONDS
}

function isIgnorableEmptyNativeCompressionStub(
  db: DatabaseSync,
  parent: AuditSessionRow,
  candidate: AuditSessionRow,
  sessions: AuditSessionRow[],
): boolean {
  if (candidate.source !== 'tui') return false
  if (candidate.parent_session_id !== parent.id) return false
  if (candidate.message_count !== 0 || candidate.tool_call_count !== 0) return false
  if (candidate.title) return false
  if (countDbMessages(db, candidate.id) !== 0) return false
  if (!hasCloseCompressionHandoff(parent, candidate)) return false
  if (sessions.some(session => session.parent_session_id === candidate.id)) return false
  if (sessionHasExplicitLineageEdgeBridgeOrUiEvent(candidate.id)) return false
  return true
}

function findStrongAnchorCandidates(
  child: AuditSessionRow,
  contextHistory: string,
  sessions: AuditSessionRow[],
  messages: VisibleMessageRow[],
): ParentCandidate[] {
  const candidates: ParentCandidate[] = []
  for (const session of sessions) {
    if (session.id === child.id) continue
    if (session.source !== 'tui') continue
    if (session.started_at > child.started_at) continue
    if (session.message_count <= 0 && session.tool_call_count <= 0) continue
    const anchors = anchorSnippetsForParent(sessionMessages(messages, session.id))
    const matched = anchors.find(anchor => contextHistory.includes(anchor))
    if (matched) candidates.push({ session, anchor: matched })
  }
  return candidates
}

function hasBranchOrSubagentConflict(
  db: DatabaseSync,
  parent: AuditSessionRow,
  child: AuditSessionRow,
  sessions: AuditSessionRow[],
): boolean {
  if (parent.ended_at == null) return true
  if (child.started_at < parent.ended_at) return true

  return sessions.some(session =>
    session.id !== child.id
    && session.parent_session_id === parent.id
    && session.source === parent.source
    && session.started_at < child.started_at
    && !isIgnorableEmptyNativeCompressionStub(db, parent, session, sessions)
  )
}

function rootForParent(parent: AuditSessionRow): string {
  const lineage = listSessionLineage().find(row =>
    row.session_id === parent.id
    || row.persistent_session_id === parent.id
    || row.web_session_id === parent.id
  )
  return lineage?.root_session_id || lineage?.logical_conversation_id || parent.id
}

function rejected(
  childSessionId: string,
  dryRun: boolean,
  reason: LineageAuditRejectReason,
  overrides: Partial<LineageAuditRepairResult> = {},
): LineageAuditRepairResult {
  return {
    status: 'rejected',
    dryRun,
    childSessionId,
    parentSessionId: null,
    conversationId: null,
    rootSessionId: null,
    reason,
    ...overrides,
  }
}

export function auditTuiContinuationLineage(
  options: LineageAuditRepairOptions,
): LineageAuditRepairResult {
  const childSessionId = options.childSessionId.trim()
  const dryRun = options.dryRun !== false
  const db = openStateDbReadOnly()
  if (!db) return rejected(childSessionId, dryRun, 'child-not-found')

  try {
    const sessions = loadSessions(db)
    const child = sessions.find(session => session.id === childSessionId)
    if (!child) return rejected(childSessionId, dryRun, 'child-not-found')
    if (child.source !== 'tui' || child.parent_session_id) {
      return rejected(childSessionId, dryRun, child.parent_session_id ? 'existing-native-parent' : 'child-not-parentless-tui')
    }

    const messages = loadVisibleMessages(db)
    const firstUser = firstVisibleUser(messages, child.id)
    const contextHistory = firstUser ? bridgeContextHistory(firstUser.content) : ''
    if (!firstUser || !contextHistory) {
      return rejected(childSessionId, dryRun, 'first-visible-user-not-bridge-context')
    }

    if (hasExistingExplicitParent(child.id)) return rejected(childSessionId, dryRun, 'existing-explicit-parent')
    if (readBridgeContinuationLinks()[child.id]) return rejected(childSessionId, dryRun, 'existing-bridge-parent')

    const candidates = findStrongAnchorCandidates(child, contextHistory, sessions, messages)
    if (!candidates.length) return rejected(childSessionId, dryRun, 'no-anchor-candidate')
    const uniqueParentIds = new Set(candidates.map(candidate => candidate.session.id))
    if (uniqueParentIds.size !== 1) return rejected(childSessionId, dryRun, 'multiple-anchor-candidates')

    const candidate = candidates[0]
    const overlapEvidence = parentOverlapEvidence(db, candidate.session, child, messages)
    if (overlapEvidence) {
      return rejected(childSessionId, dryRun, 'manual-review-required', {
        parentSessionId: candidate.session.id,
        diagnostic: 'overlap-with-parent-activity',
        evidence: overlapEvidence,
        matchedAnchor: candidate.anchor,
      })
    }
    if (hasBranchOrSubagentConflict(db, candidate.session, child, sessions)) {
      return rejected(childSessionId, dryRun, 'branch-or-subagent-conflict')
    }

    const rootSessionId = rootForParent(candidate.session)
    return {
      status: 'repairable',
      dryRun,
      childSessionId: child.id,
      parentSessionId: candidate.session.id,
      conversationId: rootSessionId,
      rootSessionId,
      matchedAnchor: candidate.anchor,
    }
  } finally {
    db.close()
  }
}

export function repairTuiContinuationLineage(
  options: LineageAuditRepairOptions,
): LineageAuditRepairResult {
  const audit = auditTuiContinuationLineage({ ...options, dryRun: true })
  const dryRun = options.dryRun !== false
  if (audit.status !== 'repairable' || dryRun) return { ...audit, dryRun }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (!audit.parentSessionId || !audit.rootSessionId || !audit.conversationId) {
    return { ...audit, status: 'rejected', dryRun: false, reason: 'write-failed' }
  }

  try {
    upsertSessionLineage({
      session_id: audit.childSessionId,
      logical_conversation_id: audit.conversationId,
      source: 'tui',
      authority: 'explicit',
      relation_kind: 'continuation',
      parent_session_id: audit.parentSessionId,
      root_session_id: audit.rootSessionId,
      web_session_id: null,
      bridge_session_id: null,
      persistent_session_id: audit.childSessionId,
      created_at: now,
    })
    recordBridgeConversationLineage({
      conversation_id: audit.conversationId,
      root_session_id: audit.rootSessionId,
      child_session_id: audit.childSessionId,
      parent_session_id: audit.parentSessionId,
      created_at: now,
    })
    writeBridgeContinuationLink(audit.childSessionId, audit.parentSessionId)
    invalidateCanonicalConversationFactsCache()
    return { ...audit, status: 'repaired', dryRun: false }
  } catch {
    return { ...audit, status: 'rejected', dryRun: false, reason: 'write-failed' }
  }
}
