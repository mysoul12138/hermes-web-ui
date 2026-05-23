import { getRuntimeStatusSnapshot } from '../../services/hermes/runtime-status'

export async function status(ctx: any) {
  ctx.body = getRuntimeStatusSnapshot()
}
