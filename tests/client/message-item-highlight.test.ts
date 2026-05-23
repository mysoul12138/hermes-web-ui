// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  NDrawer: {
    name: 'NDrawer',
    template: '<div><slot /></div>',
  },
  NDrawerContent: {
    name: 'NDrawerContent',
    template: '<div><slot /></div>',
  },
  NSpin: {
    name: 'NSpin',
    template: '<div><slot /></div>',
  },
  useMessage: () => ({
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}))

import MessageItem from '@/components/hermes/chat/MessageItem.vue'
import { useSettingsStore } from '@/stores/hermes/settings'
import type { Message } from '@/stores/hermes/chat'

describe('MessageItem tool details', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        getVoices: vi.fn(() => []),
        speak: vi.fn(),
        cancel: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
      },
    })
  })

  it('renders highlighted code blocks for tool arguments and tool results', async () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'tool-1',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'web_search',
          toolArgs: '{"query":"syntax highlighting"}',
          toolResult: '{"results":[{"title":"Done"}]}',
          toolStatus: 'done',
        } satisfies Message,
      },
    })

    await wrapper.find('.tool-line').trigger('click')

    const blocks = wrapper.findAll('.tool-details .hljs-code-block')
    expect(blocks).toHaveLength(2)
    expect(blocks[0].find('.code-lang').text()).toBe('json')
    expect(blocks[1].find('.code-lang').text()).toBe('json')
  })

  it('renders inline diffs as a separate tool detail section', async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText)
    const inlineDiff = '--- a/src/file.ts\n+++ b/src/file.ts\n@@\n-old value\n+new value'
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'tool-diff',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'patch',
          toolInlineDiff: inlineDiff,
          toolStatus: 'done',
        } satisfies Message,
      },
    })

    await wrapper.find('.tool-line').trigger('click')

    const diffSection = wrapper.find('[data-copy-source="tool-inline-diff"]')
    expect(diffSection.find('.tool-detail-label').text()).toBe('chat.inlineDiff')
    expect(diffSection.find('.code-lang').text()).toBe('diff')
    expect(diffSection.find('code.hljs').text()).toContain('-old value')
    expect(diffSection.find('code.hljs').text()).toContain('+new value')
    expect(diffSection.find('.diff-delete').text()).toBe('-old value')
    expect(diffSection.find('.diff-add').text()).toBe('+new value')
    expect(diffSection.find('.diff-file').text()).toBe('--- a/src/file.ts')
    expect(diffSection.find('.diff-hunk').text()).toBe('@@')

    await diffSection.find('[data-copy-code="true"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith(inlineDiff)
  })

  it('truncates large inline diffs for display but copies the full diff', async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText)
    const inlineDiff = Array.from({ length: 1200 }, (_, index) =>
      index % 2 === 0 ? `-old value ${index}` : `+new value ${index}`,
    ).join('\n')
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'tool-large-diff',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'patch',
          toolInlineDiff: inlineDiff,
          toolStatus: 'done',
        } satisfies Message,
      },
    })

    await wrapper.find('.tool-line').trigger('click')

    const diffSection = wrapper.find('[data-copy-source="tool-inline-diff"]')
    expect(diffSection.text()).toContain('chat.truncated')
    expect(diffSection.findAll('.diff-line').length).toBeLessThan(220)

    await diffSection.find('[data-copy-code="true"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith(inlineDiff)
  })

  it('renders modernized assistant and tool chrome for the content area', async () => {
    const assistantWrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'assistant-1',
          role: 'assistant',
          content: 'hello world',
          timestamp: Date.now(),
        } satisfies Message,
      },
    })

    expect(assistantWrapper.find('.message-bubble-header').exists()).toBe(true)
    expect(assistantWrapper.find('.message-bubble-surface').exists()).toBe(true)

    const toolWrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'tool-modern',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'terminal',
          toolResult: '{"ok":true}',
          toolStatus: 'done',
        } satisfies Message,
      },
    })

    expect(toolWrapper.find('.tool-card').exists()).toBe(true)
    await toolWrapper.find('.tool-line').trigger('click')
    expect(toolWrapper.find('.tool-status-badge').exists()).toBe(true)
  })

  it('renders assistant meta with the copy action before the timestamp', () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'assistant-copy-meta',
          role: 'assistant',
          content: 'copyable content',
          timestamp: Date.now(),
        } satisfies Message,
      },
    })

    const meta = wrapper.find('.message-meta-hover')
    const copyButton = meta.find('.copy-bubble-btn').element
    const timestamp = meta.find('.message-time').element
    expect(meta.exists()).toBe(true)
    expect(meta.find('.copy-bubble-btn').exists()).toBe(true)
    expect(meta.find('.message-time').exists()).toBe(true)
    expect(copyButton.compareDocumentPosition(timestamp) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps user meta with the timestamp before the copy action', () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'user-copy-meta',
          role: 'user',
          content: 'copyable prompt',
          timestamp: Date.now(),
        } satisfies Message,
      },
    })

    const meta = wrapper.find('.message-meta-hover')
    const timestamp = meta.find('.message-time').element
    const copyButton = meta.find('.copy-bubble-btn').element
    expect(meta.exists()).toBe(true)
    expect(timestamp.compareDocumentPosition(copyButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('does not render a thinking block when reasoning duplicates assistant content', () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'assistant-duplicate-reasoning',
          role: 'assistant',
          content: '我再把这次踩到的坑补进 release-notes-monitor 技能。',
          reasoning: '我再把这次踩到的坑补进 release-notes-monitor 技能。',
          timestamp: Date.now(),
        } satisfies Message,
      },
    })

    expect(wrapper.find('.thinking-block').exists()).toBe(false)
    expect(wrapper.find('.msg-content').text()).toContain('release-notes-monitor')
  })

  it('does not render a thinking block when reasoning is a near-duplicate answer preview', () => {
    const content = '修复会放在前端 hydration/live merge 边界：当 assistant reasoning 与最终正文高度相同，就丢弃 bogus reasoning，只保留正文显示。'
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'assistant-near-duplicate-reasoning',
          role: 'assistant',
          content,
          reasoning: '修复放在前端 hydration live merge 边界，当 assistant 的 reasoning 和最终正文高度相同，会丢弃 bogus reasoning 并只保留正文。',
          timestamp: Date.now(),
        } satisfies Message,
      },
    })

    expect(wrapper.find('.thinking-block').exists()).toBe(false)
    expect(wrapper.find('.msg-content').text()).toContain('hydration/live merge')
  })

  it('still renders distinct assistant reasoning that is not an answer preview', async () => {
    useSettingsStore().display.show_reasoning = true
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'assistant-distinct-reasoning',
          role: 'assistant',
          content: '最终结论：只清洗 bogus reasoning，不隐藏真实思考过程。',
          reasoning: '先比较缓存与服务端快照的消息字段，再确认 merge 边界是否会把旧 reasoning 继续带入。',
          timestamp: Date.now(),
        } satisfies Message,
      },
    })

    expect(wrapper.find('.thinking-block').exists()).toBe(true)
    expect(wrapper.find('.thinking-body').text()).toContain('缓存与服务端快照')
  })

  it('expands preview-only tool messages', async () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'tool-preview-only',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'terminal',
          toolPreview: 'terminal npm run build',
          toolStatus: 'done',
        } satisfies Message,
      },
    })

    await wrapper.find('.tool-line').trigger('click')

    expect(wrapper.find('.tool-details').exists()).toBe(true)
    expect(wrapper.find('.tool-detail-label').text()).toBe('files.preview')
    expect(wrapper.find('.tool-details code.hljs').text()).toContain('terminal npm run build')
  })

  it('hides provider placeholder reasoning and empty placeholder bubbles while still showing real reasoning', async () => {
    const placeholderReasoningWrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'assistant-placeholder-reasoning',
          role: 'assistant',
          content: '',
          reasoning: 'ಠ╭╮ಠ musing...',
          timestamp: Date.now(),
        } satisfies Message,
      },
    })

    expect(placeholderReasoningWrapper.find('.thinking-block').exists()).toBe(false)
    expect(placeholderReasoningWrapper.find('.message-bubble').exists()).toBe(false)

    const placeholderContentWrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'assistant-placeholder-content',
          role: 'assistant',
          content: '<think>ಠ╭╮ಠ musing...</think>',
          timestamp: Date.now(),
        } satisfies Message,
      },
    })

    expect(placeholderContentWrapper.find('.thinking-block').exists()).toBe(false)
    expect(placeholderContentWrapper.find('.message-bubble').exists()).toBe(false)

    const realReasoningWrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'assistant-real-reasoning',
          role: 'assistant',
          content: 'Final answer',
          reasoning: 'I need to compare the two release timestamps before summarizing.',
          timestamp: Date.now(),
        } satisfies Message,
      },
    })

    expect(realReasoningWrapper.find('.thinking-block').exists()).toBe(true)
    await realReasoningWrapper.find('.thinking-header').trigger('click')
    expect(realReasoningWrapper.find('.thinking-body').text()).toContain('I need to compare')
  })

  it('marks outbound user messages so they can be right-aligned and use palette option 5', () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'user-1',
          role: 'user',
          content: 'please align me right',
          timestamp: Date.now(),
        } satisfies Message,
      },
    })

    expect(wrapper.find('.msg-body--outbound').exists()).toBe(true)
    expect(wrapper.find('.msg-content--outbound').exists()).toBe(true)
    expect(wrapper.find('.message-bubble--user').exists()).toBe(true)
    expect(wrapper.find('.message-bubble--user-palette-5').exists()).toBe(true)
  })

  it('keeps streaming assistant plain-text output in a wrapping pre block instead of clipping it', () => {
    const content = '第一行很长很长很长很长很长很长很长很长很长很长\n第二行继续输出'
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'assistant-streaming-plain',
          role: 'assistant',
          content,
          isStreaming: true,
          timestamp: Date.now(),
        } satisfies Message,
      },
    })

    const block = wrapper.find('.message-stream-text')
    expect(block.exists()).toBe(true)
    expect(block.text()).toBe(content)
    expect(block.classes()).toContain('with-streaming-cursor')
    expect(block.attributes('class')).toContain('message-stream-text')
  })

  it('copies tool detail code through the delegated click handler', async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText)
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'tool-copy',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'web_search',
          toolArgs: '{"query":"syntax highlighting"}',
          toolStatus: 'done',
        } satisfies Message,
      },
    })

    await wrapper.find('.tool-line').trigger('click')

    const expected = wrapper.find('.tool-details code.hljs').text()
    await wrapper.find('.tool-details [data-copy-code="true"]').trigger('click')

    expect(writeText).toHaveBeenCalledWith(expected)
  })

  it('truncates large tool arguments for display but copies the full formatted payload', async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText)
    const message = {
      content: 'x'.repeat(4000),
      ok: true,
    }
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'tool-args-large',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'write_file',
          toolArgs: JSON.stringify(message),
          toolStatus: 'done',
        } satisfies Message,
      },
    })

    await wrapper.find('.tool-line').trigger('click')

    const expected = JSON.stringify(message, null, 2)
    const code = wrapper.find('.tool-details code.hljs')
    expect(wrapper.find('.tool-details .code-lang').text()).toBe('json')
    expect(wrapper.html()).toContain('chat.truncated')
    expect(code.findAll('span')).toHaveLength(0)

    await wrapper.find('.tool-details [data-copy-code="true"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith(expected)
  })

  it('copies the full large JSON tool result even when the display is truncated', async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText)
    const fullResult = {
      content: 'x'.repeat(4000),
      ok: true,
    }
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'tool-2',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'read_file',
          toolResult: JSON.stringify(fullResult),
          toolStatus: 'done',
        } satisfies Message,
      },
    })

    await wrapper.find('.tool-line').trigger('click')

    expect(wrapper.find('.tool-details .code-lang').text()).toBe('json')
    expect(wrapper.html()).toContain('chat.truncated')
    expect(wrapper.find('.tool-details code.hljs').findAll('span')).toHaveLength(0)

    await wrapper.find('.tool-details [data-copy-code="true"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(fullResult, null, 2))
  })

  it('copies the full large raw tool result even when the display is truncated', async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText)
    const fullResult = 'line\n'.repeat(1200)
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'tool-raw',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'read_file',
          toolResult: fullResult,
          toolStatus: 'done',
        } satisfies Message,
      },
    })

    await wrapper.find('.tool-line').trigger('click')

    expect(wrapper.find('.tool-details .code-lang').text()).toBe('text')
    expect(wrapper.html()).toContain('chat.truncated')
    expect(wrapper.find('.tool-details code.hljs').findAll('span')).toHaveLength(0)

    await wrapper.find('.tool-details [data-copy-code="true"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith(fullResult)
  })
})
