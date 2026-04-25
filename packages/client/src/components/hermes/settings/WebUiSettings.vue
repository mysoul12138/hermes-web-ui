<script setup lang="ts">
import { computed } from 'vue'
import { NSwitch, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/hermes/settings'
import SettingRow from './SettingRow.vue'

const settingsStore = useSettingsStore()
const message = useMessage()
const { t } = useI18n()

const bridgeEnabled = computed(() =>
  typeof settingsStore.webui.bridge_enabled === 'boolean'
    ? settingsStore.webui.bridge_enabled
    : !!settingsStore.webui.bridge_effective_enabled,
)
const bridgeUsesEnvDefault = computed(() =>
  settingsStore.webui.bridge_env_enabled && typeof settingsStore.webui.bridge_enabled !== 'boolean',
)

async function saveBridgeEnabled(value: boolean) {
  try {
    await settingsStore.saveSection('webui', { bridge_enabled: value })
    message.success(t('settings.saved'))
  } catch {
    message.error(t('settings.saveFailed'))
  }
}
</script>

<template>
  <section class="settings-section">
    <SettingRow
      :label="t('settings.webui.bridge')"
      :hint="bridgeUsesEnvDefault ? t('settings.webui.bridgeEnvDefaultHint') : t('settings.webui.bridgeHint')"
    >
      <div class="bridge-control">
        <NSwitch
          :value="bridgeEnabled"
          @update:value="saveBridgeEnabled"
        />
        <NTag v-if="bridgeUsesEnvDefault" size="small" type="info" round>
          {{ t('settings.webui.bridgeEnvDefault') }}
        </NTag>
      </div>
    </SettingRow>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.settings-section {
  margin-top: 16px;
}

.bridge-control {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
</style>
