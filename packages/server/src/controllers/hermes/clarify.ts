import * as clarifyService from '../../services/hermes/clarify'

export async function pending(ctx: any) {
  const sessionId = typeof ctx.query.session_id === 'string' ? ctx.query.session_id.trim() : ''
  if (!sessionId) {
    ctx.status = 400
    ctx.body = { error: 'Missing session_id' }
    return
  }

  ctx.body = clarifyService.getPendingClarify(sessionId)
}

export async function respond(ctx: any) {
  const { session_id, request_id, answer } = ctx.request.body as { session_id?: string; request_id?: string; answer?: string }
  if (!session_id || typeof session_id !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'Missing session_id' }
    return
  }
  if (!request_id || typeof request_id !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'Missing request_id' }
    return
  }
  if (typeof answer !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'Missing answer' }
    return
  }

  const result = await clarifyService.respondClarify(session_id, request_id, answer)
  ctx.body = {
    ok: true,
    answer,
    status: (result as any)?.status,
    bridge: (result as any)?.bridge,
  }
}
