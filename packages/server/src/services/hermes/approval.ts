import * as hermesCli from './hermes-cli'
import { sendInstruction } from './hermes'
import { getLivePendingApproval } from './run-state'
import { tuiBridge } from './tui-bridge'

export interface PendingApproval {
  approval_id?: string
  description?: string
  command?: string
  pattern_key?: string
  pattern_keys?: string[]
}

export interface PendingApprovalResponse {
  pending: PendingApproval | null
  pending_count: number
}

export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'

const APPROVAL_COMMANDS: Record<ApprovalChoice, string> = {
  once: '/approve',
  session: '/approve session',
  always: '/approve always',
  deny: '/deny',
}

function tryParseJson(value: unknown): any | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return JSON.parse(value)
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

export function findPendingApproval(messages: any[]): PendingApproval | null {
  const lastUserIdx = [...messages].map(msg => msg?.role).lastIndexOf('user')
  const relevantMessages = lastUserIdx >= 0 ? messages.slice(lastUserIdx + 1) : messages

  for (let i = relevantMessages.length - 1; i >= 0; i -= 1) {
    const msg = relevantMessages[i]

    if (msg?.role === 'assistant') {
      const text = typeof msg?.content === 'string' ? msg.content.trim() : ''
      if (!text) continue
      if (/approval_required|need approval|需要审批|blocked/i.test(text)) continue
      return null
    }

    if (msg?.role === 'tool') {
      if (typeof msg?.content !== 'string' || !msg.content.trim()) {
        if (msg?.tool_status === 'running') return null
        continue
      }

      const parsed = tryParseJson(msg.content)
      if (parsed?.status !== 'approval_required') {
        return null
      }

      const command = typeof parsed.command === 'string' && parsed.command.trim()
        ? parsed.command.trim()
        : extractApprovalCommandFromArgs(msg.tool_args)

      return {
        approval_id: typeof parsed.approval_id === 'string' && parsed.approval_id.trim() ? parsed.approval_id.trim() : undefined,
        description: typeof parsed.description === 'string' && parsed.description.trim() ? parsed.description.trim() : undefined,
        command,
        pattern_key: typeof parsed.pattern_key === 'string' && parsed.pattern_key.trim() ? parsed.pattern_key.trim() : undefined,
        pattern_keys: Array.isArray(parsed.pattern_keys) ? parsed.pattern_keys.filter((item: unknown): item is string => typeof item === 'string' && !!item.trim()) : undefined,
      }
    }
  }

  return null
}

export async function getPendingApproval(sessionId: string): Promise<PendingApprovalResponse> {
  // Prefer live approval cached from SSE stream — available before session messages
  // are flushed to disk, so the UI can surface the approval prompt immediately.
  const live = getLivePendingApproval(sessionId)
  if (live) {
    return {
      pending: {
        approval_id: live.approval_id,
        description: live.description,
        command: live.command,
        pattern_key: live.pattern_key,
        pattern_keys: live.pattern_keys,
      },
      pending_count: live.pending_count || 1,
    }
  }

  // Fallback: read persisted session messages (available after the run completes)
  const session = await hermesCli.getSession(sessionId)
  const pending = session?.messages ? findPendingApproval(session.messages) : null
  return {
    pending,
    pending_count: pending ? 1 : 0,
  }
}

export async function respondApproval(sessionId: string, choice: ApprovalChoice, authToken?: string) {
  if (tuiBridge.isEnabled() && tuiBridge.hasSession(sessionId)) {
    return tuiBridge.respondApproval(sessionId, choice)
  }
  return sendInstruction({
    input: APPROVAL_COMMANDS[choice],
    sessionId,
    authToken,
  })
}
