import { request } from '../client'

export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'

export interface PendingApproval {
  approval_id?: string
  description?: string
  command?: string
  pattern_key?: string
  pattern_keys?: string[]
  _session_id?: string
  _optimistic?: boolean
}

export interface PendingApprovalResponse {
  pending: PendingApproval | null
  pending_count?: number
}

export interface RespondApprovalRequest {
  session_id: string
  choice: ApprovalChoice
  approval_id?: string
}

export interface RespondApprovalResponse {
  ok: boolean
  choice: ApprovalChoice
  run_id?: string
  status?: string
  command?: string
}

export async function getPendingApproval(sessionId: string): Promise<PendingApprovalResponse> {
  return request<PendingApprovalResponse>(`/api/hermes/approval/pending?session_id=${encodeURIComponent(sessionId)}`)
}

export async function respondApproval(body: RespondApprovalRequest): Promise<RespondApprovalResponse> {
  return request<RespondApprovalResponse>('/api/hermes/approval/respond', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
