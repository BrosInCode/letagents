import { onMounted, onUnmounted, ref, type Ref } from "vue";
import { createInkScene, type InkMode, type InkScene } from "./ink-scene";

export interface InkMarkPlacement {
  /** Where the mark forms, in uv (y up). */
  center: [number, number];
  /** The mark's height as a part of the canvas height. */
  height: number;
}

export interface UseInkSceneOptions {
  canvas: Ref<HTMLCanvasElement | null>;
  /** Measures where the mark should form in the live layout. Called each time the scene is made. */
  placeMark?: () => InkMarkPlacement | null;
  /** Smaller grids: phones, small windows, coarse pointers. Defaults to a media query. */
  light?: () => boolean;
  /**
   * Start from the formed mark instead of playing the opening: it is simulated hidden, a
   * slice at a time, and fades in once formed. For screens seen often, such as a loader.
   */
  formed?: boolean;
}

/**
 * Drives the "Two inks" fluid scene with its performance guards, for every page that shows it:
 *
 * - The opening plays once, then nothing draws until the ink is stirred or a live mode runs.
 * - A late start (a skip, a hidden window, reduced motion, a rebuild) catches up a slice at a
 *   time: the whole opening is ~340 steps, a long GPU stall if sent in one frame.
 * - Reduced motion and rebuilds simulate under a veil and fade the formed mark in.
 * - A new window shape makes the scene again (the grids are sized to the shape), but a change
 *   of height alone by under 15% (a phone address bar) does not.
 * - A device that could not hold the opening near 60 fps gets no extra ink work.
 * - Missing WebGL2 half-float targets or a lost context switch to `fallback` (a static mark).
 * - Unmounting gives the WebGL context back at once.
 */
export function useInkScene(options: UseInkSceneOptions) {
  const fallback = ref(false);
  const veiled = ref(false);
  const skipped = ref(false);
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  let scene: InkScene | null = null;
  let frame = 0;
  let liveFrame = 0;
  let liveRunning = false;
  let waitFrame = 0;
  let startedAt = 0;
  let lastFrame = 0;
  let struggling = false;
  const frameTimes: number[] = [];
  let observer: ResizeObserver | undefined;
  let sceneShape = 0;
  let sceneWidth = 0;
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPointer: { x: number; y: number } | null = null;
  let pendingMode: InkMode | null = null;

  function openingTime(now = performance.now()) {
    if (!scene) return 0;
    if (reduced) return scene.end;
    return startedAt ? Math.min((now - startedAt) / 1000, scene.end) : 0;
  }

  function tick(now: number) {
    if (!scene) return;
    // The clock starts on the first drawn frame, as CSS animations do.
    if (!startedAt) startedAt = now;
    const t = openingTime(now);
    const caughtUp = scene.render(t);
    if (caughtUp && !veiled.value && t < scene.end && lastFrame) frameTimes.push(now - lastFrame);
    lastFrame = now;
    if (caughtUp && veiled.value) veiled.value = false;
    if (t < scene.end || !caughtUp) { frame = requestAnimationFrame(tick); return; }
    const sorted = frameTimes.slice().sort((a, b) => a - b);
    struggling = sorted.length > 30 && sorted[Math.floor(sorted.length / 2)] > 24;
    // A mode asked for during the opening starts once the mark has formed.
    if (pendingMode) { const mode = pendingMode; pendingMode = null; setMode(mode); }
  }
  function runOpening() {
    cancelAnimationFrame(frame);
    lastFrame = 0;
    frame = requestAnimationFrame(tick);
  }

  function build(canvas: HTMLCanvasElement): InkScene | null {
    const mark = options.placeMark?.() ?? null;
    let made: InkScene | null = null;
    try {
      const light = options.light ? options.light() : matchMedia("(max-width: 760px), (pointer: coarse)").matches;
      made = createInkScene(canvas, { light, markCenter: mark?.center, markHeight: mark?.height });
    } catch (error) {
      console.error(error);
    }
    const box = canvas.getBoundingClientRect();
    sceneShape = box.height ? box.width / box.height : 0;
    sceneWidth = box.width;
    return made;
  }

  function stopLive() {
    cancelAnimationFrame(liveFrame);
    liveRunning = false;
  }

  // The fixed time step draws the same picture for the same time, so a rebuilt scene is
  // simulated again (in slices, hidden) up to the same moment.
  function rebuild() {
    const canvas = options.canvas.value;
    if (!scene || !canvas) return;
    stopLive();
    scene.dispose();
    scene = build(canvas);
    if (!scene) { cancelAnimationFrame(frame); fallback.value = true; return; }
    veiled.value = true;
    runOpening();
  }

  function onResize() {
    const canvas = options.canvas.value;
    if (!scene || !canvas) return;
    scene.resize();
    const box = canvas.getBoundingClientRect();
    if (!box.height || !sceneShape || !sceneWidth) return;
    const shapeChange = Math.abs(box.width / box.height / sceneShape - 1);
    const widthChange = Math.abs(box.width / sceneWidth - 1);
    if (!(widthChange > .02 && shapeChange > .02) && shapeChange < .15) return;
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(rebuild, 180);
  }

  function onContextLost(event: Event) {
    event.preventDefault();
    cancelAnimationFrame(frame);
    stopLive();
    scene = null;
    fallback.value = true;
  }

  function start() {
    const canvas = options.canvas.value;
    if (!canvas || scene) return;
    scene = build(canvas);
    if (!scene) { fallback.value = true; return; }
    canvas.addEventListener("webglcontextlost", onContextLost, { once: true });
    observer = new ResizeObserver(onResize);
    observer.observe(canvas);
    startedAt = options.formed ? performance.now() - scene.end * 1000 : 0;
    veiled.value = reduced || Boolean(options.formed);
    runOpening();
  }

  /** A first look never holds anyone up: finish the opening now, as a short fast-forward. */
  function skip() {
    if (skipped.value || !scene) return;
    const now = performance.now();
    if (startedAt && (now - startedAt) / 1000 >= scene.end) return;
    skipped.value = true;
    startedAt = now - scene.end * 1000;
    runOpening();
  }

  function liveLoop(now: number) {
    if (!scene) { liveRunning = false; return; }
    liveRunning = scene.live(now);
    if (liveRunning) liveFrame = requestAnimationFrame(liveLoop);
  }
  function wake() {
    if (liveRunning) return;
    liveRunning = true;
    liveFrame = requestAnimationFrame(liveLoop);
  }

  /** Sign-in beats: simmer while waiting, dissolve on success, settle back on cancel. */
  function setMode(mode: InkMode) {
    if (!scene || reduced) return;
    if (!scene.ready()) {
      // Finish the opening first (in slices); the mode starts when the mark has formed.
      pendingMode = mode;
      skip();
      return;
    }
    stopLive();
    scene.setMode(mode);
    wake();
  }

  /** The person is the warm ink: a mouse over the water leaves a trail. Touch does nothing. */
  function stir(event: PointerEvent) {
    if (!scene || reduced || struggling || event.pointerType !== "mouse" || !scene.ready()) return;
    const box = options.canvas.value?.getBoundingClientRect();
    if (!box?.width) return;
    const x = (event.clientX - box.left) / box.width;
    const y = 1 - (event.clientY - box.top) / box.height;
    const previous = lastPointer;
    lastPointer = { x, y };
    if (!previous) return;
    const dx = x - previous.x, dy = y - previous.y;
    if (Math.abs(dx) + Math.abs(dy) < .0015) return;
    scene.stir(x, y, dx, dy);
    wake();
  }

  /** The agent answers a press: a ring from the dot and mint ink streaming toward `target`. */
  function pulseToward(target: Element) {
    if (!scene || reduced || struggling || !scene.ready()) return;
    const box = options.canvas.value?.getBoundingClientRect();
    if (!box?.width) return;
    const rect = target.getBoundingClientRect();
    stopLive();
    scene.pulse((rect.left + rect.width / 2 - box.left) / box.width, 1 - (rect.top - box.top) / box.height);
    wake();
  }

  onMounted(start);
  onUnmounted(() => {
    clearTimeout(rebuildTimer);
    cancelAnimationFrame(frame);
    cancelAnimationFrame(waitFrame);
    stopLive();
    observer?.disconnect();
    // Leaving: give the WebGL context back now instead of at garbage collection.
    scene?.dispose(true);
    scene = null;
  });

  return { fallback, veiled, skipped, reduced, skip, setMode, stir, pulseToward };
}
