# Custom Code Isolation Plan

> **Generated:** 2026-05-05
> **Upstream base:** `b5481d6`
> **Goal:** Minimize modifications to upstream files so future merges are trivial.

---

## 1. Executive Summary

The fork contains **~9,210 lines added / ~3,087 deleted** across **57 modified files** and **15 new files** under `packages/`. The customizations fall into **7 major feature areas**:

| # | Feature Area | Lines (±) | New Files | Upstream Files Modified |
|---|---|---|---|---|
| 1 | **TUI Bridge** (server-side bridge to Hermes CLI) | ~1,450 | 3 | 2 |
| 2 | **Conversation/Branch System** (session threading) | ~1,300 | 1 | 4 |
| 3 | **Chat Store Rewrite** (streaming, tools, approval) | ~4,250 | 0 | 1 |
| 4 | **Approval & Clarify UI** | ~700 | 8 | 1 |
| 5 | **Message Display** (diff, scrollbar, thinking) | ~2,400 | 1 | 6 |
| 6 | **Settings & Display** (avatar, assistant name) | ~560 | 1 | 3 |
| 7 | **Provider Management** (credential pool) | ~320 | 0 | 3 |

---

## 2. High-Risk File Analysis

### 2.1 `packages/client/src/stores/hermes/chat.ts` — **CRITICAL**

**Diff size:** +3,322 / -926 = **4,248 total changed lines**

This is the single most invasive file. The entire store was effectively rewritten.

**Custom additions:**
- ~30 pure helper functions (`tryParseJson`, `textFromRunEvent`, `pickToolArgs`, `pickToolPreview`, `stripAnsi`, `normalizeInlineDiff`, etc.)
- New interfaces: `CompressionState`, expanded `Session` and `Message` types
- Approval/clarify extraction from message history
- Bridge session awareness (`isPersistentTuiSessionId`)
- Completion bell integration
- Conversation/branch support (`switchBranchSession`, `refreshSessionBranches`)
- Steer/session interrupt support
- Subagent event handling
- Token usage tracking

**Can be extracted to standalone module?** **YES** — heavily
- All 30+ helper functions → `custom/utils/run-event-helpers.ts`
- Approval/clarify extraction → `custom/utils/approval-extractor.ts`
- Tool event parsing → `custom/utils/tool-event-parser.ts`
- `CompressionState` and related logic → `custom/stores/compression.ts`
- Branch/session helpers → `custom/stores/branch-helpers.ts`

**Must stay in upstream file?** **YES** — small hooks:
- Import statements (1-2 lines each)
- Type augmentations on `Message` and `Session` interfaces (additive fields)
- Store method additions (call into extracted modules)
- `displayMessages` computed change (filter logic)

**Extraction potential:** ~80% of the custom code can be moved out.

---

### 2.2 `packages/client/src/components/hermes/chat/MessageItem.vue` — **HIGH**

**Diff size:** +758 / -417 = **1,175 total changed lines**

**Custom additions:**
- `isDiffLikeContent()` — diff detection in tool payloads
- `formatToolPayload()` — enhanced with diff detection
- `withAuthToken()` — URL auth token helper (duplicated)
- `assistantAvatarUrl`, `assistantName` computeds
- `showMessageHeader`, `messageHeadTitle`, `messageHeadStatus` computeds
- `toolStatusLabel` computed
- `isLongUserMessage` computed
- `displayReasoning`, `visibleThinkingSegments`, `visiblePendingThinking` computed
- `showStreamingCursor` computed
- Removed `ContentBlock[]` parsing (upstream feature removed)

**Can be extracted?** **YES**
- `isDiffLikeContent()` → `custom/utils/diff-detector.ts`
- `withAuthToken()` → `custom/utils/auth-url.ts` (shared utility)
- All new computed props → `custom/composables/useMessageDisplay.ts`
- `formatToolPayload` enhancement → `custom/utils/tool-payload-formatter.ts`

**Must stay?** **YES**
- Template changes (assistant avatar, header, diff rendering)
- Import hooks (2-3 lines each)
- Prop/event wiring

**Extraction potential:** ~60% of logic; template changes are inherent.

---

### 2.3 `packages/client/src/components/hermes/chat/MessageList.vue` — **HIGH**

**Diff size:** +725 / -268 = **993 total changed lines**

**Custom additions:**
- **Custom scrollbar** (~200 lines): `updateCustomScrollbar`, `handleScrollbarPointerDown/Move`, drag logic
- **Compression notice** UI (~60 lines): `compressionNoticeClass/Title/Meta`
- **"At latest" button** logic
- `showRunPlaceholder` computed (streaming detection)
- `streamingAssistantHasVisibleOutput` computed
- Scroll position memory per session
- `withAuthToken()` helper (duplicated again)
- `assistantAvatarUrl`, `assistantName` computeds (duplicated)

**Can be extracted?** **YES**
- Custom scrollbar → `custom/components/CustomScrollbar.vue` or `custom/composables/useCustomScrollbar.ts`
- Compression notice → `custom/components/CompressionNotice.vue`
- Scroll memory → `custom/composables/useScrollMemory.ts`
- `withAuthToken()` → single shared utility

**Must stay?** **YES**
- Template changes (scrollbar DOM, compression banner, "jump to latest" button)
- `displayMessages` computed change

**Extraction potential:** ~70%

---

### 2.4 `packages/client/src/components/hermes/chat/MarkdownRenderer.vue` — **MEDIUM**

**Diff size:** +34 / -8 = **42 total changed lines**

**Custom additions:**
- `escapeHtmlAttr()` / `escapeHtmlText()` — XSS-safe HTML attribute escaping
- `inheritAttrs: false` + `useAttrs()` pass-through
- `overflow-wrap: anywhere` CSS fix

**Can be extracted?** **YES** (partially)
- `escapeHtmlAttr/Text` → `custom/utils/html-escape.ts`

**Must stay?** **YES** — hooks:
- `defineOptions({ inheritAttrs: false })` — must be in the component
- `v-bind="attrs"` in template — must be in template
- The escaping calls in `renderedHtml` computed — must stay in this file

**Extraction potential:** ~30% (mostly in-place security fixes — these are good upstream candidates)

---

### 2.5 `packages/server/src/services/hermes/tui-bridge.ts` — **NEW FILE**

**Size:** 1,102 lines — **entirely new**

This is a self-contained service that spawns a Python TUI gateway process and communicates via JSON-RPC. It handles:
- Process lifecycle management
- Session create/resume
- Run submission with context handoff
- Approval/clarify forwarding
- Idle heartbeat & completion detection
- Token usage normalization

**Already fully isolated** — this file is a new addition and needs no extraction. It should remain as-is.

---

### 2.6 `packages/server/src/routes/hermes/proxy-handler.ts` — **HIGH**

**Diff size:** +147 / -33 = **180 total changed lines**

**Custom additions:**
- Bridge run routing (intercept `/v1/runs` POST → TUI bridge)
- Bridge steer routing (intercept `/v1/sessions/:id/steer`)
- Bridge cancel routing (intercept `/v1/runs/:id/cancel`)
- Bridge SSE stream routing (intercept `/v1/runs/:id/events` GET)
- Enhanced `processRunEventChunk()` — approval tracking in SSE
- `setRunSession` / `getSessionForRun` moved to `run-state.ts`
- Run ID extraction from `result.id` (not just `result.run_id`)

**Can be extracted?** **YES** (partially)
- Bridge routing middleware → `custom/server/bridge-middleware.ts`
- SSE event processing enhancement → `custom/server/sse-processor.ts`

**Must stay?** **YES**
- The bridge intercept `if` blocks in `proxy()` function — they must modify the control flow in the upstream handler
- `processRunEventChunk` replaces `extractRunCompletedFromChunk` — the function signature change must stay

**Extraction potential:** ~50%

---

## 3. All Modified Files — Categorized

### 3.1 Files with High Extraction Potential

| File | Lines Changed | Extractable | Must Stay | Strategy |
|------|--------------|-------------|-----------|----------|
| `client/src/stores/hermes/chat.ts` | 4,248 | ~3,400 | ~850 | Extract helpers to `custom/utils/`, composables to `custom/composables/` |
| `client/src/components/hermes/chat/MessageList.vue` | 993 | ~700 | ~300 | Extract scrollbar, compression notice to custom components |
| `client/src/components/hermes/chat/ChatPanel.vue` | 1,296 | ~900 | ~400 | Extract branch UI helpers to `custom/composables/useBranches.ts` |
| `client/src/components/hermes/chat/MessageItem.vue` | 1,175 | ~700 | ~480 | Extract diff detection, auth URL, computed props |
| `server/src/db/hermes/conversations-db.ts` | 786 | ~600 | ~190 | Extract bridge context helpers to `custom/server/bridge-context.ts` |
| `server/src/controllers/hermes/providers.ts` | 189 | ~150 | ~40 | Extract credential pool sync to `custom/server/credential-pool.ts` |
| `server/src/services/config-helpers.ts` | 132 | ~120 | ~15 | Extract `listUserProviders` to `custom/server/user-providers.ts` |

### 3.2 Files with Moderate Extraction Potential

| File | Lines Changed | Extractable | Must Stay | Strategy |
|------|--------------|-------------|-----------|----------|
| `client/src/components/hermes/chat/MarkdownRenderer.vue` | 42 | ~15 | ~30 | XSS fix should go upstream; attrs pass-through stays |
| `client/src/components/hermes/chat/highlight.ts` | 119 | ~100 | ~20 | `autoConvertDiffParagraphs` is fully extractable |
| `client/src/styles/code-block.scss` | 80 | ~80 | 0 | Can be moved to `custom/styles/diff-blocks.scss` |
| `client/src/utils/thinking-parser.ts` | 61 | ~55 | ~10 | `isPlaceholderThinkingText` is standalone |
| `client/src/components/hermes/settings/DisplaySettings.vue` | 478 | ~400 | ~80 | Avatar crop is a standalone component |
| `server/src/services/hermes/conversations.ts` | 267 | ~200 | ~70 | Bridge context helpers |
| `server/src/db/hermes/sessions-db.ts` | 185 | ~150 | ~40 | Orphan linking + bridge context |

### 3.3 Files with Low Extraction Potential (Must Stay)

| File | Lines Changed | Extractable | Must Stay | Reason |
|------|--------------|-------------|-----------|--------|
| `server/src/routes/hermes/proxy-handler.ts` | 180 | ~90 | ~90 | Control flow changes must stay inline |
| `client/src/api/hermes/chat.ts` | 568 | ~300 | ~270 | Interface/type changes are upstream-facing |
| `client/src/composables/useSpeech.ts` | 18 | 0 | 18 | SSR safety fixes — should go upstream |
| `server/src/routes/index.ts` | 4 | 0 | 4 | Route registration — must stay |
| `server/src/routes/hermes/proxy.ts` | 9 | 0 | 9 | Import changes — must stay |
| i18n locale files (8 files) | ~300 | 0 | ~300 | Translation keys — must stay in locale files |

### 3.4 New Files (Already Isolated)

These files are entirely new and don't modify upstream code:

| File | Lines | Purpose |
|------|-------|---------|
| `server/src/services/hermes/tui-bridge.ts` | 1,102 | TUI gateway bridge (JSON-RPC client) |
| `server/src/services/hermes/run-state.ts` | 85 | Run→session mapping + live approval state |
| `server/src/services/hermes/tui-live.ts` | 62 | Live TUI session key tracking |
| `server/src/services/hermes/approval.ts` | 121 | Approval state management |
| `server/src/services/hermes/clarify.ts` | 37 | Clarify state management |
| `server/src/controllers/hermes/approval.ts` | 42 | Approval HTTP handlers |
| `server/src/controllers/hermes/clarify.ts` | 39 | Clarify HTTP handlers |
| `server/src/routes/hermes/approval.ts` | 6 | Approval routes |
| `server/src/routes/hermes/clarify.ts` | 7 | Clarify routes |
| `client/src/api/hermes/approval.ts` | 43 | Approval API client |
| `client/src/api/hermes/clarify.ts` | 38 | Clarify API client |
| `client/src/components/hermes/chat/ApprovalPrompt.vue` | 152 | Approval UI component |
| `client/src/components/hermes/chat/ClarifyPrompt.vue` | 140 | Clarify UI component |
| `client/src/components/hermes/settings/WebUiSettings.vue` | 62 | WebUI settings panel |
| `client/src/utils/completion-bell.ts` | 61 | Audio notification utility |

**Total new file lines:** ~2,097

---

## 4. Proposed `custom/` Directory Structure

```
packages/
├── client/src/custom/
│   ├── utils/
│   │   ├── auth-url.ts                  # withAuthToken() — shared by 4+ files
│   │   ├── run-event-helpers.ts         # 30+ helpers from chat.ts
│   │   ├── tool-event-parser.ts         # pickToolArgs, pickToolPreview, pickToolResult
│   │   ├── tool-payload-formatter.ts    # formatToolPayload with diff detection
│   │   ├── diff-detector.ts             # isDiffLikeContent, autoConvertDiffParagraphs
│   │   ├── html-escape.ts              # escapeHtmlAttr, escapeHtmlText
│   │   └── completion-bell.ts          # (already new file, move here)
│   ├── composables/
│   │   ├── useMessageDisplay.ts         # MessageItem computed props
│   │   ├── useCustomScrollbar.ts        # Custom scrollbar logic from MessageList
│   │   ├── useScrollMemory.ts           # Per-session scroll position memory
│   │   ├── useBranches.ts              # Branch tree helpers from ChatPanel
│   │   └── useCompressionNotice.ts      # Compression banner logic
│   ├── components/
│   │   ├── chat/
│   │   │   ├── ApprovalPrompt.vue       # (already new, keep)
│   │   │   ├── ClarifyPrompt.vue        # (already new, keep)
│   │   │   ├── CompressionNotice.vue    # Extracted from MessageList
│   │   │   └── CustomScrollbar.vue      # Extracted from MessageList
│   │   └── settings/
│   │       ├── AvatarCropper.vue        # Extracted from DisplaySettings
│   │       └── WebUiSettings.vue        # (already new, keep)
│   ├── stores/
│   │   ├── compression.ts              # CompressionState + actions
│   │   └── branch-helpers.ts           # Branch session state helpers
│   └── styles/
│       └── diff-blocks.scss            # Diff line styles from code-block.scss
│
├── server/src/custom/
│   ├── utils/
│   │   ├── bridge-context.ts           # isBridgeContextPrompt, bridgeContextDisplayText
│   │   ├── orphan-linking.ts           # isLikelyOrphanContinuation, linkOrphanCompressionContinuations
│   │   └── token-normalizer.ts         # normalizeUsagePayload, finiteNumber
│   ├── middleware/
│   │   └── bridge-routing.ts           # Bridge intercept logic from proxy-handler
│   ├── services/
│   │   ├── tui-bridge.ts              # (already new, keep)
│   │   ├── tui-live.ts                # (already new, keep)
│   │   ├── run-state.ts               # (already new, keep)
│   │   ├── approval.ts                # (already new, keep)
│   │   ├── clarify.ts                 # (already new, keep)
│   │   └── credential-pool.ts         # syncCustomCredentialPool from providers.ts
│   └── routes/
│       ├── approval.ts                 # (already new, keep)
│       └── clarify.ts                  # (already new, keep)
```

---

## 5. Extraction Priority Order

### Phase 1: Shared Utilities (LOW RISK, HIGH IMPACT)
**Goal:** Eliminate code duplication across files.

| Priority | Item | Files Affected | Effort |
|----------|------|----------------|--------|
| P1.1 | Extract `withAuthToken()` to `custom/utils/auth-url.ts` | MessageItem, MessageList, DisplaySettings, ChatPanel | 1h |
| P1.2 | Extract `isDiffLikeContent()` to `custom/utils/diff-detector.ts` | MessageItem, highlight.ts | 1h |
| P1.3 | Extract `escapeHtmlAttr/Text()` to `custom/utils/html-escape.ts` | MarkdownRenderer | 30m |
| P1.4 | Extract `isPlaceholderThinkingText()` to custom module | thinking-parser, MessageItem, MessageList | 1h |

### Phase 2: Chat Store Decomposition (HIGH RISK, HIGHEST IMPACT)
**Goal:** Reduce `chat.ts` from ~4,250 changed lines to <1,000 upstream-facing lines.

| Priority | Item | Lines Saved | Effort |
|----------|------|-------------|--------|
| P2.1 | Extract 30+ run-event helper functions to `custom/utils/run-event-helpers.ts` | ~600 | 3h |
| P2.2 | Extract tool event parsing to `custom/utils/tool-event-parser.ts` | ~400 | 2h |
| P2.3 | Extract approval/clarify extraction logic to `custom/utils/approval-extractor.ts` | ~200 | 1h |
| P2.4 | Extract `CompressionState` + actions to `custom/stores/compression.ts` | ~150 | 1h |
| P2.5 | Extract branch session helpers to `custom/stores/branch-helpers.ts` | ~200 | 1h |
| P2.6 | Move `CompletionState` tracking to custom store | ~100 | 1h |

### Phase 3: Component Decomposition (MEDIUM RISK, HIGH IMPACT)
**Goal:** Reduce template-level changes in upstream Vue files.

| Priority | Item | Lines Saved | Effort |
|----------|------|-------------|--------|
| P3.1 | Extract custom scrollbar to `CustomScrollbar.vue` | ~200 | 2h |
| P3.2 | Extract compression notice to `CompressionNotice.vue` | ~60 | 1h |
| P3.3 | Extract avatar cropper to `AvatarCropper.vue` | ~300 | 2h |
| P3.4 | Extract branch tree UI helpers to `useBranches.ts` composable | ~300 | 2h |
| P3.5 | Extract message display computeds to `useMessageDisplay.ts` | ~200 | 2h |

### Phase 4: Server-Side Isolation (MEDIUM RISK, MEDIUM IMPACT)
**Goal:** Minimize server upstream file changes.

| Priority | Item | Lines Saved | Effort |
|----------|------|-------------|--------|
| P4.1 | Extract bridge context helpers from conversations-db.ts | ~200 | 2h |
| P4.2 | Extract orphan linking to `custom/utils/orphan-linking.ts` | ~150 | 1h |
| P4.3 | Extract credential pool sync to `custom/services/credential-pool.ts` | ~150 | 1h |
| P4.4 | Extract bridge routing middleware from proxy-handler.ts | ~90 | 2h |
| P4.5 | Extract `listUserProviders` to custom module | ~120 | 1h |

### Phase 5: Style & Configuration (LOW RISK, LOW IMPACT)
**Goal:** Move custom styles to separate files.

| Priority | Item | Lines Saved | Effort |
|----------|------|-------------|--------|
| P5.1 | Move diff block styles to `custom/styles/diff-blocks.scss` | ~80 | 30m |
| P5.2 | Move user message code wrap styles | ~10 | 15m |
| P5.3 | Add i18n keys via custom locale merge | ~300 (8 files) | 2h |

---

## 6. Upstream Merge Strategy

### Files that should be proposed as upstream PRs (good changes):

1. **`useSpeech.ts`** — SSR safety (`typeof window !== 'undefined'` guard) — pure bugfix
2. **`MarkdownRenderer.vue`** — XSS escaping in `src` attributes — security fix
3. **`highlight.ts`** — Diff syntax highlighting — feature addition
4. **`code-block.scss`** — Diff line styles — feature addition
5. **`thinking-parser.ts`** — `isPlaceholderThinkingText` — useful utility

### Files that should NEVER be proposed upstream (fork-specific):

1. **`tui-bridge.ts`** — Entire TUI bridge is fork-specific
2. **`proxy-handler.ts`** bridge routing — fork-specific routing
3. **`chat.ts`** store rewrite — too invasive, architecture difference
4. **Approval/Clarify system** — specific to fork's UX
5. **Avatar cropper / assistant naming** — cosmetic fork feature

---

## 7. Duplication Hotspots

The following code is **duplicated in 3+ files** and should be extracted to a shared module immediately:

### `withAuthToken()` — duplicated in:
- `packages/client/src/components/hermes/chat/MessageItem.vue`
- `packages/client/src/components/hermes/chat/MessageList.vue`
- `packages/client/src/components/hermes/settings/DisplaySettings.vue`

**→ Extract to:** `packages/client/src/custom/utils/auth-url.ts`

### `assistantAvatarUrl` / `assistantName` computeds — duplicated in:
- `MessageItem.vue`
- `MessageList.vue`
- `DisplaySettings.vue`
- `ChatPanel.vue`

**→ Extract to:** `packages/client/src/custom/composables/useAssistantDisplay.ts`

### `isBridgeContextPrompt()` / `bridgeContextDisplayText()` — duplicated in:
- `packages/server/src/db/hermes/conversations-db.ts`
- `packages/server/src/services/hermes/conversations.ts`
- `packages/server/src/db/hermes/sessions-db.ts`

**→ Extract to:** `packages/server/src/custom/utils/bridge-context.ts`

### `isLikelyOrphanContinuation()` — duplicated in:
- `packages/server/src/db/hermes/conversations-db.ts`
- `packages/server/src/services/hermes/conversations.ts`
- `packages/server/src/db/hermes/sessions-db.ts`

**→ Extract to:** `packages/server/src/custom/utils/orphan-linking.ts`

---

## 8. Estimated Impact

| Metric | Before | After Phase 5 |
|--------|--------|---------------|
| Modified upstream files | 57 | ~30 |
| Lines changed in upstream files | ~9,200 | ~2,500 |
| Max lines in any single upstream file | 4,250 (chat.ts) | ~800 |
| Duplicated code instances | 4 (withAuthToken) | 0 |
| Merge conflict risk | HIGH | LOW |
| Time to merge upstream updates | Hours | Minutes |

---

## 9. Implementation Notes

### Import Convention
All custom modules should be imported via a path alias:
```typescript
// In vite.config.ts / tsconfig.json
"@custom/*": ["./src/custom/*"]

// Usage in upstream files (minimal diff)
import { withAuthToken } from '@/custom/utils/auth-url'
```

### Backward Compatibility
Each extraction should maintain the same public API. Downstream consumers (upstream files) should see no behavioral change — only the implementation location changes.

### Testing Strategy
- After each phase, run `npm run build` to verify no regressions
- Run `npm run test` for unit tests
- Manually verify chat streaming, tool display, approval flow

### Custom Module Index
Create `packages/client/src/custom/index.ts` as a barrel export:
```typescript
export { withAuthToken } from './utils/auth-url'
export { isDiffLikeContent } from './utils/diff-detector'
export { useCustomScrollbar } from './composables/useCustomScrollbar'
// etc.
```
