<template>
  <DisclosurePanel
    :open="open"
    class="connector-disclosure"
    @toggle="open = !open"
    ><template #summary
      ><span>{{ title }}</span></template
    >
    <div class="connector-disclosure-body"><slot /></div
  ></DisclosurePanel>
</template>
<script setup lang="ts">
import { ref, watch } from "vue";
import DisclosurePanel from "../DisclosurePanel.vue";
const props = defineProps<{ title: string; initiallyOpen?: boolean }>();
const open = ref(props.initiallyOpen === true);
watch(
  () => props.initiallyOpen,
  (value) => {
    if (value) open.value = true;
  },
);
</script>
