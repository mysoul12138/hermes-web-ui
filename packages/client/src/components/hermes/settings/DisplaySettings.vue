<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NSwitch, NSelect, NInput, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/hermes/settings'
import { useTheme, type ThemeMode } from '@/composables/useTheme'
import { getApiKey, getBaseUrlValue } from '@/api/client'
import SettingRow from './SettingRow.vue'

const settingsStore = useSettingsStore()
const message = useMessage()
const { t } = useI18n()
const { mode, setMode } = useTheme()
const avatarInputRef = ref<HTMLInputElement | null>(null)
const ASSISTANT_AVATAR_MAX_BYTES = 10 * 1024 * 1024

const themeOptions = [
  { label: t('settings.display.themeLight'), value: 'light' },
  { label: t('settings.display.themeDark'), value: 'dark' },
  { label: t('settings.display.themeSystem'), value: 'system' },
]

const busyInputModeOptions = [
  { label: t('settings.display.busyInputModeQueue'), value: 'queue' },
  { label: t('settings.display.busyInputModeSteer'), value: 'steer' },
]

async function save(values: Record<string, any>) {
  try {
    await settingsStore.saveSection('display', values)
    message.success(t('settings.saved'))
  } catch (err: any) {
    message.error(t('settings.saveFailed'))
  }
}

function handleThemeChange(val: string) {
  const m = val as ThemeMode
  setMode(m)
  save({ skin: m })
}

function withAuthToken(url: string): string {
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return url
  const base = getBaseUrlValue()
  const resolved = url.startsWith('/') ? `${base}${url}` : url
  if (!resolved.includes('/api/')) return resolved
  const token = getApiKey()
  if (!token || resolved.includes('token=')) return resolved
  return `${resolved}${resolved.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}

const assistantAvatarUrl = computed(() => withAuthToken(settingsStore.display.assistant_avatar_url || '/logo.png'))
const assistantName = computed(() => settingsStore.display.assistant_name || 'Hermes')
const assistantNameDraft = ref(assistantName.value)

watch(assistantName, value => {
  assistantNameDraft.value = value
})

function saveAssistantName() {
  const next = assistantNameDraft.value.trim() || 'Hermes'
  assistantNameDraft.value = next
  if (next === assistantName.value) return
  void save({ assistant_name: next })
}

function openAvatarPicker() {
  avatarInputRef.value?.click()
}

function isSupportedAvatarFile(file: File): boolean {
  const name = file.name.toLowerCase()
  return file.type.startsWith('image/')
    || name.endsWith('.webp')
}

function isHeicAvatarFile(file: File): boolean {
  const name = file.name.toLowerCase()
  return name.endsWith('.heic') || name.endsWith('.heif') || /hei[cf]/i.test(file.type)
}

async function uploadAvatarFile(file: File): Promise<string> {
  const formData = new FormData()
  formData.append('file', file, file.name)
  const base = getBaseUrlValue()
  const token = getApiKey()
  const res = await fetch(`${base}/upload`, {
    method: 'POST',
    body: formData,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
  const data = await res.json() as { files?: Array<{ name: string; path: string }> }
  const uploaded = data.files?.[0]
  if (!uploaded?.path) throw new Error('Upload returned no file')
  return `/api/hermes/download?path=${encodeURIComponent(uploaded.path)}&name=${encodeURIComponent(uploaded.name || file.name)}`
}

async function handleAvatarChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (isHeicAvatarFile(file)) {
    message.error(t('settings.display.avatarHeicUnsupported'))
    return
  }
  if (!isSupportedAvatarFile(file)) {
    message.error(t('settings.display.avatarInvalid'))
    return
  }
  if (file.size > ASSISTANT_AVATAR_MAX_BYTES) {
    message.error(t('settings.display.avatarTooLarge'))
    return
  }
  try {
    const url = await uploadAvatarFile(file)
    await save({ assistant_avatar_url: url })
  } catch {
    message.error(t('settings.saveFailed'))
  }
}
</script>

<template>
  <section class="settings-section">
    <SettingRow :label="t('settings.display.theme')" :hint="t('settings.display.themeHint')">
      <NSelect :value="mode" :options="themeOptions" size="small" :consistent-menu-width="false" class="input-sm" @update:value="handleThemeChange" />
    </SettingRow>
    <SettingRow :label="t('settings.display.streaming')" :hint="t('settings.display.streamingHint')">
      <NSwitch :value="settingsStore.display.streaming" @update:value="v => save({ streaming: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.display.compact')" :hint="t('settings.display.compactHint')">
      <NSwitch :value="settingsStore.display.compact" @update:value="v => save({ compact: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.display.showReasoning')" :hint="t('settings.display.showReasoningHint')">
      <NSwitch :value="settingsStore.display.show_reasoning" @update:value="v => save({ show_reasoning: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.display.assistantAvatar')" :hint="t('settings.display.assistantAvatarHint')">
      <div class="avatar-control">
        <img :src="assistantAvatarUrl" alt="" class="avatar-preview" />
        <input
          ref="avatarInputRef"
          type="file"
          accept="image/*,.webp"
          class="avatar-input"
          @change="handleAvatarChange"
        />
        <NButton size="small" @click="openAvatarPicker">
          {{ t('settings.display.uploadAvatar') }}
        </NButton>
        <NButton
          size="small"
          tertiary
          :disabled="!settingsStore.display.assistant_avatar_url"
          @click="save({ assistant_avatar_url: '' })"
        >
          {{ t('settings.display.resetAvatar') }}
        </NButton>
      </div>
    </SettingRow>
    <SettingRow :label="t('settings.display.assistantName')" :hint="t('settings.display.assistantNameHint')">
      <NInput
        v-model:value="assistantNameDraft"
        size="small"
        class="input-sm"
        :placeholder="t('settings.display.assistantNamePlaceholder')"
        @blur="saveAssistantName"
        @keyup.enter="saveAssistantName"
      />
    </SettingRow>
    <SettingRow :label="t('settings.display.showCost')" :hint="t('settings.display.showCostHint')">
      <NSwitch :value="settingsStore.display.show_cost" @update:value="v => save({ show_cost: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.display.inlineDiffs')" :hint="t('settings.display.inlineDiffsHint')">
      <NSwitch :value="settingsStore.display.inline_diffs" @update:value="v => save({ inline_diffs: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.display.bellOnComplete')" :hint="t('settings.display.bellOnCompleteHint')">
      <NSwitch :value="settingsStore.display.bell_on_complete" @update:value="v => save({ bell_on_complete: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.display.busyInputMode')" :hint="t('settings.display.busyInputModeHint')">
      <NSelect :value="settingsStore.display.busy_input_mode || 'queue'" :options="busyInputModeOptions" size="small" :consistent-menu-width="false" class="input-sm" @update:value="v => save({ busy_input_mode: v })" />
    </SettingRow>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.settings-section {
  margin-top: 16px;
}

.avatar-control {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.avatar-preview {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid $border-color;
}

.avatar-input {
  display: none;
}
</style>
