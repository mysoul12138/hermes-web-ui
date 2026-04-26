import { describe, expect, it } from 'vitest'
import { applyJobModelDefaults, applyResolvedJobDefaults } from '../../packages/server/src/controllers/hermes/jobs'

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
