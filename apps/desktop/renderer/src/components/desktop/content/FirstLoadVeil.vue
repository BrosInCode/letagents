<template>
  <!--
    The first load after the app opens: only the ink, over the whole window, while the
    sidebar and the room load underneath. App.vue removes it through the room-arrival
    transition, so the app appears all at once (room-loader-handoff.ts).
  -->
  <div class="first-load-veil" data-testid="first-load-veil">
    <InkRoomLoader :label="label" />
    <div class="first-load-veil-drag" aria-hidden="true" />
  </div>
</template>

<script setup lang="ts">
import InkRoomLoader from "./InkRoomLoader.vue";

defineProps<{ label: string }>();
</script>

<style scoped>
.first-load-veil { position: fixed; inset: 0; z-index: 200; background: #000; }
/* The window still moves by its top edge while it loads; the macOS buttons sit there. */
.first-load-veil-drag { position: absolute; inset: 0 0 auto; height: 52px; -webkit-app-region: drag; }
</style>
