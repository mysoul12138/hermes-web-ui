<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import MessageItem from "./MessageItem.vue";
import { useChatStore } from "@/stores/hermes/chat";
import { useSettingsStore } from "@/stores/hermes/settings";
import { parseThinking, isPlaceholderThinkingText } from "@/utils/thinking-parser";
import { getApiKey, getBaseUrlValue } from "@/api/client";

const chatStore = useChatStore();
const settingsStore = useSettingsStore();
const { t } = useI18n();
const listRef = ref<HTMLElement>();
const isAtLatest = ref(true);
const LATEST_THRESHOLD = 120;
const scrollPositions = new Map<string, number>();
let scrollRequestToken = 0;

const displayMessages = computed(() => chatStore.displayMessages);

function withAuthToken(url: string): string {
  if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url;
  const base = getBaseUrlValue();
  const resolved = url.startsWith("/") ? `${base}${url}` : url;
  if (!resolved.includes("/api/")) return resolved;
  const token = getApiKey();
  if (!token || resolved.includes("token=")) return resolved;
  return `${resolved}${resolved.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

const assistantAvatarUrl = computed(() =>
  withAuthToken(settingsStore.display.assistant_avatar_url || "/logo.png"),
);
const assistantName = computed(() => settingsStore.display.assistant_name?.trim() || "Hermes");

const streamingAssistantHasVisibleOutput = computed(() => {
  const streamingAssistant = [...displayMessages.value]
    .reverse()
    .find((msg) => msg.role === "assistant" && msg.isStreaming);
  if (!streamingAssistant) return false;
  if (streamingAssistant.reasoning?.trim() && !isPlaceholderThinkingText(streamingAssistant.reasoning)) return true;
  const parsed = parseThinking(streamingAssistant.content || "", { streaming: true });
  return (
    parsed.body.trim().length > 0 ||
    parsed.segments.some((segment) => segment.trim().length > 0 && !isPlaceholderThinkingText(segment)) ||
    (!!parsed.pending?.trim().length && !isPlaceholderThinkingText(parsed.pending))
  );
});

const showRunPlaceholder = computed(() =>
  chatStore.isRunActive && !streamingAssistantHasVisibleOutput.value,
);

const compressionNoticeClass = computed(() => ({
  "compression-notice--started": chatStore.activeCompression?.status === "started",
  "compression-notice--completed": chatStore.activeCompression?.status === "completed",
  "compression-notice--failed": chatStore.activeCompression?.status === "failed",
}));

const compressionNoticeTitle = computed(() => {
  const state = chatStore.activeCompression;
  if (!state) return "";
  if (state.status === "started") return t("chat.compressionStarted");
  if (state.status === "failed") return t("chat.compressionFailed");
  return t("chat.compressionCompleted");
});

const compressionNoticeMeta = computed(() => {
  const state = chatStore.activeCompression;
  if (!state) return "";
  if (state.beforeTokens != null && state.afterTokens != null) {
    return t("chat.compressionTokenStats", {
      before: state.beforeTokens.toLocaleString(),
      after: state.afterTokens.toLocaleString(),
    });
  }
  if (state.tokenCount != null) {
    return t("chat.compressionPreparingStats", {
      tokens: state.tokenCount.toLocaleString(),
    });
  }
  if (state.messageCount != null) {
    return t("chat.compressionMessageStats", {
      count: state.messageCount.toLocaleString(),
    });
  }
  return "";
});

function isNearBottom(threshold = LATEST_THRESHOLD): boolean {
  const el = listRef.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

function updateLatestState() {
  isAtLatest.value = isNearBottom();
}

function rememberSessionScroll(sessionId: string | null | undefined) {
  const el = listRef.value;
  if (!el || !sessionId) return;
  scrollPositions.set(sessionId, el.scrollTop);
}

function restoreScrollTop(top: number, sessionId = chatStore.activeSessionId) {
  const token = ++scrollRequestToken;
  nextTick(() => {
    const el = listRef.value;
    if (token !== scrollRequestToken || sessionId !== chatStore.activeSessionId) return;
    if (!el) return;
    el.scrollTop = Math.max(0, Math.min(top, el.scrollHeight));
    updateLatestState();
  });
}

function scrollToBottom(smooth = false, sessionId = chatStore.activeSessionId) {
  const token = ++scrollRequestToken;
  nextTick(() => {
    const el = listRef.value;
    if (token !== scrollRequestToken || sessionId !== chatStore.activeSessionId) return;
    if (el) {
      if (smooth && typeof el.scrollTo === "function") {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      } else {
        el.scrollTop = el.scrollHeight;
      }
      updateLatestState();
    }
  });
}

function scrollToMessage(messageId: string, sessionId = chatStore.activeSessionId) {
  const token = ++scrollRequestToken;
  nextTick(() => {
    if (token !== scrollRequestToken || sessionId !== chatStore.activeSessionId) return;
    const el = document.getElementById(`message-${messageId}`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      updateLatestState();
    }
  });
}

function handleScroll() {
  rememberSessionScroll(chatStore.activeSessionId);
  updateLatestState();
}

onMounted(() => {
  if (Object.keys(settingsStore.display).length === 0) void settingsStore.fetchSettings();
  nextTick(updateLatestState);
});

// Scroll to bottom on session switch
watch(
  () => chatStore.activeSessionId,
  (id, previousId) => {
    rememberSessionScroll(previousId);
    if (!id) return;
    if (chatStore.focusMessageId) {
      scrollToMessage(chatStore.focusMessageId, id);
      return;
    }
    if (scrollPositions.has(id)) {
      restoreScrollTop(scrollPositions.get(id)!, id);
      return;
    }
    if (chatStore.activeSession?.isBranchSession && !chatStore.isSessionLive(id)) {
      restoreScrollTop(0, id);
      return;
    }
    scrollToBottom(false, id);
  },
  { immediate: true },
);

watch(
  () => chatStore.focusMessageId,
  (messageId) => {
    if (!messageId) return;
    scrollToMessage(messageId);
  },
);

// When a run starts (user just sent a message), always scroll to bottom once
watch(
  () => chatStore.isRunActive,
  (v) => {
    if (v) scrollToBottom();
  },
);

// During streaming, follow growth only while the user remains at the latest edge.
watch(
  () => {
    const last = chatStore.messages[chatStore.messages.length - 1];
    if (!last) return "";
    return [
      last.id,
      last.role,
      last.content.length,
      last.content.slice(-80),
      last.reasoning?.length || 0,
      last.reasoning?.slice(-80) || "",
      last.toolStatus || "",
      last.toolArgs?.length || 0,
      last.toolResult?.length || 0,
      displayMessages.value.length,
      showRunPlaceholder.value ? "placeholder" : "",
    ].join(":");
  },
  () => {
    const last = chatStore.messages[chatStore.messages.length - 1];
    if (!chatStore.isRunActive && !last?.isStreaming) return;
    if (chatStore.focusMessageId) {
      scrollToMessage(chatStore.focusMessageId);
      return;
    }
    if (!isAtLatest.value) return;
    scrollToBottom(false, chatStore.activeSessionId);
  },
);
</script>

<template>
  <div class="message-list-shell">
    <div ref="listRef" class="message-list" @scroll="handleScroll">
      <div class="message-list-stage" :class="{ 'is-empty': displayMessages.length === 0 }">
        <div v-if="chatStore.activeSession?.isBranchSession" class="branch-view-banner">
          <span class="branch-view-title">{{ chatStore.activeSession.title || chatStore.activeSession.id }}</span>
          <span class="branch-view-meta">{{ t("chat.branchActiveHint") }}</span>
        </div>
        <div
          v-if="chatStore.activeCompression"
          class="compression-notice"
          :class="compressionNoticeClass"
          aria-live="polite"
        >
          <span class="compression-notice-icon" aria-hidden="true">
            <svg v-if="chatStore.activeCompression.status === 'started'" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2v4" />
              <path d="M12 18v4" />
              <path d="m4.93 4.93 2.83 2.83" />
              <path d="m16.24 16.24 2.83 2.83" />
              <path d="M2 12h4" />
              <path d="M18 12h4" />
              <path d="m4.93 19.07 2.83-2.83" />
              <path d="m16.24 7.76 2.83-2.83" />
            </svg>
            <svg v-else-if="chatStore.activeCompression.status === 'failed'" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            </svg>
            <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </span>
          <span class="compression-notice-copy">
            <span class="compression-notice-title">{{ compressionNoticeTitle }}</span>
            <span v-if="compressionNoticeMeta" class="compression-notice-meta">{{ compressionNoticeMeta }}</span>
          </span>
        </div>
        <div v-if="displayMessages.length === 0" class="empty-state">
          <img src="/logo.png" :alt="assistantName" class="empty-logo" />
          <p>{{ t("chat.emptyState") }}</p>
        </div>
        <div v-else class="message-list-stack">
          <MessageItem
            v-for="msg in displayMessages"
            :key="msg.id"
            :message="msg"
            :highlight="chatStore.focusMessageId === msg.id"
          />
          <div v-if="showRunPlaceholder" class="run-placeholder" aria-live="polite">
            <img :src="assistantAvatarUrl" :alt="assistantName" class="run-placeholder-avatar" />
            <div class="run-placeholder-content">
              <div class="run-placeholder-bubble">
                <span class="run-placeholder-dots" aria-hidden="true">
                  <span></span>
                  <span></span>
                  <span></span>
                </span>
                <span>{{ t("chat.thinkingInProgress") }}</span>
              </div>
              <div class="run-placeholder-time">{{ t("jobs.status.running") }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <button
      v-if="!isAtLatest"
      type="button"
      class="jump-to-latest"
      aria-label="Scroll to latest message"
      title="Scroll to latest message"
      @click="scrollToBottom(true)"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 5v14" />
        <path d="m19 12-7 7-7-7" />
      </svg>
    </button>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.message-list-shell {
  flex: 1;
  min-height: 0;
  position: relative;
}

.message-list {
  height: 100%;
  overflow-y: auto;
  padding: 24px 28px 30px;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.018), rgba(0, 0, 0, 0));

  .dark & {
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.018), rgba(255, 255, 255, 0));
  }
}

.message-list-stage {
  width: min(100%, 980px);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-height: 100%;

  &.is-empty {
    justify-content: center;
  }
}

.message-list-stack {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.empty-state {
  min-height: 320px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: $text-muted;
  gap: 12px;
  border: 1px dashed rgba(0, 0, 0, 0.12);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.45);

  .dark & {
    border-color: rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.025);
  }

  .empty-logo {
    width: 48px;
    height: 48px;
    opacity: 0.25;
  }

  p {
    font-size: 14px;
  }
}

.branch-view-banner {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid $border-color;
  border-left: 3px solid rgba(37, 99, 235, 0.7);
  border-radius: 12px;
  background: rgba(37, 99, 235, 0.055);
  padding: 12px 14px;

  .dark & {
    border-color: rgba(255, 255, 255, 0.08);
    background: rgba(37, 99, 235, 0.08);
  }
}

.branch-view-title {
  color: $text-primary;
  font-size: 13px;
  font-weight: 600;
}

.branch-view-meta {
  color: $text-muted;
  font-size: 11px;
}

.compression-notice {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(100%, 820px);
  border: 1px solid rgba(20, 184, 166, 0.22);
  border-left: 3px solid rgba(20, 184, 166, 0.72);
  border-radius: 10px;
  background: rgba(20, 184, 166, 0.07);
  color: $text-primary;
  padding: 10px 12px;

  .dark & {
    border-color: rgba(45, 212, 191, 0.2);
    border-left-color: rgba(45, 212, 191, 0.76);
    background: rgba(45, 212, 191, 0.08);
  }
}

.compression-notice--failed {
  border-color: rgba(245, 158, 11, 0.22);
  border-left-color: rgba(245, 158, 11, 0.75);
  background: rgba(245, 158, 11, 0.07);

  .dark & {
    border-color: rgba(251, 191, 36, 0.2);
    border-left-color: rgba(251, 191, 36, 0.72);
    background: rgba(251, 191, 36, 0.08);
  }
}

.compression-notice-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 999px;
  color: #0f766e;
  background: rgba(20, 184, 166, 0.12);
  flex-shrink: 0;

  .dark & {
    color: #5eead4;
    background: rgba(45, 212, 191, 0.1);
  }
}

.compression-notice--failed .compression-notice-icon {
  color: #b45309;
  background: rgba(245, 158, 11, 0.12);

  .dark & {
    color: #fcd34d;
    background: rgba(251, 191, 36, 0.1);
  }
}

.compression-notice--started .compression-notice-icon svg {
  animation: compression-spin 1.1s linear infinite;
}

.compression-notice-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.compression-notice-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
}

.compression-notice-meta {
  color: $text-muted;
  font-size: 11px;
  line-height: 1.35;
}

@keyframes compression-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.run-placeholder {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  max-width: min(100%, 820px);
}

.run-placeholder-avatar {
  width: 38px;
  height: 38px;
  border-radius: 999px;
  flex-shrink: 0;
  margin-top: 2px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: rgba(0, 0, 0, 0.04);

  .dark & {
    border-color: rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.04);
  }
}

.run-placeholder-content {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.run-placeholder-bubble {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  max-width: 100%;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.06);
  background: rgba(255, 255, 255, 0.58);
  color: $text-secondary;
  font-size: 14px;
  line-height: 1.65;
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.03);

  .dark & {
    border-color: rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.04);
    color: #cdd1d6;
    box-shadow: 0 1px 0 rgba(0, 0, 0, 0.18);
  }
}

.run-placeholder-time {
  margin-top: 5px;
  padding: 0 4px;
  color: $text-muted;
  font-size: 11px;

  .dark & {
    color: #999999;
  }
}

.run-placeholder-dots {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 18px;
  flex-shrink: 0;
}

.run-placeholder-dots span {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: $text-muted;
  animation: run-placeholder-dot 1.15s ease-in-out infinite;
}

.run-placeholder-dots span:nth-child(2) {
  animation-delay: 0.15s;
}

.run-placeholder-dots span:nth-child(3) {
  animation-delay: 0.3s;
}

.jump-to-latest {
  position: absolute;
  right: 24px;
  bottom: 20px;
  width: 38px;
  height: 38px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.88);
  color: $text-secondary;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.12);
  transition: transform $transition-fast, background-color $transition-fast, color $transition-fast;

  &:hover {
    transform: translateY(-1px);
    background: $bg-card;
    color: $text-primary;
  }

  .dark & {
    border-color: rgba(255, 255, 255, 0.1);
    background: rgba(42, 42, 42, 0.92);
    color: #d2d6dc;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28);
  }
}

@keyframes run-placeholder-dot {
  0%, 70%, 100% {
    opacity: 0.35;
    transform: translateY(0);
  }

  35% {
    opacity: 1;
    transform: translateY(-3px);
  }
}

@media (max-width: $breakpoint-mobile) {
  .message-list {
    padding: 18px 14px 24px;
  }

  .jump-to-latest {
    right: 14px;
    bottom: 16px;
  }
}
</style>
