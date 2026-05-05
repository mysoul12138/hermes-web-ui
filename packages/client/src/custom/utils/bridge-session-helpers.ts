/**
 * Pure helpers for bridge session mapping, session model overrides, and
 * in-flight run tracking.  All localStorage operations — no Pinia dependency.
 *
 * Functions that need the current profile name accept it as a `profileName`
 * parameter so the callers can inject `getProfileName()` from the store.
 */
// ─── Constants ────────────────────────────────────────────────────────

export const BRIDGE_LOCAL_SESSION_KEY_PREFIX = 'hermes_bridge_local_session_v1_'
export const BRIDGE_PERSISTENT_SESSION_KEY_PREFIX = 'hermes_bridge_persistent_session_v1_'
export const BRIDGE_SEEN_KEY_PREFIX = 'hermes_bridge_seen_v1_'
export const SESSION_MODEL_OVERRIDE_KEY_PREFIX = 'hermes_session_model_override_v1_'
export const IN_FLIGHT_TTL_MS = 15 * 60 * 1000 // 15 minutes

const LEGACY_STORAGE_KEY = 'hermes_active_session'
const LEGACY_SESSIONS_CACHE_KEY = 'hermes_sessions_cache_v1'

// ─── Types ────────────────────────────────────────────────────────────

export interface InFlightRun {
  runId: string
  startedAt: number
}

export interface SessionModelOverride {
  model: string
  provider?: string
  updatedAt: number
}

// ─── localStorage utilities ───────────────────────────────────────────

function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { name?: string, code?: number }
  return e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014
}

export function setItemBestEffort(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
    return
  } catch (error) {
    if (!isQuotaExceededError(error)) return
  }
  // Attempt to free space by purging old caches for this profile
  recoverStorageQuota(key)
  try {
    localStorage.setItem(key, value)
  } catch {
    // quota exceeded or private mode — ignore, cache is best-effort
  }
}

export function saveJson(key: string, value: unknown) {
  try {
    setItemBestEffort(key, JSON.stringify(value))
  } catch {
    // quota exceeded or private mode — ignore, cache is best-effort
  }
}

export function removeItem(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

export function loadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

export function loadJsonWithFallback<T>(key: string, legacyKey?: string | null): T | null {
  const value = loadJson<T>(key)
  if (value != null) return value
  if (!legacyKey) return null
  return loadJson<T>(legacyKey)
}

export function saveJsonWithLegacy(key: string, value: unknown, legacyKey?: string | null) {
  saveJson(key, value)
  if (legacyKey) removeItem(legacyKey)
}

export function removeItemWithLegacy(key: string, legacyKey?: string | null) {
  removeItem(key)
  if (legacyKey) removeItem(legacyKey)
}

// ─── Key generators ───────────────────────────────────────────────────

export function storageKey(profileName: string): string {
  return 'hermes_active_session_' + profileName
}

export function sessionsCacheKey(profileName: string): string {
  return 'hermes_sessions_cache_v1_' + profileName
}

export function bridgeLocalSessionKey(profileName: string, sid: string): string {
  return `${BRIDGE_LOCAL_SESSION_KEY_PREFIX}${profileName}_${sid}`
}

export function bridgePersistentSessionKey(profileName: string, sid: string): string {
  return `${BRIDGE_PERSISTENT_SESSION_KEY_PREFIX}${profileName}_${sid}`
}

export function bridgeSeenKey(profileName: string): string {
  return BRIDGE_SEEN_KEY_PREFIX + profileName
}

export function sessionModelOverrideKey(profileName: string, sid: string): string {
  return `${SESSION_MODEL_OVERRIDE_KEY_PREFIX}${profileName}_${sid}`
}

export function msgsCacheKey(profileName: string, sid: string): string {
  return `hermes_session_msgs_v1_${profileName}_${sid}_`
}

export function inFlightKey(profileName: string, sid: string): string {
  return `hermes_in_flight_v1_${profileName}_${sid}`
}

export function legacyStorageKey(profileName: string): string | null {
  return profileName === 'default' ? LEGACY_STORAGE_KEY : null
}

export function legacySessionsCacheKey(profileName: string): string | null {
  return profileName === 'default' ? LEGACY_SESSIONS_CACHE_KEY : null
}

export function legacyMsgsCacheKey(profileName: string, sid: string): string | null {
  return profileName === 'default' ? `hermes_session_msgs_v1_${sid}` : null
}

export function legacyInFlightKey(profileName: string, sid: string): string | null {
  return profileName === 'default' ? `hermes_in_flight_v1_${sid}` : null
}

// ─── Storage quota recovery ───────────────────────────────────────────

function recoverStorageQuota(skipKey: string) {
  try {
    const profileName = skipKey.includes('_default_') ? 'default' : skipKey.split('_').slice(-2, -1)[0] || 'default'
    const prefixes = [
      sessionsCacheKey(profileName),
      `hermes_session_msgs_v1_${profileName}_`,
      `hermes_in_flight_v1_${profileName}_`,
      `${BRIDGE_LOCAL_SESSION_KEY_PREFIX}${profileName}_`,
      `${BRIDGE_PERSISTENT_SESSION_KEY_PREFIX}${profileName}_`,
      `${SESSION_MODEL_OVERRIDE_KEY_PREFIX}${profileName}_`,
    ]
    const legacySessions = legacySessionsCacheKey(profileName)
    if (legacySessions) prefixes.push(legacySessions)
    if (profileName === 'default') {
      prefixes.push('hermes_session_msgs_v1_')
      prefixes.push('hermes_in_flight_v1_')
    }
    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key) continue
      if (key === storageKey(profileName) || key === LEGACY_STORAGE_KEY) continue
      if (key === skipKey) continue
      if (prefixes.some(prefix => key.startsWith(prefix))) {
        keysToRemove.push(key)
      }
    }
    keysToRemove.forEach(key => removeItem(key))
  } catch {
    // ignore
  }
}

// ─── isPersistentTuiSessionId ─────────────────────────────────────────

export function isPersistentTuiSessionId(sid: string): boolean {
  return /^\d{8}_\d{6}_[0-9a-f]+$/i.test(sid)
}

// ─── Bridge session mapping ───────────────────────────────────────────

export function isBridgeLocalSession(profileName: string, sid: string): boolean {
  return localStorage.getItem(bridgeLocalSessionKey(profileName, sid)) === '1'
}

export function clearBridgeLocalSession(profileName: string, sid: string) {
  removeItem(bridgeLocalSessionKey(profileName, sid))
  removeItem(bridgePersistentSessionKey(profileName, sid))
}

export function readBridgePersistentSessionId(profileName: string, sid: string): string | null {
  const persistent = localStorage.getItem(bridgePersistentSessionKey(profileName, sid)) || null
  if (persistent && persistent !== sid && isPersistentTuiSessionId(sid)) return null
  return persistent
}

export function readBridgeBackingSessionId(profileName: string, sid: string): string | null {
  return localStorage.getItem(bridgePersistentSessionKey(profileName, sid)) || null
}

export function shouldDefaultNewSessionToTui(profileName: string): boolean {
  return localStorage.getItem(bridgeSeenKey(profileName)) === '1'
}

// ─── Session model override ───────────────────────────────────────────

export function readSessionModelOverride(profileName: string, sid: string | undefined): SessionModelOverride | null {
  if (!sid) return null
  const override = loadJson<SessionModelOverride>(sessionModelOverrideKey(profileName, sid))
  if (!override?.model?.trim()) return null
  return override
}

export function writeSessionModelOverride(profileName: string, sid: string, model: string, provider?: string) {
  const modelValue = model.trim()
  if (!sid || !modelValue) return
  saveJson(sessionModelOverrideKey(profileName, sid), {
    model: modelValue,
    provider: provider?.trim() || '',
    updatedAt: Date.now(),
  } as SessionModelOverride)
}

export function clearSessionModelOverride(profileName: string, sid: string) {
  removeItem(sessionModelOverrideKey(profileName, sid))
}

export function copySessionModelOverride(profileName: string, fromSid: string, toSid: string) {
  if (!fromSid || !toSid || fromSid === toSid) return
  const override = readSessionModelOverride(profileName, fromSid)
  if (!override) return
  writeSessionModelOverride(profileName, toSid, override.model, override.provider)
}

export function applySessionModelOverride(profileName: string, session: { id?: string; model?: string; provider?: string } | undefined | null) {
  if (!session?.id) return
  const override = readSessionModelOverride(profileName, session.id)
  if (!override) return
  session.model = override.model
  session.provider = override.provider || ''
}

// ─── In-flight run tracking ───────────────────────────────────────────

export function markInFlight(profileName: string, sid: string, runId: string) {
  saveJsonWithLegacy(
    inFlightKey(profileName, sid),
    { runId, startedAt: Date.now() } as InFlightRun,
    legacyInFlightKey(profileName, sid),
  )
}

export function readInFlight(profileName: string, sid: string): InFlightRun | null {
  const rec = loadJsonWithFallback<InFlightRun>(inFlightKey(profileName, sid), legacyInFlightKey(profileName, sid))
  if (!rec) return null
  if (Date.now() - rec.startedAt > IN_FLIGHT_TTL_MS) {
    removeItemWithLegacy(inFlightKey(profileName, sid), legacyInFlightKey(profileName, sid))
    return null
  }
  return rec
}

export function clearInFlight(profileName: string, sid: string) {
  removeItemWithLegacy(inFlightKey(profileName, sid), legacyInFlightKey(profileName, sid))
}
