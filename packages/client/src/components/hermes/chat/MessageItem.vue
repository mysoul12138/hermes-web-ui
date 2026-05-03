<script setup lang="ts">
import type { Message } from "@/stores/hermes/chat";
import { computed, onBeforeUnmount, onMounted, ref, watchEffect } from "vue";
import { useI18n } from "vue-i18n";
import { useMessage } from "naive-ui";
import { downloadFile } from "@/api/hermes/download";
import { copyToClipboard } from "@/utils/clipboard";
import MarkdownRenderer from "./MarkdownRenderer.vue";
import { parseThinking, isPlaceholderThinkingText } from "@/utils/thinking-parser";
import { useChatStore } from "@/stores/hermes/chat";
import { useSettingsStore } from "@/stores/hermes/settings";
import { getApiKey, getBaseUrlValue } from "@/api/client";
import {
  copyTextToClipboard,
  handleCodeBlockCopyClick,
  renderHighlightedCodeBlock,
} from "./highlight";
import { useGlobalSpeech } from "@/composables/useSpeech";

const TOOL_PAYLOAD_DISPLAY_LIMIT = 2000;
const USER_LONG_FORM_CHAR_THRESHOLD = 420;
const USER_LONG_FORM_LINE_THRESHOLD = 8;

const props = defineProps<{ message: Message; highlight?: boolean }>();
const { t } = useI18n();
const toast = useMessage();

const isSystem = computed(() => props.message.role === "system");
const toolExpanded = ref(false);
const previewUrl = ref<string | null>(null);

const chatStore = useChatStore();
const settingsStore = useSettingsStore();
const speech = useGlobalSpeech();

function withAuthToken(url: string): string {
  if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url;
  const base = getBaseUrlValue();
  const resolved = url.startsWith("/") ? `${base}${url}` : url;
  if (!resolved.includes("/api/")) return resolved;
  const token = getApiKey();
  if (!token || resolved.includes("token=")) return resolved;
  return `${resolved}${resolved.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

const assistantAvatarUrl = computed(() => withAuthToken(settingsStore.display.assistant_avatar_url || "/logo.png"));
const assistantName = computed(() => settingsStore.display.assistant_name?.trim() || "Hermes");

// Copy entire bubble content
const copyableContent = computed(() => {
  if (props.message.role === 'tool') return null
  const content = props.message.content || ''
  if (!content.trim()) return null
  return content
})

async function copyBubbleContent() {
  const text = copyableContent.value
  if (!text) return
  const ok = await copyToClipboard(text)
  if (ok) {
    toast.success(t('chat.copiedBubble'))
    return
  }
  toast.error(t('chat.copyFailed'))
}

const parsedThinking = computed(() =>
  parseThinking(props.message.content || "", { streaming: !!props.message.isStreaming }),
);

const showStreamingCursor = computed(() =>
  !!props.message.isStreaming && parsedThinking.value.body.trim().length > 0,
);

const isLongUserMessage = computed(() => {
  if (props.message.role !== "user") return false;
  const content = props.message.content || "";
  const lineCount = content.split(/\r?\n/).length;
  return (
    content.length >= USER_LONG_FORM_CHAR_THRESHOLD ||
    lineCount >= USER_LONG_FORM_LINE_THRESHOLD ||
    /```|<pre\b|<code\b/i.test(content)
  );
});

const displayReasoning = computed(() => {
  const reasoning = props.message.reasoning?.trim() || "";
  if (!reasoning || isPlaceholderThinkingText(reasoning)) return "";
  return reasoning;
});

const visibleThinkingSegments = computed(() =>
  parsedThinking.value.segments.filter((segment) => !isPlaceholderThinkingText(segment)),
);

const visiblePendingThinking = computed(() => {
  const pending = parsedThinking.value.pending;
  if (!pending || isPlaceholderThinkingText(pending)) return null;
  return pending;
});

// 优先使用来自 reasoning 字段/事件的思考文本；否则回退到从 content 解析的 <think> 标签。
// 若两者共存，则拼接展示（罕见，但保持信息不丢）。
const hasReasoningField = computed(() => displayReasoning.value.length > 0);

const hasThinking = computed(() =>
  hasReasoningField.value
  || visibleThinkingSegments.value.length > 0
  || visiblePendingThinking.value !== null,
);

const thinkingFullText = computed(() => {
  const parts: string[] = [];
  if (displayReasoning.value) parts.push(displayReasoning.value);
  parts.push(...visibleThinkingSegments.value);
  if (visiblePendingThinking.value) parts.push(visiblePendingThinking.value);
  return parts.join("\n\n");
});

const renderThinkingAsPlainText = computed(() =>
  props.message.isStreaming && thinkingStreamingNow.value,
);

const thinkingCharCount = computed(() => {
  let count = visibleThinkingSegments.value.reduce((sum, segment) => sum + [...segment].length, 0);
  if (visiblePendingThinking.value) count += [...visiblePendingThinking.value].length;
  if (displayReasoning.value) count += displayReasoning.value.length;
  return count;
});

// 流式思考态：仍有未闭合 <think> 标签，或 reasoning 有内容但正文尚未开始。
const thinkingStreamingNow = computed(() => {
  if (!props.message.isStreaming) return false;
  if (parsedThinking.value.pending !== null) return true;
  if (hasReasoningField.value && !props.message.content) return true;
  return false;
});

const thinkingOverride = ref<boolean | null>(null);

const thinkingExpanded = computed(() => {
  if (thinkingStreamingNow.value) return true;
  if (thinkingOverride.value !== null) return thinkingOverride.value;
  return !!settingsStore.display.show_reasoning;
});

function toggleThinking() {
  thinkingOverride.value = !thinkingExpanded.value;
}

const nowTick = ref(Date.now());
let tickTimer: number | null = null;

function ensureTick() {
  const ob = chatStore.getThinkingObservation(props.message.id);
  const shouldTick = !!(
    props.message.isStreaming &&
    ob?.startedAt !== undefined &&
    ob.endedAt === undefined
  );
  if (shouldTick && tickTimer === null) {
    tickTimer = window.setInterval(() => {
      nowTick.value = Date.now();
    }, 1000);
  } else if (!shouldTick && tickTimer !== null) {
    window.clearInterval(tickTimer);
    tickTimer = null;
  }
}

watchEffect(ensureTick);

onBeforeUnmount(() => {
  if (tickTimer !== null) window.clearInterval(tickTimer);
});

const thinkingDurationMs = computed<number | null>(() => {
  const ob = chatStore.getThinkingObservation(props.message.id);
  if (!ob?.startedAt) return null;
  const end = ob.endedAt ?? (props.message.isStreaming ? nowTick.value : ob.startedAt);
  return Math.max(0, end - ob.startedAt);
});

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}m` : `${m}m ${r}s`;
}

const timeStr = computed(() => {
  const d = new Date(props.message.timestamp);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
});

const showMessageHeader = computed(() => props.message.role === "assistant");
const messageHeadTitle = computed(() => (props.message.role === "assistant" ? assistantName.value : ""));
const messageHeadStatus = computed(() => {
  if (props.message.role !== "assistant") return "";
  return props.message.isStreaming ? t("chat.thinkingInProgress") : "";
});

const toolStatusLabel = computed(() => {
  if (props.message.toolStatus === "running") return t("jobs.status.running");
  if (props.message.toolStatus === "error") return t("chat.error");
  return "passed";
});

function isImage(type: string): boolean {
  return type.startsWith("image/");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/**
 * Extract the upload file path from message content for a given attachment.
 * Upload format in content: [File: name.txt](/tmp/hermes-uploads/abc123.txt)
 */
function getFilePathFromContent(attName: string): string | null {
  const content = props.message.content || "";
  const regex = /\[File:\s*([^\]]+)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match[1].trim() === attName.trim()) return match[2];
  }
  return null;
}

function handleAttachmentDownload(att: { name: string; url: string; type: string }) {
  const filePath = getFilePathFromContent(att.name);
  if (filePath) {
    toast.info(t("download.downloading"));
    downloadFile(filePath, att.name).catch((err: Error) => {
      toast.error(err.message || t("download.downloadFailed"));
    });
    return;
  }
  if (att.url && att.url.startsWith("blob:")) {
    const a = document.createElement("a");
    a.href = att.url;
    a.download = att.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

type ToolPayload = {
  full: string;
  display: string;
  language?: string;
};

function formatToolPayload(raw?: string): ToolPayload {
  if (!raw) {
    return { full: "", display: "" };
  }

  try {
    const full = JSON.stringify(JSON.parse(raw), null, 2);
    return {
      full,
      display:
        full.length > TOOL_PAYLOAD_DISPLAY_LIMIT
          ? full.slice(0, TOOL_PAYLOAD_DISPLAY_LIMIT) + "\n" + t("chat.truncated")
          : full,
      language: "json",
    };
  } catch {
    return {
      full: raw,
      display:
        raw.length > TOOL_PAYLOAD_DISPLAY_LIMIT
          ? raw.slice(0, TOOL_PAYLOAD_DISPLAY_LIMIT) + "\n" + t("chat.truncated")
          : raw,
    };
  }
}

function renderToolPayload(content: string, language?: string): string {
  return renderHighlightedCodeBlock(content, language, t("common.copy"), {
    maxHighlightLength: TOOL_PAYLOAD_DISPLAY_LIMIT,
  });
}

async function handleToolDetailClick(event: MouseEvent): Promise<void> {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const button = target.closest<HTMLElement>("[data-copy-code=\"true\"]");
  if (!button) return;

  event.preventDefault();

  const source = button.closest<HTMLElement>("[data-copy-source]")?.dataset.copySource;
  if (source === "tool-args" && fullToolArgs.value) {
    const ok = await copyTextToClipboard(fullToolArgs.value);
    if (ok) toast.success(t("common.copied"));
    else toast.error(t("chat.copyFailed"));
    return;
  }
  if (source === "tool-preview" && fullToolPreview.value) {
    const ok = await copyTextToClipboard(fullToolPreview.value);
    if (ok) toast.success(t("common.copied"));
    else toast.error(t("chat.copyFailed"));
    return;
  }
  if (source === "tool-result" && fullToolResult.value) {
    const ok = await copyTextToClipboard(fullToolResult.value);
    if (ok) toast.success(t("common.copied"));
    else toast.error(t("chat.copyFailed"));
    return;
  }

  const copyResult = await handleCodeBlockCopyClick(event);
  if (copyResult) toast.success(t("common.copied"));
  else if (copyResult === false) toast.error(t("chat.copyFailed"));
}

const hasAttachments = computed(
  () => (props.message.attachments?.length ?? 0) > 0,
);

const hasVisibleMessageSurface = computed(() => {
  if (props.message.role !== "assistant") return true;
  return (
    hasAttachments.value
    || hasThinking.value
    || parsedThinking.value.body.trim().length > 0
  );
});

const hasToolDetails = computed(
  () => !!(
    props.message.toolArgs ||
    props.message.toolResult ||
    props.message.toolPreview ||
    props.message.content
  ),
);

const toolPreviewPayload = computed(() => formatToolPayload(props.message.toolPreview || props.message.content));
const toolArgsPayload = computed(() => formatToolPayload(props.message.toolArgs));
const toolResultPayload = computed(() => formatToolPayload(props.message.toolResult));

const fullToolPreview = computed(() => toolPreviewPayload.value.full);
const formattedToolPreview = computed(() => toolPreviewPayload.value.display);
const fullToolArgs = computed(() => toolArgsPayload.value.full);
const formattedToolArgs = computed(() => toolArgsPayload.value.display);
const fullToolResult = computed(() => toolResultPayload.value.full);
const formattedToolResult = computed(() => toolResultPayload.value.display);

const renderedToolPreview = computed(() => {
  if (!formattedToolPreview.value) return "";
  return renderToolPayload(
    formattedToolPreview.value,
    toolPreviewPayload.value.language,
  );
});

const renderedToolArgs = computed(() => {
  if (!formattedToolArgs.value) return "";
  return renderToolPayload(
    formattedToolArgs.value,
    toolArgsPayload.value.language,
  );
});

const renderedToolResult = computed(() => {
  if (!formattedToolResult.value) return "";
  return renderToolPayload(
    formattedToolResult.value,
    toolResultPayload.value.language,
  );
});

// 语音播放相关
const canPlaySpeech = computed(() => {
  // 只有 assistant 消息可以播放，且浏览器支持 Web Speech API
  return props.message.role === 'assistant' &&
         speech.isSupported &&
         copyableContent.value;
});

const isPlayingThisMessage = computed(() => {
  return speech.currentMessageId.value === props.message.id && speech.isPlaying.value;
});

const isPausedThisMessage = computed(() => {
  return speech.currentMessageId.value === props.message.id && speech.isPaused.value;
});

function handleSpeechToggle() {
  if (!canPlaySpeech.value) {
    console.log('Speech not supported or no content')
    return
  }
  const content = props.message.content || ''
  console.log('Toggling speech for message:', props.message.id)
  console.log('Current playing:', speech.currentMessageId.value, speech.isPlaying.value)
  console.log('Call stack:', new Error().stack)

  // 尝试获取男声语音包
  const allVoices = speech.getAllVoices()
  let maleVoice = null

  // 查找可能的男声语音包
  for (const voice of allVoices) {
    const name = voice.name.toLowerCase()
    // 常见男声关键词
    if (name.includes('male') || name.includes('david') || name.includes('daniel') ||
        name.includes('mark') || name.includes('yaoyao') || name.includes('google')) {
      // 优先选择中文男声
      if (voice.lang.startsWith('zh')) {
        maleVoice = voice
        break
      }
      // 如果没有找到中文男声，记住第一个男声
      if (!maleVoice) {
        maleVoice = voice
      }
    }
  }

  console.log('Selected male voice:', maleVoice?.name, maleVoice?.lang)

  // 快速男声：语速快、音调低
  speech.toggle(props.message.id, content, {
    pitch: 0.5,   // 低沉
    rate: 1.2,    // 快速
    voice: maleVoice || undefined, // 使用男声，如果没有就用默认
  })
}

// 监听自动播放事件
let autoPlayHandler: ((e: Event) => void) | null = null

onMounted(() => {
  autoPlayHandler = (e: Event) => {
    const customEvent = e as CustomEvent<{ messageId: string; content: string }>
    if (customEvent.detail.messageId === props.message.id && canPlaySpeech.value) {
      console.log('Auto-play triggered for message:', props.message.id)
      handleSpeechToggle()
    }
  }
  window.addEventListener('auto-play-speech', autoPlayHandler)
})

// 组件卸载时停止播放并清理事件监听
onBeforeUnmount(() => {
  if (autoPlayHandler) {
    window.removeEventListener('auto-play-speech', autoPlayHandler)
  }
  if (speech.currentMessageId.value === props.message.id) {
    speech.stop();
  }
});
</script>

<template>
  <div
    class="message"
    :class="[message.role, { highlight, subagent: !!message.subagentId }]"
    :style="message.subagentId ? { marginLeft: `${Math.min(message.subagentDepth || 0, 4) * 16}px` } : undefined"
    :id="`message-${message.id}`"
  >
    <template v-if="message.role === 'tool'">
      <div
        class="tool-card"
        :class="[
          `tool-card--${message.toolStatus || 'done'}`,
          { expandable: hasToolDetails, expanded: toolExpanded },
        ]"
      >
        <div
          class="tool-line"
          :class="{ expandable: hasToolDetails }"
          @click="hasToolDetails && (toolExpanded = !toolExpanded)"
        >
          <svg
            v-if="hasToolDetails"
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="tool-chevron"
            :class="{ rotated: toolExpanded }"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <svg
            v-else
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            class="tool-icon"
          >
            <path
              d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
            />
          </svg>
          <div class="tool-summary">
            <span class="tool-name">{{ message.toolName }}</span>
            <span
              v-if="message.toolPreview && !toolExpanded"
              class="tool-preview"
              >{{ message.toolPreview }}</span
            >
          </div>
          <span class="tool-status-badge" :class="message.toolStatus || 'done'">
            <span
              v-if="message.toolStatus === 'running'"
              class="tool-spinner"
            ></span>
            {{ toolStatusLabel }}
          </span>
        </div>
        <div v-if="toolExpanded && hasToolDetails" class="tool-details" @click="handleToolDetailClick">
          <div v-if="formattedToolPreview" class="tool-detail-section" data-copy-source="tool-preview">
            <div class="tool-detail-label">{{ t("files.preview") }}</div>
            <div class="tool-detail-code-block" v-html="renderedToolPreview"></div>
          </div>
          <div v-if="formattedToolArgs" class="tool-detail-section" data-copy-source="tool-args">
            <div class="tool-detail-label">{{ t("chat.arguments") }}</div>
            <div class="tool-detail-code-block" v-html="renderedToolArgs"></div>
          </div>
          <div v-if="formattedToolResult" class="tool-detail-section" data-copy-source="tool-result">
            <div class="tool-detail-label">{{ t("chat.result") }}</div>
            <div class="tool-detail-code-block" v-html="renderedToolResult"></div>
          </div>
        </div>
      </div>
    </template>
    <template v-else>
      <div
        v-if="message.role !== 'assistant' || hasVisibleMessageSurface"
        class="msg-body"
        :class="{
          'msg-body--outbound': message.role === 'user',
          'msg-body--long-user': isLongUserMessage,
        }"
      >
        <img
          v-if="message.role === 'assistant'"
          :src="assistantAvatarUrl"
          :alt="assistantName"
          class="msg-avatar"
        />
        <div class="msg-content" :class="[message.role, { 'msg-content--outbound': message.role === 'user' }]">
          <div
            v-if="hasVisibleMessageSurface"
            class="message-bubble"
            :class="{
              system: isSystem,
              'speech-playing': isPlayingThisMessage && !isPausedThisMessage,
              'has-header': showMessageHeader,
              'message-bubble--user': message.role === 'user',
              'message-bubble--user-palette-5': message.role === 'user',
              'message-bubble--user-long': isLongUserMessage,
            }"
          >
            <div v-if="showMessageHeader" class="message-bubble-header">
              <span class="message-bubble-name">{{ messageHeadTitle }}</span>
              <span class="message-bubble-status">{{ messageHeadStatus }}</span>
            </div>
            <div class="message-bubble-surface">
              <div v-if="hasAttachments" class="msg-attachments">
                <div
                  v-for="att in message.attachments"
                  :key="att.id"
                  class="msg-attachment"
                  :class="{ image: isImage(att.type) }"
                >
                  <template v-if="isImage(att.type) && att.url">
                    <img
                      :src="att.url"
                      :alt="att.name"
                      class="msg-attachment-thumb"
                      @click="previewUrl = att.url"
                    />
                  </template>
                  <template v-else>
                    <div class="msg-attachment-file" @click="handleAttachmentDownload(att)" style="cursor: pointer;" :title="t('download.downloadFile')">
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                      >
                        <path
                          d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
                        />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      <span class="att-name">{{ att.name }}</span>
                      <span class="att-size">{{ formatSize(att.size) }}</span>
                      <svg class="att-download-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                    </div>
                  </template>
                </div>
              </div>
              <div
                v-if="hasThinking"
                class="thinking-block"
                :class="{ expanded: thinkingExpanded }"
              >
                <div class="thinking-header" @click="toggleThinking">
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    class="thinking-chevron"
                    :class="{ rotated: thinkingExpanded }"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  <span class="thinking-icon">💭</span>
                  <span class="thinking-label">
                    {{
                      thinkingStreamingNow
                        ? t('chat.thinkingInProgress')
                        : t('chat.thinkingLabel')
                    }}
                  </span>
                  <span v-if="thinkingDurationMs !== null && thinkingDurationMs > 0" class="thinking-meta">
                    · {{ t('chat.thinkingDuration', { duration: formatDuration(thinkingDurationMs) }) }}
                  </span>
                  <span class="thinking-meta">
                    · {{ t('chat.thinkingChars', { count: thinkingCharCount }) }}
                  </span>
                </div>
                <div v-if="thinkingExpanded" class="thinking-body">
                  <pre v-if="renderThinkingAsPlainText" class="thinking-stream-text">{{ thinkingFullText }}</pre>
                  <MarkdownRenderer v-else :content="thinkingFullText" />
                </div>
              </div>
              <MarkdownRenderer
                v-if="parsedThinking.body"
                :content="parsedThinking.body"
                :class="{ 'with-streaming-cursor': showStreamingCursor }"
              />
            </div>
          </div>
          <div v-if="message.role !== 'assistant' || hasVisibleMessageSurface" class="message-meta">
            <span v-if="message.steered" class="queued-badge">{{ t('chat.messageSteered') }}</span>
            <span v-else-if="message.queued" class="queued-badge">{{ t('chat.messageQueued') }}</span>
            <div class="message-meta-hover">
              <button
                v-if="canPlaySpeech"
                class="speech-bubble-btn"
                :class="{ playing: isPlayingThisMessage, paused: isPausedThisMessage }"
                @click="handleSpeechToggle"
                :title="isPlayingThisMessage ? (isPausedThisMessage ? t('chat.resumeSpeech') : t('chat.pauseSpeech')) : t('chat.playSpeech')"
              >
                <svg v-if="!isPlayingThisMessage || isPausedThisMessage" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="6" y="4" width="4" height="16"/>
                  <rect x="14" y="4" width="4" height="16"/>
                </svg>
              </button>
              <button
                v-if="copyableContent"
                class="copy-bubble-btn"
                @click="copyBubbleContent"
                :title="t('chat.copyBubble')"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
              </button>
              <span class="message-time">{{ timeStr }}</span>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
  <Teleport to="body">
    <div v-if="previewUrl" class="image-preview-overlay" @click.self="previewUrl = null">
      <img :src="previewUrl" class="image-preview-img" @click="previewUrl = null" />
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.message {
  --assistant-avatar-size: 48px;
  --assistant-avatar-space: 58px;
  --assistant-body-max: 840px;
  --assistant-bubble-max: calc(var(--assistant-body-max) - var(--assistant-avatar-space));

  display: flex;
  flex-direction: column;
  position: relative;

  &.user {
    align-items: flex-end;

    .msg-body {
      max-width: min(100%, 760px);

      &.msg-body--long-user {
        max-width: min(100%, 860px);
      }
    }

    .msg-content.user {
      align-items: flex-end;
    }

    .message-bubble {
      border: 1px solid rgba(37, 99, 235, 0.22);
      background: linear-gradient(
        180deg,
        rgba(37, 99, 235, 0.95) 0%,
        rgba(30, 86, 205, 0.95) 100%
      );
      box-shadow: 0 1px 0 rgba(0, 0, 0, 0.1);

      .dark & {
        border-color: rgba(37, 99, 235, 0.22);
        background: linear-gradient(
          180deg,
          rgba(37, 99, 235, 0.95) 0%,
          rgba(30, 86, 205, 0.95) 100%
        );
        box-shadow: 0 1px 0 rgba(0, 0, 0, 0.1);
      }
    }

    .message-bubble-surface {
      color: #f4f4f5;

      .dark & {
        color: #f4f4f5;
      }
    }

    .message-bubble--user-long {
      border-color: rgba(37, 99, 235, 0.22);
      border-left: 3px solid rgba(37, 99, 235, 0.88);
      background: rgba(248, 250, 252, 0.92);
      box-shadow: 0 1px 0 rgba(15, 23, 42, 0.04);

      .message-bubble-surface {
        color: $text-primary;
      }

      .dark & {
        border-color: rgba(255, 255, 255, 0.10);
        border-left-color: rgba(37, 99, 235, 0.95);
        background: rgba(47, 47, 47, 0.96);
        box-shadow: 0 1px 0 rgba(0, 0, 0, 0.16);

        .message-bubble-surface {
          color: #f4f4f5;
        }
      }
    }
  }

  &.assistant {
    align-items: flex-start;

    .msg-body {
      max-width: min(100%, var(--assistant-body-max));
    }
  }

  &.tool {
    align-items: flex-start;

    .tool-card {
      margin-left: var(--assistant-avatar-space);
      width: min(calc(100% - var(--assistant-avatar-space)), var(--assistant-bubble-max));
    }
  }

  &.system {
    align-items: flex-start;

    .msg-body {
      max-width: min(100%, 760px);
    }

    .message-bubble.system {
      border-left: 3px solid $warning;
      background-color: rgba(var(--warning-rgb), 0.06);
    }
  }

  &.highlight {
    .message-bubble,
    .tool-card {
      box-shadow: 0 0 0 1px rgba(var(--accent-primary-rgb), 0.45);
    }
  }

  &.subagent {
    border-left: 2px solid rgba(var(--accent-primary-rgb), 0.35);
    padding-left: 10px;
  }
}

@keyframes gradient-flow {
  0% {
    background-position: 0% 50%;
  }
  50% {
    background-position: 100% 50%;
  }
  100% {
    background-position: 0% 50%;
  }
}

.msg-body {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
}

.msg-body--outbound {
  justify-content: flex-end;
}

.msg-avatar {
  width: var(--assistant-avatar-size);
  height: var(--assistant-avatar-size);
  min-width: var(--assistant-avatar-size);
  max-width: var(--assistant-avatar-size);
  min-height: var(--assistant-avatar-size);
  max-height: var(--assistant-avatar-size);
  aspect-ratio: 1 / 1;
  display: block;
  border-radius: 999px;
  flex-shrink: 0;
  margin-top: 2px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: rgba(0, 0, 0, 0.04);
  object-fit: cover;
  object-position: center;

  .dark & {
    border-color: rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.04);
  }
}

.msg-content {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.msg-content--outbound {
  align-items: flex-end;
  margin-left: auto;
}

.message-bubble {
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.58);
  overflow: hidden;
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.03);

  .dark & {
    border-color: rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.04);
    box-shadow: 0 1px 0 rgba(0, 0, 0, 0.18);
  }
}

.message-bubble--user {
  backdrop-filter: saturate(0.92);
}

.message-bubble--user-palette-5 {
  backdrop-filter: saturate(1.02);
}

.message-bubble-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px 8px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
  background: rgba(0, 0, 0, 0.015);
  color: $text-muted;
  font-size: 11px;

  .dark & {
    border-bottom-color: rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.03);
    color: #9aa0a6;
  }
}

.message-bubble-name {
  color: $text-secondary;
  font-weight: 650;

  .dark & {
    color: #d2d6dc;
  }
}

.message-bubble-status {
  white-space: nowrap;
}

.message-bubble-surface {
  padding: 12px 14px;
  font-size: 14px;
  line-height: 1.7;
  word-break: break-word;
  border-radius: 10px;
  max-width: 100%;
  position: relative;
  box-sizing: border-box;

  &.system {
    border-left: 3px solid $warning;
    border-radius: $radius-sm;
    max-width: 80%;
    background-color: rgba(var(--warning-rgb), 0.06);
  }

  &.speech-playing {
    box-shadow:
      0 0 0 2px #ff6b6b,
      0 0 10px rgba(255, 107, 107, 0.4),
      0 0 20px rgba(255, 107, 107, 0.2);
    animation: rainbow-glow 4s linear infinite;
  }
}

@keyframes rainbow-glow {
  0% {
    box-shadow:
      0 0 0 2px #ff6b6b,
      0 0 10px rgba(255, 107, 107, 0.4),
      0 0 20px rgba(255, 107, 107, 0.2);
  }
  16.66% {
    box-shadow:
      0 0 0 2px #feca57,
      0 0 10px rgba(254, 202, 87, 0.4),
      0 0 20px rgba(254, 202, 87, 0.2);
  }
  33.33% {
    box-shadow:
      0 0 0 2px #48dbfb,
      0 0 10px rgba(72, 219, 251, 0.4),
      0 0 20px rgba(72, 219, 251, 0.2);
  }
  50% {
    box-shadow:
      0 0 0 2px #ff9ff3,
      0 0 10px rgba(255, 159, 243, 0.4),
      0 0 20px rgba(255, 159, 243, 0.2);
  }
  66.66% {
    box-shadow:
      0 0 0 2px #54a0ff,
      0 0 10px rgba(84, 160, 255, 0.4),
      0 0 20px rgba(84, 160, 255, 0.2);
  }
  83.33% {
    box-shadow:
      0 0 0 2px #5f27cd,
      0 0 10px rgba(95, 39, 205, 0.4),
      0 0 20px rgba(95, 39, 205, 0.2);
  }
  100% {
    box-shadow:
      0 0 0 2px #ff6b6b,
      0 0 10px rgba(255, 107, 107, 0.4),
      0 0 20px rgba(255, 107, 107, 0.2);
  }
}

.msg-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}

.msg-attachment {
  border-radius: 10px;
  overflow: hidden;
  background-color: rgba(0, 0, 0, 0.03);
  border: 1px solid rgba(0, 0, 0, 0.06);

  .dark & {
    background-color: rgba(255, 255, 255, 0.03);
    border-color: rgba(255, 255, 255, 0.08);
  }

  &.image {
    max-width: 220px;
  }
}

.msg-attachment-thumb {
  display: block;
  max-width: 220px;
  max-height: 180px;
  object-fit: contain;
  cursor: pointer;
}

.msg-attachment-file {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  font-size: 12px;
  color: $text-secondary;

  .att-name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 160px;
  }

  .att-size {
    color: $text-muted;
    font-size: 11px;
    flex-shrink: 0;
  }
}

.thinking-block {
  margin-bottom: 10px;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.02);
  overflow: hidden;

  .dark & {
    border-color: rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.035);
  }

  .thinking-header {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    font-size: 12px;
    color: $text-muted;
    cursor: pointer;
    padding: 8px 10px;
    user-select: none;
    border-bottom: 1px solid transparent;

    &:hover {
      background: rgba(0, 0, 0, 0.02);

      .dark & {
        background: rgba(255, 255, 255, 0.02);
      }
    }
  }

  &.expanded .thinking-header {
    border-bottom-color: rgba(0, 0, 0, 0.05);

    .dark & {
      border-bottom-color: rgba(255, 255, 255, 0.08);
    }
  }

  .thinking-chevron {
    flex-shrink: 0;
    transition: transform 0.15s ease;

    &.rotated {
      transform: rotate(90deg);
    }
  }

  .thinking-icon {
    font-size: 11px;
    flex-shrink: 0;
  }

  .thinking-label {
    font-weight: 600;
    flex-shrink: 0;
    color: $text-secondary;

    .dark & {
      color: #d2d6dc;
    }
  }

  .thinking-meta {
    color: $text-muted;
    font-variant-numeric: tabular-nums;
  }

  .thinking-body {
    padding: 9px 10px;
    font-size: 13px;
    color: $text-secondary;

    .dark & {
      color: #cdd1d6;
    }

    :deep(p) {
      margin: 0.3em 0;
    }
  }

  .thinking-stream-text {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: inherit;
  }
}

.message-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding: 0 4px;
}

.message-meta-hover {
  display: flex;
  align-items: center;
  gap: 6px;
  opacity: 0;
  transition: opacity 0.15s ease;

  .message:hover & {
    opacity: 1;
  }

  // 移动端一直显示按钮
  @media (max-width: 768px) {
    opacity: 1;
  }
}

.copy-bubble-btn,
.speech-bubble-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: $text-muted;
  cursor: pointer;
  border-radius: $radius-sm;
  padding: 0;
  transition: color 0.15s ease, background 0.15s ease;

  &:hover {
    color: $text-secondary;
    background: rgba(0, 0, 0, 0.06);
  }

  .dark & {
    color: #999999;

    &:hover {
      color: #cccccc;
      background: rgba(255, 255, 255, 0.1);
    }
  }
}

.queued-badge {
  display: inline-flex;
  align-items: center;
  margin-right: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(var(--accent-primary-rgb), 0.12);
  color: $accent-primary;
  font-size: 10px;
}

.speech-bubble-btn {
  &.playing {
    color: var(--accent-primary);
    animation: pulse 1.5s ease-in-out infinite;

    &.paused {
      animation: none;
      opacity: 0.6;
    }
  }
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

.message-time {
  font-size: 11px;
  color: $text-muted;
  user-select: none;

  .dark & {
    color: #999999;
  }
}

.tool-card {
  width: min(100%, var(--assistant-bubble-max));
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.58);
  overflow: hidden;
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.03);

  .dark & {
    border-color: rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.03);
    box-shadow: 0 1px 0 rgba(0, 0, 0, 0.18);
  }
}

.tool-line {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: $text-muted;
  padding: 10px 12px;

  &.expandable {
    cursor: pointer;

    &:hover {
      background: rgba(0, 0, 0, 0.02);

      .dark & {
        background: rgba(255, 255, 255, 0.02);
      }
    }
  }
}

.tool-summary {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
}

.tool-name {
  font-family: $font-code;
  flex-shrink: 0;
  color: $text-secondary;

  .dark & {
    color: #e5e7eb;
  }
}

.tool-preview {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $text-muted;
}

.tool-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1;

  &.done {
    color: #15803d;
    background: rgba(74, 222, 128, 0.14);

    .dark & {
      color: #86efac;
      background: rgba(74, 222, 128, 0.14);
    }
  }

  &.error {
    color: $error;
    background: rgba(var(--error-rgb), 0.14);
  }

  &.running {
    color: #b45309;
    background: rgba(251, 191, 36, 0.18);

    .dark & {
      color: #fde68a;
      background: rgba(251, 191, 36, 0.16);
    }
  }
}

.tool-chevron {
  flex-shrink: 0;
  transition: transform 0.15s ease;

  &.rotated {
    transform: rotate(90deg);
  }
}

.tool-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  flex-shrink: 0;
}

.tool-details {
  border-top: 1px solid rgba(0, 0, 0, 0.05);
  padding: 12px;

  .dark & {
    border-top-color: rgba(255, 255, 255, 0.08);
  }
}

.tool-detail-section {
  margin-bottom: 10px;

  &:last-child {
    margin-bottom: 0;
  }
}

.tool-detail-label {
  font-size: 10px;
  font-weight: 700;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 6px;
}

.tool-detail-code-block {
  :deep(.hljs-code-block) {
    margin: 0;
  }

  :deep(.code-header) {
    background: rgba(0, 0, 0, 0.02);

    .dark & {
      background: rgba(255, 255, 255, 0.03);
    }
  }

  :deep(code.hljs) {
    font-size: 11px;
    max-height: 300px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.with-streaming-cursor {
  :deep(> :last-child)::after {
    content: "";
    display: inline-block;
    width: 2px;
    height: 1em;
    margin-left: 2px;
    background-color: $text-muted;
    border-radius: 1px;
    vertical-align: text-bottom;
    animation: blink 0.8s infinite;
  }
}

@keyframes blink {
  0%,
  50% {
    opacity: 1;
  }
  51%,
  100% {
    opacity: 0;
  }
}

.image-preview-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.image-preview-img {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: 4px;
}

@media (max-width: $breakpoint-mobile) {
  .message.user .msg-body,
  .message.assistant .msg-body,
  .message.system .msg-body,
  .tool-card {
    max-width: 100%;
    width: 100%;
  }

  .message.tool .tool-card {
    margin-left: 0;
    width: 100%;
  }
}
</style>
