const TITLE_MAX_LENGTH = 40
const RUNNING_TUI_PLACEHOLDER = 'running tui session'

const SYNTHETIC_TITLE_PREFIXES = [
  'previous conversation context:',
  'current user message:',
  '[system:',
  '[context compaction',
  '[your active task list was preserved across context compression]',
  'summary generation was unavailable.',
  "you've reached the maximum number of tool-calling iterations allowed.",
  'you have reached the maximum number of tool-calling iterations allowed.',
]

function normalizeWhitespace(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function truncateTitle(value: string): string {
  return value.length > TITLE_MAX_LENGTH ? `${value.slice(0, TITLE_MAX_LENGTH)}...` : value
}

function stripLeadingHashToken(value: unknown): string {
  const text = normalizeWhitespace(value)
  const stripped = text.replace(/^(?:[0-9a-f]{7,64})(?:\s+|[:：,-]+\s+)/i, '').trim()
  return stripped || text
}

export function isLowQualitySessionTitle(value: unknown): boolean {
  const text = normalizeWhitespace(value)
  if (!text) return true
  const normalized = text.toLowerCase()
  if (normalized === RUNNING_TUI_PLACEHOLDER) return true
  if (SYNTHETIC_TITLE_PREFIXES.some(prefix => normalized.startsWith(prefix))) return true
  if (/^\d{8}_\d{6}_[0-9a-f]+$/i.test(text)) return true
  if (/^[0-9a-f]{7,64}(?:\.\.\.|…)?$/i.test(text)) return true
  if (/^[{[]/.test(text)) return true
  return false
}

export function normalizeSessionTitleCandidate(value: unknown): string | null {
  const stripped = stripLeadingHashToken(value)
  if (isLowQualitySessionTitle(stripped)) return null
  return truncateTitle(stripped)
}

export function selectSessionTitle(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    const title = normalizeSessionTitleCandidate(candidate)
    if (title) return title
  }
  return null
}
