/**
 * Pure helper functions for parsing RunEvent fields.
 * Extracted from stores/hermes/chat.ts to isolate custom code from upstream.
 */
import type { RunEvent } from '@/api/hermes/chat'

export function tryParseJson(value?: string | null): Record<string, any> | null {
  if (!value?.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : null
  } catch {
    return null
  }
}

export function extractApprovalCommandFromArgs(toolArgs?: string): string | undefined {
  const parsed = tryParseJson(toolArgs)
  return typeof parsed?.command === 'string' && parsed.command.trim()
    ? parsed.command.trim()
    : undefined
}

export function textFromRunEvent(evt: RunEvent): string {
  for (const value of [evt.text, evt.delta, evt.reasoning, evt.thinking, evt.content, evt.message, evt.output]) {
    if (typeof value === 'string' && value) return value
  }
  return ''
}

export function stringifyToolPayload(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value === 'string') return value.trim() ? value : undefined
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function commandFromToolPayload(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const parsed = tryParseJson(trimmed)
    return parsed ? (commandFromToolPayload(parsed) || trimmed) : trimmed
  }
  if (typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const command = record.command ?? record.cmd
  return typeof command === 'string' && command.trim() ? command.trim() : undefined
}

export function firstPresent(...values: unknown[]): unknown {
  return values.find(value => value != null)
}

export function numberFromRunEvent(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (value == null) continue
    const text = String(value).trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    result.push(text)
  }
  return result
}

export function toolCallKeys(toolCall: Record<string, any>): string[] {
  return uniqueStrings([
    toolCall.call_id,
    toolCall.tool_call_id,
    toolCall.id,
    toolCall.response_item_id,
    toolCall.item_id,
  ])
}

export function toolCallName(toolCall: Record<string, any>): string | undefined {
  const name = toolCall.function?.name ?? toolCall.name ?? toolCall.tool_name
  return typeof name === 'string' && name.trim() ? name.trim() : undefined
}

export function toolCallArgs(toolCall: Record<string, any>): string | undefined {
  const args = toolCall.function?.arguments ?? toolCall.arguments ?? toolCall.args ?? toolCall.input
  return stringifyToolPayload(args)
}

export function previewFromToolResult(content?: string | null): string | undefined {
  if (!content?.trim()) return undefined
  const parsed = tryParseJson(content)
  if (!parsed) return content.slice(0, 240)
  for (const key of ['command', 'output', 'stdout', 'stderr', 'result', 'content', 'message', 'summary', 'preview', 'title', 'url']) {
    const preview = stringifyToolPayload(parsed[key])
    if (preview) return preview.slice(0, 240)
  }
  return stringifyToolPayload(parsed)?.slice(0, 240)
}

export function pickToolArgs(evt: RunEvent): string | undefined {
  const payload = firstPresent(
    evt.arguments ??
    evt.args ??
    evt.parameters ??
    evt.input ??
    (evt.tool_call as Record<string, any> | undefined)?.function?.arguments ??
    (evt.tool_call as Record<string, any> | undefined)?.arguments ??
    (evt.function as Record<string, any> | undefined)?.arguments ??
    (evt.payload as Record<string, any> | undefined)?.arguments ??
    evt.command,
  )
  return stringifyToolPayload(payload)
}

export function pickToolPreview(evt: RunEvent): string | undefined {
  return commandFromToolPayload(evt.command) ||
    commandFromToolPayload(evt.arguments) ||
    commandFromToolPayload(evt.args) ||
    commandFromToolPayload(evt.parameters) ||
    commandFromToolPayload(evt.input) ||
    commandFromToolPayload((evt.tool_call as Record<string, any> | undefined)?.function?.arguments) ||
    commandFromToolPayload((evt.tool_call as Record<string, any> | undefined)?.arguments) ||
    commandFromToolPayload((evt.function as Record<string, any> | undefined)?.arguments) ||
    commandFromToolPayload((evt.payload as Record<string, any> | undefined)?.arguments) ||
    stringifyToolPayload(evt.command) ||
    stringifyToolPayload(evt.preview) ||
    stringifyToolPayload(evt.tool_preview) ||
    stringifyToolPayload(evt.context)
}

export function pickToolCallId(evt: RunEvent): string | undefined {
  return uniqueStrings([
    evt.call_id,
    evt.tool_call_id,
    (evt.tool_call as Record<string, any> | undefined)?.call_id,
    (evt.tool_call as Record<string, any> | undefined)?.id,
    evt.id,
    evt.item_id,
    evt.response_item_id,
  ])[0]
}

export function betterToolText(current: string | undefined, next: string | undefined): string | undefined {
  if (!next) return current
  if (!current) return next
  if (current === next) return current
  if (current.includes('...') && next.length > current.length) return next
  return next.length > current.length ? next : current
}

export function pickToolResult(evt: RunEvent): string | undefined {
  const details: Record<string, unknown> = {}
  for (const key of [
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
    'status',
    'duration',
    'duration_s',
    'duration_ms',
    'duration_seconds',
    'error',
  ]) {
    if (evt[key] != null) details[key] = evt[key]
  }
  if (Object.keys(details).length > 0) return JSON.stringify(details)

  return stringifyToolPayload(
    evt.content ??
    evt.message ??
    evt.summary,
  )
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
}

export function normalizeInlineDiff(value: unknown): string | undefined {
  const text = stringifyToolPayload(value)
  if (!text) return undefined
  const cleaned = stripAnsi(text)
    .split(/\r?\n/)
    .map(line => line.trimStart().replace(/^┊\s*review diff\s*$/i, ''))
    .join('\n')
    .trim()
  return cleaned || undefined
}

export function pickInlineDiff(evt: RunEvent): string | undefined {
  return normalizeInlineDiff(evt.inline_diff ?? (evt.payload as Record<string, any> | undefined)?.inline_diff)
}

export function toolEventDetails(evt: RunEvent): string | undefined {
  const details: Record<string, unknown> = {}
  for (const key of [
    'tool',
    'name',
    'preview',
    'context',
    'command',
    'duration',
    'duration_s',
    'duration_ms',
    'duration_seconds',
    'timestamp',
    'status',
    'stdout',
    'stderr',
    'output_tail',
    'files_read',
    'files_written',
    'exit_code',
    'returncode',
    'exit_status',
    'exitCode',
  ]) {
    if (evt[key] != null) details[key] = evt[key]
  }
  return Object.keys(details).length > 0 ? JSON.stringify(details) : undefined
}

export function mergeToolResult(previous: string | undefined, next: string | undefined): string | undefined {
  if (!next) return previous
  if (!previous) return next
  if (previous.includes(next)) return previous
  return `${previous}\n\n${next}`
}

export function usageFromRunEvent(evt: RunEvent): { input_tokens: number; output_tokens: number } | null {
  if (evt.usage) {
    return {
      input_tokens: evt.usage.input_tokens ?? 0,
      output_tokens: evt.usage.output_tokens ?? 0,
    }
  }
  const raw = evt as RunEvent & { inputTokens?: number; outputTokens?: number }
  const inputTokens = raw.input_tokens ?? raw.inputTokens
  const outputTokens = raw.output_tokens ?? raw.outputTokens
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return null
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  }
}
