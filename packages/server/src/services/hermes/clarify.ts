import { clearLivePendingClarify, getLivePendingClarify } from './run-state'
import { tuiBridge } from './tui-bridge'

export interface PendingClarify {
  request_id: string
  question: string
  choices: string[]
  requested_at?: number
}

export interface PendingClarifyResponse {
  pending: PendingClarify | null
  pending_count: number
}

export function getPendingClarify(sessionId: string): PendingClarifyResponse {
  const live = getLivePendingClarify(sessionId)
  return {
    pending: live
      ? {
          request_id: live.request_id,
          question: live.question,
          choices: live.choices,
          requested_at: live.requested_at,
        }
      : null,
    pending_count: live ? 1 : 0,
  }
}

export async function respondClarify(sessionId: string, requestId: string, answer: string) {
  if (tuiBridge.isEnabled() && tuiBridge.hasSession(sessionId)) {
    return tuiBridge.respondClarify(sessionId, requestId, answer)
  }
  clearLivePendingClarify(sessionId)
  return { ok: false, answer, status: 'bridge_unavailable' }
}
