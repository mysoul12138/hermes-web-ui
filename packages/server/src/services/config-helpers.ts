import { readFile, writeFile, copyFile, chmod } from 'fs/promises'
import { readdir, stat } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import YAML from 'js-yaml'
import { getActiveProfileDir, getActiveConfigPath, getActiveEnvPath, getActiveAuthPath } from './hermes/hermes-profile'
import { logger } from './logger'

// --- Provider env var mapping (from hermes providers.py HERMES_OVERLAYS + config.py) ---
export const PROVIDER_ENV_MAP: Record<string, { api_key_env: string; base_url_env: string }> = {
  openrouter: { api_key_env: 'OPENROUTER_API_KEY', base_url_env: '' },
  'glm-coding-plan': { api_key_env: '', base_url_env: '' },
  zai: { api_key_env: 'GLM_API_KEY', base_url_env: '' },
  'kimi-coding-cn': { api_key_env: 'KIMI_CN_API_KEY', base_url_env: '' },
  moonshot: { api_key_env: 'MOONSHOT_API_KEY', base_url_env: '' },
  minimax: { api_key_env: 'MINIMAX_API_KEY', base_url_env: '' },
  'minimax-cn': { api_key_env: 'MINIMAX_CN_API_KEY', base_url_env: '' },
  deepseek: { api_key_env: 'DEEPSEEK_API_KEY', base_url_env: '' },
  alibaba: { api_key_env: 'DASHSCOPE_API_KEY', base_url_env: '' },
  'alibaba-coding-plan': { api_key_env: 'ALIBABA_CODING_PLAN_API_KEY', base_url_env: 'ALIBABA_CODING_PLAN_BASE_URL' },
  anthropic: { api_key_env: 'ANTHROPIC_API_KEY', base_url_env: '' },
  xai: { api_key_env: 'XAI_API_KEY', base_url_env: '' },
  xiaomi: { api_key_env: 'XIAOMI_API_KEY', base_url_env: '' },
  'xiaomi-token-plan': { api_key_env: '', base_url_env: '' },
  gemini: { api_key_env: 'GEMINI_API_KEY', base_url_env: '' },
  kilocode: { api_key_env: 'KILO_API_KEY', base_url_env: '' },
  'ai-gateway': { api_key_env: 'AI_GATEWAY_API_KEY', base_url_env: '' },
  cliproxyapi: { api_key_env: '', base_url_env: '' },
  'opencode-zen': { api_key_env: 'OPENCODE_API_KEY', base_url_env: '' },
  'opencode-go': { api_key_env: 'OPENCODE_API_KEY', base_url_env: '' },
  huggingface: { api_key_env: 'HF_TOKEN', base_url_env: '' },
  arcee: { api_key_env: 'ARCEE_API_KEY', base_url_env: '' },
  stepfun: { api_key_env: 'STEPFUN_API_KEY', base_url_env: '' },
  nous: { api_key_env: '', base_url_env: '' },
  'openai-codex': { api_key_env: '', base_url_env: '' },
  copilot: { api_key_env: '', base_url_env: '' },
  longcat: { api_key_env: 'LONGCAT_API_KEY', base_url_env: 'LONGCAT_BASE_URL' },
}

// --- Types ---

export type SkillSource = 'builtin' | 'hub' | 'local'

export interface SkillInfo {
  name: string
  description: string
  enabled: boolean
  source?: SkillSource
}

export interface SkillCategory {
  name: string
  description: string
  skills: SkillInfo[]
}

export interface ModelInfo {
  id: string
  label: string
}

export interface ModelGroup {
  provider: string
  models: ModelInfo[]
}

export interface UserProviderInfo {
  providerKey: string
  slug: string
  label: string
  base_url: string
  model: string
  api_key: string
  models: string[]
  api_mode?: string
  context_length?: number
}

export function normalizeCustomProviderSlug(value: string): string {
  return value.trim().replace(/^custom:/i, '').toLowerCase().replace(/ /g, '-')
}

function uniqueModels(defaultModel: string, models: unknown): string[] {
  const result: string[] = []
  const push = (value: unknown) => {
    if (typeof value !== 'string') return
    const model = value.trim()
    if (model && !result.includes(model)) result.push(model)
  }
  push(defaultModel)
  if (Array.isArray(models)) {
    for (const model of models) push(model)
  } else if (models && typeof models === 'object') {
    for (const model of Object.keys(models as Record<string, unknown>)) push(model)
  }
  return result
}

export function buildUserProviderConfigEntry(
  name: string,
  base_url: string,
  api_key: string,
  model: string,
  context_length?: number,
  models?: string[],
) {
  const entry: Record<string, any> = {
    name: name.trim(),
    api: base_url.trim(),
    api_key: api_key.trim(),
    default_model: model.trim(),
    models: uniqueModels(model, models),
  }
  if (context_length && context_length > 0) entry.context_length = context_length
  return entry
}

export function listUserProviders(config: Record<string, any>): UserProviderInfo[] {
  const result: UserProviderInfo[] = []
  const seen = new Set<string>()
  const add = (info: UserProviderInfo) => {
    if (!info.slug || !info.base_url) return
    if (seen.has(info.providerKey)) return
    seen.add(info.providerKey)
    result.push(info)
  }

  const providers = config.providers
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    for (const [rawSlug, entry] of Object.entries(providers as Record<string, any>)) {
      if (!entry || typeof entry !== 'object') continue
      const slug = normalizeCustomProviderSlug(rawSlug)
      const baseUrl = String(entry.api || entry.url || entry.base_url || '').trim()
      const model = String(entry.default_model || entry.model || '').trim()
      const label = String(entry.name || rawSlug).trim()
      add({
        providerKey: `custom:${slug}`,
        slug,
        label,
        base_url: baseUrl,
        model,
        api_key: String(entry.api_key || '').trim(),
        models: uniqueModels(model, entry.models),
        api_mode: typeof entry.transport === 'string' ? entry.transport : typeof entry.api_mode === 'string' ? entry.api_mode : undefined,
        context_length: typeof entry.context_length === 'number' ? entry.context_length : undefined,
      })
    }
  }

  const customProviders = config.custom_providers
  if (Array.isArray(customProviders)) {
    for (const entry of customProviders) {
      if (!entry || typeof entry !== 'object') continue
      const name = String(entry.name || '').trim()
      const slug = normalizeCustomProviderSlug(String(entry.provider_key || name))
      const baseUrl = String(entry.base_url || '').trim()
      const model = String(entry.model || '').trim()
      add({
        providerKey: `custom:${slug}`,
        slug,
        label: name || slug,
        base_url: baseUrl,
        model,
        api_key: String(entry.api_key || '').trim(),
        models: uniqueModels(model, entry.models),
        api_mode: typeof entry.api_mode === 'string' ? entry.api_mode : undefined,
        context_length: typeof entry.context_length === 'number' ? entry.context_length : undefined,
      })
    }
  }

  return result
}

// --- Config YAML helpers ---

const configPath = () => getActiveConfigPath()

export async function readConfigYaml(): Promise<Record<string, any>> {
  const raw = await safeReadFile(configPath())
  if (!raw) return {}
  return (YAML.load(raw) as Record<string, any>) || {}
}

export async function writeConfigYaml(config: Record<string, any>): Promise<void> {
  const cp = configPath()
  await copyFile(cp, cp + '.bak')
  const yamlStr = YAML.dump(config, {
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
  })
  await writeFile(cp, yamlStr, 'utf-8')
}

// --- .env helpers ---

export async function saveEnvValue(key: string, value: string): Promise<void> {
  const envPath = getActiveEnvPath()
  let raw: string
  try {
    raw = await readFile(envPath, 'utf-8')
  } catch {
    raw = ''
  }
  const remove = !value
  const lines = raw.split('\n')
  let found = false
  const result: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#') && trimmed.startsWith(`# ${key}=`)) {
      if (!remove) result.push(`${key}=${value}`)
      found = true
    } else {
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx !== -1 && trimmed.slice(0, eqIdx).trim() === key) {
        if (!remove) result.push(`${key}=${value}`)
        found = true
      } else {
        result.push(line)
      }
    }
  }
  if (!found && !remove) {
    result.push(`${key}=${value}`)
  }
  let output = result.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '') + '\n'
  await writeFile(envPath, output, 'utf-8')
  try { await chmod(envPath, 0o600) } catch { /* ignore */ }
}

// --- File helpers ---

export async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

export async function safeStat(filePath: string): Promise<{ mtime: number } | null> {
  try {
    const s = await stat(filePath)
    return { mtime: Math.round(s.mtimeMs) }
  } catch {
    return null
  }
}

// --- Skill helpers ---

export function extractDescription(content: string): string {
  const lines = content.split('\n')
  let inFrontmatter = false
  let bodyStarted = false

  for (const line of lines) {
    if (!bodyStarted && line.trim() === '---') {
      if (!inFrontmatter) {
        inFrontmatter = true
        continue
      } else {
        inFrontmatter = false
        bodyStarted = true
        continue
      }
    }
    if (inFrontmatter) continue
    if (line.trim() === '') continue
    if (line.startsWith('#')) continue
    return line.trim().slice(0, 80)
  }
  return ''
}

export async function listFilesRecursive(dir: string, prefix: string): Promise<{ path: string; name: string }[]> {
  const result: { path: string; name: string }[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      result.push(...await listFilesRecursive(join(dir, entry.name), relPath))
    } else {
      result.push({ path: relPath, name: entry.name })
    }
  }
  return result
}

// --- Provider model helpers ---

export async function fetchProviderModels(baseUrl: string, apiKey: string, freeOnly = false): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, '')
  const modelsUrl = /\/v\d+\/?$/.test(base) ? `${base}/models` : `${base}/v1/models`
  try {
    const res = await fetch(modelsUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      logger.warn('available-models %s returned %d', modelsUrl, res.status)
      return []
    }
    const data = await res.json() as { data?: Array<{ id: string }> }
    if (!Array.isArray(data.data)) {
      logger.warn('available-models %s returned unexpected format', modelsUrl)
      return []
    }
    let models = data.data.map(m => m.id)
    if (freeOnly) models = models.filter(m => m.endsWith(':free'))
    return models.sort()
  } catch (err: any) {
    logger.error(err, 'available-models %s failed', modelsUrl)
    return []
  }
}

export function buildModelGroups(config: Record<string, any>): { default: string; groups: ModelGroup[] } {
  let defaultModel = ''
  const groups: ModelGroup[] = []

  // 1. Extract current model
  const modelSection = config.model
  if (typeof modelSection === 'object' && modelSection !== null) {
    defaultModel = String(modelSection.default || '').trim()
  } else if (typeof modelSection === 'string') {
    defaultModel = modelSection.trim()
  }

  // 2. Extract user-defined providers from Hermes' current providers: dict
  // and the legacy custom_providers: list.
  const customModels: ModelInfo[] = []
  for (const provider of listUserProviders(config)) {
    for (const model of provider.models.length ? provider.models : [provider.model]) {
      if (model) customModels.push({ id: model, label: `${provider.label}: ${model}` })
    }
  }
  if (customModels.length > 0) {
    groups.push({ provider: 'Custom', models: customModels })
  }

  return { default: defaultModel, groups }
}

// --- Profile directory helper ---

export const getHermesDir = () => getActiveProfileDir()
