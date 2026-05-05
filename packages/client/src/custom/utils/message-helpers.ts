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
    }))
  }
  return result
}

export function mapHermesSession(s: SessionSummary | ConversationSummary): Session {
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

export function withLocalSteeredMessages(mapped: Message[], current: Message[]): Message[] {
  const mappedUserTexts = new Set(mapped.filter(message => message.role === 'user').map(message => message.content.trim()).filter(Boolean))
  // Preserve both steered (in-run) and queued (waiting for next turn) user
  // messages that the server hasn't seen yet.  Without the queued check,
  // switching away from a session with pending queued messages would lose them.
  const localPreserved = current.filter(message => (message.steered || message.queued) && !mappedUserTexts.has(message.content.trim()))
  if (!localPreserved.length) return mapped
  // Insert each preserved message at the position matching its timestamp
  // instead of appending all at the end
  const result = [...mapped]
  for (const msg of localPreserved) {
    const ts = msg.timestamp || 0
    let insertIdx = result.length
    for (let i = 0; i < result.length; i++) {
      const msgTs = result[i].timestamp || 0
      if (msgTs > ts) {
        insertIdx = i
        break
      }
    }
    result.splice(insertIdx, 0, msg)
  }
  return result
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
