<template>
  <section class="surface-page" data-testid="room-details-view">
    <article class="surface-intro">
      <p class="sidebar-label">Room details</p>
      <h3>Everything connected to this room, in one place.</h3>
      <p>
        See the focused rooms branching out from here and the work already tracked inside this room.
      </p>
    </article>

    <div class="surface-list" data-testid="room-details-focus-rooms">
      <article class="surface-row single-line">
        <div>
          <p class="surface-title">Focus rooms</p>
          <p class="surface-subtitle">The focused threads linked to this room.</p>
        </div>
      </article>

      <article
        v-for="focusRoom in focusRooms"
        :key="focusRoom.roomId"
        class="surface-row"
        :data-testid="`room-focus-${focusRoom.roomId}`"
      >
        <div>
          <p class="surface-title">{{ focusRoom.displayName }}</p>
          <p class="surface-subtitle">{{ focusRoom.sourceTaskId || focusRoom.identifier }}</p>
        </div>
        <div class="surface-meta">
          <span class="state-pill">{{ focusRoom.focusStatus || "active" }}</span>
          <code>{{ focusRoom.code || focusRoom.roomId }}</code>
        </div>
      </article>

      <article v-if="!focusRooms.length" class="surface-row single-line" data-testid="room-focus-empty">
        <p class="surface-title">No focus rooms yet.</p>
      </article>
    </div>

    <div class="surface-list" data-testid="room-details-tasks">
      <article class="surface-row single-line">
        <div>
          <p class="surface-title">Tasks</p>
          <p class="surface-subtitle">A quick read on the work already in this room.</p>
        </div>
      </article>

      <article
        v-for="task in tasks"
        :key="task.id"
        class="surface-row"
        :data-testid="`room-task-${task.id}`"
      >
        <div>
          <p class="surface-title">{{ task.title }}</p>
          <p class="surface-subtitle">{{ task.assignee || "Unassigned" }}</p>
        </div>
        <div class="surface-meta">
          <span class="state-pill">{{ task.status }}</span>
          <code>{{ task.id }}</code>
        </div>
      </article>

      <article v-if="!tasks.length" class="surface-row single-line" data-testid="room-tasks-empty">
        <p class="surface-title">No tasks yet.</p>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { DesktopFocusRoomInfo, DesktopTaskSummary } from "../../../../../electron/ipc-types";

defineProps<{
  focusRooms: DesktopFocusRoomInfo[];
  tasks: DesktopTaskSummary[];
}>();
</script>
