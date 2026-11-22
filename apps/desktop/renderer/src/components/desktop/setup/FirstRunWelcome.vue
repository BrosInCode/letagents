<template>
  <article ref="frame" class="welcome-screen" :data-leaving="leaving" :data-handoff-state="handoffState"
    :inert="leaving || undefined" :aria-hidden="leaving || undefined" data-testid="first-run-welcome">
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
        <h1 ref="heading" tabindex="-1">Make room to<br>work together.</h1>
        <p>One room for your team and your agents.</p>
      </div>
      <button type="button" class="primary-button onboarding-primary welcome-start" :disabled="busy"
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
import { createHandoffPainter, handoffStillTime, type HandoffMark } from "../../../../../../../shared/ui/room-handoff.mjs";
import LetAgentsLogoMark from "../brand/LetAgentsLogoMark.vue";

const props = defineProps<{ busy: boolean; feedback: string | null; leaving: boolean }>();
const emit = defineEmits<{ start: []; settle: [] }>();
const frame = ref<HTMLElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const heading = ref<HTMLElement | null>(null);
const available = ref(false);
const paused = ref(false);
const reduced = ref(false);
const fullScreen = ref(false);
const supportsFullscreen = ref(false);
const handoffState = ref(props.leaving ? "settled" : "idle");
const handoffDuration = 800;
const paintInterval = 1000 / 60;
let paint: ReturnType<typeof createHandoffPainter> | undefined;
let context: CanvasRenderingContext2D | null = null;
let observer: ResizeObserver | undefined;
let preference: MediaQueryList | undefined;
let width = 0, height = 0, elapsed = 0, last = 0, animation = 0;
let nextPaint = 0;
let needsDraw = true;
let startedAt = 0;
let mark: HandoffMark | undefined;

function placeMark() {
  const surface = canvas.value?.getBoundingClientRect();
  const logo = frame.value?.parentElement?.querySelector<SVGSVGElement>("[data-onboarding-logo-seat]");
  if (!surface || !logo) return undefined;
  const seat = logo.getBoundingClientRect();
  if (!seat.width || !seat.height) return undefined;
  const view = logo.viewBox.baseVal;
  const centerX = view.x + view.width / 2;
  const centerY = view.y + view.height / 2;
  const points = mark?.points ?? Array.from(logo.querySelectorAll("path, circle")).flatMap(path => {
    const segment = path as SVGGeometryElement;
    const length = segment.getTotalLength();
    const count = Math.max(2, Math.ceil(length / 2.6));
    return Array.from({ length: count }, (_, index) => {
      const point = segment.getPointAtLength(length * index / (count - 1));
      return { x: point.x - centerX, y: point.y - centerY, accent: path.localName === "circle" };
    });
  });
  if (!points.length) return undefined;
  return {
    x: seat.left + seat.width / 2 - surface.left,
    y: seat.top + seat.height / 2 - surface.top,
    scale: Math.min(seat.width / view.width, seat.height / view.height),
    progress: mark?.progress ?? 0,
    points,
  };
}

function settleHandoff() {
  handoffState.value = "settled";
  mark = undefined;
  needsDraw = false;
  context?.clearRect(0, 0, width, height);
  emit("settle");
}

function draw() {
  if (available.value && width && height && handoffState.value !== "settled") {
    paint?.(width, height, reduced.value ? handoffStillTime : elapsed, !reduced.value, mark);
  }
}

function tick(now: number) {
  animation = 0;
  // A deadline follows the display clock without painting all 120 Hz frames.
  // Tolerance absorbs fractional timestamps and refresh-rate jitter.
  const advance = canPlay() && (!last || now + 1 >= nextPaint);
  if (advance) {
    if (last && !paused.value) elapsed += Math.min((now - last) / 1000, .06);
    nextPaint = last
      ? Math.max(nextPaint + paintInterval, now + paintInterval / 2)
      : now + paintInterval;
    last = now;
    if (mark) {
      mark.progress = Math.min(1, (now - startedAt) / handoffDuration);
      if (mark.progress === 1) {
        settleHandoff();
        return;
      }
    }
  }
  if (advance || needsDraw) {
    draw();
    needsDraw = false;
  }
  scheduleFrame();
}

function canPlay() {
  return !reduced.value && (props.leaving ? Boolean(mark) : !paused.value);
}

function scheduleFrame() {
  if (!animation && available.value && width && height && !document.hidden && (needsDraw || canPlay())) {
    animation = requestAnimationFrame(tick);
  }
}

function updatePlayback() {
  cancelAnimationFrame(animation);
  animation = 0;
  last = 0;
  if (props.leaving && (reduced.value || !available.value || document.hidden) && handoffState.value === "moving") settleHandoff();
  scheduleFrame();
}

function sizeCanvas() {
  const surface = canvas.value;
  if (!surface || !context || !width || !height) return;
  const density = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(1_500_000 / (width * height)));
  const pixelWidth = Math.max(1, Math.floor(width * density));
  const pixelHeight = Math.max(1, Math.floor(height * density));
  if (surface.width !== pixelWidth) surface.width = pixelWidth;
  if (surface.height !== pixelHeight) surface.height = pixelHeight;
  context.setTransform(density, 0, 0, density, 0, 0);
  if (mark) mark = placeMark() ?? mark;
  needsDraw = true;
  scheduleFrame();
}

function lostContext() {
  available.value = false;
  context = null;
  updatePlayback();
}

function restoreContext() {
  context = canvas.value?.getContext("2d") ?? null;
  if (!context) return;
  paint = createHandoffPainter(context);
  available.value = true;
  sizeCanvas();
  updatePlayback();
}

function motionPreferenceChanged() {
  reduced.value = preference?.matches ?? false;
  needsDraw = true;
  updatePlayback();
}

function fullscreenChanged() {
  fullScreen.value = document.fullscreenElement === document.documentElement;
}

async function toggleFullscreen() {
  try {
    if (fullScreen.value) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { /* The OS can deny full screen while a window is transitioning. */ }
}

function replay() {
  elapsed = 0;
  paused.value = false;
  needsDraw = true;
  updatePlayback();
}

function start() {
  emit("start");
}

watch(() => props.leaving, leaving => {
  if (leaving) {
    mark = available.value && !reduced.value && !document.hidden ? placeMark() : undefined;
    if (!mark) settleHandoff();
    else {
      startedAt = performance.now();
      handoffState.value = "moving";
    }
  } else {
    mark = undefined;
    handoffState.value = "idle";
    needsDraw = true;
    heading.value?.focus({ preventScroll: true });
  }
  updatePlayback();
}, { flush: "post" });

watch(paused, updatePlayback);
onMounted(() => {
  supportsFullscreen.value = document.fullscreenEnabled;
  fullscreenChanged();
  preference = matchMedia("(prefers-reduced-motion: reduce)");
  reduced.value = preference.matches;
  preference.addEventListener("change", motionPreferenceChanged);
  document.addEventListener("visibilitychange", updatePlayback);
  document.addEventListener("fullscreenchange", fullscreenChanged);
  canvas.value?.addEventListener("contextlost", lostContext);
  canvas.value?.addEventListener("contextrestored", restoreContext);
  if (frame.value) {
    observer = new ResizeObserver(([entry]) => {
      const size = entry.contentRect;
      if (width === size.width && height === size.height) return;
      width = size.width;
      height = size.height;
      sizeCanvas();
    });
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
.welcome-screen canvas { position: absolute; z-index: -1; inset: 0; width: 100%; height: 100%; pointer-events: none; mask-image: linear-gradient(black 60%, transparent 100%); }
.welcome-screen[data-leaving="true"] { position: absolute; inset: 0; min-height: 0; pointer-events: none; }
.welcome-screen[data-leaving="true"] canvas { mask-image: none; }
.welcome-screen[data-leaving="true"] .welcome-top,
.welcome-screen[data-leaving="true"] .welcome-content { opacity: 0; }
.welcome-top, .welcome-content { transition: opacity 180ms ease; }
.welcome-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: var(--welcome-brand-top, 16px) clamp(16px, 4vw, 56px) 16px; }
.welcome-brand, .welcome-controls, .welcome-control { display: flex; align-items: center; gap: 8px; }
.welcome-brand { min-height: 36px; font-weight: 640; }
.welcome-brand svg { width: 24px; height: 24px; }
.welcome-control { min-height: 36px; border: 0; border-radius: 8px; padding: 0 8px; background: transparent; color: #b9bfba; font: inherit; font-size: 12px; cursor: pointer; }
.welcome-control:hover { background: #ffffff10; color: #f3f5ef; }
.welcome-control svg, .welcome-start svg { width: 15px; height: 15px; }
.welcome-content { grid-row: 3; display: flex; align-items: flex-end; justify-content: space-between; flex-wrap: wrap; gap: 22px; padding: 0 clamp(24px, 6vw, 104px) clamp(32px, 7vh, 86px); }
.welcome-content h1 { margin: 0; font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif; font-size: clamp(48px, min(8vw, 12vh), 112px); font-weight: 500; line-height: .93; letter-spacing: -.06em; }
.welcome-content h1:focus { outline: none; }
.welcome-content p { margin: 16px 0 0; color: #b0b9b2; line-height: 1.5; }
.welcome-content .welcome-start { gap: 20px; min-height: 48px; --onboarding-accent: #a8dec7; }
.welcome-error { flex: 1 0 100%; }
button:focus-visible { outline: 2px solid #a8dec7; outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) { .welcome-top, .welcome-content { transition: none; } }
</style>
