import { cancelRun, startRun, steerSession, streamRunEvents, type ChatMessage, type RunEvent } from '@/api/hermes/chat'
import {
  getPendingApproval,
  respondApproval as respondApprovalApi,
  type ApprovalChoice,
  type PendingApproval,
} from '@/api/hermes/approval'
import { deleteSession as deleteSessionApi, fetchSession, fetchSessions, fetchSessionUsageSingle, type HermesMessage, type SessionSummary } from '@/api/hermes/sessions'
import { fetchConversationDetail, fetchConversationSummaries, type ConversationBranch, type ConversationMessage, type ConversationSummary } from '@/api/hermes/conversations'
import { getApiKey } from '@/api/client'
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useAppStore } from './app'
import { useProfilesStore } from './profiles'
import { useSettingsStore } from './settings'
import { detectThinkingBoundary } from '@/utils/thinking-parser'

export interface Attachment {
  id: string
  name: string
  type: string
  size: number
  url: string
  file?: File
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  timestamp: number
  toolName?: string
  toolPreview?: string
  toolArgs?: string
  toolResult?: string
  toolStatus?: 'running' | 'done' | 'error'
  isStreaming?: boolean
  queued?: boolean
  steered?: boolean
  subagentId?: string
  subagentDepth?: number
  attachments?: Attachment[]
  // 思考/推理文本。两条来源：
  //   1) 历史消息：来自 HermesMessage.reasoning 字段
  //   2) 流式：由 reasoning.delta / thinking.delta / reasoning.available 事件累加
  // 不含 <think> 包裹标签；内容自身可以为多段纯文本。
  reasoning?: string
}

export interface Session {
  id: string
  title: string
  source?: string
  messages: Message[]
  createdAt: number
  updatedAt: number
  model?: string
  provider?: string
  messageCount?: number
  inputTokens?: number
  outputTokens?: number
  endedAt?: number | null
  lastActiveAt?: number
  branchSessionCount?: number
  parentSessionId?: string | null
  rootSessionId?: string | null
  isBranchSession?: boolean
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

async function uploadFiles(attachments: Attachment[]): Promise<{ name: string; path: string }[]> {
  if (attachments.length === 0) return []
  const formData = new FormData()
  for (const att of attachments) {
    if (att.file) formData.append('file', att.file, att.name)
  }
  const token = localStorage.getItem('hermes_api_key') || ''
  const res = await fetch('/upload', {
    method: 'POST',
    body: formData,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
  const data = await res.json() as { files: { name: string; path: string }[] }
  return data.files
}

function tryParseJson(value?: string | null): Record<string, any> | null {
  if (!value?.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : null
  } catch {
    return null
  }
}

function extractApprovalCommandFromArgs(toolArgs?: string): string | undefined {
  const parsed = tryParseJson(toolArgs)
  return typeof parsed?.command === 'string' && parsed.command.trim()
    ? parsed.command.trim()
    : undefined
}

function extractCommandFromToolPreview(preview?: string): string | undefined {
  const value = preview?.trim()
  if (!value) return undefined
  return value.replace(/^terminal\s+/i, '').trim() || value
}

function textFromRunEvent(evt: RunEvent): string {
  for (const value of [evt.text, evt.delta, evt.reasoning, evt.thinking, evt.content, evt.message]) {
    if (typeof value === 'string' && value) return value
  }
  return ''
}

function isBuggyReasoningPreview(reasoningText: string, assistantContent: string): boolean {
  const r = reasoningText.trim()
  const c = assistantContent.trim()
  if (!r || !c) return false
  return c === r || c.startsWith(r)
}

function extractPendingApprovalFromMessages(messages: Message[]): PendingApproval | null {
  const lastUserIdx = [...messages].map(m => m.role).lastIndexOf('user')
  const relevantMessages = lastUserIdx >= 0 ? messages.slice(lastUserIdx + 1) : messages

  for (let i = relevantMessages.length - 1; i >= 0; i -= 1) {
    const msg = relevantMessages[i]

    if (msg.role === 'assistant') {
      const text = msg.content.trim()
      if (!text) continue
      if (/approval_required|need approval|需要审批|blocked/i.test(text)) continue
      return null
    }

    if (msg.role === 'tool') {
      if (!msg.toolResult) {
        if (msg.toolStatus === 'running') return null
        continue
      }
      const parsed = tryParseJson(msg.toolResult)
      if (parsed?.status !== 'approval_required') {
        return null
      }

      const command = typeof parsed.command === 'string' && parsed.command.trim()
        ? parsed.command.trim()
        : extractApprovalCommandFromArgs(msg.toolArgs)

      return {
        approval_id: typeof parsed.approval_id === 'string' && parsed.approval_id.trim() ? parsed.approval_id.trim() : undefined,
        description: typeof parsed.description === 'string' && parsed.description.trim()
          ? parsed.description.trim()
          : undefined,
        command,
        pattern_key: typeof parsed.pattern_key === 'string' && parsed.pattern_key.trim()
          ? parsed.pattern_key.trim()
          : undefined,
        pattern_keys: Array.isArray(parsed.pattern_keys)
          ? parsed.pattern_keys.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          : undefined,
      }
    }
  }

  return null
}

function mapHermesMessages(msgs: HermesMessage[]): Message[] {
  // Build lookups from assistant messages with tool_calls
  const toolNameMap = new Map<string, string>()
  const toolArgsMap = new Map<string, string>()
  for (const msg of msgs) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) {
          if (tc.function?.name) toolNameMap.set(tc.id, tc.function.name)
          if (tc.function?.arguments) toolArgsMap.set(tc.id, tc.function.arguments)
        }
      }
    }
  }

  const result: Message[] = []
  for (const msg of msgs) {
    // Skip assistant messages that only contain tool_calls (no meaningful content)
    if (msg.role === 'assistant' && msg.tool_calls?.length && !msg.content?.trim()) {
      // Emit a tool.started message for each tool call
      for (const tc of msg.tool_calls) {
        result.push({
          id: String(msg.id) + '_' + tc.id,
          role: 'tool',
          content: '',
          timestamp: Math.round(msg.timestamp * 1000),
          toolName: tc.function?.name || 'tool',
          toolArgs: tc.function?.arguments || undefined,
          toolStatus: 'done',
        })
      }
      continue
    }

    // Tool result messages
    if (msg.role === 'tool') {
      const tcId = msg.tool_call_id || ''
      const toolName = msg.tool_name || toolNameMap.get(tcId) || 'tool'
      const toolArgs = toolArgsMap.get(tcId) || undefined
      // Extract a short preview from the content
      let preview = ''
      if (msg.content) {
        try {
          const parsed = JSON.parse(msg.content)
          preview = parsed.url || parsed.title || parsed.preview || parsed.summary || ''
        } catch {
          preview = msg.content.slice(0, 80)
        }
      }
      // Find and remove the matching placeholder from tool_calls above
      const placeholderIdx = result.findIndex(
        m => m.role === 'tool' && m.toolName === toolName && !m.toolResult && m.id.includes('_' + tcId)
      )
      if (placeholderIdx !== -1) {
        result.splice(placeholderIdx, 1)
      }
      result.push({
        id: String(msg.id),
        role: 'tool',
        content: '',
        timestamp: Math.round(msg.timestamp * 1000),
        toolName,
        toolArgs,
        toolPreview: typeof preview === 'string' ? preview.slice(0, 100) || undefined : undefined,
        toolResult: msg.content || undefined,
        toolStatus: 'done',
      })
      continue
    }

    // Normal user/assistant messages
    result.push({
      id: String(msg.id),
      role: msg.role,
      content: msg.content || '',
      timestamp: Math.round(msg.timestamp * 1000),
      reasoning: msg.reasoning ? msg.reasoning : undefined,
    })
  }
  return result
}

function mapHermesSession(s: SessionSummary | ConversationSummary): Session {
  return {
    id: s.id,
    title: s.title || '',
    source: s.source || undefined,
    messages: [],
    createdAt: Math.round(s.started_at * 1000),
    updatedAt: Math.round((s.last_active || s.ended_at || s.started_at) * 1000),
    model: s.model,
    provider: (s as any).billing_provider || '',
    messageCount: s.message_count,
    endedAt: s.ended_at != null ? Math.round(s.ended_at * 1000) : null,
    lastActiveAt: s.last_active != null ? Math.round(s.last_active * 1000) : undefined,
    branchSessionCount: 'branch_session_count' in s ? s.branch_session_count : 0,
  }
}

// Cache keys for stale-while-revalidate loading of sessions / messages.
// All keys include the active profile name to isolate cache between profiles.
// Rendering from cache on boot avoids the multi-round-trip wait the user sees
// every time they open the page (esp. noticeable on mobile).
const STORAGE_KEY_PREFIX = 'hermes_active_session_'
const SESSIONS_CACHE_KEY_PREFIX = 'hermes_sessions_cache_v1_'
const BRIDGE_LOCAL_SESSION_KEY_PREFIX = 'hermes_bridge_local_session_v1_'
const BRIDGE_PERSISTENT_SESSION_KEY_PREFIX = 'hermes_bridge_persistent_session_v1_'
const BRIDGE_SEEN_KEY_PREFIX = 'hermes_bridge_seen_v1_'
const LEGACY_STORAGE_KEY = 'hermes_active_session'
const LEGACY_SESSIONS_CACHE_KEY = 'hermes_sessions_cache_v1'
const IN_FLIGHT_TTL_MS = 15 * 60 * 1000 // Give up after 15 minutes
const POLL_INTERVAL_MS = 2000
function isBridgeFallbackSession(detail: { source?: string; messages?: unknown[] } | null | undefined): boolean {
  return detail?.source === 'webui-bridge' && Array.isArray(detail.messages) && detail.messages.length === 0
}
const POLL_STABLE_EXITS = 3 // 3 × 2s = 6s of no change → assume run finished

// 获取当前 profile 名称，用于隔离缓存。
// 从 profiles store 的 activeProfileName（同步 localStorage）读取，
// 避免异步加载导致 chat store 初始化时拿到 null。
function getProfileName(): string {
  try {
    return useProfilesStore().activeProfileName || 'default'
  } catch {
    return 'default'
  }
}

function storageKey(): string { return STORAGE_KEY_PREFIX + getProfileName() }
function sessionsCacheKey(): string { return SESSIONS_CACHE_KEY_PREFIX + getProfileName() }
function bridgeLocalSessionKey(sid: string): string { return `${BRIDGE_LOCAL_SESSION_KEY_PREFIX}${getProfileName()}_${sid}` }
function bridgePersistentSessionKey(sid: string): string { return `${BRIDGE_PERSISTENT_SESSION_KEY_PREFIX}${getProfileName()}_${sid}` }
function bridgeSeenKey(): string { return BRIDGE_SEEN_KEY_PREFIX + getProfileName() }
function msgsCacheKey(sid: string): string { return `hermes_session_msgs_v1_${getProfileName()}_${sid}_` }
function inFlightKey(sid: string): string { return `hermes_in_flight_v1_${getProfileName()}_${sid}` }
function legacyStorageKey(): string | null { return getProfileName() === 'default' ? LEGACY_STORAGE_KEY : null }
function legacySessionsCacheKey(): string | null { return getProfileName() === 'default' ? LEGACY_SESSIONS_CACHE_KEY : null }
function legacyMsgsCacheKey(sid: string): string | null { return getProfileName() === 'default' ? `hermes_session_msgs_v1_${sid}` : null }
function legacyInFlightKey(sid: string): string | null { return getProfileName() === 'default' ? `hermes_in_flight_v1_${sid}` : null }

interface InFlightRun {
  runId: string
  startedAt: number
}

interface ApprovalState {
  pending: PendingApproval | null
  pendingCount: number
  visibleSince: number
  signature: string
  submitting: boolean
}

function loadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { name?: string, code?: number }
  return e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014
}

function recoverStorageQuota() {
  try {
    const prefixes = [
      sessionsCacheKey(),
      `hermes_session_msgs_v1_${getProfileName()}_`,
      `hermes_in_flight_v1_${getProfileName()}_`,
      `${BRIDGE_LOCAL_SESSION_KEY_PREFIX}${getProfileName()}_`,
      `${BRIDGE_PERSISTENT_SESSION_KEY_PREFIX}${getProfileName()}_`,
    ]
    const legacySessions = legacySessionsCacheKey()
    if (legacySessions) prefixes.push(legacySessions)
    if (getProfileName() === 'default') {
      prefixes.push('hermes_session_msgs_v1_')
      prefixes.push('hermes_in_flight_v1_')
    }
    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key) continue
      if (key === storageKey() || key === LEGACY_STORAGE_KEY) continue
      if (prefixes.some(prefix => key.startsWith(prefix))) {
        keysToRemove.push(key)
      }
    }
    keysToRemove.forEach(key => removeItem(key))
  } catch {
    // ignore
  }
}

function setItemBestEffort(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
    return
  } catch (error) {
    if (!isQuotaExceededError(error)) return
  }

  recoverStorageQuota()

  try {
    localStorage.setItem(key, value)
  } catch {
    // quota exceeded or private mode — ignore, cache is best-effort
  }
}

function saveJson(key: string, value: unknown) {
  try {
    setItemBestEffort(key, JSON.stringify(value))
  } catch {
    // quota exceeded or private mode — ignore, cache is best-effort
  }
}

function removeItem(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

function loadJsonWithFallback<T>(key: string, legacyKey?: string | null): T | null {
  const value = loadJson<T>(key)
  if (value != null) return value
  if (!legacyKey) return null
  return loadJson<T>(legacyKey)
}

function saveJsonWithLegacy(key: string, value: unknown, legacyKey?: string | null) {
  saveJson(key, value)
  if (legacyKey) removeItem(legacyKey)
}

function removeItemWithLegacy(key: string, legacyKey?: string | null) {
  removeItem(key)
  if (legacyKey) removeItem(legacyKey)
}

// Strip the circular `file: File` reference from attachments before caching —
// File objects don't serialize and we only need name/type/size/url for display.
function sanitizeForCache(msgs: Message[]): Message[] {
  return msgs.map(m => {
    if (!m.attachments?.length) return m
    return {
      ...m,
      attachments: m.attachments.map(a => ({ id: a.id, name: a.name, type: a.type, size: a.size, url: a.url })),
    }
  })
}

// Heals assistant messages whose `reasoning` field was polluted by the
// old bug where `reasoning.available` clobbered it with the assistant
// content. Detection heuristic: reasoning is a prefix of content (the
// bug always derived `reasoning` from `content[:500]` with tags stripped).
// Legitimate reasoning is almost never a prefix of the final answer.
function scrubBuggyReasoningInCache(msgs: Message[] | null | undefined): Message[] {
  if (!msgs) return []
  return msgs.map(m => {
    if (m.role !== 'assistant' || !m.reasoning || !m.content) return m
    const r = m.reasoning.trim()
    const c = m.content.trim()
    if (!r || !c) return m
    if (c === r || c.startsWith(r)) {
      const { reasoning: _drop, ...rest } = m
      return rest as Message
    }
    return m
  })
}

export const useChatStore = defineStore('chat', () => {
  const sessions = ref<Session[]>([])
  const activeSessionId = ref<string | null>(null)
  const focusMessageId = ref<string | null>(null)
  const streamStates = ref<Map<string, AbortController>>(new Map())
  const isStreaming = computed(() => activeSessionId.value != null && streamStates.value.has(activeSessionId.value))
  const isLoadingSessions = ref(false)
  const sessionsLoaded = ref(false)
  const isLoadingMessages = ref(false)
  // tmux-like resume state: true when we recovered an in-flight run from
  // localStorage after a refresh and are polling fetchSession for progress.
  // UI shows the thinking indicator while this is set.
  const resumingRuns = ref<Set<string>>(new Set())
  const isRunActive = computed(() =>
    isStreaming.value
    || (activeSessionId.value != null && resumingRuns.value.has(activeSessionId.value))
  )
  const pollTimers = new Map<string, ReturnType<typeof setInterval>>()
  const pollSignatures = new Map<string, { sig: string, stableTicks: number }>()
  const approvalsBySession = ref<Record<string, ApprovalState>>({})
  const dbBranchesBySession = ref<Record<string, ConversationBranch[]>>({})
  const liveBranchesBySession = ref<Record<string, ConversationBranch[]>>({})
  const approvalPollers = new Map<string, ReturnType<typeof setInterval>>()
  const dismissedApprovalSignatures = new Map<string, { signature: string, expiresAt: number }>()

  const activeSession = ref<Session | null>(null)
  const messages = computed<Message[]>(() => activeSession.value?.messages || [])
  const activeBranches = computed<ConversationBranch[]>(() => {
    const sid = activeSessionId.value
    if (!sid) return []
    const persisted = dbBranchesBySession.value[sid] || []
    return persisted.length ? persisted : (liveBranchesBySession.value[sid] || [])
  })
  const displayMessages = computed<Message[]>(() => messages.value)
  const activeApproval = computed<ApprovalState | null>(() => {
    const sid = activeSessionId.value
    if (!sid) return null
    return approvalsBySession.value[sid] || null
  })

  function isSessionLive(sessionId: string): boolean {
    return streamStates.value.has(sessionId) || resumingRuns.value.has(sessionId)
  }

  function countBranchTree(branches: ConversationBranch[]): number {
    return branches.reduce((sum, branch) => sum + 1 + countBranchTree(branch.branches || []), 0)
  }

  function findBranchById(branches: ConversationBranch[], branchId: string): ConversationBranch | null {
    for (const branch of branches) {
      if (branch.session_id === branchId) return branch
      const child = findBranchById(branch.branches || [], branchId)
      if (child) return child
    }
    return null
  }

  function sessionBranches(sessionId: string): ConversationBranch[] {
    const persisted = dbBranchesBySession.value[sessionId] || []
    return persisted.length ? persisted : (liveBranchesBySession.value[sessionId] || [])
  }

  function sessionBranchCount(sessionId: string): number {
    const loadedCount = countBranchTree(sessionBranches(sessionId))
    if (loadedCount > 0) return loadedCount
    return sessions.value.find(session => session.id === sessionId)?.branchSessionCount || 0
  }

  function branchMessagesToMessages(branch: ConversationBranch): Message[] {
    return branch.messages.map(message => ({
      id: String(message.id),
      role: message.role,
      content: message.content,
      timestamp: Math.round(message.timestamp * 1000),
    }))
  }

  function branchToSession(branch: ConversationBranch, rootSessionId: string): Session {
    return {
      id: branch.session_id,
      title: branch.title || branch.messages.find(message => message.content.trim())?.content.slice(0, 40) || branch.session_id,
      source: branch.source || undefined,
      messages: branchMessagesToMessages(branch),
      createdAt: Math.round(branch.started_at * 1000),
      updatedAt: Math.round((branch.last_active || branch.ended_at || branch.started_at) * 1000),
      model: branch.model,
      messageCount: branch.messages.length,
      endedAt: branch.ended_at != null ? Math.round(branch.ended_at * 1000) : null,
      lastActiveAt: branch.last_active != null ? Math.round(branch.last_active * 1000) : undefined,
      branchSessionCount: countBranchTree(branch.branches || []),
      parentSessionId: branch.parent_session_id,
      rootSessionId,
      isBranchSession: true,
    }
  }

  async function switchBranchSession(rootSessionId: string, branchId: string) {
    let branch = findBranchById(sessionBranches(rootSessionId), branchId)
    if (!branch) {
      await refreshSessionBranches(rootSessionId)
      branch = findBranchById(sessionBranches(rootSessionId), branchId)
    }
    if (branch) {
      const nextSession = branchToSession(branch, rootSessionId)
      const existing = sessions.value.find(session => session.id === branchId)
      if (existing) {
        existing.title = nextSession.title
        existing.source = nextSession.source
        existing.model = nextSession.model
        existing.messages = nextSession.messages
        existing.createdAt = nextSession.createdAt
        existing.updatedAt = nextSession.updatedAt
        existing.messageCount = nextSession.messageCount
        existing.endedAt = nextSession.endedAt
        existing.lastActiveAt = nextSession.lastActiveAt
        existing.branchSessionCount = nextSession.branchSessionCount
        existing.parentSessionId = nextSession.parentSessionId
        existing.rootSessionId = nextSession.rootSessionId
        existing.isBranchSession = true
      } else {
        sessions.value.push(nextSession)
      }
      persistSessionsList()
    }
    await switchSession(branchId)
  }

  function buildApprovalSignature(sessionId: string, pending: PendingApproval | null) {
    if (!pending) return ''
    return JSON.stringify({
      sid: sessionId,
      id: pending.approval_id || '',
      desc: pending.description || '',
      cmd: pending.command || '',
    })
  }

  function markApprovalDismissed(sessionId: string, pending: PendingApproval | null, ttlMs = 15000) {
    const signature = buildApprovalSignature(sessionId, pending)
    if (!signature) return
    dismissedApprovalSignatures.set(sessionId, {
      signature,
      expiresAt: Date.now() + ttlMs,
    })
  }

  function isDismissedApproval(sessionId: string, pending: PendingApproval | null) {
    const rec = dismissedApprovalSignatures.get(sessionId)
    if (!rec) return false
    if (rec.expiresAt <= Date.now()) {
      dismissedApprovalSignatures.delete(sessionId)
      return false
    }
    return rec.signature === buildApprovalSignature(sessionId, pending)
  }

  function clearDismissedApproval(sessionId: string) {
    dismissedApprovalSignatures.delete(sessionId)
  }

  function setApprovalPending(sessionId: string, pending: PendingApproval | null, pendingCount = 1) {
    if (!pending) {
      clearApproval(sessionId)
      clearDismissedApproval(sessionId)
      return
    }

    if (isDismissedApproval(sessionId, pending)) {
      return
    }

    clearDismissedApproval(sessionId)

    const prev = approvalsBySession.value[sessionId]
    const signature = buildApprovalSignature(sessionId, pending)
    approvalsBySession.value = {
      ...approvalsBySession.value,
      [sessionId]: {
        pending: { ...pending, _session_id: pending._session_id || sessionId },
        pendingCount,
        visibleSince: prev?.signature === signature ? prev.visibleSince : Date.now(),
        signature,
        submitting: false,
      },
    }
  }

  function clearApproval(sessionId: string) {
    const next = { ...approvalsBySession.value }
    delete next[sessionId]
    approvalsBySession.value = next
  }

  function maybeShowTerminalApprovalFallback(sessionId: string, toolMsg: Message) {
    const toolName = (toolMsg.toolName || '').toLowerCase()
    const preview = toolMsg.toolPreview || ''
    const looksLikeTerminal = toolName === 'terminal' || /^terminal\b/i.test(preview)
    if (!looksLikeTerminal) return

    window.setTimeout(() => {
      const msgs = getSessionMsgs(sessionId)
      const current = msgs.find(m => m.id === toolMsg.id)
      if (!current || current.toolStatus !== 'running') return
      if (approvalsBySession.value[sessionId]?.pending) return

      setApprovalPending(sessionId, {
        description: 'Terminal command is waiting for approval',
        command: extractApprovalCommandFromArgs(current.toolArgs) || extractCommandFromToolPreview(current.toolPreview),
        _session_id: sessionId,
        _optimistic: true,
      })
    }, 1200)
  }

  function shouldPreserveLiveApproval(sessionId: string) {
    const pending = approvalsBySession.value[sessionId]?.pending
    return !!pending && !pending._optimistic && (isSessionLive(sessionId) || !!readInFlight(sessionId))
  }

  function syncApprovalFromMessages(sessionId: string, messages: Message[]): boolean {
    const pending = extractPendingApprovalFromMessages(messages)
    if (!pending) {
      if (shouldPreserveLiveApproval(sessionId)) return false
      clearApproval(sessionId)
      return false
    }

    setApprovalPending(sessionId, {
      ...pending,
      _session_id: sessionId,
    })
    return true
  }

  async function pollApprovalOnce(sessionId: string) {
    try {
      const data = await getPendingApproval(sessionId)
      if (data.pending) {
        setApprovalPending(sessionId, data.pending, data.pending_count || 1)
      } else {
        if (approvalsBySession.value[sessionId]?.pending?._optimistic) return
        if (shouldPreserveLiveApproval(sessionId)) return
        clearApproval(sessionId)
      }
    } catch {
      // ignore transient polling errors
    }
  }

  function stopApprovalPolling(sessionId: string) {
    const timer = approvalPollers.get(sessionId)
    if (timer) {
      clearInterval(timer)
      approvalPollers.delete(sessionId)
    }
  }

  function startApprovalPolling(sessionId: string) {
    if (approvalPollers.has(sessionId)) return
    const timer = setInterval(() => {
      if (!isSessionLive(sessionId) && !readInFlight(sessionId)) {
        stopApprovalPolling(sessionId)
        return
      }
      void pollApprovalOnce(sessionId)
    }, 1500)
    approvalPollers.set(sessionId, timer)
  }

  async function respondApproval(choice: ApprovalChoice) {
    const sid = activeSessionId.value
    if (!sid) return
    const state = approvalsBySession.value[sid]
    if (!state?.pending) return

    if (state.pending._optimistic) {
      markApprovalDismissed(sid, state.pending)
      clearApproval(sid)
      return
    }

    approvalsBySession.value = {
      ...approvalsBySession.value,
      [sid]: {
        ...state,
        submitting: true,
      },
    }

    try {
      markApprovalDismissed(sid, state.pending)
      const result = await respondApprovalApi({
        session_id: sid,
        choice,
        approval_id: state.pending.approval_id,
      })
      clearApproval(sid)
      const resumedRunId = (result as any)?.run_id || (result as any)?.id
      if (resumedRunId) {
        attachRunStream(sid, resumedRunId)
      } else {
        await pollApprovalOnce(sid)
      }
    } catch (error) {
      clearDismissedApproval(sid)
      approvalsBySession.value = {
        ...approvalsBySession.value,
        [sid]: {
          ...state,
          submitting: false,
        },
      }
      throw error
    }
  }

  function persistSessionsList() {
    // Cache lightweight summaries only (messages are cached per-session).
    saveJsonWithLegacy(
      sessionsCacheKey(),
      sessions.value.map(s => ({ ...s, messages: [] })),
      legacySessionsCacheKey(),
    )
  }

  function persistActiveMessages() {
    const sid = activeSessionId.value
    if (!sid) return
    const s = sessions.value.find(sess => sess.id === sid)
    if (s) saveJsonWithLegacy(msgsCacheKey(sid), sanitizeForCache(s.messages), legacyMsgsCacheKey(sid))
  }

  function busyInputSteerEnabled() {
    return useSettingsStore().display.busy_input_mode === 'interrupt'
  }

  function withLocalSteeredMessages(mapped: Message[], current: Message[]): Message[] {
    const mappedUserTexts = new Set(mapped.filter(message => message.role === 'user').map(message => message.content.trim()).filter(Boolean))
    const localSteered = current.filter(message => message.steered && !mappedUserTexts.has(message.content.trim()))
    return localSteered.length ? [...mapped, ...localSteered] : mapped
  }

  async function steerBusyInput(sid: string, content: string, attachments?: Attachment[]) {
    const messageId = uid()
    let steerText = content.trim()
    const userMsg: Message = {
      id: messageId,
      role: 'user',
      content: steerText,
      timestamp: Date.now(),
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      steered: true,
    }
    addMessage(sid, userMsg)
    updateSessionTitle(sid)
    if (sid === activeSessionId.value) {
      persistActiveMessages()
      persistSessionsList()
    }

    try {
      if (attachments && attachments.length > 0) {
        const uploaded = await uploadFiles(attachments)
        const pathParts = uploaded.map(f => `[File: ${f.name}](${f.path})`)
        steerText = steerText ? steerText + '\n\n' + pathParts.join('\n') : pathParts.join('\n')
      }
      const result = await steerSession(sid, steerText)
      if (!result.ok) {
        updateMessage(sid, messageId, { steered: false })
        addMessage(sid, {
          id: uid(),
          role: 'system',
          content: `Error: /steer was not accepted (${result.status || 'unknown'}).`,
          timestamp: Date.now(),
        })
      }
    } catch (err: any) {
      updateMessage(sid, messageId, { steered: false })
      addMessage(sid, {
        id: uid(),
        role: 'system',
        content: `Error: ${err.message}`,
        timestamp: Date.now(),
      })
    } finally {
      if (sid === activeSessionId.value) persistActiveMessages()
    }
  }

  function markInFlight(sid: string, runId: string) {
    saveJsonWithLegacy(inFlightKey(sid), { runId, startedAt: Date.now() } as InFlightRun, legacyInFlightKey(sid))
  }

  function markBridgeModeSeen() {
    setItemBestEffort(bridgeSeenKey(), '1')
  }

  function shouldDefaultNewSessionToTui() {
    return localStorage.getItem(bridgeSeenKey()) === '1'
  }

  function markBridgeLocalSession(sid: string, persistentSessionId?: string) {
    setItemBestEffort(bridgeLocalSessionKey(sid), '1')
    markBridgeModeSeen()
    if (persistentSessionId && persistentSessionId !== sid) {
      setItemBestEffort(bridgePersistentSessionKey(sid), persistentSessionId)
    }
  }

  function clearBridgeLocalSession(sid: string) {
    removeItem(bridgeLocalSessionKey(sid))
    removeItem(bridgePersistentSessionKey(sid))
  }

  function isBridgeLocalSession(sid: string) {
    return localStorage.getItem(bridgeLocalSessionKey(sid)) === '1'
  }

  function readBridgePersistentSessionId(sid: string) {
    return localStorage.getItem(bridgePersistentSessionKey(sid)) || null
  }

  function clearInFlight(sid: string) {
    removeItemWithLegacy(inFlightKey(sid), legacyInFlightKey(sid))
  }

  function readInFlight(sid: string): InFlightRun | null {
    const rec = loadJsonWithFallback<InFlightRun>(inFlightKey(sid), legacyInFlightKey(sid))
    if (!rec) return null
    if (Date.now() - rec.startedAt > IN_FLIGHT_TTL_MS) {
      removeItemWithLegacy(inFlightKey(sid), legacyInFlightKey(sid))
      return null
    }
    return rec
  }

  function sessionFetchId(sid: string): string {
    return readBridgePersistentSessionId(sid) || sid
  }

  function resumeInFlightRun(sid: string): boolean {
    const inFlight = readInFlight(sid)
    if (!inFlight || streamStates.value.has(sid)) return false
    if (inFlight.runId.startsWith('bridge_run_')) {
      attachRunStream(sid, inFlight.runId)
      return true
    }
    startPolling(sid)
    return true
  }

  function compareServerMessages(local: Message[], server: Message[]) {
    const userTurnIndexes = (messages: Message[]) =>
      messages.map((m, i) => (m.role === 'user' && !m.queued && !m.steered ? i : -1)).filter(i => i >= 0)
    const localUserIndexes = userTurnIndexes(local)
    const serverUserIndexes = userTurnIndexes(server)
    const localUsers = localUserIndexes.length
    const serverUsers = serverUserIndexes.length

    if (serverUsers > localUsers) return { serverIsCaughtUp: true, serverIsAhead: true }
    if (serverUsers < localUsers) return { serverIsCaughtUp: false, serverIsAhead: false }

    const localLastUserIndex = localUserIndexes[localUserIndexes.length - 1] ?? -1
    const serverLastUserIndex = serverUserIndexes[serverUserIndexes.length - 1] ?? -1
    const sameCurrentTurn =
      localLastUserIndex < 0
      || serverLastUserIndex < 0
      || local[localLastUserIndex]?.content === server[serverLastUserIndex]?.content

    if (!sameCurrentTurn) return { serverIsCaughtUp: false, serverIsAhead: false }

    const localCurrentAssistantLen = local
      .slice(localLastUserIndex + 1)
      .filter(m => m.role === 'assistant')
      .reduce((total, m) => total + (m.content?.length || 0), 0)
    const serverCurrentAssistantLen = server
      .slice(serverLastUserIndex + 1)
      .filter(m => m.role === 'assistant')
      .reduce((total, m) => total + (m.content?.length || 0), 0)

    return {
      serverIsCaughtUp: true,
      serverIsAhead: serverCurrentAssistantLen >= localCurrentAssistantLen,
    }
  }

  function stopPolling(sid: string) {
    const t = pollTimers.get(sid)
    if (t) {
      clearInterval(t)
      pollTimers.delete(sid)
    }
    pollSignatures.delete(sid)
    resumingRuns.value = new Set([...resumingRuns.value].filter(x => x !== sid))
  }

  // Poll fetchSession while an in-flight run is recovering. Exits when the
  // server's message signature is stable for POLL_STABLE_EXITS ticks (run
  // presumed done), TTL elapses, or the user explicitly starts streaming.
  function startPolling(sid: string) {
    if (pollTimers.has(sid)) return
    resumingRuns.value = new Set([...resumingRuns.value, sid])
    const timer = setInterval(async () => {
      // If a fresh SSE stream started for this session, polling is redundant.
      if (streamStates.value.has(sid)) {
        stopPolling(sid)
        return
      }
      const inFlight = readInFlight(sid)
      if (!inFlight) {
        stopPolling(sid)
        return
      }
      try {
        const detail = await fetchSession(sessionFetchId(sid))
        if (!detail) return
        const target = sessions.value.find(s => s.id === sid)
        if (!target) return
        if (isBridgeFallbackSession(detail) && target.messages.length > 0) return
        const mapped = mapHermesMessages(detail.messages || [])
        // Use the same current-turn comparison as switchSession: server is
        // ahead only when it has a newer user turn or the assistant output
        // after the current user turn has caught up.
        const local = target.messages
        const { serverIsAhead, serverIsCaughtUp } = compareServerMessages(local, mapped)
        if (serverIsAhead) {
          target.messages = withLocalSteeredMessages(mapped, target.messages)
          if (detail.title && !target.title) target.title = detail.title
          if (sid === activeSessionId.value) persistActiveMessages()
        }
        void refreshSessionBranches(sid)
        syncApprovalFromMessages(sid, target.messages)
        // Stability detection ONLY matters when the server has at least as
        // many user turns as we do. Otherwise the server is still catching
        // up (e.g. the new turn we just sent hasn't been flushed server-side
        // yet) and a "stable" signature is a false positive — the stability
        // is the server NOT having our latest turn, not the run being done.
        if (!serverIsCaughtUp) {
          pollSignatures.delete(sid)
        } else {
          const last = mapped[mapped.length - 1]
          const sig = `${mapped.length}|${last?.content?.slice(-40) || ''}|${last?.toolStatus || ''}`
          const prev = pollSignatures.get(sid)
          if (prev && prev.sig === sig) {
            prev.stableTicks += 1
            if (prev.stableTicks >= POLL_STABLE_EXITS) {
              // The server view has stopped changing. If it is still behind
              // the locally streamed assistant reply, end recovery without
              // retreating local state; otherwise commit the server view.
              if (serverIsAhead) {
                target.messages = withLocalSteeredMessages(mapped, target.messages)
                if (detail.title) target.title = detail.title
                if (sid === activeSessionId.value) persistActiveMessages()
              }
              clearInFlight(sid)
              stopPolling(sid)
            }
          } else {
            pollSignatures.set(sid, { sig, stableTicks: 0 })
          }
        }
      } catch {
        // transient network error — ignore, next tick tries again
      }
    }, POLL_INTERVAL_MS)
    pollTimers.set(sid, timer)
  }

  async function loadSessions() {
    isLoadingSessions.value = true
    try {
      // 从 profile 对应的缓存中恢复，实现 instant render
      const cachedSessions = loadJsonWithFallback<Session[]>(sessionsCacheKey(), legacySessionsCacheKey())
      if (cachedSessions?.length) {
        sessions.value = cachedSessions
        const savedId = localStorage.getItem(storageKey()) || (legacyStorageKey() ? localStorage.getItem(legacyStorageKey()!) : null)
        if (savedId) {
          const cachedActive = cachedSessions.find(s => s.id === savedId) || null
          if (cachedActive) {
            const cachedMsgs = loadJsonWithFallback<Message[]>(msgsCacheKey(savedId), legacyMsgsCacheKey(savedId))
            if (cachedMsgs) cachedActive.messages = scrubBuggyReasoningInCache(cachedMsgs)
            activeSession.value = cachedActive
            activeSessionId.value = savedId
          }
        }
      }

      let list: Array<SessionSummary | ConversationSummary>
      try {
        list = await fetchConversationSummaries({ humanOnly: true })
      } catch {
        list = await fetchSessions()
      }
      const freshRaw = list.map(mapHermesSession)
      const freshRawIds = new Set(freshRaw.map(s => s.id))
      // Preserve already-loaded messages for sessions that are still present,
      // so we don't blow away the active session's messages on refresh.
      const msgsByIdBefore = new Map(sessions.value.map(s => [s.id, s.messages]))
      const bridgeLocalByPersistent = new Map<string, Session>()
      for (const s of sessions.value) {
        const persistentId = readBridgePersistentSessionId(s.id)
        if (persistentId) bridgeLocalByPersistent.set(persistentId, s)
      }
      const isLocalRunActive = (sid: string) =>
        streamStates.value.has(sid) || resumingRuns.value.has(sid) || !!readInFlight(sid)
      const fresh = freshRaw.filter(s => {
        const localBridge = bridgeLocalByPersistent.get(s.id)
        return !(localBridge && isLocalRunActive(localBridge.id))
      })
      const freshIds = new Set(fresh.map(s => s.id))
      for (const s of fresh) {
        const prev = msgsByIdBefore.get(s.id)
        const localBridge = bridgeLocalByPersistent.get(s.id)
        const localBridgeMessages = localBridge ? msgsByIdBefore.get(localBridge.id) || localBridge.messages : null
        if (prev && prev.length) {
          s.messages = prev
        } else if (localBridgeMessages?.length) {
          s.messages = localBridgeMessages
          saveJsonWithLegacy(msgsCacheKey(s.id), sanitizeForCache(localBridgeMessages), legacyMsgsCacheKey(s.id))
        }
      }
      // Preserve local-only sessions the server hasn't seen yet — e.g. a chat
      // that was just created and whose first run is still in-flight. Without
      // this, refreshing mid-run would wipe the session and fall back to
      // sessions[0], which is exactly what the user reported.
      // Sessions without an active in-flight run are considered deleted and
      // cleaned up along with their cached messages.
      const localOnly = sessions.value.filter(s => {
        if (freshIds.has(s.id)) return false
        const persistentId = readBridgePersistentSessionId(s.id)
        if (persistentId && freshRawIds.has(persistentId)) {
          if (isLocalRunActive(s.id)) return true
          if (activeSessionId.value === s.id) {
            activeSessionId.value = persistentId
            setItemBestEffort(storageKey(), persistentId)
          }
          removeItemWithLegacy(msgsCacheKey(s.id), legacyMsgsCacheKey(s.id))
          removeItemWithLegacy(inFlightKey(s.id), legacyInFlightKey(s.id))
          clearBridgeLocalSession(s.id)
          return false
        }
        if (readInFlight(s.id)) return true
        if (isBridgeLocalSession(s.id)) return true
        if (s.isBranchSession) return true
        // Session no longer exists on server and no active run — clean up cache
        removeItemWithLegacy(msgsCacheKey(s.id), legacyMsgsCacheKey(s.id))
        removeItemWithLegacy(inFlightKey(s.id), legacyInFlightKey(s.id))
        clearBridgeLocalSession(s.id)
        return false
      })
      sessions.value = [...localOnly, ...fresh]
      persistSessionsList()

      // Restore last active session, fallback to most recent
      const savedId = activeSessionId.value
      const targetId = savedId && sessions.value.some(s => s.id === savedId)
        ? savedId
        : sessions.value[0]?.id
      if (targetId) {
        await switchSession(targetId)
      }
    } catch (err) {
      console.error('Failed to load sessions:', err)
    } finally {
      isLoadingSessions.value = false
      sessionsLoaded.value = true
    }
  }

  // Re-pull active session from server without retreating newer locally
  // streamed output. Used on SSE drop and on tab-visible events — mobile
  // browsers kill EventSource while backgrounded, but the backend run usually
  // completes anyway.
  async function refreshActiveSession(): Promise<boolean> {
    const sid = activeSessionId.value
    if (!sid) return false
    try {
      const detail = await fetchSession(sessionFetchId(sid))
      if (!detail) return false
      const target = sessions.value.find(s => s.id === sid)
      if (!target) return false
      if (isBridgeFallbackSession(detail) && target.messages.length > 0) return true
      const mapped = mapHermesMessages(detail.messages || [])
      const { serverIsAhead } = compareServerMessages(target.messages, mapped)
      if (serverIsAhead) {
        target.messages = withLocalSteeredMessages(mapped, target.messages)
        persistActiveMessages()
      }
      void refreshSessionBranches(sid)
      if (isSessionLive(sid) || readInFlight(sid)) {
        syncApprovalFromMessages(sid, target.messages)
      } else {
        const pendingState = await getPendingApproval(sid)
        if (pendingState.pending) {
          setApprovalPending(sid, {
            ...pendingState.pending,
            _session_id: sid,
          }, pendingState.pending_count || 1)
        } else {
          clearApproval(sid)
        }
      }
      if (detail.title) target.title = detail.title
      return true
    } catch (err) {
      console.error('Failed to refresh active session:', err)
      return false
    }
  }


  function attachRunStream(sid: string, runId: string) {
    markInFlight(sid, runId)
    stopPolling(sid)
    stopApprovalPolling(sid)
    clearApproval(sid)

    // Proactively poll approval state even during the live SSE run. This covers
    // gateways/upstreams that delay or omit a named `approval` SSE event; the UI
    // should surface the approval card as soon as the session enters that state,
    // not only after the round finishes and we later rehydrate from history.
    void pollApprovalOnce(sid)
    startApprovalPolling(sid)

    const cleanup = () => {
      streamStates.value.delete(sid)
      if (persistTimer) {
        clearTimeout(persistTimer)
        persistTimer = null
      }
      if (branchRefreshTimer) {
        clearInterval(branchRefreshTimer)
        branchRefreshTimer = null
      }
    }

    let persistTimer: ReturnType<typeof setTimeout> | null = null
    let branchRefreshTimer: ReturnType<typeof setInterval> | null = null
    let runProducedAssistantText = false
    let runHadToolActivity = false
    const schedulePersist = () => {
      if (sid !== activeSessionId.value || persistTimer) return
      persistTimer = setTimeout(() => {
        persistTimer = null
        persistActiveMessages()
      }, 800)
    }

    if (runId.startsWith('bridge_run_')) {
      void refreshSessionBranches(sid)
      branchRefreshTimer = setInterval(() => {
        void refreshSessionBranches(sid)
      }, 3000)
    }

    const ctrl = streamRunEvents(
      runId,
      (evt: RunEvent) => {
        switch (evt.event) {
          case 'run.started':
            break

          case 'subagent.spawn_requested':
          case 'subagent.start':
          case 'subagent.thinking':
          case 'subagent.progress':
          case 'subagent.status':
          case 'subagent.tool':
          case 'subagent.complete':
          case 'subagent.error': {
            runHadToolActivity = true
            const msgs = getSessionMsgs(sid)
            const last = msgs[msgs.length - 1]
            if (last?.isStreaming) {
              updateMessage(sid, last.id, { isStreaming: false })
            }
            upsertSubagentBranch(sid, evt)
            break
          }

          case 'approval': {
            setApprovalPending(sid, {
              approval_id: evt.approval_id,
              description: evt.description,
              command: evt.command,
              pattern_key: evt.pattern_key,
              pattern_keys: evt.pattern_keys,
              _session_id: sid,
            }, evt.pending_count || 1)
            startApprovalPolling(sid)
            break
          }

          case 'reasoning.delta':
          case 'thinking.delta': {
            const text = textFromRunEvent(evt)
            if (!text) break
            runProducedAssistantText = true
            const msgs = getSessionMsgs(sid)
            const last = msgs[msgs.length - 1]
            if (last?.role === 'assistant' && last.isStreaming) {
              updateMessage(sid, last.id, { reasoning: (last.reasoning || '') + text })
              noteReasoningStart(last.id)
            } else {
              const newId = uid()
              addMessage(sid, {
                id: newId,
                role: 'assistant',
                content: '',
                timestamp: Date.now(),
                isStreaming: true,
                reasoning: text,
              })
              noteReasoningStart(newId)
            }
            schedulePersist()
            break
          }

          case 'reasoning.available': {
            const text = textFromRunEvent(evt)
            const msgs = getSessionMsgs(sid)
            const last = msgs[msgs.length - 1]
            if (last?.role === 'assistant' && last.isStreaming) {
              const shouldAppendReasoning = text
                && (!last.reasoning || !last.reasoning.includes(text))
                && !isBuggyReasoningPreview(text, last.content || '')
              if (shouldAppendReasoning) {
                updateMessage(sid, last.id, {
                  reasoning: last.reasoning ? `${last.reasoning}\n\n${text}` : text,
                })
              }
              noteReasoningEnd(last.id)
            } else if (text) {
              const newId = uid()
              addMessage(sid, {
                id: newId,
                role: 'assistant',
                content: '',
                timestamp: Date.now(),
                isStreaming: true,
                reasoning: text,
              })
              noteReasoningStart(newId)
              noteReasoningEnd(newId)
            }
            schedulePersist()
            break
          }

          case 'message.delta': {
            if (evt.delta) runProducedAssistantText = true
            const msgs = getSessionMsgs(sid)
            const last = msgs[msgs.length - 1]
            if (last?.role === 'assistant' && last.isStreaming) {
              const prev = last.content
              const next = prev + (evt.delta || '')
              noteThinkingDelta(last.id, prev, next)
              if (last.reasoning) noteReasoningEnd(last.id)
              updateMessage(sid, last.id, { content: next })
            } else {
              const newId = uid()
              const nextContent = evt.delta || ''
              noteThinkingDelta(newId, '', nextContent)
              addMessage(sid, {
                id: newId,
                role: 'assistant',
                content: nextContent,
                timestamp: Date.now(),
                isStreaming: true,
              })
            }
            schedulePersist()
            break
          }

          case 'tool.started': {
            runHadToolActivity = true
            const msgs = getSessionMsgs(sid)
            const last = msgs[msgs.length - 1]
            if (last?.isStreaming) {
              updateMessage(sid, last.id, { isStreaming: false })
            }
            const toolMessage: Message = {
              id: uid(),
              role: 'tool',
              content: '',
              timestamp: Date.now(),
              toolName: evt.tool || evt.name,
              toolPreview: evt.preview,
              toolStatus: 'running',
            }
            addMessage(sid, toolMessage)
            maybeShowTerminalApprovalFallback(sid, toolMessage)
            schedulePersist()
            break
          }

          case 'tool.completed': {
            runHadToolActivity = true
            const msgs = getSessionMsgs(sid)
            const toolMsgs = msgs.filter(
              m => m.role === 'tool' && m.toolStatus === 'running',
            )
            if (toolMsgs.length > 0) {
              const last = toolMsgs[toolMsgs.length - 1]
              updateMessage(sid, last.id, { toolStatus: 'done' })
            }
            if (approvalsBySession.value[sid]?.pending?._optimistic) {
              clearApproval(sid)
            }
            schedulePersist()
            break
          }

          case 'run.completed': {
            const msgs = getSessionMsgs(sid)
            const lastMsg = msgs[msgs.length - 1]
            if (lastMsg?.isStreaming) {
              updateMessage(sid, lastMsg.id, { isStreaming: false })
            }
            if (evt.usage) {
              const target = sessions.value.find(s => s.id === sid)
              if (target) {
                target.inputTokens = evt.usage.input_tokens
                target.outputTokens = evt.usage.output_tokens
              }
            }
            const finalOutput = typeof evt.output === 'string' ? evt.output : ''
            const finalOutputTrimmed = finalOutput.trim()
            if (!runProducedAssistantText && finalOutputTrimmed !== '') {
              addMessage(sid, {
                id: uid(),
                role: 'assistant',
                content: finalOutput,
                timestamp: Date.now(),
              })
              runProducedAssistantText = true
            }
            const swallowedError = !runProducedAssistantText && !runHadToolActivity && finalOutputTrimmed === ''
            if (swallowedError) {
              addMessage(sid, {
                id: uid(),
                role: 'system',
                content: 'Error: Agent returned no output. The model call may have failed (e.g. invalid API key, model not supported by provider, or context exceeded). Check the hermes-agent logs for details.',
                timestamp: Date.now(),
              })
            }
            cleanup()
            updateSessionTitle(sid)
            if (sid === activeSessionId.value) persistActiveMessages()
            clearInFlight(sid)
            stopPolling(sid)
            stopApprovalPolling(sid)
            clearApproval(sid)
            if (sid === activeSessionId.value) {
              void refreshActiveSession().finally(() => {
                void refreshSessionBranches(sid)
              })
            } else {
              void refreshSessionBranches(sid)
            }
            break
          }

          case 'run.failed': {
            const msgs = getSessionMsgs(sid)
            const lastErr = msgs[msgs.length - 1]
            if (lastErr?.isStreaming) {
              updateMessage(sid, lastErr.id, {
                isStreaming: false,
                content: evt.error ? `Error: ${evt.error}` : 'Run failed',
                role: 'system',
              })
            } else {
              addMessage(sid, {
                id: uid(),
                role: 'system',
                content: evt.error ? `Error: ${evt.error}` : 'Run failed',
                timestamp: Date.now(),
              })
            }
            msgs.forEach((m, i) => {
              if (m.role === 'tool' && m.toolStatus === 'running') {
                msgs[i] = { ...m, toolStatus: 'error' }
              }
            })
            if (approvalsBySession.value[sid]?.pending?._optimistic) {
              clearApproval(sid)
            }
            cleanup()
            if (sid === activeSessionId.value) persistActiveMessages()
            clearInFlight(sid)
            stopPolling(sid)
            stopApprovalPolling(sid)
            clearApproval(sid)
            break
          }
        }
      },
      () => {
        const msgs = getSessionMsgs(sid)
        const last = msgs[msgs.length - 1]
        if (last?.isStreaming) {
          updateMessage(sid, last.id, { isStreaming: false })
        }
        cleanup()
        updateSessionTitle(sid)
        clearInFlight(sid)
        stopPolling(sid)
        stopApprovalPolling(sid)
        clearApproval(sid)
        if (sid === activeSessionId.value) persistActiveMessages()
      },
      (err) => {
        console.warn('SSE connection dropped, resyncing from server:', err.message)
        const msgs = getSessionMsgs(sid)
        const last = msgs[msgs.length - 1]
        if (last?.isStreaming) {
          updateMessage(sid, last.id, { isStreaming: false })
        }
        msgs.forEach((m, i) => {
          if (m.role === 'tool' && m.toolStatus === 'running') {
            msgs[i] = { ...m, toolStatus: 'done' }
          }
        })
        cleanup()
        if (sid === activeSessionId.value) {
          void refreshActiveSession()
        }
        if (readInFlight(sid)) {
          startPolling(sid)
          void pollApprovalOnce(sid)
          startApprovalPolling(sid)
        }
      },
    )

    streamStates.value.set(sid, ctrl)
  }


  function createSession(): Session {
    const session: Session = {
      id: uid(),
      title: '',
      source: shouldDefaultNewSessionToTui() ? 'tui' : 'api_server',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    sessions.value.unshift(session)
    // Persist immediately so a refresh before run.completed can still find
    // this session in the cache.
    persistSessionsList()
    return session
  }

  async function switchSession(sessionId: string, focusId?: string | null) {
    clearThinkingObservationFor(sessionId)
    activeSessionId.value = sessionId
    focusMessageId.value = focusId ?? null
    setItemBestEffort(storageKey(), sessionId)
    const legacyActiveKey = legacyStorageKey()
    if (legacyActiveKey) removeItem(legacyActiveKey)
    activeSession.value = sessions.value.find(s => s.id === sessionId) || null

    if (!activeSession.value) return

    // Hydrate messages from localStorage cache first (instant render), then
    // revalidate from server in the background. If no cache exists, show the
    // loading state while we fetch.
    const hasLocalMessages = activeSession.value.messages.length > 0
    if (!hasLocalMessages) {
      const cachedMsgs = loadJsonWithFallback<Message[]>(msgsCacheKey(sessionId), legacyMsgsCacheKey(sessionId))
      if (cachedMsgs?.length) {
        activeSession.value.messages = scrubBuggyReasoningInCache(cachedMsgs)
      }
    }

    const needsBlockingLoad = activeSession.value.messages.length === 0
    if (needsBlockingLoad) isLoadingMessages.value = true

    try {
      const detail = await fetchSession(sessionFetchId(sessionId))
      if (detail && detail.messages) {
        if (isBridgeFallbackSession(detail) && activeSession.value.messages.length > 0) return
        const mapped = mapHermesMessages(detail.messages)
        // Pick whichever view has more information for the current turn.
        // Simple message-count comparison is wrong because mapHermesMessages
        // folds tool_call-only assistant messages; global last-assistant
        // comparison is also wrong across turns. Trust server only when it has
        // a newer user turn or its assistant output after the current user turn
        // has caught up.
        const local = activeSession.value.messages
        const { serverIsAhead } = compareServerMessages(local, mapped)
        if (serverIsAhead) {
          activeSession.value.messages = withLocalSteeredMessages(mapped, activeSession.value.messages)
        }
        void refreshSessionBranches(sessionId)
        if (isSessionLive(sessionId) || readInFlight(sessionId)) {
          syncApprovalFromMessages(sessionId, activeSession.value.messages)
        } else {
          const pendingState = await getPendingApproval(sessionId)
          if (pendingState.pending) {
            setApprovalPending(sessionId, {
              ...pendingState.pending,
              _session_id: sessionId,
            }, pendingState.pending_count || 1)
          } else {
            clearApproval(sessionId)
          }
        }
        // Update title: use Hermes title, or fallback to first user message
        if (detail.title) {
          activeSession.value.title = detail.title
        } else if (!activeSession.value.title) {
          const firstUser = (activeSession.value.messages).find(m => m.role === 'user' && !m.steered)
          if (firstUser) {
            const t = firstUser.content.slice(0, 40)
            activeSession.value.title = t + (firstUser.content.length > 40 ? '...' : '')
          }
        }
        persistActiveMessages()
      }
    } catch (err) {
      console.error('Failed to load session messages:', err)
    } finally {
      isLoadingMessages.value = false
    }

    // tmux-like resume: if this session has a recent in-flight run and we're
    // not currently streaming, start polling fetchSession to pick up progress
    // that happened while we were gone. Exits automatically on stability.
    if (readInFlight(sessionId) && !streamStates.value.has(sessionId)) {
      resumeInFlightRun(sessionId)
      void pollApprovalOnce(sessionId)
      startApprovalPolling(sessionId)
    }

    // Fetch token usage for this session from web-ui DB
    try {
      const usage = await fetchSessionUsageSingle(sessionId)
      if (usage) {
        activeSession.value.inputTokens = usage.input_tokens
        activeSession.value.outputTokens = usage.output_tokens
      }
    } catch { /* non-critical */ }
  }

  function newChat() {
    if (isStreaming.value) return
    const session = createSession()
    // Inherit current global model
    const appStore = useAppStore()
    session.model = appStore.selectedModel || undefined
    switchSession(session.id)
  }

  async function switchSessionModel(modelId: string, provider?: string) {
    if (!activeSession.value) return
    activeSession.value.model = modelId
    activeSession.value.provider = provider || ''
    // If provider changed, update global config too (Hermes requires it)
    if (provider) {
      const { useAppStore } = await import('./app')
      await useAppStore().switchModel(modelId, provider)
    }
  }

  async function deleteSession(sessionId: string) {
    await deleteSessionApi(sessionId)
    sessions.value = sessions.value.filter(s => s.id !== sessionId)
    removeItemWithLegacy(msgsCacheKey(sessionId), legacyMsgsCacheKey(sessionId))
    clearInFlight(sessionId)
    clearBridgeLocalSession(sessionId)
    stopPolling(sessionId)
    stopApprovalPolling(sessionId)
    clearApproval(sessionId)
    persistSessionsList()
    if (activeSessionId.value === sessionId) {
      if (sessions.value.length > 0) {
        await switchSession(sessions.value[0].id)
      } else {
        const session = createSession()
        switchSession(session.id)
      }
    }
  }

  function getSessionMsgs(sessionId: string): Message[] {
    const s = sessions.value.find(s => s.id === sessionId)
    return s?.messages || []
  }

  function addMessage(sessionId: string, msg: Message) {
    const s = sessions.value.find(s => s.id === sessionId)
    if (s) s.messages.push(msg)
  }

  function updateMessage(sessionId: string, id: string, update: Partial<Message>) {
    const s = sessions.value.find(s => s.id === sessionId)
    if (!s) return
    const idx = s.messages.findIndex(m => m.id === id)
    if (idx !== -1) {
      s.messages[idx] = { ...s.messages[idx], ...update }
    }
  }

  function updateSessionTitle(sessionId: string) {
    const target = sessions.value.find(s => s.id === sessionId)
    if (!target) return
    if (!target.title) {
      const firstUser = target.messages.find(m => m.role === 'user' && !m.steered)
      if (firstUser) {
        const title = firstUser.attachments?.length
          ? firstUser.attachments.map(a => a.name).join(', ')
          : firstUser.content
        target.title = title.slice(0, 40) + (title.length > 40 ? '...' : '')
      }
    }
    target.updatedAt = Date.now()
  }

  function textFromOutputTail(items: Array<Record<string, unknown>> | undefined): string {
    if (!Array.isArray(items) || items.length === 0) return ''
    return items
      .map(item => {
        const role = typeof item.role === 'string' ? `${item.role}: ` : ''
        const content = item.content ?? item.text ?? item.summary ?? ''
        return `${role}${typeof content === 'string' ? content : JSON.stringify(content)}`
      })
      .filter(Boolean)
      .join('\n')
  }

  function formatSubagentResult(evt: RunEvent): string | undefined {
    const lines: string[] = []
    if (evt.summary) lines.push(evt.summary)
    const tail = textFromOutputTail(evt.output_tail)
    if (tail) lines.push(tail)
    const usage = [
      evt.input_tokens != null ? `input=${evt.input_tokens}` : '',
      evt.output_tokens != null ? `output=${evt.output_tokens}` : '',
      evt.reasoning_tokens != null ? `reasoning=${evt.reasoning_tokens}` : '',
      evt.api_calls != null ? `api_calls=${evt.api_calls}` : '',
      evt.cost_usd != null ? `cost=$${evt.cost_usd}` : '',
    ].filter(Boolean).join(', ')
    if (usage) lines.push(usage)
    if (evt.files_read?.length) lines.push(`files_read: ${evt.files_read.join(', ')}`)
    if (evt.files_written?.length) lines.push(`files_written: ${evt.files_written.join(', ')}`)
    return lines.join('\n\n') || undefined
  }

  async function refreshSessionBranches(sid: string) {
    const fetchId = sessionFetchId(sid)
    if (!fetchId) return
    try {
      const detail = await fetchConversationDetail(fetchId, { humanOnly: true })
      dbBranchesBySession.value = {
        ...dbBranchesBySession.value,
        [sid]: detail.branches || [],
      }
    } catch {
      // Branch detail is best-effort; normal chat streaming must not depend on it.
    }
  }

  function upsertSubagentBranch(sessionId: string, evt: RunEvent) {
    const subagentId = evt.subagent_id || `${evt.parent_id || 'root'}:${evt.task_index ?? 0}:${evt.goal || evt.event}`
    const depth = Math.max(0, Number(evt.depth || 0))
    const status = evt.status || evt.event.replace(/^subagent\./, '')
    const goal = evt.goal || evt.summary || evt.text || 'Subagent'
    const preview = evt.tool_preview || evt.text || evt.summary || goal
    const result = formatSubagentResult(evt)
    const now = Date.now() / 1000
    const existingBranches = liveBranchesBySession.value[sessionId] || []
    const existing = existingBranches.find(branch => branch.session_id === subagentId)
    const content = result || `[${status}] ${preview}`
    const eventMessage: ConversationMessage = {
      id: evt.event,
      session_id: subagentId,
      role: evt.event === 'subagent.spawn_requested' || evt.event === 'subagent.start' ? 'user' : 'assistant',
      content,
      timestamp: now,
    }
    const previousMessages = existing?.messages || []
    const messages = [
      ...previousMessages.filter(message => message.id !== eventMessage.id),
      eventMessage,
    ].sort((a, b) => a.timestamp - b.timestamp)
    const branch: ConversationBranch = {
      session_id: subagentId,
      parent_session_id: evt.parent_id || sessionFetchId(sessionId),
      source: 'subagent',
      model: evt.model || '',
      title: depth > 0 ? `Subagent L${depth}: ${goal}` : goal,
      started_at: existing?.started_at || now,
      ended_at: evt.event === 'subagent.complete' || evt.event === 'subagent.error' ? now : null,
      last_active: now,
      is_active: evt.event !== 'subagent.complete' && evt.event !== 'subagent.error',
      messages,
      visible_count: messages.length,
      thread_session_count: 1,
      branches: existing?.branches || [],
    }
    liveBranchesBySession.value = {
      ...liveBranchesBySession.value,
      [sessionId]: existing
        ? existingBranches.map(item => item.session_id === subagentId ? branch : item)
        : [...existingBranches, branch],
    }
    void refreshSessionBranches(sessionId)
  }

  async function submitMessage(sid: string, content: string, attachments?: Attachment[], existingUserMessageId?: string) {
    let userMessageId = existingUserMessageId
    if (existingUserMessageId) {
      updateMessage(sid, existingUserMessageId, { queued: false, timestamp: Date.now() })
    } else {
      const userMsg: Message = {
        id: uid(),
        role: 'user',
        content: content.trim(),
        timestamp: Date.now(),
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
      }
      userMessageId = userMsg.id
      addMessage(sid, userMsg)
    }
    updateSessionTitle(sid)
    // Persist immediately so a refresh before the first SSE event (e.g. the
    // user closes the tab right after sending) still has the user's message
    // and session title in the cache.
    if (sid === activeSessionId.value) {
      persistActiveMessages()
      persistSessionsList()
    }

    try {
      // Build conversation history from past messages
      const sessionMsgs = getSessionMsgs(sid)
      const history: ChatMessage[] = sessionMsgs
        .filter(m => !m.queued && !m.steered && (m.role === 'user' || m.role === 'assistant') && m.content.trim())
        .map(m => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content }))

      // Upload attachments and build input with file paths
      let inputText = content.trim()
      if (attachments && attachments.length > 0) {
        const uploaded = await uploadFiles(attachments)
        // Replace blob URLs with persistent download URLs on the user message
        const token = getApiKey()
        const urlMap = new Map(uploaded.map(f => {
          const base = `/api/hermes/download?path=${encodeURIComponent(f.path)}&name=${encodeURIComponent(f.name)}`
          return [f.name, token ? `${base}&token=${encodeURIComponent(token)}` : base]
        }))
        const msgs = getSessionMsgs(sid)
        const lastUser = userMessageId ? msgs.findLast(m => m.id === userMessageId) : undefined
        if (lastUser?.attachments) {
          lastUser.attachments = lastUser.attachments.map(a => {
            const dl = urlMap.get(a.name)
            return dl ? { ...a, url: dl } : a
          })
        }
        if (sid === activeSessionId.value) persistActiveMessages()
        const pathParts = uploaded.map(f => `[File: ${f.name}](${urlMap.get(f.name)})`)
        inputText = inputText ? inputText + '\n\n' + pathParts.join('\n') : pathParts.join('\n')
      }

      const appStore = useAppStore()
      const target = sessions.value.find(s => s.id === sid)
      const sessionModel = target?.model || activeSession.value?.model || appStore.selectedModel
      const run = await startRun({
        input: inputText,
        conversation_history: history,
        session_id: sid,
        model: sessionModel || undefined,
      })

      const runId = (run as any).run_id || (run as any).id
      if (!runId) {
        addMessage(sid, {
          id: uid(),
          role: 'system',
          content: `Error: startRun returned no run ID. Response: ${JSON.stringify(run)}`,
          timestamp: Date.now(),
        })
        return
      }

      if ((run as any).bridge) {
        const target = sessions.value.find(s => s.id === sid)
        if (target) target.source = 'tui'
        markBridgeLocalSession(sid, run.session_id)
        persistSessionsList()
      }
      attachRunStream(sid, runId)
    } catch (err: any) {
      addMessage(sid, {
        id: uid(),
        role: 'system',
        content: `Error: ${err.message}`,
        timestamp: Date.now(),
      })
    }
  }

  async function sendMessage(content: string, attachments?: Attachment[]) {
    if (!content.trim() && !(attachments && attachments.length > 0)) return

    if (!activeSession.value) {
      const session = createSession()
      switchSession(session.id)
    }

    // Capture session ID at send time — all callbacks use this, not activeSessionId
    const sid = activeSessionId.value!
    if (isStreaming.value) {
      if (busyInputSteerEnabled()) void steerBusyInput(sid, content, attachments)
      return
    }

    await submitMessage(sid, content, attachments)
  }

  async function stopStreaming() {
    const sid = activeSessionId.value
    if (!sid) return
    const inFlight = readInFlight(sid)
    const ctrl = streamStates.value.get(sid)
    if (ctrl) {
      ctrl.abort()
      const msgs = getSessionMsgs(sid)
      const lastMsg = msgs[msgs.length - 1]
      if (lastMsg?.isStreaming) {
        updateMessage(sid, lastMsg.id, { isStreaming: false })
      }
      streamStates.value.delete(sid)
      stopPolling(sid)
      stopApprovalPolling(sid)
      clearApproval(sid)
      if (sid === activeSessionId.value) persistActiveMessages()
      persistSessionsList()
    } else {
      stopPolling(sid)
      stopApprovalPolling(sid)
      clearApproval(sid)
      if (sid === activeSessionId.value) persistActiveMessages()
      persistSessionsList()
    }

    if (!inFlight?.runId || !inFlight.runId.startsWith('bridge_run_')) {
      clearInFlight(sid)
      return
    }

    try {
      await cancelRun(inFlight.runId)
      clearInFlight(sid)
    } catch (err) {
      console.warn('Failed to cancel run:', err)
    }
  }

  // Tab visibility: re-sync when returning to foreground
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && activeSessionId.value && !isStreaming.value) {
        void refreshActiveSession()
        if (readInFlight(activeSessionId.value)) {
          resumeInFlightRun(activeSessionId.value)
          void pollApprovalOnce(activeSessionId.value)
          startApprovalPolling(activeSessionId.value)
        }
      }
    })
  }

  // Transient observation of <think> boundaries during active streaming.
  // Not persisted; cleared on session switch. See spec §5.3.
  const thinkingObservation = new Map<string, { startedAt?: number; endedAt?: number }>()

  function getThinkingObservation(messageId: string) {
    return thinkingObservation.get(messageId)
  }

  function noteThinkingDelta(messageId: string, prevContent: string, nextContent: string) {
    const { startedAtBoundary, endedAtBoundary } = detectThinkingBoundary(prevContent, nextContent)
    if (!startedAtBoundary && !endedAtBoundary) return
    const existing = thinkingObservation.get(messageId) || {}
    if (startedAtBoundary && existing.startedAt === undefined) {
      existing.startedAt = Date.now()
    }
    if (endedAtBoundary && existing.endedAt === undefined) {
      existing.endedAt = Date.now()
    }
    thinkingObservation.set(messageId, existing)
  }

  /** 第一次见到某条消息的 reasoning 文本时，标记 startedAt。 */
  function noteReasoningStart(messageId: string) {
    const existing = thinkingObservation.get(messageId) || {}
    if (existing.startedAt === undefined) {
      existing.startedAt = Date.now()
      thinkingObservation.set(messageId, existing)
    }
  }

  /** 内容首次到达（视为推理结束）或显式收到 reasoning.available 时，标记 endedAt。 */
  function noteReasoningEnd(messageId: string) {
    const existing = thinkingObservation.get(messageId)
    if (!existing || existing.startedAt === undefined) return
    if (existing.endedAt === undefined) {
      existing.endedAt = Date.now()
      thinkingObservation.set(messageId, existing)
    }
  }

  function clearThinkingObservationFor(_sessionId: string) {
    // messageId 与 sessionId 的关联未单独持有；方案是切会话时一律清空。
    // 这符合 spec 定义：observation 是"当前会话范围内"的 transient 状态。
    thinkingObservation.clear()
  }

  return {
    sessions,
    activeSessionId,
    activeSession,
    activeApproval,
    focusMessageId,
    messages,
    displayMessages,
    activeBranches,
    isStreaming,
    isRunActive,
    isSessionLive,
    sessionBranches,
    sessionBranchCount,
    switchBranchSession,
    isLoadingSessions,
    sessionsLoaded,
    isLoadingMessages,

    newChat,
    switchSession,
    switchSessionModel,
    deleteSession,
    sendMessage,
    respondApproval,
    stopStreaming,
    loadSessions,
    refreshSessionBranches,
    refreshActiveSession,
    getThinkingObservation,
    noteThinkingDelta,
    noteReasoningStart,
    noteReasoningEnd,
    clearThinkingObservationFor,
  }
})
