<template>
  <DisclosurePanel class="agent-disclosure" :open="open" trigger-class="agent-disclosure-trigger" @toggle="toggle">
    <template #summary><slot name="summary" /></template>
    <div v-if="visited" class="agent-disclosure-body"><slot /></div>
  </DisclosurePanel>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import DisclosurePanel from '../DisclosurePanel.vue';
const open = ref(false);
const visited = ref(false);
function toggle() {
  visited.value = true;
  open.value = !open.value;
}
</script>
<style src="./agents.css"></style>
