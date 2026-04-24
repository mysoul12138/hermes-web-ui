import * as approvalService from '../../services/hermes/approval'

function getBearerToken(ctx: any): string | undefined {
  const raw = typeof ctx.get === 'function' ? ctx.get('authorization') : ctx.headers?.authorization
  if (typeof raw !== 'string') return undefined
  const match = raw.match(/^Bearer\s+(.+)$/i)
  return match?.[1]
}

export async function pending(ctx: any) {
  const sessionId = typeof ctx.query.session_id === 'string' ? ctx.query.session_id.trim() : ''
  if (!sessionId) {
    ctx.status = 400
    ctx.body = { error: 'Missing session_id' }
    return
  }

  ctx.body = await approvalService.getPendingApproval(sessionId)
}

export async function respond(ctx: any) {
  const { session_id, choice } = ctx.request.body as { session_id?: string; choice?: approvalService.ApprovalChoice }
  if (!session_id || typeof session_id !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'Missing session_id' }
    return
  }
  if (!choice || !['once', 'session', 'always', 'deny'].includes(choice)) {
    ctx.status = 400
    ctx.body = { error: 'Invalid choice' }
    return
  }

  const run = await approvalService.respondApproval(session_id, choice, getBearerToken(ctx))
  ctx.body = {
    ok: true,
    choice,
    run_id: (run as any)?.run_id,
    status: (run as any)?.status,
    bridge: (run as any)?.bridge,
  }
}
