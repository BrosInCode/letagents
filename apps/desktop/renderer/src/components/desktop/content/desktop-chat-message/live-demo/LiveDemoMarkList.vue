<template>
  <ul class="room-inline-demo-marks" aria-label="Marks on this demo">
    <li
      v-for="mark in marks"
      :key="mark.id"
      @mouseenter="$emit('highlight', mark.id)"
      @mouseleave="$emit('highlight', null)"
      @focusin="$emit('highlight', mark.id)"
      @focusout="$emit('highlight', null)"
    >
      <i :style="{ background: mark.author.color }" aria-hidden="true"></i>
      <span class="room-inline-demo-mark-who">{{ mark.author.name }}</span>
      <span class="room-inline-demo-mark-what">{{ describeMark(mark) }}</span>
      <button
        v-if="isOwn(mark)"
        type="button"
        :aria-label="`Delete ${describeMark(mark)}`"
        :disabled="busyIds.has(mark.id)"
        @click="$emit('delete', mark.id)"
      >{{ busyIds.has(mark.id) ? "Deleting…" : "Delete" }}</button>
    </li>
  </ul>
</template>

<script setup lang="ts">
import { describeMark } from "./marks";
import type { DemoMark } from "./protocol";

defineProps<{
  marks: readonly DemoMark[];
  isOwn: (mark: DemoMark) => boolean;
  busyIds: ReadonlySet<string>;
}>();

defineEmits<{
  delete: [id: string];
  highlight: [id: string | null];
}>();
</script>
