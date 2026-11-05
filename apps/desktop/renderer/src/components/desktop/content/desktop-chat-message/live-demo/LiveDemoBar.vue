<template>
  <div class="room-inline-demo-live" role="group" aria-label="Live demo">
    <div v-if="chips.chips.length" class="room-inline-demo-presence" aria-label="People viewing this demo">
      <span
        v-for="chip in chips.chips"
        :key="chip.cid"
        class="room-inline-demo-chip"
        :style="{ '--live-color': chip.color }"
        :title="chip.self ? `${chip.name} (you)` : chip.name"
      >
        <i aria-hidden="true"></i>
        <span>{{ chip.self ? "You" : chip.name }}</span>
      </span>
      <span v-if="chips.more > 0" class="room-inline-demo-chip is-more">+{{ chips.more }}</span>
    </div>
    <span v-if="statusText" class="room-inline-demo-live-status" role="status">{{ statusText }}</span>
    <div class="room-inline-demo-live-tools">
      <template v-if="drawing">
        <div class="room-inline-demo-tool-group" role="group" aria-label="Drawing tool">
          <button
            type="button"
            :aria-pressed="tool === 'pen'"
            :class="{ 'is-active': tool === 'pen' }"
            @click="$emit('set-tool', 'pen')"
          >
            <Pencil :size="13" aria-hidden="true" />
            <span>Pen</span>
          </button>
          <button
            type="button"
            :aria-pressed="tool === 'pin'"
            :class="{ 'is-active': tool === 'pin' }"
            @click="$emit('set-tool', 'pin')"
          >
            <MapPin :size="13" aria-hidden="true" />
            <span>Pin</span>
          </button>
        </div>
        <button type="button" class="is-primary" title="Stop drawing (Esc)" @click="$emit('toggle-draw')">Done</button>
      </template>
      <button
        v-else
        type="button"
        title="Draw or add pins on this demo for everyone viewing it"
        :disabled="drawDisabled"
        @click="$emit('toggle-draw')"
      >
        <Pencil :size="13" aria-hidden="true" />
        <span>Draw</span>
      </button>
      <button
        v-if="markCount > 0"
        type="button"
        :aria-expanded="marksOpen"
        title="Show who marked this demo"
        @click="$emit('toggle-marks')"
      >Marks {{ markCount }}</button>
      <button
        v-if="canSend"
        type="button"
        title="Post a picture of this demo, with its marks, as a reply in the thread"
        :disabled="sending"
        @click="$emit('send')"
      >
        <Send :size="13" aria-hidden="true" />
        <span>{{ sending ? "Sending…" : "Send to thread" }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { MapPin, Pencil, Send } from "@lucide/vue";
import { presenceChips } from "./people";
import type { LiveDemoPerson } from "./protocol";

const props = defineProps<{
  people: readonly LiveDemoPerson[];
  selfCid: string | null;
  statusText: string;
  drawing: boolean;
  tool: "pen" | "pin";
  drawDisabled: boolean;
  markCount: number;
  marksOpen: boolean;
  canSend: boolean;
  sending: boolean;
}>();

defineEmits<{
  "toggle-draw": [];
  "set-tool": [tool: "pen" | "pin"];
  "toggle-marks": [];
  send: [];
}>();

const chips = computed(() => presenceChips(props.people, props.selfCid));
</script>
