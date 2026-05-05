/**
 * Diff detection and conversion utilities.
 * Extracted from highlight.ts and MessageItem.vue to isolate custom code from upstream.
 */

// --- Shared regex constants ---

export const DIFF_HUNK_RE = /^@@\s*-\d*/
export const DIFF_ARROW_RE = /\s→\s/
export const DIFF_INLINE_DETECT_RE =
  /<p>[\s\S]*?(@@\s*-\d*|<code>[+<]|<code>-(?!-)|\s→\s)[\s\S]*?<\/p>/

// --- Escape utility (duplicated from highlight.ts for isolation) ---

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

// --- Diff detection from MessageItem.vue ---

export function isDiffLikeContent(raw: string): boolean {
  // Check raw lines first (direct diff content)
  let hunks = 0
  let changes = 0
  for (const line of raw.split('\n')) {
    if (DIFF_HUNK_RE.test(line)) hunks++
    else if (line.startsWith('+') || line.startsWith('-')) changes++
  }
  if (hunks > 0 && changes > 0) return true
  if (changes >= 6) return true

  // Also check inside JSON values (pickToolResult wraps content in JSON)
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) {
      for (const val of Object.values(parsed)) {
        if (typeof val === 'string' && isDiffLikeContent(val)) return true
      }
    }
  } catch { /* not JSON */ }

  return false
}

// --- Diff paragraph conversion from highlight.ts ---

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
