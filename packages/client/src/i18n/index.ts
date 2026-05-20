import { createI18n } from 'vue-i18n'
import { messages } from './messages'

const saved = localStorage.getItem('hermes_locale')
const browserLanguages = Array.isArray(navigator.languages) && navigator.languages.length > 0
  ? navigator.languages
  : [navigator.language]

const supportedLocales = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'de', 'pt'] as const
type SupportedLocale = (typeof supportedLocales)[number]

function normalizeLocale(raw: string): SupportedLocale | null {
  const normalized = raw.trim().replace('_', '-')
  if ((supportedLocales as readonly string[]).includes(normalized)) {
    return normalized as SupportedLocale
  }
  const lower = normalized.toLowerCase()
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-mo' || lower === 'zh-hant') return 'zh-TW'
  if (lower.startsWith('zh')) return 'zh'
  const base = lower.split('-')[0]
  return (supportedLocales as readonly string[]).includes(base) ? base as SupportedLocale : null
}

function resolveLocale(saved: string | null, detected: string[]): SupportedLocale {
  if (saved && (supportedLocales as readonly string[]).includes(saved)) {
    return saved as SupportedLocale
  }
  for (const item of detected) {
    const locale = normalizeLocale(item)
    if (locale) return locale
  }
  return 'en'
}

function setHtmlLang(locale: SupportedLocale) {
  document.documentElement.lang = locale
}

const locale = resolveLocale(saved, browserLanguages)
setHtmlLang(locale)

export const i18n = createI18n({
  legacy: false,
  locale,
  fallbackLocale: 'en',
  messages,
})

export function switchLocale(newLocale: string): void {
  const locale = normalizeLocale(newLocale) || 'en'
  ;(i18n.global.locale as any).value = locale
  localStorage.setItem('hermes_locale', locale)
  setHtmlLang(locale)
}
