import { getActiveProfileDir } from '../../services/hermes/hermes-profile'
import type {
  ConversationBranch,
  ConversationDetail,
  ConversationListOptions,
  ConversationMessage,
  ConversationSummary,
} from '../../services/hermes/conversations'
import { listLiveTuiSessionKeys } from '../../services/hermes/tui-live'

const SQLITE_AVAILABLE = (() => {
  const [major, minor] = process.versions.node.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 5)
})()

const LINEAGE_TOLERANCE_SECONDS = 3
const DUPLICATE_CONTINUATION_WINDOW_SECONDS = 600
const LIVE_WINDOW_SECONDS = 300
const DEFAULT_CONVERSATION_LIMIT = 200
const SYNTHETIC_USER_PREFIXES = [
  '[system:',
  "you've reached the maximum number of tool-calling iterations allowed.",
  'you have reached the maximum number of tool-calling iterations allowed.',
]

const VISIBLE_HUMAN_MESSAGE_SQL = `
  m.content IS NOT NULL
  AND m.content != ''
  AND (
    m.role = 'assistant'
    OR (
      m.role = 'user'
      AND LOWER(m.content) NOT LIKE '[system:%'
      AND LOWER(m.content) NOT LIKE 'you''ve reached the maximum number of tool-calling iterations allowed.%'
      AND LOWER(m.content) NOT LIKE 'you have reached the maximum number of tool-calling iterations allowed.%'
    )
  )
`

interface ConversationSessionRow {
  id: string
  source: string
  user_id: string | null
  model: string
  title: string | null
  parent_session_id: string | null
  started_at: number
  ended_at: number | null
  end_reason: string | null
  message_count: number
  tool_call_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  billing_provider: string | null
  estimated_cost_usd: number
  actual_cost_usd: number | null
  cost_status: string
  preview: string
  last_active: number
  has_visible_messages: boolean
  is_active: boolean
  is_live_tui_process?: boolean
}

function conversationDbPath(): string {
  return `${getActiveProfileDir()}/state.db`
}

function normalizeNumber(value: unknown, fallback = 0): number {
  if (value == null || value === '') return fallback
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

function normalizeNullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function normalizeNullableString(value: unknown): string | null {
  if (value == null || value === '') return null
  return String(value)
}

function safeText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
      try {
        const parsed = JSON.parse(trimmed)
        const nested = textFromContent(parsed)
        if (nested) return nested
      } catch {
        // Fall back to the original string below.
      }
    }
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value
      .map(item => textFromContent(item).trim())
      .filter(Boolean)
      .join('\n')
  }
  if (!value || typeof value !== 'object') return ''

  const record = value as Record<string, unknown>
  for (const key of ['text', 'content', 'value'] as const) {
    const direct = record[key]
    if (typeof direct === 'string') return direct
    if (Array.isArray(direct)) {
      const nested = textFromContent(direct)
      if (nested) return nested
    }
  }

  for (const key of ['parts', 'children', 'items'] as const) {
    if (Array.isArray(record[key])) {
      const nested = textFromContent(record[key])
      if (nested) return nested
    }
  }

  const flattened = Object.values(record)
    .map(entry => textFromContent(entry).trim())
    .filter(Boolean)
    .join('\n')
  if (flattened) return flattened

  try {
    return JSON.stringify(record)
  } catch {
    return ''
  }
}

function normalizeText(value: unknown): string {
  return textFromContent(value).replace(/\s+/g, ' ').trim().toLowerCase()
}

function excerpt(value: unknown, width = 80): string {
  const text = textFromContent(value).replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > width ? `${text.slice(0, width)}…` : text
}

function isSyntheticUserText(content: unknown): boolean {
  const text = normalizeText(content)
  return SYNTHETIC_USER_PREFIXES.some(prefix => text.startsWith(prefix))
}

function mapSessionRow(row: Record<string, unknown>, nowSeconds: number, liveTuiSessionKeys: Set<string>): ConversationSessionRow {
  const id = String(row.id || '')
  const source = String(row.source || '')
  const startedAt = normalizeNumber(row.started_at)
  const endedAt = normalizeNullableNumber(row.ended_at)
  const preview = excerpt(row.preview || '')
  const rawTitle = normalizeNullableString(row.title)
  const title = rawTitle || (preview ? (preview.length > 40 ? `${preview.slice(0, 40)}...` : preview) : null)
  const lastActive = normalizeNumber(row.last_active, startedAt)
  const isLiveTuiProcess = source === 'tui' && liveTuiSessionKeys.has(id)

  return {
    id,
    source,
    user_id: normalizeNullableString(row.user_id),
    model: String(row.model || ''),
    title,
    parent_session_id: normalizeNullableString(row.parent_session_id),
    started_at: startedAt,
    ended_at: endedAt,
    end_reason: normalizeNullableString(row.end_reason),
    message_count: normalizeNumber(row.message_count),
    tool_call_count: normalizeNumber(row.tool_call_count),
    input_tokens: normalizeNumber(row.input_tokens),
    output_tokens: normalizeNumber(row.output_tokens),
    cache_read_tokens: normalizeNumber(row.cache_read_tokens),
    cache_write_tokens: normalizeNumber(row.cache_write_tokens),
    reasoning_tokens: normalizeNumber(row.reasoning_tokens),
    billing_provider: normalizeNullableString(row.billing_provider),
    estimated_cost_usd: normalizeNumber(row.estimated_cost_usd),
    actual_cost_usd: normalizeNullableNumber(row.actual_cost_usd),
    cost_status: String(row.cost_status || ''),
    preview: preview || (isLiveTuiProcess ? 'Running TUI session' : ''),
    last_active: lastActive,
    has_visible_messages: !!normalizeNumber(row.has_visible_messages) || isLiveTuiProcess,
    is_active: isLiveTuiProcess || (endedAt == null && nowSeconds - lastActive <= LIVE_WINDOW_SECONDS),
    is_live_tui_process: isLiveTuiProcess,
  }
}

function createLiveTuiPlaceholderSession(id: string, nowSeconds: number): ConversationSessionRow {
  return {
    id,
    source: 'tui',
    user_id: null,
    model: '',
    title: null,
    parent_session_id: null,
    started_at: nowSeconds,
    ended_at: null,
    end_reason: null,
    message_count: 0,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: null,
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    cost_status: '',
    preview: 'Running TUI session',
    last_active: nowSeconds,
    has_visible_messages: true,
    is_active: true,
    is_live_tui_process: true,
  }
}

function sortByRecency<T extends { last_active: number; started_at: number; id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (b.last_active !== a.last_active) return b.last_active - a.last_active
    if (b.started_at !== a.started_at) return b.started_at - a.started_at
    return a.id.localeCompare(b.id)
  })
}

function timingMatchesParent(parent: ConversationSessionRow | undefined, child: ConversationSessionRow | undefined): boolean {
  if (!parent || !child || parent.ended_at == null) return false
  return Math.abs(Number(child.started_at || 0) - Number(parent.ended_at || 0)) <= LINEAGE_TOLERANCE_SECONDS
}

function isCompressionEndReason(reason: string | null): boolean {
  return reason === 'compression' || reason === 'compressed'
}

function isLikelyOrphanContinuation(parent: ConversationSessionRow, child: ConversationSessionRow): boolean {
  if (child.id === parent.id || child.source !== parent.source || child.source === 'tool') return false
  if (parent.ended_at == null) return false
  const delta = Number(child.started_at || 0) - Number(parent.ended_at || 0)
  if (delta < 0) return false
  if (delta <= LINEAGE_TOLERANCE_SECONDS) return true
  if (delta > DUPLICATE_CONTINUATION_WINDOW_SECONDS) return false

  const parentPreview = normalizeText(parent.preview)
  const childPreview = normalizeText(child.preview)
  if (parentPreview && childPreview && parentPreview === childPreview) return true

  const parentTitle = normalizeText(parent.title)
  const childTitle = normalizeText(child.title)
  return !!parentTitle && !!childTitle && parentTitle === childTitle
}

function linkOrphanCompressionContinuations(sessions: ConversationSessionRow[]) {
  const parentless = sessions.filter(session => session.parent_session_id == null && session.source !== 'tool')
  const assignments = new Map<string, string | null>()

  for (const parent of sessions) {
    if (!isCompressionEndReason(parent.end_reason) || parent.ended_at == null) continue
    const candidates = parentless.filter(child => {
      return isLikelyOrphanContinuation(parent, child)
    })
    if (candidates.length !== 1) continue

    const child = candidates[0]
    const previous = assignments.get(child.id)
    assignments.set(child.id, previous == null ? parent.id : null)
  }

  for (const [childId, parentId] of assignments) {
    if (!parentId) continue
    const child = sessions.find(session => session.id === childId)
    if (child && child.parent_session_id == null) child.parent_session_id = parentId
  }
}

function continuationCandidates(parent: ConversationSessionRow, byId: Map<string, ConversationSessionRow>, childrenByParent: Map<string | null, string[]>, allowTool = false): ConversationSessionRow[] {
  const childIds = childrenByParent.get(parent.id) || []
  return childIds
    .map(childId => byId.get(childId))
    .filter((child): child is ConversationSessionRow => !!child)
    .filter(child => allowTool || child.source !== 'tool')
    .filter(child => child.source === parent.source)
    .filter(child => isLikelyOrphanContinuation(parent, child))
    .sort((a, b) => {
      const aDelta = Math.abs(Number(a.started_at || 0) - Number(parent.ended_at || 0))
      const bDelta = Math.abs(Number(b.started_at || 0) - Number(parent.ended_at || 0))
      if (aDelta !== bDelta) return aDelta - bDelta
      return a.id.localeCompare(b.id)
    })
}

function nextContinuationChild(parent: ConversationSessionRow, byId: Map<string, ConversationSessionRow>, childrenByParent: Map<string | null, string[]>, allowTool = false): ConversationSessionRow | null {
  if (!isCompressionEndReason(parent.end_reason)) return null
  const candidates = continuationCandidates(parent, byId, childrenByParent, allowTool)
  if (candidates.length === 1) return candidates[0]

  const exactPreviewMatches = candidates.filter(child => {
    const childPreview = normalizeText(child.preview)
    const parentPreview = normalizeText(parent.preview)
    return !!childPreview && childPreview === parentPreview
  })

  if (exactPreviewMatches.length === 1) return exactPreviewMatches[0]
  return null
}

function isCompressionContinuationChild(session: ConversationSessionRow | undefined, byId: Map<string, ConversationSessionRow>, childrenByParent: Map<string | null, string[]>): boolean {
  if (!session?.parent_session_id) return false
  const parent = byId.get(session.parent_session_id)
  if (!parent) return false
  return nextContinuationChild(parent, byId, childrenByParent)?.id === session.id
}

function compressionChainRootId(sessionId: string, byId: Map<string, ConversationSessionRow>, childrenByParent: Map<string | null, string[]>): string | null {
  let current = byId.get(sessionId) || null
  if (!current || current.source === 'tool') return null

  const seen = new Set<string>()
  while (current?.parent_session_id && !seen.has(current.id)) {
    seen.add(current.id)
    const parent = byId.get(current.parent_session_id)
    if (!parent) break
    if (nextContinuationChild(parent, byId, childrenByParent)?.id !== current.id) break
    current = parent
  }
  return current?.id || null
}

function isVisibleConversationStart(session: ConversationSessionRow | undefined, byId: Map<string, ConversationSessionRow>, childrenByParent: Map<string | null, string[]>): boolean {
  if (!session || session.source === 'tool') return false
  return !isCompressionContinuationChild(session, byId, childrenByParent)
}

function collectConversationChain(rootId: string, byId: Map<string, ConversationSessionRow>, childrenByParent: Map<string | null, string[]>, allowTool = false): ConversationSessionRow[] {
  const chain: ConversationSessionRow[] = []
  const seen = new Set<string>()
  let current = byId.get(rootId) || null
  while (current && !seen.has(current.id)) {
    chain.push(current)
    seen.add(current.id)
    current = nextContinuationChild(current, byId, childrenByParent, allowTool)
  }
  return chain
}

function toSummary(session: ConversationSessionRow): ConversationSummary {
  return {
    id: session.id,
    source: safeText(session.source),
    model: safeText(session.model),
    title: session.title ?? null,
    started_at: Number(session.started_at || 0),
    ended_at: session.ended_at ?? null,
    last_active: session.last_active,
    message_count: Number(session.message_count || 0),
    tool_call_count: Number(session.tool_call_count || 0),
    input_tokens: Number(session.input_tokens || 0),
    output_tokens: Number(session.output_tokens || 0),
    cache_read_tokens: Number(session.cache_read_tokens || 0),
    cache_write_tokens: Number(session.cache_write_tokens || 0),
    reasoning_tokens: Number(session.reasoning_tokens || 0),
    billing_provider: session.billing_provider ?? null,
    estimated_cost_usd: Number(session.estimated_cost_usd || 0),
    actual_cost_usd: session.actual_cost_usd ?? null,
    cost_status: safeText(session.cost_status),
    preview: session.preview,
    is_active: session.is_active,
    thread_session_count: 1,
    branch_session_count: 0,
  }
}

function aggregateSummary(rootId: string, byId: Map<string, ConversationSessionRow>, childrenByParent: Map<string | null, string[]>): ConversationSummary | null {
  const chain = collectConversationChain(rootId, byId, childrenByParent)
  if (!chain.length || !chain.some(session => session.has_visible_messages)) return null
  const root = chain[0]
  const last = chain[chain.length - 1]
  const firstPreview = chain.map(session => session.preview).find(Boolean) || ''
  const costStatuses = Array.from(new Set(chain.map(session => safeText(session.cost_status)).filter(Boolean)))
  const branchSessionCount = countConversationBranchSessions(chain, byId, childrenByParent)

  return {
    ...toSummary(last),
    title: last.title || root.title || firstPreview || null,
    preview: last.preview || root.preview || firstPreview,
    started_at: Number(root.started_at || 0),
    ended_at: last?.ended_at ?? null,
    last_active: Math.max(...chain.map(session => session.last_active)),
    is_active: chain.some(session => session.is_active),
    billing_provider: last?.billing_provider ?? root.billing_provider ?? null,
    cost_status: costStatuses.length === 1 ? costStatuses[0] : 'mixed',
    thread_session_count: chain.length,
    branch_session_count: branchSessionCount,
    message_count: chain.reduce((sum, session) => sum + Number(session.message_count || 0), 0),
    tool_call_count: chain.reduce((sum, session) => sum + Number(session.tool_call_count || 0), 0),
    input_tokens: Number(last.input_tokens || 0),
    output_tokens: Number(last.output_tokens || 0),
    cache_read_tokens: Number(last.cache_read_tokens || 0),
    cache_write_tokens: Number(last.cache_write_tokens || 0),
    reasoning_tokens: Number(last.reasoning_tokens || 0),
    estimated_cost_usd: chain.reduce((sum, session) => sum + Number(session.estimated_cost_usd || 0), 0),
    actual_cost_usd: chain.reduce<number | null>((sum, session) => {
      const actual = session.actual_cost_usd
      if (actual == null) return sum
      return (sum || 0) + Number(actual)
    }, null),
  }
}

function normalizeVisibleMessage(message: { id: number | string, session_id: string, role: string, content: unknown, timestamp: number }, fallbackTimestamp: number): ConversationMessage | null {
  const role = safeText(message.role)
  const content = textFromContent(message.content).trim()
  if (!content) return null
  if (role !== 'user' && role !== 'assistant') return null
  if (role === 'user' && isSyntheticUserText(content)) return null

  return {
    id: message.id,
    session_id: message.session_id,
    role,
    content,
    timestamp: Number.isFinite(Number(message.timestamp)) && Number(message.timestamp) > 0
      ? Number(message.timestamp)
      : fallbackTimestamp,
  }
}

function normalizeVisibleMessagesFromRows(rows: Array<Record<string, unknown>>, sessions: ConversationSessionRow[]): ConversationMessage[] {
  const sessionById = new Map(sessions.map(session => [session.id, session]))
  return rows
    .map(row => {
      const session = sessionById.get(String(row.session_id || ''))
      return normalizeVisibleMessage({
        id: row.id as number | string,
        session_id: String(row.session_id || ''),
        role: String(row.role || ''),
        content: row.content,
        timestamp: normalizeNumber(row.timestamp),
      }, session?.last_active || session?.started_at || 0)
    })
    .filter((message): message is ConversationMessage => !!message)
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
      return String(a.id).localeCompare(String(b.id))
    })
}

function loadVisibleMessagesForSessions(db: { prepare: (sql: string) => { all: (...params: any[]) => Array<Record<string, unknown>> } }, sessions: ConversationSessionRow[]): ConversationMessage[] {
  if (!sessions.length) return []
  const ids = sessions.map(session => session.id)
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT id, session_id, role, content, timestamp
    FROM messages
    WHERE session_id IN (${placeholders})
      AND role IN ('user', 'assistant')
      AND content IS NOT NULL
      AND content != ''
    ORDER BY timestamp, id
  `).all(...ids)
  return normalizeVisibleMessagesFromRows(rows, sessions)
}

function collectBranchRoots(chain: ConversationSessionRow[], byId: Map<string, ConversationSessionRow>, childrenByParent: Map<string | null, string[]>): ConversationSessionRow[] {
  const chainIds = new Set(chain.map(session => session.id))
  const roots: ConversationSessionRow[] = []
  for (const parent of chain) {
    const continuation = nextContinuationChild(parent, byId, childrenByParent, true)
    const childIds = childrenByParent.get(parent.id) || []
    for (const childId of childIds) {
      if (chainIds.has(childId) || childId === continuation?.id) continue
      const child = byId.get(childId)
      if (child) roots.push(child)
    }
  }
  return roots.sort((a, b) => {
    if (a.started_at !== b.started_at) return a.started_at - b.started_at
    return a.id.localeCompare(b.id)
  })
}

function collectConversationBranches(db: { prepare: (sql: string) => { all: (...params: any[]) => Array<Record<string, unknown>> } }, chain: ConversationSessionRow[], byId: Map<string, ConversationSessionRow>, childrenByParent: Map<string | null, string[]>, seen = new Set<string>()): ConversationBranch[] {
  const roots = collectBranchRoots(chain, byId, childrenByParent)
  const branches: ConversationBranch[] = []
  for (const root of roots) {
    if (seen.has(root.id)) continue
    seen.add(root.id)
    const branchChain = collectConversationChain(root.id, byId, childrenByParent, true)
    const messages = loadVisibleMessagesForSessions(db, branchChain)
    branches.push({
      session_id: root.id,
      parent_session_id: root.parent_session_id ?? null,
      source: safeText(root.source),
      model: safeText(root.model),
      title: root.title ?? null,
      started_at: Number(root.started_at || 0),
      ended_at: branchChain[branchChain.length - 1]?.ended_at ?? root.ended_at ?? null,
      last_active: branchChain.reduce((max, session) => Math.max(max, Number(session.last_active || session.started_at || 0)), Number(root.last_active || root.started_at || 0)),
      is_active: branchChain.some(session => session.is_active),
      messages,
      visible_count: messages.length,
      thread_session_count: branchChain.length,
      input_tokens: branchChain.reduce((sum, session) => sum + Number(session.input_tokens || 0), 0),
      output_tokens: branchChain.reduce((sum, session) => sum + Number(session.output_tokens || 0), 0),
      branches: collectConversationBranches(db, branchChain, byId, childrenByParent, seen),
    })
  }
  return branches
}

function countBranches(branches: ConversationBranch[]): number {
  return branches.reduce((sum, branch) => sum + 1 + countBranches(branch.branches), 0)
}

function countConversationBranchSessions(chain: ConversationSessionRow[], byId: Map<string, ConversationSessionRow>, childrenByParent: Map<string | null, string[]>, seen = new Set<string>()): number {
  let count = 0
  for (const root of collectBranchRoots(chain, byId, childrenByParent)) {
    if (seen.has(root.id)) continue
    seen.add(root.id)
    const branchChain = collectConversationChain(root.id, byId, childrenByParent, true)
    count += 1 + countConversationBranchSessions(branchChain, byId, childrenByParent, seen)
  }
  return count
}

async function openConversationDb() {
  if (!SQLITE_AVAILABLE) {
    throw new Error(`node:sqlite requires Node >= 22.5, current: ${process.versions.node}`)
  }

  const { DatabaseSync } = await import('node:sqlite')
  return new DatabaseSync(conversationDbPath(), { open: true, readOnly: true })
}

function buildConversationSessionSql(source?: string, includeTool = false): { sql: string, params: any[] } {
  const sql = `
    SELECT
      s.id,
      s.source,
      COALESCE(s.user_id, '') AS user_id,
      COALESCE(s.model, '') AS model,
      COALESCE(s.title, '') AS title,
      s.parent_session_id AS parent_session_id,
      COALESCE(s.started_at, 0) AS started_at,
      s.ended_at AS ended_at,
      COALESCE(s.end_reason, '') AS end_reason,
      COALESCE(s.message_count, 0) AS message_count,
      COALESCE(s.tool_call_count, 0) AS tool_call_count,
      COALESCE(s.input_tokens, 0) AS input_tokens,
      COALESCE(s.output_tokens, 0) AS output_tokens,
      COALESCE(s.cache_read_tokens, 0) AS cache_read_tokens,
      COALESCE(s.cache_write_tokens, 0) AS cache_write_tokens,
      COALESCE(s.reasoning_tokens, 0) AS reasoning_tokens,
      COALESCE(s.billing_provider, '') AS billing_provider,
      COALESCE(s.estimated_cost_usd, 0) AS estimated_cost_usd,
      s.actual_cost_usd AS actual_cost_usd,
      COALESCE(s.cost_status, '') AS cost_status,
      COALESCE(
        (
          SELECT SUBSTR(REPLACE(REPLACE(m.content, CHAR(10), ' '), CHAR(13), ' '), 1, 80)
          FROM messages m
          WHERE m.session_id = s.id
            AND ${VISIBLE_HUMAN_MESSAGE_SQL}
          ORDER BY m.timestamp, m.id
          LIMIT 1
        ),
        ''
      ) AS preview,
      COALESCE((SELECT MAX(m2.timestamp) FROM messages m2 WHERE m2.session_id = s.id), s.started_at) AS last_active,
      CASE WHEN EXISTS (
        SELECT 1
        FROM messages m
        WHERE m.session_id = s.id
          AND ${VISIBLE_HUMAN_MESSAGE_SQL}
      ) THEN 1 ELSE 0 END AS has_visible_messages
    FROM sessions s
    WHERE ${includeTool ? '1 = 1' : "s.source != 'tool'"}
      ${source ? 'AND s.source = ?' : ''}
    ORDER BY s.started_at DESC
  `

  return { sql, params: source ? [source] : [] }
}

async function loadConversationSessions(source?: string, includeTool = false): Promise<ConversationSessionRow[]> {
  const liveTuiSessionKeys = await listLiveTuiSessionKeys()
  const db = await openConversationDb()
  try {
    const { sql, params } = buildConversationSessionSql(source, includeTool)
    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
    const nowSeconds = Date.now() / 1000
    const sessions = rows.map(row => mapSessionRow(row, nowSeconds, liveTuiSessionKeys))
    linkOrphanCompressionContinuations(sessions)
    if (source && source !== 'tui') return sessions

    const knownIds = new Set(sessions.map(session => session.id))
    for (const sessionKey of liveTuiSessionKeys) {
      if (!knownIds.has(sessionKey)) {
        sessions.push(createLiveTuiPlaceholderSession(sessionKey, nowSeconds))
      }
    }
    return sessions
  } finally {
    db.close()
  }
}

export async function listConversationSummariesFromDb(options: ConversationListOptions = {}): Promise<ConversationSummary[]> {
  const humanOnly = options.humanOnly !== false
  const limit = options.limit && options.limit > 0 ? options.limit : DEFAULT_CONVERSATION_LIMIT
  const sessions = await loadConversationSessions(options.source)
  const byId = new Map(sessions.map(session => [session.id, session]))
  const childrenByParent = new Map<string | null, string[]>()
  for (const session of sessions) {
    const key = session.parent_session_id ?? null
    const siblings = childrenByParent.get(key) || []
    siblings.push(session.id)
    childrenByParent.set(key, siblings)
  }

  if (!humanOnly) {
    return sortByRecency(sessions.map(toSummary)).slice(0, limit)
  }

  const summaries = sessions
    .filter(session => isVisibleConversationStart(session, byId, childrenByParent))
    .map(session => aggregateSummary(session.id, byId, childrenByParent))
    .filter((summary): summary is ConversationSummary => !!summary)

  return sortByRecency(summaries).slice(0, limit)
}

export async function getConversationDetailFromDb(sessionId: string, options: ConversationListOptions = {}): Promise<ConversationDetail | null> {
  const humanOnly = options.humanOnly !== false
  const sessions = await loadConversationSessions(options.source, true)
  const byId = new Map(sessions.map(session => [session.id, session]))
  const childrenByParent = new Map<string | null, string[]>()
  for (const session of sessions) {
    const key = session.parent_session_id ?? null
    const siblings = childrenByParent.get(key) || []
    siblings.push(session.id)
    childrenByParent.set(key, siblings)
  }

  let chain: ConversationSessionRow[] = []
  if (!humanOnly) {
    const session = byId.get(sessionId)
    if (!session || session.source === 'tool') return null
    chain = [session]
  } else {
    const session = byId.get(sessionId)
    if (!session || session.source === 'tool') return null
    const rootId = compressionChainRootId(sessionId, byId, childrenByParent)
    if (!rootId) return null
    if (!isVisibleConversationStart(byId.get(rootId), byId, childrenByParent)) return null
    chain = collectConversationChain(rootId, byId, childrenByParent)
  }

  if (!chain.length) return null

  const db = await openConversationDb()
  try {
    const messages = loadVisibleMessagesForSessions(db, chain)
    const branches = humanOnly ? collectConversationBranches(db, chain, byId, childrenByParent) : []

    if (!messages.length) {
      if (humanOnly && !branches.length && !chain.some(session => session.is_live_tui_process)) return null
      const detail: ConversationDetail = {
        session_id: sessionId,
        messages: [],
        visible_count: 0,
        thread_session_count: chain.length,
      }
      if (humanOnly) {
        detail.branch_session_count = countBranches(branches)
        detail.branches = branches
      }
      return detail
    }
    const detail: ConversationDetail = {
      session_id: sessionId,
      messages,
      visible_count: messages.length,
      thread_session_count: chain.length,
    }
    if (humanOnly) {
      detail.branch_session_count = countBranches(branches)
      detail.branches = branches
    }
    return detail
  } finally {
    db.close()
  }
}
