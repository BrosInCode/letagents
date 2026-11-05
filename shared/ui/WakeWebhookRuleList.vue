<template>
  <ul class="wake-webhook-rules" :aria-label="label">
    <li
      v-for="rule in rules"
      :key="rule.id"
      class="wake-webhook-rule"
      :data-rule-id="rule.id"
      :data-state="rule.status"
    >
      <div class="wake-webhook-rule-copy">
        <p class="wake-webhook-rule-title">
          <strong>{{ rule.agent_name }}</strong>
          <span class="wake-webhook-status" :data-state="rule.status">{{ wakeWebhookRuleStatusLabel(rule) }}</span>
        </p>
        <p v-if="rule.note" class="wake-webhook-rule-note">{{ rule.note }}</p>
        <p class="wake-webhook-rule-meta">
          {{ rule.delivery?.delivered_count ?? 0 }} delivered ·
          {{ rule.delivery?.consecutive_failures ?? 0 }} failed in a row ·
          {{ wakeWebhookLastResultLabel(rule) }} ·
          Key: {{ rule.delivery?.has_bearer ? "yes" : "no" }}
        </p>
        <p v-if="form.tests.get(rule.id)" class="wake-webhook-test" :data-tone="form.tests.get(rule.id)!.tone ?? 'pending'" role="status">
          {{ form.tests.get(rule.id)!.text }}
        </p>
        <p v-if="form.cancelErrors.get(rule.id)" class="wake-webhook-error" role="alert">{{ form.cancelErrors.get(rule.id) }}</p>
      </div>
      <div v-if="rule.status === 'active' || rule.status === 'paused'" class="wake-webhook-rule-actions">
        <button
          type="button"
          class="wake-webhook-button"
          :disabled="form.tests.get(rule.id)?.state === 'sending'"
          :aria-label="`Send a test delivery to ${rule.agent_name}'s webhook`"
          @click="form.sendTest(rule)"
        >Send test</button>
        <button
          type="button"
          class="wake-webhook-button"
          :disabled="form.cancelling.has(rule.id)"
          :aria-label="`Cancel ${rule.agent_name}'s webhook wake-up`"
          @click="form.cancel(rule)"
        >Cancel</button>
      </div>
    </li>
  </ul>
</template>

<script setup lang="ts">
import type { WakeRule } from "../wake-rules.mjs";
import { wakeWebhookLastResultLabel, wakeWebhookRuleStatusLabel, type WakeWebhookForm } from "./wake-webhook-form";

/** The rows of the webhook wake-up list: the same row for a listed rule and for a cancelled one. */
defineProps<{
  rules: readonly WakeRule[];
  form: WakeWebhookForm;
  label: string;
}>();
</script>
