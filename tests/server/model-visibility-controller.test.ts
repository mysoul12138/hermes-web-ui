import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockReadFile, mockReadConfigYaml, mockFetchProviderModels, mockBuildModelGroups, mockReadAppConfig, mockWriteAppConfig } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockReadConfigYaml: vi.fn(),
  mockFetchProviderModels: vi.fn(),
  mockBuildModelGroups: vi.fn(() => ({ default: '', groups: [] })),
  mockReadAppConfig: vi.fn(),
  mockWriteAppConfig: vi.fn(),
}))

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
}))

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveEnvPath: () => '/fake/home/.hermes/.env',
  getActiveAuthPath: () => '/fake/home/.hermes/auth.json',
}))

vi.mock('../../packages/server/src/services/config-helpers', () => ({
  readConfigYaml: mockReadConfigYaml,
  writeConfigYaml: vi.fn(),
  fetchProviderModels: mockFetchProviderModels,
  buildModelGroups: mockBuildModelGroups,
  PROVIDER_ENV_MAP: {
    deepseek: { api_key_env: 'DEEPSEEK_API_KEY' },
  },
  listUserProviders: vi.fn(() => []),
}))

vi.mock('../../packages/server/src/shared/providers', () => ({
  buildProviderModelMap: () => ({
    deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  }),
  PROVIDER_PRESETS: [
    {
      value: 'deepseek',
      label: 'DeepSeek',
      base_url: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat', 'deepseek-reasoner'],
    },
  ],
}))

vi.mock('../../packages/server/src/services/hermes/copilot-models', () => ({
  getCopilotModelsDetailed: vi.fn(async () => []),
  resolveCopilotOAuthToken: vi.fn(async () => ''),
}))

vi.mock('../../packages/server/src/services/app-config', () => ({
  readAppConfig: mockReadAppConfig,
  writeAppConfig: mockWriteAppConfig,
}))

vi.mock('../../packages/server/src/db', () => ({
  getDb: vi.fn(),
}))

vi.mock('../../packages/server/src/db/hermes/schemas', () => ({
  MODEL_CONTEXT_TABLE: 'model_context',
}))

import * as ctrl from '../../packages/server/src/controllers/hermes/models'

function makeCtx(body: Record<string, unknown> = {}): any {
  return { params: {}, query: {}, request: { body }, body: undefined, status: 200 }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockReadFile.mockResolvedValue('DEEPSEEK_API_KEY=sk-test\n')
  mockReadConfigYaml.mockResolvedValue({ model: { default: 'deepseek-chat', provider: 'deepseek' } })
  mockBuildModelGroups.mockReturnValue({ default: '', groups: [] })
  mockReadAppConfig.mockResolvedValue({})
  mockWriteAppConfig.mockImplementation(async patch => patch)
})

describe('models controller — model visibility', () => {
  it('filters available models per provider without changing canonical IDs', async () => {
    mockReadAppConfig.mockResolvedValue({
      modelVisibility: {
        deepseek: { mode: 'include', models: ['deepseek-reasoner'] },
      },
    })

    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.groups).toHaveLength(1)
    expect(ctx.body.groups[0]).toMatchObject({
      provider: 'deepseek',
      models: ['deepseek-reasoner'],
      available_models: ['deepseek-chat', 'deepseek-reasoner'],
    })
    expect(ctx.body.default).toBe('deepseek-reasoner')
    expect(ctx.body.default_provider).toBe('deepseek')
    expect(ctx.body.model_visibility).toEqual({
      deepseek: { mode: 'include', models: ['deepseek-reasoner'] },
    })
  })

  it('fails open for stale include rules so a provider can be recovered in the UI', async () => {
    mockReadAppConfig.mockResolvedValue({
      modelVisibility: {
        deepseek: { mode: 'include', models: ['missing-model'] },
      },
    })

    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    expect(ctx.body.groups[0]).toMatchObject({
      provider: 'deepseek',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      available_models: ['deepseek-chat', 'deepseek-reasoner'],
    })
  })

  it('merges Web UI custom models into available provider groups', async () => {
    mockReadAppConfig.mockResolvedValue({
      customModels: {
        deepseek: ['gemma-4-26b-a4b-it', 'deepseek-chat'],
      },
    })

    const ctx = makeCtx()
    await ctrl.getAvailable(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.groups[0]).toMatchObject({
      provider: 'deepseek',
      models: ['deepseek-chat', 'deepseek-reasoner', 'gemma-4-26b-a4b-it'],
      available_models: ['deepseek-chat', 'deepseek-reasoner', 'gemma-4-26b-a4b-it'],
    })
    expect(ctx.body.custom_models).toEqual({
      deepseek: ['gemma-4-26b-a4b-it', 'deepseek-chat'],
    })
  })

  it('saves include visibility in web-ui app config only', async () => {
    mockReadAppConfig.mockResolvedValue({ copilotEnabled: true })
    mockWriteAppConfig.mockResolvedValue({
      copilotEnabled: true,
      modelVisibility: { deepseek: { mode: 'include', models: ['deepseek-chat'] } },
    })

    const ctx = makeCtx({ provider: 'deepseek', mode: 'include', models: ['deepseek-chat', 'deepseek-chat', ''] })
    await ctrl.setModelVisibility(ctx)

    expect(mockWriteAppConfig).toHaveBeenCalledWith({
      modelVisibility: { deepseek: { mode: 'include', models: ['deepseek-chat'] } },
    })
    expect(ctx.body).toEqual({
      success: true,
      model_visibility: { deepseek: { mode: 'include', models: ['deepseek-chat'] } },
    })
  })

  it('adds and removes custom models in web-ui app config only', async () => {
    mockReadAppConfig.mockResolvedValueOnce({
      customModels: { deepseek: ['existing'] },
    })
    mockWriteAppConfig.mockResolvedValueOnce({
      customModels: { deepseek: ['existing', 'manual-model'] },
    })

    const addCtx = makeCtx({ provider: 'deepseek', model: 'manual-model' })
    await ctrl.addCustomModel(addCtx)

    expect(mockWriteAppConfig).toHaveBeenCalledWith({
      customModels: { deepseek: ['existing', 'manual-model'] },
    })
    expect(addCtx.body).toEqual({
      success: true,
      custom_models: { deepseek: ['existing', 'manual-model'] },
    })

    mockReadAppConfig.mockResolvedValueOnce({
      customModels: { deepseek: ['existing', 'manual-model'] },
    })
    mockWriteAppConfig.mockResolvedValueOnce({
      customModels: { deepseek: ['existing'] },
    })

    const removeCtx = makeCtx({ provider: 'deepseek', model: 'manual-model' })
    await ctrl.removeCustomModel(removeCtx)

    expect(mockWriteAppConfig).toHaveBeenLastCalledWith({
      customModels: { deepseek: ['existing'] },
    })
    expect(removeCtx.body).toEqual({
      success: true,
      custom_models: { deepseek: ['existing'] },
    })
  })

  it('removes custom models from query params when DELETE body is missing', async () => {
    mockReadAppConfig.mockResolvedValueOnce({
      customModels: { deepseek: ['manual-model'] },
    })
    mockWriteAppConfig.mockResolvedValueOnce({
      customModels: {},
    })

    const ctx = makeCtx()
    ctx.request.body = undefined
    ctx.query = { provider: 'deepseek', model: 'manual-model' }

    await ctrl.removeCustomModel(ctx)

    expect(ctx.status).toBe(200)
    expect(mockWriteAppConfig).toHaveBeenCalledWith({ customModels: {} })
    expect(ctx.body).toEqual({ success: true, custom_models: {} })
  })
})
