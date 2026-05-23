/**
 * Display-related helper functions for reasoning/thinking text.
 * Extracted from stores/hermes/chat.ts to isolate custom code from upstream.
 */
import type { Message } from '@/stores/hermes/chat'

export function isBuggyReasoningPreview(reasoningText: string, assistantContent: string): boolean {
  const r = normalizeComparableText(reasoningText)
  const c = normalizeComparableText(assistantContent)
  if (!r || !c) return false
  return c === r || c.startsWith(r) || r.startsWith(c)
    || looksNearDuplicate(r, c)
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

function looksNearDuplicate(a: string, b: string): boolean {
  const shorter = Math.min(a.length, b.length)
  const longer = Math.max(a.length, b.length)
  if (shorter < 40 || longer === 0) return false
  if (shorter / longer < 0.72) return false
  return diceCoefficient(a, b) >= 0.86
}

function diceCoefficient(a: string, b: string): number {
  const left = bigramCounts(a)
  const right = bigramCounts(b)
  if (!left.size || !right.size) return a === b ? 1 : 0
  let overlap = 0
  let leftTotal = 0
  let rightTotal = 0
  for (const count of left.values()) leftTotal += count
  for (const count of right.values()) rightTotal += count
  for (const [key, count] of left) {
    const other = right.get(key) || 0
    overlap += Math.min(count, other)
  }
  return (2 * overlap) / (leftTotal + rightTotal)
}

function bigramCounts(text: string): Map<string, number> {
  const compact = text.replace(/\s+/g, '')
  const counts = new Map<string, number>()
  for (let i = 0; i < compact.length - 1; i += 1) {
    const key = compact.slice(i, i + 2)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return counts
}
