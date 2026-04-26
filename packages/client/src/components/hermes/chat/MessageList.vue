<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import MessageItem from "./MessageItem.vue";
import { useChatStore } from "@/stores/hermes/chat";
import { useSettingsStore } from "@/stores/hermes/settings";
import { parseThinking } from "@/utils/thinking-parser";
import { getApiKey, getBaseUrlValue } from "@/api/client";

const chatStore = useChatStore();
const settingsStore = useSettingsStore();
const { t } = useI18n();
const listRef = ref<HTMLElement>();

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

const streamingAssistantHasVisibleOutput = computed(() => {
  const streamingAssistant = [...displayMessages.value]
    .reverse()
    .find((msg) => msg.role === "assistant" && msg.isStreaming);
  if (!streamingAssistant) return false;
  if (streamingAssistant.reasoning?.trim()) return true;
  const parsed = parseThinking(streamingAssistant.content || "", { streaming: true });
  return (
    parsed.body.trim().length > 0 ||
    parsed.segments.some((segment) => segment.trim().length > 0) ||
    (parsed.pending?.trim().length ?? 0) > 0
  );
});

const showRunPlaceholder = computed(() =>
  chatStore.isRunActive && !streamingAssistantHasVisibleOutput.value,
);

function isNearBottom(threshold = 200): boolean {
  const el = listRef.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

function scrollToBottom() {
  nextTick(() => {
    if (listRef.value) {
      listRef.value.scrollTop = listRef.value.scrollHeight;
    }
  });
}

function scrollToMessage(messageId: string) {
  nextTick(() => {
    const el = document.getElementById(`message-${messageId}`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
    }
  });
}

// Scroll to bottom on session switch
watch(
  () => chatStore.activeSessionId,
  (id) => {
    if (!id) return;
    if (chatStore.focusMessageId) {
      nextTick(() => scrollToMessage(chatStore.focusMessageId!));
      return;
    }
    nextTick(() => scrollToBottom());
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

// During streaming, only auto-scroll if the user is already near the bottom
watch(
  () => chatStore.messages[chatStore.messages.length - 1]?.content,
  () => {
    if (chatStore.focusMessageId) {
      scrollToMessage(chatStore.focusMessageId);
      return;
    }
    if (!isNearBottom()) return;
    scrollToBottom();
  },
);
watch(
  () => `${chatStore.activeSessionId || ""}:${displayMessages.value.length}:${showRunPlaceholder.value}`,
  () => {
    if (!chatStore.isStreaming) { scrollToBottom(); return; }
    if (!isNearBottom()) return;
    scrollToBottom();
  },
);
</script>

<template>
  <div ref="listRef" class="message-list">
    <div v-if="chatStore.activeSession?.isBranchSession" class="branch-view-banner">
      <span class="branch-view-title">{{ chatStore.activeSession.title || chatStore.activeSession.id }}</span>
      <span class="branch-view-meta">{{ t("chat.branchActiveHint") }}</span>
    </div>
    <div v-if="displayMessages.length === 0" class="empty-state">
      <img src="/logo.png" alt="Hermes" class="empty-logo" />
      <p>{{ t("chat.emptyState") }}</p>
    </div>
    <MessageItem
      v-for="msg in displayMessages"
      :key="msg.id"
      :message="msg"
      :highlight="chatStore.focusMessageId === msg.id"
    />
    <div v-if="showRunPlaceholder" class="run-placeholder" aria-live="polite">
      <img :src="assistantAvatarUrl" alt="Hermes" class="run-placeholder-avatar" />
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
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.message-list {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  background-color: $bg-card;

  .dark & {
    background-color: #333333;
  }
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: $text-muted;
  gap: 12px;

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
  gap: 3px;
  border: 1px solid $border-color;
  border-left: 3px solid rgba(var(--accent-primary-rgb), 0.65);
  border-radius: $radius-md;
  background: rgba(var(--accent-primary-rgb), 0.05);
  padding: 10px 12px;
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

.run-placeholder {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 80%;
}

.run-placeholder-avatar {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  margin-top: 2px;
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
  padding: 10px 14px;
  border-radius: 10px;
  background: $msg-assistant-bg;
  color: $text-muted;
  font-size: 14px;
  line-height: 1.65;
}

.run-placeholder-time {
  margin-top: 4px;
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

</style>
