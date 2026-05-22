/**
 * SSE stream event processing for chat runs.
 *
 * Extracted from the chat store to decouple SSE event handling from Pinia
 * state management.  The upstream Socket.IO implementation lives in
 * chat-run-socket.ts; this module is the SSE equivalent.
 *
 * The store creates a `RunStreamCallbacks` object and passes it to
 * `processRunEvent` for each SSE event.  All state mutations happen
 * through the callbacks — this module has no Pinia dependency.
 */
import type { RunEvent } from '@/api/hermes/chat'
import type { Message } from '@/stores/hermes/chat'
import {
  textFromRunEvent,
  numberFromRunEvent,
  betterToolText,
  pickToolArgs,
  pickToolPreview,
  pickToolCallId,
  pickToolResult,
  pickInlineDiff,
  toolEventDetails,
  mergeToolResult,
  usageFromRunEvent,
} from '@/custom/utils/run-event-helpers'
import { isBuggyReasoningPreview } from '@/custom/utils/display-helpers'

// ─── Callback interface ──────────────────────────────────────────────

export interface RunStreamCallbacks {
  // Message operations
  getMessages: () => Message[]
  addMessage: (msg: Message) => void
  updateMessage: (id: string, update: Partial<Message>) => void
  uid: () => string

  // Compression state
  setCompressionState: (data: {
    status: 'started' | 'completed' | 'failed'
    messageCount?: number
    tokenCount?: number
    totalMessages?: number
    resultMessages?: number
    beforeTokens?: number
    afterTokens?: number
    summaryTokens?: number
    verbatimCount?: number
    error?: string
  }) => void
  clearCompression: () => void

  // Subagent
  upsertSubagentBranch: (evt: RunEvent) => void

  // Approval / Clarify
  setApprovalPending: (evt: RunEvent) => void
  startApprovalPolling: () => void
  setClarifyPending: (evt: RunEvent) => void
  startClarifyPolling: () => void
  clearApproval: () => void

  // Usage
  applySessionUsage: (usage: { input_tokens: number; output_tokens: number } | null) => void
  persistSessionsList: () => void

  // Thinking / reasoning observation
  noteThinkingDelta: (messageId: string, prev: string, next: string) => void
  noteReasoningStart: (messageId: string) => void
  noteReasoningEnd: (messageId: string) => void

  // Delta batching (store provides the batch machinery)
  appendStreamDelta: (messageId: string, field: 'content' | 'reasoning', text: string) => void
  flushStreamDeltas: () => void

  // Persistence
  schedulePersist: () => void
}

// ─── Event processor ─────────────────────────────────────────────────

/**
 * Process a single RunEvent from the SSE stream.
 *
 * Returns `true` if the run produced any assistant text (used by the store
 * to decide whether to show a "no output" error on completion).
 */
export function processRunEvent(
  evt: RunEvent,
  cb: RunStreamCallbacks,
  state: { runProducedAssistantText: boolean; runHadToolActivity: boolean },
): void {
  switch (evt.event) {
    case 'run.started':
      break

    case 'compression.started': {
      cb.setCompressionState({
        status: 'started',
        messageCount: numberFromRunEvent(evt.message_count),
        tokenCount: numberFromRunEvent(evt.token_count),
      })
      break
    }

    case 'compression.completed': {
      if (evt.compressed === false) {
        cb.clearCompression()
      } else {
        cb.setCompressionState({
          status: evt.error ? 'failed' : 'completed',
          totalMessages: numberFromRunEvent(evt.totalMessages),
          resultMessages: numberFromRunEvent(evt.resultMessages),
          beforeTokens: numberFromRunEvent(evt.beforeTokens),
          afterTokens: numberFromRunEvent(evt.contextTokens ?? evt.context_tokens ?? evt.context_token_count ?? evt.afterTokens),
          summaryTokens: numberFromRunEvent(evt.summaryTokens),
          verbatimCount: numberFromRunEvent(evt.verbatimCount),
          error: typeof evt.error === 'string' ? evt.error : undefined,
        })
      }
      break
    }

    case 'subagent.spawn_requested':
    case 'subagent.start':
    case 'subagent.thinking':
    case 'subagent.progress':
    case 'subagent.status':
    case 'subagent.tool':
    case 'subagent.complete':
    case 'subagent.error': {
      state.runHadToolActivity = true
      const msgs = cb.getMessages()
      const last = msgs[msgs.length - 1]
      if (last?.isStreaming) {
        cb.updateMessage(last.id, { isStreaming: false })
      }
      cb.upsertSubagentBranch(evt)
      break
    }

    case 'approval': {
      cb.setApprovalPending(evt)
      cb.startApprovalPolling()
      break
    }

    case 'clarify': {
      cb.setClarifyPending(evt)
      cb.startClarifyPolling()
      break
    }

    case 'reasoning.delta':
    case 'thinking.delta': {
      const text = textFromRunEvent(evt)
      if (!text) break
      state.runProducedAssistantText = true
      const msgs = cb.getMessages()
      const last = msgs[msgs.length - 1]
      if (last?.role === 'assistant' && last.isStreaming) {
        cb.noteReasoningStart(last.id)
        cb.appendStreamDelta(last.id, 'reasoning', text)
      } else {
        const newId = cb.uid()
        cb.addMessage({
          id: newId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          isStreaming: true,
          reasoning: text,
        })
        cb.noteReasoningStart(newId)
        cb.schedulePersist()
      }
      break
    }

    case 'reasoning.available': {
      cb.flushStreamDeltas()
      const text = textFromRunEvent(evt)
      const msgs = cb.getMessages()
      const last = msgs[msgs.length - 1]
      if (last?.role === 'assistant' && last.isStreaming) {
        const shouldAppendReasoning = text
          && (!last.reasoning || !last.reasoning.includes(text))
          && !isBuggyReasoningPreview(text, last.content || '')
        if (shouldAppendReasoning) {
          cb.updateMessage(last.id, {
            reasoning: last.reasoning ? `${last.reasoning}\n\n${text}` : text,
          })
        }
        cb.noteReasoningEnd(last.id)
      } else if (text) {
        const newId = cb.uid()
        cb.addMessage({
          id: newId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          isStreaming: true,
          reasoning: text,
        })
        cb.noteReasoningStart(newId)
        cb.noteReasoningEnd(newId)
      }
      cb.schedulePersist()
      break
    }

    case 'message.delta': {
      if (evt.delta) state.runProducedAssistantText = true
      let msgs = cb.getMessages()
      let last = msgs[msgs.length - 1]
      // If the last assistant message has pending reasoning deltas, flush
      // them first so content doesn't interleave with reasoning.
      if (last?.role === 'assistant' && last.isStreaming) {
        cb.flushStreamDeltas()
        msgs = cb.getMessages()
        last = msgs[msgs.length - 1]
      }
      if (last?.role === 'assistant' && last.isStreaming) {
        cb.appendStreamDelta(last.id, 'content', evt.delta || '')
      } else {
        const newId = cb.uid()
        const nextContent = evt.delta || ''
        cb.addMessage({
          id: newId,
          role: 'assistant',
          content: nextContent,
          timestamp: Date.now(),
          isStreaming: true,
        })
        cb.noteThinkingDelta(newId, '', nextContent)
        cb.schedulePersist()
      }
      break
    }

    case 'tool.start':
    case 'tool.started': {
      cb.flushStreamDeltas()
      state.runHadToolActivity = true
      const msgs = cb.getMessages()
      const last = msgs[msgs.length - 1]
      if (last?.isStreaming) {
        cb.updateMessage(last.id, { isStreaming: false })
      }
      cb.addMessage({
        id: cb.uid(),
        role: 'tool',
        content: '',
        timestamp: Date.now(),
        toolName: evt.tool || evt.name || evt.tool_name,
        toolPreview: pickToolPreview(evt),
        toolArgs: pickToolArgs(evt),
        toolCallId: pickToolCallId(evt),
        toolStatus: 'running',
      })
      cb.schedulePersist()
      break
    }

    case 'tool.progress': {
      state.runHadToolActivity = true
      const msgs = cb.getMessages()
      const toolMsgs = msgs.filter(m => m.role === 'tool' && m.toolStatus === 'running')
      if (toolMsgs.length > 0) {
        const eventToolCallId = pickToolCallId(evt)
        const last = (eventToolCallId && toolMsgs.find(m => m.toolCallId === eventToolCallId))
          || toolMsgs[toolMsgs.length - 1]
        cb.updateMessage(last.id, {
          toolPreview: betterToolText(last.toolPreview, pickToolPreview(evt)),
          toolArgs: betterToolText(last.toolArgs, pickToolArgs(evt)),
          toolResult: mergeToolResult(last.toolResult, pickToolResult(evt) || toolEventDetails(evt)),
          toolInlineDiff: betterToolText(last.toolInlineDiff, pickInlineDiff(evt)),
          toolCallId: last.toolCallId || eventToolCallId,
        })
      }
      cb.schedulePersist()
      break
    }

    case 'tool.complete':
    case 'tool.completed': {
      state.runHadToolActivity = true
      const msgs = cb.getMessages()
      const toolMsgs = msgs.filter(m => m.role === 'tool' && m.toolStatus === 'running')
      if (toolMsgs.length > 0) {
        const eventToolCallId = pickToolCallId(evt)
        const last = (eventToolCallId && toolMsgs.find(m => m.toolCallId === eventToolCallId))
          || toolMsgs[toolMsgs.length - 1]
        cb.updateMessage(last.id, {
          toolStatus: 'done',
          toolPreview: betterToolText(last.toolPreview, pickToolPreview(evt)),
          toolArgs: betterToolText(last.toolArgs, pickToolArgs(evt)),
          toolResult: mergeToolResult(last.toolResult, pickToolResult(evt) || toolEventDetails(evt)),
          toolInlineDiff: betterToolText(last.toolInlineDiff, pickInlineDiff(evt)),
          toolCallId: last.toolCallId || eventToolCallId,
        })
      }
      cb.clearApproval() // clear optimistic approval if any
      cb.schedulePersist()
      break
    }

    case 'usage.updated': {
      cb.applySessionUsage(usageFromRunEvent(evt))
      cb.persistSessionsList()
      break
    }

    // run.completed and run.failed are handled by the store directly
    // because they require extensive cleanup (polling, branching, etc.)
    default:
      break
  }
}
