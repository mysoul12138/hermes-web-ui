import { describe, expect, it } from 'vitest'
import {
  buildModelGroups,
  buildUserProviderConfigEntry,
  listUserProviders,
} from '../../packages/server/src/services/config-helpers'

describe('config helpers user providers', () => {
  it('reads Hermes providers dict as WebUI custom providers', () => {
    const config = {
      model: {
        default: 'gpt-5.5',
        provider: 'custom:ai.warp2pans.online',
      },
      providers: {
        'ai.warp2pans.online': {
          name: 'ai.warp2pans.online',
          api: 'https://ai.warp2pans.online/v1',
          api_key: 'secret',
          default_model: 'gpt-5.5',
          models: ['gpt-5.5', 'gpt-5.4'],
          context_length: 1000000,
        },
      },
    }

    expect(listUserProviders(config)).toEqual([
      expect.objectContaining({
        providerKey: 'custom:ai.warp2pans.online',
        slug: 'ai.warp2pans.online',
        base_url: 'https://ai.warp2pans.online/v1',
        model: 'gpt-5.5',
        models: ['gpt-5.5', 'gpt-5.4'],
        context_length: 1000000,
      }),
    ])
    expect(buildModelGroups(config).groups[0].models).toEqual([
      { id: 'gpt-5.5', label: 'ai.warp2pans.online: gpt-5.5' },
      { id: 'gpt-5.4', label: 'ai.warp2pans.online: gpt-5.4' },
    ])
  })

  it('builds Hermes providers dict entries instead of legacy-only custom providers', () => {
    expect(buildUserProviderConfigEntry(
      'ai.warp2pans.online',
      'https://ai.warp2pans.online/v1',
      'secret',
      'gpt-5.5',
      1000000,
    )).toEqual({
      name: 'ai.warp2pans.online',
      api: 'https://ai.warp2pans.online/v1',
      api_key: 'secret',
      default_model: 'gpt-5.5',
      models: ['gpt-5.5'],
      context_length: 1000000,
    })
  })
})
