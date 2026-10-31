<template>
  <div v-html="html"></div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { renderDesktopMarkdown } from "./markdown";

// Renders one markdown text. The computed only runs again when `text` or an option
// changes, so a parent that re-renders on a stream batch or a clock tick does not
// parse the unchanged notes again. Pass class and other attributes on the element.
const props = withDefaults(defineProps<{
  text: string;
  block?: boolean;
  mentions?: boolean;
  preservePaths?: boolean;
}>(), { block: true, mentions: true, preservePaths: false });

const html = computed(() => renderDesktopMarkdown(props.text, {
  block: props.block,
  mentions: props.mentions,
  preservePaths: props.preservePaths,
}));
</script>
