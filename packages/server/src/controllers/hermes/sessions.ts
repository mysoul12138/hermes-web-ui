import * as hermesCli from '../../services/hermes/hermes-cli'
import { listConversationSummaries, getConversationDetail } from '../../services/hermes/conversations'
import { listConversationSummariesFromDb, getConversationDetailFromDb } from '../../db/hermes/conversations-db'
import { getSessionDetailFromDb, listSessionSummaries, searchSessionSummaries, getUsageStatsFromDb } from '../../db/hermes/sessions-db'
import {
  listSessions as localListSessions,
  searchSessions as localSearchSessions,
  getSessionDetail as localGetSessionDetail,
  deleteSession as localDeleteSession,
  renameSession as localRenameSession,
  useLocalSessionStore,
} from '../../db/hermes/session-store'
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
    model: '',
    title: null,
    preview: '',
    started_at: now,
    ended_at: null,
    last_active: now,
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
    cost_status: 'unknown',
    messages: [],
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

function getGroupChatStorage() {
  return getGroupChatServer()?.getStorage() || null
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
    const sessions = localListSessions(profile, source, limit && limit > 0 ? limit : 2000)
    ctx.body = { sessions: filterPendingDeletedSessions(sessions) }
    return
  }

  const source = (ctx.query.source as string) || undefined
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined

  try {
    const sessions = await listSessionSummaries(source, limit && limit > 0 ? limit : 2000)
    ctx.body = { sessions: filterPendingDeletedSessions(sessions) }
    return
  } catch (err) {
    logger.warn(err, 'Hermes Session DB: summary query failed, falling back to CLI')
  }

  const sessions = await hermesCli.listSessions(source, limit)
  ctx.body = { sessions: filterPendingDeletedSessions(sessions) }
}

export async function search(ctx: any) {
  if (useLocalSessionStore()) {
    const q = typeof ctx.query.q === 'string' ? ctx.query.q : ''
    const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined
    const profile = getActiveProfileName()
    const results = localSearchSessions(profile, q, limit && limit > 0 ? limit : 20)
    ctx.body = { results: filterPendingDeletedSessions(results) }
    return
  }

  const q = typeof ctx.query.q === 'string' ? ctx.query.q : ''
  const source = typeof ctx.query.source === 'string' && ctx.query.source.trim()
    ? ctx.query.source.trim()
    : undefined
  const limit = ctx.query.limit ? parseInt(ctx.query.limit as string, 10) : undefined

  try {
    const results = await searchSessionSummaries(q, source, limit && limit > 0 ? limit : 20)
    ctx.body = { results: filterPendingDeletedSessions(results) }
  } catch (err) {
    logger.error(err, 'Hermes Session DB: search failed')
    ctx.status = 500
    ctx.body = { error: 'Failed to search sessions' }
  }
}

export async function get(ctx: any) {
  if (isPendingDeletedSession(ctx.params.id)) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }

  if (useLocalSessionStore()) {
    const session = localGetSessionDetail(ctx.params.id)
    if (session && !hasPendingDeletedSessionDetail(session)) {
      ctx.body = { session }
      return
    }
  }

  try {
    const session = await getSessionDetailFromDb(ctx.params.id)
    if (session) {
      if (hasPendingDeletedSessionDetail(session)) {
        ctx.status = 404
        ctx.body = { error: 'Session not found' }
        return
      }
      ctx.body = { session }
      return
    }
  } catch (err) {
    logger.warn(err, 'Hermes Session DB: detail query failed, falling back to CLI')
  }

  const persistentSessionId = tuiBridge.getPersistentSessionId(ctx.params.id)
  if (persistentSessionId && persistentSessionId !== ctx.params.id) {
    try {
      const mappedSession = await getSessionDetailFromDb(persistentSessionId)
      if (mappedSession && !hasPendingDeletedSessionDetail(mappedSession)) {
        ctx.body = { session: mappedSession }
        return
      }
    } catch (err) {
      logger.warn(err, 'Hermes Session DB: mapped bridge detail query failed, falling back to CLI')
    }

    const mappedCliSession = await hermesCli.getSession(persistentSessionId)
    if (mappedCliSession) {
      ctx.body = { session: mappedCliSession }
      return
    }
  }

  const session = await hermesCli.getSession(ctx.params.id)
  if (!session) {
    if (bridgeSessionFallbackEnabled()) {
      ctx.body = { session: createBridgeSessionFallback(ctx.params.id) }
      return
    }
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  ctx.body = { session }
}

export async function remove(ctx: any) {
  if (useLocalSessionStore()) {
    const sessionId = ctx.params.id
    const ok = localDeleteSession(sessionId)
    if (!ok) {
      ctx.status = 500
      ctx.body = { error: 'Failed to delete session' }
      return
    }
    deleteUsage(sessionId)
    ctx.body = { ok: true }
    return
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
  if (mapped) storage?.deleteSessionProfile(sessionId)
  deleteUsage(sessionId)
  ctx.body = { ok: true }
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
  for (const m of [...local.by_model, ...hermes.by_model].filter(m => m.model)) {
    const existing = modelMap.get(m.model)
    if (existing) {
      existing.input_tokens += m.input_tokens
      existing.output_tokens += m.output_tokens
      existing.cache_read_tokens += m.cache_read_tokens
      existing.cache_write_tokens += m.cache_write_tokens
      existing.reasoning_tokens += m.reasoning_tokens
      existing.sessions += m.sessions
    } else {
      modelMap.set(m.model, { ...m })
    }
  }

  const dayMap = new Map<string, UsageStatsDailyRow>()
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    dayMap.set(key, { date: key, tokens: 0, cache: 0, sessions: 0, cost: 0 })
  }
  for (const d of [...local.by_day, ...hermes.by_day]) {
    const existing = dayMap.get(d.date)
    if (existing) {
      existing.tokens += d.tokens
      existing.cache += d.cache
      existing.sessions += d.sessions
      existing.cost += d.cost
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
