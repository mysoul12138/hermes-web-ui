import { cancelRun, startRun, steerSession, streamRunEvents, type ChatMessage, type RunEvent } from '@/api/hermes/chat'
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
import { deleteSession as deleteSessionApi, fetchSession, fetchSessions, fetchSessionUsageSingle, type HermesMessage, type SessionDetail, type SessionSummary } from '@/api/hermes/sessions'
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
  toolCallId?: string
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
  endedAt?: number | null
  lastActiveAt?: number
  workspace?: string | null
  branchSessionCount?: number
  parentSessionId?: string | null
  rootSessionId?: string | null
  isBranchSession?: boolean
}

export interface CompressionState {
  status: 'started' | 'completed' | 'failed'
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

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function isPersistentTuiSessionId(sessionId: string): boolean {
  return /^\d{8}_\d{6}_[0-9a-f]+$/i.test(sessionId)
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

function textFromRunEvent(evt: RunEvent): string {
  for (const value of [evt.text, evt.delta, evt.reasoning, evt.thinking, evt.content, evt.message, evt.output]) {
    if (typeof value === 'string' && value) return value
  }
  return ''
}

function stringifyToolPayload(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value === 'string') return value.trim() ? value : undefined
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function commandFromToolPayload(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const parsed = tryParseJson(trimmed)
    return parsed ? (commandFromToolPayload(parsed) || trimmed) : trimmed
  }
  if (typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const command = record.command ?? record.cmd
  return typeof command === 'string' && command.trim() ? command.trim() : undefined
}

function firstPresent(...values: unknown[]): unknown {
  return values.find(value => value != null)
}

function numberFromRunEvent(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (value == null) continue
    const text = String(value).trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    result.push(text)
  }
  return result
}

function toolCallKeys(toolCall: Record<string, any>): string[] {
  return uniqueStrings([
    toolCall.call_id,
    toolCall.tool_call_id,
    toolCall.id,
    toolCall.response_item_id,
    toolCall.item_id,
  ])
}

function toolCallName(toolCall: Record<string, any>): string | undefined {
  const name = toolCall.function?.name ?? toolCall.name ?? toolCall.tool_name
  return typeof name === 'string' && name.trim() ? name.trim() : undefined
}

function toolCallArgs(toolCall: Record<string, any>): string | undefined {
  const args = toolCall.function?.arguments ?? toolCall.arguments ?? toolCall.args ?? toolCall.input
  return stringifyToolPayload(args)
}

function previewFromToolResult(content?: string | null): string | undefined {
  if (!content?.trim()) return undefined
  const parsed = tryParseJson(content)
  if (!parsed) return content.slice(0, 240)
  for (const key of ['command', 'output', 'stdout', 'stderr', 'result', 'content', 'message', 'summary', 'preview', 'title', 'url']) {
    const preview = stringifyToolPayload(parsed[key])
    if (preview) return preview.slice(0, 240)
  }
  return stringifyToolPayload(parsed)?.slice(0, 240)
}

function pickToolArgs(evt: RunEvent): string | undefined {
  const payload = firstPresent(
    evt.arguments ??
    evt.args ??
    evt.parameters ??
    evt.input ??
    (evt.tool_call as Record<string, any> | undefined)?.function?.arguments ??
    (evt.tool_call as Record<string, any> | undefined)?.arguments ??
    (evt.function as Record<string, any> | undefined)?.arguments ??
    (evt.payload as Record<string, any> | undefined)?.arguments ??
    evt.command,
  )
  return stringifyToolPayload(payload)
}

function pickToolPreview(evt: RunEvent): string | undefined {
  return commandFromToolPayload(evt.command) ||
    commandFromToolPayload(evt.arguments) ||
    commandFromToolPayload(evt.args) ||
    commandFromToolPayload(evt.parameters) ||
    commandFromToolPayload(evt.input) ||
    commandFromToolPayload((evt.tool_call as Record<string, any> | undefined)?.function?.arguments) ||
    commandFromToolPayload((evt.tool_call as Record<string, any> | undefined)?.arguments) ||
    commandFromToolPayload((evt.function as Record<string, any> | undefined)?.arguments) ||
    commandFromToolPayload((evt.payload as Record<string, any> | undefined)?.arguments) ||
    stringifyToolPayload(evt.command) ||
    stringifyToolPayload(evt.preview) ||
    stringifyToolPayload(evt.tool_preview) ||
    stringifyToolPayload(evt.context)
}

function pickToolCallId(evt: RunEvent): string | undefined {
  return uniqueStrings([
    evt.call_id,
    evt.tool_call_id,
    (evt.tool_call as Record<string, any> | undefined)?.call_id,
    (evt.tool_call as Record<string, any> | undefined)?.id,
    evt.id,
    evt.item_id,
    evt.response_item_id,
  ])[0]
}

function betterToolText(current: string | undefined, next: string | undefined): string | undefined {
  if (!next) return current
  if (!current) return next
  if (current === next) return current
  if (current.includes('...') && next.length > current.length) return next
  return next.length > current.length ? next : current
}

function pickToolResult(evt: RunEvent): string | undefined {
  const details: Record<string, unknown> = {}
  for (const key of [
    'result',
    'output',
    'stdout',
    'stderr',
    'output_tail',
    'files_read',
    'files_written',
    'exit_code',
    'returncode',
    'exit_status',
    'exitCode',
    'status',
    'duration',
    'duration_s',
    'duration_ms',
    'duration_seconds',
    'error',
  ]) {
    if (evt[key] != null) details[key] = evt[key]
  }
  if (Object.keys(details).length > 0) return JSON.stringify(details)

  return stringifyToolPayload(
    evt.content ??
    evt.message ??
    evt.summary,
  )
}

function toolEventDetails(evt: RunEvent): string | undefined {
  const details: Record<string, unknown> = {}
  for (const key of [
    'tool',
    'name',
    'preview',
    'context',
    'command',
    'duration',
    'duration_s',
    'duration_ms',
    'duration_seconds',
    'timestamp',
    'status',
    'stdout',
    'stderr',
    'output_tail',
    'files_read',
    'files_written',
    'exit_code',
    'returncode',
    'exit_status',
    'exitCode',
  ]) {
    if (evt[key] != null) details[key] = evt[key]
  }
  return Object.keys(details).length > 0 ? JSON.stringify(details) : undefined
}

function mergeToolResult(previous: string | undefined, next: string | undefined): string | undefined {
  if (!next) return previous
  if (!previous) return next
  if (previous.includes(next)) return previous
  return `${previous}\n\n${next}`
}

function applySessionUsage(session: Session | undefined | null, usage: { input_tokens: number; output_tokens: number } | null | undefined, options: { allowReset?: boolean } = {}) {
  if (!session || !usage) return
  const currentInput = session.inputTokens ?? 0
  const currentOutput = session.outputTokens ?? 0
  const currentTotal = currentInput + currentOutput
  const nextInput = usage.input_tokens ?? 0
  const nextOutput = usage.output_tokens ?? 0
  const nextTotal = nextInput + nextOutput
  if (nextTotal > 0 && (options.allowReset || currentTotal === 0 || nextTotal >= currentTotal)) {
    session.inputTokens = nextInput
    session.outputTokens = nextOutput
  }
}

function usageFromRunEvent(evt: RunEvent): { input_tokens: number; output_tokens: number } | null {
  if (evt.usage) {
    return {
      input_tokens: evt.usage.input_tokens ?? 0,
      output_tokens: evt.usage.output_tokens ?? 0,
    }
  }
  const raw = evt as RunEvent & { inputTokens?: number; outputTokens?: number }
  const inputTokens = raw.input_tokens ?? raw.inputTokens
  const outputTokens = raw.output_tokens ?? raw.outputTokens
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return null
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  }
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
  applySessionUsage(session, detail as { input_tokens: number; output_tokens: number }, { allowReset: true })
  applySessionModelOverride(session)
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
        const keys = toolCallKeys(tc)
        const name = toolCallName(tc)
        const args = toolCallArgs(tc)
        for (const key of keys) {
          if (name) toolNameMap.set(key, name)
          if (args) toolArgsMap.set(key, args)
        }
      }
    }
  }

  const result: Message[] = []
  for (const msg of msgs) {
    // Skip assistant messages that only contain tool_calls (no meaningful content)
    if (msg.role === 'assistant' && msg.tool_calls?.length && !msg.content?.trim()) {
      // Emit a tool.started message for each tool call
      for (const [idx, tc] of msg.tool_calls.entries()) {
        const keys = toolCallKeys(tc)
        const primaryKey = keys[0] || `${msg.id}_${idx}`
        const args = toolCallArgs(tc)
        const preview = extractApprovalCommandFromArgs(args) || commandFromToolPayload(tryParseJson(args) || args)
        result.push({
          id: String(msg.id) + '_' + primaryKey,
          role: 'tool',
          content: '',
          timestamp: Math.round(msg.timestamp * 1000),
          toolName: toolCallName(tc) || 'tool',
          toolArgs: args,
          toolPreview: preview?.slice(0, 240),
          toolCallId: primaryKey,
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
      const preview = previewFromToolResult(msg.content)
        || extractApprovalCommandFromArgs(toolArgs)
        || commandFromToolPayload(tryParseJson(toolArgs) || toolArgs)
      // Find and remove the matching placeholder from tool_calls above
      const placeholderIdx = result.findIndex(
        m => m.role === 'tool'
          && !m.toolResult
          && (
            (!!tcId && (m.toolCallId === tcId || m.id.includes('_' + tcId)))
            || (m.toolName === toolName && !tcId)
          )
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
        toolPreview: preview?.slice(0, 240),
        toolResult: msg.content || undefined,
        toolCallId: tcId || undefined,
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
    title: s.title || s.preview || s.id,
    source: s.source === 'webui-bridge' ? 'tui' : (s.source || undefined),
    messages: [],
    createdAt: Math.round(s.started_at * 1000),
    updatedAt: Math.round((s.last_active || s.ended_at || s.started_at) * 1000),
    model: s.model,
    provider: (s as any).billing_provider || '',
    billingBaseUrl: (s as any).billing_base_url || '',
    messageCount: s.message_count,
    inputTokens: s.input_tokens,
    outputTokens: s.output_tokens,
    endedAt: s.ended_at != null ? Math.round(s.ended_at * 1000) : null,
    lastActiveAt: s.last_active != null ? Math.round(s.last_active * 1000) : undefined,
    workspace: (s as any).workspace || null,
    branchSessionCount: 'branch_session_count' in s ? s.branch_session_count : 0,
  }
}

function normalizeProviderKey(value: string): string {
  return value.trim().toLowerCase()
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase()
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
const BRANCH_SESSION_META_KEY_PREFIX = 'hermes_branch_session_meta_v1_'
const SESSION_MODEL_OVERRIDE_KEY_PREFIX = 'hermes_session_model_override_v1_'
const LEGACY_STORAGE_KEY = 'hermes_active_session'
const LEGACY_SESSIONS_CACHE_KEY = 'hermes_sessions_cache_v1'
const IN_FLIGHT_TTL_MS = 15 * 60 * 1000 // Give up after 15 minutes
const POLL_INTERVAL_MS = 2000
const COMPRESSION_NOTICE_TTL_MS = 15_000
const STREAM_FLUSH_INTERVAL_MS = 50
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
function branchSessionMetaKey(): string { return BRANCH_SESSION_META_KEY_PREFIX + getProfileName() }
function sessionModelOverrideKey(sid: string): string { return `${SESSION_MODEL_OVERRIDE_KEY_PREFIX}${getProfileName()}_${sid}` }
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

interface SessionModelOverride {
  model: string
  provider?: string
  updatedAt: number
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
      `${SESSION_MODEL_OVERRIDE_KEY_PREFIX}${getProfileName()}_`,
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

function readSessionModelOverride(sid: string | undefined): SessionModelOverride | null {
  if (!sid) return null
  const override = loadJson<SessionModelOverride>(sessionModelOverrideKey(sid))
  if (!override?.model?.trim()) return null
  return override
}

function writeSessionModelOverride(sid: string, model: string, provider?: string) {
  const modelValue = model.trim()
  if (!sid || !modelValue) return
  saveJson(sessionModelOverrideKey(sid), {
    model: modelValue,
    provider: provider?.trim() || '',
    updatedAt: Date.now(),
  } as SessionModelOverride)
}

function clearSessionModelOverride(sid: string) {
  removeItem(sessionModelOverrideKey(sid))
}

function copySessionModelOverride(fromSid: string, toSid: string) {
  if (!fromSid || !toSid || fromSid === toSid) return
  const override = readSessionModelOverride(fromSid)
  if (!override) return
  writeSessionModelOverride(toSid, override.model, override.provider)
}

function applySessionModelOverride(session: Session | undefined | null) {
  if (!session) return
  const override = readSessionModelOverride(session.id)
  if (!override) return
  session.model = override.model
  session.provider = override.provider || ''
}

// Strip the circular `file: File` reference from attachments before caching —
// File objects don't serialize and we only need name/type/size/url for display.
function sanitizeForCache(msgs: Message[]): Message[] {
  return msgs.map(m => {
    const { isStreaming: _isStreaming, ...rest } = m
    if (!m.attachments?.length) return rest
    return {
      ...rest,
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
  const isRunActive = computed(() =>
    isStreaming.value
    || (activeSessionId.value != null && (isSessionLive(activeSessionId.value) || !!readInFlight(activeSessionId.value)))
  )
  const pollTimers = new Map<string, ReturnType<typeof setInterval>>()
  const pollSignatures = new Map<string, { sig: string, stableTicks: number }>()
  const approvalsBySession = ref<Record<string, ApprovalState>>({})
  const clarifiesBySession = ref<Record<string, ClarifyState>>({})
  const dbBranchesBySession = ref<Record<string, ConversationBranch[]>>({})
  const liveBranchesBySession = ref<Record<string, ConversationBranch[]>>({})
  const subagentActivityBySession = ref<Record<string, Record<string, ConversationMessage[]>>>({})
  const compressionBySession = ref<Record<string, CompressionState>>({})
  const approvalPollers = new Map<string, ReturnType<typeof setInterval>>()
  const clarifyPollers = new Map<string, ReturnType<typeof setInterval>>()
  const compressionNoticeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const dismissedApprovalSignatures = new Map<string, { signature: string, expiresAt: number }>()

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

  function countBranchTree(branches: ConversationBranch[]): number {
    return branches.reduce((sum, branch) => sum + 1 + countBranchTree(branch.branches || []), 0)
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

  function findBranchById(branches: ConversationBranch[], branchId: string): ConversationBranch | null {
    for (const branch of branches) {
      if (branch.session_id === branchId) return branch
      const child = findBranchById(branch.branches || [], branchId)
      if (child) return child
    }
    return null
  }

  function flattenBranchTree(branches: ConversationBranch[]): ConversationBranch[] {
    return branches.flatMap(branch => [branch, ...flattenBranchTree(branch.branches || [])])
  }

  function mergeConversationMessages(persisted: ConversationMessage[] = [], live: ConversationMessage[] = []): ConversationMessage[] {
    const byId = new Map<string, ConversationMessage>()
    for (const message of persisted) byId.set(String(message.id), message)
    for (const message of live) byId.set(String(message.id), message)
    return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp)
  }

  function isSubagentStatusText(text: string): boolean {
    return !text.trim() || /^\[(?:start|progress|tool|thinking|status|complete|error)\]\s/i.test(text.trim())
  }

  function isSubagentTranscriptText(text: string): boolean {
    return /^###\s+Subagent\b/i.test(text.trim())
  }

  function hasRealBranchMessageContent(messages: Array<{ role?: string; content: string }>): boolean {
    return messages.some(message => {
      if (message.role === 'user') return false
      return !isSubagentStatusText(message.content) && !isSubagentTranscriptText(message.content)
    })
  }

  function normalizedBranchText(value: string | null | undefined): string {
    return (value || '')
      .replace(/^subagent\s+l\d+\s*:\s*/i, '')
      .replace(/^subagent\s*:\s*/i, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .trim()
  }

  function branchTextKey(branch: ConversationBranch): string {
    const primaryText = branch.source === 'subagent'
      ? (
          branch.messages.find(message => message.role === 'user' && message.content.trim())?.content
          || branch.title
          || branch.messages.find(message => message.content.trim())?.content
          || ''
        )
      : (
          branch.title
          || branch.messages.find(message => message.role === 'user' && message.content.trim())?.content
          || branch.messages.find(message => message.content.trim())?.content
          || ''
        )
    return normalizedBranchText(
      primaryText,
    )
  }

  function branchParentMatches(persisted: ConversationBranch, live: ConversationBranch): boolean {
    const persistedParent = persisted.parent_session_id || ''
    const liveParent = live.parent_session_id || ''
    if (!persistedParent || !liveParent) return false
    return persistedParent === liveParent
      || persistedParent === sessionFetchId(liveParent)
      || sessionFetchId(persistedParent) === liveParent
  }

  function branchesRepresentSameSubagent(persisted: ConversationBranch, live: ConversationBranch): boolean {
    if (live.source !== 'subagent') return false
    if (persisted.source !== 'tui' && persisted.source !== 'api_server' && persisted.source !== 'webui-bridge') return false
    if (!branchParentMatches(persisted, live)) return false

    const persistedKey = branchTextKey(persisted)
    const liveKey = branchTextKey(live)
    const hasTextMatch = !!persistedKey && !!liveKey && (
      persistedKey === liveKey
      || persistedKey.includes(liveKey)
      || liveKey.includes(persistedKey)
    )
    const startedDelta = Math.abs((persisted.started_at || 0) - (live.started_at || 0))
    const recentDelta = Math.abs((persisted.last_active || persisted.started_at || 0) - (live.last_active || live.started_at || 0))

    if (hasTextMatch) return true
    if (persistedKey || liveKey) {
      // During execution, the persisted TUI branch can exist before its
      // title/visible messages are hydrated. In that window we still need to
      // collapse the live subagent placeholder into the single closest TUI
      // branch under the same parent, otherwise the UI shows two child
      // sessions and later "snaps" when the live placeholder disappears.
      if (!persistedKey && startedDelta <= 15 && recentDelta <= 120) return true
      return false
    }
    return startedDelta <= 5 && (!live.is_active || recentDelta <= 30)
  }

  function findLiveBranchMatch(persisted: ConversationBranch, live: ConversationBranch[], usedLiveIds: Set<string>): ConversationBranch | undefined {
    return live
      .filter(branch => !usedLiveIds.has(branch.session_id) && branchesRepresentSameSubagent(persisted, branch))
      .sort((a, b) => {
        const aStartedDelta = Math.abs((persisted.started_at || 0) - (a.started_at || 0))
        const bStartedDelta = Math.abs((persisted.started_at || 0) - (b.started_at || 0))
        if (aStartedDelta !== bStartedDelta) return aStartedDelta - bStartedDelta
        const aRecentDelta = Math.abs((persisted.last_active || persisted.started_at || 0) - (a.last_active || a.started_at || 0))
        const bRecentDelta = Math.abs((persisted.last_active || persisted.started_at || 0) - (b.last_active || b.started_at || 0))
        if (aRecentDelta !== bRecentDelta) return aRecentDelta - bRecentDelta
        return a.session_id.localeCompare(b.session_id)
      })[0]
  }

  function mergePersistedAndLiveBranch(persisted: ConversationBranch, liveBranch: ConversationBranch): ConversationBranch {
    const persistedMessagesAreOnlySubagentStatus = (persisted.messages || []).every(message => isSubagentStatusText(message.content))
    const hasRealPersistedMessages = (persisted.messages || []).length > 0 && !persistedMessagesAreOnlySubagentStatus
    const messages = hasRealPersistedMessages
      ? persisted.messages
      : (liveBranch.messages.length > 0
          ? liveBranch.messages
          : mergeConversationMessages(persisted.messages, liveBranch.messages))
    const lastActive = Math.max(persisted.last_active || 0, liveBranch.last_active || 0)
    const liveIsNewer = (liveBranch.last_active || 0) >= (persisted.last_active || 0)
    const mergedIsActive = liveBranch.source === 'subagent'
      ? liveBranch.is_active
      : liveBranch.is_active || persisted.is_active
    return {
      ...persisted,
      model: persisted.model || liveBranch.model,
      title: persisted.title || liveBranch.title,
      ended_at: mergedIsActive
        ? null
        : (liveBranch.source === 'subagent'
            ? (liveBranch.ended_at ?? persisted.ended_at)
            : (liveIsNewer ? liveBranch.ended_at : persisted.ended_at)),
      last_active: lastActive,
      is_active: mergedIsActive,
      messages,
      visible_count: Math.max(persisted.visible_count || 0, messages.length, liveBranch.visible_count || 0),
      thread_session_count: Math.max(persisted.thread_session_count || 0, liveBranch.thread_session_count || 0),
      input_tokens: persisted.input_tokens ?? liveBranch.input_tokens,
      output_tokens: persisted.output_tokens ?? liveBranch.output_tokens,
      branches: mergeBranchLists(persisted.branches || [], liveBranch.branches || []),
    }
  }

  function normalizePersistedBranchForUi(branch: ConversationBranch): ConversationBranch {
    if (branch.source === 'subagent') return branch
    return {
      ...branch,
      is_active: false,
      branches: (branch.branches || []).map(normalizePersistedBranchForUi),
    }
  }

  function mergeBranchLists(persisted: ConversationBranch[] = [], live: ConversationBranch[] = []): ConversationBranch[] {
    const liveById = new Map(live.map(branch => [branch.session_id, branch]))
    const usedLiveIds = new Set<string>()
    const merged = persisted.map(branch => {
      const liveBranch = liveById.get(branch.session_id)
        || findLiveBranchMatch(branch, live, usedLiveIds)
      if (!liveBranch) return normalizePersistedBranchForUi(branch)
      usedLiveIds.add(liveBranch.session_id)
      return mergePersistedAndLiveBranch(branch, liveBranch)
    })
    for (const branch of live) {
      if (!usedLiveIds.has(branch.session_id)) merged.push(branch)
    }

    const deduped: ConversationBranch[] = []
    for (const branch of merged) {
      if (branch.source === 'subagent') {
        const persistedMatch = merged.find(candidate =>
          candidate !== branch
          && candidate.source !== 'subagent'
          && branchesRepresentSameSubagent(candidate, branch)
        )
        if (persistedMatch) continue
      }
      deduped.push(branch)
    }
    return deduped
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
    existing.title = nextSession.title
    existing.source = nextSession.source
    existing.model = nextSession.model
    if (!preserveHydratedMessages && !preserveActiveHydratedMessages) {
      const mergedMessages = existing.messages.length > 0
        ? mergeServerToolDetails(nextSession.messages, existing.messages)
        : nextSession.messages
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
      if (detail.title) target.title = detail.title
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
        if (detail && detail.messages && !isBridgeFallbackSession(detail)) {
          prefetchedDetail = detail
          const mapped = mapHermesMessages(detail.messages)
          if (mapped.length > 0) {
            const branchSummaryHasTools = nextSession.messages.some(message => message.role === 'tool')
            seededMessages = !branchSummaryHasTools
              ? mapped
              : (
                  serverHasBetterToolDetails(nextSession.messages, mapped)
                    ? mergeServerToolDetails(nextSession.messages, mapped)
                    : mapped
                )
          }
        }
      } catch {
        // Branch session prefetch is best-effort; fall back to branch summary messages.
      }
      const existing = sessions.value.find(session => session.id === branchId)
      if (existing) {
        const preserveToolDetails = serverHasBetterToolDetails(seededMessages, existing.messages)
        const nextMessages = preserveToolDetails
          ? mergeServerToolDetails(seededMessages, existing.messages)
          : seededMessages
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
      await switchSession(branchId, null, prefetchedDetail)
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

function withLocalSteeredMessages(mapped: Message[], current: Message[]): Message[] {
  const mappedUserTexts = new Set(mapped.filter(message => message.role === 'user').map(message => message.content.trim()).filter(Boolean))
  const localSteered = current.filter(message => message.steered && !mappedUserTexts.has(message.content.trim()))
  return localSteered.length ? [...mapped, ...localSteered] : mapped
}

function isStaleBridgeRunError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error || '')
  return /session is not running|bridge session not found|Bridge steer error/i.test(text)
}

  function getQueuedMessages(sid: string) {
    return getSessionMsgs(sid).filter(message => message.role === 'user' && message.queued)
  }

  async function steerBusyInput(sid: string, content: string, attachments?: Attachment[]) {
    const text = content.trim()
    try {
      const result = await steerSession(sid, text)
      if (result?.ok) {
        const userMsg: Message = {
          id: uid(),
          role: 'user',
          content: text,
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
        return
      }
    } catch (err) {
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
      copySessionModelOverride(sid, persistentSessionId)
      copyCompressionState(sid, persistentSessionId)
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
    const persistent = localStorage.getItem(bridgePersistentSessionKey(sid)) || null
    if (persistent && persistent !== sid && isPersistentTuiSessionId(sid)) return null
    return persistent
  }

  function readBridgeBackingSessionId(sid: string) {
    return localStorage.getItem(bridgePersistentSessionKey(sid)) || null
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

  function toolDetailScore(message: Message): number {
    if (message.role !== 'tool') return 0
    let score = 0
    if (message.toolName && message.toolName !== 'tool') score += 1
    if (message.toolPreview) score += 1
    if (message.toolArgs) score += 3
    if (message.toolResult) score += 4
    if (message.toolCallId) score += 1
    return score
  }

  function serverHasBetterToolDetails(local: Message[], server: Message[]): boolean {
    const localTools = local.filter(m => m.role === 'tool')
    const serverTools = server.filter(m => m.role === 'tool')
    if (!serverTools.length) return false

    for (const [idx, serverTool] of serverTools.entries()) {
      const localTool = localTools.find(m =>
        (!!serverTool.toolCallId && m.toolCallId === serverTool.toolCallId)
        || (!!serverTool.id && m.id === serverTool.id)
      ) || localTools[idx]

      if (!localTool) {
        if (serverTool.toolArgs || serverTool.toolResult || serverTool.toolPreview) return true
        continue
      }

      if (toolDetailScore(serverTool) > toolDetailScore(localTool)) return true
      if (localTool.toolResult && serverTool.toolResult && localTool.toolResult.length < serverTool.toolResult.length) return true
      if (localTool.toolArgs && serverTool.toolArgs && localTool.toolArgs.length < serverTool.toolArgs.length) return true
    }

    return false
  }

  function mergeToolMessageDetails(local: Message, server: Message): Message {
    return {
      ...local,
      toolName: local.toolName && local.toolName !== 'tool' ? local.toolName : server.toolName,
      toolPreview: betterToolText(local.toolPreview, server.toolPreview),
      toolArgs: betterToolText(local.toolArgs, server.toolArgs),
      toolResult: mergeToolResult(local.toolResult, server.toolResult),
      toolCallId: local.toolCallId || server.toolCallId,
      toolStatus: server.toolResult ? (server.toolStatus || 'done') : (local.toolStatus || server.toolStatus),
    }
  }

  function mergeServerToolDetails(local: Message[], server: Message[]): Message[] {
    const serverTools = server.filter(m => m.role === 'tool')
    if (!serverTools.length) return local

    const usedServerIndexes = new Set<number>()
    const next = local.map((message) => {
      if (message.role !== 'tool') return message
      const byId = serverTools.findIndex((tool, idx) =>
        !usedServerIndexes.has(idx)
        && (
          (!!message.toolCallId && message.toolCallId === tool.toolCallId)
          || (!!message.id && message.id === tool.id)
        )
      )
      const fallback = byId >= 0
        ? byId
        : serverTools.findIndex((_, idx) => !usedServerIndexes.has(idx))
      if (fallback < 0) return message
      usedServerIndexes.add(fallback)
      return mergeToolMessageDetails(message, serverTools[fallback])
    })

    for (const [idx, tool] of serverTools.entries()) {
      if (!usedServerIndexes.has(idx)) next.push(tool)
    }

    return next
  }

  function messagesEquivalent(a: Message[], b: Message[]): boolean {
    if (a === b) return true
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      const left = a[i]
      const right = b[i]
      if (!left || !right) return false
      if (left.id !== right.id) return false
      if (left.role !== right.role) return false
      if ((left.content || '') !== (right.content || '')) return false
      if ((left.toolName || '') !== (right.toolName || '')) return false
      if ((left.toolPreview || '') !== (right.toolPreview || '')) return false
      if ((left.toolArgs || '') !== (right.toolArgs || '')) return false
      if ((left.toolResult || '') !== (right.toolResult || '')) return false
      if ((left.toolCallId || '') !== (right.toolCallId || '')) return false
      if ((left.toolStatus || '') !== (right.toolStatus || '')) return false
      if ((left.reasoning || '') !== (right.reasoning || '')) return false
      if (!!left.isStreaming !== !!right.isStreaming) return false
      if (!!left.queued !== !!right.queued) return false
      if (!!left.steered !== !!right.steered) return false
    }
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
        const mapped = mapHermesMessages(detail.messages || [])
        // Use the same current-turn comparison as switchSession: server is
        // ahead only when it has a newer user turn or the assistant output
        // after the current user turn has caught up.
        const local = target.messages
        const { serverIsAhead, serverIsCaughtUp } = compareServerMessages(local, mapped)
        const hasBetterToolDetails = serverHasBetterToolDetails(local, mapped)
        if (serverIsAhead) {
          target.messages = withLocalSteeredMessages(mergeServerToolDetails(mapped, target.messages), target.messages)
          if (detail.title && !target.title) target.title = detail.title
          if (sid === activeSessionId.value) persistActiveMessages()
        } else if (hasBetterToolDetails) {
          target.messages = mergeServerToolDetails(target.messages, mapped)
          if (detail.title && !target.title) target.title = detail.title
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
                if (detail.title) target.title = detail.title
                if (sid === activeSessionId.value) persistActiveMessages()
              } else if (hasBetterToolDetails) {
                target.messages = mergeServerToolDetails(target.messages, mapped)
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
      const cachedSessions = (loadJsonWithFallback<Session[]>(sessionsCacheKey(), legacySessionsCacheKey()) || [])
        .filter(session => session.source !== 'subagent')
      const cachedBranchMetaIndex = loadBranchSessionMetaIndex()
      if (cachedSessions.length) {
        cachedSessions.forEach(session => {
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
      const freshRaw = list.map(mapHermesSession)
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
        if (freshIds.has(s.id)) return false
        const persistentId = readBridgeBackingSessionId(s.id)
        if (persistentId && freshRawIds.has(persistentId)) {
          if (isPersistentTuiSessionId(s.id) && persistentId !== s.id) return true
          if (isLocalRunActive(s.id)) return true
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
      const detail = await fetchResolvedSessionDetail(sid)
      if (!detail) return false
      const target = sessions.value.find(s => s.id === sid)
      if (!target) return false
      if (isBridgeFallbackSession(detail) && target.messages.length > 0) return true
      const mapped = mapHermesMessages(detail.messages || [])
      const { serverIsAhead } = compareServerMessages(target.messages, mapped)
      if (serverIsAhead) {
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
    startPolling(sid)

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
    const schedulePersist = () => {
      if (persistTimer) return
      persistTimer = setTimeout(() => {
        persistTimer = null
        persistSessionMessages(sid)
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
      const msgs = getSessionMsgs(sid)
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
        if (Object.keys(update).length > 0) updateMessage(sid, messageId, update)
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
      }, 3000)
    }

    const ctrl = streamRunEvents(
      runId,
      (evt: RunEvent) => {
        switch (evt.event) {
          case 'run.started':
            break

          case 'compression.started': {
            setCompressionState(sid, {
              status: 'started',
              messageCount: numberFromRunEvent(evt.message_count),
              tokenCount: numberFromRunEvent(evt.token_count),
            })
            break
          }

          case 'compression.completed': {
            setCompressionState(sid, {
              status: evt.error ? 'failed' : 'completed',
              totalMessages: numberFromRunEvent(evt.totalMessages),
              resultMessages: numberFromRunEvent(evt.resultMessages),
              beforeTokens: numberFromRunEvent(evt.beforeTokens),
              afterTokens: numberFromRunEvent(evt.afterTokens),
              summaryTokens: numberFromRunEvent(evt.summaryTokens),
              verbatimCount: numberFromRunEvent(evt.verbatimCount),
              error: typeof evt.error === 'string' ? evt.error : undefined,
            })
            break
          }

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

          case 'clarify': {
            setClarifyPending(sid, {
              request_id: typeof evt.request_id === 'string' ? evt.request_id : '',
              question: typeof evt.question === 'string' ? evt.question : '',
              choices: Array.isArray(evt.choices) ? evt.choices.map(String) : [],
              requested_at: typeof evt.timestamp === 'number' ? evt.timestamp : undefined,
              _session_id: sid,
            })
            startClarifyPolling(sid)
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
              noteReasoningStart(last.id)
              appendStreamDelta(last.id, 'reasoning', text)
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
              schedulePersist()
            }
            break
          }

          case 'reasoning.available': {
            flushStreamDeltas()
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
            let msgs = getSessionMsgs(sid)
            let last = msgs[msgs.length - 1]
            if (last?.role === 'assistant' && last.isStreaming && pendingStreamDeltas.get(last.id)?.reasoning) {
              flushStreamDeltas()
              msgs = getSessionMsgs(sid)
              last = msgs[msgs.length - 1]
            }
            if (last?.role === 'assistant' && last.isStreaming) {
              appendStreamDelta(last.id, 'content', evt.delta || '')
            } else {
              const newId = uid()
              const nextContent = evt.delta || ''
              addMessage(sid, {
                id: newId,
                role: 'assistant',
                content: nextContent,
                timestamp: Date.now(),
                isStreaming: true,
              })
              noteThinkingDelta(newId, '', nextContent)
              schedulePersist()
            }
            break
          }

          case 'tool.start':
          case 'tool.started': {
            flushStreamDeltas()
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
              toolName: evt.tool || evt.name || evt.tool_name,
              toolPreview: pickToolPreview(evt),
              toolArgs: pickToolArgs(evt),
              toolCallId: pickToolCallId(evt),
              toolStatus: 'running',
            }
            addMessage(sid, toolMessage)
            schedulePersist()
            break
          }

          case 'tool.progress': {
            runHadToolActivity = true
            const msgs = getSessionMsgs(sid)
            const toolMsgs = msgs.filter(
              m => m.role === 'tool' && m.toolStatus === 'running',
            )
            if (toolMsgs.length > 0) {
              const eventToolCallId = pickToolCallId(evt)
              const last = (eventToolCallId && toolMsgs.find(m => m.toolCallId === eventToolCallId))
                || toolMsgs[toolMsgs.length - 1]
              updateMessage(sid, last.id, {
                toolPreview: betterToolText(last.toolPreview, pickToolPreview(evt)),
                toolArgs: betterToolText(last.toolArgs, pickToolArgs(evt)),
                toolResult: mergeToolResult(last.toolResult, pickToolResult(evt) || toolEventDetails(evt)),
                toolCallId: last.toolCallId || eventToolCallId,
              })
            }
            schedulePersist()
            break
          }

          case 'tool.complete':
          case 'tool.completed': {
            runHadToolActivity = true
            const msgs = getSessionMsgs(sid)
            const toolMsgs = msgs.filter(
              m => m.role === 'tool' && m.toolStatus === 'running',
            )
            if (toolMsgs.length > 0) {
              const eventToolCallId = pickToolCallId(evt)
              const last = (eventToolCallId && toolMsgs.find(m => m.toolCallId === eventToolCallId))
                || toolMsgs[toolMsgs.length - 1]
              updateMessage(sid, last.id, {
                toolStatus: 'done',
                toolPreview: betterToolText(last.toolPreview, pickToolPreview(evt)),
                toolArgs: betterToolText(last.toolArgs, pickToolArgs(evt)),
                toolResult: mergeToolResult(last.toolResult, pickToolResult(evt) || toolEventDetails(evt)),
                toolCallId: last.toolCallId || eventToolCallId,
              })
            }
            if (approvalsBySession.value[sid]?.pending?._optimistic) {
              clearApproval(sid)
            }
            schedulePersist()
            break
          }

          case 'usage.updated': {
            const target = sessions.value.find(s => s.id === sid)
            applySessionUsage(target, usageFromRunEvent(evt), { allowReset: true })
            persistSessionsList()
            break
          }

          case 'run.completed': {
            const msgs = getSessionMsgs(sid)
            const lastMsg = msgs[msgs.length - 1]
            if (lastMsg?.isStreaming) {
              updateMessage(sid, lastMsg.id, { isStreaming: false })
            }
            const target = sessions.value.find(s => s.id === sid)
            applySessionUsage(target, usageFromRunEvent(evt))
            const finalOutput = typeof evt.output === 'string' ? evt.output : ''
            const eventOutput = finalOutput || textFromRunEvent(evt)
            const eventOutputTrimmed = eventOutput.trim()
            if (!runProducedAssistantText && eventOutputTrimmed !== '') {
              addMessage(sid, {
                id: uid(),
                role: 'assistant',
                content: eventOutput,
                timestamp: Date.now(),
              })
              runProducedAssistantText = true
            }
            const swallowedError = !runProducedAssistantText && !runHadToolActivity && eventOutputTrimmed === ''
            if (swallowedError) {
              addMessage(sid, {
                id: uid(),
                role: 'system',
                content: 'Error: Agent returned no output. The model call may have failed (e.g. invalid API key, model not supported by provider, or context exceeded). Check the hermes-agent logs for details.',
                timestamp: Date.now(),
              })
            }
            if (autoPlaySpeechEnabled.value) {
              const lastAssistant = [...getSessionMsgs(sid)].reverse().find(m => m.role === 'assistant')
              if (lastAssistant?.content) {
                window.setTimeout(() => {
                  playMessageSpeech(lastAssistant.id, lastAssistant.content)
                }, 300)
              }
            }
            finishLiveSubagentBranches(sid, 'complete')
            cleanup()
            updateSessionTitle(sid)
            persistSessionMessages(sid)
            persistSessionsList()
            clearInFlight(sid)
            stopPolling(sid)
            stopApprovalPolling(sid)
            stopClarifyPolling(sid)
            clearApproval(sid)
            clearClarify(sid)
            if (sid === activeSessionId.value) {
              void refreshActiveSession().finally(() => {
                void refreshSessionBranches(rootSessionIdFor(sid))
              })
            } else {
              void refreshSessionBranches(rootSessionIdFor(sid))
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
            finishLiveSubagentBranches(sid, 'error')
            cleanup()
            persistSessionMessages(sid)
            persistSessionsList()
            clearInFlight(sid)
            stopPolling(sid)
            stopApprovalPolling(sid)
            stopClarifyPolling(sid)
            clearApproval(sid)
            clearClarify(sid)
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
        finishLiveSubagentBranches(sid, 'complete')
        cleanup()
        updateSessionTitle(sid)
        clearInFlight(sid)
        stopPolling(sid)
        stopApprovalPolling(sid)
        stopClarifyPolling(sid)
        clearApproval(sid)
        clearClarify(sid)
        persistSessionMessages(sid)
        persistSessionsList()
        void submitNextQueuedMessage(sid)
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
        persistSessionMessages(sid)
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

  async function switchSession(sessionId: string, focusId?: string | null, prefetchedDetail: SessionDetail | null = null) {
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
      const detail = prefetchedDetail ?? await fetchResolvedSessionDetail(sessionId)
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
          const nextMessages = withLocalSteeredMessages(mergeServerToolDetails(mapped, activeSession.value.messages), activeSession.value.messages)
          if (!messagesEquivalent(activeSession.value.messages, nextMessages)) {
            activeSession.value.messages = nextMessages
          }
        } else if (serverHasBetterToolDetails(local, mapped)) {
          const nextMessages = mergeServerToolDetails(activeSession.value.messages, mapped)
          if (!messagesEquivalent(activeSession.value.messages, nextMessages)) {
            activeSession.value.messages = nextMessages
          }
        }
        void refreshSessionBranches(rootSessionIdFor(sessionId))
        if (isSessionLive(sessionId) || readInFlight(sessionId)) {
          syncApprovalFromMessages(sessionId, activeSession.value.messages)
          void pollClarifyOnce(sessionId)
          startClarifyPolling(sessionId)
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
          clearClarify(sessionId)
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
        applySessionDetail(activeSession.value, detail)
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
      void pollClarifyOnce(sessionId)
      startClarifyPolling(sessionId)
    }

    // Fetch token usage for this session from web-ui DB
    try {
      const usage = await fetchSessionUsageSingle(sessionId)
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
    await deleteSessionApi(sessionId)
    sessions.value = sessions.value.filter(s => s.id !== sessionId)
    removeItemWithLegacy(msgsCacheKey(sessionId), legacyMsgsCacheKey(sessionId))
    clearSessionModelOverride(sessionId)
    clearInFlight(sessionId)
    clearBridgeLocalSession(sessionId)
    stopPolling(sessionId)
    stopApprovalPolling(sessionId)
    stopClarifyPolling(sessionId)
    clearApproval(sessionId)
    clearClarify(sessionId)
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

  function appendUniqueLine(lines: string[], line: string) {
    const trimmed = line.trim()
    if (!trimmed) return
    if (lines[lines.length - 1] === trimmed) return
    lines.push(trimmed)
  }

  function parseSubagentStatus(content: string): { kind: string; text: string } {
    const trimmed = content.trim()
    const match = trimmed.match(/^\[([^\]]+)\]\s*(.*)$/)
    if (!match) return { kind: 'result', text: trimmed }
    return {
      kind: match[1].toLowerCase(),
      text: (match[2] || '').trim(),
    }
  }

  function pushSubagentSection(lines: string[], title: string, items: string[]) {
    const unique = [...new Set(items.map(item => item.trim()).filter(Boolean))]
    if (!unique.length) return
    lines.push('')
    lines.push(`#### ${title}`)
    for (const item of unique) appendUniqueLine(lines, `- ${item}`)
  }

  function formatSubagentLiveTranscript(events: ConversationMessage[], goal: string, isActive: boolean): string {
    const lines: string[] = []
    const buckets = {
      progress: [] as string[],
      tools: [] as string[],
      thinking: [] as string[],
      result: [] as string[],
      status: [] as string[],
      errors: [] as string[],
    }

    for (const event of events) {
      const parsed = parseSubagentStatus(event.content)
      if (!parsed.text) continue
      if (parsed.kind === 'tool') buckets.tools.push(parsed.text)
      else if (parsed.kind === 'thinking') buckets.thinking.push(parsed.text)
      else if (parsed.kind === 'progress' || parsed.kind === 'start') buckets.progress.push(parsed.text)
      else if (parsed.kind === 'complete' || parsed.kind === 'result') buckets.result.push(parsed.text)
      else if (parsed.kind === 'error') buckets.errors.push(parsed.text)
      else buckets.status.push(parsed.text)
    }

    lines.push(`### ${isActive ? 'Subagent live transcript' : 'Subagent transcript'}`)
    if (goal.trim()) {
      lines.push('')
      lines.push(`**Task:** ${goal.trim()}`)
    }
    lines.push('')
    lines.push(`**State:** ${isActive ? 'running' : 'completed'}`)

    pushSubagentSection(lines, 'Progress', buckets.progress)
    pushSubagentSection(lines, 'Tools', buckets.tools)
    pushSubagentSection(lines, 'Thinking', buckets.thinking)
    pushSubagentSection(lines, 'Status', buckets.status)
    pushSubagentSection(lines, 'Result', buckets.result)
    pushSubagentSection(lines, 'Errors', buckets.errors)

    if (!Object.values(buckets).some(items => items.length > 0)) {
      lines.push('')
      lines.push('#### Status')
      lines.push('- Waiting for live activity...')
    }
    return lines.join('\n')
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
    try {
      const detail = await fetchConversationDetail(fetchId, { humanOnly: true })
      const branchCount = countBranchTree(detail.branches || [])
      dbBranchesBySession.value = {
        ...dbBranchesBySession.value,
        [sid]: detail.branches || [],
      }
      persistBranchSessionMeta(sid, detail.branches || [])
      const session = sessions.value.find(item => item.id === sid)
      if (session) session.branchSessionCount = branchCount
      syncBranchSessions(sid)
      promoteMergedSubagentBranchSessions(sid)
      reconcileBranchSessions(sid)
      await hydrateActiveBranchSession(sid)
      if (activeSession.value?.rootSessionId === sid) persistActiveMessages()
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
      if (target) {
        if (sessionModel) target.model = sessionModel
        target.provider = sessionProvider
        if (sessionModel) writeSessionModelOverride(target.id, sessionModel, sessionProvider)
        persistSessionsList()
      }
      const run = await startRun({
        input: inputText,
        conversation_history: history,
        session_id: sid,
        model: sessionModel || undefined,
        provider: sessionProvider || undefined,
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
        if (run.context_handoff || history.length > 0) {
          setCompressionState(sid, {
            status: 'completed',
            messageCount: run.context_message_count || history.length || undefined,
            tokenCount: numberFromRunEvent(run.context_token_count),
          })
        }
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
    if (isRunActive.value) {
      const settingsStore = useSettingsStore()
      if (!settingsStore.loaded && !settingsStore.loading) {
        await settingsStore.fetchSettings()
      }
      const busyMode = settingsStore.display.busy_input_mode || 'queue'
      if (busyMode === 'steer') {
        await steerBusyInput(sid, content, attachments)
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
      stopClarifyPolling(sid)
      clearApproval(sid)
      clearClarify(sid)
      if (sid === activeSessionId.value) persistActiveMessages()
      persistSessionsList()
    } else {
      stopPolling(sid)
      stopApprovalPolling(sid)
      stopClarifyPolling(sid)
      clearApproval(sid)
      clearClarify(sid)
      if (sid === activeSessionId.value) persistActiveMessages()
      persistSessionsList()
    }

    if (!inFlight?.runId || !inFlight.runId.startsWith('bridge_run_')) {
      clearInFlight(sid)
      await submitNextQueuedMessage(sid)
      return
    }

    try {
      await cancelRun(inFlight.runId)
      clearInFlight(sid)
      await submitNextQueuedMessage(sid)
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
          void pollClarifyOnce(activeSessionId.value)
          startClarifyPolling(activeSessionId.value)
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
