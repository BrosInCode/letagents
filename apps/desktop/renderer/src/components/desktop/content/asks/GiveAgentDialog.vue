<template>
  <DesktopDialogShell :open="Boolean(token)" panel-class="give-agent-dialog" aria-labelledby="agent-give-title" :show-close="false" :close-disabled="Boolean(busy)" initial-focus="#agent-give-title" test-id="agent-give-dialog" @close="close">
    <GiveAgentPanel :key="token || ''" v-model:selected="selected" :request="ask" :options="options" :initial-amount="initialAmount" heading-id="agent-give-title" :loading="loading" :unavailable="unavailable?.error" :error="error" :busy="busy" :done="done" :offered="offered" :retry-give="giveFailed" @give="give" @decline="cantHelp" @close="close" @retry="load">
      <template #close><button type="button" class="give-close" aria-label="Close request" :disabled="Boolean(busy)" @click="close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg></button></template>
    </GiveAgentPanel>
  </DesktopDialogShell>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import type { DesktopAgentAsk, DesktopAgentAskModel } from "../../../../../../electron/ipc-types/asks";
import { desktopIpc, desktopBridgeUpgradeMessage } from "../../../../ipc/index.js";
import DesktopDialogShell from "../DesktopDialogShell.vue";
import { parseCustomAmount } from "./ask-links";
import GiveAgentPanel from "../../../../../../../../shared/ui/give-agent/GiveAgentPanel.vue";

const LAST_AMOUNT_KEY = "letagents-desktop:last-gift-amount";
const props = defineProps<{ token: string | null }>();
const emit = defineEmits<{ close: []; given: [roomName: string | null] }>();

const loading = ref(false);
const busy = ref<"give" | "decline" | null>(null);
const offered = ref(false);
const giveFailed = ref(false);
const ask = ref<DesktopAgentAsk | null>(null);
const unavailable = ref<{ code: string; error: string } | null>(null);
const error = ref<string | null>(null);
const done = ref<string | null>(null);
const options = ref<Array<{ key: string; model: DesktopAgentAskModel; requested: boolean; canGive: boolean }>>([]);
const selected = ref<string | null>(null);
const initialAmount = ref(10);
let generation = 0;
onBeforeUnmount(() => { generation++; });

function lastAmount(): number | null {
  try { return parseCustomAmount(localStorage.getItem(LAST_AMOUNT_KEY) ?? ""); } catch { return null; }
}

watch(selected, () => { if (giveFailed.value) error.value = null; giveFailed.value = false; });
watch(() => props.token, () => { void load(); }, { immediate: true });

async function load() {
  const version = ++generation, token = props.token;
  ask.value = null; unavailable.value = null; error.value = null; done.value = null; busy.value = null;
  options.value = []; selected.value = null; offered.value = false; giveFailed.value = false; loading.value = false;
  if (!token) return;
  if (!desktopIpc.asks) { error.value = desktopBridgeUpgradeMessage(); return; }
  loading.value = true;
  try {
    const [preview, models] = await Promise.all([desktopIpc.asks.preview(token), desktopIpc.asks.listModels()]);
    if (version !== generation) return;
    if (!preview.ok) { error.value = preview.error; return; }
    ask.value = preview.value.ask; unavailable.value = preview.value.unavailable;
    if (unavailable.value) return;
    if (!models.ok) { error.value = models.error; return; }
    const list = models.value;
    const requested = list.find(model => model.providerId === preview.value.ask.provider_id && model.model === preview.value.ask.model) ?? null;
    const ordered = requested ? [requested, ...list.filter(model => model !== requested)] : list;
    const available = await Promise.all(ordered.map(async model => ({
      key: `${model.providerId}:${model.model ?? ""}`, model, requested: model === requested,
      canGive: await desktopIpc.asks!.canGive(model.providerId),
    })));
    if (version !== generation) return;
    options.value = available;
    selected.value = available.find(option => option.canGive)?.key ?? null;
    initialAmount.value = preview.value.ask.amount_percent ?? lastAmount() ?? 10;
  } catch {
    if (version === generation) error.value = "Couldn't open this request. Check your connection and try again.";
  } finally { if (version === generation) loading.value = false; }
}

async function give(chosen: number) {
  const token = props.token; const choice = options.value.find(option => option.key === selected.value && option.canGive);
  const version = generation;
  if (!token || !choice || busy.value) return;
  if (!Number.isInteger(chosen) || chosen < 1 || chosen > 100) { error.value = "Enter a whole number from 1 to 100."; return; }
  busy.value = "give"; error.value = null; giveFailed.value = false;
  try {
    const result = await desktopIpc.asks!.give({ token, providerId: choice.model.providerId, model: choice.model.model, modelLabel: choice.model.label, amountPercent: chosen });
    if (version !== generation) return;
    if (!result.ok) { error.value = result.error; giveFailed.value = true; return; }
    try { localStorage.setItem(LAST_AMOUNT_KEY, String(chosen)); } catch { /* storage unavailable */ }
    offered.value = result.value.state === "on_hold";
    done.value = result.value.state === "on_hold"
      ? `${ask.value?.asker} will be asked to accept ${choice.model.label}.`
      : `Your agent is in ${ask.value?.asker}'s room. Thanks for helping.`;
    emit("given", ask.value?.room_display_name ?? null);
  } catch {
    if (version === generation) { error.value = "Couldn’t add this agent. Check your connection and try again."; giveFailed.value = true; }
  } finally {
    if (version === generation) busy.value = null;
  }
}

async function cantHelp() {
  if (!props.token || busy.value) return;
  const version = generation;
  busy.value = "decline"; error.value = null; giveFailed.value = false;
  const result = await desktopIpc.asks?.cantHelp(props.token).catch(() => null);
  if (version !== generation) return;
  busy.value = null;
  if (!result?.ok) { error.value = result && !result.ok ? result.error : "Couldn't reach LetAgents. Check your connection and try again."; return; }
  close();
}

function close() { if (!busy.value) emit("close"); }
</script>

<style>
.give-agent-dialog { width: min(600px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); display: flex; min-height: 0; outline: none; box-shadow: 0 32px 100px #0006; border-radius: 17px; }
@media (max-width:480px) { .give-agent-dialog { width: calc(100vw - 20px); max-height: calc(100dvh - 24px); } }
</style>
