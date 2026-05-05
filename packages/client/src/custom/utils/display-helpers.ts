/**
 * Display-related helper functions for reasoning/thinking text.
 * Extracted from stores/hermes/chat.ts to isolate custom code from upstream.
 */
import type { Message } from '@/stores/hermes/chat'

export function isBuggyReasoningPreview(reasoningText: string, assistantContent: string): boolean {
  const r = reasoningText.trim()
  const c = assistantContent.trim()
  if (!r || !c) return false
  return c === r || c.startsWith(r) || r.startsWith(c)
}

export function scrubBuggyReasoning(message: Message): Message {
  if (message.role !== 'assistant' || !message.reasoning || !message.content) return message
  if (!isBuggyReasoningPreview(message.reasoning, message.content)) return message
  const { reasoning: _drop, ...rest } = message
  return rest as Message
}
