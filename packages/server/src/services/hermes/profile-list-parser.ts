export interface ProfileListRuntimeInfo {
  active: boolean
  gateway?: string
  alias?: string
}

const GATEWAY_STATUS_TOKENS = new Set([
  'running',
  'stopped',
  'starting',
  'active',
  'stop',
  '—',
  '-',
])

function normalizeProfileLine(line: string): { active: boolean; body: string } | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('Profile') || trimmed.match(/^─/)) return null

  const active = trimmed.startsWith('◆')
  return {
    active,
    body: active ? trimmed.slice(1).trim() : trimmed,
  }
}

function matchProfileLine(body: string, profileNames: string[]): { profile: string; rest: string } | null {
  for (const profile of profileNames) {
    if (body === profile) return { profile, rest: '' }
    if (body.startsWith(profile) && /\s/.test(body.charAt(profile.length))) {
      return { profile, rest: body.slice(profile.length).trim() }
    }
  }
  return null
}

function extractGatewayInfo(rest: string): { gateway?: string; alias?: string } {
  const parts = rest.split(/\s+/).filter(Boolean)
  for (let i = 0; i < parts.length; i += 1) {
    const token = parts[i]
    if (GATEWAY_STATUS_TOKENS.has(token.toLowerCase())) {
      const alias = parts[i + 1]
      return {
        gateway: token,
        alias: alias && alias !== '—' && alias !== '-' ? alias : undefined,
      }
    }
  }
  return {}
}

export function parseProfileListRuntimeInfo(stdout: string, profileNames: string[]): Map<string, ProfileListRuntimeInfo> {
  const result = new Map<string, ProfileListRuntimeInfo>()
  const sortedProfiles = [...new Set(profileNames.map(name => name.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
  const normalized = stdout.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.trim().split('\n').filter(Boolean)

  for (const line of lines) {
    const parsed = normalizeProfileLine(line)
    if (!parsed) continue

    const matched = matchProfileLine(parsed.body, sortedProfiles)
    if (!matched) continue

    result.set(matched.profile, {
      active: parsed.active,
      ...extractGatewayInfo(matched.rest),
    })
  }

  return result
}
