<template>
  <section class="settings-panel" data-testid="settings-agents-panel">
    <div class="surface-list settings-system-list" data-testid="worker-status-list">
      <article
        v-for="worker in workers"
        :key="worker.id"
        class="surface-row"
        :data-testid="`worker-row-${worker.id}`"
      >
        <div>
          <p class="surface-title">{{ worker.runtime }}</p>
          <p class="surface-subtitle">{{ worker.detail }}</p>
        </div>
        <div class="surface-meta">
          <span class="state-pill" :data-state="worker.state">{{ worker.state.replace(/_/g, " ") }}</span>
          <span>{{ worker.roomId ? friendlyRoomLabel(worker.roomId) : "No room yet" }}</span>
        </div>
      </article>

      <article v-if="!workers.length" class="surface-row single-line" data-testid="worker-status-empty">
        <p class="surface-title">No agents yet.</p>
        <p class="surface-subtitle">Add an agent to a room to get started.</p>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { friendlyRoomLabel } from "../../../../domain/git-rooms";
import type { WorkerSnapshot } from "../../../../../../electron/ipc-types";

defineProps<{
  workers: WorkerSnapshot[];
}>();
</script>
