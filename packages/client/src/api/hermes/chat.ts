import { request, getBaseUrlValue, getApiKey } from '../client'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface StartRunRequest {
  input: string | ChatMessage[]
  instructions?: string
  conversation_history?: ChatMessage[]
  session_id?: string
  model?: string
  provider?: string
}

export interface StartRunResponse {
  run_id: string
  status: string
  bridge?: boolean
  session_id?: string
  bridge_session_id?: string
}

export interface SteerSessionResponse {
  ok: boolean
  status: string
  bridge?: boolean
  run_id?: string
  text?: string
}

// SSE event types from /v1/runs/{id}/events
export interface RunEvent {
  [key: string]: unknown
  event: string
  run_id?: string
  delta?: string
  /** Payload text for `reasoning.delta` / `thinking.delta` / `reasoning.available` events. */
  text?: string
  content?: string
  reasoning?: string
  thinking?: string
  message?: string
  tool?: string
  name?: string
  preview?: string
  arguments?: unknown
  args?: unknown
  parameters?: unknown
  input?: unknown
  context?: unknown
  result?: unknown
  /** Final response text on `run.completed`. May be empty/null if the agent
   * silently swallowed an upstream error — see chat store for fallback. */
  output?: string | null
  stdout?: unknown
  stderr?: unknown
  exit_code?: unknown
  returncode?: unknown
  exit_status?: unknown
  exitCode?: unknown
  duration?: number
  duration_s?: number
  duration_ms?: number
  timestamp?: number
  error?: string
  approval_id?: string
  description?: string
  command?: string
  pattern_key?: string
  pattern_keys?: string[]
  pending_count?: number
  request_id?: string
  question?: string
  choices?: string[]
  subagent_id?: string
  parent_id?: string
  depth?: number
  goal?: string
  status?: string
  summary?: string
  task_count?: number
  task_index?: number
  model?: string
  tool_name?: string
  tool_preview?: string
  output_tail?: Array<Record<string, unknown>>
  files_read?: string[]
  files_written?: string[]
  input_tokens?: number
  output_tokens?: number
  reasoning_tokens?: number
  api_calls?: number
  cost_usd?: number
  duration_seconds?: number
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
  }
}

function emitParsedEvent(eventName: string, raw: string, onEvent: (event: RunEvent) => void) {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const normalized = parsed as RunEvent
      if (!normalized.event) normalized.event = eventName
      onEvent(normalized)
      return normalized
    }
  } catch {
    const fallback = { event: eventName, delta: raw }
    onEvent(fallback)
    return fallback
  }

  const fallback = { event: eventName, delta: raw }
  onEvent(fallback)
  return fallback
}

const NAMED_RUN_EVENTS = [
  'approval',
  'clarify',
  'message.delta',
  'message.complete',
  'reasoning.delta',
  'thinking.delta',
  'reasoning',
  'thinking',
  'reasoning.available',
  'thinking.available',
  'reasoning.complete',
  'thinking.complete',
  'tool.started',
  'tool.progress',
  'tool.completed',
  'tool.start',
  'tool.complete',
  'run.started',
  'run.completed',
  'run.failed',
  'subagent.spawn_requested',
  'subagent.start',
  'subagent.thinking',
  'subagent.progress',
  'subagent.status',
  'subagent.tool',
  'subagent.complete',
  'subagent.error',
] as const

export async function startRun(body: StartRunRequest): Promise<StartRunResponse> {
  const headers: Record<string, string> = {}
  if (body.session_id) {
    headers['X-Hermes-Session-Id'] = body.session_id
  }
  return request<StartRunResponse>('/api/hermes/v1/runs', {
    method: 'POST',
    body: JSON.stringify(body),
    headers,
  })
}

export async function cancelRun(runId: string): Promise<void> {
  await request(`/api/hermes/v1/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
  })
}

export async function steerSession(sessionId: string, text: string): Promise<SteerSessionResponse> {
  return request<SteerSessionResponse>(`/api/hermes/v1/sessions/${encodeURIComponent(sessionId)}/steer`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
}

export function streamRunEvents(
  runId: string,
  onEvent: (event: RunEvent) => void,
  onDone: () => void,
  onError: (err: Error) => void,
) {
  const baseUrl = getBaseUrlValue()
  const token = getApiKey()
  const profile = localStorage.getItem('hermes_active_profile_name')
  const params = new URLSearchParams()
  if (token) params.set('token', token)
  if (profile && profile !== 'default') params.set('profile', profile)
  const qs = params.toString()
  const url = `${baseUrl}/api/hermes/v1/runs/${runId}/events${qs ? `?${qs}` : ''}`

  let closed = false
  const source = new EventSource(url)

  const handleSseEvent = (eventName: string, e: MessageEvent) => {
    if (closed) return
    const parsed = emitParsedEvent(eventName, e.data, onEvent)
    if (parsed?.event === 'run.completed' || parsed?.event === 'run.failed') {
      closed = true
      source.close()
      onDone()
    }
  }

  source.onmessage = (e) => handleSseEvent('message', e)

  for (const eventName of NAMED_RUN_EVENTS) {
    source.addEventListener(eventName, (e: MessageEvent) => handleSseEvent(eventName, e))
  }

  source.onerror = () => {
    if (closed) return
    closed = true
    source.close()
    onError(new Error('SSE connection error'))
  }

  // Return AbortController-compatible object
  return {
    abort: () => {
      if (!closed) {
        closed = true
        source.close()
      }
    },
  } as unknown as AbortController
}

export async function fetchModels(): Promise<{ data: Array<{ id: string }> }> {
  return request('/api/hermes/v1/models')
}
