import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { delimiter, resolve } from 'path'
import { createInterface } from 'readline'
import YAML from 'js-yaml'
import {
  clearLivePendingApproval,
  clearLivePendingApprovalForRun,
  clearLivePendingClarify,
  clearLivePendingClarifyForRun,
  setLivePendingApprovalForRun,
  setLivePendingClarifyForRun,
  setRunSession,
} from './run-state'
import { getActiveConfigPath } from './hermes-profile'
import { updateUsage } from '../../db/hermes/usage-store'
import { countTokens } from '../../lib/context-compressor'

export interface BridgeRunEvent {
  event: string
  run_id: string
  timestamp?: number
  delta?: string
  output?: string
  error?: string
  tool?: string
  preview?: string
  arguments?: unknown
  args?: unknown
  input?: unknown
  context?: unknown
  result?: unknown
  stdout?: unknown
  stderr?: unknown
  output_tail?: Array<Record<string, unknown>>
  files_read?: string[]
  files_written?: string[]
  exit_code?: unknown
  returncode?: unknown
  exit_status?: unknown
  exitCode?: unknown
  duration?: number
  duration_s?: number
  duration_ms?: number
  approval_id?: string
  description?: string
  command?: string
  pattern_key?: string
  pattern_keys?: string[]
  pending_count?: number
  request_id?: string
  question?: string
  choices?: string[]
  subagent_id?: string
  parent_id?: string
  depth?: number
  goal?: string
  status?: string
  summary?: string
  text?: string
  content?: string
  reasoning?: string
  thinking?: string
  message?: string
  task_count?: number
  task_index?: number
  model?: string
  tool_name?: string
  tool_preview?: string
  input_tokens?: number
  output_tokens?: number
  reasoning_tokens?: number
  api_calls?: number
  cost_usd?: number
  duration_seconds?: number
  message_count?: number
  token_count?: number
  compressed?: boolean
  llmCompressed?: boolean
  totalMessages?: number
  resultMessages?: number
  beforeTokens?: number
  afterTokens?: number
  summaryTokens?: number
  verbatimCount?: number
  compressedStartIndex?: number
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
    reasoning_tokens?: number
    cache_read_tokens?: number
    cache_write_tokens?: number
    source?: string
  }
  usage_source?: string
}

interface PendingRpc {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface RunState {
  runId: string
  webSessionId: string
  bridgeSessionId: string
  events: BridgeRunEvent[]
  waiters: Array<(event: BridgeRunEvent | null) => void>
  closed: boolean
  idleTimer?: ReturnType<typeof setTimeout>
  completeTimer?: ReturnType<typeof setTimeout>
  pendingApproval?: boolean
  pendingClarify?: boolean
  contextInputTokens?: number
}

interface BridgeSessionRef {
  id: string
  created: boolean
  persistentSessionId?: string
}

interface TuiSessionListItem {
  id?: string
  source?: string
  started_at?: number
}

interface PendingPersistentResolution {
  before: Set<string>
  deadlineAt: number
}

const STARTUP_TIMEOUT_MS = Math.max(5000, Number(process.env.HERMES_TUI_STARTUP_TIMEOUT_MS || 15000))
const REQUEST_TIMEOUT_MS = Math.max(30000, Number(process.env.HERMES_TUI_RPC_TIMEOUT_MS || 120000))
const IDLE_HEARTBEAT_MS = Math.max(5000, Number(process.env.HERMES_TUI_IDLE_HEARTBEAT_MS || process.env.HERMES_TUI_IDLE_COMPLETE_MS || 15000))
const COMPLETE_GRACE_MS = Math.max(250, Number(process.env.HERMES_TUI_COMPLETE_GRACE_MS || 1500))

function resolveHermesHome(): string {
  return process.env.HERMES_HOME?.trim() || resolve(homedir(), '.hermes')
}

const DEFAULT_BRIDGE_PYTHON = resolve(resolveHermesHome(), 'webui-bridge-venv/bin/python')
if (!process.env.HERMES_PYTHON && existsSync(DEFAULT_BRIDGE_PYTHON)) {
  process.env.HERMES_PYTHON = DEFAULT_BRIDGE_PYTHON
}

function resolvePython(root: string): string {
  const configured = process.env.HERMES_PYTHON?.trim() || process.env.PYTHON?.trim()
  const venv = process.env.VIRTUAL_ENV?.trim()
  const hermesHome = resolveHermesHome()
  const hit = [
    venv && resolve(venv, 'bin/python'),
    venv && resolve(venv, 'Scripts/python.exe'),
    resolve(hermesHome, 'webui-bridge-venv/bin/python'),
    resolve(hermesHome, 'webui-bridge-venv/bin/python3'),
    resolve(root, '.venv/bin/python'),
    resolve(root, '.venv/bin/python3'),
    resolve(root, 'venv/bin/python'),
    resolve(root, 'venv/bin/python3'),
  ].find((p): p is string => !!p && existsSync(p))
  if (hit) return hit
  if (configured) return configured
  return hit || (process.platform === 'win32' ? 'python' : 'python3')
}

function resolveBridgeRoot(): string {
  return process.env.HERMES_TUI_ROOT?.trim()
    || process.env.HERMES_PYTHON_SRC_ROOT?.trim()
    || process.env.HERMES_AGENT_ROOT?.trim()
    || resolve(resolveHermesHome(), 'hermes-publish.HkvvHk')
}

function parseBridgeFlag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}

function readBridgeConfigEnabled(): boolean | null {
  try {
    const config = YAML.load(readFileSync(getActiveConfigPath(), 'utf-8')) as Record<string, any> | null
    return parseBridgeFlag(config?.webui?.bridge_enabled)
  } catch {
    return null
  }
}

function isUnknownBridgeMethod(error: unknown, method: string): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return new RegExp(`unknown method:\\s*${method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(message)
}

function normalizeSteerResult(result: { status?: string, text?: string } | null | undefined, text: string) {
  return {
    ok: result?.status === 'queued',
    status: result?.status || 'unknown',
    text: result?.text || text,
  }
}

function payloadText(payload: Record<string, any>): string {
  for (const key of ['text', 'delta', 'content', 'message', 'output', 'summary']) {
    const value = payload[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

function toolPayloadFields(payload: Record<string, any>): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const key of [
    'arguments',
    'args',
    'input',
    'context',
    'command',
    'result',
    'output',
    'stdout',
    'stderr',
    'output_tail',
    'files_read',
    'files_written',
    'exit_code',
    'returncode',
    'exit_status',
    'exitCode',
    'duration_s',
    'duration_ms',
    'status',
    'summary',
    'message',
    'content',
  ]) {
    if (payload[key] !== undefined && payload[key] !== null) fields[key] = payload[key]
  }
  if (fields.arguments === undefined) {
    fields.arguments = payload.args ?? payload.input ?? payload.command
  }
  if (fields.result === undefined) {
    fields.result = payload.result ?? payload.output ?? payload.stdout ?? payload.stderr
  }
  return fields
}

function finiteNumber(value: unknown): number | undefined {
  const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(numberValue) && numberValue >= 0 ? Math.round(numberValue) : undefined
}

function normalizeUsagePayload(payload: Record<string, any>): BridgeRunEvent['usage'] | undefined {
  const raw = payload.usage && typeof payload.usage === 'object' ? payload.usage as Record<string, unknown> : payload
  const inputTokens = finiteNumber(raw.input_tokens ?? raw.inputTokens)
  const outputTokens = finiteNumber(raw.output_tokens ?? raw.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: finiteNumber(raw.total_tokens ?? raw.totalTokens) ?? inputTokens + outputTokens,
    reasoning_tokens: finiteNumber(raw.reasoning_tokens ?? raw.reasoningTokens),
    cache_read_tokens: finiteNumber(raw.cache_read_tokens ?? raw.cacheReadTokens),
    cache_write_tokens: finiteNumber(raw.cache_write_tokens ?? raw.cacheWriteTokens),
    source: typeof raw.source === 'string' ? raw.source : typeof payload.usage_source === 'string' ? payload.usage_source : 'provider',
  }
}

class TuiGatewayClient extends EventEmitter {
  private proc: ChildProcess | null = null
  private reqId = 0
  private pending = new Map<string, PendingRpc>()
  private ready = false
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null

  async ensureStarted(): Promise<void> {
    if (this.proc?.stdin && !this.proc.killed && this.proc.exitCode === null && this.ready) return
    if (this.readyPromise) return this.readyPromise

    const root = resolveBridgeRoot()
    const python = resolvePython(root)
    const cwd = process.env.HERMES_CWD || root
    const env = { ...process.env }
    env.HERMES_PYTHON = python
    const pyPath = env.PYTHONPATH?.trim()
    env.PYTHONPATH = pyPath ? `${root}${delimiter}${pyPath}` : root
    env.PATH = [
      process.env.HERMES_EXTRA_PATH,
      resolve(process.env.HOME || '', '.local/bin'),
      resolve(process.env.HOME || '', '.npm-global/bin'),
      env.PATH,
    ].filter(Boolean).join(delimiter)

    this.ready = false
    this.proc?.kill()
    this.proc = spawn(python, ['-m', 'tui_gateway.entry'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })

    const stdout = createInterface({ input: this.proc.stdout! })
    stdout.on('line', line => {
      try {
        this.dispatch(JSON.parse(line))
      } catch {
        // Ignore non-protocol output; stderr carries diagnostics.
      }
    })

    const stderr = createInterface({ input: this.proc.stderr! })
    stderr.on('line', line => {
      if (line.trim()) this.emit('log', line.trim())
    })

    this.proc.on('error', err => {
      this.rejectAll(new Error(`bridge process error: ${err.message}`))
      this.readyReject?.(err)
    })

    this.proc.on('exit', code => {
      this.ready = false
      this.readyPromise = null
      this.rejectAll(new Error(`bridge process exited${code == null ? '' : ` (${code})`}`))
      this.emit('exit', code)
    })

    this.readyPromise = new Promise((resolveReady, rejectReady) => {
      this.readyResolve = resolveReady
      this.readyReject = rejectReady
      setTimeout(() => {
        if (!this.ready) rejectReady(new Error(`timed out waiting for tui bridge ready (python=${python}, cwd=${cwd})`))
      }, STARTUP_TIMEOUT_MS)
    })

    return this.readyPromise
  }

  private dispatch(message: any) {
    const id = typeof message?.id === 'string' ? message.id : undefined
    if (id && this.pending.has(id)) {
      const pending = this.pending.get(id)!
      clearTimeout(pending.timer)
      this.pending.delete(id)
      if (message.error) {
        pending.reject(new Error(message.error.message || 'bridge request failed'))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (message?.method === 'event' && message.params?.type) {
      if (message.params.type === 'gateway.ready') {
        this.ready = true
        this.readyResolve?.()
      }
      this.emit('event', message.params)
    }
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  async request<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    await this.ensureStarted()
    if (!this.proc?.stdin) throw new Error('bridge process not running')
    const id = `r${++this.reqId}`
    return new Promise<T>((resolveReq, rejectReq) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) rejectReq(new Error(`bridge request timeout: ${method}`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolveReq, reject: rejectReq, timer })
      try {
        this.proc!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        rejectReq(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}

export class TuiBridgeService {
  private bridgeSessionsByWebSession = new Map<string, string>()
  private webSessionsByBridgeSession = new Map<string, string>()
  private persistentSessionsByWebSession = new Map<string, string>()
  private pendingPersistentResolutions = new Map<string, PendingPersistentResolution>()
  private activeRunsByBridgeSession = new Map<string, string>()
  private runs = new Map<string, RunState>()

  constructor(private client = new TuiGatewayClient()) {
    this.client.on('event', event => this.handleGatewayEvent(event))
  }

  isEnabled(): boolean {
    const configFlag = readBridgeConfigEnabled()
    if (configFlag !== null) return configFlag
    const envFlag = parseBridgeFlag(process.env.HERMES_WEBUI_BRIDGE)
    return envFlag === true
  }

  hasSession(webSessionId: string): boolean {
    return this.bridgeSessionsByWebSession.has(webSessionId)
  }

  getPersistentSessionId(webSessionId: string): string | null {
    return this.persistentSessionsByWebSession.get(webSessionId) || null
  }

  async startRun(
    input: string,
    webSessionId: string,
    conversationHistory: Array<{ role: string, content: string }> = [],
  ) {
    if (!this.isEnabled()) throw new Error('Hermes WebUI bridge is disabled')
    let bridgeSession = await this.ensureBridgeSession(webSessionId)
    let bridgeSessionId = bridgeSession.id
    let persistentSessionId = bridgeSession.persistentSessionId
    const runId = `bridge_run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const contextPrompt = this.buildPrompt(input, conversationHistory)
    const state: RunState = {
      runId,
      webSessionId,
      bridgeSessionId,
      events: [],
      waiters: [],
      closed: false,
      contextInputTokens: countTokens(contextPrompt),
    }
    this.runs.set(runId, state)
    setRunSession(runId, webSessionId)
    this.activeRunsByBridgeSession.set(bridgeSessionId, runId)
    this.push(runId, { event: 'run.started', run_id: runId, timestamp: Date.now() / 1000 })
    const contextTokenCount = countTokens(contextPrompt)
    const contextMessageCount = conversationHistory.filter(item => item.content?.trim()).length
    const usesContextHandoff = bridgeSession.created && contextPrompt !== input
    if (usesContextHandoff) {
      this.push(runId, {
        event: 'compression.started',
        run_id: runId,
        timestamp: Date.now() / 1000,
        message_count: contextMessageCount,
        token_count: contextTokenCount,
      })
      this.push(runId, {
        event: 'compression.completed',
        run_id: runId,
        timestamp: Date.now() / 1000,
        compressed: true,
        llmCompressed: false,
        totalMessages: contextMessageCount,
        resultMessages: Math.min(contextMessageCount, 8),
        beforeTokens: contextTokenCount,
        afterTokens: contextTokenCount,
        summaryTokens: 0,
        verbatimCount: Math.min(contextMessageCount, 8),
        compressedStartIndex: 0,
      })
    }
    this.scheduleIdleHeartbeat(runId)

    const prompt = bridgeSession.created ? contextPrompt : input
    try {
      await this.client.request('prompt.submit', { session_id: bridgeSessionId, text: prompt })
    } catch (error) {
      if (!/session busy/i.test(error instanceof Error ? error.message : String(error))) {
        this.push(runId, {
          event: 'run.failed',
          run_id: runId,
          timestamp: Date.now() / 1000,
          error: error instanceof Error ? error.message : String(error),
        })
        this.closeRun(runId)
        throw error
      }

      this.activeRunsByBridgeSession.delete(bridgeSessionId)
      const recreated = await this.createBridgeSession(webSessionId)
      bridgeSessionId = recreated.id
      persistentSessionId = recreated.persistentSessionId
      state.bridgeSessionId = bridgeSessionId
      state.contextInputTokens = countTokens(this.buildPrompt(input, conversationHistory))
      this.activeRunsByBridgeSession.set(bridgeSessionId, runId)
      await this.client.request('prompt.submit', { session_id: bridgeSessionId, text: this.buildPrompt(input, conversationHistory) })
    }
    return {
      run_id: runId,
      status: 'queued',
      bridge: true,
      session_id: persistentSessionId,
      bridge_session_id: bridgeSessionId,
      context_handoff: usesContextHandoff,
      context_message_count: contextMessageCount,
      context_token_count: contextTokenCount,
    }
  }

  async respondApproval(webSessionId: string, choice: string) {
    const bridgeSessionId = this.bridgeSessionsByWebSession.get(webSessionId)
    if (!bridgeSessionId) return null
    const result = await this.client.request('approval.respond', {
      session_id: bridgeSessionId,
      choice,
      all: false,
    })
    clearLivePendingApproval(webSessionId)
    const runId = this.activeRunsByBridgeSession.get(bridgeSessionId)
    if (runId) {
      const state = this.runs.get(runId)
      if (state) state.pendingApproval = false
      this.scheduleIdleHeartbeat(runId)
    }
    return { ok: true, choice, bridge: true, result }
  }

  async respondClarify(webSessionId: string, requestId: string, answer: string) {
    const bridgeSessionId = this.bridgeSessionsByWebSession.get(webSessionId)
    if (!bridgeSessionId) return null
    const result = await this.client.request('clarify.respond', {
      session_id: bridgeSessionId,
      request_id: requestId,
      answer,
    })
    clearLivePendingClarify(webSessionId)
    const runId = this.activeRunsByBridgeSession.get(bridgeSessionId)
    if (runId) {
      const state = this.runs.get(runId)
      if (state) state.pendingClarify = false
      this.scheduleIdleHeartbeat(runId)
    }
    return { ok: true, answer, bridge: true, result }
  }

  async steer(webSessionId: string, text: string) {
    if (!this.isEnabled()) throw new Error('Hermes WebUI bridge is disabled')
    const bridgeSessionId = this.bridgeSessionsByWebSession.get(webSessionId)
    if (!bridgeSessionId) throw new Error('bridge session not found')
    const runId = this.activeRunsByBridgeSession.get(bridgeSessionId)
    if (!runId) throw new Error('session is not running')
    let result: { status?: string, text?: string }
    try {
      result = await this.client.request<{ status?: string, text?: string }>('session.steer', {
        session_id: bridgeSessionId,
        text,
      })
    } catch (error) {
      if (!isUnknownBridgeMethod(error, 'session.steer')) throw error
      result = await this.steerViaCommandDispatch(bridgeSessionId, text)
    }
    const normalized = normalizeSteerResult(result, text)
    this.scheduleIdleHeartbeat(runId)
    return {
      ...normalized,
      run_id: runId,
      bridge: true,
    }
  }

  private async steerViaCommandDispatch(bridgeSessionId: string, text: string): Promise<{ status?: string, text?: string }> {
    try {
      const dispatched = await this.client.request<{ type?: string, output?: string, message?: string }>('command.dispatch', {
        session_id: bridgeSessionId,
        command: `/steer ${text}`,
      })
      if (dispatched?.type === 'exec') return { status: 'queued', text }
      if (dispatched?.type === 'send') {
        throw new Error('Hermes bridge accepted /steer only as a new message; true mid-run steer is not available')
      }
      return { status: 'queued', text }
    } catch (error) {
      if (!isUnknownBridgeMethod(error, 'command.dispatch')) throw error
      const slash = await this.client.request<{ output?: string }>('slash.exec', {
        session_id: bridgeSessionId,
        command: `/steer ${text}`,
      })
      const output = slash?.output || ''
      if (/not a quick\/plugin\/skill command|unknown command|usage:/i.test(output)) {
        throw new Error(output || 'Hermes bridge does not support /steer')
      }
      if (/Steer queued|arrives after the next tool call|queued/i.test(output)) return { status: 'queued', text }
      throw new Error(output || 'Hermes bridge does not support /steer')
    }
  }

  async cancelRun(runId: string) {
    const state = this.runs.get(runId)
    if (!state) return null

    this.clearIdleTimer(state)
    state.pendingApproval = false
    clearLivePendingApproval(state.webSessionId)
    clearLivePendingApprovalForRun(runId)
    state.pendingClarify = false
    clearLivePendingClarify(state.webSessionId)
    clearLivePendingClarifyForRun(runId)

    const result = await this.client.request('session.interrupt', {
      session_id: state.bridgeSessionId,
    })

    this.push(runId, {
      event: 'run.completed',
      run_id: runId,
      timestamp: Date.now() / 1000,
      output: '',
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    })
    this.closeRun(runId)
    return { ok: true, cancelled: true, bridge: true, result }
  }

  async *stream(runId: string): AsyncGenerator<BridgeRunEvent> {
    const state = this.runs.get(runId)
    if (!state) throw new Error(`Bridge run not found: ${runId}`)
    let index = 0
    while (true) {
      while (index < state.events.length) {
        yield state.events[index++]
      }
      if (state.closed) return
      const event = await new Promise<BridgeRunEvent | null>(resolve => state.waiters.push(resolve))
      if (event === null) return
    }
  }

  private async ensureBridgeSession(webSessionId: string): Promise<BridgeSessionRef> {
    const existing = this.bridgeSessionsByWebSession.get(webSessionId)
    if (existing) {
      return {
        id: existing,
        created: false,
        persistentSessionId: this.persistentSessionsByWebSession.get(webSessionId),
      }
    }
    const resumed = await this.tryResumeBridgeSession(webSessionId)
    if (resumed) return resumed
    return this.createBridgeSession(webSessionId)
  }

  private async createBridgeSession(webSessionId: string): Promise<BridgeSessionRef> {
    const before = await this.listPersistentSessionIds().catch(() => new Set<string>())
    const created = await this.client.request<{ session_id: string }>('session.create', { cols: 100 })
    const bridgeSessionId = created.session_id
    const persistentSessionId = await this.waitForNewPersistentSessionId(before).catch(() => undefined)
    const previous = this.bridgeSessionsByWebSession.get(webSessionId)
    if (previous) this.webSessionsByBridgeSession.delete(previous)
    this.bridgeSessionsByWebSession.set(webSessionId, bridgeSessionId)
    this.webSessionsByBridgeSession.set(bridgeSessionId, webSessionId)
    if (persistentSessionId) {
      this.rememberPersistentSessionId(webSessionId, persistentSessionId)
    } else {
      this.schedulePersistentSessionResolution(webSessionId, before)
    }
    return { id: bridgeSessionId, created: true, persistentSessionId }
  }

  private async tryResumeBridgeSession(webSessionId: string): Promise<BridgeSessionRef | null> {
    if (!/^\d{8}_\d{6}_/.test(webSessionId)) return null
    try {
      const resumed = await this.client.request<{ session_id: string, resumed?: string }>('session.resume', {
        session_id: webSessionId,
        cols: 100,
      })
      const bridgeSessionId = resumed.session_id
      this.bridgeSessionsByWebSession.set(webSessionId, bridgeSessionId)
      this.webSessionsByBridgeSession.set(bridgeSessionId, webSessionId)
      const persistentSessionId = resumed.resumed || webSessionId
      this.rememberPersistentSessionId(webSessionId, persistentSessionId)
      return { id: bridgeSessionId, created: false, persistentSessionId }
    } catch {
      return null
    }
  }

  private rememberPersistentSessionId(webSessionId: string, persistentSessionId: string) {
    this.persistentSessionsByWebSession.set(webSessionId, persistentSessionId)
    this.pendingPersistentResolutions.delete(webSessionId)
  }

  private schedulePersistentSessionResolution(webSessionId: string, before: Set<string>) {
    if (this.persistentSessionsByWebSession.has(webSessionId)) return
    this.pendingPersistentResolutions.set(webSessionId, {
      before: new Set(before),
      deadlineAt: Date.now() + STARTUP_TIMEOUT_MS,
    })
    void this.resolvePendingPersistentSession(webSessionId)
  }

  private async resolvePendingPersistentSession(webSessionId: string) {
    while (true) {
      const pending = this.pendingPersistentResolutions.get(webSessionId)
      if (!pending) return
      if (Date.now() >= pending.deadlineAt) {
        this.pendingPersistentResolutions.delete(webSessionId)
        return
      }
      const found = await this.findNewPersistentSessionIdOnce(pending.before).catch(() => undefined)
      if (found?.id) {
        this.rememberPersistentSessionId(webSessionId, found.id)
        return
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }

  private async listPersistentSessionIds(): Promise<Set<string>> {
    const result = await this.client.request<{ sessions?: TuiSessionListItem[] }>('session.list', { limit: 200 })
    return new Set((result.sessions || [])
      .map(session => session.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0))
  }

  private async waitForNewPersistentSessionId(before: Set<string>): Promise<string | undefined> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      const hit = await this.findNewPersistentSessionIdOnce(before)
      if (hit?.id) return hit.id
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    return undefined
  }

  private async findNewPersistentSessionIdOnce(before: Set<string>): Promise<TuiSessionListItem | undefined> {
    const claimedIds = new Set(this.persistentSessionsByWebSession.values())
    const result = await this.client.request<{ sessions?: TuiSessionListItem[] }>('session.list', { limit: 200 })
    const added = (result.sessions || [])
      .filter(session => session.id && !before.has(session.id) && !claimedIds.has(session.id))
      .sort((a, b) => (Number(b.started_at) || 0) - (Number(a.started_at) || 0))
    return added.find(session => session.source === 'tui') || added[0]
  }

  private buildPrompt(input: string, conversationHistory: Array<{ role: string, content: string }>): string {
    const history = conversationHistory
      .filter(item => item.content?.trim())
      .filter(item => !(item.role === 'user' && item.content.trim() === input.trim()))
      .slice(-8)
      .map(item => `${item.role}: ${item.content}`)
      .join('\n\n')
    if (!history) return input
    return `Previous conversation context:\n${history}\n\nCurrent user message:\n${input}`
  }

  private handleGatewayEvent(event: any) {
    const bridgeSessionId = event?.session_id
    if (!bridgeSessionId) return
    const runId = this.activeRunsByBridgeSession.get(bridgeSessionId)
    if (!runId) return
    const payload = event.payload || {}
    const timestamp = Date.now() / 1000

    if (typeof event.type === 'string' && event.type.startsWith('subagent.')) {
      this.push(runId, {
        event: event.type,
        run_id: runId,
        timestamp,
        ...payload,
      })
      this.scheduleIdleHeartbeat(runId)
      return
    }

    switch (event.type) {
      case 'approval.request':
        {
          const state = this.runs.get(runId)
          if (state) {
            state.pendingApproval = true
          }
          this.scheduleIdleHeartbeat(runId)
        }
        setLivePendingApprovalForRun(runId, {
          approval_id: typeof payload.approval_id === 'string' ? payload.approval_id : undefined,
          description: typeof payload.description === 'string' ? payload.description : undefined,
          command: typeof payload.command === 'string' ? payload.command : undefined,
          pattern_key: typeof payload.pattern_key === 'string' ? payload.pattern_key : undefined,
          pattern_keys: Array.isArray(payload.pattern_keys) ? payload.pattern_keys.filter((item: unknown): item is string => typeof item === 'string') : undefined,
          pending_count: typeof payload.pending_count === 'number' ? payload.pending_count : undefined,
        })
        this.push(runId, {
          event: 'approval',
          run_id: runId,
          timestamp,
          approval_id: payload.approval_id,
          description: payload.description,
          command: payload.command,
          pattern_key: payload.pattern_key,
          pattern_keys: payload.pattern_keys,
          pending_count: payload.pending_count || 1,
        })
        break
      case 'clarify.request':
        {
          const state = this.runs.get(runId)
          if (state) {
            state.pendingClarify = true
          }
          this.scheduleIdleHeartbeat(runId)
        }
        setLivePendingClarifyForRun(runId, {
          request_id: typeof payload.request_id === 'string' ? payload.request_id : '',
          question: typeof payload.question === 'string' ? payload.question : '',
          choices: Array.isArray(payload.choices) ? payload.choices.map((item: unknown) => String(item)) : [],
          requested_at: timestamp,
        })
        this.push(runId, {
          event: 'clarify',
          run_id: runId,
          timestamp,
          request_id: payload.request_id,
          question: payload.question,
          choices: Array.isArray(payload.choices) ? payload.choices.map((item: unknown) => String(item)) : [],
        })
        break
      case 'message.delta':
        this.push(runId, { event: 'message.delta', run_id: runId, timestamp, delta: payloadText(payload) })
        this.scheduleIdleHeartbeat(runId)
        break
      case 'reasoning.delta':
      case 'thinking.delta':
      case 'reasoning':
      case 'thinking':
      case 'reasoning.available':
      case 'thinking.available':
      case 'reasoning.complete':
      case 'thinking.complete':
        this.push(runId, {
          event: event.type === 'thinking.available' || event.type === 'thinking.complete' || event.type === 'reasoning.complete'
            ? 'reasoning.available'
            : event.type === 'reasoning' || event.type === 'thinking'
              ? 'reasoning.delta'
              : event.type,
          run_id: runId,
          timestamp,
          text: payload.text || payload.reasoning || payload.thinking || payload.content || payload.message || '',
          delta: payload.delta,
          reasoning: payload.reasoning,
          thinking: payload.thinking,
          content: payload.content,
          message: payload.message,
        })
        this.scheduleIdleHeartbeat(runId)
        break
      case 'message.complete':
        {
          const usage = normalizeUsagePayload(payload)
          this.scheduleRunCompleted(runId, {
            event: 'run.completed',
            run_id: runId,
            timestamp,
            output: payloadText(payload),
            usage,
            usage_source: usage?.source,
          })
        }
        break
      case 'error':
        clearLivePendingApprovalForRun(runId)
        clearLivePendingClarifyForRun(runId)
        this.push(runId, { event: 'run.failed', run_id: runId, timestamp, error: payload.message || 'Bridge run failed' })
        this.closeRun(runId)
        break
      case 'tool.start':
        {
          const state = this.runs.get(runId)
          if (state) this.scheduleIdleHeartbeat(runId)
        }
        this.push(runId, {
          event: 'tool.started',
          run_id: runId,
          timestamp,
          tool: payload.name,
          preview: payload.preview || payload.context || payload.name,
          ...toolPayloadFields(payload),
        })
        break
      case 'tool.progress':
        this.push(runId, {
          event: 'tool.progress',
          run_id: runId,
          timestamp,
          tool: payload.name,
          preview: payload.preview || payload.context || payload.name,
          ...toolPayloadFields(payload),
        })
        this.scheduleIdleHeartbeat(runId)
        break
      case 'tool.complete':
        this.push(runId, {
          event: 'tool.completed',
          run_id: runId,
          timestamp,
          tool: payload.name,
          duration: typeof payload.duration_s === 'number' ? payload.duration_s : undefined,
          ...toolPayloadFields(payload),
        })
        this.scheduleIdleHeartbeat(runId)
        break
    }
  }

  private clearIdleTimer(state: RunState) {
    if (!state.idleTimer) return
    clearTimeout(state.idleTimer)
    state.idleTimer = undefined
  }

  private clearCompleteTimer(state: RunState) {
    if (!state.completeTimer) return
    clearTimeout(state.completeTimer)
    state.completeTimer = undefined
  }

  private completedEventWithUsage(state: RunState, event: BridgeRunEvent): BridgeRunEvent {
    const normalized = event.usage || normalizeUsagePayload(event as Record<string, any>)
    if (normalized && normalized.input_tokens + normalized.output_tokens > 0) {
      return {
        ...event,
        usage: normalized,
        usage_source: normalized.source || event.usage_source || 'provider',
      }
    }

    const outputTokens = countTokens(event.output || '')
    const inputTokens = state.contextInputTokens ?? 0
    const fallback = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      source: 'server-tokenizer',
    }
    return {
      ...event,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      usage: fallback,
      usage_source: fallback.source,
    }
  }

  private persistCompletedUsage(state: RunState, event: BridgeRunEvent) {
    const usage = event.usage
    if (!usage || usage.input_tokens + usage.output_tokens <= 0) return
    updateUsage(state.webSessionId, {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_tokens,
      cacheWriteTokens: usage.cache_write_tokens,
      reasoningTokens: usage.reasoning_tokens,
    })
  }

  private scheduleRunCompleted(runId: string, event: BridgeRunEvent) {
    const state = this.runs.get(runId)
    if (!state || state.closed) return
    this.clearCompleteTimer(state)
    state.completeTimer = setTimeout(() => {
      const completedEvent = this.completedEventWithUsage(state, event)
      this.persistCompletedUsage(state, completedEvent)
      this.push(runId, completedEvent)
      this.closeRun(runId)
    }, COMPLETE_GRACE_MS)
  }

  private scheduleIdleHeartbeat(runId: string, delayMs = IDLE_HEARTBEAT_MS) {
    const state = this.runs.get(runId)
    if (!state || state.closed) return
    this.clearIdleTimer(state)
    state.idleTimer = setTimeout(() => {
      const current = this.runs.get(runId)
      if (!current || current.closed) return
      this.push(runId, {
        event: 'bridge.heartbeat',
        run_id: runId,
        timestamp: Date.now() / 1000,
      })
      this.scheduleIdleHeartbeat(runId, delayMs)
    }, delayMs)
  }

  private push(runId: string, event: BridgeRunEvent) {
    const state = this.runs.get(runId)
    if (!state || state.closed) return
    state.events.push(event)
    for (const waiter of state.waiters.splice(0)) waiter(event)
  }

  private closeRun(runId: string) {
    const state = this.runs.get(runId)
    if (!state || state.closed) return
    state.closed = true
    this.clearIdleTimer(state)
    this.clearCompleteTimer(state)
    clearLivePendingApprovalForRun(runId)
    clearLivePendingClarifyForRun(runId)
    this.activeRunsByBridgeSession.delete(state.bridgeSessionId)
    for (const waiter of state.waiters.splice(0)) waiter(null)
  }
}

export const tuiBridge = new TuiBridgeService()
