import { tuiBridge } from './tui-bridge'

export interface RuntimeRunSnapshot {
  runId: string
  webSessionId: string
  bridgeSessionId: string
  persistentSessionId: string | null
  status: 'running' | 'awaiting_approval' | 'awaiting_clarify' | 'cancelling' | 'closed'
  eventCount: number
  lastEvent: string | null
  lastActivityAt: number | null
  ageMs: number
  idleMs: number | null
  pendingApproval: boolean
  pendingClarify: boolean
  cancelRequestedAt: number | null
  contextInputTokens: number | null
}

export interface RuntimeStatusSnapshot {
  bridge: {
    enabled: boolean
    activeRuns: number
    trackedRuns: number
    trackedWebSessions: number
    persistentSessions: number
    pendingPersistentResolutions: number
  }
  runs: RuntimeRunSnapshot[]
  sessions: Array<{
    webSessionId: string
    bridgeSessionId: string
    persistentSessionId: string | null
    activeRunId: string | null
  }>
  capturedAt: number
}

export function getRuntimeStatusSnapshot(): RuntimeStatusSnapshot {
  return tuiBridge.getRuntimeSnapshot()
}
