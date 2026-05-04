import hljs from 'highlight.js'
import { copyToClipboard } from '@/utils/clipboard'

const LANGUAGE_ALIASES: Record<string, string> = {
  shellscript: 'bash',
  sh: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  vue: 'xml',
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function sanitizeLanguageClass(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, '-') || 'plain'
}

function renderDiffLine(line: string): string {
  let kind = 'context'
  if (line.startsWith('+++') || line.startsWith('---')) kind = 'file'
  else if (line.startsWith('@@')) kind = 'hunk'
  else if (line.startsWith('+')) kind = 'add'
  else if (line.startsWith('-')) kind = 'delete'
  else if (line.startsWith('\\')) kind = 'meta'
  return `<span class="diff-line diff-${kind}">${escapeHtml(line || ' ')}</span>`
}

function renderDiff(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(renderDiffLine)
    .join('\n')
}

export function normalizeHighlightLanguage(lang?: string): string {
  const normalized = lang?.trim().toLowerCase() || ''
  return LANGUAGE_ALIASES[normalized] || normalized
}

export function inferStructuredLanguage(content: string): string | undefined {
  try {
    JSON.parse(content)
    return 'json'
  } catch {
    return undefined
  }
}

type RenderHighlightedCodeBlockOptions = {
  maxHighlightLength?: number
}

export function renderHighlightedCodeBlock(
  content: string,
  lang: string | undefined,
  copyLabel: string,
  options: RenderHighlightedCodeBlockOptions = {},
): string {
  const requestedLanguage = lang?.trim().toLowerCase() || ''
  const normalizedLanguage = normalizeHighlightLanguage(requestedLanguage)
  const highlightLimit = options.maxHighlightLength ?? Number.POSITIVE_INFINITY

  let highlighted = ''
  let codeClassLanguage = normalizedLanguage || requestedLanguage || 'plain'
  let labelLanguage = requestedLanguage

  try {
    if (normalizedLanguage === 'diff' && content.length <= highlightLimit) {
      highlighted = renderDiff(content)
      codeClassLanguage = 'diff'
    } else if (normalizedLanguage && hljs.getLanguage(normalizedLanguage) && content.length <= highlightLimit) {
      highlighted = hljs.highlight(content, {
        language: normalizedLanguage,
        ignoreIllegals: true,
      }).value
      codeClassLanguage = normalizedLanguage
    } else {
      highlighted = escapeHtml(content)
      if (!labelLanguage) {
        labelLanguage = 'text'
      }
    }
  } catch {
    highlighted = escapeHtml(content)
    if (!labelLanguage) {
      labelLanguage = 'text'
    }
  }

  const languageLabelHtml = labelLanguage
    ? `<span class="code-lang">${escapeHtml(labelLanguage)}</span>`
    : ''

  return `<pre class="hljs-code-block"><div class="code-header">${languageLabelHtml}<button type="button" class="copy-btn" data-copy-code="true">${escapeHtml(copyLabel)}</button></div><code class="hljs language-${sanitizeLanguageClass(codeClassLanguage)}">${highlighted}</code></pre>`
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  return copyToClipboard(text)
}

export async function handleCodeBlockCopyClick(event: MouseEvent): Promise<boolean | null> {
  const target = event.target
  if (!(target instanceof HTMLElement)) return null

  const button = target.closest<HTMLElement>('[data-copy-code="true"]')
  if (!button) return null

  event.preventDefault()

  const block = button.closest('.hljs-code-block')
  const code = block?.querySelector('code')
  const text = code?.textContent ?? ''
  if (!text) return false

  return copyTextToClipboard(text)
}

// --- Auto-detect inline diffs (not wrapped in ```diff) ---

const DIFF_HUNK_RE = /^@@\s*-\d*/
const DIFF_ARROW_RE = /\s→\s/
const DIFF_INLINE_DETECT_RE =
  /<p>[\s\S]*?(@@\s*-\d*|<code>[+<]|<code>-(?!-)|\s→\s)[\s\S]*?<\/p>/

function looksLikeDiff(lines: string[]): boolean {
  let hunks = 0
  let adds = 0
  let dels = 0
  let context = 0
  for (const l of lines) {
    if (DIFF_HUNK_RE.test(l)) hunks++
    else if (/^\+[^+]/.test(l)) adds++
    else if (/^-[^-]/.test(l)) dels++
    else if (/^ /.test(l)) context++
  }
  if (hunks > 0 && adds + dels > 0) return true
  const total = lines.length
  if (total >= 4 && adds + dels + context > total * 0.3) return true
  return false
}

/**
 * Post-process rendered markdown HTML to find <p> tags whose text content
 * looks like a unified diff (hunk headers, + / - change lines, → arrow)
 * and convert them into syntax-highlighted diff code blocks.
 */
export function autoConvertDiffParagraphs(html: string): string {
  if (!DIFF_INLINE_DETECT_RE.test(html)) return html

  const doc = new DOMParser().parseFromString(html, 'text/html')
  const paragraphs = Array.from(doc.querySelectorAll('body > p'))
  if (paragraphs.length === 0) return html

  let i = 0
  let changed = false

  const isDiffLine = (t: string) =>
    DIFF_HUNK_RE.test(t) ||
    DIFF_ARROW_RE.test(t) ||
    /^\+[^+]/.test(t) ||
    /^-[^-]/.test(t)

  while (i < paragraphs.length) {
    const group = [paragraphs[i]]
    const texts = [paragraphs[i].textContent || '']

    // Merge consecutive <p> tags only when BOTH neighbours look like diff
    while (i + group.length < paragraphs.length) {
      const nextText = paragraphs[i + group.length].textContent || ''
      if (!isDiffLine(texts[texts.length - 1]) || !isDiffLine(nextText)) break
      group.push(paragraphs[i + group.length])
      texts.push(nextText)
    }

    // Reconstruct the original plain-text lines
    const rawLines: string[] = []
    for (const text of texts) {
      for (const line of text.split('\n')) {
        const trimmed = line.trimEnd()
        if (trimmed) rawLines.push(trimmed)
      }
    }

    if (rawLines.length >= 3 && looksLikeDiff(rawLines)) {
      // Build highlighted diff HTML
      const highlighted = rawLines
        .map((l) => {
          let kind = 'context'
          if (l.startsWith('+++') || l.startsWith('---')) kind = 'file'
          else if (l.startsWith('@@')) kind = 'hunk'
          else if (l.startsWith('+')) kind = 'add'
          else if (l.startsWith('-')) kind = 'delete'
          else if (l.startsWith('\\')) kind = 'meta'
          return `<span class="diff-line diff-${kind}">${escapeHtml(l || ' ')}</span>`
        })
        .join('\n')

      const wrapper = doc.createElement('div')
      wrapper.innerHTML = `<pre class="hljs-code-block"><div class="code-header"><span class="code-lang">diff</span><button type="button" class="copy-btn" data-copy-code="true">Copy</button></div><code class="hljs language-diff">${highlighted}</code></pre>`

      group[0].parentNode?.replaceChild(wrapper, group[0])
      for (let k = 1; k < group.length; k++) group[k].remove()

      changed = true
      i += group.length
    } else {
      i += group.length
    }
  }

  return changed ? doc.body.innerHTML : html
}
