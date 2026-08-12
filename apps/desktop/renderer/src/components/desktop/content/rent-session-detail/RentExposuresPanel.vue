<template>
  <section>
    <p v-if="loading" class="rent-detail-empty">Loading exposures...</p>
    <p v-else-if="exposures.length === 0" class="rent-detail-empty">
      Nothing exposed yet. Every file, search result, or command output the agent sees will be listed here.
    </p>
    <ol v-else class="rent-exposures">
      <li
        v-for="exposure in exposures"
        :key="exposure.id"
        :data-testid="`rent-detail-exposure-${exposure.id}`"
      >
        <div class="rent-exposure-main">
          <code class="rent-exposure-path">{{ exposure.path }}</code>
          <p class="rent-exposure-meta">
            {{ exposureTypeLabel(exposure.exposureType) }}
            <template v-if="exposure.redactionCount > 0">
              · {{ exposure.redactionCount }} redaction{{ exposure.redactionCount === 1 ? "" : "s" }}
            </template>
            · {{ formatTime(exposure.createdAt) }}
          </p>
        </div>
        <span class="state-pill" :data-state="exposureScanState(exposure.secretScanStatus)">
          {{ humanizeToken(exposure.secretScanStatus) }}
        </span>
      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
import type { DesktopRentalExposure } from "../../../../../../electron/ipc-types";
import {
  exposureScanState,
  exposureTypeLabel,
  formatTime,
  humanizeToken,
} from "./presentation";

defineProps<{
  exposures: DesktopRentalExposure[];
  loading: boolean;
}>();
</script>

<style scoped>
.rent-detail-empty {
  opacity: 0.65;
  font-size: 0.9rem;
}
.rent-exposures {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.rent-exposures li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
  border-radius: 0.5rem;
}
.rent-exposure-path {
  font-size: 0.85rem;
  word-break: break-all;
}
.rent-exposure-meta {
  margin: 0.25rem 0 0;
  font-size: 0.75rem;
  opacity: 0.6;
}
</style>
