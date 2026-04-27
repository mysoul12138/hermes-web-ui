import { request } from '../client'

export interface PendingClarify {
  request_id: string
  question: string
  choices: string[]
  requested_at?: number
  _session_id?: string
}

export interface PendingClarifyResponse {
  pending: PendingClarify | null
  pending_count?: number
}

export interface RespondClarifyRequest {
  session_id: string
  request_id: string
  answer: string
}

export interface RespondClarifyResponse {
  ok: boolean
  answer: string
  status?: string
  bridge?: boolean
}

export async function getPendingClarify(sessionId: string): Promise<PendingClarifyResponse> {
  return request<PendingClarifyResponse>(`/api/hermes/clarify/pending?session_id=${encodeURIComponent(sessionId)}`)
}

export async function respondClarify(body: RespondClarifyRequest): Promise<RespondClarifyResponse> {
  return request<RespondClarifyResponse>('/api/hermes/clarify/respond', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
