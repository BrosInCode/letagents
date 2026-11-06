<template>
  <div v-if="shown.faces.length" class="live-demo-faces" role="group" aria-label="People viewing this demo">
    <template v-for="face in shown.faces" :key="face.cid">
      <span
        v-if="face.self"
        class="live-demo-face is-self"
        :style="faceStyle(face.color)"
        data-tip="You"
        aria-label="You"
      >{{ face.initials }}</span>
      <button
        v-else
        class="live-demo-face"
        type="button"
        :style="faceStyle(face.color)"
        :data-tip="`${face.name} · click to find`"
        :aria-label="`Find ${face.name}'s pointer`"
        @click="$emit('find', face.cid)"
      >{{ face.initials }}</button>
    </template>
    <span
      v-if="shown.more > 0"
      class="live-demo-face is-more"
      :data-tip="`${shown.more} more`"
      :aria-label="`${shown.more} more`"
    >+{{ shown.more }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { presenceFaces, readableTextColor } from "./people";
import type { LiveDemoPerson } from "./protocol";

const props = defineProps<{
  people: readonly LiveDemoPerson[];
  selfCid: string | null;
}>();

defineEmits<{
  /** Show where this person's pointer is. */
  find: [cid: string];
}>();

const shown = computed(() => presenceFaces(props.people, props.selfCid));

function faceStyle(color: string): Record<string, string> {
  return { "--live-color": color, "--live-ink": readableTextColor(color) };
}
</script>
