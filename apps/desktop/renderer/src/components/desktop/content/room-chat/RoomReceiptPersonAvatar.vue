<template>
  <span class="room-receipt-avatar" :style="{ '--avatar-tint': tint }" :title="name">
    <img v-if="avatarUrl && !failed" :src="avatarUrl" alt="" draggable="false" @error="failed = true" />
    <template v-else>{{ initial }}</template>
  </span>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{ name: string; avatarUrl: string | null }>();
const failed = ref(false);
const initial = computed(() => (props.name.trim()[0] ?? "?").toUpperCase());
// A person keeps one tint wherever their initial shows.
const tints = ["#86efac", "#fcd34d", "#f9a8d4", "#a5b4fc", "#fdba74", "#67e8f9", "#d8b4fe"];
const tint = computed(() => {
  let hash = 5381;
  for (const char of props.name) hash = ((hash << 5) + hash + char.charCodeAt(0)) >>> 0;
  return tints[hash % tints.length];
});
</script>
