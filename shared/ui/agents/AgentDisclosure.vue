<template>
  <article class="agent-disclosure" :data-open="open" :data-instant="instant">
    <button
      ref="trigger"
      type="button"
      class="agent-disclosure-trigger"
      :aria-expanded="open"
      :aria-controls="id"
      @click="toggle"
    >
      <span class="agent-disclosure-summary"><slot name="summary" /></span>
      <svg
        class="agents-chevron"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="m6 4 4 4-4 4"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <div
      :id="id"
      class="agent-disclosure-grid"
      :inert="!open"
      :aria-hidden="!open"
    >
      <div class="agent-disclosure-clip">
        <div v-if="visited" class="agent-disclosure-body"><slot /></div>
      </div>
    </div>
  </article>
</template>
<script setup lang="ts">
import { ref, useId } from "vue";
const id = `agent-detail-${useId()}`;
const open = ref(false);
const visited = ref(false);
const instant = ref(false);
const trigger = ref<HTMLButtonElement>();
function toggle(event: MouseEvent) {
  instant.value = event.detail === 0;
  visited.value = true;
  open.value = !open.value;
}
</script>
<style src="./agents.css"></style>
