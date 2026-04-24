// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, number>) => {
      if (key === 'chat.approvalTitle') return 'Approval required'
      if (key === 'chat.approvalAllowOnce') return 'Allow once'
      if (key === 'chat.approvalAllowSession') return 'Allow for session'
      if (key === 'chat.approvalAllowAlways') return 'Always allow'
      if (key === 'chat.approvalDeny') return 'Deny'
      if (key === 'chat.approvalDangerousCommand') return 'Risky command:'
      if (key === 'chat.approvalPendingCount') return `Showing ${params?.current} of ${params?.total}`
      if (key === 'chat.approvalResponding') return 'Submitting approval response...'
      return key
    },
  }),
}))

const NButtonStub = {
  props: ['disabled', 'loading', 'type', 'size'],
  emits: ['click'],
  template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
}

import ApprovalPrompt from '@/components/hermes/chat/ApprovalPrompt.vue'

describe('ApprovalPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders description, command, queue count, and all action buttons', () => {
    const wrapper = mount(ApprovalPrompt, {
      props: {
        pending: {
          approval_id: 'approval-1',
          description: 'Need permission',
          command: 'rm -rf /tmp/demo',
        },
        pendingCount: 3,
        submitting: false,
      },
      global: {
        stubs: {
          NButton: NButtonStub,
        },
      },
    })

    expect(wrapper.text()).toContain('Need permission')
    expect(wrapper.text()).toContain('rm -rf /tmp/demo')
    expect(wrapper.text()).toContain('Showing 1 of 3')
    expect(wrapper.findAll('button')).toHaveLength(4)
  })

  it('disables every action while submitting', () => {
    const wrapper = mount(ApprovalPrompt, {
      props: {
        pending: {
          approval_id: 'approval-1',
          description: 'Need permission',
        },
        pendingCount: 1,
        submitting: true,
      },
      global: {
        stubs: {
          NButton: NButtonStub,
        },
      },
    })

    expect(wrapper.text()).toContain('Submitting approval response...')
    expect(wrapper.findAll('button').every(node => node.attributes('disabled') !== undefined)).toBe(true)
  })
})
