<template>
  <section class="overview-page" data-testid="room-overview-view">
    <article class="hero-panel" data-testid="room-overview-hero">
      <p class="hero-kicker">{{ activeEntry.kind === "focus" ? "Focus room" : "Parent room" }}</p>
      <h3>{{ activeEntry.headline }}</h3>
      <p class="hero-copy">{{ activeEntry.description }}</p>

      <div class="hero-actions">
        <button class="primary-button large" type="button" data-testid="overview-room-details" @click="$emit('open-room-details')">
          Open room details
        </button>
        <button class="ghost-button large" type="button" data-testid="overview-view-agents" @click="$emit('view-agents')">
          View agents
        </button>
      </div>
    </article>

    <section class="stats-grid" data-testid="room-overview-stats">
      <article class="stat-card" data-testid="room-overview-scope">
        <span class="stat-label">Room scope</span>
        <strong>{{ activeEntry.kind === "focus" ? "Scoped focus room" : "Parent room" }}</strong>
        <small>{{ activeEntry.meta }}</small>
      </article>

      <article class="stat-card" data-testid="room-overview-branch">
        <span class="stat-label">Room branch context</span>
        <strong>{{ branch || "Unknown" }}</strong>
        <small>{{ rootPath || "Loading repository…" }}</small>
      </article>

      <article class="stat-card" data-testid="room-overview-agents">
        <span class="stat-label">Agents</span>
        <strong>{{ participantsCount }}</strong>
        <small>Bring your agents into the room and keep their status close at hand.</small>
      </article>

      <article class="stat-card" data-testid="room-overview-tasks">
        <span class="stat-label">Tasks</span>
        <strong>{{ tasksCount }}</strong>
        <small>See open work and follow what each room is carrying.</small>
      </article>
    </section>

    <section class="action-grid" data-testid="room-overview-actions">
      <button class="action-card" type="button" data-testid="overview-related-rooms" @click="$emit('open-room-details')">
        <span class="action-eyebrow">Rooms</span>
        <strong>See related rooms</strong>
        <p>Keep the main room and its focus rooms together, so work stays easy to follow.</p>
      </button>

      <button class="action-card" type="button" data-testid="overview-ready-agents" @click="$emit('view-agents')">
        <span class="action-eyebrow">Agents</span>
        <strong>See who is ready</strong>
        <p>Check who is available, what is active, and where attention is needed.</p>
      </button>

      <button class="action-card" type="button" data-testid="overview-check-setup" @click="$emit('show-system')">
        <span class="action-eyebrow">App</span>
        <strong>Check the setup</strong>
        <p>Keep connection details and recovery notes nearby without crowding the room view.</p>
      </button>
    </section>

    <RoomBoardSummary :tasks="tasks" />
    <RoomRecentActivity :entries="recentActivity" />
  </section>
</template>

<script setup lang="ts">
import type { DesktopActivityEntry, DesktopTaskSummary } from "../../../../../electron/ipc-types";
import RoomBoardSummary from "./RoomBoardSummary.vue";
import RoomRecentActivity from "./RoomRecentActivity.vue";
import type { RoomEntry } from "../types";

defineProps<{
  activeEntry: RoomEntry;
  branch: string | null;
  rootPath: string | null;
  participantsCount: number;
  tasksCount: number;
  tasks: DesktopTaskSummary[];
  recentActivity: DesktopActivityEntry[];
}>();

defineEmits<{
  "open-room-details": [];
  "view-agents": [];
  "show-system": [];
}>();
</script>
