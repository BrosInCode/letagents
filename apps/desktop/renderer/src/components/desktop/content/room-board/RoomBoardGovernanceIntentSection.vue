<template>
  <section ref="sectionElement" class="desktop-board-governance-section">
    <p v-if="!governance.pendingIntents.length">No pending requests.</p>
    <article
      v-for="intent in governance.pendingIntents"
      :id="`desktop-board-governance-request-${intent.id}`"
      :key="intent.id"
      class="desktop-board-governance-intent"
      tabindex="-1"
      :aria-label="`${readableIntentTitle(intent)}: ${readableIntentBody(intent)}`"
    >
      <header>
        <strong>{{ readableIntentTitle(intent) }}</strong>
        <span>{{ intent.proposerActorLabel || "Unknown proposer" }}</span>
      </header>
      <p>{{ readableIntentBody(intent) }}</p>
      <form
        v-if="governance.capabilities.canDecideIntents && denyingIntentId === intent.id"
        class="desktop-board-governance-deny"
        @submit.prevent="submitDeny"
      >
        <label
          class="desktop-task-create-field desktop-board-governance-deny-field"
          :for="`desktop-board-governance-deny-${intent.id}`"
        >
          <span>Reason <small>optional</small></span>
          <!-- Read-only, not disabled, while sending: focus stays in the form. -->
          <textarea
            :id="`desktop-board-governance-deny-${intent.id}`"
            v-model="denyReason"
            rows="2"
            maxlength="500"
            placeholder="Tell the agent why"
            :readonly="busy"
            :aria-busy="busy"
            data-testid="board-governance-deny-reason"
            @keydown.esc.stop.prevent="cancelDeny"
          />
        </label>
        <footer>
          <button
            type="submit"
            class="desktop-board-secondary-action"
            :aria-disabled="busy"
            data-testid="board-governance-deny-confirm"
          >
            {{ busy ? "Denying…" : "Deny request" }}
          </button>
          <button
            type="button"
            class="desktop-board-secondary-action"
            :aria-disabled="busy"
            @click="cancelDeny"
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
import { nextTick, ref } from "vue";
import type { DesktopBoardGovernanceSnapshot } from "../../../../../../electron/ipc-types";
import {
  approveIntentLabel,
  readableIntentBody,
  readableIntentTitle,
} from "./governance-presentation";
import { useGovernanceDenyForm, type DenyFormFocusTarget } from "./useGovernanceDenyForm";

const props = defineProps<{
  governance: DesktopBoardGovernanceSnapshot;
  busy: boolean;
}>();

const emit = defineEmits<{
  "approve-intent": [intentId: string];
  "deny-intent": [intentId: string, reason: string | null];
}>();

const sectionElement = ref<HTMLElement | null>(null);
const {
  denyingIntentId,
  reason: denyReason,
  start: startDeny,
  cancel: cancelDeny,
  submit: submitDeny,
} = useGovernanceDenyForm({
  intents: () => props.governance.pendingIntents,
  busy: () => props.busy,
  deny: (intentId, reason) => emit("deny-intent", intentId, reason),
  focus: (target) => { void nextTick(() => focusTargetElement(target)?.focus()); },
});

function focusTargetElement(target: DenyFormFocusTarget): HTMLElement | null {
  if (target.kind === "list") return sectionElement.value?.closest<HTMLElement>('[role="tabpanel"]') ?? null;
  const id = target.kind === "reason"
    ? `desktop-board-governance-deny-${target.intentId}`
    : target.kind === "deny"
      ? `desktop-board-governance-deny-button-${target.intentId}`
      : `desktop-board-governance-request-${target.intentId}`;
  return document.getElementById(id);
}
</script>
