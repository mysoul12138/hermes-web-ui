import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/config', () => ({
  config: { upstream: 'http://127.0.0.1:8642' },
}))

vi.mock('../../packages/server/src/services/gateway-bootstrap', () => ({
  getGatewayManagerInstance: () => null,
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { applyJobModelDefaults, applyResolvedJobDefaults, update } from '../../packages/server/src/controllers/hermes/jobs'

function createMockCtx(overrides: Record<string, any> = {}) {
  const ctx: any = {
    req: { method: 'PATCH' },
    request: { body: { name: 'renamed' } },
    params: { id: 'abc123abc123' },
    query: {},
    search: '',
    headers: {},
    status: 200,
    set: vi.fn(),
    body: null,
    ...overrides,
  }
  ctx.get = (name: string) => {
    const match = Object.entries(ctx.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())
    const value = match?.[1]
    return Array.isArray(value) ? value[0] : value || ''
  }
  return ctx
}

describe('jobs controller defaults', () => {
  it('fills missing model/provider from config.yaml model section', () => {
    const payload = {
      name: 'weekly-cleanup',
      schedule: '0 20 * * 0',
      prompt: 'clean files',
    }

    const resolved = applyJobModelDefaults(payload, {
      model: {
        default: 'deepseek-ai/DeepSeek-V4-Pro',
        provider: 'custom:llm.mathmodel.tech',
      },
    })

    expect(resolved).toMatchObject({
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      provider: 'custom:llm.mathmodel.tech',
      base_url: null,
    })
  })

  it('preserves explicit job model/provider when provided', () => {
    const resolved = applyJobModelDefaults({
      model: 'deepseek-ai/DeepSeek-V4-Flash',
      provider: 'custom:llm.mathmodel.tech',
      base_url: null,
    }, {
      model: {
        default: 'deepseek-ai/DeepSeek-V4-Pro',
        provider: 'custom:another-provider',
        base_url: 'https://example.com/v1',
      },
    })

    expect(resolved).toMatchObject({
      model: 'deepseek-ai/DeepSeek-V4-Flash',
      provider: 'custom:llm.mathmodel.tech',
      base_url: 'https://example.com/v1',
    })
  })

  it('treats null and blank values as missing and backfills them', () => {
    const resolved = applyJobModelDefaults({
      model: null,
      provider: '   ',
      base_url: '',
    }, {
      model: {
        default: 'deepseek-ai/DeepSeek-V4-Pro',
        provider: 'custom:llm.mathmodel.tech',
      },
    })

    expect(resolved).toMatchObject({
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      provider: 'custom:llm.mathmodel.tech',
      base_url: null,
    })
  })

  it('hydrates legacy jobs with missing model/provider for WebUI responses', () => {
    const resolved = applyResolvedJobDefaults({
      id: 'job-1',
      model: null,
      provider: '',
      base_url: null,
    }, {
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      provider: 'custom:llm.mathmodel.tech',
      base_url: null,
    })

    expect(resolved).toMatchObject({
      id: 'job-1',
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      provider: 'custom:llm.mathmodel.tech',
      base_url: null,
    })
  })
})

describe('Hermes jobs controller proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes through upstream validation status and body instead of masking it as 502', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ error: 'Prompt must be <= 5000 characters' }),
    })

    const ctx = createMockCtx()
    await update(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Prompt must be <= 5000 characters' })
    expect(ctx.set).toHaveBeenCalledWith('Content-Type', 'application/json')
  })

  it('keeps real proxy connection failures as 502', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))

    const ctx = createMockCtx()
    await update(ctx)

    expect(ctx.status).toBe(502)
    expect(ctx.body).toEqual({ error: { message: 'Proxy error: ECONNREFUSED' } })
  })
})
