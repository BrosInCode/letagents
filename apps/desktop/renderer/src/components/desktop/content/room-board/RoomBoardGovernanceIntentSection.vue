<template>
  <section class="desktop-board-governance-section">
    <p v-if="!governance.pendingIntents.length">No pending requests.</p>
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
      <form
        v-if="governance.capabilities.canDecideIntents && denyingIntentId === intent.id"
        class="desktop-board-governance-deny"
        @submit.prevent="submitDeny(intent.id)"
      >
        <label class="desktop-board-governance-deny-field" :for="`desktop-board-governance-deny-${intent.id}`">
          <span>Reason <small>optional</small></span>
          <textarea
            :id="`desktop-board-governance-deny-${intent.id}`"
            ref="denyReasonInput"
            v-model="denyReason"
            rows="2"
            maxlength="500"
            placeholder="Tell the agent why"
            :disabled="busy"
            data-testid="board-governance-deny-reason"
            @keydown.esc.stop.prevent="cancelDeny({ restoreFocus: true })"
          />
        </label>
        <footer>
          <button
            type="submit"
            class="desktop-board-secondary-action"
            :disabled="busy"
            data-testid="board-governance-deny-confirm"
          >
            Deny request
          </button>
          <button
            type="button"
            class="desktop-board-secondary-action"
            :disabled="busy"
            @click="cancelDeny({ restoreFocus: true })"
          >
            Cancel
          </button>
        </footer>
      </form>
      <footer v-else-if="governance.capabilities.canDecideIntents">
        <button
          type="button"
          class="desktop-board-primary-action"
          :disabled="busy"
          @click="emit('approve-intent', intent.id)"
        >
          {{ approveIntentLabel(intent) }}
        </button>
        <button
          :id="`desktop-board-governance-deny-button-${intent.id}`"
          type="button"
          class="desktop-board-secondary-action"
          :disabled="busy"
          data-testid="board-governance-deny"
          @click="startDeny(intent.id)"
        >
          Deny
        </button>
      </footer>
    </article>
  </section>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import type { DesktopBoardGovernanceSnapshot } from "../../../../../../electron/ipc-types";
import {
  approveIntentLabel,
  denyIntentReason,
  readableIntentBody,
  readableIntentTitle,
} from "./governance-presentation";

const props = defineProps<{
  governance: DesktopBoardGovernanceSnapshot;
  busy: boolean;
}>();

const emit = defineEmits<{
  "approve-intent": [intentId: string];
  "deny-intent": [intentId: string, reason: string | null];
}>();

const denyingIntentId = ref<string | null>(null);
const denyReason = ref("");
const denyReasonInput = ref<HTMLTextAreaElement[] | null>(null);

// The form stays open while a denial is in flight or fails, so a typed reason
// survives a retry. It closes once the request leaves the pending list.
watch(() => props.governance.pendingIntents, (intents) => {
  if (denyingIntentId.value && !intents.some((intent) => intent.id === denyingIntentId.value)) {
    cancelDeny();
  }
});

function startDeny(intentId: string): void {
  denyingIntentId.value = intentId;
  denyReason.value = "";
  void nextTick(() => denyReasonInput.value?.[0]?.focus());
}

function cancelDeny(options: { restoreFocus?: boolean } = {}): void {
  const intentId = denyingIntentId.value;
  denyingIntentId.value = null;
  denyReason.value = "";
  if (options.restoreFocus && intentId) {
    void nextTick(() => document.getElementById(`desktop-board-governance-deny-button-${intentId}`)?.focus());
  }
}

function submitDeny(intentId: string): void {
  if (props.busy) return;
  emit("deny-intent", intentId, denyIntentReason(denyReason.value));
}
</script>
