<template>
  <section class="desktop-board-governance-section">
    <p v-if="!governance.pendingIntents.length">No pending board intents.</p>
    <article
      v-for="intent in governance.pendingIntents"
      :key="intent.id"
      class="desktop-board-governance-intent"
    >
      <header>
        <strong>{{ readableIntentTitle(intent) }}</strong>
        <span>{{ intent.proposerActorLabel || "Unknown proposer" }}</span>
      </header>
      <p>{{ readableIntentBody(intent) }}</p>
      <footer v-if="governance.capabilities.canDecideIntents">
        <button
          type="button"
          class="desktop-board-primary-action"
          :disabled="busy"
          @click="emit('approve-intent', intent.id)"
        >
          {{ approveIntentLabel(intent) }}
        </button>
        <button
          type="button"
          class="desktop-board-secondary-action"
          :disabled="busy"
          @click="emit('deny-intent', intent.id)"
        >
          Deny
        </button>
      </footer>
    </article>
  </section>
</template>

<script setup lang="ts">
import type { DesktopBoardGovernanceSnapshot } from "../../../../../../electron/ipc-types";
import {
  approveIntentLabel,
  readableIntentBody,
  readableIntentTitle,
} from "./governance-presentation";

defineProps<{
  governance: DesktopBoardGovernanceSnapshot;
  busy: boolean;
}>();

const emit = defineEmits<{
  "approve-intent": [intentId: string];
  "deny-intent": [intentId: string];
}>();
</script>
