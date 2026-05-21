import { existsSync, readFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import { getActiveAuthPath } from '../../services/hermes/hermes-profile'
import * as hermesCli from '../../services/hermes/hermes-cli'
import { buildUserProviderConfigEntry, updateConfigYaml, saveEnvValue, PROVIDER_ENV_MAP } from '../../services/config-helpers'
import { PROVIDER_PRESETS } from '../../shared/providers'
import { logger } from '../../services/logger'

const OPTIONAL_API_KEY_PROVIDERS = new Set(['cliproxyapi', 'xai-oauth'])
const DIRECT_CONFIG_PROVIDERS = new Set(['xai-oauth'])

async function clearStoredAuthProvider(poolKey: string) {
  try {
    const authPath = getActiveAuthPath()
    if (!existsSync(authPath)) return

    const auth = JSON.parse(readFileSync(authPath, 'utf-8'))
    let changed = false
    if (auth.providers && Object.prototype.hasOwnProperty.call(auth.providers, poolKey)) {
      delete auth.providers[poolKey]
      changed = true
    }
    if (auth.credential_pool && Object.prototype.hasOwnProperty.call(auth.credential_pool, poolKey)) {
      delete auth.credential_pool[poolKey]
      changed = true
    }
    if (changed) {
      await writeFile(authPath, JSON.stringify(auth, null, 2) + '\n', 'utf-8')
    }
  } catch (err: any) { logger.error(err, 'Failed to clear auth credentials for %s', poolKey) }
}

function buildProviderEntry(name: string, base_url: string, api_key: string, model: string, context_length?: number) {
  const entry: any = { name, base_url, api_key, model }
  if (context_length && context_length > 0) {
    entry.models = { [model]: { context_length } }
  }
  return entry
}

function providerSlugFromPoolKey(poolKey: string): string {
  return poolKey.replace(/^custom:/, '').trim().toLowerCase().replace(/ /g, '-')
}

function removeLegacyCustomProvider(config: any, poolKey: string): any | null {
  if (!Array.isArray(config.custom_providers)) return null
  const idx = (config.custom_providers as any[]).findIndex((e: any) => {
    return `custom:${String(e?.name || '').trim().toLowerCase().replace(/ /g, '-')}` === poolKey
  })
  if (idx === -1) return null
  const [removed] = (config.custom_providers as any[]).splice(idx, 1)
  if ((config.custom_providers as any[]).length === 0) delete config.custom_providers
  return removed || null
}

function ensureProvidersDict(config: any): Record<string, any> {
  if (!config.providers || typeof config.providers !== 'object' || Array.isArray(config.providers)) {
    config.providers = {}
  }
  return config.providers as Record<string, any>
}

export async function create(ctx: any) {
  const { name, base_url, api_key, model, context_length, providerKey } = ctx.request.body as {
    name: string; base_url: string; api_key: string; model: string; context_length?: number; providerKey?: string | null
  }
  if (!name || !base_url || !model) {
    ctx.status = 400; ctx.body = { error: 'Missing name, base_url, or model' }; return
  }
  if (!api_key && !OPTIONAL_API_KEY_PROVIDERS.has(String(providerKey || ''))) {
    ctx.status = 400; ctx.body = { error: 'Missing API key' }; return
  }
  try {
    const poolKey = providerKey || `custom:${name.trim().toLowerCase().replace(/ /g, '-')}`
    const isBuiltin = poolKey in PROVIDER_ENV_MAP
    await updateConfigYaml(async (config) => {
      if (typeof config.model !== 'object' || config.model === null) { config.model = {} }
      if (!isBuiltin) {
        const slug = providerSlugFromPoolKey(poolKey)
        const providers = ensureProvidersDict(config)
        providers[slug] = buildUserProviderConfigEntry(slug, base_url, api_key, model, context_length || 0)
        removeLegacyCustomProvider(config, poolKey)
        config.model.default = model
        config.model.provider = poolKey
      } else {
        if (PROVIDER_ENV_MAP[poolKey].api_key_env) {
          await saveEnvValue(PROVIDER_ENV_MAP[poolKey].api_key_env, api_key)
          if (PROVIDER_ENV_MAP[poolKey].base_url_env) { await saveEnvValue(PROVIDER_ENV_MAP[poolKey].base_url_env, base_url) }
          config.model.default = model
          config.model.provider = poolKey
        } else if (DIRECT_CONFIG_PROVIDERS.has(poolKey)) {
          if (PROVIDER_ENV_MAP[poolKey].base_url_env) { await saveEnvValue(PROVIDER_ENV_MAP[poolKey].base_url_env, base_url) }
          config.model.default = model
          config.model.provider = poolKey
        } else {
          if (!Array.isArray(config.custom_providers)) { config.custom_providers = [] }
          const existing = (config.custom_providers as any[]).find(
            (e: any) => `custom:${e.name}` === `custom:${poolKey}`
          )
          if (existing) {
            existing.base_url = base_url
            existing.api_key = api_key
            existing.model = model
            const preset = PROVIDER_PRESETS.find(p => p.value === poolKey)
            if (preset?.api_mode) existing.api_mode = preset.api_mode
            if (context_length && context_length > 0) {
              if (!existing.models) existing.models = {}
              existing.models[model] = existing.models[model] || {}
              existing.models[model].context_length = context_length
            }
          } else {
            const entry = buildProviderEntry(poolKey, base_url, api_key, model, context_length)
            const preset = PROVIDER_PRESETS.find(p => p.value === poolKey)
            if (preset?.api_mode) entry.api_mode = preset.api_mode
            config.custom_providers.push(entry)
          }
          config.model.default = model
          config.model.provider = `custom:${poolKey}`
        }
      }
      delete config.model.base_url
      delete config.model.api_key
      return config
    })
    // TODO: Test if provider works without gateway restart
    // try { await hermesCli.restartGateway() } catch (e: any) { logger.error(e, 'Gateway restart failed') }
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}

export async function update(ctx: any) {
  const poolKey = decodeURIComponent(ctx.params.poolKey)
  const { name, base_url, api_key, model } = ctx.request.body as {
    name?: string; base_url?: string; api_key?: string; model?: string
  }
  try {
    const isCustom = poolKey.startsWith('custom:')
    if (isCustom) {
      const found = await updateConfigYaml((config) => {
        const slug = providerSlugFromPoolKey(poolKey)
        const providers = ensureProvidersDict(config)
        const legacy = Array.isArray(config.custom_providers)
          ? (config.custom_providers as any[]).find((e: any) => `custom:${String(e?.name || '').trim().toLowerCase().replace(/ /g, '-')}` === poolKey)
          : null
        const existing = providers[slug] || (legacy ? buildUserProviderConfigEntry(
          slug,
          legacy.base_url || '',
          legacy.api_key || '',
          legacy.model || '',
          Number(legacy.models?.[legacy.model]?.context_length || 0),
        ) : null)
        if (!existing) return { data: config, result: false, write: false }
        const nextSlug = name !== undefined ? providerSlugFromPoolKey(`custom:${name}`) : slug
        if (nextSlug !== slug) delete providers[slug]
        const nextBaseUrl = base_url !== undefined ? base_url : existing.api || ''
        const nextApiKey = api_key !== undefined ? api_key : existing.api_key || ''
        const nextModel = model !== undefined ? model : existing.default_model || ''
        const nextContextLength = Number(existing.context_length || 0)
        providers[nextSlug] = buildUserProviderConfigEntry(nextSlug, nextBaseUrl, nextApiKey, nextModel, nextContextLength)
        removeLegacyCustomProvider(config, poolKey)
        if (config.model?.provider === poolKey && nextSlug !== slug) {
          config.model.provider = `custom:${nextSlug}`
        }
        return { data: config, result: true }
      })
      if (!found) {
        ctx.status = 404; ctx.body = { error: `Custom provider "${poolKey}" not found` }; return
      }
      // Sync credential pool in auth.json if api_key changed
      if (api_key !== undefined) {
        try {
          const authPath = getActiveAuthPath()
          if (existsSync(authPath)) {
            const auth = JSON.parse(readFileSync(authPath, 'utf-8'))
            if (auth.credential_pool?.[poolKey]) {
              auth.credential_pool[poolKey] = (auth.credential_pool[poolKey] as any[]).map((entry: any) => ({
                ...entry,
                access_token: api_key,
                last_status: null,
                last_error_code: null,
              }))
              await writeFile(authPath, JSON.stringify(auth, null, 2) + '\n', 'utf-8')
            }
          }
        } catch (err: any) { logger.error(err, 'Failed to sync credential pool for %s', poolKey) }
      }
    } else {
      const envMapping = PROVIDER_ENV_MAP[poolKey]
      if (!envMapping?.api_key_env) {
        ctx.status = 400; ctx.body = { error: `Cannot update credentials for "${poolKey}"` }; return
      }
      if (api_key !== undefined) { await saveEnvValue(envMapping.api_key_env, api_key) }
    }
    // TODO: Test if provider works without gateway restart
    // try { await hermesCli.restartGateway() } catch (e: any) { logger.error(e, 'Gateway restart failed') }
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}

export async function remove(ctx: any) {
  const poolKey = decodeURIComponent(ctx.params.poolKey)
  try {
    const isCustom = poolKey.startsWith('custom:')
    const removed = await updateConfigYaml(async (config) => {
      if (isCustom) {
        const slug = providerSlugFromPoolKey(poolKey)
        const providers = config.providers && typeof config.providers === 'object' && !Array.isArray(config.providers)
          ? config.providers as Record<string, any>
          : null
        const hadProvider = !!providers?.[slug]
        if (providers) {
          delete providers[slug]
          if (Object.keys(providers).length === 0) delete config.providers
        }
        const removedLegacy = removeLegacyCustomProvider(config, poolKey)
        if (!hadProvider && !removedLegacy) return { data: config, result: false, write: false }
      } else {
        const envMapping = PROVIDER_ENV_MAP[poolKey]
        if (envMapping?.api_key_env) {
          await saveEnvValue(envMapping.api_key_env, '')
          if (envMapping.base_url_env) { await saveEnvValue(envMapping.base_url_env, '') }
        }
      }
      if (config.model?.provider === poolKey) {
        const providerEntries = config.providers && typeof config.providers === 'object' && !Array.isArray(config.providers)
          ? Object.entries(config.providers) as [string, any][]
          : []
        const remaining = Array.isArray(config.custom_providers) ? config.custom_providers as any[] : []
        if (providerEntries.length > 0) {
          const [fallbackSlug, fallbackProvider] = providerEntries[0]
          const fallbackKey = `custom:${fallbackSlug}`
          if (typeof config.model !== 'object' || config.model === null) { config.model = {} }
          config.model.default = fallbackProvider.default_model
          config.model.provider = fallbackKey
          delete config.model.base_url
          delete config.model.api_key
        } else if (remaining.length > 0) {
          const fallbackCp = remaining[0]
          const fallbackKey = `custom:${fallbackCp.name.trim().toLowerCase().replace(/ /g, '-')}`
          if (typeof config.model !== 'object' || config.model === null) { config.model = {} }
          config.model.default = fallbackCp.model
          config.model.provider = fallbackKey
          delete config.model.base_url
          delete config.model.api_key
        } else {
          config.model = {}
        }
      }
      return { data: config, result: true }
    })
    if (!removed) {
      ctx.status = 404; ctx.body = { error: `Custom provider "${poolKey}" not found` }; return
    }
    if (!isCustom) {
      const envMapping = PROVIDER_ENV_MAP[poolKey]
      if (!envMapping) {
        ctx.status = 404; ctx.body = { error: `Provider "${poolKey}" not found` }; return
      }
    }
    await clearStoredAuthProvider(poolKey)
    // TODO: Test if provider works without gateway restart
    // try { await hermesCli.restartGateway() } catch (e: any) { logger.error(e, 'Gateway restart failed') }
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}
