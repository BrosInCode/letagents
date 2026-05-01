<template>
  <section class="surface-page" data-testid="worker-status-view">
    <article class="surface-intro">
      <p class="sidebar-label">Agents</p>
      <h3>See the workers this app knows about.</h3>
      <p>
        This is the local worker surface: which runtime each worker belongs to, whether it is live, and what it is tied to.
      </p>
    </article>

    <div class="surface-list" data-testid="worker-status-list">
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
          <code>{{ worker.roomId || "No room yet" }}</code>
        </div>
      </article>

      <article v-if="!workers.length" class="surface-row single-line" data-testid="worker-status-empty">
        <p class="surface-title">No app-managed workers yet.</p>
        <p class="surface-subtitle">This surface will fill in once the desktop app starts launching and supervising workers directly.</p>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { WorkerSnapshot } from "../../../../../electron/ipc-types";

defineProps<{
  workers: WorkerSnapshot[];
}>();
</script>
