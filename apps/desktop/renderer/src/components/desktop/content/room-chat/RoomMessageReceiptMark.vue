<template>
  <button
    v-if="receipt"
    ref="mark"
    type="button"
    class="room-receipt-mark"
    :data-tone="summary!.tone"
    :data-receipt-mark="messageId"
    aria-haspopup="dialog"
    :aria-expanded="isOpen"
    :aria-label="`${summary!.title}. Show who this message woke`"
    @click.stop="toggle"
  >
    <template v-if="summary!.tone === 'nobody'">
      <span class="room-receipt-mark-glyph" aria-hidden="true"><CircleAlert :size="12" :stroke-width="2" /></span>
      <span>Nobody woken</span>
    </template>
    <template v-else>
      <span class="room-receipt-mark-logos" aria-hidden="true">
        <template v-for="agent in logoAgents" :key="agent.agentKey">
          <img v-if="agent.icon" :src="agent.icon" alt="" draggable="false" />
          <Bot v-else :size="11" />
        </template>
      </span>
      <span class="room-receipt-mark-glyph" aria-hidden="true">
        <span v-if="summary!.tone === 'active'" class="room-receipt-dots"><i /><i /><i /></span>
        <CircleAlert v-else-if="summary!.tone === 'attention'" :size="12" :stroke-width="2" />
        <Check v-else-if="summary!.tone === 'positive'" :size="12" :stroke-width="2.4" />
        <Minus v-else :size="12" :stroke-width="2.2" />
      </span>
      <span v-if="summary!.total > 1" class="room-receipt-mark-count">{{ summary!.replied }}/{{ summary!.total }}</span>
    </template>
  </button>
</template>

<script setup lang="ts">
import { Bot, Check, CircleAlert, Minus } from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";

import { injectRoomMessageReceipts } from "../../../../composables/useRoomMessageReceipts";
import { orderReceiptAgents, summarizeReceipt } from "../../../../domain/message-receipt-view";
import { providerIconForLabel } from "./provider-icon";

const props = defineProps<{ messageId: string }>();

const receipts = injectRoomMessageReceipts();
const mark = ref<HTMLButtonElement | null>(null);

let untrack: (() => void) | null = null;
watch(() => props.messageId, (messageId) => {
  untrack?.();
  untrack = receipts?.track(messageId) ?? null;
}, { immediate: true });
onBeforeUnmount(() => untrack?.());

const receipt = computed(() => receipts?.receiptFor(props.messageId) ?? null);
const summary = computed(() => receipt.value ? summarizeReceipt(receipt.value) : null);
const logoAgents = computed(() => orderReceiptAgents(receipt.value?.agents ?? []).slice(0, 3).map((agent) => ({
  agentKey: agent.agentKey,
  icon: providerIconForLabel(agent.provider, agent.agentKey),
})));
const isOpen = computed(() => receipts?.opened.value?.messageId === props.messageId);

function toggle(): void {
  if (!receipts || !mark.value) return;
  if (isOpen.value) receipts.close();
  else receipts.open({ messageId: props.messageId, anchor: mark.value });
}

defineExpose({ open: () => { if (!isOpen.value) toggle(); } });
</script>
