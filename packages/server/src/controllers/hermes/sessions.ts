import * as hermesCli from '../../services/hermes/hermes-cli'
import { listConversationSummaries, getConversationDetail } from '../../services/hermes/conversations'
import { listConversationSummariesFromDb, searchConversationSummariesFromDb, getConversationDetailFromDb } from '../../db/hermes/conversations-db'
import { getSessionDetailFromDb, listSessionSummaries, searchSessionSummaries, getUsageStatsFromDb, type HermesSessionDetailRow } from '../../db/hermes/sessions-db'
import { listSessionLineage, resolveCanonicalSessionId } from '../../db/hermes/session-lineage'
import {
  listSessions as localListSessions,
  searchSessions as localSearchSessions,
  getSessionDetail as localGetSessionDetail,
  deleteSession as localDeleteSession,
  renameSession as localRenameSession,
  useLocalSessionStore,
} from '../../db/hermes/session-store'
import { ExportCompressor } from '../../lib/context-compressor/export-compressor'
import { getGatewayManagerInstance } from '../../services/gateway-bootstrap'
import { deleteUsage, getUsage, getUsageBatch, getLocalUsageStats } from '../../db/hermes/usage-store'
import type { LocalUsageStats, UsageStatsModelRow, UsageStatsDailyRow } from '../../db/hermes/usage-store'
import { getModelContextLength } from '../../services/hermes/model-context'
import { getActiveConfigPath, getActiveProfileName } from '../../services/hermes/hermes-profile'
import { getGroupChatServer } from '../../routes/hermes/group-chat'
import { logger } from '../../services/logger'
import { tuiBridge } from '../../services/hermes/tui-bridge'
import { existsSync, readFileSync } from 'fs'
import YAML from 'js-yaml'
import type { ConversationDetail, ConversationSummary } from '../../services/hermes/conversations'

function parseBridgeFlag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}

function bridgeSessionFallbackEnabled(): boolean {
  try {
    const configPath = getActiveConfigPath()
    if (existsSync(configPath)) {
      const config = YAML.load(readFileSync(configPath, 'utf-8')) as Record<string, any> | null
      const configured = parseBridgeFlag(config?.webui?.bridge_enabled)
      if (configured !== null) return configured
    }
  } catch {}
  return parseBridgeFlag(process.env.HERMES_WEBUI_BRIDGE) === true
}

function createBridgeSessionFallback(id: string) {
  const now = Date.now() / 1000
  return {
    id,
    source: 'webui-bridge',
    user_id: null,
    model: '',
    title: null,
    preview: '',
    started_at: now,
    ended_at: null,
    end_reason: null,
    last_active: now,
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
    cost_status: 'unknown',
    messages: [],
    thread_session_count: 1,
  }
}

function createBridgeConversationFallback(id: string): ConversationDetail {
  return {
    session_id: id,
    messages: [],
    visible_count: 0,
    thread_session_count: 1,
    branch_session_count: 0,
    branches: [],
  }
}

function isBridgeContinuationWrapperOnlyDetail(session: any): boolean {
  if (!session || session.source !== 'tui') return false
  const messages = Array.isArray(session.messages) ? session.messages : []
  if (messages.length !== 1) return false
  const message = messages[0]
  const content = String(message?.content || '').trim().toLowerCase()
  return message?.role === 'user' && content.startsWith('previous conversation context:')
}

function getPendingDeletedSessionIds(): Set<string> {
  return getGroupChatServer()?.getStorage().getPendingDeletedSessionIds() || new Set<string>()
}

function filterPendingDeletedSessions<T extends { id: string }>(items: T[]): T[] {
  const pendingIds = getPendingDeletedSessionIds()
  if (pendingIds.size === 0) return items
  return items.filter(item => !pendingIds.has(item.id))
}

function filterPendingDeletedConversationSummaries(items: ConversationSummary[]): ConversationSummary[] {
  return filterPendingDeletedSessions(items)
}

function isPendingDeletedSession(sessionId: string): boolean {
  return getPendingDeletedSessionIds().has(sessionId)
}

function hasPendingDeletedConversation(detail: ConversationDetail): boolean {
  const pendingIds = getPendingDeletedSessionIds()
  if (pendingIds.size === 0) return false
  if (pendingIds.has(detail.session_id)) return true
  const hasPendingBranch = (detail.branches || []).some(branch => {
    if (pendingIds.has(branch.session_id)) return true
    return branch.messages.some(message => pendingIds.has(message.session_id))
  })
  return hasPendingBranch || detail.messages.some(message => pendingIds.has(message.session_id))
}

function hasPendingDeletedSessionDetail(session: { id: string; messages?: Array<{ session_id?: string | null }> }): boolean {
  const pendingIds = getPendingDeletedSessionIds()
  if (pendingIds.size === 0) return false
  if (pendingIds.has(session.id)) return true
  return (session.messages || []).some(message => {
    const messageSessionId = message.session_id || session.id
    return pendingIds.has(messageSessionId)
  })
}

function mergeConversationDetailIntoSession(
  session: HermesSessionDetailRow,
  detail: ConversationDetail,
): HermesSessionDetailRow & { branch_session_count?: number, branches?: ConversationDetail['branches'], represented_session_ids?: string[] } {
  return {
    ...session,
    title: detail.title ?? session.title,
    messages: detail.messages.map(message => ({
      id: message.id,
      session_id: message.session_id,
      role: message.role,
      content: message.content,
      tool_call_id: message.tool_call_id ?? null,
      tool_calls: message.tool_calls ?? null,
      tool_name: message.tool_name ?? null,
      timestamp: message.timestamp,
      token_count: message.token_count ?? null,
      finish_reason: message.finish_reason ?? null,
      reasoning: message.reasoning ?? null,
    })),
    message_count: detail.messages.length,
    thread_session_count: detail.thread_session_count,
    branch_session_count: detail.branch_session_count,
    branches: detail.branches,
    represented_session_ids: detail.represented_session_ids,
  }
}

async function getDbSessionDetailForRequest(
  lookupSessionId: string,
  requestedSessionId: string,
  canonicalSessionId: string,
): Promise<(HermesSessionDetailRow & { branch_session_count?: number, branches?: ConversationDetail['branches'] }) | null> {
  const session = await getSessionDetailFromDb(lookupSessionId)
  if (!session) {
    logger.info({
      route: 'get',
      sessionId: requestedSessionId,
      canonicalSessionId,
      lookupSessionId,
    }, '[sessions-controller] get db-null')
    return null
  }
  if (hasPendingDeletedSessionDetail(session)) {
    return session
  }
  if (isBridgeContinuationWrapperOnlyDetail(session)) {
    logger.info({
      route: 'get',
      sessionId: requestedSessionId,
      canonicalSessionId,
      lookupSessionId,
      source: session.source,
    }, '[sessions-controller] get db-wrapper-only-suppressed')
    return {
      ...createBridgeSessionFallback(requestedSessionId),
    }
  }
  if (session.source === 'tui') {
    try {
      const conversationDetail = await getConversationDetailFromDb(lookupSessionId, { humanOnly: true })
      if (conversationDetail && !hasPendingDeletedConversation(conversationDetail)) {
        const mergedSession = mergeConversationDetailIntoSession(session, conversationDetail)
        logger.info({
          sessionId: requestedSessionId,
          canonicalSessionId,
          lookupSessionId,
          source: session.source,
          rawMessageCount: Array.isArray(session.messages) ? session.messages.length : 0,
          messageCount: mergedSession.messages.length,
          rawThreadSessionCount: session.thread_session_count,
          threadSessionCount: conversationDetail.thread_session_count,
        }, '[sessions-controller] get conversation-db-hit')
        return mergedSession
      }
    } catch (err) {
      logger.warn(err, 'Hermes Conversation DB: session detail aggregation failed, falling back to raw session detail')
    }
  }
  logger.info({
    sessionId: requestedSessionId,
    canonicalSessionId,
    lookupSessionId,
    source: session.source,
    messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
  }, '[sessions-controller] get db-hit')
  return session
}

function getGroupChatStorage() {
  return getGroupChatServer()?.getStorage() || null
}

function dedupeTuiSessionsByLineage<T extends { id: string }>(
  sessions: T[],
  source = 'tui',
): T[] {
  const lineageRows = listSessionLineage(source)
  if (!lineageRows.length) return sessions
  const aliasToLogical = new Map<string, string>()
  for (const row of lineageRows) {
    const logical = resolveCanonicalSessionId(row.session_id)
      || row.root_session_id
      || row.logical_conversation_id
      || row.session_id
    aliasToLogical.set(row.session_id, logical)
    if (row.web_session_id) aliasToLogical.set(row.web_session_id, logical)
    if (row.persistent_session_id) aliasToLogical.set(row.persistent_session_id, logical)
    if (row.bridge_session_id) aliasToLogical.set(row.bridge_session_id, logical)
  }
  const deduped = new Map<string, T>()
  for (const session of sessions) {
    const key = aliasToLogical.get(session.id) || session.id
    if (!deduped.has(key)) deduped.set(key, session)
  }
  return [...deduped.values()]
}

export async function listConversations(ctx: any) {
  const source = (ctx.query.source as string) || undefined
  const humanOnly = (ctx.query.humanOnly as string) !== 'false' && ctx.query.humanOnly !== '0'
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined

  try {
    const sessions = await listConversationSummariesFromDb({ source, humanOnly, limit })
    ctx.body = { sessions: filterPendingDeletedConversationSummaries(sessions) }
    return
  } catch (err) {
    logger.warn(err, 'Hermes Conversation DB: summary query failed, falling back to CLI export')
  }

  const sessions = await listConversationSummaries({ source, humanOnly, limit })
  ctx.body = { sessions: filterPendingDeletedConversationSummaries(sessions) }
}

export async function getConversationMessages(ctx: any) {
  const source = (ctx.query.source as string) || undefined
  const humanOnly = (ctx.query.humanOnly as string) !== 'false' && ctx.query.humanOnly !== '0'

  try {
    const detail = await getConversationDetailFromDb(ctx.params.id, { source, humanOnly })
    if (!detail || hasPendingDeletedConversation(detail)) {
      if (!detail && bridgeSessionFallbackEnabled()) {
        ctx.body = createBridgeConversationFallback(ctx.params.id)
        return
      }
      ctx.status = 404
      ctx.body = { error: 'Conversation not found' }
      return
    }
    ctx.body = detail
    return
  } catch (err) {
    logger.warn(err, 'Hermes Conversation DB: detail query failed, falling back to CLI export')
  }

  const detail = await getConversationDetail(ctx.params.id, { source, humanOnly })
  if (!detail || hasPendingDeletedConversation(detail)) {
    if (!detail && bridgeSessionFallbackEnabled()) {
      ctx.body = createBridgeConversationFallback(ctx.params.id)
      return
    }
    ctx.status = 404
    ctx.body = { error: 'Conversation not found' }
    return
  }
  ctx.body = detail
}

export async function list(ctx: any) {
  if (useLocalSessionStore()) {
    const source = (ctx.query.source as string) || undefined
    const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined
    const profile = getActiveProfileName()
    const effectiveLimit = limit && limit > 0 ? limit : 2000
    const localSessions = localListSessions(profile, source, effectiveLimit)
      .filter(session => session.source !== 'tui')
    if (source && source !== 'tui') {
      logger.info({
        route: 'list',
        mode: 'local-store-only',
        source: source || null,
        localCount: localSessions.length,
        effectiveLimit,
      }, '[sessions-controller] route-choice')
      ctx.body = { sessions: filterPendingDeletedSessions(localSessions) }
      return
    }
    try {
      const tuiSessions = await listSessionSummaries(source === 'tui' ? 'tui' : undefined, effectiveLimit)
      logger.info({
        route: 'list',
        source: source || null,
        localCount: localSessions.length,
        tuiCount: tuiSessions.length,
        effectiveLimit,
      }, '[sessions-controller] list mixed local+tui')
      const merged = [...localSessions, ...dedupeTuiSessionsByLineage(tuiSessions)]
      const deduped = Array.from(new Map(merged.map(session => [session.id, session])).values())
        .sort((a, b) => Number(b.last_active || b.started_at || 0) - Number(a.last_active || a.started_at || 0))
        .slice(0, effectiveLimit)
      ctx.body = { sessions: filterPendingDeletedSessions(deduped) }
      return
    } catch (err) {
      logger.warn(err, 'Hermes Session DB: summary query failed in local-session mode, falling back to local store only')
      logger.info({
        route: 'list',
        source: source || null,
        localCount: localSessions.length,
        effectiveLimit,
      }, '[sessions-controller] list local-only-fallback')
      ctx.body = { sessions: filterPendingDeletedSessions(localSessions) }
      return
    }
  }

  const source = (ctx.query.source as string) || undefined
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined

  try {
    const sessions = await listSessionSummaries(source, limit && limit > 0 ? limit : 2000)
    logger.info({
      route: 'list',
      mode: 'db',
      source: source || null,
      count: sessions.length,
    }, '[sessions-controller] route-choice')
    ctx.body = { sessions: filterPendingDeletedSessions(sessions) }
    return
  } catch (err) {
    logger.warn(err, 'Hermes Session DB: summary query failed, falling back to CLI')
  }

  const sessions = await hermesCli.listSessions(source, limit)
  ctx.body = { sessions: filterPendingDeletedSessions(sessions) }
}

/**
 * List Hermes sessions only (exclude api_server source)
 * GET /api/hermes/sessions/hermes?source=&limit=
 */
export async function listHermesSessions(ctx: any) {
  const source = (ctx.query.source as string) || undefined
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined
  const effectiveLimit = limit && limit > 0 ? limit : 2000

  if (!source || source === 'tui') {
    try {
      const conversations = await listConversationSummariesFromDb({
        source: 'tui',
        humanOnly: true,
        limit: effectiveLimit,
      })
      ctx.body = { sessions: filterPendingDeletedConversationSummaries(conversations) }
      return
    } catch (err) {
      logger.warn(err, 'Hermes Conversation DB: tui summary query failed, falling back to session DB')
    }
  }

  try {
    const sessions = await listSessionSummaries(source, effectiveLimit)
    ctx.body = { sessions: filterPendingDeletedSessions(sessions.filter(s => s.source !== 'api_server' && s.source !== 'cron')) }
    return
  } catch (err) {
    logger.warn(err, 'Hermes Session DB: summary query failed, falling back to CLI')
  }

  const sessions = await hermesCli.listSessions(source, limit)
  ctx.body = { sessions: filterPendingDeletedSessions(sessions.filter(s => s.source !== 'api_server')) }
}

export async function search(ctx: any) {
  if (useLocalSessionStore()) {
    const q = typeof ctx.query.q === 'string' ? ctx.query.q : ''
    const source = typeof ctx.query.source === 'string' && ctx.query.source.trim()
      ? ctx.query.source.trim()
      : undefined
    const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined
    const profile = getActiveProfileName()
    const effectiveLimit = limit && limit > 0 ? limit : 20
    const localResults = localSearchSessions(profile, q, effectiveLimit)
      .filter(session => session.source !== 'tui')
    let tuiResults: Awaited<ReturnType<typeof searchConversationSummariesFromDb>> = []
    if (!source || source === 'tui') {
      try {
        tuiResults = await searchConversationSummariesFromDb(q, {
          source: 'tui',
          humanOnly: true,
          limit: effectiveLimit,
        })
        tuiResults = dedupeTuiSessionsByLineage(tuiResults as any) as typeof tuiResults
        logger.info({
          route: 'search',
          source: source || null,
          localCount: localResults.length,
          tuiCount: tuiResults.length,
          effectiveLimit,
          query: q,
        }, '[sessions-controller] search mixed local+tui')
      } catch (err) {
        logger.warn(err, 'Hermes Session DB: tui search supplement failed')
      }
    }
    const merged = [...localResults, ...tuiResults]
    const deduped = Array.from(new Map(merged.map(item => [item.id, item])).values())
      .sort((left, right) => {
        if ((right.last_active || right.started_at) !== (left.last_active || left.started_at)) {
          return (right.last_active || right.started_at) - (left.last_active || left.started_at)
        }
        const leftRank = 'rank' in left ? (left.rank || 0) : 0
        const rightRank = 'rank' in right ? (right.rank || 0) : 0
        return leftRank - rightRank
      })
      .slice(0, effectiveLimit)
    ctx.body = { results: filterPendingDeletedSessions(deduped) }
    return
  }

  const q = typeof ctx.query.q === 'string' ? ctx.query.q : ''
  const source = typeof ctx.query.source === 'string' && ctx.query.source.trim()
    ? ctx.query.source.trim()
    : undefined
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined

  try {
    const results = await searchSessionSummaries(q, source, limit && limit > 0 ? limit : 20)
    logger.info({
      route: 'search',
      mode: 'db',
      source: source || null,
      count: results.length,
    }, '[sessions-controller] route-choice')
    ctx.body = { results: filterPendingDeletedSessions(results) }
  } catch (err) {
    logger.error(err, 'Hermes Session DB: search failed')
    ctx.status = 500
    ctx.body = { error: 'Failed to search sessions' }
  }
}

export async function get(ctx: any) {
  const requestedSessionId = ctx.params.id
  const canonicalSessionId = resolveCanonicalSessionId(requestedSessionId) || requestedSessionId
  logger.info({
    route: 'get',
    requestedSessionId,
    canonicalSessionId,
    useLocalSessionStore: useLocalSessionStore(),
  }, '[sessions-controller] route-start')

  if (isPendingDeletedSession(ctx.params.id)) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }

  if (useLocalSessionStore()) {
    const session = localGetSessionDetail(requestedSessionId)
    if (session && session.source !== 'tui' && !hasPendingDeletedSessionDetail(session)) {
      logger.info({
        route: 'get',
        sessionId: requestedSessionId,
        canonicalSessionId,
        lookupSessionId: requestedSessionId,
        source: session.source,
      }, '[sessions-controller] get local-hit')
      ctx.body = { session }
      return
    }
    if (session) {
      logger.info({
        route: 'get',
        sessionId: requestedSessionId,
        canonicalSessionId,
        lookupSessionId: requestedSessionId,
        source: session.source,
        messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
      }, '[sessions-controller] get local-bypassed')
    }
  }

  try {
    for (const lookupSessionId of Array.from(new Set([requestedSessionId, canonicalSessionId]))) {
      const result = await getDbSessionDetailForRequest(lookupSessionId, requestedSessionId, canonicalSessionId)
      if (!result) continue
      if (hasPendingDeletedSessionDetail(result)) {
        ctx.status = 404
        ctx.body = { error: 'Session not found' }
        return
      }
      ctx.body = { session: result }
      return
    }
  } catch (err) {
    logger.warn(err, 'Hermes Session DB: detail query failed, falling back to CLI')
  }

  const persistentSessionId = tuiBridge.getPersistentSessionId(canonicalSessionId)
  if (persistentSessionId && persistentSessionId !== canonicalSessionId) {
    try {
      const mappedSession = await getSessionDetailFromDb(persistentSessionId)
      if (mappedSession && !hasPendingDeletedSessionDetail(mappedSession)) {
        logger.info({
          route: 'get',
          sessionId: requestedSessionId,
          canonicalSessionId,
          persistentSessionId,
        }, '[sessions-controller] get mapped-db-hit')
        ctx.body = { session: mappedSession }
        return
      }
    } catch (err) {
      logger.warn(err, 'Hermes Session DB: mapped bridge detail query failed, falling back to CLI')
    }

    const mappedCliSession = await hermesCli.getSession(persistentSessionId)
    if (mappedCliSession) {
      logger.info({
        route: 'get',
        sessionId: requestedSessionId,
        canonicalSessionId,
        persistentSessionId,
      }, '[sessions-controller] get mapped-cli-hit')
      ctx.body = { session: mappedCliSession }
      return
    }
  }

  let session: Awaited<ReturnType<typeof hermesCli.getSession>> | null = null
  for (const lookupSessionId of Array.from(new Set([requestedSessionId, canonicalSessionId]))) {
    session = await hermesCli.getSession(lookupSessionId)
    if (session) break
  }
  const wrapperOnlyCliSession = isBridgeContinuationWrapperOnlyDetail(session)
  if (!session || wrapperOnlyCliSession) {
    logger.info({
      route: 'get',
      sessionId: requestedSessionId,
      canonicalSessionId,
      fallback: !session ? 'none' : 'wrapper-only-cli',
    }, '[sessions-controller] get cli-suppressed')
    if (wrapperOnlyCliSession || bridgeSessionFallbackEnabled()) {
      ctx.body = { session: createBridgeSessionFallback(requestedSessionId) }
      return
    }
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  logger.info({
    route: 'get',
    sessionId: requestedSessionId,
    canonicalSessionId,
    source: session.source,
    messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
  }, '[sessions-controller] get cli-hit')
  ctx.body = { session }
}

/**
 * Get Hermes session detail only (exclude api_server source)
 * GET /api/hermes/sessions/hermes/:id
 */
export async function getHermesSession(ctx: any) {
  // Try database first (consistent with listHermesSessions)
  try {
    const session = await getSessionDetailFromDb(ctx.params.id)
    if (session && session.source !== 'api_server' && session.source !== 'cron') {
      ctx.body = { session }
      return
    }
  } catch (err) {
    logger.warn(err, 'Hermes Session DB: detail query failed, falling back to CLI')
  }

  // Fallback to CLI
  const session = await hermesCli.getSession(ctx.params.id)
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  // Filter out api_server sessions
  if (session.source === 'api_server') {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  ctx.body = { session }
}

export async function remove(ctx: any) {
  if (useLocalSessionStore()) {
    const sessionId = ctx.params.id
    const localOk = localDeleteSession(sessionId)
    if (localOk) {
      deleteUsage(sessionId)
      ctx.body = { ok: true }
      return
    }

    // In local session-store mode, Hermes TUI sessions are not necessarily
    // mirrored into the Web UI SQLite store. If the local delete misses,
    // fall through to the Hermes deletion path instead of surfacing a false
    // 500 to the frontend.
    logger.info('[remove] local session-store miss, falling back to Hermes delete for sessionId=%s', sessionId)
  }

  const sessionId = ctx.params.id
  const storage = getGroupChatStorage()
  const currentProfile = getActiveProfileName()
  const mapped = storage?.getSessionProfile(sessionId) || null

  logger.info('[remove] sessionId=%s, currentProfile=%s, mapped=%j', sessionId, currentProfile, mapped)

  if (mapped && mapped.profile_name !== currentProfile) {
    logger.info('[remove] cross-profile detected, enqueued deferred delete for profile=%s', mapped.profile_name)
    storage?.enqueuePendingSessionDelete(sessionId, mapped.profile_name)
    deleteUsage(sessionId)
    ctx.body = { ok: true, deferred: true }
    return
  }

  const ok = await hermesCli.deleteSession(sessionId)
  if (!ok) {
    ctx.status = 500
    ctx.body = { error: 'Failed to delete session' }
    return
  }
  storage?.markSessionDeleted(sessionId, mapped?.profile_name || currentProfile)
  if (mapped) storage?.deleteSessionProfile(sessionId)
  deleteUsage(sessionId)
  ctx.body = { ok: true }
}

export async function batchRemove(ctx: any) {
  const { ids } = ctx.request.body as { ids?: string[] }
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    ctx.status = 400
    ctx.body = { error: 'ids is required and must be a non-empty array' }
    return
  }

  const validIds = ids.filter(id => typeof id === 'string' && id.trim() !== '')
  if (validIds.length === 0) {
    ctx.status = 400
    ctx.body = { error: 'No valid session ids provided' }
    return
  }

  const results = {
    deleted: 0,
    failed: 0,
    errors: [] as Array<{ id: string; error: string }>
  }
  const storage = getGroupChatStorage()
  const currentProfile = getActiveProfileName()

  if (useLocalSessionStore()) {
    for (const id of validIds) {
      const localOk = localDeleteSession(id)
      if (localOk) {
        deleteUsage(id)
        results.deleted++
        continue
      }

      const ok = await hermesCli.deleteSession(id)
      if (ok) {
        storage?.markSessionDeleted(id, (storage?.getSessionProfile(id)?.profile_name) || currentProfile)
        storage?.deleteSessionProfile(id)
        deleteUsage(id)
        results.deleted++
      } else {
        results.failed++
        results.errors.push({ id, error: 'Failed to delete session' })
      }
    }
  } else {
    for (const id of validIds) {
      const ok = await hermesCli.deleteSession(id)
      if (ok) {
        storage?.markSessionDeleted(id, (storage?.getSessionProfile(id)?.profile_name) || currentProfile)
        storage?.deleteSessionProfile(id)
        deleteUsage(id)
        results.deleted++
      } else {
        results.failed++
        results.errors.push({ id, error: 'Failed to delete session' })
      }
    }
  }

  ctx.body = { ...results, ok: true }
}

export async function usageBatch(ctx: any) {
  const ids = (ctx.query.ids as string)
  if (!ids) {
    ctx.body = {}
    return
  }
  const idList = ids.split(',').filter(Boolean)
  ctx.body = getUsageBatch(idList)
}

export async function usageSingle(ctx: any) {
  const result = getUsage(ctx.params.id)
  if (!result) {
    ctx.body = { input_tokens: 0, output_tokens: 0 }
    return
  }
  ctx.body = result
}

export async function rename(ctx: any) {
  if (useLocalSessionStore()) {
    const { title } = ctx.request.body as { title?: string }
    if (!title || typeof title !== 'string') {
      ctx.status = 400
      ctx.body = { error: 'title is required' }
      return
    }
    const ok = localRenameSession(ctx.params.id, title.trim())
    if (!ok) {
      ctx.status = 500
      ctx.body = { error: 'Failed to rename session' }
      return
    }
    ctx.body = { ok: true }
    return
  }

  const { title } = ctx.request.body as { title?: string }
  if (!title || typeof title !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'title is required' }
    return
  }
  const ok = await hermesCli.renameSession(ctx.params.id, title.trim())
  if (!ok) {
    ctx.status = 500
    ctx.body = { error: 'Failed to rename session' }
    return
  }
  ctx.body = { ok: true }
}

export async function setWorkspace(ctx: any) {
  const { workspace } = ctx.request.body as { workspace?: string }
  if (workspace !== undefined && workspace !== null && typeof workspace !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'workspace must be a string or null' }
    return
  }
  if (useLocalSessionStore()) {
    const { updateSession, getSession, createSession } = await import('../../db/hermes/session-store')
    const { getActiveProfileName } = await import('../../services/hermes/hermes-profile')
    const id = ctx.params.id
    // Create session if it doesn't exist yet (user may set workspace before sending first message)
    if (!getSession(id)) {
      createSession({ id, profile: getActiveProfileName(), title: '' })
    }
    updateSession(id, { workspace: workspace || null } as any)
    ctx.body = { ok: true }
    return
  }
  ctx.status = 501
  ctx.body = { error: 'Workspace setting only supported in local session store mode' }
}

export async function contextLength(ctx: any) {
  const profile = (ctx.query.profile as string) || undefined
  ctx.body = { context_length: getModelContextLength(profile) }
}

export async function usageStats(ctx: any) {
  const rawDays = parseInt(String(ctx.query?.days ?? '30'), 10)
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 365) : 30

  // Local Web UI chat usage is kept in the dashboard DB and must be merged
  // with Hermes' native state.db analytics for the same period.
  const currentProfile = getActiveProfileName()
  const local = getLocalUsageStats(currentProfile, days)

  let hermes = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    sessions: 0,
    by_model: [] as UsageStatsModelRow[],
    by_day: [] as UsageStatsDailyRow[],
    cost: 0,
    total_api_calls: 0,
  }

  try {
    hermes = await getUsageStatsFromDb(days)
  } catch (err) {
    logger.warn(err, 'usageStats: failed to load Hermes usage analytics from state.db')
  }

  const totalInput = local.input_tokens + hermes.input_tokens
  const totalOutput = local.output_tokens + hermes.output_tokens
  const totalCacheRead = local.cache_read_tokens + hermes.cache_read_tokens
  const totalCacheWrite = local.cache_write_tokens + hermes.cache_write_tokens
  const totalReasoning = local.reasoning_tokens + hermes.reasoning_tokens
  const totalSessions = local.sessions + hermes.sessions

  const modelMap = new Map<string, UsageStatsModelRow>()
  for (const m of [...local.by_model, ...hermes.by_model]) {
    const model = (m.model || '').trim() || 'unknown'
    const existing = modelMap.get(model)
    if (existing) {
      existing.input_tokens += m.input_tokens
      existing.output_tokens += m.output_tokens
      existing.cache_read_tokens += m.cache_read_tokens
      existing.cache_write_tokens += m.cache_write_tokens
      existing.reasoning_tokens += m.reasoning_tokens
      existing.sessions += m.sessions
    } else {
      modelMap.set(model, { ...m, model })
    }
  }

  const dayMap = new Map<string, UsageStatsDailyRow>()
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    dayMap.set(key, { date: key, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, sessions: 0, errors: 0, cost: 0 })
  }
  for (const d of [...local.by_day, ...hermes.by_day]) {
    const existing = dayMap.get(d.date)
    if (existing) {
      existing.input_tokens += d.input_tokens; existing.output_tokens += d.output_tokens
      existing.cache_read_tokens += d.cache_read_tokens; existing.cache_write_tokens += d.cache_write_tokens
      existing.sessions += d.sessions; existing.errors += d.errors; existing.cost += d.cost
    }
  }

  ctx.body = {
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_cache_read_tokens: totalCacheRead,
    total_cache_write_tokens: totalCacheWrite,
    total_reasoning_tokens: totalReasoning,
    total_sessions: totalSessions,
    total_cost: hermes.cost,
    total_api_calls: hermes.total_api_calls,
    period_days: days,
    model_usage: [...modelMap.values()].sort((a, b) => (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens)),
    daily_usage: [...dayMap.values()],
  }
}

/**
 * List folders under workspace base path for folder picker.
 * GET /api/hermes/workspace/folders?path=<relative_path>
 * Base: /opt/data/workspace (overridable via WORKSPACE_BASE env)
 */
export async function listWorkspaceFolders(ctx: any) {
  const { resolve, join } = await import('path')
  const { readdir } = await import('fs/promises')
  const { existsSync } = await import('fs')

  const WORKSPACE_BASE = process.env.WORKSPACE_BASE || '/opt/data/workspace'
  const subPath = (ctx.query.path as string) || ''

  // Security: prevent path traversal
  const fullPath = resolve(join(WORKSPACE_BASE, subPath))
  if (!fullPath.startsWith(resolve(WORKSPACE_BASE))) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return
  }

  if (!existsSync(fullPath)) {
    ctx.status = 404
    ctx.body = { error: 'Path not found', folders: [] }
    return
  }

  try {
    const entries = await readdir(fullPath, { withFileTypes: true })
    const folders = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({
        name: e.name,
        path: subPath ? `${subPath}/${e.name}` : e.name,
        fullPath: join(fullPath, e.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    ctx.body = { base: WORKSPACE_BASE, current: subPath, folders }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

const exportCompressor = new ExportCompressor()

export async function exportSession(ctx: any) {
  let session: any = null

  if (useLocalSessionStore()) {
    session = localGetSessionDetail(ctx.params.id)
  } else {
    try {
      session = await getSessionDetailFromDb(ctx.params.id)
    } catch (err) {
      logger.warn(err, 'Hermes Session DB: export detail query failed, falling back to CLI')
    }
    if (!session) {
      session = await hermesCli.getSession(ctx.params.id)
    }
  }

  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }

  const mode = (ctx.query.mode as string) || 'full'
  const ext = (ctx.query.ext as string) || (mode === 'compressed' ? 'txt' : 'json')
  const title = session.title || 'session'
  const safeName = title.replace(/[^a-zA-Z0-9一-鿿_-]/g, '_').slice(0, 50)
  const filename = `${safeName}_${ctx.params.id.slice(0, 8)}.${ext}`

  if (mode === 'compressed') {
    const result = await compressSession(session)
    if (ext === 'json') {
      ctx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
      ctx.set('Content-Type', 'application/json')
      ctx.body = JSON.stringify({ id: session.id, title: session.title, ...result.meta, messages: result.messages }, null, 2)
    } else {
      ctx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
      ctx.set('Content-Type', 'text/plain; charset=utf-8')
      ctx.body = serializeAsText(session.title, result.messages)
    }
  } else {
    if (ext === 'txt') {
      ctx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
      ctx.set('Content-Type', 'text/plain; charset=utf-8')
      ctx.body = serializeAsText(session.title, session.messages || [])
    } else {
      ctx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
      ctx.set('Content-Type', 'application/json')
      ctx.body = JSON.stringify(session, null, 2)
    }
  }
}

async function compressSession(session: any) {
  const mgr = getGatewayManagerInstance()
  const profile = getActiveProfileName()
  const upstream = mgr ? mgr.getUpstream(profile).replace(/\/$/, '') : ''
  const apiKey = mgr ? mgr.getApiKey(profile) || undefined : undefined
  const messages = (session.messages || []).map((m: any) => ({
    role: m.role,
    content: m.content || '',
    tool_calls: m.tool_calls,
    tool_call_id: m.tool_call_id,
    name: m.tool_name,
    reasoning_content: m.reasoning,
  }))

  return exportCompressor.compress(messages, upstream, apiKey, session.id, profile)
}

function serializeAsText(title: string | null, messages: any[]): string {
  const lines: string[] = [`# ${title || 'Untitled'}`, '']
  for (const msg of messages) {
    const role = msg.role || 'unknown'
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    const ts = msg.timestamp ? new Date(msg.timestamp * 1000).toISOString() : ''
    lines.push(`[${role}]${ts ? ' ' + ts : ''}`)
    lines.push(content || '')
    lines.push('')
  }
  return lines.join('\n')
}

export async function getConversationMessagesPaginated(ctx: any) {
  const offset = ctx.query.offset ? parseInt(ctx.query.offset as string, 10) : 0
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : 50

  if (useLocalSessionStore()) {
    const { getSessionDetailPaginated } = await import('../../db/hermes/session-store')
    const result = getSessionDetailPaginated(ctx.params.id, offset, limit)

    if (!result) {
      ctx.status = 404
      ctx.body = { error: 'Conversation not found' }
      return
    }

    ctx.body = {
      session: {
        id: result.session.id,
        source: result.session.source,
        model: result.session.model,
        title: result.session.title,
        started_at: result.session.started_at,
        ended_at: result.session.ended_at,
        last_active: result.session.last_active,
        message_count: result.session.message_count,
        input_tokens: result.session.input_tokens,
        output_tokens: result.session.output_tokens,
      },
      messages: result.messages,
      total: result.total,
      offset: result.offset,
      limit: result.limit,
      hasMore: result.hasMore,
    }
    return
  }

  ctx.status = 404
  ctx.body = { error: 'Conversation not found' }
}
