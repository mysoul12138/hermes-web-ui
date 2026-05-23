// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const runtimeApi = vi.hoisted(() => ({
  fetchRuntimeStatus: vi.fn(),
}))

const skillsApi = vi.hoisted(() => ({
  fetchSkillUsageStats: vi.fn(),
}))

const messageMock = vi.hoisted(() => ({
  success: vi.fn(),
}))

vi.mock('@/api/hermes/runtime', () => ({
  fetchRuntimeStatus: runtimeApi.fetchRuntimeStatus,
}))

vi.mock('@/api/hermes/skills', () => ({
  fetchSkillUsageStats: skillsApi.fetchSkillUsageStats,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (!params) return key
      return `${key}:${JSON.stringify(params)}`
    },
  }),
}))

vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<any>('naive-ui')
  return {
    ...actual,
    useMessage: () => messageMock,
    NButton: {
      props: ['loading'],
      emits: ['click'],
      template: '<button class="n-button-stub" :disabled="loading" @click="$emit(\'click\')"><slot /></button>',
    },
  }
})

import RuntimeView from '@/views/hermes/RuntimeView.vue'
import SkillsUsageView from '@/views/hermes/SkillsUsageView.vue'

function flushPromises() {
  return Promise.resolve().then(() => Promise.resolve())
}

function runtimeSnapshot() {
  return {
    capturedAt: 1710000000000,
    bridge: {
      enabled: true,
      activeRuns: 0,
      trackedWebSessions: 0,
      pendingPersistentResolutions: 0,
    },
    runs: [],
    sessions: [],
  }
}

function skillUsageStats() {
  return {
    period_days: 7,
    summary: {
      total_skill_actions: 0,
      total_skill_loads: 0,
      total_skill_edits: 0,
      distinct_skills_used: 0,
    },
    top_skills: [],
    by_day: [],
  }
}

describe('monitoring refresh feedback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    runtimeApi.fetchRuntimeStatus.mockResolvedValue(runtimeSnapshot())
    skillsApi.fetchSkillUsageStats.mockResolvedValue(skillUsageStats())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows feedback only for manual runtime status refreshes', async () => {
    const wrapper = mount(RuntimeView)
    await flushPromises()

    expect(messageMock.success).not.toHaveBeenCalled()

    await wrapper.find('.n-button-stub').trigger('click')
    await flushPromises()

    expect(messageMock.success).toHaveBeenCalledWith('runtime.refreshSuccess')
  })

  it('shows feedback only for manual skill usage refreshes', async () => {
    const wrapper = mount(SkillsUsageView)
    await flushPromises()

    expect(messageMock.success).not.toHaveBeenCalled()

    const buttons = wrapper.findAll('.n-button-stub')
    await buttons[buttons.length - 1].trigger('click')
    await flushPromises()

    expect(messageMock.success).toHaveBeenCalledWith('skillsUsage.refreshSuccess')
  })
})
