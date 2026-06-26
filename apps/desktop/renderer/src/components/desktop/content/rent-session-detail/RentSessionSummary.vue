<template>
  <div class="rent-detail-summary">
    <div>
      <p class="rent-detail-label">Session ID</p>
      <code>{{ session.id }}</code>
    </div>
    <div>
      <p class="rent-detail-label">Status</p>
      <span class="state-pill" :data-state="sessionStatusState(session.status)">
        {{ humanizeToken(session.status) }}
      </span>
    </div>
    <div>
      <p class="rent-detail-label">Access</p>
      <span>{{ rentalModeLabel(session.mode) }}</span>
    </div>
    <div>
      <p class="rent-detail-label">Rental credits</p>
      <span v-if="usage && usage.lrtLimit !== null">
        {{ usage.lrtUsed }}/{{ usage.lrtLimit }}
      </span>
      <span v-else-if="usage">{{ usage.lrtUsed }}</span>
      <span v-else>—</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type {
  DesktopRentalSession,
  DesktopRentalUsageSnapshot,
} from "../../../../../../electron/ipc-types";
import { humanizeToken, rentalModeLabel, sessionStatusState } from "./presentation";

defineProps<{
  session: DesktopRentalSession;
  usage: DesktopRentalUsageSnapshot | null;
}>();

</script>

<style scoped>
.rent-detail-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
  gap: 0.75rem;
  padding: 0 1.25rem 0.75rem;
}
.rent-detail-summary > div {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.85rem;
}
.rent-detail-label {
  opacity: 0.65;
  margin: 0;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
</style>
