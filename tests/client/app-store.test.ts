// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mockSystemApi = vi.hoisted(() => ({
  checkHealth: vi.fn(),
  fetchAvailableModels: vi.fn(),
  addCustomModel: vi.fn(),
  removeCustomModel: vi.fn(),
  updateDefaultModel: vi.fn(),
  updateModelAlias: vi.fn(),
  updateModelVisibility: vi.fn(),
  triggerUpdate: vi.fn(),
}))

vi.mock('@/api/hermes/system', () => mockSystemApi)

import { useAppStore } from '@/stores/hermes/app'

async function loadAppStoreWithVersion(version: string) {
  vi.resetModules()
  ;(globalThis as any).__APP_VERSION__ = version
  const mod = await import('@/stores/hermes/app')
  return mod.useAppStore()
}

describe('App Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockSystemApi.addCustomModel.mockResolvedValue({ success: true, custom_models: {} })
    mockSystemApi.removeCustomModel.mockResolvedValue({ success: true, custom_models: {} })
    window.localStorage.clear()
    window.localStorage.setItem('hermes_api_key', 'test-token')
  })

  it('persists desktop sidebar collapsed state to localStorage', () => {
    const store = useAppStore()

    expect(store.sidebarCollapsed).toBe(false)

    store.toggleSidebarCollapsed()
    expect(store.sidebarCollapsed).toBe(true)
    expect(window.localStorage.getItem('hermes_sidebar_collapsed')).toBe('1')

    store.toggleSidebarCollapsed()
    expect(store.sidebarCollapsed).toBe(false)
    expect(window.localStorage.getItem('hermes_sidebar_collapsed')).toBe('0')
  })

  it('loads model visibility and falls back when the configured default is hidden', async () => {
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'deepseek-chat',
      default_provider: 'deepseek',
      groups: [
        {
          provider: 'deepseek',
          label: 'DeepSeek',
          base_url: 'https://api.deepseek.com/v1',
          api_key: 'sk-test',
          models: ['deepseek-reasoner'],
        },
      ],
      allProviders: [],
      model_visibility: {
        deepseek: { mode: 'include', models: ['deepseek-reasoner'] },
      },
    })
    const store = useAppStore()

    await store.loadModels()

    expect(store.modelVisibility).toEqual({
      deepseek: { mode: 'include', models: ['deepseek-reasoner'] },
    })
    expect(store.selectedModel).toBe('deepseek-reasoner')
    expect(store.selectedProvider).toBe('deepseek')
    expect(store.isModelVisible('deepseek', 'deepseek-reasoner')).toBe(true)
    expect(store.isModelVisible('deepseek', 'deepseek-chat')).toBe(false)
  })

  it('persists model visibility without changing the canonical selected model id', async () => {
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'deepseek-reasoner',
      default_provider: 'deepseek',
      groups: [
        {
          provider: 'deepseek',
          label: 'DeepSeek',
          base_url: 'https://api.deepseek.com/v1',
          api_key: 'sk-test',
          models: ['deepseek-reasoner'],
        },
      ],
      allProviders: [],
      model_visibility: {
        deepseek: { mode: 'include', models: ['deepseek-reasoner'] },
      },
    })
    mockSystemApi.updateModelVisibility.mockResolvedValue({
      success: true,
      model_visibility: {
        deepseek: { mode: 'include', models: ['deepseek-reasoner'] },
      },
    })
    const store = useAppStore()
    await store.loadModels()

    await store.setModelVisibility('deepseek', { mode: 'include', models: ['deepseek-reasoner'] })

    expect(mockSystemApi.updateModelVisibility).toHaveBeenCalledWith({
      provider: 'deepseek',
      mode: 'include',
      models: ['deepseek-reasoner'],
    })
    expect(store.selectedModel).toBe('deepseek-reasoner')
    expect(store.selectedProvider).toBe('deepseek')
    expect(mockSystemApi.updateDefaultModel).not.toHaveBeenCalled()
  })

  it('loads persisted custom models from the server response', async () => {
    mockSystemApi.fetchAvailableModels.mockResolvedValue({
      default: 'gemma-4-26b-a4b-it',
      default_provider: 'google-ai-studio',
      groups: [{
        provider: 'google-ai-studio',
        label: 'Google AI Studio',
        base_url: 'https://generativelanguage.googleapis.com/v1beta',
        models: ['gemma-4-26b-a4b-it'],
        api_key: '',
      }],
      allProviders: [],
      custom_models: {
        'google-ai-studio': ['gemma-4-26b-a4b-it'],
      },
    })
    const store = useAppStore()

    await store.loadModels()

    expect(store.selectedModel).toBe('gemma-4-26b-a4b-it')
    expect(store.customModels).toEqual({
      'google-ai-studio': ['gemma-4-26b-a4b-it'],
    })
  })

  it('persists manually entered custom models and removes them from loaded groups', async () => {
    mockSystemApi.addCustomModel.mockResolvedValue({
      success: true,
      custom_models: { deepseek: ['manual-model'] },
    })
    mockSystemApi.removeCustomModel.mockResolvedValue({
      success: true,
      custom_models: {},
    })
    const store = useAppStore()
    store.modelGroups = [{
      provider: 'deepseek',
      label: 'DeepSeek',
      base_url: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat'],
      available_models: ['deepseek-chat'],
      api_key: '',
    }]

    await store.switchModel('manual-model', 'deepseek')

    expect(store.selectedModel).toBe('manual-model')
    expect(store.customModels).toEqual({ deepseek: ['manual-model'] })
    expect(mockSystemApi.addCustomModel).toHaveBeenCalledWith({
      provider: 'deepseek',
      model: 'manual-model',
    })

    store.modelGroups = [{
      provider: 'deepseek',
      label: 'DeepSeek',
      base_url: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat', 'manual-model'],
      available_models: ['deepseek-chat', 'manual-model'],
      api_key: '',
    }]

    await store.removeCustomModel('manual-model', 'deepseek')

    expect(store.customModels).toEqual({})
    expect(store.modelGroups[0].models).toEqual(['deepseek-chat'])
    expect(store.modelGroups[0].available_models).toEqual(['deepseek-chat'])
    expect(mockSystemApi.removeCustomModel).toHaveBeenCalledWith({
      provider: 'deepseek',
      model: 'manual-model',
    })
    expect(store.selectedModel).toBe('deepseek-chat')
    expect(mockSystemApi.updateDefaultModel).toHaveBeenLastCalledWith({
      default: 'deepseek-chat',
      provider: 'deepseek',
    })
  })

  it('clears the updating state and reports failure when self-update request fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockSystemApi.triggerUpdate.mockRejectedValue(new Error('install failed'))
    const store = useAppStore()

    const ok = await store.doUpdate()

    expect(ok).toBe(false)
    expect(store.updating).toBe(false)
    expect(consoleError).toHaveBeenCalledWith('Failed to update Hermes Web UI:', expect.any(Error))
    consoleError.mockRestore()
  })

  it('marks the client as outdated only when the server reports a newer version', async () => {
    const store = await loadAppStoreWithVersion('0.5.17')

    mockSystemApi.checkHealth.mockResolvedValueOnce({
      status: 'ok',
      webui_version: '0.5.16',
      webui_latest: '0.5.16',
      webui_update_available: false,
    })
    await store.checkConnection()
    expect(store.serverVersion).toBe('0.5.16')
    expect(store.clientOutdated).toBe(false)

    mockSystemApi.checkHealth.mockResolvedValueOnce({
      status: 'ok',
      webui_version: '0.5.17',
      webui_latest: '0.5.17',
      webui_update_available: false,
    })
    await store.checkConnection()
    expect(store.serverVersion).toBe('0.5.17')
    expect(store.clientOutdated).toBe(false)

    mockSystemApi.checkHealth.mockResolvedValueOnce({
      status: 'ok',
      webui_version: '0.5.18',
      webui_latest: '0.5.18',
      webui_update_available: true,
    })
    await store.checkConnection()
    expect(store.serverVersion).toBe('0.5.18')
    expect(store.clientOutdated).toBe(true)
  })
})
