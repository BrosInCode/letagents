<template>
  <canvas
    ref="canvas"
    class="room-activity-orb"
    :width="backing"
    :height="backing"
    :style="{ width: `${size}px`, height: `${size}px` }"
    :data-orb="state"
    role="img"
    :aria-label="ACTIVITY_ORB_LABELS[state]"
  ></canvas>
</template>

<script setup lang="ts">
// A thinking-orbs style indicator (see activity-orb.ts for the MIT notice).
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ACTIVITY_ORB_LABELS, activityOrbClock, drawActivityOrb, type ActivityOrbHost, type ActivityOrbState } from "./activity-orb";

const props = withDefaults(defineProps<{ state: ActivityOrbState; size?: number }>(), { size: 20 });
const canvas = ref<HTMLCanvasElement | null>(null);
// Two backing pixels per CSS pixel: sharp on Retina, cheap everywhere.
const backing = props.size * 2;
let onScreen = true;
let observer: IntersectionObserver | null = null;
const clock = activityOrbClock();

/** The dots take the text colour, so the orb follows the theme. It is read once a second, not every frame. */
let inkValue = "";
let inkReadAt = -Infinity;
function ink(element: HTMLCanvasElement): string {
  const now = Date.now();
  if (now - inkReadAt < 1_000 && inkValue) return inkValue;
  inkReadAt = now;
  const color = typeof getComputedStyle === "function" ? getComputedStyle(element).color : "";
  inkValue = color.match(/\d+(\.\d+)?/g)?.slice(0, 3).join(",") || "250,250,250";
  return inkValue;
}

const host: ActivityOrbHost = {
  draw(t) {
    const element = canvas.value;
    const context = element?.getContext?.("2d");
    if (element && context) drawActivityOrb(context, props.state, t, backing, ink(element));
  },
  visible: () => onScreen,
};

onMounted(() => {
  clock.add(host);
  if (typeof IntersectionObserver === "function" && canvas.value) {
    observer = new IntersectionObserver((entries) => {
      onScreen = entries.some((entry) => entry.isIntersecting);
      clock.refresh();
    });
    observer.observe(canvas.value);
  }
});
// A new state paints at once, even under reduced motion.
watch(() => props.state, () => clock.refresh());
onBeforeUnmount(() => {
  observer?.disconnect();
  clock.remove(host);
});
</script>

<style scoped>
.room-activity-orb { display: block; flex: 0 0 auto; }
</style>
