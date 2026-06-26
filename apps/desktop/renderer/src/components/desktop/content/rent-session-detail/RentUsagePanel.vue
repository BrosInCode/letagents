<template>
  <section>
    <p v-if="!usage" class="rent-detail-empty">Loading usage...</p>
    <dl v-else class="rent-detail-dl">
      <div>
        <dt>Rental credits used</dt>
        <dd>{{ usage.lrtUsed }}</dd>
      </div>
      <div>
        <dt>Rental credits reserved</dt>
        <dd>{{ usage.lrtReserved }}</dd>
      </div>
      <div>
        <dt>Rental credit limit</dt>
        <dd>{{ usage.lrtLimit ?? "—" }}</dd>
      </div>
      <div>
        <dt>Rental credits remaining</dt>
        <dd>{{ usage.lrtRemaining ?? "—" }}</dd>
      </div>
      <div>
        <dt>Budget stop</dt>
        <dd>{{ usage.budgetStopThreshold ?? "—" }}</dd>
      </div>
      <div>
        <dt>Time limit (min)</dt>
        <dd>{{ usage.timeLimitMinutes ?? "—" }}</dd>
      </div>
      <div>
        <dt>Started</dt>
        <dd>{{ formatTime(usage.startedAt) }}</dd>
      </div>
      <div>
        <dt>Ends</dt>
        <dd>{{ formatTime(usage.endsAt) }}</dd>
      </div>
    </dl>
  </section>
</template>

<script setup lang="ts">
import type { DesktopRentalUsageSnapshot } from "../../../../../../electron/ipc-types";
import { formatTime } from "./presentation";

defineProps<{
  usage: DesktopRentalUsageSnapshot | null;
}>();
</script>

<style scoped>
.rent-detail-empty {
  opacity: 0.65;
  font-size: 0.9rem;
}
.rent-detail-dl {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: 0.75rem 1.25rem;
  margin: 0;
}
.rent-detail-dl > div {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.rent-detail-dl dt {
  opacity: 0.65;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.rent-detail-dl dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
</style>
