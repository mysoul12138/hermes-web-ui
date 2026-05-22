/**
 * Message manipulation helper functions.
 * Extracted from stores/hermes/chat.ts to isolate custom code from upstream.
 */
import type { Message, Session } from '@/stores/hermes/chat'
import type { PendingApproval } from '@/api/hermes/approval'
import type { HermesMessage, SessionSummary } from '@/api/hermes/sessions'
import type { ConversationSummary } from '@/api/hermes/conversations'
import {
  tryParseJson,
  extractApprovalCommandFromArgs,
  commandFromToolPayload,
  toolCallKeys,
  toolCallName,
  toolCallArgs,
  previewFromToolResult,
  betterToolText,
  mergeToolResult,
} from '@/custom/utils/run-event-helpers'
import { scrubBuggyReasoning } from '@/custom/utils/display-helpers'

const STEER_TIMESTAMP_MATCH_WINDOW_MS = 5000

export function isPersistentTuiSessionId(sessionId: string): boolean {
  return /^\d{8}_\d{6}_[0-9a-f]+$/i.test(sessionId)
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export function normalizeProviderKey(value: string): string {
  return value.trim().toLowerCase()
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase()
}

export function isBridgeFallbackSession(detail: { source?: string; messages?: unknown[] } | null | undefined): boolean {
  return detail?.source === 'webui-bridge' && Array.isArray(detail.messages) && detail.messages.length === 0
}

export function applySessionUsage(session: Session | undefined | null, usage: { input_tokens: number; output_tokens: number } | null | undefined, options: { allowReset?: boolean } = {}) {
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

export function extractPendingApprovalFromMessages(messages: Message[]): PendingApproval | null {
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

export function mapHermesMessages(msgs: HermesMessage[]): Message[] {
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
    result.push(scrubBuggyReasoning({
      id: String(msg.id),
      role: msg.role,
      content: msg.content || '',
      timestamp: Math.round(msg.timestamp * 1000),
      reasoning: msg.reasoning ? msg.reasoning : undefined,
      ...(msg.steered ? { steered: true } : {}),
      ...(msg.ui_event_id ? { ui_event_id: msg.ui_event_id } : {}),
    }))
  }
  return result
}

export function mapHermesSession(s: SessionSummary | ConversationSummary): Session {
  const rawRepresentedSessionIds: unknown[] = Array.isArray((s as any).represented_session_ids)
    ? (s as any).represented_session_ids
    : []
  const representedSessionIds = rawRepresentedSessionIds.length > 0
    ? rawRepresentedSessionIds.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
    : [s.id]
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
    rootSessionId: s.id,
    parentSessionId: null,
    representedSessionIds: [...new Set(representedSessionIds)],
  }
}

export function toolDetailScore(message: Message): number {
  if (message.role !== 'tool') return 0
  let score = 0
  if (message.toolName && message.toolName !== 'tool') score += 1
  if (message.toolPreview) score += 1
  if (message.toolArgs) score += 3
  if (message.toolResult) score += 4
  if (message.toolInlineDiff) score += 5
  if (message.toolCallId) score += 1
  return score
}

export function serverHasBetterToolDetails(local: Message[], server: Message[]): boolean {
  const localTools = local.filter(m => m.role === 'tool')
  const serverTools = server.filter(m => m.role === 'tool')
  if (!serverTools.length) return false

  for (const [idx, serverTool] of serverTools.entries()) {
    const localTool = localTools.find(m =>
      (!!serverTool.toolCallId && m.toolCallId === serverTool.toolCallId)
      || (!!serverTool.id && m.id === serverTool.id)
    ) || localTools[idx]

    if (!localTool) {
      if (serverTool.toolArgs || serverTool.toolResult || serverTool.toolPreview || serverTool.toolInlineDiff) return true
      continue
    }

    if (toolDetailScore(serverTool) > toolDetailScore(localTool)) return true
    if (localTool.toolResult && serverTool.toolResult && localTool.toolResult.length < serverTool.toolResult.length) return true
    if (localTool.toolArgs && serverTool.toolArgs && localTool.toolArgs.length < serverTool.toolArgs.length) return true
  }

  return false
}

export function mergeToolMessageDetails(local: Message, server: Message): Message {
  return {
    ...local,
    toolName: local.toolName && local.toolName !== 'tool' ? local.toolName : server.toolName,
    toolPreview: betterToolText(local.toolPreview, server.toolPreview),
    toolArgs: betterToolText(local.toolArgs, server.toolArgs),
    toolResult: mergeToolResult(local.toolResult, server.toolResult),
    toolInlineDiff: betterToolText(local.toolInlineDiff, server.toolInlineDiff),
    toolCallId: local.toolCallId || server.toolCallId,
    toolStatus: server.toolResult ? (server.toolStatus || 'done') : (local.toolStatus || server.toolStatus),
  }
}

export function mergeServerToolDetails(local: Message[], server: Message[]): Message[] {
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

export function messagesEquivalent(a: Message[], b: Message[]): boolean {
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
    if ((left.toolInlineDiff || '') !== (right.toolInlineDiff || '')) return false
    if ((left.toolCallId || '') !== (right.toolCallId || '')) return false
    if ((left.toolStatus || '') !== (right.toolStatus || '')) return false
    if ((left.reasoning || '') !== (right.reasoning || '')) return false
    if ((left.ui_event_id || '') !== (right.ui_event_id || '')) return false
    if (!!left.isStreaming !== !!right.isStreaming) return false
    if (!!left.queued !== !!right.queued) return false
    if (!!left.steered !== !!right.steered) return false
  }
  return true
}

export function compareServerMessages(local: Message[], server: Message[]) {
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

export function isServerPersistedSteerMessage(message: Message): boolean {
  return message.role === 'user'
    && (!!message.ui_event_id || String(message.id || '').startsWith('ui.steer.'))
}

export function withLocalSteeredMessages(mapped: Message[], current: Message[]): Message[] {
  const serverPersistedSteers = mapped.filter(isServerPersistedSteerMessage)
  const localSteeredByText = new Map<string, Message[]>()
  for (const message of current) {
    if (message.role !== 'user' || !message.steered) continue
    if (matchesServerPersistedSteer(message, serverPersistedSteers)) continue
    const text = message.content.trim()
    if (!text) continue
    const queue = localSteeredByText.get(text) || []
    queue.push(message)
    localSteeredByText.set(text, queue)
  }
  const matchedLocalSteeredIds = new Set<string>()
  const matchedSteeredPlacements: Array<{ mappedId: string, localSteered: Message, mappedIndex: number }> = []

  const merged = mapped.map((message, mappedIndex) => {
    if (message.role !== 'user') return message
    if (isServerPersistedSteerMessage(message)) {
      return {
        ...message,
        steered: true,
      }
    }
    const candidates = localSteeredByText.get(message.content.trim())
    const localSteered = findClosestSteeredMessage(message, candidates)
    if (!localSteered) return message
    matchedLocalSteeredIds.add(localSteered.id)
    if (candidates) {
      const matchedIndex = candidates.findIndex(candidate => candidate.id === localSteered.id)
      if (matchedIndex >= 0) candidates.splice(matchedIndex, 1)
      if (candidates.length === 0) localSteeredByText.delete(message.content.trim())
    }
    matchedSteeredPlacements.push({ mappedId: message.id, localSteered, mappedIndex })
    return {
      ...message,
      steered: true,
      attachments: message.attachments || localSteered.attachments,
    }
  })
  const reorderedMerged = restoreMatchedSteeredPositions(merged, current, matchedSteeredPlacements)
  // Preserve both steered (in-run) and queued (waiting for next turn) user
  // messages that the server hasn't seen yet.  Without the queued check,
  // switching away from a session with pending queued messages would lose them.
  const localPreserved = current.filter(message => {
    if (message.queued) return true
    if (!message.steered) return false
    if (matchesServerPersistedSteer(message, serverPersistedSteers)) return false
    return !matchedLocalSteeredIds.has(message.id)
  })
  if (!localPreserved.length) return reorderedMerged
  const result = [...reorderedMerged]
  const anchorIds = new Set(result.map(message => message.id))
  const currentIndexById = new Map(current.map((message, index) => [message.id, index] as const))
  for (const msg of localPreserved) {
    if (msg.steered) {
      const anchoredInsertIndex = findSteeredInsertIndex(result, current, currentIndexById, msg)
      if (anchoredInsertIndex != null) {
        result.splice(anchoredInsertIndex, 0, msg)
        anchorIds.add(msg.id)
        continue
      }
    }
    const currentIdx = currentIndexById.get(msg.id) ?? -1
    let inserted = false
    const nextAnchorId = msg.nextMessageId
    if (nextAnchorId && anchorIds.has(nextAnchorId)) {
      const insertIdx = result.findIndex(message => message.id === nextAnchorId)
      if (insertIdx >= 0) {
        result.splice(insertIdx, 0, msg)
        inserted = true
      }
    }
    if (currentIdx >= 0) {
      if (!inserted) {
        for (let i = currentIdx + 1; i < current.length; i += 1) {
          const candidateNextId = current[i]?.id
          if (!candidateNextId || !anchorIds.has(candidateNextId)) continue
          const insertIdx = result.findIndex(message => message.id === candidateNextId)
          if (insertIdx >= 0) {
            result.splice(insertIdx, 0, msg)
            inserted = true
            break
          }
        }
      }
      if (!inserted) {
        for (let i = currentIdx - 1; i >= 0; i -= 1) {
          const previousId = current[i]?.id
          if (!previousId || !anchorIds.has(previousId)) continue
          const anchorIdx = result.findIndex(message => message.id === previousId)
          if (anchorIdx >= 0) {
            result.splice(anchorIdx + 1, 0, msg)
            inserted = true
            break
          }
        }
      }
    }
    if (!inserted) {
      const previousAnchorId = msg.previousMessageId
      if (previousAnchorId && anchorIds.has(previousAnchorId)) {
        const anchorIdx = result.findIndex(message => message.id === previousAnchorId)
        if (anchorIdx >= 0) {
          result.splice(anchorIdx + 1, 0, msg)
          inserted = true
        }
      }
    }
    if (!inserted) result.push(msg)
    anchorIds.add(msg.id)
  }
  return result
}

function matchesServerPersistedSteer(local: Message, serverSteers: Message[]): boolean {
  if (!serverSteers.length || local.role !== 'user' || !local.steered) return false
  const localId = String(local.id || '')
  const localUiEventId = local.ui_event_id || (localId.startsWith('ui.steer.') ? localId.slice('ui.steer.'.length) : '')
  const localText = local.content.trim()
  const localTs = normalizeMessageTimestamp(local.timestamp || 0)
  return serverSteers.some(server => {
    const serverId = String(server.id || '')
    const serverUiEventId = server.ui_event_id || (serverId.startsWith('ui.steer.') ? serverId.slice('ui.steer.'.length) : '')
    if (localUiEventId && serverUiEventId && localUiEventId === serverUiEventId) return true
    if (localId && serverId && localId === serverId) return true
    if (!localText || localText !== server.content.trim()) return false
    const serverTs = normalizeMessageTimestamp(server.timestamp || 0)
    if (!localTs || !serverTs) return false
    return Math.abs(localTs - serverTs) <= STEER_TIMESTAMP_MATCH_WINDOW_MS
  })
}

function findClosestSteeredMessage(message: Message, candidates: Message[] | undefined): Message | undefined {
  if (!candidates?.length) return undefined
  const serverTs = normalizeMessageTimestamp(message.timestamp || 0)
  if (!serverTs) return candidates[0]
  let best: Message | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const localTs = normalizeMessageTimestamp(candidate.timestamp || 0)
    if (!localTs) return candidate
    const distance = Math.abs(serverTs - localTs)
    if (distance > STEER_TIMESTAMP_MATCH_WINDOW_MS || distance >= bestDistance) continue
    best = candidate
    bestDistance = distance
  }
  return best
}

function restoreMatchedSteeredPositions(
  mapped: Message[],
  current: Message[],
  placements: Array<{ mappedId: string, localSteered: Message, mappedIndex: number }>,
): Message[] {
  if (!placements.length) return mapped
  const result = [...mapped]
  const currentIndexById = new Map(current.map((message, index) => [message.id, index] as const))
  for (const placement of placements) {
    const resultIndex = result.findIndex(message => message.id === placement.mappedId)
    if (resultIndex < 0) continue
    const [message] = result.splice(resultIndex, 1)
    const insertIndex = findSteeredInsertIndex(result, current, currentIndexById, placement.localSteered)
    if (insertIndex == null) {
      result.splice(Math.min(placement.mappedIndex, result.length), 0, message)
    } else {
      result.splice(insertIndex, 0, message)
    }
  }
  return result
}

function findSteeredInsertIndex(
  result: Message[],
  current: Message[],
  currentIndexById: Map<string, number>,
  localSteered: Message,
): number | null {
  const anchorIds = new Set(result.map(message => message.id))
  const localTs = normalizeMessageTimestamp(localSteered.timestamp || 0)
  const currentAnchors = localSteeredCurrentAnchors(current, currentIndexById, anchorIds, localSteered)
  const nextAnchorId = anchorIds.has(localSteered.nextMessageId || '')
    ? localSteered.nextMessageId
    : currentAnchors.nextAnchorId
  const nextAnchorIdx = nextAnchorId
    ? result.findIndex(message => message.id === nextAnchorId)
    : -1
  const previousAnchorId = anchorIds.has(localSteered.previousMessageId || '')
    ? localSteered.previousMessageId
    : currentAnchors.previousAnchorId
  const previousAnchorIdx = previousAnchorId
    ? result.findIndex(message => message.id === previousAnchorId)
    : -1

  if (previousAnchorIdx >= 0 && nextAnchorIdx >= 0 && previousAnchorIdx < nextAnchorIdx) {
    return insertionIndexByTimestamp(result, previousAnchorIdx + 1, nextAnchorIdx, localTs)
  }

  if (previousAnchorIdx >= 0) {
    return insertionIndexByTimestamp(result, previousAnchorIdx + 1, result.length, localTs)
  }

  if (nextAnchorId && anchorIds.has(nextAnchorId)) {
    return insertionIndexByTimestamp(result, 0, nextAnchorIdx, localTs)
  }

  const currentIdx = currentIndexById.get(localSteered.id) ?? -1
  if (currentIdx >= 0) {
    for (let i = currentIdx + 1; i < current.length; i += 1) {
      const candidateNextId = current[i]?.id
      if (!candidateNextId || !anchorIds.has(candidateNextId)) continue
      const insertIdx = result.findIndex(message => message.id === candidateNextId)
      if (insertIdx >= 0) return insertIdx
    }
    for (let i = currentIdx - 1; i >= 0; i -= 1) {
      const previousId = current[i]?.id
      if (!previousId || !anchorIds.has(previousId)) continue
      const anchorIdx = result.findIndex(message => message.id === previousId)
      if (anchorIdx >= 0) return anchorIdx + 1
    }
  }

  if (localTs) return insertionIndexByTimestamp(result, 0, result.length, localTs)
  return null
}

function localSteeredCurrentAnchors(
  current: Message[],
  currentIndexById: Map<string, number>,
  anchorIds: Set<string>,
  localSteered: Message,
): { previousAnchorId?: string, nextAnchorId?: string } {
  const currentIdx = currentIndexById.get(localSteered.id) ?? -1
  if (currentIdx < 0) return {}

  let previousAnchorId: string | undefined
  for (let i = currentIdx - 1; i >= 0; i -= 1) {
    const candidateId = current[i]?.id
    if (candidateId && anchorIds.has(candidateId)) {
      previousAnchorId = candidateId
      break
    }
  }

  let nextAnchorId: string | undefined
  for (let i = currentIdx + 1; i < current.length; i += 1) {
    const candidateId = current[i]?.id
    if (candidateId && anchorIds.has(candidateId)) {
      nextAnchorId = candidateId
      break
    }
  }

  return { previousAnchorId, nextAnchorId }
}

function insertionIndexByTimestamp(result: Message[], start: number, end: number, timestamp: number): number {
  const lower = Math.max(0, Math.min(start, result.length))
  const upper = Math.max(lower, Math.min(end, result.length))
  if (!timestamp) return lower
  for (let index = lower; index < upper; index += 1) {
    const currentTs = normalizeMessageTimestamp(result[index]?.timestamp || 0)
    if (currentTs && currentTs > timestamp) return index
  }
  return upper
}

function normalizeMessageTimestamp(timestamp: number): number {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0
  if (timestamp > 10000000000000000) return Math.round(timestamp / 1000000)
  if (timestamp > 100000000000000) return Math.round(timestamp / 1000)
  return timestamp < 100000000000 ? Math.round(timestamp * 1000) : Math.round(timestamp)
}

export function isStaleBridgeRunError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error || '')
  return /session is not running|bridge session not found|Bridge steer error/i.test(text)
}

export function sanitizeForCache(msgs: Message[]): Message[] {
  return msgs.map(m => {
    const { isStreaming: _isStreaming, ...rest } = m
    if (!m.attachments?.length) return rest
    return {
      ...rest,
      attachments: m.attachments.map(a => ({ id: a.id, name: a.name, type: a.type, size: a.size, url: a.url })),
    }
  })
}

export function scrubBuggyReasoningInCache(msgs: Message[] | null | undefined): Message[] {
  if (!msgs) return []
  return msgs.map(scrubBuggyReasoning)
}
