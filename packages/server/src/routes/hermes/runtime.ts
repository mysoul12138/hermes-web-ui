import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/runtime'

export const runtimeRoutes = new Router()

runtimeRoutes.get('/api/hermes/runtime/status', ctrl.status)
