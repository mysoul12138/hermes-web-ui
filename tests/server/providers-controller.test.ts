import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import YAML from 'js-yaml'

vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({
  restartGateway: vi.fn().mockResolvedValue('ok'),
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

function createCtx(poolKey: string, body: Record<string, unknown> = {}) {
  return {
    params: { poolKey: encodeURIComponent(poolKey) },
    request: { body },
    status: 200,
    body: null,
  } as any
}

describe('Hermes providers controller credential pool sync', () => {
  let oldHome: string | undefined
  let hermesHome: string

  beforeEach(async () => {
    oldHome = process.env.HERMES_HOME
    hermesHome = await mkdtemp(join(tmpdir(), 'hermes-webui-providers-'))
    process.env.HERMES_HOME = hermesHome
    vi.resetModules()
  })

  afterEach(() => {
    if (oldHome === undefined) {
      delete process.env.HERMES_HOME
    } else {
      process.env.HERMES_HOME = oldHome
    }
  })

  it('updates custom provider credential pool when api_key changes', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), YAML.dump({
      model: {
        default: 'gpt-5.5',
        provider: 'custom:ai.warp2pans.online',
      },
      providers: {
        'ai.warp2pans.online': {
          name: 'Ai.warp2pans.online',
          api: 'https://ai.warp2pans.online/v1',
          api_key: 'old-key',
          default_model: 'gpt-5.5',
          models: ['gpt-5.5'],
        },
      },
    }), 'utf-8')
    await writeFile(join(hermesHome, 'auth.json'), JSON.stringify({
      credential_pool: {
        'custom:ai.warp2pans.online': [
          {
            id: 'existing-config',
            label: 'ai.warp2pans.online',
            auth_type: 'api_key',
            priority: 0,
            source: 'config:ai.warp2pans.online',
            access_token: 'old-key',
            base_url: 'https://ai.warp2pans.online/v1',
            last_status: 'exhausted',
          },
        ],
      },
    }, null, 2), 'utf-8')

    const { update } = await import('../../packages/server/src/controllers/hermes/providers')
    const ctx = createCtx('custom:ai.warp2pans.online', { api_key: 'new-key' })
    await update(ctx)

    expect(ctx.body).toEqual({ success: true })
    const auth = JSON.parse(await readFile(join(hermesHome, 'auth.json'), 'utf-8'))
    expect(auth.credential_pool['custom:ai.warp2pans.online']).toEqual([
      expect.objectContaining({
        id: 'existing-config',
        access_token: 'new-key',
        priority: 0,
        last_status: null,
        last_error_code: null,
        base_url: 'https://ai.warp2pans.online/v1',
      }),
    ])
  })

  it('removes custom provider credential pool when provider is deleted', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), YAML.dump({
      model: { default: 'gpt-5.5', provider: 'custom:ai.warp2pans.online' },
      providers: {
        'ai.warp2pans.online': {
          name: 'Ai.warp2pans.online',
          api: 'https://ai.warp2pans.online/v1',
          api_key: 'key',
          default_model: 'gpt-5.5',
          models: ['gpt-5.5'],
        },
      },
    }), 'utf-8')
    await writeFile(join(hermesHome, 'auth.json'), JSON.stringify({
      credential_pool: {
        'custom:ai.warp2pans.online': [{ access_token: 'key' }],
      },
    }, null, 2), 'utf-8')

    const { remove } = await import('../../packages/server/src/controllers/hermes/providers')
    const ctx = createCtx('custom:ai.warp2pans.online')
    await remove(ctx)

    expect(ctx.body).toEqual({ success: true })
    const auth = JSON.parse(await readFile(join(hermesHome, 'auth.json'), 'utf-8'))
    expect(auth.credential_pool['custom:ai.warp2pans.online']).toBeUndefined()
  })
})
