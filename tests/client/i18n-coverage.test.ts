import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'

import { changelog } from '@/data/changelog'
import { messages, rawMessages } from '@/i18n/messages'

const SOURCE_ROOT = join(process.cwd(), 'packages/client/src')

function toPosixPath(path: string): string {
  return path.replace(/\\/g, '/')
}

function walkFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(path, files)
    } else if (/\.(ts|vue)$/.test(entry.name) && !toPosixPath(path).includes('/i18n/locales/')) {
      files.push(path)
    }
  }
  return files
}

function collectLiteralTranslationKeys(): string[] {
  const keys = new Set<string>()
  const translationCall = /(?:\b|\$)t\(\s*['"]([^'"]+)['"]/g

  for (const file of walkFiles(SOURCE_ROOT)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(translationCall)) {
      keys.add(match[1])
    }
  }

  for (const entry of changelog) {
    for (const change of entry.changes) {
      keys.add(change)
    }
  }

  return [...keys].sort()
}

function hasPath(messages: Record<string, unknown>, key: string): boolean {
  let current: unknown = messages
  for (const part of key.split('.')) {
    if (!current || typeof current !== 'object' || !(part in current)) return false
    current = (current as Record<string, unknown>)[part]
  }
  return typeof current !== 'undefined'
}

describe('i18n locale coverage', () => {
  // Keys that are newly added but not yet translated in all locales
  const ALLOWED_MISSING_KEYS = new Set([
    'changelog.new_0_5_4_7',
    'chat.sessionNotFound',
  ])

  it('defines every statically referenced translation key in the English source locale', () => {
    const missing = collectLiteralTranslationKeys()
      .filter((key) => !hasPath(rawMessages.en, key))
      .filter((key) => !ALLOWED_MISSING_KEYS.has(key))

    expect(missing).toEqual([])
  })

  it('defines every statically referenced translation key in effective runtime messages', () => {
    const requiredKeys = collectLiteralTranslationKeys()
    const missing = Object.entries(messages).flatMap(([locale, localeMessages]) =>
      requiredKeys
        .filter((key) => !hasPath(localeMessages, key))
        .filter((key) => !ALLOWED_MISSING_KEYS.has(key))
        .map((key) => `${locale}: ${key}`),
    )

    expect(missing).toEqual([])
  })

  it('keeps approval prompt actions translated in source locales', () => {
    const approvalKeys = [
      'approvalTitle',
      'approvalAllowOnce',
      'approvalAllowSession',
      'approvalAllowAlways',
      'approvalDeny',
      'approvalPendingCount',
      'approvalDangerousCommand',
      'approvalResponding',
    ]

    for (const [locale, localeMessages] of Object.entries(rawMessages)) {
      const chat = localeMessages.chat as Record<string, unknown>
      const missingOrFallback = approvalKeys
        .filter((key) => typeof chat?.[key] !== 'string' || chat[key] === `chat.${key}`)
        .map((key) => `${locale}: chat.${key}`)

      expect(missingOrFallback).toEqual([])
    }

    expect((rawMessages.zh.chat as Record<string, string>).approvalAllowOnce).toBe('允许一次')
    expect((rawMessages.zh.chat as Record<string, string>).approvalAllowSession).toBe('本会话允许')
    expect((rawMessages.zh.chat as Record<string, string>).approvalAllowAlways).toBe('始终允许')
    expect((rawMessages.zh.chat as Record<string, string>).approvalDeny).toBe('拒绝')
  })

  it('keeps the coverage scanner rooted in client source files', () => {
    expect(toPosixPath(relative(process.cwd(), SOURCE_ROOT))).toBe('packages/client/src')
  })
})
