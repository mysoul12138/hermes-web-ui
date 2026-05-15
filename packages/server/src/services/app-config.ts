import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { config } from '../config'

const APP_HOME = config.appHome
const APP_CONFIG_FILE = join(APP_HOME, 'config.json')

export interface ModelVisibilityRule {
  mode: 'all' | 'include'
  models: string[]
}

export interface AppConfig {
  // Whether GitHub Copilot has been explicitly added by the user in web-ui.
  // Default false: even when COPILOT_GITHUB_TOKEN / gh-cli / apps.json can
  // resolve a token, the Copilot provider is hidden until the user opts in
  // via "Add Provider". Mirrors how the user manages Codex/Nous: the web-ui
  // owns the provider list, system credentials are merely a fallback source.
  copilotEnabled?: boolean

  // Web UI-only display aliases keyed by provider -> canonical model ID.
  modelAliases?: Record<string, Record<string, string>>

  // Web UI-only model picker visibility.
  modelVisibility?: Record<string, ModelVisibilityRule>
}

let cache: AppConfig | null = null

export async function readAppConfig(): Promise<AppConfig> {
  if (cache) return cache
  try {
    const raw = await readFile(APP_CONFIG_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as AppConfig
    cache = parsed
    return parsed
  } catch {
    cache = {}
    return cache
  }
}

export async function writeAppConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const current = await readAppConfig()
  const merged: AppConfig = { ...current, ...patch }
  await mkdir(APP_HOME, { recursive: true })
  await writeFile(APP_CONFIG_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 })
  cache = merged
  return merged
}

export function __resetAppConfigCacheForTest(): void {
  cache = null
}
