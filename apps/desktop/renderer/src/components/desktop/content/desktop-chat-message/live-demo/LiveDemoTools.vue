<template>
  <div class="live-demo-tools" role="toolbar" aria-label="Demo tools">
    <button
      class="live-demo-tool"
      type="button"
      data-tool="pin"
      :aria-pressed="pinning"
      :disabled="!canMark"
      title="Pin a note on the demo (P)"
      @click="$emit('pin')"
    >
      <MapPin :size="15" aria-hidden="true" />
      <span class="live-demo-tool-label">Pin</span>
    </button>
    <button
      class="live-demo-tool"
      type="button"
      data-tool="draw"
      :aria-pressed="drawing"
      :disabled="!canMark"
      title="Draw on the demo for everyone here (D)"
      @click="$emit('draw')"
    >
      <PenLine :size="15" aria-hidden="true" />
      <span class="live-demo-tool-label">Draw</span>
    </button>
    <button
      class="live-demo-tool"
      type="button"
      data-pop="marks"
      :aria-expanded="openPop === 'marks'"
      :disabled="!ready"
      :aria-label="`Marks on this demo: ${markCount}`"
      title="Marks on this demo"
      @click="$emit('toggle-pop', 'marks')"
    >
      <List :size="15" aria-hidden="true" />
      <span class="live-demo-tool-count">{{ markCount }}</span>
    </button>
    <button
      v-if="canSend"
      class="live-demo-tool"
      type="button"
      data-pop="send"
      :aria-expanded="openPop === 'send'"
      :disabled="!ready || sendBusy"
      title="Send a picture of this demo, with its marks, to the thread"
      @click="$emit('send')"
    >
      <ArrowUpRight :size="15" aria-hidden="true" />
      <span class="live-demo-tool-label">Send to thread</span>
    </button>
    <button
      class="live-demo-tool is-icon"
      type="button"
      data-pop="more"
      :aria-expanded="openPop === 'more'"
      aria-label="More"
      title="More"
      @click="$emit('toggle-pop', 'more')"
    >
      <Ellipsis :size="15" aria-hidden="true" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { ArrowUpRight, Ellipsis, List, MapPin, PenLine } from "@lucide/vue";

export type LiveDemoPop = "marks" | "send" | "more";

defineProps<{
  /** The demo runs and has joined: the marks can be read. */
  ready: boolean;
  /** Pin and Draw work now. */
  canMark: boolean;
  pinning: boolean;
  drawing: boolean;
  markCount: number;
  canSend: boolean;
  sendBusy: boolean;
  openPop: LiveDemoPop | null;
}>();

defineEmits<{
  pin: [];
  draw: [];
  send: [];
  "toggle-pop": [pop: LiveDemoPop];
}>();
</script>
