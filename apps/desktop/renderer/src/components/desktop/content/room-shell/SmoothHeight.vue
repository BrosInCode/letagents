<template>
  <div
    class="room-settings-smooth-height"
    :data-animated="animated"
    :style="height === null ? undefined : { height: `${height}px` }"
  >
    <div ref="contentElement">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

/**
 * Follows the height of its content with a transition, so content that wraps
 * onto another line, appears or leaves does not make what is below it jump.
 */
const contentElement = ref<HTMLElement | null>(null);
const height = ref<number | null>(null);
const animated = ref(false);
let observer: ResizeObserver | undefined;

onMounted(() => {
  const content = contentElement.value;
  // Without a way to measure, the frame keeps its natural height.
  if (!content || typeof ResizeObserver === "undefined") return;
  observer = new ResizeObserver(([entry]) => {
    // The border box is not affected by the dialog's entrance transform.
    height.value = entry.borderBoxSize?.[0]?.blockSize ?? content.offsetHeight;
  });
  observer.observe(content);
  // The first height is taken, not travelled to.
  requestAnimationFrame(() => requestAnimationFrame(() => { animated.value = true; }));
});

onBeforeUnmount(() => observer?.disconnect());
</script>
