import { EventEmitter } from 'events'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockIsSessionCompressionEnded = vi.hoisted(() => vi.fn())
const mockWriteBridgeContinuationLink = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  isSessionCompressionEnded: mockIsSessionCompressionEnded,
}))

vi.mock('../../packages/server/src/services/hermes/bridge-continuation-links', () => ({
  writeBridgeContinuationLink: mockWriteBridgeContinuationLink,
}))

vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({
  updateUsage: vi.fn(),
}))

import { closeDb, getDb, getStoragePath } from '../../packages/server/src/db'
import { listConversationSessionEdges } from '../../packages/server/src/db/hermes/conversation-lineage'
import { TuiBridgeService } from '../../packages/server/src/services/hermes/tui-bridge'

type PersistentSession = { id: string, source: string, started_at: number }

class LineageGatewayClient extends EventEmitter {
  requests: Array<{ method: string, params: Record<string, any> }> = []
  createdSessions = 0
  persistentSessions: PersistentSession[] = []
  createPersistentIds: Array<string | null> = ['20260522_120000_aaaaaa']
  resumePersistentId: string | null = null
  failSubmitOnceWithBusy = false

  async request<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    this.requests.push({ method, params })
    if (method === 'session.list') return { sessions: this.persistentSessions } as T
    if (method === 'session.create') {
      this.createdSessions += 1
      const id = this.createPersistentIds.shift()
      if (id) {
        this.persistentSessions.push({
          id,
          source: 'tui',
          started_at: Date.now() / 1000,
        })
      }
      return { session_id: `runtime-${this.createdSessions}` } as T
    }
    if (method === 'session.resume') {
      return {
        session_id: 'runtime-resumed',
        resumed: this.resumePersistentId || params.session_id,
      } as T
    }
    if (method === 'prompt.submit') {
      if (this.failSubmitOnceWithBusy) {
        this.failSubmitOnceWithBusy = false
        throw new Error('session busy')
      }
      return { ok: true } as T
    }
    if (method === 'config.set') return { ok: true } as T
    return { ok: true } as T
  }
}

function edges(conversationId: string) {
  const db = getDb()
  if (!db) return []
  return listConversationSessionEdges(db, conversationId)
}

function resetTestRuntimeDb() {
  const runtimeDbDir = dirname(getStoragePath())
  closeDb()
  rmSync(runtimeDbDir, { recursive: true, force: true })
}

describe('TuiBridgeService explicit conversation lineage', () => {
  let runtimeDir: string

  beforeEach(() => {
    resetTestRuntimeDb()
    runtimeDir = join(tmpdir(), `hermes-webui-tui-lineage-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(runtimeDir, { recursive: true })
    process.env.HERMES_HOME = runtimeDir
    process.env.VITEST = 'true'
    mockIsSessionCompressionEnded.mockReset()
    mockIsSessionCompressionEnded.mockResolvedValue(false)
    mockWriteBridgeContinuationLink.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetTestRuntimeDb()
    rmSync(runtimeDir, { recursive: true, force: true })
    delete process.env.HERMES_HOME
  })

  it('writes a canonical continues edge for create with persistent child and persistent parent', async () => {
    const client = new LineageGatewayClient()
    client.createPersistentIds = ['20260522_120000_aaaaaa']
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)

    const result = await bridge.startRun('follow up', 'web-root', [], {
      lineageRootSessionId: '20260522_110000_bbbbbb',
      lineageParentSessionId: '20260522_110000_bbbbbb',
    })
    ;(bridge as any).closeRun(result.run_id)

    expect(edges('20260522_110000_bbbbbb')).toEqual([
      expect.objectContaining({
        child_session_id: '20260522_120000_aaaaaa',
        parent_session_id: '20260522_110000_bbbbbb',
        edge_type: 'continues',
        confidence: 'explicit',
        created_by: 'bridge',
      }),
    ])
  })

  it('does not write canonical edge until pending persistent resolution succeeds', async () => {
    vi.useFakeTimers()
    const client = new LineageGatewayClient()
    client.createPersistentIds = [null]
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)
    vi.spyOn(bridge as any, 'waitForNewPersistentSessionId').mockResolvedValueOnce(undefined)

    const result = await bridge.startRun('follow up', 'web-root', [], {
      lineageRootSessionId: '20260522_110000_bbbbbb',
      lineageParentSessionId: '20260522_110000_bbbbbb',
    })
    expect(edges('20260522_110000_bbbbbb')).toEqual([])

    client.persistentSessions.push({
      id: '20260522_120000_aaaaaa',
      source: 'tui',
      started_at: Date.now() / 1000,
    })
    await vi.advanceTimersByTimeAsync(600)
    expect(edges('20260522_110000_bbbbbb')).toEqual([
      expect.objectContaining({
        child_session_id: '20260522_120000_aaaaaa',
        parent_session_id: '20260522_110000_bbbbbb',
        edge_type: 'continues',
      }),
    ])

    ;(bridge as any).closeRun(result.run_id)
    vi.useRealTimers()
  })

  it('reconciles delayed persistent lineage on stream attach and disconnect without duplicate edges', async () => {
    vi.useFakeTimers()
    const client = new LineageGatewayClient()
    client.createPersistentIds = [null]
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)
    vi.spyOn(bridge as any, 'waitForNewPersistentSessionId').mockResolvedValueOnce(undefined)

    const result = await bridge.startRun('follow up', 'web-root', [], {
      lineageRootSessionId: '20260522_110000_bbbbbb',
      lineageParentSessionId: '20260522_110000_bbbbbb',
    })
    const stream = bridge.stream(result.run_id)
    await stream.next()

    client.persistentSessions.push({
      id: '20260522_120000_aaaaaa',
      source: 'tui',
      started_at: Date.now() / 1000,
    })
    await vi.advanceTimersByTimeAsync(600)
    await stream.return?.(undefined)
    ;(bridge as any).reconcileBridgeConversationLineage('web-root', 'duplicate-attach')

    expect(edges('20260522_110000_bbbbbb')).toEqual([
      expect.objectContaining({
        child_session_id: '20260522_120000_aaaaaa',
        parent_session_id: '20260522_110000_bbbbbb',
        edge_type: 'continues',
      }),
    ])

    ;(bridge as any).closeRun(result.run_id)
    vi.useRealTimers()
  })

  it('reconciles persistent explicit lineage at completion when the first write only had a temp web id', async () => {
    vi.useFakeTimers()
    const client = new LineageGatewayClient()
    client.createPersistentIds = [null]
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)
    vi.spyOn(bridge as any, 'waitForNewPersistentSessionId').mockResolvedValueOnce(undefined)

    const result = await bridge.startRun('follow up', 'web-root', [], {
      lineageRootSessionId: '20260522_110000_bbbbbb',
      lineageParentSessionId: '20260522_110000_bbbbbb',
    })
    expect(edges('20260522_110000_bbbbbb')).toEqual([])

    ;(bridge as any).rememberPersistentSessionId('web-root', '20260522_120000_aaaaaa')
    ;(bridge as any).updateLineageReconciliation('web-root', {
      bridgeSessionId: result.bridge_session_id,
      persistentSessionId: '20260522_120000_aaaaaa',
      lineageParentSessionId: '20260522_110000_bbbbbb',
      lineageRootSessionId: '20260522_110000_bbbbbb',
      lineage: {
        logicalConversationId: '20260522_110000_bbbbbb',
        rootSessionId: '20260522_110000_bbbbbb',
      },
    })
    client.emit('event', {
      session_id: result.bridge_session_id,
      type: 'message.complete',
      payload: { content: 'done' },
    })
    await vi.advanceTimersByTimeAsync(1600)

    expect(edges('20260522_110000_bbbbbb')).toEqual([
      expect.objectContaining({
        child_session_id: '20260522_120000_aaaaaa',
        parent_session_id: '20260522_110000_bbbbbb',
        edge_type: 'continues',
      }),
    ])
    vi.useRealTimers()
  })

  it('skips bad parents and records only a root edge for the persistent child', async () => {
    const client = new LineageGatewayClient()
    client.createPersistentIds = ['20260522_120000_aaaaaa']
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)

    const result = await bridge.startRun('follow up', 'web-root', [], {
      lineageRootSessionId: '20260522_110000_bbbbbb',
      lineageParentSessionId: 'mpbadshortid',
    })
    ;(bridge as any).closeRun(result.run_id)

    expect(edges('20260522_110000_bbbbbb')).toEqual([
      expect.objectContaining({
        child_session_id: '20260522_120000_aaaaaa',
        parent_session_id: null,
        edge_type: 'root',
      }),
    ])
  })

  it('never writes short bridge runtime ids as canonical child ids', async () => {
    vi.useFakeTimers()
    const client = new LineageGatewayClient()
    client.createPersistentIds = [null]
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)
    vi.spyOn(bridge as any, 'waitForNewPersistentSessionId').mockResolvedValueOnce(undefined)

    const result = await bridge.startRun('new request', 'web-root', [], {
      lineageRootSessionId: '20260522_110000_bbbbbb',
      lineageParentSessionId: '20260522_110000_bbbbbb',
    })
    ;(bridge as any).closeRun(result.run_id)

    expect(result.session_id).toBeUndefined()
    expect(edges('20260522_110000_bbbbbb')).toEqual([])
    vi.useRealTimers()
  })

  it('writes context handoff continues edge only for distinct persistent parent and child', async () => {
    const client = new LineageGatewayClient()
    client.createPersistentIds = ['20260522_120000_aaaaaa']
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)
    ;(bridge as any).persistentSessionsByWebSession.set('web-root', '20260522_110000_bbbbbb')

    const result = await bridge.startRun('current request', 'web-root', [
      { role: 'user', content: 'previous request' },
      { role: 'assistant', content: 'previous answer' },
    ], {
      lineageRootSessionId: '20260522_110000_bbbbbb',
      lineageParentSessionId: '20260522_110000_bbbbbb',
    })
    ;(bridge as any).closeRun(result.run_id)

    expect(edges('20260522_110000_bbbbbb')).toEqual([
      expect.objectContaining({
        child_session_id: '20260522_120000_aaaaaa',
        parent_session_id: '20260522_110000_bbbbbb',
        edge_type: 'continues',
      }),
    ])
  })

  it('keeps duplicate bridge writes idempotent', async () => {
    const client = new LineageGatewayClient()
    client.createPersistentIds = ['20260522_120000_aaaaaa']
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)
    ;(bridge as any).persistentSessionsByWebSession.set('web-root', '20260522_110000_bbbbbb')

    const result = await bridge.startRun('current request', 'web-root', [
      { role: 'user', content: 'previous request' },
      { role: 'assistant', content: 'previous answer' },
    ], {
      lineageRootSessionId: '20260522_110000_bbbbbb',
      lineageParentSessionId: '20260522_110000_bbbbbb',
    })
    ;(bridge as any).closeRun(result.run_id)

    expect(edges('20260522_110000_bbbbbb')).toHaveLength(1)
  })

  it('writes resume as root when it resumes the same persistent session', async () => {
    const client = new LineageGatewayClient()
    client.resumePersistentId = '20260522_110000_bbbbbb'
    const bridge = new TuiBridgeService(client as any)
    vi.spyOn(bridge, 'isEnabled').mockReturnValue(true)

    const result = await bridge.startRun('resume request', '20260522_110000_bbbbbb', [], {
      lineageRootSessionId: '20260522_110000_bbbbbb',
      lineageParentSessionId: '20260522_110000_bbbbbb',
    })
    ;(bridge as any).closeRun(result.run_id)

    expect(edges('20260522_110000_bbbbbb')).toEqual([
      expect.objectContaining({
        child_session_id: '20260522_110000_bbbbbb',
        parent_session_id: null,
        edge_type: 'root',
      }),
    ])
  })
})
