/**
 * Pure helpers for branch session tree operations.
 *
 * These functions were extracted from the chat store to reduce coupling with
 * upstream.  Functions that need store state (like `sessionFetchId` or
 * `readBridgeBackingSessionId`) accept them as injected parameters so the
 * helpers remain free of Pinia imports.
 */
import type { ConversationBranch, ConversationMessage } from '@/api/hermes/conversations'
import type { SessionDetail } from '@/api/hermes/sessions'

// Minimal message shape used by branch→session mapping.  Avoids importing the
// full Message interface from the chat store.
export interface BranchMessage {
  id: string
  role: string
  content: string
  timestamp: number
  isStreaming?: boolean
}

export interface BranchSession {
  id: string
  title: string
  source?: string
  messages: BranchMessage[]
  createdAt: number
  updatedAt: number
  model?: string
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

// ─── Pure tree utilities ─────────────────────────────────────────────

export function countBranchTree(branches: ConversationBranch[]): number {
  return branches.reduce((sum, branch) => sum + 1 + countBranchTree(branch.branches || []), 0)
}

export function flattenBranchTree(branches: ConversationBranch[]): ConversationBranch[] {
  return branches.flatMap(branch => [branch, ...flattenBranchTree(branch.branches || [])])
}

export function findBranchById(branches: ConversationBranch[], branchId: string): ConversationBranch | null {
  for (const branch of branches) {
    if (branch.session_id === branchId) return branch
    const child = findBranchById(branch.branches || [], branchId)
    if (child) return child
  }
  return null
}

export function mergeConversationMessages(persisted: ConversationMessage[] = [], live: ConversationMessage[] = []): ConversationMessage[] {
  const byId = new Map<string, ConversationMessage>()
  for (const message of persisted) byId.set(String(message.id), message)
  for (const message of live) byId.set(String(message.id), message)
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp)
}

// ─── Subagent text classification ────────────────────────────────────

export function isSubagentStatusText(text: string): boolean {
  return !text.trim() || /^\[(?:start|progress|tool|thinking|status|complete|error)\]\s/i.test(text.trim())
}

export function isSubagentTranscriptText(text: string): boolean {
  return /^###\s+Subagent\b/i.test(text.trim())
}

export function hasRealBranchMessageContent(messages: Array<{ role?: string; content: string }>): boolean {
  return messages.some(message => {
    if (message.role === 'user') return false
    return !isSubagentStatusText(message.content) && !isSubagentTranscriptText(message.content)
  })
}

// ─── Branch text matching ────────────────────────────────────────────

export function normalizedBranchText(value: string | null | undefined): string {
  return (value || '')
    .replace(/^subagent\s+l\d+\s*:\s*/i, '')
    .replace(/^subagent\s*:\s*/i, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
}

export function branchTextKey(branch: ConversationBranch): string {
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
  return normalizedBranchText(primaryText)
}

// ─── Branch matching (requires ID resolver injection) ─────────────────

export type IdResolver = (id: string) => string | null

export function branchParentMatches(
  persisted: ConversationBranch,
  live: ConversationBranch,
  sessionFetchId: IdResolver,
  readBridgeBackingSessionId: IdResolver,
): boolean {
  const persistedParent = persisted.parent_session_id || ''
  const liveParent = live.parent_session_id || ''
  if (!persistedParent || !liveParent) return false
  return persistedParent === liveParent
    || persistedParent === sessionFetchId(liveParent)
    || sessionFetchId(persistedParent) === liveParent
    || readBridgeBackingSessionId(persistedParent) === liveParent
    || readBridgeBackingSessionId(liveParent) === persistedParent
}

export function branchesRepresentSameSubagent(
  persisted: ConversationBranch,
  live: ConversationBranch,
  sessionFetchId: IdResolver,
  readBridgeBackingSessionId: IdResolver,
): boolean {
  if (live.source !== 'subagent') return false
  if (persisted.source !== 'tui' && persisted.source !== 'api_server' && persisted.source !== 'webui-bridge') return false
  if (!branchParentMatches(persisted, live, sessionFetchId, readBridgeBackingSessionId)) return false

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
    if (!persistedKey && startedDelta <= 15 && recentDelta <= 120) return true
    return false
  }
  return startedDelta <= 5 && (!live.is_active || recentDelta <= 30)
}

export function findLiveBranchMatch(
  persisted: ConversationBranch,
  live: ConversationBranch[],
  usedLiveIds: Set<string>,
  sessionFetchId: IdResolver,
  readBridgeBackingSessionId: IdResolver,
): ConversationBranch | undefined {
  return live
    .filter(branch => !usedLiveIds.has(branch.session_id) && branchesRepresentSameSubagent(persisted, branch, sessionFetchId, readBridgeBackingSessionId))
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

// ─── Branch merging (requires ID resolver injection) ──────────────────

export function mergePersistedAndLiveBranch(
  persisted: ConversationBranch,
  liveBranch: ConversationBranch,
  sessionFetchId: IdResolver,
  readBridgeBackingSessionId: IdResolver,
): ConversationBranch {
  const persistedMessagesAreOnlySubagentStatus = (persisted.messages || []).every(message => isSubagentStatusText(message.content))
  const hasRealPersistedMessages = (persisted.messages || []).length > 0 && !persistedMessagesAreOnlySubagentStatus
  const preferLive = liveBranch.source === 'subagent' && liveBranch.is_active
  const messages = preferLive
    ? (liveBranch.messages.length > 0 ? liveBranch.messages : persisted.messages)
    : (hasRealPersistedMessages
        ? persisted.messages
        : (liveBranch.messages.length > 0
            ? liveBranch.messages
            : mergeConversationMessages(persisted.messages, liveBranch.messages)))
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
    branches: mergeBranchLists(persisted.branches || [], liveBranch.branches || [], sessionFetchId, readBridgeBackingSessionId),
  }
}

export function normalizePersistedBranchForUi(branch: ConversationBranch): ConversationBranch {
  if (branch.source === 'subagent') return branch
  return {
    ...branch,
    is_active: false,
    branches: (branch.branches || []).map(normalizePersistedBranchForUi),
  }
}

export function mergeBranchLists(
  persisted: ConversationBranch[] = [],
  live: ConversationBranch[] = [],
  sessionFetchId: IdResolver,
  readBridgeBackingSessionId: IdResolver,
): ConversationBranch[] {
  const liveById = new Map(live.map(branch => [branch.session_id, branch]))
  const usedLiveIds = new Set<string>()
  const merged = persisted.map(branch => {
    const liveBranch = liveById.get(branch.session_id)
      || findLiveBranchMatch(branch, live, usedLiveIds, sessionFetchId, readBridgeBackingSessionId)
    if (!liveBranch) return normalizePersistedBranchForUi(branch)
    usedLiveIds.add(liveBranch.session_id)
    return mergePersistedAndLiveBranch(branch, liveBranch, sessionFetchId, readBridgeBackingSessionId)
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
        && branchesRepresentSameSubagent(candidate, branch, sessionFetchId, readBridgeBackingSessionId)
      )
      if (persistedMatch) continue
    }
    deduped.push(branch)
  }
  return deduped
}

// ─── Branch → Session mapping ────────────────────────────────────────

export function branchMessagesToMessages(branch: ConversationBranch): BranchMessage[] {
  const mapped: BranchMessage[] = branch.messages.map(message => ({
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

export function branchToSession(branch: ConversationBranch, rootSessionId: string): BranchSession {
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

export function detailMessagesBelongToBranch(detail: SessionDetail, branchId: string): boolean {
  if (detail.id && detail.id !== branchId) return false
  const ids = new Set((detail.messages || [])
    .map(message => message.session_id)
    .filter(Boolean))
  return ids.size === 0 || (ids.size === 1 && ids.has(branchId))
}

export function branchToSessionDetail(branch: ConversationBranch): SessionDetail {
  return {
    id: branch.session_id,
    source: branch.source === 'webui-bridge' ? 'tui' : branch.source,
    model: branch.model,
    title: branch.title,
    started_at: branch.started_at,
    ended_at: branch.ended_at,
    last_active: branch.last_active,
    message_count: branch.messages.length,
    tool_call_count: 0,
    input_tokens: branch.input_tokens ?? 0,
    output_tokens: branch.output_tokens ?? 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: null,
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    cost_status: '',
    messages: branch.messages.map(message => ({
      id: message.id as number,
      session_id: branch.session_id,
      role: message.role,
      content: message.content,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      timestamp: message.timestamp,
      token_count: null,
      finish_reason: null,
      reasoning: null,
    })),
  }
}

// ─── Subagent formatting ─────────────────────────────────────────────

export function textFromOutputTail(items: Array<Record<string, unknown>> | undefined): string {
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

export function formatSubagentResult(evt: Record<string, any>): string | undefined {
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

export function appendUniqueLine(lines: string[], line: string) {
  const trimmed = line.trim()
  if (!trimmed) return
  if (lines[lines.length - 1] === trimmed) return
  lines.push(trimmed)
}

export function parseSubagentStatus(content: string): { kind: string; text: string } {
  const trimmed = content.trim()
  const match = trimmed.match(/^\[([^\]]+)\]\s*(.*)$/)
  if (!match) return { kind: 'result', text: trimmed }
  return {
    kind: match[1].toLowerCase(),
    text: (match[2] || '').trim(),
  }
}

export function pushSubagentSection(lines: string[], title: string, items: string[]) {
  const unique = [...new Set(items.map(item => item.trim()).filter(Boolean))]
  if (!unique.length) return
  lines.push('')
  lines.push(`#### ${title}`)
  for (const item of unique) appendUniqueLine(lines, `- ${item}`)
}

export function formatSubagentLiveTranscript(events: ConversationMessage[], goal: string, isActive: boolean): string {
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
