<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NSwitch, NSelect, NInput, NModal, NSlider, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/hermes/settings'
import { useTheme, type ThemeMode } from '@/composables/useTheme'
import { getApiKey, getBaseUrlValue } from '@/api/client'
import { withAuthToken } from '@/custom/utils/auth-url'
import SettingRow from './SettingRow.vue'

const settingsStore = useSettingsStore()
const message = useMessage()
const { t } = useI18n()
const { mode, setMode } = useTheme()
const avatarInputRef = ref<HTMLInputElement | null>(null)
const avatarCropStageRef = ref<HTMLElement | null>(null)
const ASSISTANT_AVATAR_MAX_BYTES = 10 * 1024 * 1024
const ASSISTANT_AVATAR_CANVAS_SIZE = 512
const AVATAR_CROP_INITIAL_ZOOM = 1.18

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

const assistantAvatarUrl = computed(() => withAuthToken(settingsStore.display.assistant_avatar_url || '/logo.png'))
const assistantName = computed(() => settingsStore.display.assistant_name || 'Hermes')
const assistantNameDraft = ref(assistantName.value)
const avatarUploading = ref(false)
const avatarCropVisible = ref(false)
const avatarCropFile = ref<File | null>(null)
const avatarCropImageUrl = ref('')
const avatarCropNaturalWidth = ref(0)
const avatarCropNaturalHeight = ref(0)
const avatarCropX = ref(0)
const avatarCropY = ref(0)
const avatarCropZoom = ref(AVATAR_CROP_INITIAL_ZOOM)

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

function isSvgAvatarFile(file: File): boolean {
  return file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')
}

async function loadImageElement(url: string): Promise<HTMLImageElement> {
  const img = new Image()
  img.decoding = 'async'
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = url
  })
  return img
}

async function readImageElement(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file)
  try {
    return await loadImageElement(url)
  } finally {
    URL.revokeObjectURL(url)
  }
}

const avatarCropMaxSize = computed(() =>
  Math.min(avatarCropNaturalWidth.value, avatarCropNaturalHeight.value),
)

const avatarCropSize = computed(() => {
  const maxSize = avatarCropMaxSize.value
  if (!maxSize) return 0
  return maxSize / avatarCropZoom.value
})

const avatarCropFrameStyle = computed(() => {
  const width = avatarCropNaturalWidth.value
  const height = avatarCropNaturalHeight.value
  const size = avatarCropSize.value
  if (!width || !height || !size) return {}
  return {
    left: `${(avatarCropX.value / width) * 100}%`,
    top: `${(avatarCropY.value / height) * 100}%`,
    width: `${(size / width) * 100}%`,
    height: `${(size / height) * 100}%`,
  }
})

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function centerAvatarCrop(zoom = avatarCropZoom.value) {
  const maxSize = avatarCropMaxSize.value
  if (!maxSize) return
  const nextSize = maxSize / zoom
  avatarCropX.value = Math.round((avatarCropNaturalWidth.value - nextSize) / 2)
  avatarCropY.value = Math.round((avatarCropNaturalHeight.value - nextSize) / 2)
}

function setAvatarCropZoom(value: number | [number, number]) {
  if (Array.isArray(value)) return
  const oldSize = avatarCropSize.value || avatarCropMaxSize.value
  const centerX = avatarCropX.value + oldSize / 2
  const centerY = avatarCropY.value + oldSize / 2
  avatarCropZoom.value = value
  const nextSize = avatarCropSize.value
  avatarCropX.value = clamp(centerX - nextSize / 2, 0, avatarCropNaturalWidth.value - nextSize)
  avatarCropY.value = clamp(centerY - nextSize / 2, 0, avatarCropNaturalHeight.value - nextSize)
}

function resetAvatarCropper() {
  if (avatarCropImageUrl.value) URL.revokeObjectURL(avatarCropImageUrl.value)
  avatarCropVisible.value = false
  avatarCropFile.value = null
  avatarCropImageUrl.value = ''
  avatarCropNaturalWidth.value = 0
  avatarCropNaturalHeight.value = 0
  avatarCropX.value = 0
  avatarCropY.value = 0
  avatarCropZoom.value = AVATAR_CROP_INITIAL_ZOOM
}

async function openAvatarCropper(file: File) {
  const url = URL.createObjectURL(file)
  try {
    const img = await loadImageElement(url)
    avatarCropFile.value = file
    avatarCropImageUrl.value = url
    avatarCropNaturalWidth.value = img.naturalWidth || img.width
    avatarCropNaturalHeight.value = img.naturalHeight || img.height
    avatarCropZoom.value = AVATAR_CROP_INITIAL_ZOOM
    centerAvatarCrop(AVATAR_CROP_INITIAL_ZOOM)
    avatarCropVisible.value = true
  } catch (err) {
    URL.revokeObjectURL(url)
    throw err
  }
}

function startAvatarCropDrag(event: PointerEvent) {
  const stage = avatarCropStageRef.value
  const size = avatarCropSize.value
  if (!stage || !size) return
  const rect = stage.getBoundingClientRect()
  if (!rect.width || !rect.height) return
  const startClientX = event.clientX
  const startClientY = event.clientY
  const startX = avatarCropX.value
  const startY = avatarCropY.value
  const move = (moveEvent: PointerEvent) => {
    const dx = ((moveEvent.clientX - startClientX) / rect.width) * avatarCropNaturalWidth.value
    const dy = ((moveEvent.clientY - startClientY) / rect.height) * avatarCropNaturalHeight.value
    avatarCropX.value = clamp(startX + dx, 0, avatarCropNaturalWidth.value - size)
    avatarCropY.value = clamp(startY + dy, 0, avatarCropNaturalHeight.value - size)
  }
  const stop = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop)
  window.addEventListener('pointercancel', stop)
}

async function prepareAvatarUploadFile(file: File, crop?: { x: number; y: number; size: number }): Promise<File> {
  if (isSvgAvatarFile(file)) return file

  const img = await readImageElement(file)
  const naturalWidth = img.naturalWidth || img.width
  const naturalHeight = img.naturalHeight || img.height
  const sourceSize = crop?.size || Math.min(naturalWidth, naturalHeight)
  if (!sourceSize) throw new Error('Invalid image dimensions')

  const sourceX = crop ? crop.x : Math.max(0, Math.floor((naturalWidth - sourceSize) / 2))
  const sourceY = crop ? crop.y : Math.max(0, Math.floor((naturalHeight - sourceSize) / 2))
  const canvas = document.createElement('canvas')
  canvas.width = ASSISTANT_AVATAR_CANVAS_SIZE
  canvas.height = ASSISTANT_AVATAR_CANVAS_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is not available')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(
    img,
    sourceX,
    sourceY,
    sourceSize,
    sourceSize,
    0,
    0,
    ASSISTANT_AVATAR_CANVAS_SIZE,
    ASSISTANT_AVATAR_CANVAS_SIZE,
  )

  const blob = await new Promise<Blob | null>(resolve => {
    canvas.toBlob(resolve, 'image/webp', 0.94)
  })
  if (!blob) throw new Error('Failed to prepare avatar')
  const baseName = file.name.replace(/\.[^.]+$/, '') || 'assistant-avatar'
  return new File([blob], `${baseName}-avatar.webp`, { type: 'image/webp' })
}

async function uploadAvatarFile(file: File, crop?: { x: number; y: number; size: number }): Promise<string> {
  const uploadFile = await prepareAvatarUploadFile(file, crop)
  const formData = new FormData()
  formData.append('file', uploadFile, uploadFile.name)
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
  return `/api/hermes/download?path=${encodeURIComponent(uploaded.path)}&name=${encodeURIComponent(uploaded.name || uploadFile.name)}`
}

async function saveAvatarFile(file: File, crop?: { x: number; y: number; size: number }) {
  avatarUploading.value = true
  try {
    const url = await uploadAvatarFile(file, crop)
    await save({ assistant_avatar_url: url })
  } finally {
    avatarUploading.value = false
  }
}

async function confirmAvatarCrop() {
  const file = avatarCropFile.value
  const size = avatarCropSize.value
  if (!file || !size) return
  try {
    await saveAvatarFile(file, {
      x: Math.round(avatarCropX.value),
      y: Math.round(avatarCropY.value),
      size: Math.round(size),
    })
    resetAvatarCropper()
  } catch {
    message.error(t('settings.saveFailed'))
  }
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
    if (isSvgAvatarFile(file)) {
      await saveAvatarFile(file)
      return
    }
    await openAvatarCropper(file)
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
        <NButton size="small" :loading="avatarUploading" @click="openAvatarPicker">
          {{ t('settings.display.uploadAvatar') }}
        </NButton>
        <NButton
          size="small"
          tertiary
          :disabled="!settingsStore.display.assistant_avatar_url || avatarUploading"
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
  <NModal
    v-model:show="avatarCropVisible"
    preset="dialog"
    :title="t('settings.display.avatarCropTitle')"
    class="avatar-crop-modal"
    :mask-closable="!avatarUploading"
    @after-leave="resetAvatarCropper"
  >
    <div class="avatar-cropper">
      <div
        ref="avatarCropStageRef"
        class="avatar-crop-stage"
        @pointerdown.prevent="startAvatarCropDrag"
      >
        <img :src="avatarCropImageUrl" alt="" class="avatar-crop-image" draggable="false" />
        <div class="avatar-crop-shade"></div>
        <div class="avatar-crop-frame" :style="avatarCropFrameStyle">
          <span class="avatar-crop-frame-ring"></span>
        </div>
      </div>
      <div class="avatar-crop-controls">
        <span class="avatar-crop-label">{{ t('settings.display.avatarCropZoom') }}</span>
        <NSlider
          :value="avatarCropZoom"
          :min="1"
          :max="4"
          :step="0.01"
          :tooltip="false"
          @update:value="setAvatarCropZoom"
        />
      </div>
      <div class="avatar-crop-actions">
        <NButton size="small" tertiary :disabled="avatarUploading" @click="resetAvatarCropper">
          {{ t('common.cancel') }}
        </NButton>
        <NButton size="small" type="primary" :loading="avatarUploading" @click="confirmAvatarCrop">
          {{ t('settings.display.avatarCropApply') }}
        </NButton>
      </div>
    </div>
  </NModal>
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
  width: 48px;
  height: 48px;
  min-width: 48px;
  max-width: 48px;
  min-height: 48px;
  max-height: 48px;
  aspect-ratio: 1 / 1;
  display: block;
  border-radius: 50%;
  object-fit: cover;
  object-position: center;
  border: 1px solid $border-color;
}

.avatar-input {
  display: none;
}

.avatar-crop-modal {
  width: min(560px, calc(100vw - 32px));
}

.avatar-cropper {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.avatar-crop-stage {
  position: relative;
  width: 100%;
  max-height: min(58vh, 460px);
  overflow: hidden;
  border-radius: 8px;
  background: #111;
  cursor: grab;
  touch-action: none;
  user-select: none;

  &:active {
    cursor: grabbing;
  }
}

.avatar-crop-image {
  display: block;
  width: 100%;
  height: auto;
  max-height: min(58vh, 460px);
  object-fit: contain;
  pointer-events: none;
  user-select: none;
}

.avatar-crop-shade {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.38);
  pointer-events: none;
}

.avatar-crop-frame {
  position: absolute;
  border: 2px solid rgba(255, 255, 255, 0.96);
  box-shadow: 0 0 0 999px rgba(0, 0, 0, 0.42);
  pointer-events: none;
}

.avatar-crop-frame-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  box-shadow:
    inset 0 0 0 1px rgba(0, 0, 0, 0.35),
    0 0 0 1px rgba(0, 0, 0, 0.22);
}

.avatar-crop-controls {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
}

.avatar-crop-label {
  color: $text-secondary;
  font-size: 12px;
}

.avatar-crop-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
