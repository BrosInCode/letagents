<template>
  <section class="desktop-board-governance-section">
    <p v-if="!governance.audit.length">No governance audit entries yet.</p>
    <article
      v-for="entry in governance.audit"
      :key="`${entry.kind}:${entry.id}:${entry.createdAt}`"
      class="desktop-board-governance-audit-entry"
    >
      <header>
        <strong>{{ readableAuditEvent(entry) }}</strong>
        <span>{{ governanceTimestamp(entry.createdAt) }}</span>
      </header>
      <p v-if="entry.actorLabel">By {{ entry.actorLabel }}</p>
      <p v-if="auditResultText(entry)">{{ auditResultText(entry) }}</p>
      <p v-if="entry.reason">{{ entry.reason }}</p>
    </article>
  </section>
</template>

<script setup lang="ts">
import type { DesktopBoardGovernanceSnapshot } from "../../../../../../electron/ipc-types";
import {
  auditResultText,
  governanceTimestamp,
  readableAuditEvent,
} from "./governance-presentation";

defineProps<{
  governance: DesktopBoardGovernanceSnapshot;
}>();
</script>
