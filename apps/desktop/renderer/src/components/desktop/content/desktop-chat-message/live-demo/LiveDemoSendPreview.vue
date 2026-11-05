<template>
  <section ref="root" class="room-inline-demo-preview" aria-label="Picture to send" @keydown.escape.stop.prevent="$emit('cancel')">
    <img v-if="previewUrl" :src="previewUrl" alt="Picture of the demo with its marks">
    <p v-else class="room-inline-demo-preview-none">No preview is available for this picture.</p>
    <div class="room-inline-demo-preview-side">
      <p class="room-inline-demo-preview-title">Send this picture to the thread?</p>
      <p v-if="partial" class="room-inline-demo-preview-note">It shows only the part of the demo that is on screen.</p>
      <p v-if="error" class="room-inline-demo-preview-note is-error" role="alert">{{ error }}</p>
      <div class="room-inline-demo-preview-actions">
        <button type="button" :disabled="sending" @click="$emit('cancel')">Cancel</button>
        <button ref="confirm" type="button" class="is-primary" :disabled="sending" @click="$emit('confirm')">
          {{ sending ? "Sending…" : "Send to thread" }}
        </button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";

defineProps<{
  /** A data URL of the picture, or null when main made none. */
  previewUrl: string | null;
  /** The picture shows only part of the demo. */
  partial: boolean;
  sending: boolean;
  error: string;
}>();

defineEmits<{
  confirm: [];
  cancel: [];
}>();

const root = ref<HTMLElement | null>(null);
const confirm = ref<HTMLButtonElement | null>(null);

// The person asked for this picture. The card was scrolled into view to take it,
// which can leave this panel above the list's edge, so bring it into view, and
// give the keyboard to its answer.
onMounted(() => {
  root.value?.scrollIntoView({ block: "nearest", inline: "nearest" });
  confirm.value?.focus({ preventScroll: true });
});
</script>
