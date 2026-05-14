export type InjectedMessageFamily =
  | 'none'
  | 'system_note'
  | 'compaction_preamble'
  | 'todo_reinjection'
  | 'summary_failure'
  | 'tool_iteration_limit'
  | 'bridge_continuation_prompt'

const BRIDGE_CONTEXT_PROMPT_PREFIX = 'previous conversation context:'
const BRIDGE_CURRENT_USER_MARKER = 'current user message:'

export function normalizeInjectedMessageText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

export function classifyInjectedMessage(content: unknown): InjectedMessageFamily {
  const text = normalizeInjectedMessageText(content)
  if (!text) return 'none'
  if (text.startsWith('[system:')) return 'system_note'
  if (text.startsWith('[context compaction')) return 'compaction_preamble'
  if (text.startsWith('[your active task list was preserved across context compression]')) return 'todo_reinjection'
  if (text.startsWith('summary generation was unavailable.')) return 'summary_failure'
  if (
    text.startsWith("you've reached the maximum number of tool-calling iterations allowed.")
    || text.startsWith('you have reached the maximum number of tool-calling iterations allowed.')
  ) {
    return 'tool_iteration_limit'
  }
  if (text.startsWith(BRIDGE_CONTEXT_PROMPT_PREFIX) || text.startsWith(BRIDGE_CURRENT_USER_MARKER)) {
    return 'bridge_continuation_prompt'
  }
  return 'none'
}

export function isBridgeContinuationPrompt(content: unknown): boolean {
  return classifyInjectedMessage(content) === 'bridge_continuation_prompt'
}

export function shouldHideFromHumanDisplay(role: unknown, content: unknown): boolean {
  const family = classifyInjectedMessage(content)
  if (family === 'none') return false
  if (family === 'bridge_continuation_prompt') return String(role || '').trim().toLowerCase() === 'user'
  const normalizedRole = String(role || '').trim().toLowerCase()
  return normalizedRole === 'user' || family === 'summary_failure'
}

export function shouldHideFromPromptHistory(role: unknown, content: unknown): boolean {
  const family = classifyInjectedMessage(content)
  if (family === 'none') return false
  if (family === 'bridge_continuation_prompt') {
    return String(role || '').trim().toLowerCase() === 'user'
  }
  return true
}
