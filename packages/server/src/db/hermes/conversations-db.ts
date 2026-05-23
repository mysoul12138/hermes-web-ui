import { getActiveProfileDir } from '../../services/hermes/hermes-profile'
import { readBridgeContinuationLinks } from '../../services/hermes/bridge-continuation-links'
import {
  listActiveExplicitConversationSessionEdges,
  listConversationUiEventsReadOnly,
  listConversationThreadsReadOnly,
  type ConversationSessionEdgeRow,
  type ConversationThreadRow,
  type ConversationUiEventRow,
} from './conversation-lineage'
import { listSessionLineage, type SessionLineageRow } from './session-lineage'
import type {
  ConversationBranch,
  ConversationContinuationEdge,
  ConversationDetail,
  ConversationListOptions,
  ConversationMessage,
  ConversationSummary,
} from '../../services/hermes/conversations'
import { logger } from '../../services/logger'
import { listLiveTuiSessionKeys } from '../../services/hermes/tui-live'
import { getDb } from '../index'

const SQLITE_AVAILABLE = (() => {
  const [major, minor] = process.versions.node.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 5)
})()

const LINEAGE_TOLERANCE_SECONDS = 3
const DUPLICATE_CONTINUATION_WINDOW_SECONDS = 600
const LIVE_WINDOW_SECONDS = 300
const DEFAULT_CONVERSATION_LIMIT = 200
const BRIDGE_CONTEXT_PROMPT_PREFIX = 'previous conversation context:'
const BRIDGE_CURRENT_USER_MARKER = 'current user message:'
const SYNTHETIC_USER_PREFIXES = [
  '[system:',
  '[context compaction',
  '[your active task list was preserved across context compression]',
  'summary generation was unavailable.',
  "you've reached the maximum number of tool-calling iterations allowed.",
  'you have reached the maximum number of tool-calling iterations allowed.',
]

function shouldTraceContinuationSession(sessionId: string): boolean {
  return process.env.HERMES_TRACE_CONTINUATION_SESSION === sessionId
}

function shouldTraceConversationAggregation(): boolean {
  return process.env.HERMES_TRACE_CONVERSATION_AGGREGATION === '1'
}

function traceAggregationTiming(stage: string, startedAt: number, detail: Record<string, unknown> = {}) {
  if (!shouldTraceConversationAggregation()) return
  logger.info({
    stage,
    elapsedMs: Date.now() - startedAt,
    ...detail,
  }, '[conversations-db] aggregation timing')
}

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
  billing_base_url: string | null
  estimated_cost_usd: number
  actual_cost_usd: number | null
  cost_status: string
  raw_preview: string
  raw_context_anchor: string
  raw_visible_history: string
  preview: string
  last_active: number
  has_visible_messages: boolean
  is_active: boolean
  is_live_tui_process?: boolean
}

type ParentEvidenceKind = ConversationContinuationEdge['kind']

interface ParentEvidence {
  parentId: string
  kind: ParentEvidenceKind
}

interface ExplicitConversationGraph {
  conversationId: string
  rootSessionId: string
  mainline: ConversationSessionRow[]
  branchEdges: ConversationSessionEdgeRow[]
  continuationEdges: ConversationContinuationEdge[]
}

interface CanonicalGraphFacts {
  parentEvidence: Map<string, ParentEvidence>
  childrenByParent: Map<string | null, string[]>
  sessionLineage: SessionLineageRow[]
}

interface ExplicitLineageFacts {
  threads: ConversationThreadRow[]
  edges: ConversationSessionEdgeRow[]
  sessionLineage: SessionLineageRow[]
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

function parseToolCalls(value: unknown): any[] | null {
  if (value == null || value === '') return null
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
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

function assistantTextTail(value: unknown, width = 64): string {
  const text = textFromContent(value).replace(/\s+/g, ' ').trim().toLowerCase()
  if (!text) return ''
  return text.length > width ? text.slice(-width) : text
}

function bridgeAssistantHistoryTail(value: unknown, width = 64): string {
  const tail = assistantTextTail(value, width)
  return tail ? `assistant: ${tail}` : ''
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
  const rawPreview = safeText(row.raw_preview || row.preview || '')
  const rawContextAnchor = safeText(row.raw_context_anchor || '')
  const rawVisibleHistory = safeText(row.raw_visible_history || '')
  const preview = excerpt(bridgeContextDisplayText(rawPreview) || rawPreview)
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
    billing_base_url: normalizeNullableString(row.billing_base_url),
    estimated_cost_usd: normalizeNumber(row.estimated_cost_usd),
    actual_cost_usd: normalizeNullableNumber(row.actual_cost_usd),
    cost_status: String(row.cost_status || ''),
    raw_preview: rawPreview,
    raw_context_anchor: rawContextAnchor,
    raw_visible_history: rawVisibleHistory,
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
    billing_base_url: null,
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    cost_status: '',
    raw_preview: 'Running TUI session',
    raw_context_anchor: 'Running TUI session',
    raw_visible_history: 'Running TUI session',
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

function hasConversationContent(session: ConversationSessionRow | undefined): boolean {
  return !!session && (session.has_visible_messages || Number(session.tool_call_count || 0) > 0 || !!session.title)
}

function isEmptyCompressionPivot(session: ConversationSessionRow | undefined): boolean {
  return !!session
    && session.source === 'tui'
    && session.parent_session_id == null
    && isCompressionEndReason(session.end_reason)
    && !hasConversationContent(session)
}

function isEmptyCompressionSession(session: ConversationSessionRow | undefined): boolean {
  return !!session
    && session.source === 'tui'
    && isCompressionEndReason(session.end_reason)
    && !hasConversationContent(session)
}

function isOutputEmptyCompressionSession(session: ConversationSessionRow | undefined): boolean {
  return !!session
    && session.source === 'tui'
    && isCompressionEndReason(session.end_reason)
    && !session.has_visible_messages
    && Number(session.tool_call_count || 0) <= 0
}

function isBridgeContextPrompt(value: unknown): boolean {
  return normalizeText(value).startsWith(BRIDGE_CONTEXT_PROMPT_PREFIX)
}

function bridgeContextDisplayText(value: unknown): string | null {
  const text = textFromContent(value).trim()
  if (!isBridgeContextPrompt(text)) return null
  const normalized = text.toLowerCase()
  const markerIndex = normalized.lastIndexOf(BRIDGE_CURRENT_USER_MARKER)
  if (markerIndex < 0) return null
  const currentUserText = text.slice(markerIndex + BRIDGE_CURRENT_USER_MARKER.length).trim()
  return currentUserText || null
}

function bridgeContextHistoryText(value: unknown): string {
  const text = textFromContent(value).trim()
  if (!isBridgeContextPrompt(text)) return ''
  const normalized = text.toLowerCase()
  const markerIndex = normalized.lastIndexOf(BRIDGE_CURRENT_USER_MARKER)
  const history = markerIndex >= 0 ? text.slice(0, markerIndex) : text
  return normalizeText(history)
}

function bridgeContextAssistantHistorySnippets(value: unknown): string[] {
  const history = bridgeContextHistoryText(value).replace(/^previous conversation context:\s*/, '')
  if (!history) return []

  const snippets: string[] = []
  const rolePattern = /(?:^|\s)(assistant|user|system|tool):\s*/g
  let currentRole: string | null = null
  let contentStart = 0
  let match: RegExpExecArray | null

  while ((match = rolePattern.exec(history))) {
    if (currentRole === 'assistant') snippets.push(history.slice(contentStart, match.index).trim())
    currentRole = match[1]
    contentStart = rolePattern.lastIndex
  }

  if (currentRole === 'assistant') snippets.push(history.slice(contentStart).trim())
  if (!snippets.length && history) snippets.push(history)

  return [...new Set(snippets.map(snippet => normalizeText(snippet)).filter(snippet => snippet.length >= 12))]
}

function bridgeContextRoleHistorySnippets(value: unknown): string[] {
  const history = bridgeContextHistoryText(value).replace(/^previous conversation context:\s*/, '')
  if (!history) return []

  const snippets: string[] = []
  const rolePattern = /(?:^|\s)(assistant|user):\s*/g
  let currentRole: string | null = null
  let contentStart = 0
  let match: RegExpExecArray | null

  while ((match = rolePattern.exec(history))) {
    if (currentRole === 'assistant' || currentRole === 'user') snippets.push(history.slice(contentStart, match.index).trim())
    currentRole = match[1]
    contentStart = rolePattern.lastIndex
  }

  if (currentRole === 'assistant' || currentRole === 'user') snippets.push(history.slice(contentStart).trim())
  return [...new Set(snippets.map(snippet => normalizeText(snippet)).filter(snippet => snippet.length >= 12))]
}

function conversationHistoryAnchors(session: ConversationSessionRow): string[] {
  return [
    session.raw_visible_history,
    session.raw_context_anchor,
    session.raw_preview,
    session.preview,
    session.title,
    assistantTextTail(session.raw_visible_history),
    assistantTextTail(session.raw_context_anchor),
    assistantTextTail(session.raw_preview),
    assistantTextTail(session.preview),
    bridgeAssistantHistoryTail(session.raw_visible_history),
    bridgeAssistantHistoryTail(session.raw_context_anchor),
    bridgeAssistantHistoryTail(session.raw_preview),
    bridgeAssistantHistoryTail(session.preview),
  ]
    .map(anchor => normalizeText(anchor))
    .filter(anchor => anchor.length >= 12)
}

function bridgeContextHistoryMatchesSession(session: ConversationSessionRow, bridgeContextPrompt: unknown): boolean {
  const history = bridgeContextHistoryText(bridgeContextPrompt)
  if (!history) return false

  const anchors = conversationHistoryAnchors(session)
  if (anchors.some(anchor => history.includes(anchor) || anchor.includes(history))) return true

  const snippets = bridgeContextRoleHistorySnippets(bridgeContextPrompt)
  if (!snippets.length) return false
  return snippets.some(snippet => anchors.some(anchor => anchor.includes(snippet) || snippet.includes(anchor)))
}

function contextReferencesParent(parent: ConversationSessionRow, child: ConversationSessionRow): boolean {
  const prompt = child.raw_preview || child.preview || child.title
  const history = bridgeContextHistoryText(prompt)
  if (!history) {
    if (shouldTraceContinuationSession(child.id) || shouldTraceContinuationSession(parent.id)) {
      logger.info({
        parentId: parent.id,
        childId: child.id,
        childPreview: child.preview,
        childRawPreview: child.raw_preview,
      }, '[conversations-db] bridge-context parent-reference miss: no history text')
    }
    return false
  }
  const anchors = conversationHistoryAnchors(parent)
  const matched = bridgeContextHistoryMatchesSession(parent, prompt)
  if (!matched && (shouldTraceContinuationSession(child.id) || shouldTraceContinuationSession(parent.id))) {
    logger.info({
      parentId: parent.id,
      childId: child.id,
      history,
      anchors: anchors.slice(0, 10),
    }, '[conversations-db] bridge-context parent-reference miss: history does not reference parent')
  }
  return matched
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

function isLikelyBridgeContextBranchContinuation(parent: ConversationSessionRow, child: ConversationSessionRow): boolean {
  if (child.id === parent.id || child.source !== parent.source || child.source !== 'tui') return false
  if (!parent.parent_session_id) return false
  if (!isBridgeContextPrompt(child.raw_preview || child.preview || child.title)) return false
  if (!contextReferencesParent(parent, child)) return false

  const childStarted = Number(child.started_at || 0)
  const parentStarted = Number(parent.started_at || 0)
  if (childStarted < parentStarted) return false

  const startedDelta = childStarted - parentStarted
  const activeGap = childStarted - Number(parent.last_active || parent.started_at || 0)
  return startedDelta <= DUPLICATE_CONTINUATION_WINDOW_SECONDS || activeGap <= LINEAGE_TOLERANCE_SECONDS
}

function isLikelyBridgeContextRootContinuation(parent: ConversationSessionRow, child: ConversationSessionRow): boolean {
  if (child.id === parent.id || child.source !== parent.source || child.source !== 'tui') return false
  if (child.parent_session_id != null && child.parent_session_id !== parent.id) return false
  if (!isBridgeContextPrompt(child.raw_preview || child.preview || child.title)) return false
  return false
}

function linkOrphanCompressionContinuations(sessions: ConversationSessionRow[]) {
  const parentless = sessions.filter(session => session.parent_session_id == null && session.source !== 'tool')
  const assignments = new Map<string, string | null>()

  for (const parent of sessions) {
    if (!isCompressionEndReason(parent.end_reason) || parent.ended_at == null) continue
    const hasExplicitContinuation = sessions.some(session =>
      session.parent_session_id === parent.id
      && session.source === parent.source
      && isLikelyOrphanContinuation(parent, session),
    )
    const candidates = parentless.filter(child => {
      if (hasExplicitContinuation && isBridgeContextPrompt(child.raw_preview || child.preview || child.title)) return false
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

function sessionHasExplicitLineageRoot(
  sessionId: string,
  lineageRows: SessionLineageRow[],
): boolean {
  return lineageRows.some(row => (
    row.session_id === sessionId
    && row.authority === 'explicit'
    && (
      row.relation_kind === 'root'
      || row.root_session_id === sessionId
      || row.logical_conversation_id === sessionId
    )
  ))
}

function linkParentlessEmptyCompressionPivots(sessions: ConversationSessionRow[], lineageRows: SessionLineageRow[] = []) {
  const byId = new Map(sessions.map(session => [session.id, session]))
  const children = new Map<string, ConversationSessionRow[]>()
  const childIdsByParent = new Map<string | null, string[]>()
  for (const session of sessions) {
    const key = session.parent_session_id ?? null
    const childIds = childIdsByParent.get(key) || []
    childIds.push(session.id)
    childIdsByParent.set(key, childIds)

    if (!session.parent_session_id) continue
    const siblings = children.get(session.parent_session_id) || []
    siblings.push(session)
    children.set(session.parent_session_id, siblings)
  }

  for (const pivot of sessions) {
    if (!isEmptyCompressionPivot(pivot)) continue
    if (sessionHasExplicitLineageRoot(pivot.id, lineageRows)) continue
    const descendants = children.get(pivot.id) || []
    if (descendants.length !== 1) continue
    const firstChild = descendants[0]
    if (firstChild.source !== pivot.source) continue

    const visibleDescendant = collectConversationChain(firstChild.id, byId, childIdsByParent)
      .find(session => hasConversationContent(session) && isBridgeContextPrompt(session.raw_preview || session.preview || session.title))
    if (!visibleDescendant) continue

    const pivotStarted = Number(pivot.started_at || 0)
    const candidate = sessions
      .filter(session => session.id !== pivot.id && !descendants.some(descendant => descendant.id === session.id))
      .filter(session => session.source === pivot.source)
      .filter(session => hasConversationContent(session))
      .filter(session => Number(session.started_at || 0) <= pivotStarted)
      .filter(session => !isBridgeContextPrompt(session.raw_preview || session.preview || session.title))
      .filter(session => bridgeContextHistoryMatchesSession(session, visibleDescendant.raw_preview || visibleDescendant.preview || visibleDescendant.title))
      .sort((left, right) => {
        const leftAnchor = Number(left.last_active || left.started_at || 0)
        const rightAnchor = Number(right.last_active || right.started_at || 0)
        if (rightAnchor !== leftAnchor) return rightAnchor - leftAnchor
        if (right.started_at !== left.started_at) return right.started_at - left.started_at
        return right.id.localeCompare(left.id)
      })[0]

    if (candidate) {
      pivot.parent_session_id = candidate.id
      if (shouldTraceConversationAggregation() || shouldTraceContinuationSession(pivot.id) || shouldTraceContinuationSession(candidate.id)) {
        logger.info({
          pivotId: pivot.id,
          parentId: candidate.id,
          evidenceChildId: visibleDescendant.id,
        }, '[conversations-db] linked parentless empty compression pivot')
      }
    }
  }
}

function linkOrphanBridgeContextRootContinuations(sessions: ConversationSessionRow[]) {
  // Disabled: root-level bridge-context sessions are too ambiguous to safely
  // auto-link. They often carry copied context text but are not reliable
  // evidence of a parent-child relationship.
}

function linkOrphanBridgeContextBranchContinuations(sessions: ConversationSessionRow[]) {
  // Disabled: root-level bridge-context sessions are too ambiguous to safely
  // re-parent under an existing continuation chain. This was creating false
  // branch children such as 181042/181317 under 180009.
}

function continuationCandidates(parent: ConversationSessionRow, byId: Map<string, ConversationSessionRow>, childrenByParent: Map<string | null, string[]>, allowTool = false): ConversationSessionRow[] {
  const childIds = childrenByParent.get(parent.id) || []
  return childIds
    .map(childId => byId.get(childId))
    .filter((child): child is ConversationSessionRow => !!child)
    .filter(child => allowTool || child.source !== 'tool')
    .filter(child => child.source === parent.source)
    .filter(child => isCompressionEndReason(parent.end_reason)
      ? isLikelyOrphanContinuation(parent, child)
      : !isCompressionLineageChild(parent, byId)
        && (
          isLikelyBridgeContextBranchContinuation(parent, child)
          || isLikelyBridgeContextRootContinuation(parent, child)
          || isLikelyEmptyCompressionPivotContinuation(parent, child, byId, childrenByParent)
        ))
    .sort((a, b) => {
      const anchor = isCompressionEndReason(parent.end_reason)
        ? Number(parent.ended_at || 0)
        : Number(parent.started_at || 0)
      const aDelta = Math.abs(Number(a.started_at || 0) - anchor)
      const bDelta = Math.abs(Number(b.started_at || 0) - anchor)
      if (aDelta !== bDelta) return aDelta - bDelta
      return a.id.localeCompare(b.id)
    })
}

function isLikelyEmptyCompressionPivotContinuation(
  parent: ConversationSessionRow,
  child: ConversationSessionRow,
  byId: Map<string, ConversationSessionRow>,
  childrenByParent: Map<string | null, string[]>,
): boolean {
  if (!isEmptyCompressionSession(child)) return false
  return isTrustedEmptyCompressionPivotLink(parent, child, byId, childrenByParent)
}

function emptyCompressionPivotBridgeEvidence(
  parent: ConversationSessionRow,
  pivot: ConversationSessionRow,
  byId: Map<string, ConversationSessionRow>,
  childrenByParent: Map<string | null, string[]>,
): ConversationSessionRow | null {
  return emptyCompressionPivotBridgeEvidencePath(parent, pivot, byId, childrenByParent)?.at(-1) || null
}

function emptyCompressionPivotBridgeEvidencePath(
  parent: ConversationSessionRow,
  pivot: ConversationSessionRow,
  byId: Map<string, ConversationSessionRow>,
  childrenByParent: Map<string | null, string[]>,
): ConversationSessionRow[] | null {
  if (pivot.id === parent.id || pivot.source !== parent.source || pivot.source !== 'tui') return null
  if (pivot.parent_session_id !== parent.id) return null
  if (!isEmptyCompressionSession(pivot)) return null
  if (!hasConversationContent(parent)) return null
  if (Number(pivot.started_at || 0) < Number(parent.started_at || 0)) return null

  const path: ConversationSessionRow[] = []
  const seen = new Set<string>()
  let current: ConversationSessionRow | null = pivot

  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    path.push(current)
    const source = current.source
    const childIds: string[] = childrenByParent.get(current.id) || []
    const children: ConversationSessionRow[] = childIds
      .map((childId: string) => byId.get(childId))
      .filter((child): child is ConversationSessionRow => !!child)
      .filter((child: ConversationSessionRow) => child.source === source && child.source !== 'tool')

    if (children.length !== 1) return null

    const next: ConversationSessionRow = children[0]
    if (Number(next.started_at || 0) < Number(current.started_at || 0)) return null

    if (isEmptyCompressionSession(next)) {
      current = next
      continue
    }

    if (!hasConversationContent(next)) return null
    if (!isBridgeContextPrompt(next.raw_preview || next.preview || next.title)) return null
    return contextReferencesParent(parent, next) ? [...path, next] : null
  }

  return null
}

function emptyCompressionPivotNativeContinuationPath(
  parent: ConversationSessionRow,
  pivot: ConversationSessionRow,
  byId: Map<string, ConversationSessionRow>,
  childrenByParent: Map<string | null, string[]>,
): ConversationSessionRow[] | null {
  if (pivot.id === parent.id || pivot.source !== parent.source || pivot.source !== 'tui') return null
  if (pivot.parent_session_id !== parent.id) return null
  if (!isEmptyCompressionSession(pivot)) return null
  if (!hasConversationContent(parent)) return null
  if (!isLikelyOrphanContinuation(parent, pivot)) return null

  const path: ConversationSessionRow[] = []
  const seen = new Set<string>()
  let current: ConversationSessionRow | null = pivot

  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    path.push(current)
    const childIds: string[] = childrenByParent.get(current.id) || []
    const children: ConversationSessionRow[] = childIds
      .map((childId: string) => byId.get(childId))
      .filter((child): child is ConversationSessionRow => !!child)
      .filter((child: ConversationSessionRow) => child.source === current?.source && child.source !== 'tool')

    if (children.length !== 1) return null
    const next: ConversationSessionRow = children[0]
    if (Number(next.started_at || 0) < Number(current.started_at || 0)) return null

    if (isEmptyCompressionSession(next)) {
      if (!isLikelyOrphanContinuation(current, next)) return null
      current = next
      continue
    }

    if (!hasConversationContent(next)) return null
    if (!isLikelyOrphanContinuation(current, next)) return null
    return [...path, next]
  }

  return null
}

function isTrustedEmptyCompressionPivotLink(
  parent: ConversationSessionRow,
  child: ConversationSessionRow,
  byId: Map<string, ConversationSessionRow>,
  childrenByParent: Map<string | null, string[]>,
): boolean {
  if (child.id === parent.id || child.source !== parent.source || child.source !== 'tui') return false
  if (child.parent_session_id !== parent.id) return false
  if (Number(child.started_at || 0) < Number(parent.started_at || 0)) return false
  if (!isEmptyCompressionSession(parent) && !isEmptyCompressionSession(child)) return false

  const emptyAncestors: ConversationSessionRow[] = []
  let anchor: ConversationSessionRow | undefined = parent
  const seen = new Set<string>()
  while (anchor && isEmptyCompressionSession(anchor) && !seen.has(anchor.id)) {
    seen.add(anchor.id)
    emptyAncestors.unshift(anchor)
    anchor = anchor.parent_session_id ? byId.get(anchor.parent_session_id) : undefined
  }
  if (!anchor || isEmptyCompressionSession(anchor) || anchor.source !== child.source) return false

  const firstPivot = emptyAncestors[0] || child
  const path = emptyCompressionPivotBridgeEvidencePath(anchor, firstPivot, byId, childrenByParent)
    || emptyCompressionPivotNativeContinuationPath(anchor, firstPivot, byId, childrenByParent)
  if (!path?.some(session => session.id === child.id)) return false
  if (parent.id === anchor.id) return path[0]?.id === child.id
  return path.some((session, index) => index > 0 && path[index - 1]?.id === parent.id && session.id === child.id)
}

function isExplicitRootEmptyCompressionPivotLink(
  parent: ConversationSessionRow,
  child: ConversationSessionRow,
  byId: Map<string, ConversationSessionRow>,
  childrenByParent: Map<string | null, string[]>,
  lineageRows: SessionLineageRow[],
): boolean {
  if (!isOutputEmptyCompressionSession(parent)) return false
  if (!sessionHasExplicitLineageRoot(parent.id, lineageRows)) return false
  if (child.id === parent.id || child.source !== parent.source || child.source !== 'tui') return false
  if (child.parent_session_id !== parent.id) return false
  if (isAgentLikeBranchSession(child, byId)) return false
  if (Number(child.started_at || 0) < Number(parent.started_at || 0)) return false
  const children = (childrenByParent.get(parent.id) || [])
    .map(childId => byId.get(childId))
    .filter((item): item is ConversationSessionRow => !!item && item.source === parent.source && item.source !== 'tool')
  if (children.length !== 1) return false
  return hasConversationContent(child)
}

function isExplicitBoundaryEmptyCompressionPivotLink(
  parent: ConversationSessionRow,
  child: ConversationSessionRow,
  byId: Map<string, ConversationSessionRow>,
  childrenByParent: Map<string | null, string[]>,
): boolean {
  if (!isOutputEmptyCompressionSession(parent)) return false
  if (child.id === parent.id || child.source !== parent.source || child.source !== 'tui') return false
  if (child.parent_session_id !== parent.id) return false
  if (isAgentLikeBranchSession(child, byId)) return false
  if (Number(child.started_at || 0) < Number(parent.started_at || 0)) return false
  const children = (childrenByParent.get(parent.id) || [])
    .map(childId => byId.get(childId))
    .filter((item): item is ConversationSessionRow => !!item && item.source === parent.source && item.source !== 'tool')
  return children.length === 1 && hasConversationContent(child)
}

function hasBridgeContextPromptDescendantReferencing(
  session: ConversationSessionRow,
  byId: Map<string, ConversationSessionRow>,
  childrenByParent: Map<string | null, string[]>,
  seen = new Set<string>(),
): boolean {
  if (seen.has(session.id)) return false
  seen.add(session.id)
  const childIds = childrenByParent.get(session.id) || []
  for (const childId of childIds) {
    const child = byId.get(childId)
    if (!child || child.source !== session.source || child.source === 'tool') continue
    if (
      hasConversationContent(child)
      && isBridgeContextPrompt(child.raw_preview || child.preview || child.title)
      && contextReferencesParent(session, child)
    ) return true
    if (isEmptyCompressionSession(child) && hasBridgeContextPromptDescendantReferencing(session, byId, childrenByParent, seen)) return true
  }
  return false
}

function hasBridgeContextPromptDescendantReferencingAny(
  session: ConversationSessionRow,
  anchors: ConversationSessionRow[],
  byId: Map<string, ConversationSessionRow>,
  childrenByParent: Map<string | null, string[]>,
  seen = new Set<string>(),
): boolean {
  if (seen.has(session.id)) return false
  seen.add(session.id)
  const childIds = childrenByParent.get(session.id) || []
  for (const childId of childIds) {
    const child = byId.get(childId)
    if (!child || child.source !== session.source || child.source === 'tool') continue
    if (
      hasConversationContent(child)
      && isBridgeContextPrompt(child.raw_preview || child.preview || child.title)
      && anchors.some(anchor => contextReferencesParent(anchor, child))
    ) return true
    if (hasBridgeContextPromptDescendantReferencingAny(child, anchors, byId, childrenByParent, seen)) return true
  }
  return false
}

function nativeAncestorAnchors(parent: ConversationSessionRow, byId: Map<string, ConversationSessionRow>): ConversationSessionRow[] {
  const anchors: ConversationSessionRow[] = []
  const seen = new Set<string>()
  let current: ConversationSessionRow | undefined = parent
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    anchors.push(current)
    if (!current.parent_session_id) break
    const next = byId.get(current.parent_session_id)
    if (!next || next.source !== current.source || next.source === 'tool') break
    current = next
  }
  return anchors
}

function isTrustedLongGapNativeContinuation(
  parent: ConversationSessionRow,
  child: ConversationSessionRow,
  byId: Map<string, ConversationSessionRow>,
  childrenByParent: Map<string | null, string[]>,
): boolean {
  if (child.id === parent.id) return false
  if (child.parent_session_id !== parent.id) return false
  if (child.source !== parent.source) return false
  if (child.source !== 'tui' && child.source !== 'webui-bridge') return false
  if (nativeAncestorAnchors(parent, byId).some(anchor => isOutputEmptyCompressionSession(anchor))) return false
  if (!hasConversationContent(parent)) return false
  if (!child.has_visible_messages && Number(child.tool_call_count || 0) <= 0) return false
  if (!isCompressionEndReason(parent.end_reason) && parent.end_reason !== 'tui_shutdown') return false
  if (Number(child.started_at || 0) < Number(parent.started_at || 0)) return false
  if (isBranchRoot(child, byId)) return false
  if (isBridgeContextPrompt(child.raw_preview || child.preview || child.title)) return false

  const anchors = nativeAncestorAnchors(parent, byId)
  const hasDescendantAnchorEvidence = hasBridgeContextPromptDescendantReferencingAny(child, anchors, byId, childrenByParent)
  if (hasDescendantAnchorEvidence) return true

  const ambiguousLongGapSiblings = (childrenByParent.get(parent.id) || [])
    .map(childId => byId.get(childId))
    .filter((sibling): sibling is ConversationSessionRow => !!sibling)
    .filter(sibling => sibling.id !== child.id)
    .filter(sibling => sibling.source === child.source && sibling.source !== 'tool')
    .filter(sibling => sibling.has_visible_messages || Number(sibling.tool_call_count || 0) > 0)
    .filter(sibling => Number(sibling.started_at || 0) >= Number(parent.started_at || 0))
    .filter(sibling => !isBridgeContextPrompt(sibling.raw_preview || sibling.preview || sibling.title))
    .filter(sibling => !isLikelyOrphanContinuation(parent, sibling))
    .filter(sibling => !isExplicitHandoffContinuationChild(sibling, byId))
    .filter(sibling => !isBridgeContextBranchContinuationChild(sibling, byId))
    .filter(sibling => !hasBridgeContextPromptDescendantReferencingAny(sibling, anchors, byId, childrenByParent))

  return ambiguousLongGapSiblings.length === 0
}

function nextContinuationChild(parent: ConversationSessionRow, byId: Map<string, ConversationSessionRow>, childrenByParent: Map<string | null, string[]>, allowTool = false): ConversationSessionRow | null {
  const candidates = continuationCandidates(parent, byId, childrenByParent, allowTool)
  if (candidates.length === 1) return candidates[0]

  const exactPreviewMatches = candidates.filter(child => {
    const childPreview = normalizeText(child.preview)
    const parentPreview = normalizeText(parent.preview)
    return !!childPreview && childPreview === parentPreview
  })

  if (exactPreviewMatches.length === 1) return exactPreviewMatches[0]
  const exactTimingMatches = candidates.filter(child => timingMatchesParent(parent, child))
  if (exactTimingMatches.length === 1) return exactTimingMatches[0]
  return null
}

function isCompressionContinuationChild(session: ConversationSessionRow | undefined, byId: Map<string, ConversationSessionRow>, childrenByParent: Map<string | null, string[]>): boolean {
  if (!session?.parent_session_id) return false
  const parent = byId.get(session.parent_session_id)
  if (!parent) return false
  return nextContinuationChild(parent, byId, childrenByParent)?.id === session.id
}

function isExplicitHandoffContinuationChild(session: ConversationSessionRow | undefined, byId: Map<string, ConversationSessionRow>): boolean {
  if (!session?.parent_session_id) return false
  const parent = byId.get(session.parent_session_id)
  if (!parent) return false
  if (session.source !== parent.source) return false
  if (session.source !== 'tui' && session.source !== 'webui-bridge' && session.source !== 'cli') return false
  if (session.id === parent.id) return false

  const childStarted = Number(session.started_at || 0)
  const parentStarted = Number(parent.started_at || 0)
  if (childStarted < parentStarted) return false
  if (!parent.has_visible_messages && Number(parent.tool_call_count || 0) <= 0) return false

  const parentPreview = normalizeText(parent.preview)
  const childPreview = normalizeText(session.preview)
  const parentTitle = normalizeText(parent.title)
  const childTitle = normalizeText(session.title)

  const sameVisiblePrompt = !!parentPreview && !!childPreview && parentPreview === childPreview
  const sameVisibleTitle = !!parentTitle && !!childTitle && parentTitle === childTitle
  const numberedContinuationTitle =
    !!parent.title
    && !!session.title
    && normalizeText(session.title).startsWith(normalizeText(parent.title))
  const bridgePromptStyle = isBridgeContextPrompt(session.raw_preview || session.preview || session.title)
  const handoffReason = isCompressionEndReason(parent.end_reason) || parent.end_reason === 'tui_shutdown'

  if (bridgePromptStyle) return true
  if (handoffReason && (sameVisiblePrompt || sameVisibleTitle || numberedContinuationTitle)) return true
  if (numberedContinuationTitle && sameVisiblePrompt) return true
  return false
}

function isLikelyExplicitContinuation(parent: ConversationSessionRow, child: ConversationSessionRow): boolean {
  // Fallback for sessions whose parent_session_id was explicitly set by the
  // gateway (e.g. webui-bridge continuations) but whose source / preview does
  // not match the strict bridge-context prompt format.
  //
  // Only applies to TUI / webui-bridge sessions — CLI and other sources use
  // regular continuation chains and must NOT be folded into bridge context.
  if (child.id === parent.id) return false
  if (child.source !== 'tui' && child.source !== 'webui-bridge') return false
  if (parent.source === 'tool') return false
  if (child.parent_session_id !== parent.id) return false
  if (!parent.has_visible_messages && Number(parent.tool_call_count || 0) <= 0) return false
  // Parent must have ended — if still active, the child is a branch, not a
  // continuation.  Continuations are created when the user resumes a finished
  // conversation.
  if (parent.ended_at == null) return false
  // Compression continuations are handled by the compression-chain logic, not
  // bridge context.  Do not hijack them.
  if (isCompressionEndReason(parent.end_reason)) return false

  const childStarted = Number(child.started_at || 0)
  const parentStarted = Number(parent.started_at || 0)
  if (childStarted < parentStarted) return false

  // The child must have started AFTER the parent ended.  If the child started
  // while the parent was still running, it is a subagent spawn (or similar
  // in-flight branch), not a continuation.  Without this check, every child of
  // a finished TUI session would be classified as a "continuation", causing the
  // parent to disappear from the conversation list.
  const parentEnded = Number(parent.ended_at || 0)
  if (parentEnded > 0 && childStarted < parentEnded) return false

  return true
}

function isBridgeContextBranchContinuationChild(
  session: ConversationSessionRow | undefined,
  byId: Map<string, ConversationSessionRow>,
  inferredChildren?: Map<string, string[]>,
): boolean {
  if (!session?.parent_session_id) return false
  const parent = byId.get(session.parent_session_id)
  if (
    parent
    && session.source === 'tui'
    && (inferredChildren?.get(session.id) || []).length > 0
    && parent.ended_at != null
    && (isCompressionEndReason(parent.end_reason) || parent.end_reason === 'tui_shutdown')
  ) return true
  return !!parent
    && (isLikelyBridgeContextBranchContinuation(parent, session) || isLikelyBridgeContextRootContinuation(parent, session) || isLikelyExplicitContinuation(parent, session))
}

function findInferredBridgeContextParent(session: ConversationSessionRow, sessions: ConversationSessionRow[]): ConversationSessionRow | null {
  if (session.source !== 'tui') return null
  if (session.parent_session_id != null) return null
  if (!isBridgeContextPrompt(session.raw_preview || session.preview || session.title)) return null

  const sessionStarted = Number(session.started_at || 0)
  const candidates = sessions
    .filter(candidate => candidate.id !== session.id)
    .filter(candidate => candidate.source === session.source)
    .filter(candidate => candidate.source !== 'tool')
    .filter(candidate => !isBridgePromptOnlyContinuationStub(candidate))
    .filter(candidate => Number(candidate.started_at || 0) <= sessionStarted)
    .filter(candidate => candidate.has_visible_messages || Number(candidate.tool_call_count || 0) > 0)
    .sort((left, right) => {
      const leftAnchor = Number(left.last_active || left.started_at || 0)
      const rightAnchor = Number(right.last_active || right.started_at || 0)
      if (rightAnchor !== leftAnchor) return rightAnchor - leftAnchor
      if (right.started_at !== left.started_at) return right.started_at - left.started_at
      return right.id.localeCompare(left.id)
    })

  const exact = candidates.find(candidate => contextReferencesParent(candidate, session))
  if (exact) {
    if (shouldTraceContinuationSession(session.id)) {
      logger.info({
        sessionId: session.id,
        sessionTitle: session.title,
        exactParentId: exact.id,
        exactParentTitle: exact.title,
      }, '[conversations-db] inferred-parent exact-hit')
    }
    return exact
  }

  // Fallback: some root-level continuation prompts contain a long summarized
  // history that no longer includes an exact anchor from the immediate parent.
  // Keep this conservative:
  // - candidate itself must not also be a continuation prompt root
  // - either titles match, or the continuation history still contains a
  //   prefix-sized slice of the candidate anchor/preview text
  const sessionTitle = normalizeText(session.title)
  const history = bridgeContextHistoryText(session.raw_preview || session.preview || session.title)
  const assistantHistorySnippets = bridgeContextAssistantHistorySnippets(session.raw_preview || session.preview || session.title)
  const fallback = candidates.find(candidate => {
    if (isBridgeContextPrompt(candidate.raw_preview || candidate.preview || candidate.title)) return false
    const candidateTitle = normalizeText(candidate.title)
    const titleMatches = !!sessionTitle && !!candidateTitle && candidateTitle === sessionTitle
    const candidateAnchors = conversationHistoryAnchors(candidate).filter(anchor => anchor.length >= 16)
    const anchorMatches = candidateAnchors.some(anchor => {
      const window = Math.min(48, anchor.length)
      const fragmentWindow = Math.min(16, anchor.length)
      const coreWindow = Math.min(12, anchor.length)
      const fragments = new Set<string>()
      fragments.add(anchor.slice(0, window))
      fragments.add(anchor.slice(Math.max(0, anchor.length - window)))
      const middleStart = Math.max(0, Math.floor((anchor.length - fragmentWindow) / 2))
      fragments.add(anchor.slice(middleStart, middleStart + fragmentWindow))
      const coreStart = Math.max(0, Math.floor((anchor.length - coreWindow) / 2))
      fragments.add(anchor.slice(coreStart, coreStart + coreWindow))
      for (let start = 0; start + 16 <= anchor.length; start += 8) {
        fragments.add(anchor.slice(start, Math.min(anchor.length, start + fragmentWindow)))
      }
      return Array.from(fragments).some(fragment => fragment.length >= 12 && history.includes(fragment))
    })
    const assistantHistoryMatches = assistantHistorySnippets.some(snippet => candidateAnchors.some(anchor => anchor.includes(snippet) || snippet.includes(anchor)))
    const fullHistoryMatches = bridgeContextHistoryMatchesSession(candidate, session.raw_preview || session.preview || session.title)
    if (!titleMatches && !anchorMatches && !assistantHistoryMatches && !fullHistoryMatches) return false
    const anchor = Number(candidate.last_active || candidate.started_at || 0)
    const delta = sessionStarted - anchor
    return delta >= 0 && delta <= DUPLICATE_CONTINUATION_WINDOW_SECONDS
  })
  if (shouldTraceContinuationSession(session.id)) {
    logger.info({
      sessionId: session.id,
      sessionTitle: session.title,
      history: history.slice(0, 500),
      assistantHistorySnippets,
      candidateIds: candidates.slice(0, 10).map(candidate => candidate.id),
      candidateTitles: candidates.slice(0, 10).map(candidate => candidate.title),
      fallbackParentId: fallback?.id || null,
      fallbackParentTitle: fallback?.title || null,
    }, '[conversations-db] inferred-parent fallback-result')
  }
  return fallback || null
}

function isBridgePromptOnlyContinuationStub(session: ConversationSessionRow): boolean {
  return isBridgeContextPrompt(session.raw_preview || session.preview || session.title)
    && Number(session.message_count || 0) <= 1
    && Number(session.tool_call_count || 0) === 0
}

function explicitBridgeLinkMatchesParent(parent: ConversationSessionRow, child: ConversationSessionRow): boolean {
  if (!hasConversationContent(child)) return false
  const prompt = child.raw_preview || child.preview || child.title
  if (!isBridgeContextPrompt(prompt)) return true
  return bridgeContextHistoryMatchesSession(parent, prompt)
}

function resolvesToBridgeBoundary(
  session: ConversationSessionRow,
  boundary: ConversationSessionRow,
  byId: Map<string, ConversationSessionRow>,
  parentEvidence: Map<string, ParentEvidence>,
): boolean {
  const seen = new Set<string>()
  let current: ConversationSessionRow | undefined = session
  while (current && !seen.has(current.id)) {
    if (current.id === boundary.id) return true
    seen.add(current.id)

    const evidence = parentEvidence.get(current.id)
    if (evidence) {
      current = byId.get(evidence.parentId)
      continue
    }

    if (!current.parent_session_id) return false
    const nativeParent = byId.get(current.parent_session_id)
    if (!nativeParent || nativeParent.source !== current.source || nativeParent.source === 'tool') return false
    current = nativeParent
  }
  return false
}

function resolveLegacyBridgeParent(
  session: ConversationSessionRow,
  explicitParent: ConversationSessionRow | null,
  candidates: ConversationSessionRow[],
  byId: Map<string, ConversationSessionRow>,
  parentEvidence: Map<string, ParentEvidence>,
): { parent: ConversationSessionRow | null, kind: ParentEvidenceKind | null, reason: string } {
  const prompt = session.raw_preview || session.preview || session.title
  const inferredParent = isBridgeContextPrompt(prompt)
    ? findInferredBridgeContextParent(session, candidates)
    : null

  if (inferredParent) {
    if (explicitParent && explicitParent.id === inferredParent.id && explicitBridgeLinkMatchesParent(explicitParent, session)) {
      return { parent: explicitParent, kind: 'explicit_bridge_link', reason: 'explicit-link' }
    }
    if (explicitParent) {
      if (resolvesToBridgeBoundary(inferredParent, explicitParent, byId, parentEvidence)) {
        return {
          parent: inferredParent,
          kind: 'fallback_inference',
          reason: 'inferred-within-explicit-link',
        }
      }
      if (explicitBridgeLinkMatchesParent(explicitParent, session)) {
        return { parent: explicitParent, kind: 'explicit_bridge_link', reason: 'explicit-link' }
      }
      return { parent: null, kind: null, reason: 'explicit-link-context-mismatch' }
    }
    return {
      parent: inferredParent,
      kind: 'fallback_inference',
      reason: 'inferred',
    }
  }

  if (explicitParent && explicitBridgeLinkMatchesParent(explicitParent, session)) {
    return { parent: explicitParent, kind: 'explicit_bridge_link', reason: 'explicit-link' }
  }

  if (explicitParent) {
    return { parent: null, kind: null, reason: 'explicit-link-context-mismatch' }
  }

  return { parent: null, kind: null, reason: 'no-bridge-parent' }
}

function shouldSuppressBridgePromptTopLevelConversation(
  session: ConversationSessionRow,
  parentEvidence: Map<string, ParentEvidence>,
): boolean {
  if (session.parent_session_id != null) return false
  if (isBridgePromptOnlyContinuationStub(session)) return true
  if (!isBridgeContextPrompt(session.raw_preview || session.preview || session.title)) return false
  return !!parentEvidence.get(session.id)
}

function sessionLineageAliases(row: SessionLineageRow): string[] {
  return [
    row.session_id,
    row.web_session_id,
    row.bridge_session_id,
    row.persistent_session_id,
  ]
    .map(value => (value || '').trim())
    .filter((value, index, values) => !!value && values.indexOf(value) === index)
}

function applySessionLineageParentEvidence(
  map: Map<string, ParentEvidence>,
  sessions: ConversationSessionRow[],
  lineageRows: SessionLineageRow[],
) {
  if (!lineageRows.length) return
  const byId = new Map(sessions.map(session => [session.id, session]))
  const lineageByLogical = new Map<string, SessionLineageRow[]>()
  for (const row of lineageRows) {
    const logical = (row.logical_conversation_id || '').trim()
    if (!logical) continue
    const group = lineageByLogical.get(logical) || []
    group.push(row)
    lineageByLogical.set(logical, group)
  }

  for (const row of lineageRows) {
    if (row.authority !== 'explicit') continue
    if (row.relation_kind !== 'continuation' && row.relation_kind !== 'wrapper') continue

    const childId = sessionLineageAliases(row).find(id => !!byId.get(id))
    if (!childId) continue

    const parentCandidates = [
      row.parent_session_id,
      ...(lineageByLogical.get(row.logical_conversation_id || '') || []).flatMap(parentRow => {
        if (parentRow.session_id === row.session_id) return []
        if (parentRow.relation_kind !== 'root' && parentRow.session_id !== parentRow.root_session_id) return []
        return sessionLineageAliases(parentRow)
      }),
      row.root_session_id,
      row.logical_conversation_id,
    ]
      .map(value => (value || '').trim())
      .filter(Boolean)

    const parentId = parentCandidates.find(candidate => candidate !== childId && !!byId.get(candidate))
    if (!parentId) continue
    if (!map.has(childId)) map.set(childId, { parentId, kind: 'explicit_bridge_link' })
  }
}

function buildParentEvidenceMap(sessions: ConversationSessionRow[], protectedFallbackParentIds = new Set<string>()): Map<string, ParentEvidence> {
  const map = new Map<string, ParentEvidence>()
  const explicitLinks = readBridgeContinuationLinks()
  const sessionLineage = listSessionLineage()
  const byId = new Map(sessions.map(session => [session.id, session]))
  const sortedCandidates = sessions
    .filter(candidate => candidate.source === 'tui')
    .filter(candidate => candidate.source !== 'tool')
    .filter(candidate => candidate.has_visible_messages || Number(candidate.tool_call_count || 0) > 0)
    .sort((left, right) => {
      const leftAnchor = Number(left.last_active || left.started_at || 0)
      const rightAnchor = Number(right.last_active || right.started_at || 0)
      if (leftAnchor !== rightAnchor) return leftAnchor - rightAnchor
      if (left.started_at !== right.started_at) return left.started_at - right.started_at
      return left.id.localeCompare(right.id)
    })

  const sessionsByStartedAt = [...sessions].sort((left, right) => {
    if (left.started_at !== right.started_at) return left.started_at - right.started_at
    return left.id.localeCompare(right.id)
  })

  for (const session of sessionsByStartedAt) {
    const explicitParentId = explicitLinks[session.id]
    if (explicitParentId) {
      const explicitParent = byId.get(explicitParentId)
      if (!explicitParent || explicitParent.id === session.id) {
        logConversationDecision('skip-invalid-explicit-bridge-link', session, { explicitParentId })
        continue
      }
      const resolution = resolveLegacyBridgeParent(session, explicitParent, sortedCandidates.filter(candidate => {
        if (candidate.id === session.id) return false
        if (candidate.source !== session.source) return false
        if (candidate.source === 'tool') return false
        return Number(candidate.started_at || 0) <= Number(session.started_at || 0)
      }), byId, map)
      if (resolution.parent) {
        map.set(session.id, { parentId: resolution.parent.id, kind: resolution.kind || 'explicit_bridge_link' })
        if (resolution.reason === 'inferred-within-explicit-link') {
          logConversationDecision('use-inferred-bridge-parent-over-explicit-link', session, {
            explicitParentId: explicitParent.id,
            inferredParentId: resolution.parent.id,
          })
        }
        continue
      }
      logConversationDecision('skip-explicit-bridge-link-context-mismatch', session, {
        explicitParentId: explicitParent.id,
        explicitParentPreview: explicitParent.preview,
      })
    }
    if (session.parent_session_id != null) continue
    if (!isBridgeContextPrompt(session.raw_preview || session.preview || session.title)) continue
    const sessionStarted = Number(session.started_at || 0)
    const windowCandidates: ConversationSessionRow[] = []
    for (let index = sortedCandidates.length - 1; index >= 0; index -= 1) {
      const candidate = sortedCandidates[index]
      if (candidate.id === session.id) continue
      if (Number(candidate.started_at || 0) > sessionStarted) continue
      const anchor = Number(candidate.last_active || candidate.started_at || 0)
      const delta = sessionStarted - anchor
      if (delta > DUPLICATE_CONTINUATION_WINDOW_SECONDS) {
        if (anchor < sessionStarted - DUPLICATE_CONTINUATION_WINDOW_SECONDS) break
        continue
      }
      windowCandidates.push(candidate)
    }
    const parent = findInferredBridgeContextParent(session, windowCandidates)
    if (parent && !protectedFallbackParentIds.has(parent.id)) map.set(session.id, { parentId: parent.id, kind: 'fallback_inference' })
  }
  applySessionLineageParentEvidence(map, sessions, sessionLineage)
  return map
}

function buildInferredBridgeContextChildrenMap(parentEvidence: Map<string, ParentEvidence>): Map<string, string[]> {
  const children = new Map<string, string[]>()
  for (const [childId, evidence] of parentEvidence) {
    const siblings = children.get(evidence.parentId) || []
    siblings.push(childId)
    children.set(evidence.parentId, siblings)
  }
  return children
}

function bridgeContextRootId(
  sessionId: string,
  byId: Map<string, ConversationSessionRow>,
  parentEvidence: Map<string, ParentEvidence>,
): string | null {
  let current = byId.get(sessionId) || null
  if (!current) return null

  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    const parent = directBridgeContextParent(current, byId, parentEvidence)
    if (!parent) return current.id
    current = parent
  }
  return current?.id || null
}

function mergeChildrenByParent(
  directChildren: Map<string | null, string[]>,
  inferredChildren: Map<string, string[]>,
): Map<string | null, string[]> {
  const merged = new Map<string | null, string[]>()
  for (const [parentId, childIds] of directChildren) {
    merged.set(parentId, [...childIds])
  }
  for (const [parentId, childIds] of inferredChildren) {
    const next = merged.get(parentId) || []
    for (const childId of childIds) {
      if (!next.includes(childId)) next.push(childId)
    }
    merged.set(parentId, next)
  }
  return merged
}

function isSubagentSession(session: ConversationSessionRow | undefined): boolean {
  return !!session && session.source === 'subagent'
}

function isAgentLikeBranchSession(
  session: ConversationSessionRow | undefined,
  byId: Map<string, ConversationSessionRow>,
  inferredChildren?: Map<string, string[]>,
): boolean {
  if (!session || session.source === 'tool') return false
  if (session.source === 'subagent') return true
  if (isEmptyCompressionSession(session)) return false
  if ((session.source !== 'tui' && session.source !== 'webui-bridge') || !session.parent_session_id) return false
  const parent = byId.get(session.parent_session_id)
  if (!parent || parent.source === 'tool') return false
  if (session.source === 'tui' && (inferredChildren?.get(session.id) || []).length > 0 && parent.ended_at == null) return true
  if (isBridgeContextPrompt(session.raw_preview || session.preview || session.title)) return false
  if (isCompressionLineageChild(session, byId)) return false
  if (isExplicitHandoffContinuationChild(session, byId)) return false
  if (isBridgeContextBranchContinuationChild(session, byId, inferredChildren)) return false

  const childStarted = Number(session.started_at || 0)
  const parentStarted = Number(parent.started_at || 0)
  if (childStarted < parentStarted) return false

  if (parent.ended_at == null) return true
  return childStarted + LINEAGE_TOLERANCE_SECONDS < Number(parent.ended_at || 0)
}

function hasTrustedNativeParent(
  session: ConversationSessionRow,
  parent: ConversationSessionRow,
  byId: Map<string, ConversationSessionRow>,
  childrenByParent: Map<string | null, string[]>,
): boolean {
  if (session.source !== parent.source) return false
  if (session.source !== 'tui' && session.source !== 'webui-bridge') return true
  if (isOutputEmptyCompressionSession(parent) || isOutputEmptyCompressionSession(session)) {
    return isTrustedEmptyCompressionPivotLink(parent, session, byId, childrenByParent)
  }
  if (parent.ended_at == null && hasBridgeContextPromptDescendantReferencing(session, byId, childrenByParent)) return true
  if (hasBridgeContextPromptDescendantReferencingAny(session, nativeAncestorAnchors(parent, byId), byId, childrenByParent)) return true
  if (isTrustedLongGapNativeContinuation(parent, session, byId, childrenByParent)) return true
  if (isCompressionLineageChild(parent, byId)) return false
  if (isCompressionLineageChild(session, byId)) return true
  if (isExplicitHandoffContinuationChild(session, byId)) return true
  if (isLikelyExplicitContinuation(parent, session)) return true
  if (isBridgeContextBranchContinuationChild(session, byId)) return true
  return false
}

function effectiveParentEvidence(
  session: ConversationSessionRow | undefined,
  parentEvidence: Map<string, ParentEvidence>,
  byId?: Map<string, ConversationSessionRow>,
  childrenByParent?: Map<string | null, string[]>,
): ParentEvidence | null {
  if (!session) return null
  const explicitOrFallback = parentEvidence.get(session.id)
  if (explicitOrFallback) return explicitOrFallback
  if (!session.parent_session_id) return null
  const parent = byId?.get(session.parent_session_id)
  if (parent && byId && childrenByParent && !hasTrustedNativeParent(session, parent, byId, childrenByParent)) {
    logConversationDecision('skip-untrusted-native-parent', session, {
      parentId: parent.id,
      parentEndReason: parent.end_reason,
      parentMessageCount: parent.message_count,
      parentToolCallCount: parent.tool_call_count,
    })
    return null
  }
  if (parent || !byId) return { parentId: session.parent_session_id, kind: 'native_parent' }
  return null
}

function effectiveParentId(
  session: ConversationSessionRow | undefined,
  parentEvidence: Map<string, ParentEvidence>,
  byId?: Map<string, ConversationSessionRow>,
  childrenByParent?: Map<string | null, string[]>,
): string | null {
  return effectiveParentEvidence(session, parentEvidence, byId, childrenByParent)?.parentId ?? null
}

function rootConversationIdForSession(
  sessionId: string,
  byId: Map<string, ConversationSessionRow>,
  parentEvidence: Map<string, ParentEvidence>,
  childrenByParent?: Map<string | null, string[]>,
  memo = new Map<string, string | null>(),
): string | null {
  if (memo.has(sessionId)) return memo.get(sessionId) ?? null
  const session = byId.get(sessionId)
  if (!session || session.source === 'tool') {
    memo.set(sessionId, null)
    return null
  }

  const seen = new Set<string>()
  let current: ConversationSessionRow | undefined = session
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    const parentId = effectiveParentId(current, parentEvidence, byId, childrenByParent)
    if (!parentId) {
      if (shouldTraceContinuationSession(sessionId)) {
        logger.info({
          sessionId,
          resolvedRootId: current.id,
          seen: Array.from(seen),
        }, '[conversations-db] root-conversation resolved-no-parent')
      }
      memo.set(sessionId, current.id)
      return current.id
    }
    const parent = byId.get(parentId)
    if (!parent) {
      if (shouldTraceContinuationSession(sessionId)) {
        logger.info({
          sessionId,
          missingParentId: parentId,
          resolvedRootId: current.id,
          seen: Array.from(seen),
        }, '[conversations-db] root-conversation missing-parent')
      }
      memo.set(sessionId, current.id)
      return current.id
    }
    if (
      childrenByParent
      && isOutputEmptyCompressionSession(parent)
      && !isTrustedEmptyCompressionPivotLink(parent, current, byId, childrenByParent)
    ) {
      memo.set(sessionId, current.id)
      return current.id
    }
    current = parent
  }

  if (shouldTraceContinuationSession(sessionId)) {
    logger.info({
      sessionId,
      loopResolvedRootId: current?.id ?? session.id,
      seen: Array.from(seen),
    }, '[conversations-db] root-conversation loop-exit')
  }
  memo.set(sessionId, current?.id ?? session.id)
  return current?.id ?? session.id
}

function hasInvalidEmptyCompressionPivotAncestor(
  session: ConversationSessionRow,
  byId: Map<string, ConversationSessionRow>,
  childrenByParent: Map<string | null, string[]>,
): boolean {
  const seen = new Set<string>()
  let current: ConversationSessionRow | undefined = session

  while (current?.parent_session_id && !seen.has(current.id)) {
    seen.add(current.id)
    const parent = byId.get(current.parent_session_id)
    if (!parent) return false
    if (
      isOutputEmptyCompressionSession(parent)
      && !isTrustedEmptyCompressionPivotLink(parent, current, byId, childrenByParent)
    ) return true
    if (
      isEmptyCompressionSession(current)
      && !isCompressionEndReason(parent.end_reason)
      && !isLikelyEmptyCompressionPivotContinuation(parent, current, byId, childrenByParent)
    ) return true
    current = parent
  }

  return false
}

function mainlineSessionsForRoot(
  rootId: string,
  sessions: ConversationSessionRow[],
  byId: Map<string, ConversationSessionRow>,
  childrenByParent: Map<string | null, string[]>,
  parentEvidence: Map<string, ParentEvidence>,
  inferredChildren?: Map<string, string[]>,
): ConversationSessionRow[] {
  const memo = new Map<string, string | null>()
  return sessions
    .filter(session => session.source !== 'tool')
    .filter(session => !isAgentLikeBranchSession(session, byId, inferredChildren))
    .filter(session => {
      const resolvedRootId = rootConversationIdForSession(session.id, byId, parentEvidence, childrenByParent, memo)
      if (resolvedRootId !== rootId) return false
      return resolvedRootId === session.id || !hasInvalidEmptyCompressionPivotAncestor(session, byId, childrenByParent)
    })
    .sort((left, right) => {
      if (left.started_at !== right.started_at) return left.started_at - right.started_at
      return left.id.localeCompare(right.id)
    })
}

function buildMainlineByRoot(
  sessions: ConversationSessionRow[],
  byId: Map<string, ConversationSessionRow>,
  childrenByParent: Map<string | null, string[]>,
  parentEvidence: Map<string, ParentEvidence>,
  inferredChildren?: Map<string, string[]>,
): Map<string, ConversationSessionRow[]> {
  const rootMemo = new Map<string, string | null>()
  const grouped = new Map<string, ConversationSessionRow[]>()

  for (const session of sessions) {
    if (session.source === 'tool') continue
    if (isAgentLikeBranchSession(session, byId, inferredChildren)) continue
    const rootId = rootConversationIdForSession(session.id, byId, parentEvidence, childrenByParent, rootMemo)
    if (!rootId) continue
    if (rootId !== session.id && hasInvalidEmptyCompressionPivotAncestor(session, byId, childrenByParent)) continue
    const group = grouped.get(rootId) || []
    group.push(session)
    grouped.set(rootId, group)
  }

  for (const group of grouped.values()) {
    group.sort((left, right) => {
      if (left.started_at !== right.started_at) return left.started_at - right.started_at
      return left.id.localeCompare(right.id)
    })
  }

  return grouped
}

function collectSubagentBranchRoots(
  mainlineIds: Set<string>,
  byId: Map<string, ConversationSessionRow>,
  effectiveChildren: Map<string | null, string[]>,
  inferredChildren?: Map<string, string[]>,
): ConversationSessionRow[] {
  const roots: ConversationSessionRow[] = []
  for (const parentId of mainlineIds) {
      const childIds = effectiveChildren.get(parentId) || []
    for (const childId of childIds) {
      const child = byId.get(childId)
      if (child && isAgentLikeBranchSession(child, byId, inferredChildren)) roots.push(child)
    }
  }
  return roots.sort((left, right) => {
    if (left.started_at !== right.started_at) return left.started_at - right.started_at
    return left.id.localeCompare(right.id)
  })
}

function buildSubagentBranchTree(
  db: { prepare: (sql: string) => { all: (...params: any[]) => Array<Record<string, unknown>> } },
  root: ConversationSessionRow,
  byId: Map<string, ConversationSessionRow>,
  effectiveChildren: Map<string | null, string[]>,
  inferredChildren?: Map<string, string[]>,
  seen = new Set<string>(),
): ConversationBranch | null {
  if (!isAgentLikeBranchSession(root, byId, inferredChildren) || seen.has(root.id)) return null
  seen.add(root.id)

  const childBranches = (effectiveChildren.get(root.id) || [])
    .map(childId => byId.get(childId))
    .filter((child): child is ConversationSessionRow => isAgentLikeBranchSession(child, byId, inferredChildren))
    .map(child => buildSubagentBranchTree(db, child, byId, effectiveChildren, inferredChildren, seen))
    .filter((branch): branch is ConversationBranch => !!branch)

  const messages = loadVisibleMessagesForSessions(db, [root])
  return {
    session_id: root.id,
    parent_session_id: root.parent_session_id ?? null,
    source: safeText(root.source),
    model: safeText(root.model),
    title: root.title ?? null,
    started_at: Number(root.started_at || 0),
    ended_at: root.ended_at ?? null,
    last_active: Number(root.last_active || root.started_at || 0),
    is_active: root.is_active,
    messages,
    visible_count: messages.length,
    thread_session_count: 1,
    input_tokens: Number(root.input_tokens || 0),
    output_tokens: Number(root.output_tokens || 0),
    branches: childBranches,
  }
}

function directBridgeContextParent(
  session: ConversationSessionRow | undefined,
  byId: Map<string, ConversationSessionRow>,
  parentEvidence: Map<string, ParentEvidence>,
): ConversationSessionRow | null {
  if (!session) return null
  if (isBridgeContextBranchContinuationChild(session, byId) && session.parent_session_id) {
    return byId.get(session.parent_session_id) || null
  }
  const evidence = parentEvidence.get(session.id)
  return evidence ? (byId.get(evidence.parentId) || null) : null
}

function bridgeContextHistoryPathToRoot(session: ConversationSessionRow, byId: Map<string, ConversationSessionRow>, parentEvidence: Map<string, ParentEvidence>): ConversationSessionRow[] {
  const firstParent = directBridgeContextParent(session, byId, parentEvidence)
  if (!firstParent) return []
  const reversed: ConversationSessionRow[] = []
  const seen = new Set<string>()
  let current: ConversationSessionRow | null = firstParent

  while (current && !seen.has(current.id)) {
    reversed.push(current)
    seen.add(current.id)
    current = directBridgeContextParent(current, byId, parentEvidence)
  }

  return reversed.reverse()
}

function hasBridgeContextContinuationDescendant(
  session: ConversationSessionRow,
  byId: Map<string, ConversationSessionRow>,
  childrenByParent: Map<string | null, string[]>,
  inferredChildren: Map<string, string[]>,
  seen = new Set<string>(),
): boolean {
  if (seen.has(session.id)) return false
  seen.add(session.id)
  if ((inferredChildren.get(session.id) || []).length > 0) return true
  const childIds = childrenByParent.get(session.id) || []
  for (const childId of childIds) {
    const child = byId.get(childId)
    if (!child || child.source === 'tool') continue
    if (isBridgeContextBranchContinuationChild(child, byId)) return true
    if (hasBridgeContextContinuationDescendant(child, byId, childrenByParent, inferredChildren, seen)) return true
  }
  return false
}

function isCompressionLineageChild(session: ConversationSessionRow | undefined, byId: Map<string, ConversationSessionRow>): boolean {
  if (!session?.parent_session_id) return false
  const parent = byId.get(session.parent_session_id)
  if (isOutputEmptyCompressionSession(parent)) return false
  return !!parent && isCompressionEndReason(parent.end_reason) && isLikelyOrphanContinuation(parent, session)
}

function compressionChainRootId(sessionId: string, byId: Map<string, ConversationSessionRow>, childrenByParent: Map<string | null, string[]>): string | null {
  let current = byId.get(sessionId) || null
  if (!current || current.source === 'tool') return null

  const seen = new Set<string>()
  while (current?.parent_session_id && !seen.has(current.id)) {
    seen.add(current.id)
    const parent = byId.get(current.parent_session_id)
    if (!parent) break
    if (!isCompressionLineageChild(current, byId)) break
    current = parent
  }
  return current?.id || null
}

function compressionPathToRoot(session: ConversationSessionRow, byId: Map<string, ConversationSessionRow>): ConversationSessionRow[] {
  const reversed: ConversationSessionRow[] = [session]
  const seen = new Set<string>()
  let current: ConversationSessionRow | null = session

  while (current?.parent_session_id && !seen.has(current.id)) {
    seen.add(current.id)
    const parent = byId.get(current.parent_session_id)
    if (!parent || !isCompressionLineageChild(current, byId)) break
    reversed.push(parent)
    current = parent
  }

  return reversed.reverse()
}

function isLatestCompressionContinuation(session: ConversationSessionRow | undefined, byId: Map<string, ConversationSessionRow>, childrenByParent: Map<string | null, string[]>): boolean {
  if (!session || session.source === 'tool') return false
  const path = compressionPathToRoot(session, byId)
  if (path.length <= 1) return false
  return collectConversationChain(path[0].id, byId, childrenByParent).at(-1)?.id === session.id
}

function isLatestBridgeContextContinuation(
  session: ConversationSessionRow | undefined,
  byId: Map<string, ConversationSessionRow>,
  childrenByParent: Map<string | null, string[]>,
  parentEvidence: Map<string, ParentEvidence>,
  inferredChildren: Map<string, string[]>,
): boolean {
  if (!session || session.source === 'tool') return false
  const parent = directBridgeContextParent(session, byId, parentEvidence)
  if (!parent) return false
  if ((inferredChildren.get(session.id) || []).length > 0) return false
  if (parent && isCompressionLineageChild(parent, byId)) return false
  return collectConversationChain(session.id, byId, childrenByParent).at(-1)?.id === session.id
}

function isBranchRoot(session: ConversationSessionRow | undefined, byId: Map<string, ConversationSessionRow>): boolean {
  if (!session?.parent_session_id) return false
  const parent = byId.get(session.parent_session_id)
  return !!parent && parent.end_reason === 'branched' && timingMatchesParent(parent, session)
}

function isRealConversationBranch(session: ConversationSessionRow | undefined, byId: Map<string, ConversationSessionRow>): boolean {
  if (!session || session.source === 'tool') return false
  if (session.source === 'subagent') return true
  return isBranchRoot(session, byId)
}

function isVisibleConversationStart(
  session: ConversationSessionRow | undefined,
  byId: Map<string, ConversationSessionRow>,
  childrenByParent: Map<string | null, string[]>,
  parentEvidence: Map<string, ParentEvidence>,
  inferredChildren: Map<string, string[]>,
): boolean {
  if (!session || session.source === 'tool') return false
  if (session.source === 'tui' && !session.has_visible_messages && Number(session.tool_call_count || 0) <= 0 && !session.title) {
    logConversationDecision('hide-empty-tui-stub', session, { reason: 'no visible messages or tool activity' })
    return false
  }
  if (isBridgePromptOnlyContinuationStub(session)) {
    logConversationDecision('hide-wrapper-only-bridge-context-stub', session, { reason: 'wrapper prompt without assistant/tool output' })
    return false
  }
  if (directBridgeContextParent(session, byId, parentEvidence)) {
    logConversationDecision('hide-bridge-context-continuation-child', session, { reason: 'fold into root conversation' })
    return false
  }
  if (session.source === 'tui' && (inferredChildren.get(session.id) || []).length > 0 && session.parent_session_id) {
    logConversationDecision('hide-bridge-context-placeholder-root', session, { reason: 'placeholder is represented by inferred bridge continuation' })
    return false
  }
  if (isAgentLikeBranchSession(session, byId, inferredChildren)) {
    logConversationDecision('hide-agent-like-branch-placeholder', session, { reason: 'branch placeholder is represented under its root' })
    return false
  }
  const hasEffectiveParent = !!effectiveParentEvidence(session, parentEvidence, byId, childrenByParent)
  const visible = (!hasEffectiveParent || isBranchRoot(session, byId))
    && !isCompressionContinuationChild(session, byId, childrenByParent)
    && !isCompressionLineageChild(session, byId)
  if (shouldTraceContinuationSession(session.id)) {
    logger.info({
      sessionId: session.id,
      visible,
      parentSessionId: session.parent_session_id,
      hasEffectiveParent,
      isBranchRoot: isBranchRoot(session, byId),
      hasDirectBridgeParent: !!directBridgeContextParent(session, byId, parentEvidence),
      isCompressionContinuationChild: isCompressionContinuationChild(session, byId, childrenByParent),
      isCompressionLineageChild: isCompressionLineageChild(session, byId),
      title: session.title,
      preview: session.preview,
      rawPreview: session.raw_preview,
    }, '[conversations-db] visible-start-eval')
  }
  if (visible) {
    logConversationDecision('keep-visible-root', session, { reason: 'root or branch root conversation' })
  }
  return visible
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

function representedSessionIds(chain: ConversationSessionRow[]): string[] {
  return [...new Set(chain.map(session => safeText(session.id)).filter(Boolean))]
}

function sessionsByStartedAt(byId: Map<string, ConversationSessionRow>): ConversationSessionRow[] {
  return [...byId.values()].sort((left, right) => {
    if (left.started_at !== right.started_at) return left.started_at - right.started_at
    return left.id.localeCompare(right.id)
  })
}

function continuationEdgesForChain(
  chain: ConversationSessionRow[],
  parentEvidence: Map<string, ParentEvidence>,
  byId: Map<string, ConversationSessionRow>,
  childrenByParent: Map<string | null, string[]>,
): ConversationContinuationEdge[] {
  const chainIds = new Set(chain.map(session => session.id))
  const edges: ConversationContinuationEdge[] = []
  for (const session of chain) {
    const evidence = effectiveParentEvidence(session, parentEvidence, byId, childrenByParent)
    if (!evidence || !chainIds.has(evidence.parentId)) continue
    edges.push({
      child_session_id: session.id,
      parent_session_id: evidence.parentId,
      kind: evidence.kind,
    })
  }
  return edges.sort((left, right) => {
    const leftChild = chain.find(session => session.id === left.child_session_id)
    const rightChild = chain.find(session => session.id === right.child_session_id)
    const leftStarted = Number(leftChild?.started_at || 0)
    const rightStarted = Number(rightChild?.started_at || 0)
    if (leftStarted !== rightStarted) return leftStarted - rightStarted
    return left.child_session_id.localeCompare(right.child_session_id)
  })
}

function logConversationDecision(stage: string, session: ConversationSessionRow | undefined, detail: Record<string, unknown> = {}) {
  if (!session) return
  if (!shouldTraceConversationAggregation() && !shouldTraceContinuationSession(session.id)) return
  logger.info({
    sessionId: session.id,
    source: session.source,
    parentSessionId: session.parent_session_id,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    endReason: session.end_reason,
    hasVisibleMessages: session.has_visible_messages,
    isActive: session.is_active,
    isLiveTuiProcess: session.is_live_tui_process,
    preview: session.preview,
    rawPreview: session.raw_preview,
    ...detail,
  }, '[conversations-db] %s', stage)
}

function bridgeContextHistoryChain(chain: ConversationSessionRow[]): ConversationSessionRow[] {
  if (chain.length < 2) return []
  const visibleRoot = chain[chain.length - 1]
  const history = chain.slice(0, -1)
  return history.length && isLikelyBridgeContextBranchContinuation(history[history.length - 1], visibleRoot)
    ? history
    : []
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
    billing_base_url: session.billing_base_url ?? null,
    estimated_cost_usd: Number(session.estimated_cost_usd || 0),
    actual_cost_usd: session.actual_cost_usd ?? null,
    cost_status: safeText(session.cost_status),
    preview: session.preview,
    is_active: session.is_active,
    thread_session_count: 1,
    branch_session_count: 0,
    represented_session_ids: [session.id],
  }
}

function aggregateSummary(
  rootId: string,
  byId: Map<string, ConversationSessionRow>,
  childrenByParent: Map<string | null, string[]>,
  branchSessionCount: number,
  parentEvidence: Map<string, ParentEvidence>,
  mainline?: ConversationSessionRow[],
): ConversationSummary | null {
  const requestedRoot = byId.get(rootId)
  const fallbackCompressionHistory = requestedRoot ? compressionPathToRoot(requestedRoot, byId).slice(0, -1) : []
  const fallbackBridgeContextHistory = requestedRoot ? bridgeContextHistoryPathToRoot(requestedRoot, byId, parentEvidence) : []
  const fallbackChain = fallbackCompressionHistory.length ? [requestedRoot!] : collectConversationChain(rootId, byId, childrenByParent)
  const normalizedMainline = (mainline || []).filter(session => session.source !== 'tool')
  const unifiedChain = normalizedMainline.length
    ? normalizedMainline
    : [...fallbackBridgeContextHistory, ...fallbackChain]
  const summaryChain = unifiedChain.filter((session, index) => {
    if (index > 0 && isBridgePromptOnlyContinuationStub(session)) return false
    return true
  })
  if (!summaryChain.length || ![...summaryChain, ...fallbackCompressionHistory].some(session => session.has_visible_messages || Number(session.tool_call_count || 0) > 0)) return null
  const root = summaryChain[0]
  const visibleHead = requestedRoot || root
  const last = summaryChain[summaryChain.length - 1]
  const firstPreview = summaryChain.map(session => session.preview).find(Boolean) || ''
  const costStatuses = Array.from(new Set(summaryChain.map(session => safeText(session.cost_status)).filter(Boolean)))
  const normalizedBranchSessionCount = requestedRoot && isBridgeContextBranchContinuationChild(requestedRoot, byId)
    ? 0
    : branchSessionCount
  if (shouldTraceConversationAggregation() || shouldTraceContinuationSession(rootId)) {
    logger.info({
      rootId,
      chainIds: unifiedChain.map(session => session.id),
      summaryChainIds: summaryChain.map(session => session.id),
      compressionHistoryIds: fallbackCompressionHistory.map(session => session.id),
      bridgeContextHistoryIds: fallbackBridgeContextHistory.map(session => session.id),
      mainlineIds: normalizedMainline.map(session => session.id),
      representedSessionIds: representedSessionIds(unifiedChain),
      branchSessionCount: normalizedBranchSessionCount,
    }, '[conversations-db] aggregate-summary')
  }

  return {
    ...toSummary(visibleHead),
    title: root.title || last.title || firstPreview || null,
    preview: last.preview || visibleHead.preview || root.preview || firstPreview,
    started_at: Number(visibleHead.started_at || 0),
    ended_at: last?.ended_at ?? null,
    last_active: Math.max(...summaryChain.map(session => session.last_active)),
    is_active: summaryChain.some(session => session.is_active),
    billing_provider: last?.billing_provider ?? root.billing_provider ?? null,
    billing_base_url: last?.billing_base_url ?? root.billing_base_url ?? null,
    cost_status: costStatuses.length === 1 ? costStatuses[0] : 'mixed',
    thread_session_count: summaryChain.length,
    branch_session_count: normalizedBranchSessionCount,
    message_count: summaryChain.reduce((sum, session) => sum + Number(session.message_count || 0), 0),
    tool_call_count: summaryChain.reduce((sum, session) => sum + Number(session.tool_call_count || 0), 0),
    input_tokens: Number(last.input_tokens || 0),
    output_tokens: Number(last.output_tokens || 0),
    cache_read_tokens: Number(last.cache_read_tokens || 0),
    cache_write_tokens: Number(last.cache_write_tokens || 0),
    reasoning_tokens: Number(last.reasoning_tokens || 0),
    estimated_cost_usd: summaryChain.reduce((sum, session) => sum + Number(session.estimated_cost_usd || 0), 0),
    actual_cost_usd: summaryChain.reduce<number | null>((sum, session) => {
      const actual = session.actual_cost_usd
      if (actual == null) return sum
      return (sum || 0) + Number(actual)
    }, null),
    represented_session_ids: representedSessionIds(unifiedChain),
  }
}

function conversationTitleForChain(chain: ConversationSessionRow[]): string | null {
  if (!chain.length) return null
  const root = chain[0]
  const last = chain[chain.length - 1]
  const firstPreview = chain.map(session => session.preview).find(Boolean) || ''
  return root.title || last.title || firstPreview || null
}

function normalizeDetailMessage(row: Record<string, unknown>, fallbackTimestamp: number): ConversationMessage | null {
  const role = safeText(row.role)
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') return null
  if (role === 'tool' && !normalizeNullableString(row.tool_call_id)) return null
  const rawContent = row.content == null ? '' : String(row.content)
  const displayContent = role === 'user'
    ? (bridgeContextDisplayText(rawContent) || rawContent)
    : rawContent
  if (role !== 'tool' && !displayContent.trim()) {
    const toolCalls = parseToolCalls(row.tool_calls)
    if (role !== 'assistant' || !toolCalls?.length) return null
  }
  if ((role === 'user' || role === 'assistant') && isSyntheticUserText(displayContent)) return null

  return {
    id: row.id as number | string,
    session_id: String(row.session_id || ''),
    role: role as ConversationMessage['role'],
    content: displayContent,
    tool_call_id: normalizeNullableString(row.tool_call_id),
    tool_calls: parseToolCalls(row.tool_calls),
    tool_name: normalizeNullableString(row.tool_name),
    timestamp: Number.isFinite(Number(row.timestamp)) && Number(row.timestamp) > 0
      ? Number(row.timestamp)
      : fallbackTimestamp,
    token_count: normalizeNullableNumber(row.token_count),
    finish_reason: normalizeNullableString(row.finish_reason),
    reasoning: normalizeNullableString(row.reasoning) || normalizeNullableString(row.reasoning_content),
  }
}

function normalizeVisibleMessagesFromRows(rows: Array<Record<string, unknown>>, sessions: ConversationSessionRow[]): ConversationMessage[] {
  const sessionById = new Map(sessions.map(session => [session.id, session]))
  const sessionIndex = new Map(sessions.map((session, index) => [session.id, index]))
  const syntheticHandoffSessionIds = new Set(
    rows
      .filter(row => isSyntheticUserText(row.content))
      .map(row => String(row.session_id || '')),
  )
  const normalized = rows
    .map(row => {
      const session = sessionById.get(String(row.session_id || ''))
      return normalizeDetailMessage(row, session?.last_active || session?.started_at || 0)
    })
    .filter((message): message is ConversationMessage => !!message)
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
      return String(a.id).localeCompare(String(b.id))
    })
  if (normalized.length < 2) return normalized

  return filterCompressionReplayPrefixMessages(
    filterOrphanToolMessages(filterExplicitMainlineReplayPrefixMessages(
      normalized,
      sessions,
      sessionById,
      sessionIndex,
      { filterUserPrefix: 'native-non-compression', syntheticHandoffSessionIds },
    )),
    sessions,
    sessionById,
    sessionIndex,
  )
}

function visibleMessageReplayKey(message: ConversationMessage): string {
  return `${message.role}\u0000${normalizeText(message.content)}`
}

function messageToolCallIds(message: ConversationMessage): string[] {
  const ids: string[] = []
  if (message.tool_call_id) ids.push(message.tool_call_id)
  for (const toolCall of message.tool_calls || []) {
    for (const key of ['id', 'call_id'] as const) {
      const value = toolCall?.[key]
      if (typeof value === 'string' && value) ids.push(value)
    }
  }
  return [...new Set(ids)]
}

function visibleMessagesReplayEquivalent(message: ConversationMessage, prior: ConversationMessage): boolean {
  if (visibleMessageReplayKey(message) === visibleMessageReplayKey(prior)) return true
  if (message.role !== 'tool' || prior.role !== 'tool') return false
  const priorIds = new Set(messageToolCallIds(prior))
  return messageToolCallIds(message).some(id => priorIds.has(id))
}

function isReplayPrefixMessage(message: ConversationMessage): boolean {
  return message.role === 'assistant'
}

function filterExplicitMainlineReplayPrefixMessages(
  messages: ConversationMessage[],
  sessions: ConversationSessionRow[],
  sessionById: Map<string, ConversationSessionRow>,
  sessionIndex: Map<string, number>,
  options: { filterUserPrefix?: boolean | 'native-non-compression', syntheticHandoffSessionIds?: Set<string> } = {},
): ConversationMessage[] {
  const bySession = new Map<string, ConversationMessage[]>()
  for (const message of messages) {
    const grouped = bySession.get(message.session_id) || []
    grouped.push(message)
    bySession.set(message.session_id, grouped)
  }

  const priorMessages: ConversationMessage[] = []
  const filtered: ConversationMessage[] = []
  const filterUserPrefix = options.filterUserPrefix ?? true
  for (const session of sessions) {
    const sessionMessages = bySession.get(session.id) || []
    const parent = session.parent_session_id ? sessionById.get(session.parent_session_id) : null
    const canFilterCompressionHandoffPrefix = !!parent
      && isCompressionEndReason(parent.end_reason)
      && timingMatchesParent(parent, session)
      && !!options.syntheticHandoffSessionIds?.has(session.id)
    let replayIndex = 0
    const canFilterUserPrefix = filterUserPrefix === true
      || (
        filterUserPrefix === 'native-non-compression'
        && !!session.parent_session_id
        && (
          !isCompressionReplaySession(session, sessions, sessionById, sessionIndex)
          || canFilterCompressionHandoffPrefix
        )
      )
    if (canFilterUserPrefix) {
      while (
        replayIndex < sessionMessages.length
        && replayIndex < priorMessages.length
        && visibleMessagesReplayEquivalent(sessionMessages[replayIndex], priorMessages[replayIndex])
      ) {
        replayIndex += 1
      }
    }
    const syntheticIndex = sessionMessages.findIndex(message => isSyntheticUserText(message.content))
    const isCompressionHandoffReplay = canFilterCompressionHandoffPrefix
      && replayIndex > 0
      && (syntheticIndex < 0 || replayIndex <= syntheticIndex)
    const prefixThreshold = isReplayPrefixEligibleSession(session, sessions, sessionById, sessionIndex) ? 1 : 2
    const prefixLength = isCompressionReplaySession(session, sessions, sessionById, sessionIndex)
      && filterUserPrefix === 'native-non-compression'
      ? (isCompressionHandoffReplay ? replayIndex : 0)
      : replayIndex >= prefixThreshold
        && (syntheticIndex < 0 || replayIndex <= syntheticIndex)
        ? replayIndex
        : 0
    const droppedToolCallIds = new Set<string>()
    if (prefixLength > 0) {
      for (const message of sessionMessages.slice(0, prefixLength)) {
        for (const toolCall of message.tool_calls || []) {
          for (const key of ['id', 'call_id'] as const) {
            const value = toolCall?.[key]
            if (typeof value === 'string' && value) droppedToolCallIds.add(value)
          }
        }
        if (message.tool_call_id) droppedToolCallIds.add(message.tool_call_id)
      }
    }

    const remainingMessages = sessionMessages.slice(prefixLength)
    let stillInReplayPrefix = prefixLength > 0
    for (const message of remainingMessages) {
      if (
        stillInReplayPrefix
        && message.role === 'tool'
        && !!message.tool_call_id
        && droppedToolCallIds.has(message.tool_call_id)
      ) {
        continue
      }
      if (message.role !== 'tool') stillInReplayPrefix = false
      filtered.push(message)
    }
    for (const message of sessionMessages) {
      priorMessages.push(message)
    }
  }

  return filtered
}

function filterOrphanToolMessages(messages: ConversationMessage[]): ConversationMessage[] {
  const knownToolCallIds = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const id of messageToolCallIds(message)) knownToolCallIds.add(id)
  }
  return messages.filter(message => (
    message.role !== 'tool'
    || !message.tool_call_id
    || knownToolCallIds.has(message.tool_call_id)
  ))
}

function isCompressionReplaySession(
  session: ConversationSessionRow,
  sessions: ConversationSessionRow[],
  sessionById: Map<string, ConversationSessionRow>,
  sessionIndex: Map<string, number>,
): boolean {
  const index = sessionIndex.get(session.id)
  if (index == null || index <= 0) return false
  const parent = session.parent_session_id ? sessionById.get(session.parent_session_id) : null
  if (isCompressionEndReason(parent?.end_reason ?? null)) return true
  return isCompressionEndReason(sessions[index - 1]?.end_reason ?? null)
}

function isReplayPrefixEligibleSession(
  session: ConversationSessionRow,
  sessions: ConversationSessionRow[],
  sessionById: Map<string, ConversationSessionRow>,
  sessionIndex: Map<string, number>,
): boolean {
  const parent = session.parent_session_id ? sessionById.get(session.parent_session_id) : null
  return !isCompressionReplaySession(session, sessions, sessionById, sessionIndex)
    || isCompressionEndReason(parent?.end_reason ?? null)
}

function filterCompressionReplayPrefixMessages(
  messages: ConversationMessage[],
  sessions: ConversationSessionRow[],
  sessionById: Map<string, ConversationSessionRow>,
  sessionIndex: Map<string, number>,
): ConversationMessage[] {
  const bySession = new Map<string, ConversationMessage[]>()
  for (const message of messages) {
    const grouped = bySession.get(message.session_id) || []
    grouped.push(message)
    bySession.set(message.session_id, grouped)
  }

  const prior = new Set<string>()
  const filtered: ConversationMessage[] = []
  for (const session of sessions) {
    const sessionMessages = bySession.get(session.id) || []
    if (isCompressionReplaySession(session, sessions, sessionById, sessionIndex)) {
      filtered.push(...sessionMessages.filter(message => (
        !isReplayPrefixMessage(message) || !prior.has(visibleMessageReplayKey(message))
      )))
    } else {
      filtered.push(...sessionMessages)
    }
    for (const message of sessionMessages) {
      prior.add(visibleMessageReplayKey(message))
    }
  }

  return filtered.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
    return String(a.id).localeCompare(String(b.id))
  })
}

function filterCompressionReplayPrefixMessagesPreservingOrder(
  messages: ConversationMessage[],
  sessions: ConversationSessionRow[],
  sessionById: Map<string, ConversationSessionRow>,
  sessionIndex: Map<string, number>,
): ConversationMessage[] {
  const bySession = new Map<string, ConversationMessage[]>()
  for (const message of messages) {
    const grouped = bySession.get(message.session_id) || []
    grouped.push(message)
    bySession.set(message.session_id, grouped)
  }

  const prior = new Set<string>()
  const filtered: ConversationMessage[] = []
  for (const session of sessions) {
    const sessionMessages = bySession.get(session.id) || []
    if (isCompressionReplaySession(session, sessions, sessionById, sessionIndex)) {
      filtered.push(...sessionMessages.filter(message => (
        !isReplayPrefixMessage(message) || !prior.has(visibleMessageReplayKey(message))
      )))
    } else {
      filtered.push(...sessionMessages)
    }
    for (const message of sessionMessages) {
      prior.add(visibleMessageReplayKey(message))
    }
  }

  return filtered
}

function loadVisibleMessagesForSessions(db: { prepare: (sql: string) => { all: (...params: any[]) => Array<Record<string, unknown>> } }, sessions: ConversationSessionRow[]): ConversationMessage[] {
  if (!sessions.length) return []
  const ids = sessions.map(session => session.id)
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT id, session_id, role, content, tool_call_id, tool_calls, tool_name,
      timestamp, token_count, finish_reason, reasoning, reasoning_content
    FROM messages
    WHERE session_id IN (${placeholders})
      AND role IN ('user', 'assistant', 'tool')
      AND (
        role = 'tool'
        OR (content IS NOT NULL AND content != '')
        OR (role = 'assistant' AND tool_calls IS NOT NULL AND tool_calls != '')
      )
    ORDER BY timestamp, id
  `).all(...ids)
  return normalizeVisibleMessagesFromRows(rows, sessions)
}

function loadVisibleMessagesForExplicitMainline(db: { prepare: (sql: string) => { all: (...params: any[]) => Array<Record<string, unknown>> } }, sessions: ConversationSessionRow[]): ConversationMessage[] {
  const messages: ConversationMessage[] = []
  const sessionById = new Map(sessions.map(session => [session.id, session]))
  const sessionIndex = new Map(sessions.map((session, index) => [session.id, index]))
  for (const session of sessions) {
    const rows = db.prepare(`
      SELECT id, session_id, role, content, tool_call_id, tool_calls, tool_name,
        timestamp, token_count, finish_reason, reasoning, reasoning_content
      FROM messages
      WHERE session_id = ?
        AND role IN ('user', 'assistant', 'tool')
        AND (
          role = 'tool'
          OR (content IS NOT NULL AND content != '')
          OR (role = 'assistant' AND tool_calls IS NOT NULL AND tool_calls != '')
        )
      ORDER BY id
    `).all(session.id)
    for (const row of rows) {
      const message = normalizeDetailMessage(row, session.last_active || session.started_at || 0)
      if (message) messages.push(message)
    }
  }
  return filterCompressionReplayPrefixMessagesPreservingOrder(
    filterExplicitMainlineReplayPrefixMessages(messages, sessions, sessionById, sessionIndex),
    sessions,
    sessionById,
    sessionIndex,
  )
}

function isUiEventMessageId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith('ui.')
}

function visibleMessageMatchesAnchor(message: ConversationMessage, sessionId: string | null, messageId: string | null): boolean {
  if (!sessionId || !messageId) return false
  return message.session_id === sessionId && String(message.id) === messageId
}

function segmentEndIndex(messages: ConversationMessage[], sessionId: string | null): number {
  if (!sessionId) return messages.length
  let lastIndex = -1
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].session_id === sessionId) lastIndex = i
  }
  return lastIndex >= 0 ? lastIndex + 1 : messages.length
}

function insertSteerUiEvents(
  messages: ConversationMessage[],
  events: ConversationUiEventRow[],
  conversationId: string,
): ConversationMessage[] {
  const steerEvents = events
    .filter(event => event.event_type === 'steer' && event.content)
    .sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at - b.created_at
      return a.event_id.localeCompare(b.event_id)
    })
  if (!steerEvents.length) return messages

  const result = [...messages]
  const insertedEventIds = new Set<string>()
  for (const event of steerEvents) {
    if (insertedEventIds.has(event.event_id)) continue
    if (result.some(message => String(message.id) === `ui.steer.${event.event_id}`)) continue

    const anchorSessionId = event.anchor_session_id || event.source_session_id
    let insertIndex = -1
    if (event.anchor_after_message_id) {
      const anchorIndex = result.findIndex(message => visibleMessageMatchesAnchor(message, anchorSessionId, event.anchor_after_message_id))
      if (anchorIndex >= 0) insertIndex = anchorIndex + 1
    }
    if (insertIndex < 0 && event.anchor_message_id) {
      const anchorIndex = result.findIndex(message => visibleMessageMatchesAnchor(message, anchorSessionId, event.anchor_message_id))
      if (anchorIndex >= 0) insertIndex = anchorIndex + 1
    }
    if (insertIndex < 0) {
      const sourceTail = segmentEndIndex(result, event.source_session_id)
      insertIndex = sourceTail < result.length
        ? sourceTail
        : segmentEndIndex(result, event.anchor_session_id)
    }

    while (insertIndex < result.length && isUiEventMessageId(result[insertIndex]?.id)) {
      insertIndex += 1
    }
    result.splice(insertIndex, 0, {
      id: `ui.steer.${event.event_id}`,
      session_id: event.source_session_id || conversationId,
      role: 'user',
      content: event.content || '',
      timestamp: Number(event.created_at || 0) * 1000,
      steered: true,
      ui_event_id: event.event_id,
    } as ConversationMessage)
    insertedEventIds.add(event.event_id)
  }
  return result
}

function logExplicitGraphSkip(reason: string, detail: Record<string, unknown> = {}) {
  if (!shouldTraceConversationAggregation()) return
  logger.info({ reason, ...detail }, '[conversations-db] explicit lineage graph skipped')
}

function activeExplicitEdgesForConversation(edges: ConversationSessionEdgeRow[], conversationId: string): ConversationSessionEdgeRow[] {
  return edges.filter(edge => (
    edge.conversation_id === conversationId
    && edge.confidence === 'explicit'
    && edge.superseded_at == null
  ))
}

function buildExplicitConversationGraph(
  thread: ConversationThreadRow,
  edges: ConversationSessionEdgeRow[],
  byId: Map<string, ConversationSessionRow>,
  canonicalFacts: CanonicalGraphFacts = {
    parentEvidence: new Map(),
    childrenByParent: new Map(),
    sessionLineage: [],
  },
): ExplicitConversationGraph | null {
  const conversationEdges = activeExplicitEdgesForConversation(edges, thread.conversation_id)
  if (!conversationEdges.length) {
    logExplicitGraphSkip('no-active-explicit-edges', { conversationId: thread.conversation_id })
    return null
  }

  const root = byId.get(thread.root_session_id)
  if (!root || root.source === 'tool') {
    logExplicitGraphSkip('missing-root-session', { conversationId: thread.conversation_id, rootSessionId: thread.root_session_id })
    return null
  }

  const rootEdges = conversationEdges.filter(edge => edge.edge_type === 'root')
  if (!rootEdges.length || rootEdges.some(edge => edge.child_session_id !== thread.root_session_id || edge.parent_session_id != null)) {
    logExplicitGraphSkip('invalid-root-edge', {
      conversationId: thread.conversation_id,
      rootSessionId: thread.root_session_id,
      rootEdges: rootEdges.map(edge => ({ child: edge.child_session_id, parent: edge.parent_session_id })),
    })
    return null
  }

  const byChildParent = new Map<string, string>()
  const nonRootParentByChild = new Map<string, string>()
  const continuesKindByChild = new Map<string, ParentEvidenceKind>()
  const continuesByParent = new Map<string, ConversationSessionEdgeRow[]>()
  const edgeSessionIds = new Set<string>([thread.root_session_id])

  for (const edge of conversationEdges) {
    const child = byId.get(edge.child_session_id)
    if (!child || child.source === 'tool') {
      logExplicitGraphSkip('missing-child-session', { conversationId: thread.conversation_id, childSessionId: edge.child_session_id })
      return null
    }
    edgeSessionIds.add(child.id)

    if (edge.edge_type === 'root') continue
    const parentId = edge.parent_session_id
    if (!parentId) {
      logExplicitGraphSkip('missing-parent-id', { conversationId: thread.conversation_id, childSessionId: edge.child_session_id, edgeType: edge.edge_type })
      return null
    }
    const edgeParent = byId.get(parentId)
    if (!edgeParent || edgeParent.source === 'tool') {
      logExplicitGraphSkip('missing-parent-session', { conversationId: thread.conversation_id, childSessionId: edge.child_session_id, parentSessionId: parentId })
      return null
    }
    const canonicalEvidence = canonicalFacts.parentEvidence.get(child.id)
    const canonicalParent = canonicalEvidence ? byId.get(canonicalEvidence.parentId) : null
    const parent = canonicalParent && canonicalParent.source !== 'tool' && canonicalParent.id !== child.id
      ? canonicalParent
      : edgeParent
    const existingNonRootParent = nonRootParentByChild.get(child.id)
    if (existingNonRootParent && existingNonRootParent !== parent.id) {
      logExplicitGraphSkip('multiple-active-parents', { conversationId: thread.conversation_id, childSessionId: child.id, parents: [existingNonRootParent, parent.id] })
      return null
    }
    nonRootParentByChild.set(child.id, parent.id)
    edgeSessionIds.add(parent.id)
    if (edge.edge_type === 'continues' && parent.source !== child.source) {
      logExplicitGraphSkip('source-mismatch', {
        conversationId: thread.conversation_id,
        parentSessionId: parent.id,
        parentSource: parent.source,
        childSessionId: child.id,
        childSource: child.source,
      })
      return null
    }

    if (edge.edge_type === 'continues') {
      const existingParent = byChildParent.get(child.id)
      if (existingParent && existingParent !== parent.id) {
        logExplicitGraphSkip('multiple-active-parents', { conversationId: thread.conversation_id, childSessionId: child.id, parents: [existingParent, parent.id] })
        return null
      }
      byChildParent.set(child.id, parent.id)
      continuesKindByChild.set(child.id, canonicalParent ? (canonicalEvidence?.kind || 'explicit_bridge_link') : 'explicit_bridge_link')
      const siblings = continuesByParent.get(parent.id) || []
      siblings.push(edge)
      continuesByParent.set(parent.id, siblings)
      if (siblings.length > 1) {
        logExplicitGraphSkip('multiple-active-continues-children', {
          conversationId: thread.conversation_id,
          parentSessionId: parent.id,
          children: siblings.map(sibling => sibling.child_session_id),
        })
        return null
      }
    }
  }

  const mainline: ConversationSessionRow[] = []
  const continuationEdges: ConversationContinuationEdge[] = []
  const seen = new Set<string>()
  let current: ConversationSessionRow | undefined = root
  while (current) {
    if (seen.has(current.id)) {
      logExplicitGraphSkip('cycle', { conversationId: thread.conversation_id, sessionId: current.id })
      return null
    }
    seen.add(current.id)
    mainline.push(current)
    const nextEdge = continuesByParent.get(current.id)?.[0]
    if (!nextEdge) break
    const child = byId.get(nextEdge.child_session_id)
    if (!child) {
      logExplicitGraphSkip('missing-next-session', { conversationId: thread.conversation_id, childSessionId: nextEdge.child_session_id })
      return null
    }
    continuationEdges.push({
      child_session_id: child.id,
      parent_session_id: current.id,
      kind: continuesKindByChild.get(child.id) || 'explicit_bridge_link',
    })
    current = child
  }

  const explicitSessionIds = new Set(edgeSessionIds)
  const explicitMainlineIds = new Set(mainline.map(session => session.id))
  const canonicalMainline = [...mainline]
  let appendedCanonicalChild = true
  while (appendedCanonicalChild) {
    appendedCanonicalChild = false
    const canonicalIds = new Set(canonicalMainline.map(session => session.id))
    const nextChildren = sessionsByStartedAt(byId)
      .filter(session => !canonicalIds.has(session.id))
      .filter(session => !isAgentLikeBranchSession(session, byId))
      .filter(session => {
        const evidence = effectiveParentEvidence(session, canonicalFacts.parentEvidence, byId, canonicalFacts.childrenByParent)
        const parent = evidence ? byId.get(evidence.parentId) : null
        const nativeParent = session.parent_session_id ? byId.get(session.parent_session_id) : null
        if (
          nativeParent
          && canonicalIds.has(nativeParent.id)
          && (
            isExplicitRootEmptyCompressionPivotLink(nativeParent, session, byId, canonicalFacts.childrenByParent, canonicalFacts.sessionLineage)
            || isExplicitBoundaryEmptyCompressionPivotLink(nativeParent, session, byId, canonicalFacts.childrenByParent)
          )
        ) return true
        return !!evidence
          && canonicalIds.has(evidence.parentId)
          && (
            explicitSessionIds.has(session.id)
            || evidence.kind === 'native_parent'
            || (!!parent && isExplicitRootEmptyCompressionPivotLink(parent, session, byId, canonicalFacts.childrenByParent, canonicalFacts.sessionLineage))
          )
      })
      .sort((left, right) => {
        if (left.started_at !== right.started_at) return left.started_at - right.started_at
        return left.id.localeCompare(right.id)
      })
    if (nextChildren.length !== 1) continue
    const child = nextChildren[0]
    const nativeParent = child.parent_session_id ? byId.get(child.parent_session_id) : null
    const evidence = nativeParent
      && canonicalIds.has(nativeParent.id)
      && (
        isExplicitRootEmptyCompressionPivotLink(nativeParent, child, byId, canonicalFacts.childrenByParent, canonicalFacts.sessionLineage)
        || isExplicitBoundaryEmptyCompressionPivotLink(nativeParent, child, byId, canonicalFacts.childrenByParent)
      )
      ? { parentId: nativeParent.id, kind: 'native_parent' as ParentEvidenceKind }
      : effectiveParentEvidence(child, canonicalFacts.parentEvidence, byId, canonicalFacts.childrenByParent)
    if (!evidence) continue
    canonicalMainline.push(child)
    continuationEdges.push({
      child_session_id: child.id,
      parent_session_id: evidence.parentId,
      kind: evidence.kind,
    })
    appendedCanonicalChild = true
  }

  const mainlineIds = new Set(canonicalMainline.map(session => session.id))
  for (const [childId] of byChildParent) {
    if (!mainlineIds.has(childId)) {
      logExplicitGraphSkip('continues-edge-outside-mainline', { conversationId: thread.conversation_id, childSessionId: childId })
      return null
    }
  }

  return {
    conversationId: thread.conversation_id,
    rootSessionId: thread.root_session_id,
    mainline: canonicalMainline,
    branchEdges: conversationEdges.filter(edge => (
      (edge.edge_type === 'branches' || edge.edge_type === 'subagent')
      && !mainlineIds.has(edge.child_session_id)
    )),
    continuationEdges,
  }
}

function buildExplicitConversationGraphs(
  threads: ConversationThreadRow[],
  edges: ConversationSessionEdgeRow[],
  byId: Map<string, ConversationSessionRow>,
  canonicalFacts?: CanonicalGraphFacts,
): ExplicitConversationGraph[] {
  return threads
    .map(thread => buildExplicitConversationGraph(thread, edges, byId, canonicalFacts))
    .filter((graph): graph is ExplicitConversationGraph => !!graph)
}

function listExplicitLineageFactsFromDb(
  db: { prepare: (sql: string) => { all: (...params: any[]) => Array<Record<string, unknown>> } },
): ExplicitLineageFacts {
  const threads = listConversationThreadsReadOnly(db as any)
  const edges = listActiveExplicitConversationSessionEdges(db as any)
  return {
    threads,
    edges,
    sessionLineage: [],
  }
}

function mergeExplicitLineageFacts(...factsList: ExplicitLineageFacts[]): ExplicitLineageFacts {
  const threads = new Map<string, ConversationThreadRow>()
  const edges = new Map<string, ConversationSessionEdgeRow>()
  const sessionLineage = new Map<string, SessionLineageRow>()

  for (const facts of factsList) {
    for (const thread of facts.threads) threads.set(thread.conversation_id, thread)
    for (const edge of facts.edges) edges.set(edge.edge_id, edge)
    for (const row of facts.sessionLineage) sessionLineage.set(row.session_id, row)
  }

  return {
    threads: [...threads.values()].sort((left, right) => {
      if (right.updated_at !== left.updated_at) return right.updated_at - left.updated_at
      return left.conversation_id.localeCompare(right.conversation_id)
    }),
    edges: [...edges.values()].sort((left, right) => {
      if (left.conversation_id !== right.conversation_id) return left.conversation_id.localeCompare(right.conversation_id)
      if (left.created_at !== right.created_at) return left.created_at - right.created_at
      return left.edge_id.localeCompare(right.edge_id)
    }),
    sessionLineage: [...sessionLineage.values()].sort((left, right) => {
      if (right.updated_at !== left.updated_at) return right.updated_at - left.updated_at
      if (right.created_at !== left.created_at) return right.created_at - left.created_at
      return right.session_id.localeCompare(left.session_id)
    }),
  }
}

function loadExplicitLineageFacts(
  hermesDb: { prepare: (sql: string) => { all: (...params: any[]) => Array<Record<string, unknown>> } },
): ExplicitLineageFacts {
  const webuiDb = getDb()
  const webuiFacts = webuiDb && webuiDb !== hermesDb
    ? listExplicitLineageFactsFromDb(webuiDb)
    : { threads: [], edges: [], sessionLineage: [] }
  return mergeExplicitLineageFacts(
    listExplicitLineageFactsFromDb(hermesDb),
    {
      ...webuiFacts,
      sessionLineage: listSessionLineage(),
    },
  )
}

function synthesizeConversationThreadsFromSessionLineage(
  lineageRows: SessionLineageRow[],
  byId: Map<string, ConversationSessionRow>,
): ConversationThreadRow[] {
  const byConversationId = new Map<string, ConversationThreadRow>()
  for (const row of lineageRows) {
    if (row.authority !== 'explicit') continue
    const conversationId = (row.logical_conversation_id || row.root_session_id || row.session_id || '').trim()
    if (!conversationId || byConversationId.has(conversationId)) continue
    const rootId = [
      row.root_session_id,
      row.logical_conversation_id,
      ...sessionLineageAliases(row),
    ]
      .map(value => (value || '').trim())
      .find(value => !!value && !!byId.get(value))
    if (!rootId) continue
    byConversationId.set(conversationId, {
      conversation_id: conversationId,
      root_session_id: rootId,
      title: null,
      status: 'active',
      created_at: row.created_at,
      updated_at: row.updated_at,
      schema_version: 1,
    })
  }
  return [...byConversationId.values()]
}

function synthesizeConversationEdgesFromSessionLineage(
  lineageRows: SessionLineageRow[],
  byId: Map<string, ConversationSessionRow>,
): ConversationSessionEdgeRow[] {
  const edges = new Map<string, ConversationSessionEdgeRow>()
  const addEdge = (
    conversationId: string,
    childSessionId: string,
    parentSessionId: string | null,
    edgeType: ConversationSessionEdgeRow['edge_type'],
    createdAt: number,
  ) => {
    const edgeId = `session-lineage:${conversationId}:${edgeType}:${childSessionId}`
    if (edges.has(edgeId)) return
    edges.set(edgeId, {
      edge_id: edgeId,
      conversation_id: conversationId,
      parent_session_id: parentSessionId,
      child_session_id: childSessionId,
      edge_type: edgeType,
      confidence: 'explicit',
      created_by: 'migration',
      created_at: createdAt,
      superseded_at: null,
    })
  }

  for (const row of lineageRows) {
    if (row.authority !== 'explicit') continue
    const conversationId = (row.logical_conversation_id || row.root_session_id || row.session_id || '').trim()
    if (!conversationId) continue
    const childId = sessionLineageAliases(row).find(id => !!byId.get(id))
    if (!childId) continue
    if (row.relation_kind === 'root' || childId === row.root_session_id || childId === row.logical_conversation_id) {
      addEdge(conversationId, childId, null, 'root', row.created_at)
      continue
    }
    if (row.relation_kind !== 'continuation' && row.relation_kind !== 'wrapper') continue
    const parentId = [row.parent_session_id, row.root_session_id, row.logical_conversation_id]
      .map(value => (value || '').trim())
      .find(value => !!value && value !== childId && !!byId.get(value))
    if (!parentId) continue
    addEdge(conversationId, childId, parentId, 'continues', row.created_at)
  }

  return [...edges.values()]
}

function synthesizeConversationThreadsFromBridgeLinks(
  byId: Map<string, ConversationSessionRow>,
  canonicalParentEvidence: Map<string, ParentEvidence>,
): ConversationThreadRow[] {
  const links = readBridgeContinuationLinks()
  const threads = new Map<string, ConversationThreadRow>()
  for (const [childId, parentId] of Object.entries(links)) {
    const child = byId.get(childId)
    const parent = byId.get(parentId)
    if (!child || !parent || child.source === 'tool' || parent.source === 'tool') continue
    const edgeParent = bridgeLinkCanonicalParent(parent, child, byId, canonicalParentEvidence)
    if (!edgeParent) continue
    const rootId = rootSessionIdForBridgeLinkBoundary(parent, byId)
    if (!rootId || threads.has(rootId)) continue
    const root = byId.get(rootId)
    if (!root || root.source === 'tool') continue
    threads.set(rootId, {
      conversation_id: rootId,
      root_session_id: rootId,
      title: null,
      status: 'active',
      created_at: Number(root.started_at || parent.started_at || child.started_at || 0),
      updated_at: Math.max(Number(root.last_active || 0), Number(parent.last_active || 0), Number(child.last_active || 0)),
      schema_version: 1,
    })
  }
  return [...threads.values()]
}

function rootSessionIdForBridgeLinkBoundary(
  session: ConversationSessionRow,
  byId: Map<string, ConversationSessionRow>,
): string | null {
  let current: ConversationSessionRow | undefined = session
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    const parent: ConversationSessionRow | null = current.parent_session_id ? (byId.get(current.parent_session_id) || null) : null
    if (!parent || parent.source !== current.source || parent.source === 'tool') return current.id
    current = parent
  }
  return current?.id || session.id
}

function synthesizeConversationEdgesFromBridgeLinks(
  byId: Map<string, ConversationSessionRow>,
  canonicalParentEvidence: Map<string, ParentEvidence>,
): ConversationSessionEdgeRow[] {
  const links = readBridgeContinuationLinks()
  const edges = new Map<string, ConversationSessionEdgeRow>()
  const addEdge = (
    conversationId: string,
    childSessionId: string,
    parentSessionId: string | null,
    edgeType: ConversationSessionEdgeRow['edge_type'],
    createdAt: number,
  ) => {
    const edgeId = `bridge-link:${conversationId}:${edgeType}:${childSessionId}`
    if (edges.has(edgeId)) return
    edges.set(edgeId, {
      edge_id: edgeId,
      conversation_id: conversationId,
      parent_session_id: parentSessionId,
      child_session_id: childSessionId,
      edge_type: edgeType,
      confidence: 'explicit',
      created_by: 'migration',
      created_at: createdAt,
      superseded_at: null,
    })
  }

  for (const [childId, parentId] of Object.entries(links)) {
    const child = byId.get(childId)
    const parent = byId.get(parentId)
    if (!child || !parent || child.source === 'tool' || parent.source === 'tool') continue
    const canonicalParent = bridgeLinkCanonicalParent(parent, child, byId, canonicalParentEvidence)
    if (!canonicalParent) continue
    const rootId = rootSessionIdForBridgeLinkBoundary(parent, byId)
    if (!rootId || !byId.get(rootId)) continue
    addEdge(rootId, rootId, null, 'root', Number(byId.get(rootId)?.started_at || 0))
    addEdge(rootId, child.id, canonicalParent.id, 'continues', Number(child.started_at || 0))
  }

  return [...edges.values()]
}

function bridgeLinkCanonicalParent(
  linkedParent: ConversationSessionRow,
  child: ConversationSessionRow,
  byId: Map<string, ConversationSessionRow>,
  canonicalParentEvidence: Map<string, ParentEvidence>,
): ConversationSessionRow | null {
  const evidence = canonicalParentEvidence.get(child.id)
  const evidenceParent = evidence ? byId.get(evidence.parentId) : null
  if (evidenceParent && evidenceParent.source !== 'tool') return evidenceParent

  if (!isOutputEmptyCompressionSession(linkedParent)) return null
  if (!isBridgeContextPrompt(child.raw_preview || child.preview || child.title)) return null
  const nativeChildren = [...byId.values()]
    .filter(session => session.parent_session_id === linkedParent.id)
    .filter(session => session.source === linkedParent.source && session.source !== 'tool')
    .filter(session => hasConversationContent(session))
    .filter(session => !isAgentLikeBranchSession(session, byId))
  if (nativeChildren.length !== 1) return null
  const nativeChild = nativeChildren[0]
  if (contextReferencesParent(nativeChild, child)) return nativeChild
  if (Number(child.started_at || 0) >= Number(nativeChild.started_at || 0)) return nativeChild
  return null
}

function augmentExplicitLineageFacts(
  facts: ExplicitLineageFacts,
  byId: Map<string, ConversationSessionRow>,
  canonicalParentEvidence: Map<string, ParentEvidence> = new Map(),
): ExplicitLineageFacts {
  return mergeExplicitLineageFacts(facts, {
    threads: synthesizeConversationThreadsFromSessionLineage(facts.sessionLineage, byId),
    edges: synthesizeConversationEdgesFromSessionLineage(facts.sessionLineage, byId),
    sessionLineage: facts.sessionLineage,
  }, {
    threads: synthesizeConversationThreadsFromBridgeLinks(byId, canonicalParentEvidence),
    edges: synthesizeConversationEdgesFromBridgeLinks(byId, canonicalParentEvidence),
    sessionLineage: [],
  })
}

function explicitFactSessionIds(facts: ExplicitLineageFacts): Set<string> {
  const ids = new Set<string>()
  for (const thread of facts.threads) {
    if (thread.root_session_id) ids.add(thread.root_session_id)
  }
  for (const edge of facts.edges) {
    if (edge.parent_session_id) ids.add(edge.parent_session_id)
    if (edge.child_session_id) ids.add(edge.child_session_id)
  }
  return ids
}

function explicitGraphForSession(
  sessionId: string,
  graphs: ExplicitConversationGraph[],
): ExplicitConversationGraph | null {
  return graphs.find(graph => (
    graph.mainline.some(session => session.id === sessionId)
    || graph.branchEdges.some(edge => edge.child_session_id === sessionId)
  )) || null
}

function buildExplicitChildrenByParent(graph: ExplicitConversationGraph): Map<string | null, string[]> {
  const children = new Map<string | null, string[]>()
  for (const edge of graph.continuationEdges) {
    const siblings = children.get(edge.parent_session_id) || []
    siblings.push(edge.child_session_id)
    children.set(edge.parent_session_id, siblings)
  }
  for (const edge of graph.branchEdges) {
    const parentId = edge.parent_session_id ?? graph.rootSessionId
    const siblings = children.get(parentId) || []
    if (!siblings.includes(edge.child_session_id)) siblings.push(edge.child_session_id)
    children.set(parentId, siblings)
  }
  return children
}

function buildDirectChildrenByParent(sessions: ConversationSessionRow[]): Map<string | null, string[]> {
  const children = new Map<string | null, string[]>()
  for (const session of sessions) {
    const key = session.parent_session_id ?? null
    const siblings = children.get(key) || []
    siblings.push(session.id)
    children.set(key, siblings)
  }
  return children
}

function explicitSummaryForGraph(
  graph: ExplicitConversationGraph,
  db: { prepare: (sql: string) => { all: (...params: any[]) => Array<Record<string, unknown>> } },
  byId: Map<string, ConversationSessionRow>,
): ConversationSummary | null {
  if (!graph.mainline.length) return null
  const messages = loadVisibleMessagesForExplicitMainline(db, graph.mainline)
  if (!messages.length && !graph.branchEdges.length && !graph.mainline.some(session => session.is_live_tui_process || Number(session.tool_call_count || 0) > 0)) return null
  const childrenByParent = buildExplicitChildrenByParent(graph)
  const branches = graph.branchEdges
    .map(edge => byId.get(edge.child_session_id))
    .filter((root): root is ConversationSessionRow => !!root)
    .map(root => buildSubagentBranchTree(db, root, byId, childrenByParent))
    .filter((branch): branch is ConversationBranch => !!branch)
  return aggregateSummary(graph.rootSessionId, byId, childrenByParent, countBranches(branches), new Map(), graph.mainline)
}

function explicitDetailForGraph(
  requestedSessionId: string,
  graph: ExplicitConversationGraph,
  db: { prepare: (sql: string) => { all: (...params: any[]) => Array<Record<string, unknown>> } },
  byId: Map<string, ConversationSessionRow>,
): ConversationDetail | null {
  const rawMessages = loadVisibleMessagesForExplicitMainline(db, graph.mainline)
  const messages = insertSteerUiEvents(
    rawMessages,
    listConversationUiEventsReadOnly(db as any, graph.conversationId),
    graph.conversationId,
  )
  const childrenByParent = buildExplicitChildrenByParent(graph)
  const branches = graph.branchEdges
    .map(edge => byId.get(edge.child_session_id))
    .filter((root): root is ConversationSessionRow => !!root)
    .map(root => buildSubagentBranchTree(db, root, byId, childrenByParent))
    .filter((branch): branch is ConversationBranch => !!branch)
  if (!messages.length && !branches.length && !graph.mainline.some(session => session.is_live_tui_process || Number(session.tool_call_count || 0) > 0)) return null
  return {
    session_id: requestedSessionId,
    title: conversationTitleForChain(graph.mainline),
    messages,
    visible_count: messages.length,
    thread_session_count: graph.mainline.length,
    branch_session_count: countBranches(branches),
    branches,
    continuation_edges: graph.continuationEdges,
  }
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
      if (child && isRealConversationBranch(child, byId)) roots.push(child)
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
    const childBranches = collectConversationBranches(db, branchChain, byId, childrenByParent, seen)
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
      branches: childBranches,
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
      COALESCE(s.billing_base_url, '') AS billing_base_url,
      COALESCE(s.estimated_cost_usd, 0) AS estimated_cost_usd,
      s.actual_cost_usd AS actual_cost_usd,
      COALESCE(s.cost_status, '') AS cost_status,
      COALESCE(
        (
          SELECT REPLACE(REPLACE(m.content, CHAR(10), ' '), CHAR(13), ' ')
          FROM messages m
          WHERE m.session_id = s.id
            AND ${VISIBLE_HUMAN_MESSAGE_SQL}
          ORDER BY m.timestamp, m.id
          LIMIT 1
        ),
        ''
      ) AS raw_preview,
      COALESCE(
        (
          SELECT REPLACE(REPLACE(m.content, CHAR(10), ' '), CHAR(13), ' ')
          FROM messages m
          WHERE m.session_id = s.id
            AND ${VISIBLE_HUMAN_MESSAGE_SQL}
          ORDER BY m.timestamp DESC, m.id DESC
          LIMIT 1
        ),
        ''
      ) AS raw_context_anchor,
      COALESCE(
        (
          SELECT GROUP_CONCAT(role || ': ' || REPLACE(REPLACE(content, CHAR(10), ' '), CHAR(13), ' '), CHAR(10))
          FROM (
            SELECT m.role AS role, m.content AS content
            FROM messages m
            WHERE m.session_id = s.id
              AND ${VISIBLE_HUMAN_MESSAGE_SQL}
            ORDER BY m.timestamp, m.id
          )
        ),
        ''
      ) AS raw_visible_history,
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
    linkParentlessEmptyCompressionPivots(sessions, listSessionLineage())
    linkOrphanBridgeContextRootContinuations(sessions)
    linkOrphanBridgeContextBranchContinuations(sessions)
    if (shouldTraceConversationAggregation()) {
      logger.info({
        source: source || 'all',
        includeTool,
        rowCount: rows.length,
        sessionCount: sessions.length,
        liveTuiCount: liveTuiSessionKeys.size,
        sampleIds: sessions.slice(0, 20).map(session => session.id),
      }, '[conversations-db] load-conversation-sessions')
    }
    if (source && source !== 'tui') return sessions

    const knownIds = new Set(sessions.map(session => session.id))
    for (const sessionKey of liveTuiSessionKeys) {
      if (!knownIds.has(sessionKey)) {
        sessions.push(createLiveTuiPlaceholderSession(sessionKey, nowSeconds))
        if (shouldTraceConversationAggregation() || shouldTraceContinuationSession(sessionKey)) {
          logger.info({ sessionKey }, '[conversations-db] add-live-tui-placeholder')
        }
      }
    }
    return sessions
  } finally {
    db.close()
  }
}

async function loadRawConversationSessions(source?: string, includeTool = false): Promise<ConversationSessionRow[]> {
  const liveTuiSessionKeys = await listLiveTuiSessionKeys()
  const db = await openConversationDb()
  try {
    const { sql, params } = buildConversationSessionSql(source, includeTool)
    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
    const nowSeconds = Date.now() / 1000
    const sessions = rows.map(row => mapSessionRow(row, nowSeconds, liveTuiSessionKeys))
    if (source && source !== 'tui') return sessions

    const knownIds = new Set(sessions.map(session => session.id))
    for (const sessionKey of liveTuiSessionKeys) {
      if (!knownIds.has(sessionKey)) sessions.push(createLiveTuiPlaceholderSession(sessionKey, nowSeconds))
    }
    return sessions
  } finally {
    db.close()
  }
}

export async function listConversationSummariesFromDb(options: ConversationListOptions = {}): Promise<ConversationSummary[]> {
  const startedAt = Date.now()
  const humanOnly = options.humanOnly !== false
  const limit = options.limit && options.limit > 0 ? options.limit : DEFAULT_CONVERSATION_LIMIT
  let explicitSummaries: ConversationSummary[] = []
  let explicitSessionIds = new Set<string>()
  const sessions = await loadConversationSessions(options.source)
  traceAggregationTiming('loaded-sessions', startedAt, { sessionCount: sessions.length })
  const byId = new Map(sessions.map(session => [session.id, session]))
  let explicitFacts: ExplicitLineageFacts = { threads: [], edges: [], sessionLineage: [] }
  if (humanOnly) {
    const db = await openConversationDb()
    try {
      explicitFacts = augmentExplicitLineageFacts(loadExplicitLineageFacts(db), byId)
      explicitSessionIds = explicitFactSessionIds(explicitFacts)
    } finally {
      db.close()
    }
  }
  const parentEvidence = buildParentEvidenceMap(sessions, explicitSessionIds)
  traceAggregationTiming('built-parent-evidence', startedAt, {
    parentEvidenceCount: parentEvidence.size,
    explicitBridgeLinkCount: [...parentEvidence.values()].filter(evidence => evidence.kind === 'explicit_bridge_link').length,
    fallbackInferenceCount: [...parentEvidence.values()].filter(evidence => evidence.kind === 'fallback_inference').length,
  })
  const inferredChildren = buildInferredBridgeContextChildrenMap(parentEvidence)
  const directChildrenByParent = buildDirectChildrenByParent(sessions)
  const childrenByParent = mergeChildrenByParent(directChildrenByParent, inferredChildren)
  const rootMemo = new Map<string, string | null>()
  const mainlineByRoot = buildMainlineByRoot(sessions, byId, childrenByParent, parentEvidence, inferredChildren)
  traceAggregationTiming('built-mainlines', startedAt, { rootCount: mainlineByRoot.size })

  if (!humanOnly) {
    return sortByRecency(sessions.map(toSummary)).slice(0, limit)
  }

  const canonicalExplicitFacts = augmentExplicitLineageFacts(explicitFacts, byId, parentEvidence)
  const db = await openConversationDb()
  try {
    const graphs = buildExplicitConversationGraphs(
      canonicalExplicitFacts.threads,
      canonicalExplicitFacts.edges,
      byId,
      {
        parentEvidence,
        childrenByParent,
        sessionLineage: explicitFacts.sessionLineage,
      },
    )
    explicitSessionIds = new Set(graphs.flatMap(graph => [
      ...graph.mainline.map(session => session.id),
      ...graph.branchEdges.map(edge => edge.child_session_id),
    ]))
    explicitSummaries = graphs
      .map(graph => explicitSummaryForGraph(graph, db, byId))
      .filter((summary): summary is ConversationSummary => !!summary)

    const rootIds = sessions
      .filter(session => session.source !== 'tool')
      .filter(session => !explicitSessionIds.has(session.id))
      .filter(session => !isSubagentSession(session))
      .filter(session => !shouldSuppressBridgePromptTopLevelConversation(session, parentEvidence))
      .filter(session => isVisibleConversationStart(session, byId, childrenByParent, parentEvidence, inferredChildren))
      .map(session => rootConversationIdForSession(session.id, byId, parentEvidence, childrenByParent, rootMemo))
      .filter((id): id is string => !!id)
    const uniqueRootIds = [...new Set(rootIds)]
    traceAggregationTiming('built-root-ids', startedAt, { uniqueRootCount: uniqueRootIds.length })
    const summaries = uniqueRootIds
      .map(rootId => {
        const mainline = mainlineByRoot.get(rootId) || []
        if (mainline.some(session => explicitSessionIds.has(session.id))) return null
        if (!mainline.length) return null
        const mainlineIds = new Set(mainline.map(session => session.id))
        const subagentRoots = collectSubagentBranchRoots(mainlineIds, byId, childrenByParent, inferredChildren)
        const branches = subagentRoots
          .map(root => buildSubagentBranchTree(db, root, byId, childrenByParent, inferredChildren))
          .filter((branch): branch is ConversationBranch => !!branch)
        return aggregateSummary(rootId, byId, childrenByParent, countBranches(branches), parentEvidence, mainline)
      })
      .filter((summary): summary is ConversationSummary => !!summary)
    traceAggregationTiming('built-summaries', startedAt, { summaryCount: summaries.length })

    return sortByRecency([...explicitSummaries, ...summaries]).slice(0, limit)
  } finally {
    db.close()
  }
}

export async function getConversationDetailFromDb(sessionId: string, options: ConversationListOptions = {}): Promise<ConversationDetail | null> {
  const humanOnly = options.humanOnly !== false
  let protectedExplicitSessionIds = new Set<string>()
  const sessions = await loadConversationSessions(options.source, true)
  const byId = new Map(sessions.map(session => [session.id, session]))
  let explicitFacts: ExplicitLineageFacts = { threads: [], edges: [], sessionLineage: [] }
  if (humanOnly) {
    const db = await openConversationDb()
    try {
      explicitFacts = augmentExplicitLineageFacts(loadExplicitLineageFacts(db), byId)
      protectedExplicitSessionIds = explicitFactSessionIds(explicitFacts)
    } finally {
      db.close()
    }
  }
  const parentEvidence = buildParentEvidenceMap(sessions, protectedExplicitSessionIds)
  const inferredChildren = buildInferredBridgeContextChildrenMap(parentEvidence)
  const directChildrenByParent = buildDirectChildrenByParent(sessions)
  const childrenByParent = mergeChildrenByParent(directChildrenByParent, inferredChildren)
  const rootMemo = new Map<string, string | null>()

  if (humanOnly) {
    const canonicalExplicitFacts = augmentExplicitLineageFacts(explicitFacts, byId, parentEvidence)
    const db = await openConversationDb()
    try {
      const graphs = buildExplicitConversationGraphs(
        canonicalExplicitFacts.threads,
        canonicalExplicitFacts.edges,
        byId,
        {
          parentEvidence,
          childrenByParent,
          sessionLineage: explicitFacts.sessionLineage,
        },
      )
      const graph = explicitGraphForSession(sessionId, graphs)
      if (graph) return explicitDetailForGraph(sessionId, graph, db, byId)
      protectedExplicitSessionIds = new Set(graphs.flatMap(explicitGraph => [
        ...explicitGraph.mainline.map(session => session.id),
        ...explicitGraph.branchEdges.map(edge => edge.child_session_id),
      ]))
    } finally {
      db.close()
    }
  }

  let chain: ConversationSessionRow[] = []
  if (!humanOnly) {
    const session = byId.get(sessionId)
    if (!session || session.source === 'tool') return null
    chain = [session]
  } else {
    const session = byId.get(sessionId)
    if (!session || session.source === 'tool' || isSubagentSession(session)) return null
    if (isBridgePromptOnlyContinuationStub(session)) return null
    const rootId = rootConversationIdForSession(sessionId, byId, parentEvidence, childrenByParent, rootMemo)
    if (!rootId) return null
    chain = mainlineSessionsForRoot(rootId, sessions, byId, childrenByParent, parentEvidence, inferredChildren)
  }

  if (!chain.length) return null

  const db = await openConversationDb()
  try {
    const messages = loadVisibleMessagesForSessions(db, chain)
    const branches = humanOnly
      ? collectSubagentBranchRoots(new Set(chain.map(session => session.id)), byId, childrenByParent, inferredChildren)
          .map(root => buildSubagentBranchTree(db, root, byId, childrenByParent, inferredChildren))
          .filter((branch): branch is ConversationBranch => !!branch)
      : []

    if (!messages.length) {
      if (humanOnly && !branches.length && !chain.some(session => session.is_live_tui_process || Number(session.tool_call_count || 0) > 0)) return null
      const detail: ConversationDetail = {
        session_id: sessionId,
        title: conversationTitleForChain(chain),
        messages: [],
        visible_count: 0,
        thread_session_count: chain.length,
      }
      if (humanOnly) {
        detail.branch_session_count = countBranches(branches)
        detail.branches = branches
        detail.continuation_edges = continuationEdgesForChain(chain, parentEvidence, byId, childrenByParent)
      }
      return detail
    }
    const detail: ConversationDetail = {
      session_id: sessionId,
      title: conversationTitleForChain(chain),
      messages,
      visible_count: messages.length,
      thread_session_count: chain.length,
    }
    if (humanOnly) {
      detail.branch_session_count = countBranches(branches)
      detail.branches = branches
      detail.continuation_edges = continuationEdgesForChain(chain, parentEvidence, byId, childrenByParent)
    }
    return detail
  } finally {
    db.close()
  }
}
