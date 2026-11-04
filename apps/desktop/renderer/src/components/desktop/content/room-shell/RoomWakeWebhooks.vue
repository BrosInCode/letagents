<template>
  <section
    v-if="agents.length"
    class="room-settings-section"
    data-section="wake"
    aria-labelledby="room-settings-heading-wake"
    data-testid="room-wake-webhooks"
  >
    <h3 id="room-settings-heading-wake">Wake a bot by webhook</h3>
    <div class="room-settings-list">
      <div class="room-settings-row room-wake-webhooks-row">
        <WakeWebhookSection
          :room-id="roomIdentifier"
          :agents="agents"
          :rules="rules"
          :api="api"
          :loading="loading"
          :error="error"
          @changed="refresh"
        />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, toRef, watch } from "vue";
import WakeWebhookSection from "../../../../../../../../shared/ui/WakeWebhookSection.vue";
import type { WakeRule, WakeWebhookAgent, WakeWebhookApi } from "../../../../../../../../shared/wake-rules.mjs";
import { selectOwnWakeWebhookRules } from "../../../../../../../../shared/ui/wake-webhook-form";
import { desktopIpc } from "../../../../ipc/index";
import { safeUserVisibleErrorDetail } from "../../../../domain/user-visible-error";
import { invalidateRoomWakeRules, useRoomWakeRules } from "../../../../composables/useRoomWakeRules";

const props = defineProps<{ roomIdentifier: string }>();
// The Room settings rail lists this section only while the person owns an agent here (null hides it).
const emit = defineEmits<{ summary: [summary: string | null] }>();

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
watch([agents, rules], ([list, all]) => {
  if (!list.length) { emit("summary", null); return; }
  const held = selectOwnWakeWebhookRules(all, list).filter((rule) => rule.status === "active" || rule.status === "paused").length;
  emit("summary", held ? `${held} set` : "None");
}, { immediate: true });
onBeforeUnmount(() => { generation++; });
</script>

<style>
.room-wake-webhooks-row {
  display: block;
}
</style>
