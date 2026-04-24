// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockClient = vi.hoisted(() => ({
  request: vi.fn(),
}))

vi.mock('@/api/client', () => mockClient)

import { respondApproval } from '@/api/hermes/approval'

describe('Hermes approval API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClient.request.mockResolvedValue({ ok: true, choice: 'once' })
  })

  it.each([
    ['once'],
    ['session'],
    ['always'],
    ['deny'],
  ] as const)('posts %s to the local approval endpoint', async (choice) => {
    const result = await respondApproval({
      session_id: 'sess-1',
      choice,
      approval_id: 'approval-1',
    })

    expect(mockClient.request).toHaveBeenCalledWith('/api/hermes/approval/respond', {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'sess-1',
        choice,
        approval_id: 'approval-1',
      }),
    })
    expect(result).toEqual({ ok: true, choice: 'once' })
  })
})
