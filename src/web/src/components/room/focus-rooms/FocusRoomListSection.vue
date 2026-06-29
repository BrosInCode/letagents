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
        <div class="focus-room-link-copy">
          <span
            v-if="focusRoom.git_room"
            class="focus-room-kind-badge"
            :title="gitRoomTitle(focusRoom.git_room)"
          >
            <GitBranchIcon :size="13" />
            <span>{{ gitRoomKindLabel(focusRoom.git_room) }}</span>
          </span>
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
import GitBranchIcon from '@/components/icons/GitBranchIcon.vue'
import type { FocusRoomInfo, GitRoomInfo } from '@/composables/useRoom'

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
  if (focusRoom.git_room) {
    return `${focusRoom.git_room.repository.full_name} · ${gitRoomRefLabel(focusRoom.git_room)}`
  }
  if (props.concluded) {
    return focusRoom.conclusion_summary || focusRoom.source_task_id || focusRoom.room_id
  }
  return focusRoom.source_task_id || 'No linked task yet'
}

function gitRoomKindLabel(gitRoom: GitRoomInfo): string {
  switch (gitRoom.ref.type) {
    case 'branch':
      return 'Branch Room'
    case 'tag':
      return 'Tag Room'
    case 'pull_request':
      return 'PR Room'
    default:
      return 'Git Room'
  }
}

function gitRoomRefLabel(gitRoom: GitRoomInfo): string {
  const ref = gitRoom.ref
  if (
    ref.name &&
    ref.head_repository?.full_name &&
    ref.head_repository.full_name !== gitRoom.repository.full_name
  ) {
    return `${ref.head_repository.owner}:${ref.name}`
  }
  return ref.name || ref.default_branch || ref.type.replace('_', ' ')
}

function gitRoomTitle(gitRoom: GitRoomInfo): string {
  return `${gitRoom.provider} ${gitRoom.repository.full_name} ${gitRoomRefLabel(gitRoom)}`
}
</script>
