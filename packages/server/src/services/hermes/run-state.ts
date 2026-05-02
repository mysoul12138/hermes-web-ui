export interface LivePendingApproval {
  approval_id?: string
  description?: string
  command?: string
  pattern_key?: string
  pattern_keys?: string[]
  pending_count?: number
}

export interface LivePendingClarify {
  request_id: string
  question: string
  choices: string[]
  requested_at?: number
}

const RUN_TTL_MS = 30 * 60 * 1000

const runSessionMap = new Map<string, string>()
const liveApprovalsBySession = new Map<string, LivePendingApproval>()
const liveClarifiesBySession = new Map<string, LivePendingClarify>()
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

function resetRunTimer(runId: string) {
  const prev = cleanupTimers.get(runId)
  if (prev) clearTimeout(prev)
  cleanupTimers.set(runId, setTimeout(() => {
    cleanupTimers.delete(runId)
    const sessionId = runSessionMap.get(runId)
    runSessionMap.delete(runId)
    if (sessionId) {
      liveApprovalsBySession.delete(sessionId)
      liveClarifiesBySession.delete(sessionId)
    }
  }, RUN_TTL_MS))
}

export function setRunSession(runId: string, sessionId: string): void {
  runSessionMap.set(runId, sessionId)
  resetRunTimer(runId)
}

export function getSessionForRun(runId: string): string | undefined {
  return runSessionMap.get(runId)
}

export function setLivePendingApprovalForRun(runId: string, pending: LivePendingApproval): void {
  const sessionId = runSessionMap.get(runId)
  if (!sessionId) return
  liveApprovalsBySession.set(sessionId, pending)
  resetRunTimer(runId)
}

export function clearLivePendingApprovalForRun(runId: string): void {
  const sessionId = runSessionMap.get(runId)
  if (sessionId) liveApprovalsBySession.delete(sessionId)
}

export function setLivePendingClarifyForRun(runId: string, pending: LivePendingClarify): void {
  const sessionId = runSessionMap.get(runId)
  if (!sessionId) return
  liveClarifiesBySession.set(sessionId, pending)
  resetRunTimer(runId)
}

export function clearLivePendingClarifyForRun(runId: string): void {
  const sessionId = runSessionMap.get(runId)
  if (sessionId) liveClarifiesBySession.delete(sessionId)
}

export function getLivePendingApproval(sessionId: string): LivePendingApproval | null {
  return liveApprovalsBySession.get(sessionId) || null
}

export function clearLivePendingApproval(sessionId: string): void {
  liveApprovalsBySession.delete(sessionId)
}

export function getLivePendingClarify(sessionId: string): LivePendingClarify | null {
  return liveClarifiesBySession.get(sessionId) || null
}

export function clearLivePendingClarify(sessionId: string): void {
  liveClarifiesBySession.delete(sessionId)
}
