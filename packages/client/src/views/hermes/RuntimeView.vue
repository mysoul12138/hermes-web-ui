<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchRuntimeStatus, type RuntimeRunSnapshot, type RuntimeStatusSnapshot } from '@/api/hermes/runtime'

const { t } = useI18n()
const snapshot = ref<RuntimeStatusSnapshot | null>(null)
const loading = ref(false)
const error = ref('')
let refreshTimer: ReturnType<typeof setInterval> | null = null

const hasRuns = computed(() => (snapshot.value?.runs.length || 0) > 0)
const hasSessions = computed(() => (snapshot.value?.sessions.length || 0) > 0)

function formatDuration(ms: number | null | undefined) {
  if (ms == null) return t('runtime.notAvailable')
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    const restMinutes = minutes % 60
    return `${hours}h ${restMinutes}m`
  }
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function formatTime(value: number | null | undefined) {
  if (!value) return t('runtime.notAvailable')
  return new Date(value).toLocaleTimeString()
}

function statusLabel(run: RuntimeRunSnapshot) {
  return t(`runtime.runStatus.${run.status}`)
}

async function loadStatus() {
  loading.value = true
  error.value = ''
  try {
    snapshot.value = await fetchRuntimeStatus()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadStatus()
  refreshTimer = setInterval(loadStatus, 5000)
})

onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>

<template>
  <div class="runtime-view">
    <header class="page-header">
      <div>
        <h2 class="header-title">{{ t('runtime.title') }}</h2>
        <p class="header-subtitle">{{ t('runtime.subtitle') }}</p>
      </div>
      <NButton size="small" quaternary :loading="loading" @click="loadStatus">
        {{ t('runtime.refresh') }}
      </NButton>
    </header>

    <main class="runtime-content">
      <div v-if="error" class="runtime-error">{{ error }}</div>
      <div v-if="loading && !snapshot" class="runtime-empty">{{ t('common.loading') }}</div>

      <template v-if="snapshot">
        <section class="stat-grid">
          <article class="stat-card">
            <span class="stat-label">{{ t('runtime.bridgeEnabled') }}</span>
            <strong>{{ snapshot.bridge.enabled ? t('runtime.enabled') : t('runtime.disabled') }}</strong>
          </article>
          <article class="stat-card">
            <span class="stat-label">{{ t('runtime.activeRuns') }}</span>
            <strong>{{ snapshot.bridge.activeRuns }}</strong>
          </article>
          <article class="stat-card">
            <span class="stat-label">{{ t('runtime.trackedSessions') }}</span>
            <strong>{{ snapshot.bridge.trackedWebSessions }}</strong>
          </article>
          <article class="stat-card">
            <span class="stat-label">{{ t('runtime.pendingResolutions') }}</span>
            <strong>{{ snapshot.bridge.pendingPersistentResolutions }}</strong>
          </article>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h3>{{ t('runtime.runsTitle') }}</h3>
            <span>{{ t('runtime.lastUpdated', { time: formatTime(snapshot.capturedAt) }) }}</span>
          </div>
          <div v-if="!hasRuns" class="runtime-empty">{{ t('runtime.noRuns') }}</div>
          <div v-else class="run-list">
            <article v-for="run in snapshot.runs" :key="run.runId" class="run-card">
              <div class="run-topline">
                <strong>{{ statusLabel(run) }}</strong>
                <code>{{ run.runId }}</code>
              </div>
              <div class="run-meta">
                <span>{{ t('runtime.webSession') }}: <code>{{ run.webSessionId }}</code></span>
                <span>{{ t('runtime.bridgeSession') }}: <code>{{ run.bridgeSessionId }}</code></span>
                <span>{{ t('runtime.persistentSession') }}: <code>{{ run.persistentSessionId || t('runtime.notAvailable') }}</code></span>
                <span>{{ t('runtime.lastEvent') }}: <code>{{ run.lastEvent || t('runtime.notAvailable') }}</code></span>
                <span>{{ t('runtime.age') }}: {{ formatDuration(run.ageMs) }}</span>
                <span>{{ t('runtime.idle') }}: {{ formatDuration(run.idleMs) }}</span>
                <span>{{ t('runtime.events') }}: {{ run.eventCount }}</span>
                <span>{{ t('runtime.contextTokens') }}: {{ run.contextInputTokens ?? t('runtime.notAvailable') }}</span>
              </div>
            </article>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h3>{{ t('runtime.sessionsTitle') }}</h3>
            <span>{{ snapshot.sessions.length }}</span>
          </div>
          <div v-if="!hasSessions" class="runtime-empty">{{ t('runtime.noSessions') }}</div>
          <div v-else class="session-table">
            <div class="session-row session-head">
              <span>{{ t('runtime.webSession') }}</span>
              <span>{{ t('runtime.bridgeSession') }}</span>
              <span>{{ t('runtime.persistentSession') }}</span>
              <span>{{ t('runtime.activeRun') }}</span>
            </div>
            <div v-for="session in snapshot.sessions" :key="session.webSessionId" class="session-row">
              <code>{{ session.webSessionId }}</code>
              <code>{{ session.bridgeSessionId }}</code>
              <code>{{ session.persistentSessionId || t('runtime.notAvailable') }}</code>
              <code>{{ session.activeRunId || t('runtime.notAvailable') }}</code>
            </div>
          </div>
        </section>
      </template>
    </main>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.runtime-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.page-header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 21px 20px;
  border-bottom: 1px solid $border-color;
}

.header-title {
  margin: 0;
  color: $text-primary;
  font-size: 16px;
  font-weight: 600;
}

.header-subtitle {
  margin: 6px 0 0;
  color: $text-muted;
  font-size: 13px;
}

.runtime-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  max-width: 1120px;
  width: 100%;
  margin: 0 auto;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.stat-card,
.panel,
.run-card {
  border: 1px solid $border-light;
  border-radius: $radius-md;
  background: $bg-primary;
}

.stat-card {
  padding: 16px;

  strong {
    display: block;
    margin-top: 8px;
    color: $text-primary;
    font-size: 24px;
  }
}

.stat-label,
.panel-header span,
.run-meta {
  color: $text-muted;
  font-size: 12px;
}

.panel {
  padding: 16px;
  margin-bottom: 16px;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;

  h3 {
    margin: 0;
    color: $text-primary;
    font-size: 14px;
    font-weight: 600;
  }
}

.run-list {
  display: grid;
  gap: 10px;
}

.run-card {
  padding: 12px;
  background: $bg-secondary;
}

.run-topline {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;

  strong {
    color: $text-primary;
  }
}

.run-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 12px;
}

.session-table {
  display: grid;
  gap: 1px;
  overflow-x: auto;
  border: 1px solid $border-light;
  border-radius: $radius-sm;
}

.session-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(160px, 1fr));
  gap: 12px;
  padding: 10px 12px;
  background: $bg-secondary;
  color: $text-muted;
  font-size: 12px;
}

.session-head {
  background: $bg-card;
  color: $text-secondary;
  font-weight: 600;
}

code {
  overflow: hidden;
  color: $text-secondary;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.runtime-empty,
.runtime-error {
  padding: 32px 0;
  text-align: center;
  color: $text-muted;
  font-size: 14px;
}

.runtime-error {
  color: $error;
}

@media (max-width: $breakpoint-mobile) {
  .page-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .stat-grid,
  .run-meta {
    grid-template-columns: 1fr;
  }
}
</style>
