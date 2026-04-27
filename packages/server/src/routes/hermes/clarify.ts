import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/clarify'

export const clarifyRoutes = new Router()

clarifyRoutes.get('/api/hermes/clarify/pending', ctrl.pending)
clarifyRoutes.post('/api/hermes/clarify/respond', ctrl.respond)
