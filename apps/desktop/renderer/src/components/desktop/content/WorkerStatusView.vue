<template>
  <DesktopSurfacePage data-testid="worker-status-view">
    <DesktopSurfaceIntro
      kicker="Agents"
      title="See the workers this app knows about."
      description="This is the local worker surface: which runtime each worker belongs to, whether it is live, and what it is tied to."
    />

    <DesktopSurfaceList data-testid="worker-status-list">
      <DesktopSurfaceRow
        v-for="worker in workers"
        :key="worker.id"
        :data-testid="`worker-row-${worker.id}`"
      >
        <div>
          <p class="surface-title">{{ worker.runtime }}</p>
          <p class="surface-subtitle">{{ worker.detail }}</p>
        </div>
        <template #meta>
          <span class="state-pill" :data-state="worker.state">{{ worker.state.replace(/_/g, " ") }}</span>
          <code>{{ worker.roomId || "No room yet" }}</code>
        </template>
      </DesktopSurfaceRow>

      <DesktopSurfaceRow v-if="!workers.length" single-line data-testid="worker-status-empty">
        <p class="surface-title">No app-managed workers yet.</p>
        <p class="surface-subtitle">This surface will fill in once the desktop app starts launching and supervising workers directly.</p>
      </DesktopSurfaceRow>
    </DesktopSurfaceList>
  </DesktopSurfacePage>
</template>

<script setup lang="ts">
import type { WorkerSnapshot } from "../../../../../electron/ipc-types";
import DesktopSurfaceIntro from "./ui/DesktopSurfaceIntro.vue";
import DesktopSurfaceList from "./ui/DesktopSurfaceList.vue";
import DesktopSurfacePage from "./ui/DesktopSurfacePage.vue";
import DesktopSurfaceRow from "./ui/DesktopSurfaceRow.vue";

defineProps<{
  workers: WorkerSnapshot[];
}>();
</script>
