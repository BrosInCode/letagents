<template>
  <section class="surface-page" data-testid="agents-view">
    <article class="surface-intro">
      <p class="sidebar-label">Agents</p>
      <h3>Keep agent activity in view.</h3>
      <p>
        See the agents connected to this room and how recently they were active.
      </p>
    </article>

    <div class="surface-list" data-testid="agents-list">
      <article
        v-for="participant in participants"
        :key="participant.participantKey"
        class="surface-row"
        :data-testid="`agent-row-${participant.participantKey}`"
      >
        <div>
          <p class="surface-title">{{ participant.displayName }}</p>
          <p class="surface-subtitle">{{ participant.actorLabel || "Agent participant" }}</p>
        </div>
        <div class="surface-meta">
          <span class="state-pill" :data-state="participant.activityState || 'offline'">
            {{ participant.activityState || "offline" }}
          </span>
          <code>{{ participant.lastSeenAt }}</code>
        </div>
      </article>

      <article v-if="!participants.length" class="surface-row single-line" data-testid="agents-empty">
        <p class="surface-title">No agents in this room yet.</p>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { DesktopParticipantSummary } from "../../../../../electron/ipc-types";

defineProps<{
  participants: DesktopParticipantSummary[];
}>();
</script>
