<template>
  <div v-if="visible" class="focus-section-card category-card">
    <div class="focus-section-header">
      <div>
        <h3>{{ title }}</h3>
        <p>{{ description }}</p>
      </div>
      <span class="focus-badge">{{ rooms.length }}</span>
    </div>

    <div class="focus-card-list">
      <div v-if="rooms.length === 0" class="focus-empty compact">
        <h4>{{ emptyTitle }}</h4>
        <p>{{ emptyDescription }}</p>
      </div>

      <button
        v-for="focusRoom in rooms"
        :key="focusRoom.room_id"
        class="focus-task focus-room-link"
        :data-concluded="concluded ? 'true' : undefined"
        :data-selected="selectedRoomId === focusRoom.room_id"
        :aria-pressed="selectedRoomId === focusRoom.room_id"
        :aria-label="`Inspect ${focusRoom.display_name} ${concluded ? 'shared result' : 'room audit'} details`"
        aria-controls="focus-room-detail-panel"
        type="button"
        @click="emit('select', focusRoom.room_id)"
      >
        <div>
          <strong>{{ focusRoom.display_name }}</strong>
          <span>{{ roomSubtitle(focusRoom) }}</span>
        </div>
        <small>{{ concluded ? 'concluded' : focusRoom.focus_status || 'active' }}</small>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { FocusRoomInfo } from '@/composables/useRoom'

const props = defineProps<{
  title: string
  description: string
  emptyTitle: string
  emptyDescription: string
  rooms: readonly FocusRoomInfo[]
  selectedRoomId: string | null
  concluded?: boolean
  showWhenEmpty?: boolean
}>()

const emit = defineEmits<{
  select: [roomId: string]
}>()

const visible = computed(() => props.showWhenEmpty || props.rooms.length > 0)

function roomSubtitle(focusRoom: FocusRoomInfo): string {
  if (props.concluded) {
    return focusRoom.conclusion_summary || focusRoom.source_task_id || focusRoom.room_id
  }
  return focusRoom.source_task_id || 'No linked task yet'
}
</script>
