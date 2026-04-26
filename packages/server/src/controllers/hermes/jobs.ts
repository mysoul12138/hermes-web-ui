import { readFile } from 'fs/promises'
import YAML from 'js-yaml'
import type { Context } from 'koa'
import { getGatewayManagerInstance } from '../../services/gateway-bootstrap'
import { config } from '../../config'
import { getProfileDir } from '../../services/hermes/hermes-profile'

type JobBody = Record<string, any>

type JobDefaults = {
  model: string | null
  provider: string | null
  base_url: string | null
}

function getUpstream(profile: string): string {
  const mgr = getGatewayManagerInstance()
  return mgr ? mgr.getUpstream(profile) : config.upstream.replace(/\/$/, '')
}

function getApiKey(profile: string): string | null {
  const mgr = getGatewayManagerInstance()
  return mgr?.getApiKey(profile) ?? null
}

function resolveProfile(ctx: Context): string {
  return ctx.get('x-hermes-profile') || (ctx.query.profile as string) || 'default'
}

function buildHeaders(profile: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const apiKey = getApiKey(profile)
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  return headers
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export function applyJobModelDefaults<T extends JobBody>(payload: T, configData: Record<string, any> | null | undefined): T {
  const modelSection = configData?.model
  const configDefaultModel = typeof modelSection === 'object' && modelSection !== null
    ? normalizeOptionalString(modelSection.default)
    : normalizeOptionalString(modelSection)
  const configDefaultProvider = typeof modelSection === 'object' && modelSection !== null
    ? normalizeOptionalString(modelSection.provider)
    : null
  const configBaseUrl = typeof modelSection === 'object' && modelSection !== null
    ? normalizeOptionalString(modelSection.base_url)
    : null

  return {
    ...payload,
    model: normalizeOptionalString(payload.model) ?? configDefaultModel,
    provider: normalizeOptionalString(payload.provider) ?? configDefaultProvider,
    base_url: normalizeOptionalString(payload.base_url) ?? configBaseUrl,
  }
}

async function readProfileJobDefaults(profile: string): Promise<JobDefaults> {
  try {
    const raw = await readFile(`${getProfileDir(profile)}/config.yaml`, 'utf-8')
    const configData = (YAML.load(raw) as Record<string, any> | null) || {}
    const normalized = applyJobModelDefaults({} as JobBody, configData)
    return {
      model: normalizeOptionalString(normalized.model),
      provider: normalizeOptionalString(normalized.provider),
      base_url: normalizeOptionalString(normalized.base_url),
    }
  } catch {
    return { model: null, provider: null, base_url: null }
  }
}

export function applyResolvedJobDefaults<T extends JobBody>(job: T, defaults: JobDefaults): T {
  return {
    ...job,
    model: normalizeOptionalString(job.model) ?? defaults.model,
    provider: normalizeOptionalString(job.provider) ?? defaults.provider,
    base_url: normalizeOptionalString(job.base_url) ?? defaults.base_url,
  }
}

async function adaptJobResponse(data: any, profile: string): Promise<any> {
  const defaults = await readProfileJobDefaults(profile)
  if (Array.isArray(data?.jobs)) {
    return {
      ...data,
      jobs: data.jobs.map((job: any) => applyResolvedJobDefaults(job, defaults)),
    }
  }
  if (data?.job && typeof data.job === 'object') {
    return {
      ...data,
      job: applyResolvedJobDefaults(data.job, defaults),
    }
  }
  return data
}

const TIMEOUT_MS = 30_000

async function proxyRequest(
  ctx: Context,
  upstreamPath: string,
  method?: string,
  bodyOverride?: Record<string, any>,
  transformResponse?: (data: any, profile: string) => Promise<any>,
): Promise<void> {
  const profile = resolveProfile(ctx)
  const upstream = getUpstream(profile)
  const params = new URLSearchParams(ctx.search || '')
  params.delete('token')
  const search = params.toString()
  const url = `${upstream}${upstreamPath}${search ? `?${search}` : ''}`

  const headers = buildHeaders(profile)
  const body = ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD'
    ? JSON.stringify(bodyOverride ?? ctx.request.body ?? {})
    : undefined

  const res = await fetch(url, {
    method: method || ctx.req.method,
    headers,
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  if (!res.ok) {
    ctx.status = 502
    ctx.set('Content-Type', 'application/json')
    ctx.body = { error: { message: `Upstream error: ${res.status} ${res.statusText}` } }
    return
  }

  ctx.status = res.status
  ctx.set('Content-Type', res.headers.get('content-type') || 'application/json')
  const data = await res.json()
  ctx.body = transformResponse ? await transformResponse(data, profile) : data
}

export async function list(ctx: Context) {
  await proxyRequest(ctx, '/api/jobs', undefined, undefined, adaptJobResponse)
}

export async function get(ctx: Context) {
  await proxyRequest(ctx, `/api/jobs/${ctx.params.id}`, undefined, undefined, adaptJobResponse)
}

export async function create(ctx: Context) {
  const profile = resolveProfile(ctx)
  const defaults = await readProfileJobDefaults(profile)
  await proxyRequest(ctx, '/api/jobs', undefined, {
    ...(ctx.request.body || {}),
    model: normalizeOptionalString((ctx.request.body as JobBody | undefined)?.model) ?? defaults.model,
    provider: normalizeOptionalString((ctx.request.body as JobBody | undefined)?.provider) ?? defaults.provider,
    base_url: normalizeOptionalString((ctx.request.body as JobBody | undefined)?.base_url) ?? defaults.base_url,
  }, adaptJobResponse)
}

export async function update(ctx: Context) {
  const profile = resolveProfile(ctx)
  const defaults = await readProfileJobDefaults(profile)
  await proxyRequest(ctx, `/api/jobs/${ctx.params.id}`, undefined, {
    ...(ctx.request.body || {}),
    model: normalizeOptionalString((ctx.request.body as JobBody | undefined)?.model) ?? defaults.model,
    provider: normalizeOptionalString((ctx.request.body as JobBody | undefined)?.provider) ?? defaults.provider,
    base_url: normalizeOptionalString((ctx.request.body as JobBody | undefined)?.base_url) ?? defaults.base_url,
  }, adaptJobResponse)
}

export async function remove(ctx: Context) {
  await proxyRequest(ctx, `/api/jobs/${ctx.params.id}`)
}

export async function pause(ctx: Context) {
  await proxyRequest(ctx, `/api/jobs/${ctx.params.id}/pause`, undefined, undefined, adaptJobResponse)
}

export async function resume(ctx: Context) {
  await proxyRequest(ctx, `/api/jobs/${ctx.params.id}/resume`, undefined, undefined, adaptJobResponse)
}

export async function run(ctx: Context) {
  await proxyRequest(ctx, `/api/jobs/${ctx.params.id}/run`, undefined, undefined, adaptJobResponse)
}
