<template>
  <DesktopDialogShell
    :open="Boolean(token)"
    panel-class="desktop-task-modal agent-give-dialog"
    aria-labelledby="agent-give-title"
    close-label="Close"
    :close-disabled="busy"
    test-id="agent-give-dialog"
    @close="close"
  >
    <p v-if="loading" class="agent-ask-ready-copy">Opening the request…</p>

    <template v-else-if="done">
      <header class="agent-ask-header"><h3 id="agent-give-title">Added</h3></header>
      <p class="agent-ask-ready-copy">{{ done }}</p>
      <footer class="desktop-task-create-actions">
        <button type="button" class="desktop-board-primary-action" @click="close">Done</button>
      </footer>
    </template>

    <template v-else-if="unavailable || !ask">
      <header class="agent-ask-header"><h3 id="agent-give-title">{{ unavailable?.code === "ask_used" ? "Thank you" : "Request unavailable" }}</h3></header>
      <p class="agent-ask-ready-copy" data-testid="agent-give-unavailable">{{ unavailable?.error ?? error ?? "This link isn't valid." }}</p>
      <footer class="desktop-task-create-actions">
        <button type="button" class="desktop-board-primary-action" @click="close">Close</button>
      </footer>
    </template>

    <template v-else>
      <header class="agent-ask-header">
        <h3 id="agent-give-title">{{ ask.asker }} asked for an agent</h3>
        <p class="agent-give-meta">{{ ask.model_label }}<template v-if="ask.room_display_name"> · {{ ask.room_display_name }}</template></p>
      </header>
      <blockquote v-if="ask.note" class="agent-give-note">{{ ask.note }}</blockquote>

      <fieldset class="agent-ask-field">
        <legend>Agent</legend>
        <div class="agent-give-models">
          <button v-for="option in options" :key="option.key" type="button" class="agent-give-model"
            :aria-pressed="selected === option.key" :disabled="busy || !option.canGive" @click="selected = option.key">
            <span>{{ option.model.label }}</span>
            <small>{{ !option.canGive ? "Can't be given yet" : option.requested ? "Requested" : `${ask.asker} must accept` }}</small>
          </button>
        </div>
      </fieldset>

      <fieldset class="agent-ask-field agent-ask-amount">
        <legend>How much to give</legend>
        <div class="agent-ask-chips">
          <button v-for="choice in AMOUNT_CHOICES" :key="choice" type="button" :aria-pressed="amount === choice && !customOpen"
            :disabled="busy" @click="amount = choice; customOpen = false">{{ choice }}%</button>
          <button type="button" :aria-pressed="customOpen" :disabled="busy" @click="customOpen = true">Custom</button>
        </div>
        <input v-if="customOpen" v-model="customText" class="agent-ask-custom" type="text" inputmode="numeric" placeholder="15"
          aria-label="Custom amount in percent" :disabled="busy" />
        <small class="agent-ask-hint">Of your main usage limit.</small>
      </fieldset>

      <p class="agent-give-terms">Uses your quota. Once given, you can't take it back.</p>
      <p v-if="error" class="desktop-task-dialog-error" role="alert">{{ error }}</p>

      <footer class="desktop-task-create-actions">
        <button type="button" class="desktop-task-detail-button" :disabled="busy" data-testid="agent-give-cant" @click="cantHelp">Can't right now</button>
        <button type="button" class="desktop-board-primary-action" :disabled="busy || !current" data-testid="agent-give-add" @click="give">
          {{ busy ? "Adding…" : current ? `Add ${current.model.label}` : "Choose an agent" }}
        </button>
      </footer>
    </template>
  </DesktopDialogShell>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { DesktopAgentAsk, DesktopAgentAskModel } from "../../../../../../electron/ipc-types/asks";
import { desktopIpc, desktopBridgeUpgradeMessage } from "../../../../ipc/index.js";
import DesktopDialogShell from "../DesktopDialogShell.vue";
import { AMOUNT_CHOICES, parseCustomAmount } from "./ask-links";

const LAST_AMOUNT_KEY = "letagents-desktop:last-gift-amount";
const props = defineProps<{ token: string | null }>();
const emit = defineEmits<{ close: []; given: [roomName: string | null] }>();

const loading = ref(false);
const busy = ref(false);
const ask = ref<DesktopAgentAsk | null>(null);
const unavailable = ref<{ code: string; error: string } | null>(null);
const error = ref<string | null>(null);
const done = ref<string | null>(null);
const options = ref<Array<{ key: string; model: DesktopAgentAskModel; requested: boolean; canGive: boolean }>>([]);
const selected = ref<string | null>(null);
const amount = ref(10);
const customOpen = ref(false);
const customText = ref("");
const current = computed(() => options.value.find(option => option.key === selected.value && option.canGive) ?? null);

function lastAmount(): number | null {
  try { return parseCustomAmount(localStorage.getItem(LAST_AMOUNT_KEY) ?? ""); } catch { return null; }
}

watch(() => props.token, async token => {
  ask.value = null; unavailable.value = null; error.value = null; done.value = null; customOpen.value = false; customText.value = "";
  if (!token) return;
  if (!desktopIpc.asks) { error.value = desktopBridgeUpgradeMessage(); return; }
  loading.value = true;
  try {
    const [preview, models] = await Promise.all([desktopIpc.asks.preview(token), desktopIpc.asks.listModels()]);
    if (!preview.ok) { error.value = preview.error; return; }
    ask.value = preview.value.ask; unavailable.value = preview.value.unavailable;
    const list = models.ok ? models.value : [];
    const requested = list.find(model => model.providerId === preview.value.ask.provider_id && model.model === preview.value.ask.model)
      ?? { providerId: preview.value.ask.provider_id, model: preview.value.ask.model, label: preview.value.ask.model_label };
    const ordered = [requested, ...list.filter(model => model !== requested)];
    options.value = await Promise.all(ordered.map(async model => ({
      key: `${model.providerId}:${model.model ?? ""}`, model, requested: model === requested,
      canGive: await desktopIpc.asks!.canGive(model.providerId),
    })));
    selected.value = options.value.find(option => option.canGive)?.key ?? null;
    // Preselect what was asked for, then what this person gave last time, then 10% (S3).
    amount.value = preview.value.ask.amount_percent ?? lastAmount() ?? 10;
    if (!(AMOUNT_CHOICES as readonly number[]).includes(amount.value)) { customOpen.value = true; customText.value = String(amount.value); }
  } finally {
    loading.value = false;
  }
}, { immediate: true });

async function give() {
  const token = props.token; const choice = current.value;
  if (!token || !choice || busy.value) return;
  const chosen = customOpen.value ? parseCustomAmount(customText.value) : amount.value;
  if (chosen === null) { error.value = "Enter a whole number from 1 to 100."; return; }
  busy.value = true; error.value = null;
  try {
    const result = await desktopIpc.asks!.give({ token, providerId: choice.model.providerId, model: choice.model.model, modelLabel: choice.model.label, amountPercent: chosen });
    if (!result.ok) { error.value = result.error; return; }
    try { localStorage.setItem(LAST_AMOUNT_KEY, String(chosen)); } catch { /* storage unavailable */ }
    done.value = result.value.state === "on_hold"
      ? `${ask.value?.asker} will be asked to accept ${choice.model.label}.`
      : `Your agent is in ${ask.value?.asker}'s room. Thanks for helping.`;
    emit("given", ask.value?.room_display_name ?? null);
  } finally {
    busy.value = false;
  }
}

async function cantHelp() {
  if (!props.token || busy.value) return;
  busy.value = true;
  await desktopIpc.asks?.cantHelp(props.token).catch(() => undefined);
  busy.value = false;
  close();
}

function close() { if (!busy.value) emit("close"); }
</script>
