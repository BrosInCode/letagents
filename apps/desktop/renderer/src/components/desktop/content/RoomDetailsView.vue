<template>
  <DesktopSurfacePage data-testid="room-details-view">
    <DesktopSurfaceIntro
      kicker="Room details"
      title="Everything connected to this room, in one place."
      description="See the focused rooms branching out from here and the work already tracked inside this room."
    />

    <DesktopSurfaceList data-testid="room-details-focus-rooms">
      <DesktopSurfaceRow single-line>
        <div>
          <p class="surface-title">Focus rooms</p>
          <p class="surface-subtitle">The focused threads linked to this room.</p>
        </div>
      </DesktopSurfaceRow>

      <DesktopSurfaceRow
        v-for="focusRoom in focusRooms"
        :key="focusRoom.roomId"
        :data-testid="`room-focus-${focusRoom.roomId}`"
      >
        <div>
          <p class="surface-title">{{ focusRoom.displayName }}</p>
          <p class="surface-subtitle">{{ focusRoom.sourceTaskId || focusRoom.identifier }}</p>
        </div>
        <template #meta>
          <span class="state-pill">{{ focusRoom.focusStatus || "active" }}</span>
          <code>{{ focusRoom.code || focusRoom.roomId }}</code>
        </template>
      </DesktopSurfaceRow>

      <DesktopSurfaceRow v-if="!focusRooms.length" single-line data-testid="room-focus-empty">
        <p class="surface-title">No focus rooms yet.</p>
      </DesktopSurfaceRow>
    </DesktopSurfaceList>

    <DesktopSurfaceList data-testid="room-details-tasks">
      <DesktopSurfaceRow single-line>
        <div>
          <p class="surface-title">Tasks</p>
          <p class="surface-subtitle">A quick read on the work already in this room.</p>
        </div>
      </DesktopSurfaceRow>

      <DesktopSurfaceRow
        v-for="task in tasks"
        :key="task.id"
        :data-testid="`room-task-${task.id}`"
      >
        <div>
          <p class="surface-title">{{ task.title }}</p>
          <p class="surface-subtitle">{{ task.assignee || "Unassigned" }}</p>
        </div>
        <template #meta>
          <span class="state-pill">{{ task.status }}</span>
          <code>{{ task.id }}</code>
        </template>
      </DesktopSurfaceRow>

      <DesktopSurfaceRow v-if="!tasks.length" single-line data-testid="room-tasks-empty">
        <p class="surface-title">No tasks yet.</p>
      </DesktopSurfaceRow>
    </DesktopSurfaceList>
  </DesktopSurfacePage>
</template>

<script setup lang="ts">
import type { DesktopFocusRoomInfo, DesktopTaskSummary } from "../../../../../electron/ipc-types";
import DesktopSurfaceIntro from "./ui/DesktopSurfaceIntro.vue";
import DesktopSurfaceList from "./ui/DesktopSurfaceList.vue";
import DesktopSurfacePage from "./ui/DesktopSurfacePage.vue";
import DesktopSurfaceRow from "./ui/DesktopSurfaceRow.vue";

defineProps<{
  focusRooms: DesktopFocusRoomInfo[];
  tasks: DesktopTaskSummary[];
}>();
</script>
