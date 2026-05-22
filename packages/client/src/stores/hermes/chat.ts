import { cancelRun, startRun, steerSession, streamRunEvents, type ChatMessage, type RunEvent, type SteerUiEventPayload } from '@/api/hermes/chat'
import {
  getPendingApproval,
  respondApproval as respondApprovalApi,
  type ApprovalChoice,
  type PendingApproval,
} from '@/api/hermes/approval'
import {
  getPendingClarify,
  respondClarify as respondClarifyApi,
  type PendingClarify,
} from '@/api/hermes/clarify'
import { deleteSession as deleteSessionApi, fetchSession, fetchSessions, fetchHermesSessions, fetchSessionUsageSingle, type SessionDetail, type SessionSummary } from '@/api/hermes/sessions'
import { fetchConversationDetail, fetchConversationSummaries, type ConversationBranch, type ConversationMessage, type ConversationSummary } from '@/api/hermes/conversations'
import { getApiKey } from '@/api/client'
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useAppStore } from './app'
import { useProfilesStore } from './profiles'
import { useSettingsStore } from './settings'
import { detectThinkingBoundary } from '@/utils/thinking-parser'
import { primeCompletionSound, playCompletionSound } from '@/utils/completion-sound'
import { shouldHideFromPromptHistory } from '@/utils/injected-message-rules'
import {
  textFromRunEvent,
  numberFromRunEvent,
  usageFromRunEvent,
} from '@/custom/utils/run-event-helpers'
import { processRunEvent, type RunStreamCallbacks } from '@/custom/utils/sse-stream-manager'
import {
  storageKey as _storageKey,
  sessionsCacheKey as _sessionsCacheKey,
  bridgeLocalSessionKey as _bridgeLocalSessionKey,
  bridgePersistentSessionKey as _bridgePersistentSessionKey,
  bridgeSeenKey as _bridgeSeenKey,
  steerHistoryKey as _steerHistoryKey,
  msgsCacheKey as _msgsCacheKey,
  inFlightKey as _inFlightKey,
  legacyStorageKey as _legacyStorageKey,
  legacySessionsCacheKey as _legacySessionsCacheKey,
  legacyMsgsCacheKey as _legacyMsgsCacheKey,
  legacyInFlightKey as _legacyInFlightKey,
  loadJson as _loadJson,
  loadJsonWithFallback as _loadJsonWithFallback,
  saveJson as _saveJson,
  saveJsonWithLegacy as _saveJsonWithLegacy,
  removeItem as _removeItem,
  removeItemWithLegacy as _removeItemWithLegacy,
  setItemBestEffort as _setItemBestEffort,
  writeSessionModelOverride as _writeSessionModelOverride,
  clearSessionModelOverride as _clearSessionModelOverride,
  copySessionModelOverride as _copySessionModelOverride,
  applySessionModelOverride as _applySessionModelOverride,
  markInFlight as _markInFlight,
  readInFlight as _readInFlight,
  clearInFlight as _clearInFlight,
  isPersistentTuiSessionId,
  shouldDefaultNewSessionToTui as _shouldDefaultNewSessionToTui,
  isBridgeLocalSession as _isBridgeLocalSession,
  clearBridgeLocalSession as _clearBridgeLocalSession,
  readBridgePersistentSessionId as _readBridgePersistentSessionId,
  readBridgeBackingSessionId as _readBridgeBackingSessionId,
  readSteerHistory as _readSteerHistory,
  appendSteerHistory as _appendSteerHistory,
  type InFlightRun,
  type SteerHistoryEntry,
} from '@/custom/utils/bridge-session-helpers'
import {
  uid,
  normalizeProviderKey,
  normalizeBaseUrl,
  isBridgeFallbackSession,
  applySessionUsage,
  extractPendingApprovalFromMessages,
  mapHermesMessages,
  mapHermesSession,
  compareServerMessages,
  serverHasBetterToolDetails,
  mergeServerToolDetails,
  withLocalSteeredMessages,
  isServerPersistedSteerMessage,
  messagesEquivalent,
  isStaleBridgeRunError,
  sanitizeForCache,
  scrubBuggyReasoningInCache,
} from '@/custom/utils/message-helpers'
import {
  countBranchTree,
  flattenBranchTree,
  findBranchById,
  isSubagentStatusText,
  hasRealBranchMessageContent,
  detailMessagesBelongToBranch,
  branchToSessionDetail,
  branchesRepresentSameSubagent as _branchesRepresentSameSubagent,
  mergeBranchLists as _mergeBranchLists,
  formatSubagentResult,
  parseSubagentStatus,
  formatSubagentLiveTranscript,
} from '@/custom/utils/branch-helpers'

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
  toolInlineDiff?: string
  toolCallId?: string
  toolStatus?: 'running' | 'done' | 'error'
  isStreaming?: boolean
  queued?: boolean
  steered?: boolean
  ui_event_id?: string
  previousMessageId?: string
  nextMessageId?: string
  subagentId?: string
  subagentDepth?: number
  attachments?: Attachment[]
  // 思考/推理文本。两条来源：
  //   1) 历史消息：来自 HermesMessage.reasoning 字段
  //   2) 流式：由 reasoning.delta / thinking.delta / reasoning.available 事件累加
  // 不含 <think> 包裹标签；内容自身可以为多段纯文本。
  reasoning?: string
  thinkingStartedAt?: number
  thinkingEndedAt?: number
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
  billingBaseUrl?: string
  messageCount?: number
  inputTokens?: number
  outputTokens?: number
  contextTokens?: number
  endedAt?: number | null
  lastActiveAt?: number
  workspace?: string | null
  branchSessionCount?: number
  parentSessionId?: string | null
  rootSessionId?: string | null
  isBranchSession?: boolean
  representedSessionIds?: string[]
}

export interface CompressionState {
  status: 'started' | 'completed' | 'failed'
  mode?: 'compression' | 'bridge_handoff'
  startedAt: number
  updatedAt: number
  messageCount?: number
  tokenCount?: number
  beforeTokens?: number
  afterTokens?: number
  totalMessages?: number
  resultMessages?: number
  summaryTokens?: number
  verbatimCount?: number
  error?: string
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



function applySessionDetail(session: Session | undefined | null, detail: Partial<SessionDetail> | null | undefined) {
  if (!session || !detail) return
  if (detail.source) session.source = detail.source === 'webui-bridge' ? 'tui' : detail.source
  if (detail.model) session.model = detail.model
  if (detail.billing_provider != null) session.provider = detail.billing_provider || ''
  if ((detail as any).billing_base_url != null) session.billingBaseUrl = (detail as any).billing_base_url || ''
  if (detail.message_count != null) session.messageCount = detail.message_count
  if (detail.ended_at !== undefined) session.endedAt = detail.ended_at != null ? Math.round(detail.ended_at * 1000) : null
  if (detail.last_active != null) session.lastActiveAt = Math.round(detail.last_active * 1000)
  const represented = representedSessionIdsOf({ id: session.id, represented_session_ids: detail.represented_session_ids } as SessionSummary)
  session.representedSessionIds = [...new Set([...(session.representedSessionIds || [session.id]), ...represented])]
  applySessionUsage(session, detail as { input_tokens: number; output_tokens: number }, { allowReset: true })
  applySessionModelOverride(session)
}

function representedSessionIdsOf(summary: SessionSummary | ConversationSummary): string[] {
  const raw = 'represented_session_ids' in summary ? (summary.represented_session_ids || []) : []
  const ids = Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) : []
  return ids.length > 0 ? [...new Set(ids)] : [summary.id]
}

function logSessionLoad(stage: string, detail: Record<string, unknown>) {
  if (!(globalThis as any)?.__HERMES_CHAT_DEBUG__) return
  console.info(`[chat.loadSessions] ${stage}`, detail)
}

function logTitleMutation(source: string, sessionId: string, before: string | undefined, after: string | undefined, detail: Record<string, unknown> = {}) {
  if ((before || '') === (after || '')) return
  if (!(globalThis as any)?.__HERMES_CHAT_DEBUG__) return
  console.info('[chat.title]', {
    source,
    sessionId,
    before: before || '',
    after: after || '',
    ...detail,
  })
}

function logTitleSnapshot(source: string, detail: Record<string, unknown>) {
  if (!(globalThis as any)?.__HERMES_CHAT_DEBUG__) return
  console.info('[chat.title.snapshot]', {
    source,
    ...detail,
  })
}

function looksLikeContinuationPrompt(text: string | null | undefined): boolean {
  const normalized = (text || '').replace(/\s+/g, ' ').trim().toLowerCase()
  return normalized.startsWith('previous conversation context:')
    || normalized.startsWith('current user message:')
}

function looksLikeWrapperOnlyMessages(messages: Message[] | null | undefined): boolean {
  if (!Array.isArray(messages) || messages.length !== 1) return false
  const [message] = messages
  return message.role === 'user' && looksLikeContinuationPrompt(message.content)
}

function parseExplicitSteerCommand(content: string): string | null {
  const match = content.trim().match(/^\/steer(?:\s+([\s\S]+))?$/i)
  if (!match) return null
  const text = (match[1] || '').trim()
  return text || null
}

function normalizeMessageTimestamp(timestamp: number): number {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0
  if (timestamp > 10000000000000000) return Math.round(timestamp / 1000000)
  if (timestamp > 100000000000000) return Math.round(timestamp / 1000)
  return timestamp < 100000000000 ? Math.round(timestamp * 1000) : Math.round(timestamp)
}

function looksLikeEmptyTuiStub(session: SessionSummary): boolean {
  return session.source === 'tui'
    && !session.title
    && !(session.preview || '').trim()
    && Number(session.message_count || 0) === 0
    && Number(session.tool_call_count || 0) === 0
}

function looksLikeEmptyTuiStubSession(session: Session): boolean {
  return session.source === 'tui'
    && (!session.title || session.title === session.id)
    && !(session.messages || []).length
    && Number(session.messageCount || 0) === 0
    && Number(session.inputTokens || 0) === 0
    && Number(session.outputTokens || 0) === 0
}

function logActiveBinding(source: string, detail: Record<string, unknown>) {
  if (!(globalThis as any)?.__HERMES_CHAT_DEBUG__) return
  console.info('[chat.active]', detail.source ? detail : { source, ...detail })
}











// Cache keys for stale-while-revalidate loading of sessions / messages.
// All keys include the active profile name to isolate cache between profiles.
// Rendering from cache on boot avoids the multi-round-trip wait the user sees
// every time they open the page (esp. noticeable on mobile).
const BRANCH_SESSION_META_KEY_PREFIX = 'hermes_branch_session_meta_v1_'
const POLL_INTERVAL_MS = 2000
const COMPRESSION_NOTICE_TTL_MS = 15_000
const STREAM_FLUSH_INTERVAL_MS = 120
const LIVE_BRANCH_REFRESH_INTERVAL_MS = 8000

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

// Thin wrappers that inject getProfileName() into the pure helpers.
function storageKey(): string { return _storageKey(getProfileName()) }
function sessionsCacheKey(): string { return _sessionsCacheKey(getProfileName()) }
function bridgeLocalSessionKey(sid: string): string { return _bridgeLocalSessionKey(getProfileName(), sid) }
function bridgePersistentSessionKey(sid: string): string { return _bridgePersistentSessionKey(getProfileName(), sid) }
function bridgeSeenKey(): string { return _bridgeSeenKey(getProfileName()) }
function branchSessionMetaKey(): string { return BRANCH_SESSION_META_KEY_PREFIX + getProfileName() }
function msgsCacheKey(sid: string): string { return _msgsCacheKey(getProfileName(), sid) }
function inFlightKey(sid: string): string { return _inFlightKey(getProfileName(), sid) }
function legacyStorageKey(): string | null { return _legacyStorageKey(getProfileName()) }
function legacySessionsCacheKey(): string | null { return _legacySessionsCacheKey(getProfileName()) }
function legacyMsgsCacheKey(sid: string): string | null { return _legacyMsgsCacheKey(getProfileName(), sid) }
function legacyInFlightKey(sid: string): string | null { return _legacyInFlightKey(getProfileName(), sid) }
function loadJson<T>(key: string): T | null { return _loadJson<T>(key) }
function loadJsonWithFallback<T>(key: string, legacyKey?: string | null): T | null { return _loadJsonWithFallback<T>(key, legacyKey) }
function readSteerHistory(sid: string): SteerHistoryEntry[] { return _readSteerHistory(getProfileName(), sid) }
function appendSteerHistory(
  sid: string,
  content: string,
  timestamp: number,
  anchors?: { previousMessageId?: string, nextMessageId?: string, uiEventId?: string },
) {
  return _appendSteerHistory(getProfileName(), sid, content, timestamp, anchors)
}
function writeSteerHistory(sid: string, entries: SteerHistoryEntry[]) {
  saveJson(_steerHistoryKey(getProfileName(), sid), entries)
}
function saveJson(key: string, value: unknown) { _saveJson(key, value) }
function saveJsonWithLegacy(key: string, value: unknown, legacyKey?: string | null) { _saveJsonWithLegacy(key, value, legacyKey) }
function removeItem(key: string) { _removeItem(key) }
function removeItemWithLegacy(key: string, legacyKey?: string | null) { _removeItemWithLegacy(key, legacyKey) }
function setItemBestEffort(key: string, value: string) { _setItemBestEffort(key, value) }
function writeSessionModelOverride(sid: string, model: string, provider?: string) { _writeSessionModelOverride(getProfileName(), sid, model, provider) }
function clearSessionModelOverride(sid: string) { _clearSessionModelOverride(getProfileName(), sid) }
function copySessionModelOverride(fromSid: string, toSid: string) { _copySessionModelOverride(getProfileName(), fromSid, toSid) }
function applySessionModelOverride(session: Session | undefined | null) { _applySessionModelOverride(getProfileName(), session) }
function markInFlight(sid: string, runId: string) { _markInFlight(getProfileName(), sid, runId) }
function readInFlight(sid: string): InFlightRun | null { return _readInFlight(getProfileName(), sid) }
function clearInFlight(sid: string) { _clearInFlight(getProfileName(), sid) }
function isBridgeLocalSession(sid: string): boolean { return _isBridgeLocalSession(getProfileName(), sid) }
function clearBridgeLocalSession(sid: string) { _clearBridgeLocalSession(getProfileName(), sid) }
function readBridgePersistentSessionId(sid: string): string | null { return _readBridgePersistentSessionId(getProfileName(), sid) }
function readBridgeBackingSessionId(sid: string): string | null { return _readBridgeBackingSessionId(getProfileName(), sid) }
function shouldDefaultNewSessionToTui(): boolean { return _shouldDefaultNewSessionToTui(getProfileName()) }

interface ApprovalState {
  pending: PendingApproval | null
  pendingCount: number
  visibleSince: number
  signature: string
  submitting: boolean
}

interface ClarifyState {
  pending: PendingClarify | null
  visibleSince: number
  signature: string
  submitting: boolean
}

interface BranchSessionMeta {
  parentSessionId: string | null
  rootSessionId: string
  branchSessionCount?: number
}

export const useChatStore = defineStore('chat', () => {
  const sessions = ref<Session[]>([])
  const activeSessionId = ref<string | null>(null)
  const focusMessageId = ref<string | null>(null)
  const streamStates = ref<Map<string, AbortController>>(new Map())
  const pendingRunStarts = ref<Set<string>>(new Set())
  const cancelledPendingStarts = ref<Set<string>>(new Set())
  const isStreaming = computed(() => activeSessionId.value != null && streamStates.value.has(activeSessionId.value))
  const autoPlaySpeechEnabled = ref(false)

  function setAutoPlaySpeech(enabled: boolean) {
    autoPlaySpeechEnabled.value = enabled
  }
  const isLoadingSessions = ref(false)
  const sessionsLoaded = ref(false)
  const isLoadingMessages = ref(false)
  // tmux-like resume state: true when we recovered an in-flight run from
  // localStorage after a refresh and are polling fetchSession for progress.
  // UI shows the thinking indicator while this is set.
  const resumingRuns = ref<Set<string>>(new Set())
  const abortingSessions = ref<Set<string>>(new Set())
  const isRunActive = computed(() => {
    const sid = activeSessionId.value
    if (sid == null) return false
    if (activeSession.value?.endedAt != null) {
      return candidateSessionIdsForRun(sid).some(candidateId =>
        streamStates.value.has(candidateId) || pendingRunStarts.value.has(candidateId) || resumingRuns.value.has(candidateId),
      )
    }
    return !!activeRunSessionId()
  })
  const isAborting = computed(() => {
    const sid = activeSessionId.value
    return !!sid && abortingSessions.value.has(sid)
  })
  const pollTimers = new Map<string, ReturnType<typeof setInterval>>()
  const pollSignatures = new Map<string, { sig: string, stableTicks: number }>()
  const approvalsBySession = ref<Record<string, ApprovalState>>({})
  const clarifiesBySession = ref<Record<string, ClarifyState>>({})
  const dbBranchesBySession = ref<Record<string, ConversationBranch[]>>({})
  const liveBranchesBySession = ref<Record<string, ConversationBranch[]>>({})
  const subagentActivityBySession = ref<Record<string, Record<string, ConversationMessage[]>>>({})
  const compressionBySession = ref<Record<string, CompressionState>>({})
  let latestSwitchRequestId = 0
  const approvalPollers = new Map<string, ReturnType<typeof setInterval>>()
  const clarifyPollers = new Map<string, ReturnType<typeof setInterval>>()
  const compressionNoticeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const dismissedApprovalSignatures = new Map<string, { signature: string, expiresAt: number }>()
  const branchRefreshInFlight = new Set<string>()

  const activeSession = ref<Session | null>(null)
  const messages = computed<Message[]>(() => activeSession.value?.messages || [])
  const activeBranches = computed<ConversationBranch[]>(() => {
    const sid = activeSessionId.value
    if (!sid) return []
    return mergedSessionBranches(sid)
  })
  const displayMessages = computed<Message[]>(() => messages.value)
  const activeCompression = computed<CompressionState | null>(() => {
    const sid = activeSessionId.value
    if (!sid) return null
    return compressionBySession.value[sid]
      || (activeSession.value?.rootSessionId ? compressionBySession.value[activeSession.value.rootSessionId] : null)
      || null
  })
  const activeApproval = computed<ApprovalState | null>(() => {
    const sid = activeSessionId.value
    if (!sid) return null
    return approvalsBySession.value[sid] || null
  })
  const activeClarify = computed<ClarifyState | null>(() => {
    const sid = activeSessionId.value
    if (!sid) return null
    return clarifiesBySession.value[sid]
      || (activeSession.value?.rootSessionId ? clarifiesBySession.value[activeSession.value.rootSessionId] : null)
      || null
  })

  function isSessionLive(sessionId: string): boolean {
    return streamStates.value.has(sessionId)
      || pendingRunStarts.value.has(sessionId)
      || resumingRuns.value.has(sessionId)
      || Object.values(liveBranchesBySession.value).some(branches => {
        const branch = findBranchById(branches, sessionId)
        return !!branch?.is_active
      })
      || Object.keys({
        ...dbBranchesBySession.value,
        ...liveBranchesBySession.value,
      }).some(rootId => !!findBranchById(sessionBranches(rootId), sessionId)?.is_active)
  }

  function candidateSessionIdsForRun(sessionId: string): string[] {
    const session = sessions.value.find(item => item.id === sessionId)
    const ids = new Set<string>([sessionId])
    for (const id of session?.representedSessionIds || []) ids.add(id)
    if (session?.rootSessionId) ids.add(session.rootSessionId)
    const persistent = readBridgePersistentSessionId(sessionId) || readBridgeBackingSessionId(sessionId)
    if (persistent) ids.add(persistent)
    for (const item of sessions.value) {
      const represented = item.representedSessionIds || []
      if (represented.includes(sessionId)) {
        ids.add(item.id)
        for (const id of represented) ids.add(id)
      }
    }
    return [...ids].filter(Boolean)
  }

  function activeRunSessionId(): string | null {
    const sid = activeSessionId.value
    if (!sid) return null
    for (const candidateId of candidateSessionIdsForRun(sid)) {
      if (streamStates.value.has(candidateId)
        || pendingRunStarts.value.has(candidateId)
        || resumingRuns.value.has(candidateId)
        || isSessionLive(candidateId)
        || readInFlight(candidateId)) {
        return candidateId
      }
    }
    return null
  }

  function loadBranchSessionMetaIndex(): Record<string, BranchSessionMeta> {
    return loadJson<Record<string, BranchSessionMeta>>(branchSessionMetaKey()) || {}
  }

  function hasLoadedBranches(rootSessionId: string, items: Session[] = sessions.value): boolean {
    const root = items.find(item => item.id === rootSessionId)
    return (root?.branchSessionCount || 0) > 0
      || countBranchTree(dbBranchesBySession.value[rootSessionId] || []) > 0
      || countBranchTree(liveBranchesBySession.value[rootSessionId] || []) > 0
  }

  function applyBranchMeta(session: Session, meta: BranchSessionMeta | undefined, rootItems: Session[] = sessions.value, allowUnverified = false) {
    if (!meta?.rootSessionId) return
    if (!allowUnverified && !hasLoadedBranches(meta.rootSessionId, rootItems)) return
    session.isBranchSession = true
    session.parentSessionId = meta.parentSessionId
    session.rootSessionId = meta.rootSessionId
    session.branchSessionCount = meta.branchSessionCount ?? session.branchSessionCount
  }

  function persistBranchSessionMeta(rootSessionId: string, branches: ConversationBranch[]) {
    if (!rootSessionId) return
    const next = { ...loadBranchSessionMetaIndex() }
    for (const [sessionId, meta] of Object.entries(next)) {
      if (sessionId !== rootSessionId && meta?.rootSessionId === rootSessionId) delete next[sessionId]
    }
    const visit = (items: ConversationBranch[]) => {
      for (const branch of items) {
        next[branch.session_id] = {
          parentSessionId: branch.parent_session_id ?? rootSessionId,
          rootSessionId,
          branchSessionCount: countBranchTree(branch.branches || []),
        }
        visit(branch.branches || [])
      }
    }
    visit(branches)
    saveJson(branchSessionMetaKey(), next)
  }

  function reconcileBranchSessions(rootSessionId: string) {
    const validBranchIds = new Set(flattenBranchTree(sessionBranches(rootSessionId)).map(branch => branch.session_id))
    let changed = false
    sessions.value = sessions.value.filter(session => {
      if (!session.isBranchSession || session.rootSessionId !== rootSessionId || validBranchIds.has(session.id)) return true
      if (activeSessionId.value === session.id) {
        const root = sessions.value.find(item => item.id === rootSessionId) || null
        activeSessionId.value = root?.id || null
        activeSession.value = root
        if (root?.id) setItemBestEffort(storageKey(), root.id)
      }
      removeItemWithLegacy(msgsCacheKey(session.id), legacyMsgsCacheKey(session.id))
      changed = true
      return false
    })
    if (changed) persistSessionsList()
  }

  // Thin wrappers that inject store-local ID resolvers into the pure helpers.
  function branchesRepresentSameSubagent(persisted: ConversationBranch, live: ConversationBranch): boolean {
    return _branchesRepresentSameSubagent(persisted, live, sessionFetchId, readBridgeBackingSessionId)
  }

  function mergeBranchLists(persisted: ConversationBranch[] = [], live: ConversationBranch[] = []): ConversationBranch[] {
    return _mergeBranchLists(persisted, live, sessionFetchId, readBridgeBackingSessionId)
  }

  function mergedSessionBranches(sessionId: string): ConversationBranch[] {
    return mergeBranchLists(dbBranchesBySession.value[sessionId] || [], liveBranchesBySession.value[sessionId] || [])
  }

  function subagentBranchAliases(sessionId: string): Map<string, string> {
    const aliases = new Map<string, string>()
    const persisted = flattenBranchTree(dbBranchesBySession.value[sessionId] || [])
    const live = flattenBranchTree(liveBranchesBySession.value[sessionId] || [])
      .filter(branch => branch.source === 'subagent')
    for (const liveBranch of live) {
      const match = persisted.find(branch => branchesRepresentSameSubagent(branch, liveBranch))
      if (match) aliases.set(liveBranch.session_id, match.session_id)
    }
    return aliases
  }

  function sessionBranches(sessionId: string): ConversationBranch[] {
    return mergedSessionBranches(sessionId)
  }

  function sessionBranchCount(sessionId: string): number {
    const loadedCount = countBranchTree(sessionBranches(sessionId))
    if (loadedCount > 0) return loadedCount
    return sessions.value.find(session => session.id === sessionId)?.branchSessionCount || 0
  }

  function branchMessagesToMessages(branch: ConversationBranch): Message[] {
    const mapped: Message[] = branch.messages.map(message => ({
      id: String(message.id),
      role: message.role,
      content: message.content,
      timestamp: Math.round(message.timestamp * 1000),
    }))
    if (branch.source === 'subagent' && branch.is_active) {
      const lastAssistant = [...mapped].reverse().find(message => message.role === 'assistant')
      if (lastAssistant) lastAssistant.isStreaming = true
    }
    return mapped
  }

  function branchToSession(branch: ConversationBranch, rootSessionId: string): Session {
    return {
      id: branch.session_id,
      title: branch.title || branch.messages.find(message => message.content.trim())?.content.slice(0, 40) || branch.session_id,
      source: branch.source === 'webui-bridge' ? 'tui' : (branch.source || undefined),
      messages: branchMessagesToMessages(branch),
      createdAt: Math.round(branch.started_at * 1000),
      updatedAt: Math.round((branch.last_active || branch.ended_at || branch.started_at) * 1000),
      model: branch.model,
      messageCount: branch.messages.length,
      inputTokens: branch.input_tokens,
      outputTokens: branch.output_tokens,
      endedAt: branch.ended_at != null ? Math.round(branch.ended_at * 1000) : null,
      lastActiveAt: branch.last_active != null ? Math.round(branch.last_active * 1000) : undefined,
      branchSessionCount: countBranchTree(branch.branches || []),
      parentSessionId: branch.parent_session_id,
      rootSessionId,
      isBranchSession: true,
    }
  }

  function syncBranchSessionFromBranch(rootSessionId: string, branch: ConversationBranch) {
    const existing = sessions.value.find(session => session.id === branch.session_id)
    if (!existing) return

    const nextSession = branchToSession(branch, rootSessionId)
    const preserveHydratedMessages = hasRealBranchMessageContent(existing.messages)
      && !hasRealBranchMessageContent(nextSession.messages)
    const preserveActiveHydratedMessages = activeSessionId.value === existing.id
      && branch.source !== 'subagent'
      && hasRealBranchMessageContent(existing.messages)
    logTitleMutation('branch.sync', existing.id, existing.title, nextSession.title, { rootSessionId, branchId: branch.session_id })
    existing.title = nextSession.title
    existing.source = nextSession.source
    existing.model = nextSession.model
    if (!preserveHydratedMessages && !preserveActiveHydratedMessages) {
      let mergedMessages = existing.messages.length > 0
        ? mergeServerToolDetails(nextSession.messages, existing.messages)
        : nextSession.messages
      // Preserve reasoning and isStreaming from hydrated messages: branch
      // summaries (from branchToSession) always set reasoning=null and may
      // lack isStreaming.  Without this guard the periodic sync → hydrate
      // cycle causes the thinking block to collapse/re-expand — flickering.
      if (existing.messages.length > 0) {
        const existingMeta = new Map<string, { reasoning?: string; isStreaming?: boolean }>()
        for (const m of existing.messages) {
          if (m.reasoning || m.isStreaming) {
            existingMeta.set(String(m.id), { reasoning: m.reasoning, isStreaming: m.isStreaming })
          }
        }
      if (existingMeta.size > 0) {
          mergedMessages = mergedMessages.map(m => {
            const meta = existingMeta.get(String(m.id))
            if (!meta) return m
            let changed = false
            const patch: Partial<Message> = {}
            if (!m.reasoning && meta.reasoning) { patch.reasoning = meta.reasoning; changed = true }
            if (!m.isStreaming && meta.isStreaming) { patch.isStreaming = true; changed = true }
            return changed ? { ...m, ...patch } : m
          })
        }
      }
      if (existing.messages.length === mergedMessages.length) {
        mergedMessages = mergedMessages.map((message, index) => {
          const current = existing.messages[index]
          if (!current || current.role !== 'assistant' || message.role !== 'assistant') return message
          if ((current.content || '').length > (message.content || '').length) {
            return {
              ...message,
              content: current.content,
              reasoning: message.reasoning || current.reasoning,
              isStreaming: message.isStreaming || current.isStreaming,
            }
          }
          return message
        })
      }
      if (!messagesEquivalent(existing.messages, mergedMessages)) {
        existing.messages = mergedMessages
      }
    }
    existing.createdAt = nextSession.createdAt
    existing.updatedAt = nextSession.updatedAt
    existing.messageCount = (preserveHydratedMessages || preserveActiveHydratedMessages)
      ? existing.messages.length
      : nextSession.messageCount
    existing.inputTokens = nextSession.inputTokens
    existing.outputTokens = nextSession.outputTokens
    existing.contextTokens = nextSession.contextTokens
    existing.endedAt = nextSession.endedAt
    existing.lastActiveAt = nextSession.lastActiveAt
    existing.branchSessionCount = nextSession.branchSessionCount
    existing.parentSessionId = nextSession.parentSessionId
    existing.rootSessionId = nextSession.rootSessionId
    existing.isBranchSession = true
  }

  function syncBranchSessions(rootSessionId: string) {
    const sync = (branches: ConversationBranch[]) => {
      for (const branch of branches) {
        syncBranchSessionFromBranch(rootSessionId, branch)
        sync(branch.branches || [])
      }
    }
    sync(sessionBranches(rootSessionId))
  }

  function upsertBranchSession(rootSessionId: string, branch: ConversationBranch): Session {
    const nextSession = branchToSession(branch, rootSessionId)
    const existing = sessions.value.find(session => session.id === nextSession.id)
    if (existing) {
      Object.assign(existing, nextSession)
      return existing
    }
    sessions.value.push(nextSession)
    return nextSession
  }

  function promoteMergedSubagentBranchSessions(rootSessionId: string) {
    const aliases = subagentBranchAliases(rootSessionId)
    if (!aliases.size) return
    let changed = false
    for (const [liveId, persistedId] of aliases) {
      const branch = findBranchById(sessionBranches(rootSessionId), persistedId)
      if (!branch) continue
      const target = upsertBranchSession(rootSessionId, branch)
      if (activeSessionId.value === liveId) {
        activeSessionId.value = persistedId
        activeSession.value = target
        setItemBestEffort(storageKey(), persistedId)
        changed = true
      }
      const before = sessions.value.length
      sessions.value = sessions.value.filter(session => session.id !== liveId)
      if (sessions.value.length !== before) {
        removeItemWithLegacy(msgsCacheKey(liveId), legacyMsgsCacheKey(liveId))
        changed = true
      }
    }
    if (changed) persistSessionsList()
  }

  async function hydrateActiveBranchSession(rootSessionId: string) {
    const branchId = activeSessionId.value
    if (!branchId || branchId === rootSessionId) return
    const target = sessions.value.find(session => session.id === branchId)
    if (!target?.isBranchSession || target.rootSessionId !== rootSessionId) return
    const branch = findBranchById(sessionBranches(rootSessionId), branchId)
    if (!branch || (branch.source !== 'tui' && branch.source !== 'api_server')) return

    try {
      const detail = await fetchResolvedSessionDetail(branchId)
      if (!detail || isBridgeFallbackSession(detail)) return
      if (!detailMessagesBelongToBranch(detail, branchId)) return
      const mapped = mapHermesMessages(detail.messages || [])
      const mappedOnlySubagentStatus = mapped.length > 0 && mapped.every(message => isSubagentStatusText(message.content))
      if (branch.is_active && mappedOnlySubagentStatus) return
      if (mapped.length > 0) {
        const local = target.messages
        const nextMessages = withLocalSteeredMessages(
          mergeServerToolDetails(mapped, local),
          local,
        )
        if (!messagesEquivalent(local, nextMessages)) {
          target.messages = nextMessages
        }
        target.messageCount = target.messages.length
        if (branchId === activeSessionId.value) persistActiveMessages()
      }
      applySessionDetail(target, detail)
      if (detail.title) {
        logTitleMutation('branch.detail', target.id, target.title, detail.title, { rootSessionId, branchId })
        target.title = detail.title
      }
    } catch {
      // Active branch hydration is best-effort; the parent run stream continues.
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
      let seededMessages = nextSession.messages
      let prefetchedDetail: SessionDetail | null = null
      try {
        const detail = await fetchResolvedSessionDetail(branchId)
        if (detail && detail.messages && !isBridgeFallbackSession(detail) && detailMessagesBelongToBranch(detail, branchId)) {
          prefetchedDetail = detail
          const mapped = reapplySteerHistory(branchId, mapHermesMessages(detail.messages))
          if (mapped.length > 0) {
            const branchSummaryHasTools = nextSession.messages.some(message => message.role === 'tool')
            seededMessages = !branchSummaryHasTools
              ? withLocalSteeredMessages(mapped, nextSession.messages)
              : (
                  serverHasBetterToolDetails(nextSession.messages, mapped)
                    ? withLocalSteeredMessages(mergeServerToolDetails(nextSession.messages, mapped), nextSession.messages)
                    : withLocalSteeredMessages(mapped, nextSession.messages)
                )
          }
        }
      } catch {
        // Branch session prefetch is best-effort; fall back to branch summary messages.
      }
      if (!prefetchedDetail) {
        prefetchedDetail = branchToSessionDetail(branch)
      }
      const existing = sessions.value.find(session => session.id === branchId)
      if (existing) {
        const preserveToolDetails = serverHasBetterToolDetails(seededMessages, existing.messages)
        let nextMessages = preserveToolDetails
          ? withLocalSteeredMessages(mergeServerToolDetails(seededMessages, existing.messages), existing.messages)
          : withLocalSteeredMessages(seededMessages, existing.messages)
        // Preserve reasoning and isStreaming from existing hydrated messages
        // when the incoming messages lack them.  Same logic as in
        // syncBranchSessionFromBranch to prevent thinking-block flicker.
        if (existing.messages.length > 0) {
          const existingMeta = new Map<string, { reasoning?: string; isStreaming?: boolean }>()
          for (const m of existing.messages) {
            if (m.reasoning || m.isStreaming) {
              existingMeta.set(String(m.id), { reasoning: m.reasoning, isStreaming: m.isStreaming })
            }
          }
          if (existingMeta.size > 0) {
            nextMessages = nextMessages.map(m => {
              const meta = existingMeta.get(String(m.id))
              if (!meta) return m
              let changed = false
              const patch: Partial<Message> = {}
              if (!m.reasoning && meta.reasoning) { patch.reasoning = meta.reasoning; changed = true }
              if (!m.isStreaming && meta.isStreaming) { patch.isStreaming = true; changed = true }
              return changed ? { ...m, ...patch } : m
            })
          }
        }
        if (existing.messages.length === nextMessages.length) {
          nextMessages = nextMessages.map((message, index) => {
            const current = existing.messages[index]
            if (!current || current.role !== 'assistant' || message.role !== 'assistant') return message
            if ((current.content || '').length > (message.content || '').length) {
              return {
                ...message,
                content: current.content,
                reasoning: message.reasoning || current.reasoning,
                isStreaming: message.isStreaming || current.isStreaming,
              }
            }
            return message
          })
        }
        existing.title = nextSession.title
        existing.source = nextSession.source
        existing.model = nextSession.model
        if (!messagesEquivalent(existing.messages, nextMessages)) {
          existing.messages = nextMessages
        }
        existing.createdAt = nextSession.createdAt
        existing.updatedAt = nextSession.updatedAt
        existing.messageCount = existing.messages.length
        existing.endedAt = nextSession.endedAt
        existing.lastActiveAt = nextSession.lastActiveAt
        existing.branchSessionCount = nextSession.branchSessionCount
        existing.parentSessionId = nextSession.parentSessionId
        existing.rootSessionId = nextSession.rootSessionId
        existing.isBranchSession = true
      } else {
        nextSession.messages = seededMessages
        nextSession.messageCount = seededMessages.length
        sessions.value.push(nextSession)
      }
      persistSessionsList()
      await switchSession(branchId, null, prefetchedDetail, true)
      return
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

  function buildClarifySignature(sessionId: string, pending: PendingClarify | null) {
    if (!pending) return ''
    return JSON.stringify({
      sid: sessionId,
      id: pending.request_id || '',
      question: pending.question || '',
      choices: pending.choices || [],
    })
  }

  function setClarifyPending(sessionId: string, pending: PendingClarify | null) {
    if (!pending) {
      clearClarify(sessionId)
      return
    }

    const prev = clarifiesBySession.value[sessionId]
    const signature = buildClarifySignature(sessionId, pending)
    clarifiesBySession.value = {
      ...clarifiesBySession.value,
      [sessionId]: {
        pending: { ...pending, _session_id: pending._session_id || sessionId },
        visibleSince: prev?.signature === signature ? prev.visibleSince : Date.now(),
        signature,
        submitting: false,
      },
    }
  }

  function clearClarify(sessionId: string) {
    const next = { ...clarifiesBySession.value }
    delete next[sessionId]
    clarifiesBySession.value = next
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

  function shouldPreserveLiveClarify(sessionId: string) {
    const pending = clarifiesBySession.value[sessionId]?.pending
    return !!pending && (isSessionLive(sessionId) || !!readInFlight(sessionId))
  }

  async function pollClarifyOnce(sessionId: string) {
    try {
      const data = await getPendingClarify(sessionId)
      if (data.pending) {
        setClarifyPending(sessionId, data.pending)
      } else if (!shouldPreserveLiveClarify(sessionId)) {
        clearClarify(sessionId)
      }
    } catch {
      // ignore transient polling errors
    }
  }

  function stopClarifyPolling(sessionId: string) {
    const timer = clarifyPollers.get(sessionId)
    if (timer) {
      clearInterval(timer)
      clarifyPollers.delete(sessionId)
    }
  }

  function startClarifyPolling(sessionId: string) {
    if (clarifyPollers.has(sessionId)) return
    const timer = setInterval(() => {
      if (!isSessionLive(sessionId) && !readInFlight(sessionId)) {
        stopClarifyPolling(sessionId)
        return
      }
      void pollClarifyOnce(sessionId)
    }, 1500)
    clarifyPollers.set(sessionId, timer)
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
      sessions.value
        .filter(s => s.source !== 'subagent')
        .map(s => ({ ...s, messages: [] })),
      legacySessionsCacheKey(),
    )
  }

  function persistSessionMessages(sid: string) {
    if (!sid) return
    const s = sessions.value.find(sess => sess.id === sid)
    if (s) saveJsonWithLegacy(msgsCacheKey(sid), sanitizeForCache(s.messages), legacyMsgsCacheKey(sid))
  }

  function persistActiveMessages() {
    const sid = activeSessionId.value
    if (sid) persistSessionMessages(sid)
  }

  function getQueuedMessages(sid: string) {
    return getSessionMsgs(sid).filter(message => message.role === 'user' && message.queued)
  }

  function numericMessageId(id: unknown): string | undefined {
    if (typeof id === 'number' && Number.isFinite(id)) return String(id)
    if (typeof id === 'string' && /^\d+$/.test(id)) return id
    return undefined
  }

  function buildSteerUiEventPayload(
    sid: string,
    targetSessionId: string,
    optimisticId: string,
    timestamp: number,
    previousMessage: Message | undefined,
  ): SteerUiEventPayload {
    const previousBackendId = numericMessageId(previousMessage?.id)
    const previousSessionId = (previousMessage as any)?.session_id || targetSessionId || sid
    return {
      conversation_id: rootSessionIdFor(sid),
      source_session_id: targetSessionId || sid,
      anchor_session_id: previousBackendId ? previousSessionId : undefined,
      anchor_after_message_id: previousBackendId,
      client_message_id: optimisticId,
      client_previous_message_id: previousMessage?.id,
      client_timestamp: timestamp,
    }
  }

  function addSteeredMessage(sid: string, content: string, attachments?: Attachment[]): { id: string, timestamp: number, previousMessage?: Message } {
    const text = content.trim()
    const id = uid()
    const timestamp = Date.now()
    const existingMessages = getSessionMsgs(sid)
    const previousMessage = existingMessages[existingMessages.length - 1]
    const previousMessageId = previousMessage?.id
    const userMsg: Message = {
      id,
      role: 'user',
      content: text,
      timestamp,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      steered: true,
    }
    addMessage(sid, userMsg)
    appendSteerHistory(sid, text, timestamp, { previousMessageId })
    updateSessionTitle(sid)
    if (sid === activeSessionId.value) {
      persistActiveMessages()
      persistSessionsList()
    }
    return { id, timestamp, previousMessage }
  }

  function removeLocalSteeredMessage(sid: string, id: string) {
    const target = sessions.value.find(session => session.id === sid)
    if (!target) return
    target.messages = target.messages.filter(message => message.id !== id)
    if (sid === activeSessionId.value) {
      persistActiveMessages()
      persistSessionsList()
    }
  }

  function updateSteerHistoryUiEventId(sid: string, optimistic: { id: string, timestamp: number }, content: string, uiEventId: string) {
    const entries = readSteerHistory(sid)
    if (!entries.length) return
    const text = content.trim()
    const optimisticTs = normalizeMessageTimestamp(optimistic.timestamp)
    let matchIndex = entries.findIndex(entry => entry.uiEventId === uiEventId || (entry as any).ui_event_id === uiEventId)
    if (matchIndex < 0) {
      let bestDistance = Number.POSITIVE_INFINITY
      entries.forEach((entry, index) => {
        if (entry.content.trim() !== text) return
        const entryTs = normalizeMessageTimestamp(entry.timestamp || 0)
        const distance = entryTs && optimisticTs ? Math.abs(entryTs - optimisticTs) : 0
        if (entryTs && optimisticTs && distance > 5000) return
        if (distance >= bestDistance) return
        matchIndex = index
        bestDistance = distance
      })
    }
    if (matchIndex < 0) return
    entries[matchIndex] = {
      ...entries[matchIndex],
      uiEventId,
      clientMessageId: optimistic.id,
    } as SteerHistoryEntry
    writeSteerHistory(sid, entries)
  }

  function reapplySteerHistory(sid: string, messages: Message[]): Message[] {
    const history = readSteerHistory(sid)
    if (!history.length) return messages
    const pendingEntries = history
      .map(entry => ({
        content: entry.content.trim(),
        timestamp: normalizeMessageTimestamp(entry.timestamp || 0),
        previousMessageId: entry.previousMessageId,
        nextMessageId: entry.nextMessageId,
        uiEventId: entry.uiEventId || (entry as any).ui_event_id,
      }))
      .filter(entry => !!entry.content)
    if (!pendingEntries.length) return messages
    return messages.map(message => {
      if (message.role !== 'user') return message
      if (isServerPersistedSteerMessage(message)) return { ...message, steered: true }
      const text = message.content.trim()
      if (!text) return message
      let matchIndex = -1
      let matchDistance = Number.POSITIVE_INFINITY
      const messageTimestamp = normalizeMessageTimestamp(message.timestamp || 0)
      for (const [index, entry] of pendingEntries.entries()) {
        if (entry.uiEventId) continue
        if (entry.content !== text) continue
        if (!entry.timestamp || !messageTimestamp) {
          if (matchIndex < 0) matchIndex = index
          continue
        }
        const distance = Math.abs(messageTimestamp - entry.timestamp)
        if (distance > 5000 || distance >= matchDistance) continue
        matchIndex = index
        matchDistance = distance
      }
      if (matchIndex < 0) return message
      const entry = pendingEntries.splice(matchIndex, 1)[0]
      return {
        ...message,
        steered: true,
        ui_event_id: message.ui_event_id || entry.uiEventId,
        previousMessageId: message.previousMessageId || entry.previousMessageId,
        nextMessageId: message.nextMessageId || entry.nextMessageId,
      }
    })
  }

  async function steerBusyInput(sid: string, content: string, attachments?: Attachment[], targetSessionId = sid) {
    const text = content.trim()
    const optimistic = addSteeredMessage(sid, text, attachments)
    const uiEvent = buildSteerUiEventPayload(sid, targetSessionId, optimistic.id, optimistic.timestamp, optimistic.previousMessage)
    try {
      const result = await steerSession(targetSessionId, text, uiEvent)
      if (result?.ok) {
        if (result.ui_event_id) {
          updateMessage(sid, optimistic.id, {
            id: `ui.steer.${result.ui_event_id}`,
            ui_event_id: result.ui_event_id,
          } as Partial<Message>)
          updateSteerHistoryUiEventId(sid, optimistic, text, result.ui_event_id)
          persistSessionMessages(sid)
        }
        return
      }
    } catch (err) {
      removeLocalSteeredMessage(sid, optimistic.id)
      if (isStaleBridgeRunError(err)) {
        console.warn('Steer target is no longer running; sending as a new turn')
        clearInFlight(sid)
        streamStates.value.delete(sid)
        resumingRuns.value.delete(sid)
        await submitMessage(sid, content, attachments)
        return
      }
      console.warn('Steer failed, falling back to queue:', err)
    }
    // Fall back to queue
    removeLocalSteeredMessage(sid, optimistic.id)
    queueBusyInput(sid, content, attachments)
  }

  function queueBusyInput(sid: string, content: string, attachments?: Attachment[]) {
    const userMsg: Message = {
      id: uid(),
      role: 'user',
      content: content.trim(),
      timestamp: Date.now(),
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      queued: true,
    }
    addMessage(sid, userMsg)
    updateSessionTitle(sid)
    if (sid === activeSessionId.value) {
      persistActiveMessages()
      persistSessionsList()
    }
  }

  async function submitNextQueuedMessage(sid: string) {
    const nextQueued = getQueuedMessages(sid)[0]
    if (!nextQueued) return
    await submitMessage(sid, nextQueued.content, nextQueued.attachments, nextQueued.id)
  }

  function markBridgeModeSeen() {
    setItemBestEffort(bridgeSeenKey(), '1')
  }

  function markBridgeLocalSession(sid: string, persistentSessionId?: string) {
    setItemBestEffort(bridgeLocalSessionKey(sid), '1')
    markBridgeModeSeen()
    if (persistentSessionId && persistentSessionId !== sid) {
      setItemBestEffort(bridgePersistentSessionKey(sid), persistentSessionId)
      copySessionModelOverride(sid, persistentSessionId)
      copyCompressionState(sid, persistentSessionId)
    }
  }

  function bindResolvedBridgeSession(webSessionId: string, persistentSessionId?: string | null) {
    const persistent = persistentSessionId?.trim()
    if (!webSessionId || !persistent || persistent === webSessionId) return
    const wasActiveWebSession = activeSessionId.value === webSessionId
    markBridgeLocalSession(webSessionId, persistent)
    const webSession = sessions.value.find(session => session.id === webSessionId)
    if (webSession?.source === 'tui' && isPersistentTuiSessionId(webSessionId)) {
      const rootId = rootSessionIdFor(webSessionId)
      appendRepresentedSessionId(rootId, webSessionId)
      appendRepresentedSessionId(rootId, persistent)
      webSession.representedSessionIds = Array.from(new Set([...(webSession.representedSessionIds || [webSession.id]), persistent]))
      const inFlight = readInFlight(webSessionId)
      if (inFlight && !readInFlight(persistent)) markInFlight(persistent, inFlight.runId)
      persistSessionsList()
      return
    }
    let persistentSession = sessions.value.find(session => session.id === persistent)
    if (!persistentSession && webSession) {
      persistentSession = {
        ...webSession,
        id: persistent,
        representedSessionIds: Array.from(new Set([...(webSession.representedSessionIds || [webSession.id]), persistent])),
      }
      sessions.value.push(persistentSession)
    }
    if (webSession && persistentSession) {
      if (webSession.messages.length > 0) persistentSession.messages = webSession.messages
      persistentSession.updatedAt = Math.max(persistentSession.updatedAt || 0, webSession.updatedAt || 0)
      if (!persistentSession.title && webSession.title) persistentSession.title = webSession.title
      persistentSession.representedSessionIds = Array.from(new Set([
        ...(persistentSession.representedSessionIds || [persistentSession.id]),
        ...(webSession.representedSessionIds || [webSession.id]),
        webSessionId,
        persistent,
      ]))
    }
    if (webSession) {
      const rootId = rootSessionIdFor(webSessionId)
      appendRepresentedSessionId(rootId, webSessionId)
      appendRepresentedSessionId(rootId, persistent)
      webSession.representedSessionIds = Array.from(new Set([...(webSession.representedSessionIds || [webSession.id]), persistent]))
    }
    const inFlight = readInFlight(webSessionId)
    if (inFlight && !readInFlight(persistent)) {
      markInFlight(persistent, inFlight.runId)
    }
    const webSteerHistory = readSteerHistory(webSessionId)
    if (webSteerHistory.length) {
      const persistentSteerHistory = readSteerHistory(persistent)
      const existingKeys = new Set(persistentSteerHistory.map(entry =>
        `${entry.content.trim()}\u0000${entry.timestamp || 0}\u0000${entry.previousMessageId || ''}\u0000${entry.nextMessageId || ''}`,
      ))
      const mergedSteerHistory = [
        ...persistentSteerHistory,
        ...webSteerHistory.filter(entry => {
          const key = `${entry.content.trim()}\u0000${entry.timestamp || 0}\u0000${entry.previousMessageId || ''}\u0000${entry.nextMessageId || ''}`
          if (existingKeys.has(key)) return false
          existingKeys.add(key)
          return true
        }),
      ].slice(-50)
      writeSteerHistory(persistent, mergedSteerHistory)
    }
    const shouldCollapseWebSession = !isPersistentTuiSessionId(webSessionId)
    if (persistentSession && shouldCollapseWebSession) {
      sessions.value = sessions.value.filter(session => session.id !== webSessionId)
      if (webSession?.messages.length) {
        saveJsonWithLegacy(msgsCacheKey(persistent), sanitizeForCache(webSession.messages), legacyMsgsCacheKey(persistent))
      }
    }
    if ((wasActiveWebSession || activeSessionId.value === persistent) && persistentSession && shouldCollapseWebSession) {
      activeSessionId.value = persistent
      activeSession.value = persistentSession
      setItemBestEffort(storageKey(), persistent)
    } else if (activeSessionId.value === persistent && persistentSession) {
      activeSession.value = persistentSession
    }
    persistSessionsList()
  }

  function clearCompressionNoticeTimer(sid: string) {
    const existing = compressionNoticeTimers.get(sid)
    if (!existing) return
    clearTimeout(existing)
    compressionNoticeTimers.delete(sid)
  }

  function scheduleCompressionNoticeClear(sid: string) {
    clearCompressionNoticeTimer(sid)
    compressionNoticeTimers.set(sid, setTimeout(() => {
      const next = { ...compressionBySession.value }
      delete next[sid]
      compressionBySession.value = next
      compressionNoticeTimers.delete(sid)
    }, COMPRESSION_NOTICE_TTL_MS))
  }

  function setCompressionForSession(sid: string, state: CompressionState) {
    compressionBySession.value = {
      ...compressionBySession.value,
      [sid]: state,
    }
    if (state.status === 'started') {
      clearCompressionNoticeTimer(sid)
    } else {
      scheduleCompressionNoticeClear(sid)
    }
  }

  /** Immediately clear compression state for a session (used when compressed=false). */
  function clearCompressionForSession(sid: string) {
    clearCompressionNoticeTimer(sid)
    const next = { ...compressionBySession.value }
    delete next[sid]
    compressionBySession.value = next
  }

  function copyCompressionState(fromSid: string, toSid: string) {
    const state = compressionBySession.value[fromSid]
    if (!state || fromSid === toSid) return
    setCompressionForSession(toSid, state)
  }

  function setCompressionState(sid: string, patch: Partial<CompressionState> & { status: CompressionState['status'] }) {
    const now = Date.now()
    const prev = compressionBySession.value[sid]
    const next: CompressionState = {
      ...prev,
      startedAt: prev?.startedAt ?? now,
      updatedAt: now,
      ...patch,
    }
    setCompressionForSession(sid, next)
    const persistentSid = readBridgePersistentSessionId(sid)
    if (persistentSid && persistentSid !== sid) setCompressionForSession(persistentSid, next)
  }

  function clearPendingRunStart(sid: string) {
    pendingRunStarts.value.delete(sid)
    cancelledPendingStarts.value.delete(sid)
  }

  function setAbortingSession(sid: string, aborting: boolean) {
    const next = new Set(abortingSessions.value)
    if (aborting) next.add(sid)
    else next.delete(sid)
    abortingSessions.value = next
  }

  function sessionFetchId(sid: string): string {
    const persistent = readBridgePersistentSessionId(sid)
    if (persistent) return persistent
    const rootSessionId = sessions.value.find(session => session.id === sid)?.rootSessionId
      || loadBranchSessionMetaIndex()[sid]?.rootSessionId
      || null
    if (rootSessionId && sid.includes(':') && rootSessionId !== sid) return rootSessionId
    return sid
  }

  function rootSessionIdFor(sid: string): string {
    return sessions.value.find(session => session.id === sid)?.rootSessionId || sid
  }

  function appendRepresentedSessionId(rootId: string, representedId: string) {
    if (!rootId || !representedId) return
    const root = sessions.value.find(session => session.id === rootId)
    if (!root) return
    const next = new Set(root.representedSessionIds?.length ? root.representedSessionIds : [root.id])
    next.add(representedId)
    root.representedSessionIds = [...next]
  }

  function normalizeProviderSelection(provider: string, model?: string): string {
    const value = provider.trim()
    if (!value) return ''
    if (value.startsWith('custom:')) return value

    const appStore = useAppStore()
    const normalized = normalizeProviderKey(value)
    const exact = appStore.modelGroups.find(group => normalizeProviderKey(group.provider) === normalized)
    if (exact && (!model || exact.models.includes(model))) return exact.provider

    const custom = appStore.modelGroups.find(group =>
      group.provider.startsWith('custom:')
      && (
        normalizeProviderKey(group.provider.slice('custom:'.length)) === normalized
        || normalizeProviderKey(group.label) === normalized
        || (!!model && group.models.includes(model))
      ),
    )
    if (custom) return custom.provider

    if ((value.includes('.') || value.includes('/')) && !value.startsWith('custom:')) {
      return `custom:${normalized}`
    }
    return value
  }

  function findProviderForModel(model?: string): string {
    if (!model) return ''
    const appStore = useAppStore()
    return appStore.modelGroups.find(group => group.models.includes(model))?.provider || ''
  }

  function findProviderForBaseUrl(baseUrl?: string, model?: string): string {
    const normalized = normalizeBaseUrl(baseUrl || '')
    if (!normalized) return ''
    const appStore = useAppStore()
    const group = appStore.modelGroups.find(item =>
      normalizeBaseUrl(item.base_url || '') === normalized
      && (!model || item.models.includes(model)),
    )
    return group?.provider || ''
  }

  function providerSupportsModel(provider: string, model?: string): boolean {
    if (!provider || !model) return true
    const appStore = useAppStore()
    if (!appStore.modelGroups.length) return true
    const normalized = normalizeProviderKey(provider)
    const group = appStore.modelGroups.find(item => normalizeProviderKey(item.provider) === normalized)
    return group ? group.models.includes(model) : true
  }

  function resolveSendModelSelection(target?: Session | null): { model: string; provider: string } {
    const appStore = useAppStore()
    const appModel = appStore.selectedModel?.trim() || ''
    const appProvider = normalizeProviderSelection(appStore.selectedProvider || '', appModel)
    const targetModel = target?.model?.trim() || activeSession.value?.model?.trim() || ''
    const targetProvider = normalizeProviderSelection(
      target?.provider || activeSession.value?.provider || '',
      targetModel || appModel || undefined,
    )
    const targetBaseUrlProvider = normalizeProviderSelection(
      findProviderForBaseUrl(target?.billingBaseUrl || activeSession.value?.billingBaseUrl || '', targetModel || appModel || undefined),
      targetModel || appModel || undefined,
    )

    if (appModel) {
      if (appProvider && providerSupportsModel(appProvider, appModel)) {
        return { model: appModel, provider: appProvider }
      }
      const modelProvider = normalizeProviderSelection(findProviderForModel(appModel), appModel)
      if (modelProvider) return { model: appModel, provider: modelProvider }
      if (targetModel === appModel && targetProvider && providerSupportsModel(targetProvider, appModel)) return { model: appModel, provider: targetProvider }
      if (targetModel === appModel && targetBaseUrlProvider) return { model: appModel, provider: targetBaseUrlProvider }
      return { model: appModel, provider: '' }
    }

    if (targetModel) {
      if (targetProvider && providerSupportsModel(targetProvider, targetModel)) {
        return { model: targetModel, provider: targetProvider }
      }
      if (targetBaseUrlProvider) return { model: targetModel, provider: targetBaseUrlProvider }
      return {
        model: targetModel,
        provider: normalizeProviderSelection(findProviderForModel(targetModel), targetModel),
      }
    }

    return { model: '', provider: '' }
  }

  async function fetchResolvedSessionDetail(sid: string): Promise<SessionDetail | null> {
    const initial = await fetchSession(sessionFetchId(sid))
    if (initial && initial.id && initial.id !== sid && isBridgeLocalSession(sid)) {
      markBridgeLocalSession(sid, initial.id)
    }
    return initial
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
      const inFlight = readInFlight(sid)
      if (!inFlight) {
        stopPolling(sid)
        return
      }
      try {
        const detail = await fetchResolvedSessionDetail(sid)
        if (!detail) return
        const target = sessions.value.find(s => s.id === sid)
        if (!target) return
        if (isBridgeFallbackSession(detail) && target.messages.length > 0) return
        const mapped = reapplySteerHistory(sid, mapHermesMessages(detail.messages || []))
        // Use the same current-turn comparison as switchSession: server is
        // ahead only when it has a newer user turn or the assistant output
        // after the current user turn has caught up.
        const local = target.messages
        const { serverIsAhead, serverIsCaughtUp } = compareServerMessages(local, mapped)
        const hasBetterToolDetails = serverHasBetterToolDetails(local, mapped)
        if (serverIsAhead) {
          target.messages = withLocalSteeredMessages(mergeServerToolDetails(mapped, target.messages), target.messages)
          if (detail.title && !target.title) {
            logTitleMutation('poll.detail.empty-title', target.id, target.title, detail.title, { sid })
            target.title = detail.title
          }
          if (sid === activeSessionId.value) persistActiveMessages()
        } else if (hasBetterToolDetails) {
          target.messages = mergeServerToolDetails(target.messages, mapped)
          if (detail.title && !target.title) {
            logTitleMutation('poll.detail.empty-title', target.id, target.title, detail.title, { sid })
            target.title = detail.title
          }
          if (sid === activeSessionId.value) persistActiveMessages()
        }
        void refreshSessionBranches(rootSessionIdFor(sid))
        syncApprovalFromMessages(sid, target.messages)
        // During a live SSE stream this poll is only a detail backfill. Do not
        // let a stable DB snapshot conclude the run before run.completed arrives.
        if (streamStates.value.has(sid)) {
          pollSignatures.delete(sid)
          return
        }
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
                target.messages = withLocalSteeredMessages(mergeServerToolDetails(mapped, target.messages), target.messages)
                if (detail.title) {
                  logTitleMutation('poll.detail.stable-exit', target.id, target.title, detail.title, { sid })
                  target.title = detail.title
                }
                if (sid === activeSessionId.value) persistActiveMessages()
              } else if (hasBetterToolDetails) {
                target.messages = mergeServerToolDetails(target.messages, mapped)
                if (detail.title) {
                  logTitleMutation('poll.detail.stable-exit', target.id, target.title, detail.title, { sid })
                  target.title = detail.title
                }
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
    const switchRequestIdAtLoadStart = latestSwitchRequestId
    try {
      // 从 profile 对应的缓存中恢复，实现 instant render
      const cachedSessions = (loadJsonWithFallback<Session[]>(sessionsCacheKey(), legacySessionsCacheKey()) || [])
        .filter(session => session.source !== 'subagent')
      const cachedBranchMetaIndex = loadBranchSessionMetaIndex()
      if (cachedSessions.length) {
        cachedSessions.forEach(session => {
          session.messages = reapplySteerHistory(session.id, scrubBuggyReasoningInCache(session.messages || []))
          applyBranchMeta(session, cachedBranchMetaIndex[session.id], cachedSessions, true)
          applySessionModelOverride(session)
        })
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
      let tuiRaw: SessionSummary[] = []
      try {
        tuiRaw = await fetchHermesSessions('tui')
      } catch {
        tuiRaw = []
      }
      logSessionLoad('fetched', {
        summaryCount: list.length,
        tuiCount: tuiRaw.length,
        summaryIds: list.slice(0, 20).map(item => item.id),
        tuiIds: tuiRaw.slice(0, 20).map(item => item.id),
      })

      const representedIds = new Set<string>()
      for (const item of list) {
        for (const id of representedSessionIdsOf(item)) representedIds.add(id)
      }

      const supplementalCandidates = tuiRaw.filter(item => !representedIds.has(item.id))
      const supplementalParented = supplementalCandidates.filter(item => !!(item as any).parent_session_id).map(item => item.id)
      const supplementalContinuationLike = supplementalCandidates
        .filter(item => looksLikeContinuationPrompt((item as any).preview || item.title || ''))
        .map(item => item.id)
      const supplementalEmptyStubIds = supplementalCandidates
        .filter(item => looksLikeEmptyTuiStub(item))
        .map(item => item.id)
      const supplementalTui: SessionSummary[] = supplementalCandidates.filter(item =>
        !(item as any).parent_session_id
        && !looksLikeContinuationPrompt((item as any).preview || item.title || '')
        && !looksLikeEmptyTuiStub(item)
      )
      const mergedList = [...list, ...supplementalTui]
      logSessionLoad('supplemental-tui', {
        representedIds: Array.from(representedIds).slice(0, 50),
        tuiHermesCount: tuiRaw.length,
        supplementalCandidateIds: supplementalCandidates.slice(0, 80).map(item => item.id),
        supplementalCandidateCount: supplementalCandidates.length,
        supplementalParentedIds: supplementalParented.slice(0, 80),
        supplementalContinuationLikeIds: supplementalContinuationLike.slice(0, 80),
        supplementalEmptyStubIds: supplementalEmptyStubIds.slice(0, 80),
        supplementalAlreadyRepresentedCount: tuiRaw.length - supplementalCandidates.length,
        supplementalTuiIds: supplementalTui.map(item => item.id),
      })
      logTitleSnapshot('loadSessions.summary-input', {
        summaries: mergedList.slice(0, 30).map(item => ({
          id: item.id,
          title: item.title || '',
          preview: item.preview || '',
          representedSessionIds: representedSessionIdsOf(item),
        })),
      })
      const freshRaw = mergedList.map(mapHermesSession).filter(session => !looksLikeEmptyTuiStubSession(session))
      logTitleSnapshot('loadSessions.mapped-fresh', {
        sessions: freshRaw.slice(0, 30).map(session => ({
          id: session.id,
          title: session.title || '',
          representedSessionIds: session.representedSessionIds || [],
        })),
      })
      freshRaw.forEach(applySessionModelOverride)
      const freshRawIds = new Set(freshRaw.map(s => s.id))
      const branchMetaIndex = loadBranchSessionMetaIndex()
      // Preserve already-loaded messages for sessions that are still present,
      // so we don't blow away the active session's messages on refresh.
      const msgsByIdBefore = new Map(sessions.value.map(s => [s.id, s.messages]))
      const branchMetaByIdBefore = new Map(
        sessions.value
          .filter(s => s.isBranchSession && !!s.rootSessionId)
          .map(s => [s.id, {
            parentSessionId: s.parentSessionId ?? null,
            rootSessionId: s.rootSessionId as string,
            branchSessionCount: s.branchSessionCount,
          }]),
      )
      const bridgeLocalByPersistent = new Map<string, Session>()
      for (const s of sessions.value) {
        const persistentId = readBridgeBackingSessionId(s.id)
        if (persistentId) bridgeLocalByPersistent.set(persistentId, s)
      }
      const isLocalRunActive = (sid: string) =>
        streamStates.value.has(sid) || pendingRunStarts.value.has(sid) || resumingRuns.value.has(sid) || !!readInFlight(sid)
      const fresh = freshRaw
      const logicalSeen = new Set<string>()
      const dedupedFresh = fresh.filter(session => {
        const represented = session.representedSessionIds?.length ? session.representedSessionIds : [session.id]
        const duplicate = represented.some(id => logicalSeen.has(id))
        if (duplicate) return false
        represented.forEach(id => logicalSeen.add(id))
        return true
      })
      logSessionLoad('dedupe', {
        freshIds: fresh.map(session => session.id),
        dedupedFreshIds: dedupedFresh.map(session => session.id),
      })
      const representedByOther = new Set<string>()
      for (const session of dedupedFresh) {
        for (const id of session.representedSessionIds || []) {
          if (id !== session.id) representedByOther.add(id)
        }
      }
      const visibleFresh = dedupedFresh.filter(session => {
        if (session.isBranchSession) return true
        if (session.source !== 'tui') return true
        return !representedByOther.has(session.id)
      })
      logSessionLoad('visible', {
        representedByOther: Array.from(representedByOther),
        visibleFreshIds: visibleFresh.map(session => session.id),
      })
      const freshIds = new Set(visibleFresh.map(s => s.id))
      for (const s of visibleFresh) {
        const previousSession = sessions.value.find(session => session.id === s.id) || null
        const previousRepresentedIds = new Set(s.representedSessionIds?.length ? s.representedSessionIds : [s.id])
        const representedLocalSessions = sessions.value.filter(session => {
          const localIds = session.representedSessionIds?.length ? session.representedSessionIds : [session.id]
          return localIds.some(id => previousRepresentedIds.has(id)) || previousRepresentedIds.has(session.id)
        })
        if (representedLocalSessions.length) {
          const mergedIds = new Set(s.representedSessionIds?.length ? s.representedSessionIds : [s.id])
          for (const session of representedLocalSessions) {
            mergedIds.add(session.id)
            for (const id of session.representedSessionIds || []) mergedIds.add(id)
          }
          s.representedSessionIds = Array.from(mergedIds)
        }
        if (previousSession && previousSession.title !== s.title) {
          logTitleSnapshot('loadSessions.pre-hydrate-existing', {
            id: s.id,
            previousTitle: previousSession.title || '',
            freshTitle: s.title || '',
            representedSessionIds: s.representedSessionIds || [],
          })
        }
        const prev = msgsByIdBefore.get(s.id)
        const localBridge = bridgeLocalByPersistent.get(s.id)
        const localBridgeMessages = localBridge ? msgsByIdBefore.get(localBridge.id) || localBridge.messages : null
        if (prev && prev.length) {
          s.messages = prev
        } else if (localBridgeMessages?.length) {
          s.messages = localBridgeMessages
          saveJsonWithLegacy(msgsCacheKey(s.id), sanitizeForCache(localBridgeMessages), legacyMsgsCacheKey(s.id))
        }
        const branchMeta = branchMetaByIdBefore.get(s.id)
          || branchMetaIndex[s.id]
          || (localBridge ? branchMetaByIdBefore.get(localBridge.id) : undefined)
          || (localBridge ? branchMetaIndex[localBridge.id] : undefined)
        applyBranchMeta(s, branchMeta, fresh)
        if (localBridge) copySessionModelOverride(localBridge.id, s.id)
        applySessionModelOverride(s)
      }
      // Preserve local-only sessions the server hasn't seen yet — e.g. a chat
      // that was just created and whose first run is still in-flight. Without
      // this, refreshing mid-run would wipe the session and fall back to
      // sessions[0], which is exactly what the user reported.
      // Sessions without an active in-flight run are considered deleted and
      // cleaned up along with their cached messages.
      const localOnly = sessions.value.filter(s => {
        if (looksLikeEmptyTuiStubSession(s)) {
          removeItemWithLegacy(msgsCacheKey(s.id), legacyMsgsCacheKey(s.id))
          removeItemWithLegacy(inFlightKey(s.id), legacyInFlightKey(s.id))
          clearSessionModelOverride(s.id)
          clearBridgeLocalSession(s.id)
          return false
        }
        if (freshIds.has(s.id)) return false
        const persistentId = readBridgeBackingSessionId(s.id)
        if (persistentId && freshRawIds.has(persistentId)) {
          if (isPersistentTuiSessionId(s.id) && persistentId !== s.id) return true
          if (activeSessionId.value === s.id) {
            activeSessionId.value = persistentId
            setItemBestEffort(storageKey(), persistentId)
          }
          removeItemWithLegacy(msgsCacheKey(s.id), legacyMsgsCacheKey(s.id))
          removeItemWithLegacy(inFlightKey(s.id), legacyInFlightKey(s.id))
          clearSessionModelOverride(s.id)
          clearBridgeLocalSession(s.id)
          return false
        }
        if (readInFlight(s.id)) return true
        if (isBridgeLocalSession(s.id)) {
          if (isLocalRunActive(s.id) || !isPersistentTuiSessionId(s.id)) return true
          removeItemWithLegacy(msgsCacheKey(s.id), legacyMsgsCacheKey(s.id))
          removeItemWithLegacy(inFlightKey(s.id), legacyInFlightKey(s.id))
          clearSessionModelOverride(s.id)
          clearBridgeLocalSession(s.id)
          return false
        }
        if (s.isBranchSession) {
          return !!s.rootSessionId && hasLoadedBranches(s.rootSessionId, fresh)
        }
        // Session no longer exists on server and no active run — clean up cache
        removeItemWithLegacy(msgsCacheKey(s.id), legacyMsgsCacheKey(s.id))
        removeItemWithLegacy(inFlightKey(s.id), legacyInFlightKey(s.id))
        clearSessionModelOverride(s.id)
        clearBridgeLocalSession(s.id)
        return false
      })
      logSessionLoad('local-only', {
        localOnlyIds: localOnly.map(session => session.id),
      })
      const localOnlyBackings = new Set<string>()
      for (const session of localOnly) {
        const backingId = readBridgeBackingSessionId(session.id)
        if (backingId && backingId !== session.id && isPersistentTuiSessionId(session.id)) localOnlyBackings.add(backingId)
      }
      sessions.value = [...localOnly, ...visibleFresh.filter(session => !localOnlyBackings.has(session.id))]
      logTitleSnapshot('loadSessions.after-rebuild', {
        sessions: sessions.value.slice(0, 30).map(session => ({
          id: session.id,
          title: session.title || '',
          representedSessionIds: session.representedSessionIds || [],
          isBranchSession: !!session.isBranchSession,
        })),
      })
      persistSessionsList()

      // Restore last active session, fallback to the session that represents
      // the previously active real session, then the most recent session.
      const savedId = activeSessionId.value
      const representedTarget = savedId
        ? sessions.value.find(session => (session.representedSessionIds || [session.id]).includes(savedId))
        : null
      const targetId = savedId && sessions.value.some(s => s.id === savedId)
        ? savedId
        : representedTarget?.id || sessions.value[0]?.id
      logSessionLoad('restore-target', {
        savedId,
        representedTargetId: representedTarget?.id || null,
        targetId: targetId || null,
      })
      if (representedTarget) {
        logTitleSnapshot('loadSessions.restore-target-title', {
          savedId,
          representedTargetId: representedTarget.id,
          representedTargetTitle: representedTarget.title || '',
          representedSessionIds: representedTarget.representedSessionIds || [],
        })
      }
      if (targetId && latestSwitchRequestId === switchRequestIdAtLoadStart) {
        logActiveBinding('loadSessions:rebind-before-switch', {
          source: 'loadSessions:rebind-before-switch',
          targetId,
          beforeActiveSessionId: activeSessionId.value,
          beforeActiveSessionObjId: activeSession.value?.id || null,
          beforeActiveTitle: activeSession.value?.title || '',
        })
        activeSessionId.value = targetId
        activeSession.value = sessions.value.find(session => session.id === targetId) || null
        logActiveBinding('loadSessions:rebind-after-lookup', {
          source: 'loadSessions:rebind-after-lookup',
          targetId,
          afterActiveSessionId: activeSessionId.value,
          afterActiveSessionObjId: activeSession.value?.id || null,
          afterActiveTitle: activeSession.value?.title || '',
        })
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
    logActiveBinding('refreshActiveSession:start', {
      source: 'refreshActiveSession:start',
      sid,
      activeSessionObjId: activeSession.value?.id || null,
      activeTitle: activeSession.value?.title || '',
    })
    try {
      const detail = await fetchResolvedSessionDetail(sid)
      if (activeSessionId.value !== sid || activeSession.value?.id !== sid) return false
      if (!detail) return false
      const target = sessions.value.find(s => s.id === sid)
      if (!target) return false
      if (isBridgeFallbackSession(detail) && target.messages.length > 0) return true
      const mapped = reapplySteerHistory(sid, mapHermesMessages(detail.messages || []))
      // If the session has a resuming run, local messages are more current —
      // only merge tool detail enrichment from the server.
      const hasResumingRun = resumingRuns.value.has(sid)
      const { serverIsAhead } = compareServerMessages(target.messages, mapped)
      if (hasResumingRun) {
        if (serverHasBetterToolDetails(target.messages, mapped)) {
          target.messages = mergeServerToolDetails(target.messages, mapped)
          persistActiveMessages()
        }
      } else if (serverIsAhead) {
        target.messages = withLocalSteeredMessages(mergeServerToolDetails(mapped, target.messages), target.messages)
        persistActiveMessages()
      } else if (serverHasBetterToolDetails(target.messages, mapped)) {
        target.messages = mergeServerToolDetails(target.messages, mapped)
        persistActiveMessages()
      }
      applySessionDetail(target, detail)
      void refreshSessionBranches(rootSessionIdFor(sid))
      if (isSessionLive(sid) || readInFlight(sid)) {
        syncApprovalFromMessages(sid, target.messages)
        void pollClarifyOnce(sid)
        startClarifyPolling(sid)
      } else {
        const pendingState = await getPendingApproval(sid)
        if (activeSessionId.value !== sid || activeSession.value?.id !== sid) return false
        if (pendingState.pending) {
          setApprovalPending(sid, {
            ...pendingState.pending,
            _session_id: sid,
          }, pendingState.pending_count || 1)
        } else {
          clearApproval(sid)
        }
        clearClarify(sid)
      }
      if (detail.title && !looksLikeContinuationPrompt(detail.title)) {
        logTitleMutation('refreshActiveSession.detail', target.id, target.title, detail.title, { sid })
        target.title = detail.title
      }
      logActiveBinding('refreshActiveSession:end', {
        source: 'refreshActiveSession:end',
        sid,
        activeSessionObjId: activeSession.value?.id || null,
        activeTitle: activeSession.value?.title || '',
        targetObjId: target.id,
        targetTitle: target.title || '',
      })
      return true
    } catch (err) {
      console.error('Failed to refresh active session:', err)
      return false
    }
  }

  async function refreshSessionAfterRunSettled(sid: string) {
    const persistentSid = readBridgeBackingSessionId(sid)
    if (persistentSid && persistentSid !== sid) {
      await loadSessions()
      await refreshSessionBranches(rootSessionIdFor(persistentSid))
      return
    }
    if (sid === activeSessionId.value) {
      await refreshActiveSession()
      await refreshSessionBranches(rootSessionIdFor(sid))
      return
    }
    await refreshSessionBranches(rootSessionIdFor(sid))
  }


  function attachRunStream(sid: string, runId: string) {
    clearPendingRunStart(sid)
    markInFlight(sid, runId)
    stopPolling(sid)
    stopApprovalPolling(sid)
    stopClarifyPolling(sid)
    clearApproval(sid)
    clearClarify(sid)

    // Proactively poll approval state even during the live SSE run. This covers
    // gateways/upstreams that delay or omit a named `approval` SSE event; the UI
    // should surface the approval card as soon as the session enters that state,
    // not only after the round finishes and we later rehydrate from history.
    void pollApprovalOnce(sid)
    startApprovalPolling(sid)
    void pollClarifyOnce(sid)
    startClarifyPolling(sid)

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
      flushStreamDeltas()
    }

    let persistTimer: ReturnType<typeof setTimeout> | null = null
    let branchRefreshTimer: ReturnType<typeof setInterval> | null = null
    let streamFlushTimer: ReturnType<typeof setTimeout> | null = null
    const pendingStreamDeltas = new Map<string, { content: string; reasoning: string }>()
    let runProducedAssistantText = false
    let runHadToolActivity = false
    let resolvedStreamSessionId: string | null = null
    const runSid = () => resolvedStreamSessionId || sid
    const schedulePersist = () => {
      if (persistTimer) return
      persistTimer = setTimeout(() => {
        persistTimer = null
        persistSessionMessages(runSid())
        persistSessionsList()
      }, 800)
    }

    const flushStreamDeltas = () => {
      if (streamFlushTimer) {
        clearTimeout(streamFlushTimer)
        streamFlushTimer = null
      }
      if (pendingStreamDeltas.size === 0) return
      const pending = Array.from(pendingStreamDeltas.entries())
      pendingStreamDeltas.clear()
      const targetSid = runSid()
      const msgs = getSessionMsgs(targetSid)
      for (const [messageId, delta] of pending) {
        const message = msgs.find(m => m.id === messageId)
        if (!message) continue
        const update: Partial<Message> = {}
        if (delta.content) {
          const prev = message.content || ''
          const next = prev + delta.content
          noteThinkingDelta(messageId, prev, next)
          if (message.reasoning) noteReasoningEnd(messageId)
          update.content = next
        }
        if (delta.reasoning) {
          update.reasoning = (message.reasoning || '') + delta.reasoning
          noteReasoningStart(messageId)
        }
        if (Object.keys(update).length > 0) updateMessage(targetSid, messageId, update)
      }
      schedulePersist()
    }

    const scheduleStreamFlush = () => {
      if (streamFlushTimer) return
      streamFlushTimer = setTimeout(flushStreamDeltas, STREAM_FLUSH_INTERVAL_MS)
    }

    const appendStreamDelta = (messageId: string, field: 'content' | 'reasoning', text: string) => {
      if (!text) return
      const existing = pendingStreamDeltas.get(messageId) || { content: '', reasoning: '' }
      existing[field] += text
      pendingStreamDeltas.set(messageId, existing)
      scheduleStreamFlush()
    }

    if (runId.startsWith('bridge_run_')) {
      void refreshSessionBranches(rootSessionIdFor(sid))
      branchRefreshTimer = setInterval(() => {
        void refreshSessionBranches(rootSessionIdFor(sid))
      }, LIVE_BRANCH_REFRESH_INTERVAL_MS)
    }

    const eventState = { runProducedAssistantText: false, runHadToolActivity: false }
    const streamCallbacks: RunStreamCallbacks = {
      getMessages: () => getSessionMsgs(runSid()),
      addMessage: (msg) => addMessage(runSid(), msg),
      updateMessage: (id, update) => updateMessage(runSid(), id, update),
      uid,
      setCompressionState: (data) => setCompressionState(runSid(), data),
      clearCompression: () => clearCompressionForSession(runSid()),
      upsertSubagentBranch: (evt) => upsertSubagentBranch(sid, evt),
      setApprovalPending: (evt) => {
        const targetSid = runSid()
        setApprovalPending(targetSid, {
          approval_id: evt.approval_id,
          description: evt.description,
          command: evt.command,
          pattern_key: evt.pattern_key,
          pattern_keys: evt.pattern_keys,
          _session_id: targetSid,
        }, evt.pending_count || 1)
      },
      startApprovalPolling: () => startApprovalPolling(runSid()),
      setClarifyPending: (evt) => {
        const targetSid = runSid()
        setClarifyPending(targetSid, {
          request_id: typeof evt.request_id === 'string' ? evt.request_id : '',
          question: typeof evt.question === 'string' ? evt.question : '',
          choices: Array.isArray(evt.choices) ? evt.choices.map(String) : [],
          requested_at: typeof evt.timestamp === 'number' ? evt.timestamp : undefined,
          _session_id: targetSid,
        })
      },
      startClarifyPolling: () => startClarifyPolling(runSid()),
      clearApproval: () => {
        const targetSid = runSid()
        if (approvalsBySession.value[targetSid]?.pending?._optimistic) clearApproval(targetSid)
      },
      applySessionUsage: (usage) => {
        const target = sessions.value.find(s => s.id === runSid())
        applySessionUsage(target, usage, { allowReset: true })
      },
      persistSessionsList: () => persistSessionsList(),
      noteThinkingDelta: (messageId, prev, next) => noteThinkingDelta(messageId, prev, next),
      noteReasoningStart: (messageId) => noteReasoningStart(messageId),
      noteReasoningEnd: (messageId) => noteReasoningEnd(messageId),
      appendStreamDelta: (messageId, field, text) => appendStreamDelta(messageId, field, text),
      flushStreamDeltas: () => flushStreamDeltas(),
      schedulePersist: () => schedulePersist(),
    }

    const ctrl = streamRunEvents(
      runId,
      (evt: RunEvent) => {
        if (evt.event === 'session.resolved') {
          const webSessionId = typeof evt.web_session_id === 'string' && evt.web_session_id.trim()
            ? evt.web_session_id.trim()
            : sid
          const persistentSessionId = typeof evt.persistent_session_id === 'string' && evt.persistent_session_id.trim()
            ? evt.persistent_session_id.trim()
            : typeof evt.session_id === 'string'
              ? evt.session_id.trim()
              : ''
          bindResolvedBridgeSession(webSessionId, persistentSessionId)
          if (persistentSessionId && !isPersistentTuiSessionId(webSessionId)) {
            resolvedStreamSessionId = persistentSessionId
          }
          return
        }

        // Handle run.completed and run.failed in the store (require extensive cleanup)
        if (evt.event === 'run.completed') {
          runProducedAssistantText = eventState.runProducedAssistantText
          runHadToolActivity = eventState.runHadToolActivity
          const targetSid = runSid()
          const msgs = getSessionMsgs(targetSid)
          const lastMsg = msgs[msgs.length - 1]
          if (lastMsg?.isStreaming) {
            updateMessage(targetSid, lastMsg.id, { isStreaming: false })
          }
          const target = sessions.value.find(s => s.id === targetSid)
          applySessionUsage(target, usageFromRunEvent(evt))
          const finalOutput = typeof evt.output === 'string' ? evt.output : ''
          const eventOutput = finalOutput || textFromRunEvent(evt)
          const eventOutputTrimmed = eventOutput.trim()
          if (!runProducedAssistantText && eventOutputTrimmed !== '') {
            addMessage(targetSid, {
              id: uid(),
              role: 'assistant',
              content: eventOutput,
              timestamp: Date.now(),
            })
            runProducedAssistantText = true
          }
          const swallowedError = !runProducedAssistantText && !runHadToolActivity && eventOutputTrimmed === ''
          if (swallowedError) {
            addMessage(targetSid, {
              id: uid(),
              role: 'system',
              content: 'Error: Agent returned no output. The model call may have failed (e.g. invalid API key, model not supported by provider, or context exceeded). Check the hermes-agent logs for details.',
              timestamp: Date.now(),
            })
          }
          if (autoPlaySpeechEnabled.value) {
            const lastAssistant = [...getSessionMsgs(targetSid)].reverse().find(m => m.role === 'assistant')
            if (lastAssistant?.content) {
              window.setTimeout(() => {
                playMessageSpeech(lastAssistant.id, lastAssistant.content)
              }, 300)
            }
          }
          playCompletionBellIfEnabled()
          finishLiveSubagentBranches(sid, 'complete')
          cleanup()
          updateSessionTitle(targetSid)
          persistSessionMessages(targetSid)
          persistSessionsList()
          clearInFlight(sid)
          if (targetSid !== sid) clearInFlight(targetSid)
          stopPolling(sid)
          stopApprovalPolling(sid)
          stopClarifyPolling(sid)
          clearApproval(sid)
          clearClarify(sid)
          void refreshSessionAfterRunSettled(targetSid)
          return
        }

        if (evt.event === 'run.failed') {
          const targetSid = runSid()
          const msgs = getSessionMsgs(targetSid)
          const lastErr = msgs[msgs.length - 1]
          if (lastErr?.isStreaming) {
            updateMessage(targetSid, lastErr.id, {
              isStreaming: false,
              content: evt.error ? `Error: ${evt.error}` : 'Run failed',
              role: 'system',
            })
          } else {
            addMessage(targetSid, {
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
          if (approvalsBySession.value[targetSid]?.pending?._optimistic) {
            clearApproval(targetSid)
          }
          finishLiveSubagentBranches(sid, 'error')
          cleanup()
          persistSessionMessages(targetSid)
          persistSessionsList()
          clearInFlight(sid)
          if (targetSid !== sid) clearInFlight(targetSid)
          stopPolling(sid)
          stopApprovalPolling(sid)
          stopClarifyPolling(sid)
          clearApproval(sid)
          clearClarify(sid)
          return
        }

        // All other events handled by the extracted SSE stream manager
        processRunEvent(evt, streamCallbacks, eventState)
      },
      () => {
        const targetSid = runSid()
        const msgs = getSessionMsgs(targetSid)
        const last = msgs[msgs.length - 1]
        if (last?.isStreaming) {
          updateMessage(targetSid, last.id, { isStreaming: false })
        }
        finishLiveSubagentBranches(sid, 'complete')
        cleanup()
        updateSessionTitle(targetSid)
        clearInFlight(sid)
        if (targetSid !== sid) clearInFlight(targetSid)
        stopPolling(sid)
        stopApprovalPolling(sid)
        stopClarifyPolling(sid)
        clearApproval(sid)
        clearClarify(sid)
        persistSessionMessages(targetSid)
        persistSessionsList()
        void submitNextQueuedMessage(targetSid)
      },
      (err) => {
        console.warn('SSE connection dropped, resyncing from server:', err.message)
        const targetSid = runSid()
        const msgs = getSessionMsgs(targetSid)
        const last = msgs[msgs.length - 1]
        if (last?.isStreaming) {
          updateMessage(targetSid, last.id, { isStreaming: false })
        }
        msgs.forEach((m, i) => {
          if (m.role === 'tool' && m.toolStatus === 'running') {
            msgs[i] = { ...m, toolStatus: 'done' }
          }
        })
        cleanup()
        if (targetSid === activeSessionId.value || sid === activeSessionId.value) {
          void refreshActiveSession()
        }
        persistSessionMessages(targetSid)
        persistSessionsList()
        if (readInFlight(sid)) {
          startPolling(sid)
          void pollApprovalOnce(sid)
          startApprovalPolling(sid)
          void pollClarifyOnce(sid)
          startClarifyPolling(sid)
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

  async function switchSession(sessionId: string, focusId?: string | null, prefetchedDetail: SessionDetail | null = null, toolDetailsPreMerged = false) {
    const switchRequestId = ++latestSwitchRequestId
    const previousSessionId = activeSessionId.value
    logActiveBinding('switchSession:start', {
      source: 'switchSession:start',
      sessionId,
      previousSessionId,
      previousActiveObjId: activeSession.value?.id || null,
      previousActiveTitle: activeSession.value?.title || '',
    })
    clearThinkingObservationFor(sessionId)
    activeSessionId.value = sessionId
    focusMessageId.value = focusId ?? null
    setItemBestEffort(storageKey(), sessionId)
    const legacyActiveKey = legacyStorageKey()
    if (legacyActiveKey) removeItem(legacyActiveKey)
    for (const session of sessions.value) {
      if (readBridgeBackingSessionId(session.id) === sessionId) {
        bindResolvedBridgeSession(session.id, sessionId)
      }
    }
    activeSession.value = sessions.value.find(s => s.id === sessionId) || null
    const targetSession = activeSession.value
    logActiveBinding('switchSession:set-active', {
      source: 'switchSession:set-active',
      sessionId,
      activeSessionId: activeSessionId.value,
      activeSessionObjId: activeSession.value?.id || null,
      activeTitle: activeSession.value?.title || '',
    })

    if (!targetSession) return

    // Hydrate messages from localStorage cache first (instant render), then
    // revalidate from server in the background. If no cache exists, show the
    // loading state while we fetch.
    const hasLocalMessages = targetSession.messages.length > 0
    if (!hasLocalMessages) {
      const cachedMsgs = loadJsonWithFallback<Message[]>(msgsCacheKey(sessionId), legacyMsgsCacheKey(sessionId))
      if (cachedMsgs?.length) {
        targetSession.messages = reapplySteerHistory(sessionId, scrubBuggyReasoningInCache(cachedMsgs))
      }
    }

    const needsBlockingLoad = targetSession.messages.length === 0
    if (needsBlockingLoad) isLoadingMessages.value = true

    try {
      const detail = prefetchedDetail ?? await fetchResolvedSessionDetail(sessionId)
      if (switchRequestId !== latestSwitchRequestId || activeSessionId.value !== sessionId || activeSession.value?.id !== sessionId || targetSession.id !== sessionId) return
      if (!detail && looksLikeWrapperOnlyMessages(targetSession.messages)) {
        targetSession.messages = []
        persistActiveMessages()
      }
      if (detail && detail.messages) {
        if (isBridgeFallbackSession(detail)) {
          if (looksLikeWrapperOnlyMessages(targetSession.messages)) {
            targetSession.messages = []
            persistActiveMessages()
          }
          if (targetSession.messages.length > 0) return
        }
        const mapped = reapplySteerHistory(sessionId, mapHermesMessages(detail.messages))
        // When switching to a different session, accept the server's messages
        // — but NOT if the target session has a live stream or a resuming run.
        // In that case local messages are more up-to-date (streaming content,
        // queued user turns) and the server snapshot would clobber them.
        // The active SSE stream or polling will keep messages current.
        const switchingSessions = previousSessionId !== sessionId
        const targetHasActiveStream = candidateSessionIdsForRun(sessionId).some(candidateId =>
          streamStates.value.has(candidateId) || resumingRuns.value.has(candidateId) || readInFlight(candidateId),
        )
        const local = targetSession.messages
        if (targetHasActiveStream) {
          // Only merge tool detail enrichment from the server; never overwrite
          // streaming content or queued/steered user messages.
          if (serverHasBetterToolDetails(local, mapped)) {
            const nextMessages = mergeServerToolDetails(targetSession.messages, mapped)
            if (!messagesEquivalent(targetSession.messages, nextMessages)) {
              targetSession.messages = nextMessages
            }
          }
        } else if (switchingSessions) {
          // When switching to a different session, accept server messages
          // directly.  Do NOT merge tool details from the old session's
          // localStorage cache — fallback index matching can cross-
          // contaminate tool messages between sessions.
          // Exception: switchBranchSession sets toolDetailsPreMerged=true
          // because it already merged tool details into the session.
          const base = toolDetailsPreMerged
            ? targetSession.messages  // Already merged — keep as-is
            : mapped
          const nextMessages = withLocalSteeredMessages(base, targetSession.messages)
          if (!messagesEquivalent(targetSession.messages, nextMessages)) {
            targetSession.messages = nextMessages
          }
        } else if (compareServerMessages(local, mapped).serverIsAhead) {
          const nextMessages = withLocalSteeredMessages(mergeServerToolDetails(mapped, targetSession.messages), targetSession.messages)
          if (!messagesEquivalent(targetSession.messages, nextMessages)) {
            targetSession.messages = nextMessages
          }
        } else if (serverHasBetterToolDetails(local, mapped)) {
          const nextMessages = mergeServerToolDetails(targetSession.messages, mapped)
          if (!messagesEquivalent(targetSession.messages, nextMessages)) {
            targetSession.messages = nextMessages
          }
        }
        void refreshSessionBranches(rootSessionIdFor(sessionId))
        if (isSessionLive(sessionId) || readInFlight(sessionId)) {
          syncApprovalFromMessages(sessionId, targetSession.messages)
          void pollClarifyOnce(sessionId)
          startClarifyPolling(sessionId)
        } else {
          const pendingState = await getPendingApproval(sessionId)
          if (switchRequestId !== latestSwitchRequestId || activeSessionId.value !== sessionId || activeSession.value?.id !== sessionId || targetSession.id !== sessionId) return
          if (pendingState.pending) {
            setApprovalPending(sessionId, {
              ...pendingState.pending,
              _session_id: sessionId,
            }, pendingState.pending_count || 1)
          } else {
            clearApproval(sessionId)
          }
          clearClarify(sessionId)
        }
        // Update title: use Hermes title, or fallback to first user message
        if (detail.title && !looksLikeContinuationPrompt(detail.title)) {
          console.info('[chat.switchSession.detail]', {
            requestedSessionId: sessionId,
            detailId: detail.id,
            detailTitle: detail.title,
            activeSessionIdNow: activeSessionId.value,
            activeSessionObjIdNow: activeSession.value?.id || null,
            beforeTitle: targetSession.title || '',
            afterTitle: detail.title,
          })
          logTitleMutation('switchSession.detail', targetSession.id, targetSession.title, detail.title, { sessionId })
          targetSession.title = detail.title
        } else if (!targetSession.title) {
          const firstUser = (targetSession.messages).find(m => m.role === 'user' && !m.steered)
          if (firstUser) {
            const t = firstUser.content.slice(0, 40)
            const nextTitle = t + (firstUser.content.length > 40 ? '...' : '')
            logTitleMutation('switchSession.fallback-first-user', targetSession.id, targetSession.title, nextTitle, { sessionId })
            targetSession.title = nextTitle
          }
        }
        applySessionDetail(targetSession, detail)
        logActiveBinding('switchSession:after-detail', {
          source: 'switchSession:after-detail',
          sessionId,
          activeSessionId: activeSessionId.value,
          activeSessionObjId: activeSession.value?.id || null,
          activeTitle: targetSession.title || '',
        })
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
    if (switchRequestId !== latestSwitchRequestId || activeSessionId.value !== sessionId || activeSession.value?.id !== sessionId) return
    if (readInFlight(sessionId) && !streamStates.value.has(sessionId)) {
      // If the server already shows this session as ended, the in-flight
      // record is stale — clear it and skip resume to avoid blocking the UI.
      if (activeSession.value?.endedAt != null) {
        clearInFlight(sessionId)
      } else {
        resumeInFlightRun(sessionId)
        void pollApprovalOnce(sessionId)
        startApprovalPolling(sessionId)
        void pollClarifyOnce(sessionId)
        startClarifyPolling(sessionId)
      }
    }

    // Fetch token usage for this session from web-ui DB
    try {
      const usage = await fetchSessionUsageSingle(sessionId)
      if (switchRequestId !== latestSwitchRequestId || activeSessionId.value !== sessionId || activeSession.value?.id !== sessionId) return
      applySessionUsage(activeSession.value, usage)
    } catch { /* non-critical */ }
  }

  function newChat() {
    if (isStreaming.value) return
    const session = createSession()
    // Inherit current global model
    const appStore = useAppStore()
    session.model = appStore.selectedModel || undefined
    session.provider = normalizeProviderSelection(appStore.selectedProvider || '', session.model)
    if (session.model) writeSessionModelOverride(session.id, session.model, session.provider)
    switchSession(session.id)
  }

  async function switchSessionModel(modelId: string, provider?: string, options: { updateGlobal?: boolean } = {}) {
    if (!activeSession.value) return
    activeSession.value.model = modelId
    activeSession.value.provider = normalizeProviderSelection(provider || '', modelId)
    writeSessionModelOverride(activeSession.value.id, modelId, activeSession.value.provider)
    persistSessionsList()
    // If provider changed, update global config too (Hermes requires it)
    if (provider && options.updateGlobal !== false) {
      const { useAppStore } = await import('./app')
      await useAppStore().switchModel(modelId, provider)
    }
  }

  async function deleteSession(sessionId: string) {
    const target = sessions.value.find(session => session.id === sessionId)
    const removedIds = [...new Set([sessionId, ...(target?.representedSessionIds || [])])]
    const ok = await deleteSessionApi(sessionId)
    if (!ok) return false

    sessions.value = sessions.value.filter(s => s.id !== sessionId)
    for (const removedId of removedIds) {
      removeItemWithLegacy(msgsCacheKey(removedId), legacyMsgsCacheKey(removedId))
      clearSessionModelOverride(removedId)
      clearInFlight(removedId)
      clearBridgeLocalSession(removedId)
      stopPolling(removedId)
      stopApprovalPolling(removedId)
      stopClarifyPolling(removedId)
      clearApproval(removedId)
      clearClarify(removedId)
    }
    persistSessionsList()
    if (activeSessionId.value === sessionId) {
      if (sessions.value.length > 0) {
        await switchSession(sessions.value[0].id)
      } else {
        const session = createSession()
        switchSession(session.id)
      }
    }
    return true
  }

  function getSessionMsgs(sessionId: string): Message[] {
    const s = sessions.value.find(s => s.id === sessionId)
    return s?.messages || []
  }

  function addMessage(sessionId: string, msg: Message) {
    const s = sessions.value.find(s => s.id === sessionId)
    if (s) {
      s.messages.push(msg)
      s.updatedAt = Math.max(s.updatedAt || 0, msg.timestamp || Date.now())
    }
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
        const nextTitle = title.slice(0, 40) + (title.length > 40 ? '...' : '')
        logTitleMutation('updateSessionTitle', target.id, target.title, nextTitle, { sessionId })
        target.title = nextTitle
      }
    }
    target.updatedAt = Date.now()
  }

  function finishLiveSubagentBranches(rootSessionId: string, fallbackStatus: 'complete' | 'error') {
    const branches = liveBranchesBySession.value[rootSessionId] || []
    if (!branches.some(branch => branch.source === 'subagent' && branch.is_active)) return

    const now = Date.now() / 1000
    const activitiesForRoot = subagentActivityBySession.value[rootSessionId] || {}
    const nextActivities: Record<string, ConversationMessage[]> = { ...activitiesForRoot }
    const nextBranches = branches.map(branch => {
      if (branch.source !== 'subagent' || !branch.is_active) return branch

      const goal = branch.messages.find(message => message.role === 'user')?.content
        || branch.title
        || 'Subagent'
      const existingEvents = nextActivities[branch.session_id] || []
      const hasTerminalEvent = existingEvents.some(message => {
        const { kind } = parseSubagentStatus(message.content)
        return kind === 'complete' || kind === 'error' || kind === 'result'
      })
      const events = hasTerminalEvent
        ? existingEvents
        : [
            ...existingEvents,
            {
              id: `subagent.${fallbackStatus}:parent`,
              session_id: branch.session_id,
              role: 'assistant' as const,
              content: fallbackStatus === 'complete'
                ? '[complete] Parent run completed'
                : '[error] Parent run failed',
              timestamp: now,
            },
          ]
      nextActivities[branch.session_id] = events

      const messages: ConversationMessage[] = [
        {
          id: `${branch.session_id}:task`,
          session_id: branch.session_id,
          role: 'user',
          content: goal,
          timestamp: branch.started_at || now,
        },
        {
          id: `${branch.session_id}:live`,
          session_id: branch.session_id,
          role: 'assistant',
          content: formatSubagentLiveTranscript(events, goal, false),
          timestamp: now,
        },
      ]
      return {
        ...branch,
        is_active: false,
        ended_at: branch.ended_at ?? now,
        last_active: now,
        messages,
        visible_count: messages.length,
      }
    })

    liveBranchesBySession.value = {
      ...liveBranchesBySession.value,
      [rootSessionId]: nextBranches,
    }
    subagentActivityBySession.value = {
      ...subagentActivityBySession.value,
      [rootSessionId]: nextActivities,
    }
    syncBranchSessions(rootSessionId)
  }

  async function refreshSessionBranches(sid: string) {
    const fetchId = sessionFetchId(sid)
    if (!fetchId) return
    if (branchRefreshInFlight.has(fetchId)) return
    branchRefreshInFlight.add(fetchId)
    try {
      const detail = await fetchConversationDetail(fetchId, { humanOnly: true })
      const branchCount = countBranchTree(detail.branches || [])
      const existingSession = sessions.value.find(item => item.id === sid)
      const previousBranchCount = existingSession?.branchSessionCount || 0
      const hadLoadedBranchStructure = countBranchTree(dbBranchesBySession.value[sid] || []) > 0
        || countBranchTree(liveBranchesBySession.value[sid] || []) > 0
      const shouldPreserveBranchMeta = hadLoadedBranchStructure && previousBranchCount > 0 && branchCount === 0
      const nextBranches = shouldPreserveBranchMeta
        ? (dbBranchesBySession.value[sid] || [])
        : (detail.branches || [])
      dbBranchesBySession.value = {
        ...dbBranchesBySession.value,
        [sid]: nextBranches,
      }
      persistBranchSessionMeta(sid, nextBranches)
      const session = sessions.value.find(item => item.id === sid)
      if (session) {
        session.branchSessionCount = shouldPreserveBranchMeta ? previousBranchCount : branchCount
      }
      syncBranchSessions(sid)
      promoteMergedSubagentBranchSessions(sid)
      reconcileBranchSessions(sid)
      await hydrateActiveBranchSession(sid)
      if (activeSession.value?.rootSessionId === sid) persistActiveMessages()
    } catch {
      // Branch detail is best-effort; normal chat streaming must not depend on it.
    } finally {
      branchRefreshInFlight.delete(fetchId)
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
      role: 'assistant',
      content,
      timestamp: now,
    }
    const previousEvents = subagentActivityBySession.value[sessionId]?.[subagentId] || []
    const events = [
      ...previousEvents.filter(message => message.id !== eventMessage.id),
      eventMessage,
    ].sort((a, b) => a.timestamp - b.timestamp)
    subagentActivityBySession.value = {
      ...subagentActivityBySession.value,
      [sessionId]: {
        ...(subagentActivityBySession.value[sessionId] || {}),
        [subagentId]: events,
      },
    }
    const isActive = evt.event !== 'subagent.complete' && evt.event !== 'subagent.error'
    const messages: ConversationMessage[] = [
      {
        id: `${subagentId}:task`,
        session_id: subagentId,
        role: 'user',
        content: goal,
        timestamp: existing?.started_at || now,
      },
      {
        id: `${subagentId}:live`,
        session_id: subagentId,
        role: 'assistant',
        content: formatSubagentLiveTranscript(events, goal, isActive),
        timestamp: now,
      },
    ]
    const branch: ConversationBranch = {
      session_id: subagentId,
      parent_session_id: evt.parent_id || sessionFetchId(sessionId),
      source: 'subagent',
      model: evt.model || '',
      title: depth > 0 ? `Subagent L${depth}: ${goal}` : goal,
      started_at: existing?.started_at || now,
      ended_at: isActive ? null : now,
      last_active: now,
      is_active: isActive,
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
    syncBranchSessionFromBranch(sessionId, findBranchById(sessionBranches(sessionId), subagentId) || branch)
    if (activeSessionId.value === subagentId) persistActiveMessages()
    void refreshSessionBranches(rootSessionIdFor(sessionId))
  }

  async function respondClarify(answer: string) {
    const sid = activeSessionId.value
    if (!sid) return
    const state = activeClarify.value
    if (!state?.pending || !answer.trim()) return
    const targetSessionId = state.pending._session_id || sid

    clarifiesBySession.value = {
      ...clarifiesBySession.value,
      [targetSessionId]: {
        ...state,
        submitting: true,
      },
    }

    try {
      await respondClarifyApi({
        session_id: targetSessionId,
        request_id: state.pending.request_id,
        answer: answer.trim(),
      })
      clearClarify(targetSessionId)
      await pollClarifyOnce(targetSessionId)
    } catch (error) {
      clarifiesBySession.value = {
        ...clarifiesBySession.value,
        [targetSessionId]: {
          ...state,
          submitting: false,
        },
      }
      throw error
    }
  }

  async function submitMessage(sid: string, content: string, attachments?: Attachment[], existingUserMessageId?: string) {
    let userMessageId = existingUserMessageId
    // Build conversation history before adding/unqueueing the current message,
    // so the current input is not duplicated in conversation_history.
    const sessionMsgs = getSessionMsgs(sid)
    const history: ChatMessage[] = sessionMsgs
      .filter(m =>
        m.id !== existingUserMessageId
        && !m.queued
        && !m.steered
        && (m.role === 'user' || m.role === 'assistant')
        && m.content.trim()
        && !shouldHideFromPromptHistory(m.role, m.content)
      )
      .map(m => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content }))

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
    cancelledPendingStarts.value.delete(sid)
    pendingRunStarts.value.add(sid)

    try {

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

      const target = sessions.value.find(s => s.id === sid)
      const { model: sessionModel, provider: sessionProvider } = resolveSendModelSelection(target)
      const lineageParentSessionId = target?.parentSessionId || null
      const lineageRootSessionId = target?.rootSessionId || null
      if ((globalThis as any)?.__HERMES_CHAT_DEBUG__) {
        console.info('[chat.startRun.lineage]', {
          sid,
          targetId: target?.id || null,
          lineageParentSessionId,
          lineageRootSessionId,
          representedSessionIds: target?.representedSessionIds || [],
          source: target?.source || null,
          isBranchSession: !!target?.isBranchSession,
        })
      }
      if (target) {
        if (sessionModel) target.model = sessionModel
        target.provider = sessionProvider
        clearSessionModelOverride(target.id)
        persistSessionsList()
      }
      const run = await startRun({
        input: inputText,
        conversation_history: history,
        session_id: sid,
        model: sessionModel || undefined,
        provider: sessionProvider || undefined,
        lineage_parent_session_id: lineageParentSessionId || undefined,
        lineage_root_session_id: lineageRootSessionId || undefined,
      })

      const runId = (run as any).run_id || (run as any).id
      if (!runId) {
        clearPendingRunStart(sid)
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
        const rootId = rootSessionIdFor(sid)
        appendRepresentedSessionId(rootId, sid)
        if (run.session_id) appendRepresentedSessionId(rootId, run.session_id)
        if (run.context_handoff) {
          setCompressionState(sid, {
            status: 'completed',
            mode: 'bridge_handoff',
            messageCount: run.context_message_count || undefined,
            tokenCount: numberFromRunEvent(run.context_token_count),
          })
        }
        persistSessionsList()
      }
      if (cancelledPendingStarts.value.has(sid)) {
        clearPendingRunStart(sid)
        try {
          await cancelRun(runId)
        } catch (cancelErr) {
          console.warn('Failed to cancel just-started run after early stop:', cancelErr)
        }
        return
      }
      attachRunStream(sid, runId)
    } catch (err: any) {
      clearPendingRunStart(sid)
      addMessage(sid, {
        id: uid(),
        role: 'system',
        content: `Error: ${err.message}`,
        timestamp: Date.now(),
      })
    }
  }

  function primeCompletionBellIfEnabled() {
    if (useSettingsStore().display.bell_on_complete) {
      primeCompletionSound()
    }
  }

  function playCompletionBellIfEnabled() {
    if (useSettingsStore().display.bell_on_complete) {
      void playCompletionSound()
    }
  }

  async function sendMessage(content: string, attachments?: Attachment[]) {
    if (!content.trim() && !(attachments && attachments.length > 0)) return
    primeCompletionBellIfEnabled()

    if (!activeSession.value) {
      const session = createSession()
      switchSession(session.id)
    }

    // Capture session ID at send time — all callbacks use this, not activeSessionId
    const sid = activeSessionId.value!
    if (isRunActive.value) {
      const explicitSteerText = parseExplicitSteerCommand(content)
      if (explicitSteerText) {
        const targetRunSessionId = activeRunSessionId() || sid
        await steerBusyInput(sid, explicitSteerText, attachments, targetRunSessionId)
        return
      }
      const settingsStore = useSettingsStore()
      if (!settingsStore.loaded && !settingsStore.loading) {
        await settingsStore.fetchSettings()
      }
      const busyMode = settingsStore.display.busy_input_mode || 'queue'
      const targetRunSessionId = activeRunSessionId() || sid
      if ((globalThis as any)?.__HERMES_CHAT_DEBUG__) {
        console.info('[chat.busy-input]', {
          sid,
          busyMode,
          targetRunSessionId,
          activeSessionEndedAt: activeSession.value?.endedAt ?? null,
          representedSessionIds: activeSession.value?.representedSessionIds || [],
          candidateSessionIds: candidateSessionIdsForRun(sid),
          hasInFlight: !!readInFlight(sid),
        })
      }
      if (busyMode === 'steer') {
        await steerBusyInput(sid, content, attachments, targetRunSessionId)
        return
      }
      queueBusyInput(sid, content, attachments)
      return
    }

    await submitMessage(sid, content, attachments)
  }

  async function stopStreaming() {
    const sid = activeSessionId.value
    if (!sid) return
    if (abortingSessions.value.has(sid)) return
    const inFlight = readInFlight(sid)
    const ctrl = streamStates.value.get(sid)
    setAbortingSession(sid, true)
    const stoppedBeforeRunId = pendingRunStarts.value.has(sid) && !inFlight?.runId && !ctrl
    clearPendingRunStart(sid)
    if (stoppedBeforeRunId) cancelledPendingStarts.value.add(sid)
    try {
      let cancelResult: Awaited<ReturnType<typeof cancelRun>> | null = null
      if (inFlight?.runId) {
        cancelResult = await cancelRun(inFlight.runId)
      }
      const cancelPending = !!inFlight?.runId && cancelResult?.status === 'interrupt_sent'
      if (cancelPending) {
        stopPolling(sid)
        stopApprovalPolling(sid)
        stopClarifyPolling(sid)
        if (ctrl) {
          ctrl.abort()
          streamStates.value.delete(sid)
        }
        if (sid === activeSessionId.value) persistActiveMessages()
        persistSessionsList()
        return
      }
      if (ctrl) {
        ctrl.abort()
        const msgs = getSessionMsgs(sid)
        const lastMsg = msgs[msgs.length - 1]
        if (lastMsg?.isStreaming) {
          updateMessage(sid, lastMsg.id, { isStreaming: false })
        }
        streamStates.value.delete(sid)
      }
      stopPolling(sid)
      stopApprovalPolling(sid)
      stopClarifyPolling(sid)
      clearApproval(sid)
      clearClarify(sid)
      clearInFlight(sid)
      clearCompressionForSession(sid)
      const persistentSid = readBridgePersistentSessionId(sid)
      if (persistentSid && persistentSid !== sid) clearCompressionForSession(persistentSid)
      if (sid === activeSessionId.value) persistActiveMessages()
      persistSessionsList()
      await submitNextQueuedMessage(sid)
    } catch (err) {
      console.warn('Failed to cancel run:', err)
    } finally {
      setAbortingSession(sid, false)
    }
  }

  // Tab visibility: re-sync when returning to foreground
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && activeSessionId.value && !isStreaming.value) {
        await refreshActiveSession()
        if (readInFlight(activeSessionId.value)) {
          // If the server already shows this session as ended, the in-flight
          // record is stale — clear it and skip resume.
          if (activeSession.value?.endedAt != null) {
            clearInFlight(activeSessionId.value)
          } else {
            resumeInFlightRun(activeSessionId.value)
            void pollApprovalOnce(activeSessionId.value)
            startApprovalPolling(activeSessionId.value)
            void pollClarifyOnce(activeSessionId.value)
            startClarifyPolling(activeSessionId.value)
          }
        }
      }
    })
  }

  // Transient observation of <think> boundaries during active streaming.
  // Mirrored onto Message so the observed duration survives tab refreshes and
  // session switches.
  const thinkingObservation = new Map<string, { startedAt?: number; endedAt?: number }>()

  function findMessageById(messageId: string): Message | undefined {
    for (const session of sessions.value) {
      const match = session.messages.find(message => message.id === messageId)
      if (match) return match
    }
    return undefined
  }

  function getThinkingObservation(messageId: string) {
    const cached = thinkingObservation.get(messageId)
    const message = findMessageById(messageId)
    if (!message?.thinkingStartedAt && !message?.thinkingEndedAt) return cached
    return {
      startedAt: cached?.startedAt ?? message.thinkingStartedAt,
      endedAt: cached?.endedAt ?? message.thinkingEndedAt,
    }
  }

  function persistThinkingObservation(messageId: string, observation: { startedAt?: number; endedAt?: number }) {
    for (const session of sessions.value) {
      const idx = session.messages.findIndex(message => message.id === messageId)
      if (idx === -1) continue
      session.messages[idx] = {
        ...session.messages[idx],
        thinkingStartedAt: observation.startedAt ?? session.messages[idx].thinkingStartedAt,
        thinkingEndedAt: observation.endedAt ?? session.messages[idx].thinkingEndedAt,
      }
      persistSessionMessages(session.id)
      return
    }
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
    persistThinkingObservation(messageId, existing)
  }

  /** 第一次见到某条消息的 reasoning 文本时，标记 startedAt。 */
  function noteReasoningStart(messageId: string) {
    const existing = thinkingObservation.get(messageId) || {}
    if (existing.startedAt === undefined) {
      existing.startedAt = Date.now()
      thinkingObservation.set(messageId, existing)
      persistThinkingObservation(messageId, existing)
    }
  }

  /** 内容首次到达（视为推理结束）或显式收到 reasoning.available 时，标记 endedAt。 */
  function noteReasoningEnd(messageId: string) {
    const existing = thinkingObservation.get(messageId)
    if (!existing || existing.startedAt === undefined) return
    if (existing.endedAt === undefined) {
      existing.endedAt = Date.now()
      thinkingObservation.set(messageId, existing)
      persistThinkingObservation(messageId, existing)
    }
  }

  function clearProviderFromSessions(provider: string) {
    if (!provider) return
    const target = provider.toLowerCase()
    let dirty = false
    for (const s of sessions.value) {
      if ((s.provider || '').toLowerCase() === target) {
        s.model = undefined
        s.provider = ''
        clearSessionModelOverride(s.id)
        dirty = true
      }
    }
    if (dirty) persistSessionsList()
  }

  function clearThinkingObservationFor(_sessionId: string) {
    // Keep observations in memory and on messages; switching sessions should
    // not make the displayed "observed x seconds" metadata disappear.
  }

  // 播放消息语音
  function playMessageSpeech(messageId: string, content: string) {
    // 触发自定义事件，让 MessageItem 组件处理播放
    const event = new CustomEvent('auto-play-speech', {
      detail: { messageId, content }
    })
    window.dispatchEvent(event)
  }

  return {
    sessions,
    activeSessionId,
    activeSession,
    activeApproval,
    activeClarify,
    focusMessageId,
    messages,
    displayMessages,
    activeCompression,
    activeBranches,
    isStreaming,
    isRunActive,
    isAborting,
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
    clearProviderFromSessions,
    deleteSession,
    sendMessage,
    respondApproval,
    respondClarify,
    stopStreaming,
    loadSessions,
    refreshSessionBranches,
    refreshActiveSession,
    getThinkingObservation,
    noteThinkingDelta,
    noteReasoningStart,
    noteReasoningEnd,
    clearThinkingObservationFor,
    setAutoPlaySpeech,
    playMessageSpeech,
  }
})
