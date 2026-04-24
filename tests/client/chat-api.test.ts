// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

class MockEventSource {
  static instances: MockEventSource[] = []

  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event?: Event) => void) | null = null
  listeners = new Map<string, Array<(event: MessageEvent) => void>>()
  close = vi.fn()

  constructor(public url: string) {
    MockEventSource.instances.push(this)
  }

  addEventListener(type: string, handler: (event: MessageEvent) => void) {
    const list = this.listeners.get(type) || []
    list.push(handler)
    this.listeners.set(type, list)
  }

  emit(type: string, data: string) {
    const event = { data } as MessageEvent
    if (type === 'message') {
      this.onmessage?.(event)
      return
    }
    for (const handler of this.listeners.get(type) || []) {
      handler(event)
    }
  }
}

vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource)

import { streamRunEvents } from '@/api/hermes/chat'

describe('Hermes chat API SSE client', () => {
  beforeEach(() => {
    MockEventSource.instances = []
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('forwards named approval SSE events without closing the stream', () => {
    const onEvent = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    streamRunEvents('run-1', onEvent, onDone, onError)

    const source = MockEventSource.instances[0]
    source.emit('approval', JSON.stringify({ approval_id: 'appr-1', description: 'Need approval' }))

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'approval',
      approval_id: 'appr-1',
      description: 'Need approval',
    }))
    expect(onDone).not.toHaveBeenCalled()
    expect(source.close).not.toHaveBeenCalled()
  })

  it('also forwards approval events sent on the default message channel', () => {
    const onEvent = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    streamRunEvents('run-1', onEvent, onDone, onError)

    const source = MockEventSource.instances[0]
    source.emit('message', JSON.stringify({
      event: 'approval',
      approval_id: 'appr-inline-1',
      description: 'Inline approval event',
    }))

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'approval',
      approval_id: 'appr-inline-1',
      description: 'Inline approval event',
    }))
    expect(onDone).not.toHaveBeenCalled()
    expect(source.close).not.toHaveBeenCalled()
  })

  it('closes the stream only when run.completed arrives on the default channel', () => {
    const onEvent = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    streamRunEvents('run-1', onEvent, onDone, onError)

    const source = MockEventSource.instances[0]
    source.emit('approval', JSON.stringify({ approval_id: 'appr-1' }))
    expect(onDone).not.toHaveBeenCalled()

    source.emit('message', JSON.stringify({ event: 'run.completed' }))

    expect(onDone).toHaveBeenCalledTimes(1)
    expect(source.close).toHaveBeenCalledTimes(1)
  })
})
