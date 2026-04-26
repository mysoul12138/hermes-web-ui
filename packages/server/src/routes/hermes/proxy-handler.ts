import type { Context } from 'koa'
import { config } from '../../config'
import { getGatewayManagerInstance } from '../../services/gateway-bootstrap'
import { updateUsage } from '../../db/hermes/usage-store'
import { tuiBridge } from '../../services/hermes/tui-bridge'
import {
  clearLivePendingApprovalForRun,
  getSessionForRun,
  setLivePendingApprovalForRun,
  setRunSession,
} from '../../services/hermes/run-state'

export { setRunSession } from '../../services/hermes/run-state'

function getGatewayManager() { return getGatewayManagerInstance() }

// --- Helpers ---

function isTransientGatewayError(err: any): boolean {
  const msg = String(err?.message || '')
  const causeCode = String(err?.cause?.code || '')
  return (
    causeCode === 'ECONNREFUSED' ||
    causeCode === 'ECONNRESET' ||
    /ECONNREFUSED|ECONNRESET|fetch failed|socket hang up/i.test(msg)
  )
}

async function waitForGatewayReady(upstream: string, timeoutMs: number = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const healthUrl = `${upstream}/health`
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(1200),
      })
      if (res.ok) return true
    } catch { }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return false
}

/** Resolve profile name from request */
function resolveProfile(ctx: Context): string {
  return ctx.get('x-hermes-profile') || (ctx.query.profile as string) || 'default'
}

/** Resolve upstream URL for a request based on profile header/query */
function resolveUpstream(ctx: Context): string {
  const mgr = getGatewayManager()
  if (mgr) {
    const profile = resolveProfile(ctx)
    if (profile && profile !== 'default') {
      return mgr.getUpstream(profile)
    }
    return mgr.getUpstream()
  }
  return config.upstream.replace(/\/$/, '')
}

function buildProxyHeaders(ctx: Context, upstream: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(ctx.headers)) {
    if (value == null) continue
    const lower = key.toLowerCase()
    if (lower === 'host') {
      headers['host'] = new URL(upstream).host
    } else if (lower === 'origin' || lower === 'referer' || lower === 'connection' || lower === 'authorization') {
      continue
    } else {
      const v = Array.isArray(value) ? value[0] : value
      if (v) headers[key] = v
    }
  }

  const mgr = getGatewayManager()
  if (mgr) {
    const apiKey = mgr.getApiKey(resolveProfile(ctx))
    if (apiKey) {
      headers['authorization'] = `Bearer ${apiKey}`
    }
  }

  return headers
}

// --- SSE stream interception ---

const SSE_EVENTS_PATH = /^\/v1\/runs\/([^/]+)\/events$/
const RUN_CANCEL_PATH = /^\/v1\/runs\/([^/]+)\/cancel$/
const SESSION_STEER_PATH = /^\/v1\/sessions\/([^/]+)\/steer$/

function isUnsupportedBridgeSteerError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /unknown method:\s*session\.steer|unknown method:\s*command\.dispatch|unknown method:\s*slash\.exec|does not support \/steer|true mid-run steer is not available|agent does not support steer|not a quick\/plugin\/skill command/i.test(message)
}

/**
 * Parse SSE text chunks and extract approval / completion lifecycle events.
 */
function processRunEventChunk(chunk: string, streamRunId?: string): void {
  const lines = chunk.split('\n')
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue
    try {
      const data = JSON.parse(line.slice(6))
      const eventRunId = typeof data?.run_id === 'string' && data.run_id
        ? data.run_id
        : streamRunId
      if (!eventRunId) continue

      if (streamRunId && eventRunId !== streamRunId && !getSessionForRun(eventRunId)) {
        const streamSessionId = getSessionForRun(streamRunId)
        if (streamSessionId) setRunSession(eventRunId, streamSessionId)
      }

      if (data.event === 'approval') {
        setLivePendingApprovalForRun(eventRunId, {
          approval_id: typeof data.approval_id === 'string' ? data.approval_id : undefined,
          description: typeof data.description === 'string' ? data.description : undefined,
          command: typeof data.command === 'string' ? data.command : undefined,
          pattern_key: typeof data.pattern_key === 'string' ? data.pattern_key : undefined,
          pattern_keys: Array.isArray(data.pattern_keys) ? data.pattern_keys.filter((item: unknown): item is string => typeof item === 'string') : undefined,
          pending_count: typeof data.pending_count === 'number' ? data.pending_count : undefined,
        })
        continue
      }

      if (data.event === 'run.completed' && data.usage) {
        const sessionId = getSessionForRun(eventRunId)
        if (sessionId) {
          updateUsage(sessionId, data.usage.input_tokens, data.usage.output_tokens)
        }
        clearLivePendingApprovalForRun(eventRunId)
        continue
      }

      if (data.event === 'run.failed') {
        clearLivePendingApprovalForRun(eventRunId)
      }
    } catch { /* not JSON, skip */ }
  }
}

/**
 * Stream an SSE response while intercepting run.completed events.
 */
async function streamSSE(ctx: Context, res: Response, streamRunId?: string): Promise<void> {
  if (!res.body) {
    ctx.res.end()
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      // Forward raw bytes to client immediately
      ctx.res.write(value)

      // Also decode for interception
      buffer += decoder.decode(value, { stream: true })

      // Process complete SSE lines (delimited by double newline)
      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n\n')) !== -1) {
        const eventBlock = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 2)
        processRunEventChunk(eventBlock, streamRunId)
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      processRunEventChunk(buffer, streamRunId)
    }
  } finally {
    ctx.res.end()
  }
}

// --- Main proxy function ---

export async function proxy(ctx: Context) {
  const profile = resolveProfile(ctx)
  const upstream = resolveUpstream(ctx)
  const upstreamPath = ctx.path.replace(/^\/api\/hermes\/v1/, '/v1').replace(/^\/api\/hermes/, '/api')
  const params = new URLSearchParams(ctx.search || '')
  params.delete('token')
  const search = params.toString()
  const url = `${upstream}${upstreamPath}${search ? `?${search}` : ''}`

  const headers = buildProxyHeaders(ctx, upstream)

  try {
    let body: string | undefined
    if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') {
      // @koa/bodyparser parses JSON into ctx.request.body but doesn't store rawBody
      // by default. Re-serialize the parsed body to get the string form.
      const parsed = (ctx as any).request.body
      if (typeof parsed === 'string') {
        body = parsed
      } else if (parsed && typeof parsed === 'object') {
        body = JSON.stringify(parsed)
      }
    }

    if (tuiBridge.isEnabled() && ctx.req.method === 'POST' && /\/v1\/runs$/.test(upstreamPath) && body) {
      try {
        const parsed = JSON.parse(body)
        const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : ''
        const input = typeof parsed.input === 'string'
          ? parsed.input
          : Array.isArray(parsed.input)
            ? String(parsed.input.at(-1)?.content || '')
            : ''
        if (sessionId && input) {
          const run = await tuiBridge.startRun(input, sessionId, Array.isArray(parsed.conversation_history) ? parsed.conversation_history : [])
          ctx.status = 200
          ctx.set('Content-Type', 'application/json')
          ctx.body = run
          return
        }
      } catch (err) {
        ctx.status = 502
        ctx.body = { error: { message: `Bridge error: ${err instanceof Error ? err.message : String(err)}` } }
        return
      }
    }

    const bridgeSteerMatch = upstreamPath.match(SESSION_STEER_PATH)
    if (tuiBridge.isEnabled() && ctx.req.method === 'POST' && bridgeSteerMatch && body) {
      try {
        const parsed = JSON.parse(body)
        const text = typeof parsed.text === 'string' ? parsed.text : ''
        const result = await tuiBridge.steer(bridgeSteerMatch[1], text)
        ctx.status = 200
        ctx.set('Content-Type', 'application/json')
        ctx.body = result
        return
      } catch (err) {
        if (isUnsupportedBridgeSteerError(err)) {
          ctx.status = 200
          ctx.set('Content-Type', 'application/json')
          ctx.body = {
            ok: false,
            status: 'unsupported',
            bridge: true,
            error: 'Current Hermes TUI bridge does not support session.steer',
          }
          return
        }
        ctx.status = 502
        ctx.body = { error: { message: `Bridge steer error: ${err instanceof Error ? err.message : String(err)}` } }
        return
      }
    }

    const bridgeCancelMatch = upstreamPath.match(RUN_CANCEL_PATH)
    if (tuiBridge.isEnabled() && ctx.req.method === 'POST' && bridgeCancelMatch) {
      try {
        const result = await tuiBridge.cancelRun(bridgeCancelMatch[1])
        if (result) {
          ctx.status = 200
          ctx.set('Content-Type', 'application/json')
          ctx.body = result
          return
        }
      } catch (err) {
        ctx.status = 502
        ctx.body = { error: { message: `Bridge cancel error: ${err instanceof Error ? err.message : String(err)}` } }
        return
      }
    }

    const bridgeSseMatch = upstreamPath.match(SSE_EVENTS_PATH)
    if (tuiBridge.isEnabled() && ctx.req.method === 'GET' && bridgeSseMatch) {
      try {
        ctx.status = 200
        ctx.set('Content-Type', 'text/event-stream')
        ctx.set('Cache-Control', 'no-cache')
        ctx.set('X-Accel-Buffering', 'no')
        for await (const event of tuiBridge.stream(bridgeSseMatch[1])) {
          ctx.res.write(`data: ${JSON.stringify(event)}\n\n`)
        }
        ctx.res.end()
        return
      } catch {
        // Non-bridge run id; use the upstream SSE stream below.
      }
    }

    const requestInit: RequestInit = { method: ctx.req.method, headers, body }

    let res: Response
    try {
      res = await fetch(url, requestInit)
    } catch (err: any) {
      if (isTransientGatewayError(err) && await waitForGatewayReady(upstream)) {
        res = await fetch(url, requestInit)
      } else {
        throw err
      }
    }

    // Set response headers
    res.headers.forEach((value, key) => {
      const lower = key.toLowerCase()
      if (lower !== 'transfer-encoding' && lower !== 'connection') {
        ctx.set(key, value)
      }
    })
    ctx.status = res.status

    // Intercept POST /v1/runs to capture run_id → session_id mapping
    if (ctx.req.method === 'POST' && /\/v1\/runs$/.test(upstreamPath) && body) {
      try {
        const parsed = JSON.parse(body)
        if (parsed.session_id) {
          const resBody = await res.text()
          ctx.res.write(resBody)
          ctx.res.end()

          try {
            const result = JSON.parse(resBody)
            const runId = typeof result.run_id === 'string' && result.run_id
              ? result.run_id
              : typeof result.id === 'string' && result.id
                ? result.id
                : undefined
            if (runId) {
              setRunSession(runId, parsed.session_id)
            }
          } catch { /* response not JSON, ignore */ }
          return
        }
      } catch { /* body not JSON, fall through to normal stream */ }
      // No session_id in body — fall through to normal response handling below
    }

    // Intercept SSE streams for /v1/runs/{id}/events
    const sseMatch = upstreamPath.match(SSE_EVENTS_PATH)
    if (sseMatch) {
      await streamSSE(ctx, res, sseMatch[1])
      return
    }

    // Default: pipe response body directly
    if (res.body) {
      const reader = res.body.getReader()
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          ctx.res.write(value)
        }
        ctx.res.end()
      }
      await pump()
    } else {
      ctx.res.end()
    }
  } catch (err: any) {
    if (!ctx.res.headersSent) {
      ctx.status = 502
      ctx.set('Content-Type', 'application/json')
      ctx.body = { error: { message: `Proxy error: ${err.message}` } }
    } else {
      ctx.res.end()
    }
  }
}
