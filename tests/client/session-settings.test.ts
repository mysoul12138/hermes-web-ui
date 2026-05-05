// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const mockSettingsStore = vi.hoisted(() => ({
  sessionReset: { mode: 'both', idle_minutes: 60, at_hour: 0 },
  approvals: { mode: 'off' },
  saveSection: vi.fn(),
}))

const mockPrefsStore = vi.hoisted(() => ({
  humanOnly: true,
  setHumanOnly: vi.fn((value: boolean) => {
    mockPrefsStore.humanOnly = value
  }),
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => mockSettingsStore,
}))

vi.mock('@/stores/hermes/session-browser-prefs', () => ({
  useSessionBrowserPrefsStore: () => mockPrefsStore,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  NInputNumber: { template: '<div />' },
  NSelect: { template: '<div />' },
  NSwitch: {
    name: 'NSwitch',
    props: ['value'],
    emits: ['update:value'],
    template: '<div class="n-switch" @click="$emit(\'update:value\', !value)"></div>',
  },
  useMessage: () => ({
    success: vi.fn(),
    error: vi.fn(),
  }),
}))

import SessionSettings from '@/components/hermes/settings/SessionSettings.vue'

describe('SessionSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrefsStore.humanOnly = true
  })

  it('surfaces the human-only preference in the Session tab', async () => {
    const wrapper = mount(SessionSettings, {
      global: {
        stubs: {
          SettingRow: {
            props: ['label', 'hint'],
            template: '<div class="setting-row"><div class="setting-row-label">{{ label }}</div><slot /></div>',
          },
          NSelect: true,
          NInputNumber: true,
        },
      },
    })

    expect(wrapper.text()).toContain('settings.session.liveMonitorHumanOnly')

    // Find the NSwitch component (second .n-switch is the humanOnly one)
    const switches = wrapper.findAllComponents({ name: 'NSwitch' })
    expect(switches.length).toBeGreaterThanOrEqual(1)

    // The last NSwitch controls the humanOnly preference
    const humanOnlySwitch = switches[switches.length - 1]
    await humanOnlySwitch.vm.$emit('update:value', false)
    await Promise.resolve()

    expect(mockPrefsStore.setHumanOnly).toHaveBeenCalledWith(false)
  })
})
