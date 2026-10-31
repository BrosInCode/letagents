<template>
  <div v-if="visible.length" class="agent-ask-bar" data-testid="agent-ask-bar">
    <div v-for="ask in visible" :key="ask.id" class="agent-ask-pill" :data-state="ask.state">
      <span class="agent-ask-pill-text">{{ line(ask) }}</span>
      <span class="agent-ask-pill-actions">
        <template v-if="ask.state === 'open' || ask.state === 'claimed'">
          <button v-if="askLinkFor(ask.id)" type="button" @click="copy(ask.id)">{{ copiedId === ask.id ? "Copied" : "Copy link" }}</button>
          <button type="button" @click="act(ask.id, 'cancel')">Cancel</button>
        </template>
        <template v-else-if="ask.state === 'on_hold' && ask.is_asker">
          <button type="button" @click="act(ask.id, 'accept')">Accept</button>
          <button type="button" @click="act(ask.id, 'decline')">Remove</button>
        </template>
        <template v-else-if="ask.is_asker && (ask.state === 'active' || ask.state === 'paused')">
          <button type="button" @click="reviewing = ask">Review</button>
          <button type="button" @click="act(ask.id, 'remove')">Remove</button>
        </template>
      </span>
    </div>
    <p v-if="error" class="agent-ask-bar-error" role="alert">{{ error }}</p>
    <AskReviewDialog :ask-id="reviewing?.id ?? null" :title="reviewing ? `Work from ${reviewing.giver}'s agent` : ''" @close="reviewing = null" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { DesktopAgentAsk } from "../../../../../../electron/ipc-types/asks";
import { desktopIpc } from "../../../../ipc/index.js";
import { askLinkFor } from "./ask-links";
import AskReviewDialog from "./AskReviewDialog.vue";

const props = defineProps<{ roomIdentifier: string | null; refreshKey?: number }>();
const asks = ref<DesktopAgentAsk[]>([]);
const error = ref<string | null>(null);
const copiedId = ref<string | null>(null);
const reviewing = ref<DesktopAgentAsk | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

const visible = computed(() => asks.value.filter(ask => ask.is_asker || ask.state === "on_hold" || ask.state === "active" || ask.state === "paused"));

function line(ask: DesktopAgentAsk): string {
  const given = ask.given_model_label ?? ask.model_label;
  switch (ask.state) {
    case "open": return `Waiting for someone to add ${ask.model_label}`;
    case "claimed": return `${ask.giver ?? "Someone"} is adding ${ask.model_label}…`;
    case "on_hold": return `${ask.giver} added ${given} instead of ${ask.model_label}`;
    case "paused": return `${ask.giver}'s ${given} is offline`;
    default: return ask.given_amount_percent
      ? `${ask.giver}'s ${given} · ${ask.given_amount_percent}% given` : `${ask.giver}'s ${given}`;
  }
}

async function load() {
  if (!props.roomIdentifier || !desktopIpc.asks) { asks.value = []; return; }
  const result = await desktopIpc.asks.listRoom(props.roomIdentifier).catch(() => null);
  if (result?.ok) asks.value = result.value;
}

async function act(askId: string, action: "cancel" | "accept" | "decline" | "remove") {
  error.value = null;
  const result = await desktopIpc.asks?.act(askId, action);
  if (result && !result.ok) error.value = result.error;
  await load();
}

async function copy(askId: string) {
  const link = askLinkFor(askId);
  if (!link) return;
  try { await navigator.clipboard.writeText(link); copiedId.value = askId; } catch { copiedId.value = null; }
}

watch(() => [props.roomIdentifier, props.refreshKey], () => {
  void load();
  if (timer) clearInterval(timer);
  timer = props.roomIdentifier ? setInterval(() => void load(), 15_000) : null;
}, { immediate: true });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>
