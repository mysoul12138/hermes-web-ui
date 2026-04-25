<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import MessageItem from "./MessageItem.vue";
import { useChatStore } from "@/stores/hermes/chat";

const chatStore = useChatStore();
const { t } = useI18n();
const listRef = ref<HTMLElement>();

const displayMessages = computed(() => chatStore.displayMessages);

const showRunCursor = computed(() => {
  if (!chatStore.isRunActive) return false;
  const last = displayMessages.value[displayMessages.value.length - 1];
  return !last?.isStreaming;
});

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

// Scroll to bottom once when messages are first loaded
watch(
  () => chatStore.activeSessionId,
  (id) => {
    if (!id) return;
    if (chatStore.focusMessageId) {
      scrollToMessage(chatStore.focusMessageId);
      return;
    }
    scrollToBottom();
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
    if (!chatStore.isStreaming) { scrollToBottom(); return; }
    if (!isNearBottom()) return;
    scrollToBottom();
  },
);
watch(
  () => `${chatStore.activeSessionId || ""}:${displayMessages.value.length}:${showRunCursor.value}`,
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
    <div v-if="showRunCursor" class="run-cursor-row" aria-live="polite">
      <span class="run-cursor"></span>
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

.run-cursor-row {
  display: flex;
  align-items: center;
  min-height: 24px;
  padding: 2px 0 2px 44px;
}

.run-cursor {
  display: inline-block;
  width: 2px;
  height: 18px;
  background: $text-muted;
  border-radius: 1px;
  animation: run-cursor-blink 0.85s steps(2, start) infinite;
}

@keyframes run-cursor-blink {
  0%, 45% { opacity: 1; }
  46%, 100% { opacity: 0; }
}
</style>
