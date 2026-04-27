<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { NButton, NInput } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { PendingClarify } from '@/api/hermes/clarify'

interface Props {
  pending: PendingClarify
  submitting?: boolean
}

const props = defineProps<Props>()
const emit = defineEmits<{
  respond: [answer: string]
}>()

const { t } = useI18n()
const firstBtn = ref<any>(null)
const customAnswer = ref('')

const choices = computed(() => props.pending.choices || [])

function focusPrimary() {
  nextTick(() => {
    const candidate = firstBtn.value?.$el?.querySelector?.('button')
      || firstBtn.value?.$el
      || firstBtn.value
    candidate?.focus?.()
  })
}

function submitCustom() {
  const answer = customAnswer.value.trim()
  if (!answer) return
  emit('respond', answer)
}

function setFirstButton(el: any) {
  if (el) firstBtn.value = el
}

onMounted(focusPrimary)
watch(() => props.pending.request_id, () => {
  customAnswer.value = ''
  focusPrimary()
})
</script>

<template>
  <div
    class="clarify-prompt"
    role="alertdialog"
    aria-labelledby="clarify-heading"
    aria-describedby="clarify-question"
  >
    <div class="clarify-header">
      <span id="clarify-heading" class="clarify-title">{{ t('chat.clarifyTitle') }}</span>
    </div>

    <div id="clarify-question" class="clarify-question">{{ pending.question }}</div>

    <div v-if="choices.length" class="clarify-actions">
      <NButton
        v-for="(choice, index) in choices"
        :key="`${index}-${choice}`"
        :ref="index === 0 ? setFirstButton : undefined"
        size="small"
        :type="index === 0 ? 'primary' : 'default'"
        :loading="submitting && index === 0"
        :disabled="submitting"
        @click="emit('respond', choice)"
      >
        {{ choice }}
      </NButton>
    </div>

    <div class="clarify-custom">
      <NInput
        v-model:value="customAnswer"
        size="small"
        :disabled="submitting"
        :placeholder="t('chat.clarifyCustomPlaceholder')"
        @keydown.enter.prevent="submitCustom"
      />
      <NButton size="small" :disabled="submitting || !customAnswer.trim()" @click="submitCustom">
        {{ t('chat.clarifySend') }}
      </NButton>
    </div>

    <div v-if="submitting" class="clarify-status">{{ t('chat.clarifyResponding') }}</div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.clarify-prompt {
  margin-bottom: 10px;
  padding: 12px;
  border: 1px solid rgba(81, 151, 255, 0.35);
  border-radius: $radius-md;
  background: rgba(81, 151, 255, 0.08);
}

.clarify-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.clarify-title {
  font-size: 13px;
  font-weight: 700;
}

.clarify-question,
.clarify-status {
  font-size: 12px;
  color: $text-muted;
}

.clarify-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.clarify-custom {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.clarify-status {
  margin-top: 8px;
}
</style>
