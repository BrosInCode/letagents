<template>
  <div class="rent-detail-summary">
    <div>
      <p class="rent-detail-label">Session ID</p>
      <code>{{ session.id }}</code>
    </div>
    <div>
      <p class="rent-detail-label">Status</p>
      <span class="state-pill" :data-state="sessionStatusState(session.status)">
        {{ session.status }}
      </span>
    </div>
    <div>
      <p class="rent-detail-label">Mode</p>
      <span>{{ session.mode }}</span>
    </div>
    <div>
      <p class="rent-detail-label">LRT</p>
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
import { sessionStatusState } from "./presentation";

defineProps<{
  session: DesktopRentalSession;
  usage: DesktopRentalUsageSnapshot | null;
}>();
</script>
