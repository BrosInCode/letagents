<template>
  <div v-if="agents.length" class="wake-webhook" data-testid="wake-webhook-section">
    <p class="wake-webhook-intro">
      LetAgents sends a signed POST to the receiver's URL each time a room message is for the agent.
      Set it here instead of handing the URL and key to the bot by chat.
    </p>

    <div
      v-if="form.revealedSecret.value"
      class="wake-webhook-secret"
      role="status"
      data-testid="wake-webhook-secret"
    >
      <p class="wake-webhook-secret-title">
        <strong>{{ form.revealedSecret.value.created ? "Wake-up saved" : "Wake-up renewed" }} for {{ form.revealedSecret.value.agentName }}.</strong>
        Signing secret:
      </p>
      <div class="wake-webhook-secret-row">
        <code data-testid="wake-webhook-secret-value">{{ form.revealedSecret.value.secret }}</code>
        <button type="button" class="wake-webhook-button" :data-copied="copied" @click="copySecret">{{ copied ? "Copied" : "Copy" }}</button>
      </div>
      <p class="wake-webhook-secret-notice">{{ WAKE_WEBHOOK_SECRET_NOTICE }}</p>
      <button type="button" class="wake-webhook-button" data-variant="primary" @click="form.dismissSecret()">Done</button>
    </div>

    <form v-else-if="form.open.value" class="wake-webhook-form" data-testid="wake-webhook-form" novalidate @submit.prevent="submit">
      <label class="wake-webhook-field">
        <span>Agent</span>
        <select v-model="form.draft.agentKey" :aria-invalid="Boolean(form.errors.value.agentKey)" :disabled="form.saving.value">
          <option value="" disabled>Choose an agent</option>
          <option v-for="agent in agents" :key="agent.agent_key" :value="agent.agent_key">
            {{ agent.agent_name }}{{ agent.live ? "" : " (not connected now)" }}
          </option>
        </select>
        <small v-if="form.errors.value.agentKey" role="alert">{{ form.errors.value.agentKey }}</small>
        <small v-else>One of your agents in this room.</small>
      </label>
      <label class="wake-webhook-field">
        <span>URL</span>
        <input
          v-model="form.draft.url"
          type="url"
          inputmode="url"
          autocomplete="off"
          spellcheck="false"
          placeholder="https://"
          :aria-invalid="Boolean(form.errors.value.url)"
          :readonly="form.saving.value"
        >
        <small v-if="form.errors.value.url" role="alert">{{ form.errors.value.url }}</small>
        <small v-else>The receiver's public https URL. Private and loopback addresses are refused.</small>
      </label>
      <label class="wake-webhook-field">
        <span>Key <em>(optional)</em></span>
        <input
          v-model="form.draft.bearer"
          type="password"
          autocomplete="off"
          spellcheck="false"
          :aria-invalid="Boolean(form.errors.value.bearer)"
          :readonly="form.saving.value"
        >
        <small v-if="form.errors.value.bearer" role="alert">{{ form.errors.value.bearer }}</small>
        <small v-else>{{ WAKE_WEBHOOK_KEY_HELP }}</small>
      </label>
      <label class="wake-webhook-field">
        <span>Note <em>(optional)</em></span>
        <input
          v-model="form.draft.note"
          type="text"
          autocomplete="off"
          placeholder="wake my routine"
          :aria-invalid="Boolean(form.errors.value.note)"
          :readonly="form.saving.value"
        >
        <small v-if="form.errors.value.note" role="alert">{{ form.errors.value.note }}</small>
        <small v-else>Shown next to the wake-up, for people in the room.</small>
      </label>
      <p v-if="form.saveError.value" class="wake-webhook-error" role="alert">{{ form.saveError.value }}</p>
      <div class="wake-webhook-actions">
        <button type="submit" class="wake-webhook-button" data-variant="primary" :disabled="!form.canSubmit.value">{{ form.saving.value ? "Saving…" : "Save" }}</button>
        <button type="button" class="wake-webhook-button" :disabled="form.saving.value" @click="form.hide()">Cancel</button>
      </div>
    </form>

    <button v-else type="button" class="wake-webhook-button wake-webhook-add" data-variant="primary" data-testid="wake-webhook-add" @click="form.show()">
      Wake a bot by webhook
    </button>

    <WakeWebhookRuleList
      v-if="listedRules.length"
      :rules="listedRules"
      :form="form"
      label="Webhook wake-ups"
      data-testid="wake-webhook-rules"
    />
    <p v-else-if="!loading" class="wake-webhook-empty">{{ emptyText }}</p>
    <button
      v-if="cancelledRules.length"
      type="button"
      class="wake-webhook-link"
      data-testid="wake-webhook-cancelled-toggle"
      :aria-expanded="cancelledShown"
      @click="toggleCancelled"
    >{{ cancelledToggleLabel }}</button>
    <WakeWebhookRuleList
      v-if="cancelledShown"
      :rules="cancelledRules"
      :form="form"
      label="Cancelled webhook wake-ups"
      data-testid="wake-webhook-cancelled-rules"
    />
    <p v-if="ownRules.some((rule) => rule.status === 'active' || rule.status === 'paused')" class="wake-webhook-test-help">{{ WAKE_WEBHOOK_TEST_HELP }}</p>
    <p v-if="error" class="wake-webhook-error" role="alert">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, toRef } from "vue";

import type { WakeRule, WakeWebhookAgent, WakeWebhookApi } from "../wake-rules.mjs";
import WakeWebhookRuleList from "./WakeWebhookRuleList.vue";
import {
  WAKE_WEBHOOK_KEY_HELP,
  WAKE_WEBHOOK_SECRET_NOTICE,
  WAKE_WEBHOOK_TEST_HELP,
  selectOwnWakeWebhookRules,
  useCancelledWakeWebhookRules,
  useWakeWebhookForm,
  wakeWebhookEmptyText,
} from "./wake-webhook-form";

const props = withDefaults(defineProps<{
  roomId: string;
  /** The viewer's own agents in the room; the section shows only when there is at least one. */
  agents: readonly WakeWebhookAgent[];
  /** The room's rules (held and recent); the viewer's webhook rules are picked out of them. */
  rules: readonly WakeRule[];
  api: WakeWebhookApi;
  loading?: boolean;
  error?: string | null;
  /** Whether the host shows the section now. A host that stays mounted while shut (the web drawer) passes it, so the cancelled list is closed again on the next opening. */
  open?: boolean;
}>(), { loading: false, error: null, open: true });
const emit = defineEmits<{ changed: [] }>();

const form = useWakeWebhookForm({
  roomId: toRef(props, "roomId"),
  agents: toRef(props, "agents"),
  api: props.api,
  onChanged: () => emit("changed"),
});
const ownRules = computed(() => selectOwnWakeWebhookRules(props.rules, props.agents));
// Cancelled rules sit behind a button, closed again when the host closes (`open` false) and so on each opening; nothing is saved.
const {
  listed: listedRules,
  cancelled: cancelledRules,
  shown: cancelledShown,
  toggleLabel: cancelledToggleLabel,
  toggle: toggleCancelled,
} = useCancelledWakeWebhookRules(ownRules, toRef(props, "open"));
const emptyText = computed(() => wakeWebhookEmptyText(cancelledRules.value.length));
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

async function copySecret(): Promise<void> {
  const secret = form.revealedSecret.value?.secret;
  if (!secret) return;
  try {
    await navigator.clipboard.writeText(secret);
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copied.value = false; }, 1600);
  } catch {
    // The secret stays on screen to select by hand.
  }
}

function submit(): void {
  void form.submit();
}
</script>

<style src="./wake-webhook.css"></style>
