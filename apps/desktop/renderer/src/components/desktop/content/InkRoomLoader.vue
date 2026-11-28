<template>
  <!-- While a room opens: the LetAgents mark in the two inks, simmering. -->
  <div class="ink-room-loader" role="status" aria-live="polite" data-testid="ink-room-loader">
    <canvas
      v-if="!ink.fallback.value"
      ref="sceneCanvas"
      class="ink-room-loader-scene"
      :data-veiled="ink.veiled.value"
      aria-hidden="true"
    />
    <OnboardingStaticMark v-else class="ink-room-loader-static" />
    <!-- The app's film grain, over the ink as on the welcome screen (the canvas is opaque). -->
    <div class="ink-room-loader-grain" aria-hidden="true" />
    <span class="ink-room-loader-label">Opening {{ label }}</span>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useInkScene } from "../../../../../../../shared/ui/ink/useInkScene";
import OnboardingStaticMark from "../onboarding/OnboardingStaticMark.vue";
import { useRoomLoaderLeaving } from "./room-loader-handoff";

defineProps<{ label: string }>();

const sceneCanvas = ref<HTMLCanvasElement | null>(null);
// The room arrived: while this screen fades out over the room, the mark lets go as
// soft smoke. Any other fade (to an error card) keeps it simmering.
const roomArriving = useRoomLoaderLeaving();
// The mark is already formed (no opening at every launch) and simmers while the room loads.
const ink = useInkScene({
  canvas: sceneCanvas,
  placeMark: () => ({ center: [0.5, 0.5], height: 0.15 }),
  formed: true,
  // Pure black, as the app background.
  water: [0, 0, 0],
  leaving: () => (roomArriving.value ? "success" : null),
});
onMounted(() => ink.setMode("simmer"));
</script>

<style scoped>
.ink-room-loader { position: absolute; inset: 0; overflow: hidden; background: #000; }
.ink-room-loader-scene {
  position: absolute; inset: 0; width: 100%; height: 100%;
  transition: opacity 520ms cubic-bezier(0.23, 1, 0.32, 1);
}
.ink-room-loader-scene[data-veiled="true"] { opacity: 0; transition: none; }
/* Set by the Backgrounds texture switch (app-texture.css); none when it is off. */
.ink-room-loader-grain {
  position: absolute; inset: 0; pointer-events: none;
  background-image: var(--grain-background, none);
}
.ink-room-loader .ink-room-loader-static { z-index: 0; top: 50%; width: 15vh; height: 15vh; }
/* Only for screen readers: the screen shows the mark alone. */
.ink-room-loader-label {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) {
  .ink-room-loader-scene { transition: opacity 200ms linear; }
}
</style>
