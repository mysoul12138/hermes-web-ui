import { beforeEach, describe, expect, it, vi } from 'vitest'

const getPendingClarifyMock = vi.fn()
const respondClarifyMock = vi.fn()

vi.mock('../../packages/server/src/services/hermes/clarify', () => ({
  getPendingClarify: getPendingClarifyMock,
  respondClarify: respondClarifyMock,
}))

describe('clarify routes', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('registers clarify routes', async () => {
    const { clarifyRoutes } = await import('../../packages/server/src/routes/hermes/clarify')
    const paths = clarifyRoutes.stack.map((entry: any) => entry.path)

    expect(paths).toEqual(expect.arrayContaining([
      '/api/hermes/clarify/pending',
      '/api/hermes/clarify/respond',
    ]))
  })

  it('delegates pending requests to the clarify service', async () => {
    getPendingClarifyMock.mockReturnValue({
      pending: { request_id: 'clarify-1', question: 'Choose?', choices: ['a', 'b'] },
      pending_count: 1,
    })

    const ctrl = await import('../../packages/server/src/controllers/hermes/clarify')
    const ctx: any = { query: { session_id: 'sess-1' }, body: null }

    await ctrl.pending(ctx)

    expect(getPendingClarifyMock).toHaveBeenCalledWith('sess-1')
    expect(ctx.body).toEqual({
      pending: { request_id: 'clarify-1', question: 'Choose?', choices: ['a', 'b'] },
      pending_count: 1,
    })
  })

  it('delegates respond requests to the clarify service', async () => {
    respondClarifyMock.mockResolvedValue({ ok: true, bridge: true })

    const ctrl = await import('../../packages/server/src/controllers/hermes/clarify')
    const ctx: any = {
      request: { body: { session_id: 'sess-1', request_id: 'clarify-1', answer: 'b' } },
      body: null,
    }

    await ctrl.respond(ctx)

    expect(respondClarifyMock).toHaveBeenCalledWith('sess-1', 'clarify-1', 'b')
    expect(ctx.body).toEqual({ ok: true, answer: 'b', status: undefined, bridge: true })
  })

  it('proxy middleware leaves local clarify routes alone', async () => {
    const { proxyMiddleware } = await import('../../packages/server/src/routes/hermes/proxy')
    const next = vi.fn()

    await proxyMiddleware({ path: '/api/hermes/clarify/pending' } as any, next)

    expect(next).toHaveBeenCalledOnce()
  })
})
