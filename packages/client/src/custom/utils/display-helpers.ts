/**
 * Display-related helper functions for reasoning/thinking text.
 * Extracted from stores/hermes/chat.ts to isolate custom code from upstream.
 */
import type { Message } from '@/stores/hermes/chat'

export function isBuggyReasoningPreview(reasoningText: string, assistantContent: string): boolean {
  const r = normalizeComparableText(reasoningText)
  const c = normalizeComparableText(assistantContent)
  if (!r || !c) return false
  if (c === r) return true
  return looksAnswerPreview(r, c)
}

export function scrubBuggyReasoning(message: Message): Message {
  if (message.role !== 'assistant' || !message.reasoning || !message.content) return message
  if (!isBuggyReasoningPreview(message.reasoning, message.content)) return message
  const { reasoning: _drop, ...rest } = message
  return rest as Message
}

function normalizeComparableText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[`*_#[\](){}<>~|>\\-]+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function looksAnswerPreview(reasoning: string, content: string): boolean {
  if (!content.startsWith(reasoning)) return false
  if (reasoning.length < 24 || content.length < 40) return false
  if (reasoning.length > 520) return false
  if (reasoning.length / content.length < 0.35) return false
  return true
}
