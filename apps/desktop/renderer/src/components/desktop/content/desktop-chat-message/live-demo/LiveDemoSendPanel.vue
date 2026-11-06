<template>
  <div class="live-demo-send">
    <div class="live-demo-send-shot">
      <img v-if="previewUrl" :src="previewUrl" alt="Picture of the demo with its marks">
      <p v-else>No preview is available for this picture.</p>
    </div>
    <p class="live-demo-send-meta">
      {{ caption }}
      <template v-if="partial"> Only the part on screen is in the picture.</template>
    </p>
    <div v-if="notes.pins.length || notes.inkBy.length" class="live-demo-send-notes">
      <p class="live-demo-send-notes-head">Sent as text with the picture</p>
      <p v-for="pin in notes.pins.slice(0, 6)" :key="pin.number" class="live-demo-send-note" :style="{ '--live-color': pin.color }">
        <i aria-hidden="true"></i>
        <span><b>{{ pin.number }}. {{ pin.author }}:</b> {{ pin.text }}</span>
      </p>
      <p v-if="notes.pins.length > 6" class="live-demo-send-note is-more">and {{ notes.pins.length - 6 }} more pins</p>
      <p v-if="notes.inkBy.length" class="live-demo-send-note is-ink">
        <span>Drawings: {{ notes.inkBy.map((ink) => `${ink.author} (${ink.colorName})`).join(", ") }}</span>
      </p>
    </div>
    <input
      v-model="note"
      class="live-demo-send-input"
      type="text"
      maxlength="1000"
      placeholder="Add a note (optional)"
      aria-label="Note for the picture"
      data-autofocus
      :disabled="sending"
      @keydown.enter.prevent="!sending && $emit('confirm', note)"
    >
    <p v-if="error" class="live-demo-send-error" role="alert">{{ error }}</p>
    <div class="live-demo-send-actions">
      <button type="button" class="live-demo-button" :disabled="sending" @click="$emit('cancel')">Cancel</button>
      <button type="button" class="live-demo-button is-primary" :disabled="sending" @click="$emit('confirm', note)">
        {{ sending ? "Sending…" : "Send to thread" }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { MarkupNotes } from "./markup";

const props = defineProps<{
  /** A data URL of the picture, or null when main made none. */
  previewUrl: string | null;
  /** The picture shows only part of the demo. */
  partial: boolean;
  markCount: number;
  notes: MarkupNotes;
  sending: boolean;
  error: string;
}>();

defineEmits<{
  confirm: [note: string];
  cancel: [];
}>();

const note = ref("");

const caption = computed(() => {
  const marks = props.markCount === 1 ? "1 mark" : `${props.markCount} marks`;
  return `Card as shown · ${marks}. Other people's pointers are left out.`;
});
</script>
