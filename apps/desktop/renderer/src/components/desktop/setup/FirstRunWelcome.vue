<template>
  <article ref="frame" class="welcome-screen" data-testid="first-run-welcome">
    <canvas ref="canvas" aria-hidden="true" />
    <header class="welcome-top">
      <span class="welcome-brand"><LetAgentsLogoMark aria-hidden="true" />LetAgents</span>
      <div class="welcome-controls">
        <button v-if="available && !reduced" type="button" class="welcome-control" @click="paused = !paused">
          <Play v-if="paused" aria-hidden="true" /><Pause v-else aria-hidden="true" />
          {{ paused ? "Play" : "Pause" }}
        </button>
        <button v-if="available && !reduced" type="button" class="welcome-control" @click="replay">
          <RotateCcw aria-hidden="true" />Replay
        </button>
        <button v-if="supportsFullscreen" type="button" class="welcome-control"
          :aria-label="fullScreen ? 'Exit full screen' : 'Full screen'" @click="toggleFullscreen">
          <Minimize v-if="fullScreen" aria-hidden="true" /><Maximize v-else aria-hidden="true" />
        </button>
      </div>
    </header>
    <div class="welcome-content">
      <div>
        <h1>Make room to<br>work together.</h1>
        <p>One room for your team and your agents.</p>
      </div>
      <button type="button" class="primary-button welcome-start" :disabled="busy"
        data-testid="first-run-start-setup" @click="start">
        Get started <ArrowRight aria-hidden="true" />
      </button>
      <p v-if="feedback" class="welcome-error" role="status" data-testid="first-run-feedback">{{ feedback }}</p>
    </div>
  </article>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { ArrowRight, Maximize, Minimize, Pause, Play, RotateCcw } from "@lucide/vue";
import { createHandoffPainter, handoffStillTime } from "../../../../../../../shared/ui/room-handoff.mjs";
import LetAgentsLogoMark from "../brand/LetAgentsLogoMark.vue";

defineProps<{ busy: boolean; feedback: string | null }>();
const emit = defineEmits<{ start: [] }>();
const frame = ref<HTMLElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const available = ref(false);
const paused = ref(false);
const reduced = ref(false);
const fullScreen = ref(false);
const supportsFullscreen = ref(false);
let paint: ReturnType<typeof createHandoffPainter> | undefined;
let observer: ResizeObserver | undefined;
let preference: MediaQueryList | undefined;
let width = 0, height = 0, elapsed = 0, last = 0, animation = 0;

function draw() {
  if (available.value && width && height) {
    paint?.(width, height, reduced.value ? handoffStillTime : elapsed, !reduced.value);
  }
}

function tick(now: number) {
  if (!last || now - last >= 29) {
    if (last) elapsed += Math.min((now - last) / 1000, .06);
    last = now;
    draw();
  }
  animation = requestAnimationFrame(tick);
}

function updatePlayback() {
  cancelAnimationFrame(animation);
  last = 0;
  if (available.value && !reduced.value && !paused.value && !document.hidden) animation = requestAnimationFrame(tick);
}

function resize() {
  const surface = canvas.value;
  const context = surface?.getContext("2d");
  if (!surface || !context || !frame.value) return;
  const size = frame.value.getBoundingClientRect();
  if (!size.width || !size.height) return;
  width = size.width;
  height = size.height;
  const density = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(1_500_000 / (width * height)));
  surface.width = Math.max(1, Math.floor(width * density));
  surface.height = Math.max(1, Math.floor(height * density));
  context.setTransform(density, 0, 0, density, 0, 0);
  draw();
}

function lostContext() {
  available.value = false;
  updatePlayback();
}

function restoreContext() {
  const context = canvas.value?.getContext("2d");
  if (!context) return;
  paint = createHandoffPainter(context);
  available.value = true;
  resize();
  updatePlayback();
}

function motionPreferenceChanged() {
  reduced.value = preference?.matches ?? false;
  draw();
  updatePlayback();
}

function fullscreenChanged() {
  fullScreen.value = document.fullscreenElement === frame.value;
}

async function toggleFullscreen() {
  try {
    if (fullScreen.value) await document.exitFullscreen();
    else await frame.value?.requestFullscreen();
  } catch { /* The OS can deny full screen while a window is transitioning. */ }
}

function replay() {
  elapsed = 0;
  paused.value = false;
  draw();
  updatePlayback();
}

async function start() {
  if (fullScreen.value) await document.exitFullscreen().catch(() => undefined);
  emit("start");
}

watch(paused, updatePlayback);
onMounted(() => {
  supportsFullscreen.value = document.fullscreenEnabled;
  preference = matchMedia("(prefers-reduced-motion: reduce)");
  reduced.value = preference.matches;
  preference.addEventListener("change", motionPreferenceChanged);
  document.addEventListener("visibilitychange", updatePlayback);
  document.addEventListener("fullscreenchange", fullscreenChanged);
  canvas.value?.addEventListener("contextlost", lostContext);
  canvas.value?.addEventListener("contextrestored", restoreContext);
  if (frame.value) {
    observer = new ResizeObserver(resize);
    observer.observe(frame.value);
  }
  restoreContext();
});
onUnmounted(() => {
  cancelAnimationFrame(animation);
  observer?.disconnect();
  preference?.removeEventListener("change", motionPreferenceChanged);
  document.removeEventListener("visibilitychange", updatePlayback);
  document.removeEventListener("fullscreenchange", fullscreenChanged);
  canvas.value?.removeEventListener("contextlost", lostContext);
  canvas.value?.removeEventListener("contextrestored", restoreContext);
});
</script>

<style scoped>
.welcome-screen {
  grid-area: 1 / 1;
  position: relative;
  isolation: isolate;
  display: grid;
  grid-template-rows: auto 1fr auto;
  min-height: max(450px, calc(100dvh - 56px));
  color: #eeefe8;
  background: radial-gradient(ellipse at 50% 32%, #182620, transparent 68%), #0c0e0d;
  overflow: clip;
}
.welcome-screen:fullscreen { min-height: 100dvh; }
.welcome-screen canvas { position: absolute; z-index: -1; inset: 0; width: 100%; height: 100%; pointer-events: none; mask-image: linear-gradient(black 60%, transparent 100%); }
.welcome-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px clamp(16px, 4vw, 56px); }
.welcome-brand, .welcome-controls, .welcome-control { display: flex; align-items: center; gap: 8px; }
.welcome-brand { font-weight: 640; }
.welcome-brand svg { width: 24px; height: 24px; }
.welcome-control { min-height: 36px; border: 0; border-radius: 8px; padding: 0 8px; background: transparent; color: #b9bfba; font: inherit; font-size: 12px; cursor: pointer; }
.welcome-control:hover { background: #ffffff10; color: #f3f5ef; }
.welcome-control svg, .welcome-start svg { width: 15px; height: 15px; }
.welcome-content { grid-row: 3; display: flex; align-items: flex-end; justify-content: space-between; flex-wrap: wrap; gap: 22px; padding: 0 clamp(24px, 6vw, 104px) clamp(32px, 7vh, 86px); }
.welcome-content h1 { margin: 0; font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif; font-size: clamp(48px, min(8vw, 12vh), 112px); font-weight: 500; line-height: .93; letter-spacing: -.06em; }
.welcome-content p { margin: 16px 0 0; color: #b0b9b2; line-height: 1.5; }
.welcome-content .welcome-start { display: inline-flex; align-items: center; gap: 20px; min-height: 48px; padding: 0 17px; border: 1px solid #42534c; border-radius: 12px; color: #eef4ef; background: #2a3630; }
.welcome-start svg { color: #a8dec7; transition: transform 220ms cubic-bezier(.22,.84,.32,1.25); }
.welcome-start:hover svg, .welcome-start:focus-visible svg { transform: translateX(3px); }
.welcome-start:active { transform: scale(.97); }
.welcome-error { flex: 1 0 100%; }
button:focus-visible { outline: 2px solid #a8dec7; outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) { .welcome-start, .welcome-start svg { transition: none; transform: none; } }
</style>
