<template>
  <section>
    <p v-if="!usage" class="rent-detail-empty">Loading usage...</p>
    <dl v-else class="rent-detail-dl">
      <div>
        <dt>LRT used</dt>
        <dd>{{ usage.lrtUsed }}</dd>
      </div>
      <div>
        <dt>LRT reserved</dt>
        <dd>{{ usage.lrtReserved }}</dd>
      </div>
      <div>
        <dt>LRT limit</dt>
        <dd>{{ usage.lrtLimit ?? "—" }}</dd>
      </div>
      <div>
        <dt>LRT remaining</dt>
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
