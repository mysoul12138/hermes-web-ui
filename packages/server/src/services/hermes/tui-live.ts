import { readdir, readFile } from 'fs/promises'
import type { Dirent } from 'fs'

const CACHE_TTL_MS = 1500
let cachedAt = 0
let cachedSessionKeys = new Set<string>()

function parseSessionKey(parts: string[]): string | null {
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]
    if (part === '--session-key') {
      return parts[i + 1] || null
    }
    if (part.startsWith('--session-key=')) {
      return part.slice('--session-key='.length) || null
    }
  }
  return null
}

async function readProcCmdline(pid: string): Promise<string[] | null> {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`)
    return raw.toString('utf8').split('\0').filter(Boolean)
  } catch {
    return null
  }
}

async function scanLiveTuiSessionKeys(): Promise<Set<string>> {
  if (process.platform === 'win32') return new Set()

  let entries: Dirent[]
  try {
    entries = await readdir('/proc', { withFileTypes: true })
  } catch {
    return new Set()
  }

  const sessionKeys = new Set<string>()
  await Promise.all(entries
    .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map(async entry => {
      const parts = await readProcCmdline(entry.name)
      if (!parts?.some(part => part === 'tui_gateway.slash_worker')) return
      const sessionKey = parseSessionKey(parts)
      if (sessionKey) sessionKeys.add(sessionKey)
    }))

  return sessionKeys
}

export async function listLiveTuiSessionKeys(): Promise<Set<string>> {
  const now = Date.now()
  if (now - cachedAt <= CACHE_TTL_MS) {
    return new Set(cachedSessionKeys)
  }

  cachedSessionKeys = await scanLiveTuiSessionKeys()
  cachedAt = now
  return new Set(cachedSessionKeys)
}
