// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/components/hermes/chat/MessageItem.vue', () => ({
  default: {
    props: ['message'],
    template: '<div class="message-item-stub">{{ message.role }}:{{ message.toolName || message.content }}</div>',
  },
}))

import MessageList from '@/components/hermes/chat/MessageList.vue'
import { useChatStore } from '@/stores/hermes/chat'

describe('MessageList', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders tool messages in the conversation list', async () => {
    const store = useChatStore()
    store.activeSessionId = 'sess-1'
    store.activeSession = {
      id: 'sess-1',
      title: 'Test',
      source: 'api_server',
      messages: [
        {
          id: 'u1',
          role: 'user',
          content: 'hello',
          timestamp: Date.now(),
        },
        {
          id: 't1',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'terminal',
          toolStatus: 'done',
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    const wrapper = mount(MessageList)
    const rendered = wrapper.findAll('.message-item-stub').map(node => node.text())

    expect(rendered).toContain('user:hello')
    expect(rendered).toContain('tool:terminal')
  })

  it('wraps messages in a dedicated content stage for the modern layout', () => {
    const store = useChatStore()
    store.activeSessionId = 'sess-modern'
    store.activeSession = {
      id: 'sess-modern',
      title: 'Modern',
      source: 'api_server',
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          content: 'render me',
          timestamp: Date.now(),
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    const wrapper = mount(MessageList)

    expect(wrapper.find('.message-list-stage').exists()).toBe(true)
    expect(wrapper.find('.message-list-stack').exists()).toBe(true)
  })

  it('does not force historical branch sessions to the bottom on first switch', async () => {
    const store = useChatStore()
    store.activeSessionId = 'root'
    store.activeSession = {
      id: 'root',
      title: 'Root',
      source: 'tui',
      messages: [
        { id: 'r1', role: 'assistant', content: 'root', timestamp: Date.now() },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    const wrapper = mount(MessageList)
    const list = wrapper.find('.message-list').element as HTMLElement
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1200 })
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 })

    list.scrollTop = 300
    await wrapper.find('.message-list').trigger('scroll')

    store.activeSessionId = 'branch'
    store.activeSession = {
      id: 'branch',
      title: 'Branch',
      source: 'tui',
      isBranchSession: true,
      rootSessionId: 'root',
      parentSessionId: 'root',
      messages: [
        { id: 'b1', role: 'user', content: 'branch task', timestamp: Date.now() },
        { id: 'b2', role: 'assistant', content: 'long branch content', timestamp: Date.now() },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await nextTick()
    await nextTick()

    expect(list.scrollTop).toBe(0)
  })
})
