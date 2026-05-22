import { resolve, join } from 'path'
import { homedir } from 'os'
import { readFileSync, existsSync, readdirSync } from 'fs'

const HERMES_BASE = process.env.HERMES_HOME || resolve(homedir(), '.hermes')

/**
 * Get the active profile's home directory.
 * default → ~/.hermes/
 * other   → ~/.hermes/profiles/{name}/
 */
export function getActiveProfileDir(): string {
  const activeFile = join(HERMES_BASE, 'active_profile')
  try {
    const name = readFileSync(activeFile, 'utf-8').trim()
    if (name && name !== 'default') {
      const dir = join(HERMES_BASE, 'profiles', name)
      if (existsSync(dir)) return dir
    }
  } catch { }
  return HERMES_BASE
}

/**
 * Get the active profile's config.yaml path.
 */
export function getActiveConfigPath(): string {
  return join(getActiveProfileDir(), 'config.yaml')
}

/**
 * Get the active profile's auth.json path.
 */
export function getActiveAuthPath(): string {
  return join(getActiveProfileDir(), 'auth.json')
}

/**
 * Get the active profile's .env path.
 */
export function getActiveEnvPath(): string {
  return join(getActiveProfileDir(), '.env')
}

/**
 * Get the active profile name.
 */
export function getActiveProfileName(): string {
  const activeFile = join(HERMES_BASE, 'active_profile')
  try {
    const name = readFileSync(activeFile, 'utf-8').trim()
    return name || 'default'
  } catch {
    return 'default'
  }
}

/**
 * List profiles known on disk. The CLI table is presentation-oriented, so
 * callers that parse it need disk names as stable anchors.
 */
export function listProfileNamesFromDisk(): string[] {
  const names = new Set<string>(['default'])
  const profilesDir = join(HERMES_BASE, 'profiles')
  try {
    for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.trim()) {
        names.add(entry.name)
      }
    }
  } catch { }
  return [...names].sort((a, b) => {
    if (a === 'default') return -1
    if (b === 'default') return 1
    return a.localeCompare(b)
  })
}

/**
 * Get profile directory by name.
 * default → ~/.hermes/
 * other   → ~/.hermes/profiles/{name}/
 */
export function getProfileDir(name: string): string {
  if (!name || name === 'default') return HERMES_BASE
  const dir = join(HERMES_BASE, 'profiles', name)
  return existsSync(dir) ? dir : HERMES_BASE
}
