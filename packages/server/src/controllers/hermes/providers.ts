import { existsSync, readFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import { getActiveAuthPath } from '../../services/hermes/hermes-profile'
import * as hermesCli from '../../services/hermes/hermes-cli'
import {
  buildUserProviderConfigEntry,
  listUserProviders,
  normalizeCustomProviderSlug,
  readConfigYaml,
  writeConfigYaml,
  saveEnvValue,
  PROVIDER_ENV_MAP,
} from '../../services/config-helpers'
import { logger } from '../../services/logger'

const OPTIONAL_API_KEY_PROVIDERS = new Set(['cliproxyapi'])

function buildProviderEntry(name: string, base_url: string, api_key: string, model: string, context_length?: number) {
  const entry: any = { name, base_url, api_key, model }
  if (context_length && context_length > 0) {
    entry.models = { [model]: { context_length } }
  }
  return entry
}

function removeLegacyCustomProvider(config: Record<string, any>, slug: string) {
  if (!Array.isArray(config.custom_providers)) return
  config.custom_providers = (config.custom_providers as any[]).filter((entry: any) =>
    normalizeCustomProviderSlug(String(entry?.provider_key || entry?.name || '')) !== slug,
  )
  if (config.custom_providers.length === 0) delete config.custom_providers
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
    const config = await readConfigYaml()
    if (typeof config.model !== 'object' || config.model === null) { config.model = {} }
    if (!isBuiltin) {
      const slug = normalizeCustomProviderSlug(poolKey)
      if (!config.providers || typeof config.providers !== 'object' || Array.isArray(config.providers)) config.providers = {}
      const existingModels = Array.isArray(config.providers[slug]?.models) ? config.providers[slug].models : undefined
      config.providers[slug] = buildUserProviderConfigEntry(name, base_url, api_key, model, context_length, existingModels)
      removeLegacyCustomProvider(config, slug)
      config.model.default = model
      config.model.provider = `custom:${slug}`
    } else {
      if (PROVIDER_ENV_MAP[poolKey].api_key_env) {
        await saveEnvValue(PROVIDER_ENV_MAP[poolKey].api_key_env, api_key)
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
          if (context_length && context_length > 0) {
            if (!existing.models) existing.models = {}
            existing.models[model] = existing.models[model] || {}
            existing.models[model].context_length = context_length
          }
        } else {
          config.custom_providers.push(buildProviderEntry(poolKey, base_url, api_key, model, context_length))
        }
        config.model.default = model
        config.model.provider = `custom:${poolKey}`
      }
    }
    delete config.model.base_url
    delete config.model.api_key
    await writeConfigYaml(config)
    try { await hermesCli.restartGateway() } catch (e: any) { logger.error(e, 'Gateway restart failed') }
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
      const slug = normalizeCustomProviderSlug(poolKey)
      const config = await readConfigYaml()
      const providers = config.providers && typeof config.providers === 'object' && !Array.isArray(config.providers)
        ? config.providers as Record<string, any>
        : null
      const existingProvider = providers?.[slug]
      if (existingProvider) {
        if (name !== undefined) existingProvider.name = name
        if (base_url !== undefined) existingProvider.api = base_url
        if (api_key !== undefined) existingProvider.api_key = api_key
        if (model !== undefined) {
          existingProvider.default_model = model
          existingProvider.models = Array.from(new Set([model, ...(Array.isArray(existingProvider.models) ? existingProvider.models : [])]))
        }
        await writeConfigYaml(config)
        try { await hermesCli.restartGateway() } catch (e: any) { logger.error(e, 'Gateway restart failed') }
        ctx.body = { success: true }
        return
      }
      if (!Array.isArray(config.custom_providers)) {
        ctx.status = 404; ctx.body = { error: `Custom provider "${poolKey}" not found` }; return
      }
      const entry = (config.custom_providers as any[]).find((e: any) => {
        return normalizeCustomProviderSlug(String(e.name || '')) === slug
      })
      if (!entry) {
        ctx.status = 404; ctx.body = { error: `Custom provider "${poolKey}" not found` }; return
      }
      if (name !== undefined) entry.name = name
      if (base_url !== undefined) entry.base_url = base_url
      if (api_key !== undefined) entry.api_key = api_key
      if (model !== undefined) entry.model = model
      await writeConfigYaml(config)
    } else {
      const envMapping = PROVIDER_ENV_MAP[poolKey]
      if (!envMapping?.api_key_env) {
        ctx.status = 400; ctx.body = { error: `Cannot update credentials for "${poolKey}"` }; return
      }
      if (api_key !== undefined) { await saveEnvValue(envMapping.api_key_env, api_key) }
    }
    try { await hermesCli.restartGateway() } catch (e: any) { logger.error(e, 'Gateway restart failed') }
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}

export async function remove(ctx: any) {
  const poolKey = decodeURIComponent(ctx.params.poolKey)
  try {
    const config = await readConfigYaml()
    const isCustom = poolKey.startsWith('custom:')
    if (isCustom) {
      const slug = normalizeCustomProviderSlug(poolKey)
      let removed = false
      if (config.providers && typeof config.providers === 'object' && !Array.isArray(config.providers) && config.providers[slug]) {
        delete config.providers[slug]
        removed = true
      }
      const idx = Array.isArray(config.custom_providers)
        ? (config.custom_providers as any[]).findIndex((e: any) => {
          return normalizeCustomProviderSlug(String(e.name || '')) === slug
        })
        : -1
      if (idx !== -1) {
        (config.custom_providers as any[]).splice(idx, 1)
        if (config.custom_providers.length === 0) delete config.custom_providers
        removed = true
      }
      if (!removed) {
        ctx.status = 404; ctx.body = { error: `Custom provider "${poolKey}" not found` }; return
      }
      await writeConfigYaml(config)
    } else {
      const envMapping = PROVIDER_ENV_MAP[poolKey]
      if (envMapping?.api_key_env) {
        await saveEnvValue(envMapping.api_key_env, '')
        if (envMapping.base_url_env) { await saveEnvValue(envMapping.base_url_env, '') }
      } else if (!envMapping?.api_key_env) {
        try {
          const authPath = getActiveAuthPath()
          if (existsSync(authPath)) {
            const auth = JSON.parse(readFileSync(authPath, 'utf-8'))
            if (auth.providers?.[poolKey]) { delete auth.providers[poolKey] }
            if (auth.credential_pool?.[poolKey]) { delete auth.credential_pool[poolKey] }
            await writeFile(authPath, JSON.stringify(auth, null, 2) + '\n', 'utf-8')
          }
        } catch (err: any) { logger.error(err, 'Failed to clear OAuth tokens for %s', poolKey) }
      }
    }
    const currentProvider = config.model?.provider
    if (currentProvider === poolKey) {
      const freshConfig = await readConfigYaml()
      const remaining = listUserProviders(freshConfig)
      if (remaining.length > 0) {
        const fallbackCp = remaining[0]
        if (typeof freshConfig.model !== 'object' || freshConfig.model === null) { freshConfig.model = {} }
        freshConfig.model.default = fallbackCp.model
        freshConfig.model.provider = fallbackCp.providerKey
        delete freshConfig.model.base_url
        delete freshConfig.model.api_key
        await writeConfigYaml(freshConfig)
      } else {
        freshConfig.model = {}
        await writeConfigYaml(freshConfig)
      }
    }
    try { await hermesCli.restartGateway() } catch (e: any) { logger.error(e, 'Gateway restart failed') }
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}
