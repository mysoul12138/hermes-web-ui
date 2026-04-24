import { beforeEach, describe, expect, it, vi } from 'vitest'

const getPendingApprovalMock = vi.fn()
const respondApprovalMock = vi.fn()

vi.mock('../../packages/server/src/services/hermes/approval', () => ({
  getPendingApproval: getPendingApprovalMock,
  respondApproval: respondApprovalMock,
}))

describe('approval routes', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('registers approval routes', async () => {
    const { approvalRoutes } = await import('../../packages/server/src/routes/hermes/approval')
    const paths = approvalRoutes.stack.map((entry: any) => entry.path)

    expect(paths).toEqual(expect.arrayContaining([
      '/api/hermes/approval/pending',
      '/api/hermes/approval/respond',
    ]))
  })

  it('delegates pending requests to the approval service', async () => {
    getPendingApprovalMock.mockResolvedValue({
      pending: { description: 'Need permission', command: 'rm -rf /tmp/demo' },
      pending_count: 1,
    })

    const ctrl = await import('../../packages/server/src/controllers/hermes/approval')
    const ctx: any = { query: { session_id: 'sess-1' }, body: null }

    await ctrl.pending(ctx)

    expect(getPendingApprovalMock).toHaveBeenCalledWith('sess-1')
    expect(ctx.body).toEqual({
      pending: { description: 'Need permission', command: 'rm -rf /tmp/demo' },
      pending_count: 1,
    })
  })

  it('rejects missing session_id for pending requests', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/approval')
    const ctx: any = { query: {}, body: null, status: 200 }

    await ctrl.pending(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Missing session_id' })
  })

  it('delegates respond requests to the approval service', async () => {
    respondApprovalMock.mockResolvedValue({ run_id: 'run-1', status: 'queued' })

    const ctrl = await import('../../packages/server/src/controllers/hermes/approval')
    const ctx: any = {
      request: { body: { session_id: 'sess-1', choice: 'session' } },
      headers: { authorization: 'Bearer secret-token' },
      get(name: string) {
        return this.headers[name]
      },
      body: null,
    }

    await ctrl.respond(ctx)

    expect(respondApprovalMock).toHaveBeenCalledWith('sess-1', 'session', 'secret-token')
    expect(ctx.body).toEqual({ ok: true, choice: 'session', run_id: 'run-1', status: 'queued' })
  })

  it('proxy middleware leaves local approval routes alone', async () => {
    const { proxyMiddleware } = await import('../../packages/server/src/routes/hermes/proxy')
    const next = vi.fn()

    await proxyMiddleware({ path: '/api/hermes/approval/pending' } as any, next)

    expect(next).toHaveBeenCalledOnce()
  })
})