/**
 * Shared URL authentication utility.
 * Extracted from MessageItem.vue, MessageList.vue, and DisplaySettings.vue
 * to isolate custom code from upstream.
 */
import { getApiKey, getBaseUrlValue } from '@/api/client'

export function withAuthToken(url: string): string {
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return url
  const base = getBaseUrlValue()
  const resolved = url.startsWith('/') ? `${base}${url}` : url
  if (!resolved.includes('/api/')) return resolved
  const token = getApiKey()
  if (!token || resolved.includes('token=')) return resolved
  return `${resolved}${resolved.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}
