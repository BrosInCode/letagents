<template>
  <SmoothHeight v-if="agents.length">
    <div class="room-settings-row" data-inline="true" data-testid="room-wake-webhooks">
      <div class="room-settings-row-copy">
        <p class="room-settings-row-title">Wake a bot by webhook</p>
        <p class="room-settings-row-description">{{ WAKE_WEBHOOK_INTRO }}</p>
      </div>
      <div class="room-settings-row-action">
        <button
          class="room-settings-button"
          type="button"
          data-testid="room-wake-webhooks-toggle"
          :aria-expanded="expanded"
          :aria-disabled="form.saving.value"
          @click="toggle"
        >{{ toggleLabel }}</button>
      </div>
      <WakeWebhookSection
        class="room-wake-webhooks-body"
        :controller="form"
        :room-id="roomIdentifier"
        :agents="agents"
        :rules="rules"
        :api="api"
        :loading="loading"
        :error="error"
      />
    </div>
  </SmoothHeight>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, toRef, watch } from "vue";
import SmoothHeight from "./SmoothHeight.vue";
import WakeWebhookSection from "../../../../../../../../shared/ui/WakeWebhookSection.vue";
import type { WakeRule, WakeWebhookAgent, WakeWebhookApi } from "../../../../../../../../shared/wake-rules.mjs";
import { WAKE_WEBHOOK_INTRO, useWakeWebhookForm } from "../../../../../../../../shared/ui/wake-webhook-form";
import { desktopIpc } from "../../../../ipc/index";
import { safeUserVisibleErrorDetail } from "../../../../domain/user-visible-error";
import { invalidateRoomWakeRules, useRoomWakeRules } from "../../../../composables/useRoomWakeRules";

// A row of the Room settings Bot section, shown only while the person owns an agent here.
const props = defineProps<{ roomIdentifier: string }>();

const agents = ref<WakeWebhookAgent[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
let generation = 0;

const roomIdentifier = toRef(props, "roomIdentifier");
const wakeRules = useRoomWakeRules(roomIdentifier, computed(() => agents.value.length > 0));
const rules = computed<readonly WakeRule[]>(() => [...(wakeRules.page.value?.active ?? []), ...(wakeRules.page.value?.recent ?? [])]);

/** A main process older than this renderer has no form: the section then stays hidden. */
function bridge() {
  const room = desktopIpc.room as typeof desktopIpc.room & {
    listWakeWebhookAgents?: typeof desktopIpc.room.listWakeWebhookAgents;
    addWakeWebhookRule?: typeof desktopIpc.room.addWakeWebhookRule;
    testWakeRule?: typeof desktopIpc.room.testWakeRule;
  };
  return room.listWakeWebhookAgents && room.addWakeWebhookRule && room.testWakeRule ? room : null;
}

const api: WakeWebhookApi = {
  async listAgents(roomId) {
    return (await bridge()?.listWakeWebhookAgents!(roomId)) ?? [];
  },
  async add(roomId, agentKey, input) {
    const room = bridge();
    if (!room) throw new Error("Restart LetAgents Desktop to add wake-ups from here.");
    const result = await room.addWakeWebhookRule!(roomId, agentKey, input);
    invalidateRoomWakeRules(roomId);
    return result;
  },
  async test(roomId, ruleId) {
    const room = bridge();
    if (!room) throw new Error("Restart LetAgents Desktop to test wake-ups from here.");
    const result = await room.testWakeRule!(roomId, ruleId);
    invalidateRoomWakeRules(roomId);
    return result;
  },
  async cancel(roomId, ruleId) {
    const rule = await desktopIpc.room.cancelWakeRule(roomId, ruleId);
    invalidateRoomWakeRules(roomId);
    return rule;
  },
};
// The row's one button opens the form under it, cancels it, and dismisses
// the secret after a save. It stays the same element, so focus stays on it.
const form = useWakeWebhookForm({ roomId: roomIdentifier, agents, api, onChanged: refresh });
const expanded = computed(() => form.open.value || form.revealedSecret.value !== null);
const toggleLabel = computed(() => (form.revealedSecret.value ? "Done" : form.open.value ? "Cancel" : "Add wake-up"));
function toggle(): void {
  if (form.saving.value) return;
  if (form.revealedSecret.value) form.dismissSecret();
  else if (form.open.value) form.hide();
  else form.show();
}

async function loadAgents(): Promise<void> {
  const version = ++generation;
  loading.value = true;
  error.value = null;
  try {
    const list = await api.listAgents(props.roomIdentifier);
    if (generation !== version) return;
    agents.value = list;
  } catch (cause) {
    if (generation !== version) return;
    agents.value = [];
    error.value = safeUserVisibleErrorDetail(cause, "Your agents in this room could not be loaded.");
  } finally {
    if (generation === version) loading.value = false;
  }
}

function refresh(): void {
  invalidateRoomWakeRules(props.roomIdentifier);
}

watch(() => props.roomIdentifier, () => { agents.value = []; void loadAgents(); }, { immediate: true, flush: "sync" });
onBeforeUnmount(() => { generation++; });
</script>

<style>
/* The form, the secret and the list of wake-ups sit under the row's title and button, across both columns. */
.room-wake-webhooks-body {
  grid-column: 1 / -1;
}
</style>
