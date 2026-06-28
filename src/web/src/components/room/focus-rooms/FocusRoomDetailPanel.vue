<template>
  <div class="focus-detail-inner">
    <div class="focus-detail-header">
      <p class="focus-eyebrow">Room audit</p>
      <span class="focus-room-state" :data-state="room.focus_status || 'active'">
        {{ room.focus_status || 'active' }}
      </span>
    </div>
    <h4>{{ room.display_name }}</h4>
    <p class="focus-detail-copy">
      {{ detailCopy }}
    </p>

    <section v-if="room.git_room" class="focus-audit-card focus-git-room-card">
      <p class="focus-eyebrow">Git Room</p>
      <div class="focus-git-room-title">
        <GitBranchIcon :size="16" />
        <strong>{{ gitRoomRefLabel(room.git_room) }}</strong>
      </div>
      <dl class="focus-git-facts">
        <div>
          <dt>Provider</dt>
          <dd>{{ gitRoomProviderLabel(room.git_room) }}</dd>
        </div>
        <div>
          <dt>Repository</dt>
          <dd>{{ room.git_room.repository.full_name }}</dd>
        </div>
        <div>
          <dt>Ref</dt>
          <dd>{{ gitRoomRefTypeLabel(room.git_room) }} · {{ gitRoomRefLabel(room.git_room) }}</dd>
        </div>
        <div>
          <dt>Access</dt>
          <dd>{{ gitRoomAccessLabel(room.git_room) }}</dd>
        </div>
      </dl>
    </section>

    <dl class="focus-facts">
      <div>
        <dt>Source task</dt>
        <dd>{{ sourceTaskLabel(room) }}</dd>
      </div>
      <div>
        <dt>Created</dt>
        <dd>{{ formatAuditTime(room.created_at) }}</dd>
      </div>
      <div>
        <dt>Concluded</dt>
        <dd>{{ room.concluded_at ? formatAuditTime(room.concluded_at) : 'Not concluded yet' }}</dd>
      </div>
      <div>
        <dt>Focus key</dt>
        <dd>{{ room.focus_key || 'Not assigned' }}</dd>
      </div>
      <div>
        <dt>Room id</dt>
        <dd>{{ room.room_id }}</dd>
      </div>
      <div>
        <dt>Parent visibility</dt>
        <dd>{{ parentVisibilityLabel(settings.parent_visibility) }}</dd>
      </div>
      <div>
        <dt>Activity scope</dt>
        <dd>{{ activityScopeLabel(settings.activity_scope) }}</dd>
      </div>
      <div>
        <dt>Code routing</dt>
        <dd>{{ githubRoutingLabel(settings.github_event_routing) }}</dd>
      </div>
    </dl>

    <section class="focus-audit-card">
      <p class="focus-eyebrow">Outcome</p>
      <p>{{ room.conclusion_summary || 'No result summary has been shared back yet.' }}</p>
    </section>

    <section v-if="room.conclusion_details" class="focus-audit-card">
      <p class="focus-eyebrow">Closeout record</p>
      <dl class="focus-closeout-facts">
        <div>
          <dt>Artifact</dt>
          <dd>{{ room.conclusion_details.artifact }}</dd>
        </div>
        <div>
          <dt>Review</dt>
          <dd>{{ reviewStateLabel(room.conclusion_details.review_state) }}</dd>
        </div>
        <div>
          <dt>Blockers</dt>
          <dd>{{ blockerStateLabel(room.conclusion_details.blocker_state) }}</dd>
        </div>
        <div>
          <dt>Parent next</dt>
          <dd>{{ parentTaskNextLabel(room.conclusion_details.parent_task_next) }}</dd>
        </div>
        <div>
          <dt>Next owner</dt>
          <dd>{{ room.conclusion_details.next_owner }}</dd>
        </div>
      </dl>
    </section>

    <section class="focus-audit-card">
      <p class="focus-eyebrow">Audit trail</p>
      <ul class="focus-audit-list">
        <li>{{ room.source_task_id ? 'Linked to a parent task.' : 'Created from an ad-hoc intent.' }}</li>
        <li>{{ room.focus_status === 'concluded' ? 'Outcome has been shared or saved.' : 'Still open for work.' }}</li>
        <li>{{ parentVisibilityLabel(settings.parent_visibility) }} controls parent-room updates.</li>
      </ul>
    </section>

    <button
      class="focus-primary"
      type="button"
      @click="emit('openFocusRoom')"
    >
      Open Focus Room
    </button>
    <p class="focus-note">
      Room cards select details first. Use this explicit action when you want to enter the room.
    </p>
  </div>
</template>

<script setup lang="ts">
import GitBranchIcon from '@/components/icons/GitBranchIcon.vue'
import type {
  FocusRoomInfo,
  FocusRoomSettings,
} from '@/composables/useRoom'
import {
  activityScopeLabel,
  blockerStateLabel,
  formatAuditTime,
  gitRoomAccessLabel,
  gitRoomProviderLabel,
  gitRoomRefLabel,
  gitRoomRefTypeLabel,
  githubRoutingLabel,
  parentTaskNextLabel,
  parentVisibilityLabel,
  reviewStateLabel,
} from './options'

defineProps<{
  room: FocusRoomInfo
  settings: FocusRoomSettings
  detailCopy: string
}>()

const emit = defineEmits<{
  openFocusRoom: []
}>()

function sourceTaskLabel(room: FocusRoomInfo): string {
  if (room.source_task_id) return room.source_task_id
  return room.git_room ? 'Git ref room' : 'Ad-hoc room'
}
</script>
