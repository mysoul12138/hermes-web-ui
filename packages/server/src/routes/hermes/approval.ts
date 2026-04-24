import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/approval'

export const approvalRoutes = new Router()

approvalRoutes.get('/api/hermes/approval/pending', ctrl.pending)
approvalRoutes.post('/api/hermes/approval/respond', ctrl.respond)