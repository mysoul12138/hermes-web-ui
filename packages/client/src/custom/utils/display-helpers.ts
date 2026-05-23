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
  if (reasoning.length < 24 || content.length < 40) return false
  if (reasoning.length > 520) return false
  const ratio = reasoning.length / content.length
  if (content.startsWith(reasoning)) return ratio >= 0.35
  if (ratio < 0.45 || ratio > 1.35) return false
  return commonSubsequenceRatio(reasoning, content) >= 0.72
}

function commonSubsequenceRatio(a: string, b: string): number {
  const left = [...a]
  const right = [...b]
  if (left.length === 0 || right.length === 0) return 0
  const previous = new Array(right.length + 1).fill(0)
  const current = new Array(right.length + 1).fill(0)
  for (let i = 1; i <= left.length; i += 1) {
    current.fill(0)
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1])
    }
    for (let j = 0; j <= right.length; j += 1) previous[j] = current[j]
  }
  return previous[right.length] / Math.min(left.length, right.length)
}
