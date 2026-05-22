<script setup lang="ts">
import { computed } from 'vue'
import multiavatar from '@multiavatar/multiavatar'
import type { KanbanProfileAvatarData } from '@/utils/hermes/kanban-assignees'

const props = withDefaults(defineProps<{
  name: string
  avatar?: KanbanProfileAvatarData | null
  size?: number
}>(), {
  size: 24,
})

const fallbackSeed = computed(() => props.name || 'default')
const generatedSvg = computed(() => multiavatar(props.avatar?.seed || fallbackSeed.value))
const style = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  flexBasis: `${props.size}px`,
}))
</script>

<template>
  <span class="kanban-profile-avatar-view" :style="style">
    <img
      v-if="avatar?.type === 'image' && avatar.dataUrl"
      class="kanban-profile-avatar-image"
      :src="avatar.dataUrl"
      alt=""
      draggable="false"
    >
    <span v-else class="kanban-profile-avatar-svg" v-html="generatedSvg" />
  </span>
</template>

<style scoped>
.kanban-profile-avatar-view {
  display: inline-flex;
  flex: 0 0 auto;
  border-radius: 50%;
  overflow: hidden;
  background: var(--bg-secondary);
}

.kanban-profile-avatar-image,
.kanban-profile-avatar-svg,
.kanban-profile-avatar-svg :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}

.kanban-profile-avatar-image {
  object-fit: cover;
}
</style>
