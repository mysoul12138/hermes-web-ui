<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ApprovalChoice, PendingApproval } from '@/api/hermes/approval'

interface Props {
  pending: PendingApproval
  pendingCount: number
  submitting?: boolean
}

const props = defineProps<Props>()
const emit = defineEmits<{
  approve: [choice: ApprovalChoice]
}>()

const { t } = useI18n()
const onceBtn = ref<any>(null)

const mergedDescription = computed(() => {
  if (props.pending.description?.trim()) return props.pending.description.trim()
  return t('chat.approvalDangerousCommand')
})

const counterText = computed(() => {
  if (props.pendingCount <= 1) return ''
  return t('chat.approvalPendingCount', { current: 1, total: props.pendingCount })
})

function focusPrimaryButton() {
  nextTick(() => {
    const candidate = onceBtn.value?.$el?.querySelector?.('button')
      || onceBtn.value?.$el
      || onceBtn.value
    candidate?.focus?.()
  })
}

onMounted(focusPrimaryButton)
watch(() => props.pending.approval_id, focusPrimaryButton)
</script>

<template>
  <div
    class="approval-prompt"
    role="alertdialog"
    aria-labelledby="approval-heading"
    aria-describedby="approval-desc"
  >
    <div class="approval-header">
      <span id="approval-heading" class="approval-title">{{ t('chat.approvalTitle') }}</span>
      <span v-if="counterText" class="approval-counter">{{ counterText }}</span>
    </div>

    <div id="approval-desc" class="approval-desc">{{ mergedDescription }}</div>
    <pre v-if="pending.command" class="approval-command">{{ pending.command }}</pre>
    <div v-if="submitting" class="approval-status">{{ t('chat.approvalResponding') }}</div>

    <div class="approval-actions">
      <NButton
        ref="onceBtn"
        type="primary"
        size="small"
        :loading="submitting"
        :disabled="submitting"
        @click="emit('approve', 'once')"
      >
        {{ t('chat.approvalAllowOnce') }}
      </NButton>
      <NButton size="small" :disabled="submitting" @click="emit('approve', 'session')">
        {{ t('chat.approvalAllowSession') }}
      </NButton>
      <NButton size="small" :disabled="submitting" @click="emit('approve', 'always')">
        {{ t('chat.approvalAllowAlways') }}
      </NButton>
      <NButton size="small" type="error" :disabled="submitting" @click="emit('approve', 'deny')">
        {{ t('chat.approvalDeny') }}
      </NButton>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.approval-prompt {
  margin-bottom: 10px;
  padding: 12px;
  border: 1px solid rgba(232, 93, 74, 0.35);
  border-radius: $radius-md;
  background: rgba(232, 93, 74, 0.08);
}

.approval-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.approval-title {
  font-size: 13px;
  font-weight: 700;
}

.approval-counter,
.approval-status,
.approval-desc {
  font-size: 12px;
  color: $text-muted;
}

.approval-status {
  margin-top: 8px;
}

.approval-command {
  margin: 8px 0 0;
  padding: 10px;
  border-radius: $radius-sm;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  background: rgba(0, 0, 0, 0.18);
  font-size: 12px;
}

.approval-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
</style>
