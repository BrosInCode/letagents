<template>
  <div
    ref="root"
    class="live-demo-overlay"
    :class="{
      'is-drawing': drawing,
      'is-pinning': pinning,
      'is-capturing': capturing,
      'has-highlight': Boolean(highlightMarkId),
    }"
    :style="{ width: `${width}px`, height: `${height}px`, '--live-self': session.viewerColor.value }"
  >
    <canvas ref="marksCanvas" class="live-demo-canvas is-saved" aria-hidden="true" />
    <canvas ref="inkCanvas" class="live-demo-canvas" aria-hidden="true" />
    <div class="live-demo-cursors" aria-hidden="true">
      <div
        v-for="cursor in shownCursors"
        :key="cursor.cid"
        :ref="cursorRef(cursor.cid)"
        class="live-demo-cursor"
        :style="{ '--live-color': cursor.color, '--live-ink': cursor.ink }"
      >
        <span class="live-demo-cursor-ring"></span>
        <svg class="live-demo-cursor-arrow" width="16" height="22" viewBox="0 0 16 22">
          <path d="M1.5 1.5v16.2l4.3-4 3.3 7 2.9-1.4-3.3-6.9h6.1L1.5 1.5z" />
        </svg>
        <span class="live-demo-cursor-tag"><PenLine class="live-demo-cursor-pen" :size="10" aria-hidden="true" />{{ cursor.name }}</span>
      </div>
    </div>
    <div
      v-if="drawing || pinning"
      ref="surface"
      class="live-demo-surface"
      tabindex="-1"
      @mousedown.prevent
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @lostpointercapture="onPointerCancel"
      @pointerleave="onPointerLeave"
    />
    <div class="live-demo-pins">
      <div
        v-for="pin in pins"
        :key="pin.id"
        class="live-demo-pin"
        :class="{
          'is-flipped': pin.flipped,
          'is-above': pin.above,
          'is-highlighted': pin.id === highlightMarkId,
          'is-pending': pin.waiting,
        }"
        :style="{ left: `${pin.left}px`, top: `${pin.top}px`, '--live-color': pin.color, '--live-ink': pin.ink }"
      >
        <button
          class="live-demo-pin-dot"
          type="button"
          :aria-label="`Pin ${pin.number} by ${pin.author}: ${pin.text}`"
        >{{ pin.number }}</button>
        <div class="live-demo-pin-card">
          <strong>{{ pin.author }} · pin {{ pin.number }}</strong>
          <p>{{ pin.text }}</p>
          <p v-if="pin.waiting" class="live-demo-pin-state">Not saved yet. It is saved when the link is back.</p>
          <button v-if="pin.own" class="live-demo-pin-delete" type="button" @click="removePin(pin)">Delete</button>
        </div>
      </div>
      <div
        v-if="pinDraft"
        class="live-demo-pin is-draft"
        :style="{ left: `${pinDraft.left}px`, top: `${pinDraft.top}px`, '--live-color': session.viewerColor.value, '--live-ink': selfInk }"
      >
        <span class="live-demo-pin-dot">{{ nextPinNumber }}</span>
      </div>
    </div>
    <div
      ref="ghost"
      class="live-demo-pin live-demo-pin-ghost"
      :style="{ '--live-color': session.viewerColor.value, '--live-ink': selfInk }"
      aria-hidden="true"
    >
      <span class="live-demo-pin-dot">{{ nextPinNumber }}</span>
    </div>
    <form
      v-if="pinDraft"
      class="live-demo-pin-editor"
      :style="{ left: `${pinDraft.editorLeft}px`, top: `${pinDraft.editorTop}px` }"
      @submit.prevent="savePin"
    >
      <input
        ref="pinInput"
        v-model="pinDraft.text"
        type="text"
        :maxlength="PIN_TEXT_MAX"
        placeholder="Add a note"
        aria-label="Note for this pin"
      >
      <p class="live-demo-pin-hint"><kbd>Enter</kbd> to pin · <kbd>Esc</kbd> to cancel</p>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { PenLine } from "@lucide/vue";
import { drawStroke, INK_WIDTH_HIGHLIGHT } from "./canvas-draw";
import { planMarkPaint } from "./marks";
import { createLatestThrottle, createInkBatcher, CURSOR_INTERVAL_MS, type InkBatcher } from "./throttle";
import { canvasBacking, demoToFrame, frameToDemo } from "./geometry";
import { readableTextColor } from "./people";
import { LIVE_DEMO, type DemoMark, type LiveDemoAnchor, type LiveDemoPoint } from "./protocol";
import type { LiveDemoSession } from "./session";
import { simplifyStroke } from "./stroke-simplify";
import { newStrokeId } from "./stroke-id";

const props = defineProps<{
  session: LiveDemoSession;
  /** The frame, in CSS px. */
  width: number;
  height: number;
  /** How much demo space is scaled to fit the frame. */
  scale: number;
  drawing: boolean;
  /** The next click on the demo places a pin. */
  pinning: boolean;
  /** A picture of the card is being taken: other people's pointers stay out of it. */
  capturing: boolean;
  highlightMarkId: string | null;
  /** The part of the frame the card shows (a tall demo is clipped), so notes open where they can be seen. */
  visibleHeight: number;
  /** Names the element under a point of the demo, saved with a pin so an agent knows what it is about. */
  anchorAt?: (at: LiveDemoPoint) => Promise<LiveDemoAnchor | null>;
}>();

const emit = defineEmits<{
  /** Escape in draw mode. */
  exit: [];
  /** Escape in pin mode. */
  "cancel-pin": [];
  /** The pin is placed (it saves on its own). */
  pinned: [];
  /** Delete one of your saved marks, or take back one that is not saved yet. */
  delete: [id: string];
  "cancel-pending": [key: number];
  /** Something the person should read. */
  notice: [text: string];
}>();

const PIN_TEXT_MAX = LIVE_DEMO.pinText;
// A new point closer than this to the last one (demo px) adds nothing.
const MIN_POINT_STEP = 1;
// A stroke keeps at most this many raw points; the saved one is simplified anyway.
const MAX_RAW_POINTS = 20_000;
// Room a cursor's name tag needs to its right and below it (CSS px).
const CURSOR_TAG_ROOM_X = 150;
const CURSOR_TAG_ROOM_Y = 34;
// A name tag fades after this long without a move, and comes back with the next one.
const CURSOR_IDLE_MS = 2_500;
const EDITOR_WIDTH = 248;
const EDITOR_HEIGHT = 80;

type PinMark = Extract<DemoMark, { kind: "pin" }>;

interface PinDraft {
  at: LiveDemoPoint;
  /** The element under the pin, once the demo has named it. */
  anchor: LiveDemoAnchor | null;
  left: number;
  top: number;
  editorLeft: number;
  editorTop: number;
  text: string;
}

interface ActiveStroke {
  pointerId: number;
  points: LiveDemoPoint[];
  batcher: InkBatcher;
}

interface PinView {
  id: string;
  pendingKey: number | null;
  number: number;
  left: number;
  top: number;
  text: string;
  author: string;
  color: string;
  ink: string;
  own: boolean;
  waiting: boolean;
  flipped: boolean;
  above: boolean;
}

const root = ref<HTMLElement | null>(null);
const marksCanvas = ref<HTMLCanvasElement | null>(null);
const inkCanvas = ref<HTMLCanvasElement | null>(null);
const surface = ref<HTMLElement | null>(null);
const ghost = ref<HTMLElement | null>(null);
const pinInput = ref<HTMLInputElement | null>(null);
const pinDraft = ref<PinDraft | null>(null);

const peopleByCid = computed(() => new Map(props.session.people.value.map((person) => [person.cid, person])));
const selfInk = computed(() => readableTextColor(props.session.viewerColor.value));

const shownCursors = computed(() => {
  // Raised when a cursor appears or goes; the cursors themselves move outside Vue.
  void props.session.cursorVersion.value;
  return props.session.cursors.cids().flatMap((cid) => {
    const person = peopleByCid.value.get(cid);
    return person ? [{ cid, name: person.name, color: person.color, ink: readableTextColor(person.color) }] : [];
  });
});

// Saved pins first, oldest first, then yours that are not saved yet: the numbers match the Marks list and the sent text.
const pins = computed<PinView[]>(() => {
  const view = (pin: Omit<PinView, "left" | "top" | "flipped" | "above" | "ink"> & { at: LiveDemoPoint }): PinView => {
    const [left, top] = demoToFrame(pin.at, props.scale);
    return {
      id: pin.id, pendingKey: pin.pendingKey, number: pin.number, text: pin.text, author: pin.author,
      color: pin.color, own: pin.own, waiting: pin.waiting, left, top, ink: readableTextColor(pin.color),
      flipped: left > props.width - 250,
      above: top > Math.min(props.height, props.visibleHeight) - 140,
    };
  };
  let number = 0;
  const list: PinView[] = [];
  for (const mark of props.session.marks.value) {
    if (mark.kind !== "pin") continue;
    const pin = mark as PinMark;
    list.push(view({
      id: pin.id, pendingKey: null, number: ++number, at: pin.at, text: pin.text, author: pin.author.name,
      color: pin.author.color, own: props.session.isOwnMark(pin), waiting: false,
    }));
  }
  for (const entry of props.session.pending.value) {
    if (entry.body.kind !== "pin") continue;
    list.push(view({
      id: `pending-${entry.key}`, pendingKey: entry.key, number: ++number, at: entry.body.at, text: entry.body.text,
      author: "You", color: props.session.viewerColor.value, own: true, waiting: entry.waiting,
    }));
  }
  return list;
});

const nextPinNumber = computed(() => pins.value.length + 1);

// Cursors move in a frame loop: a network frame only adds a sample (see cursor-interpolation.ts).
const cursorElements = new Map<string, HTMLElement>();
const cursorBinders = new Map<string, (element: unknown) => void>();
/** Where each cursor is drawn now ("hidden" before its first sample), to skip a write that changes nothing. */
const cursorPlaced = new Map<string, string>();
/** When each cursor last moved, so its name tag can fade while it rests. */
const cursorMovedAt = new Map<string, number>();

/** A stable function ref per person, so Vue calls it when the element mounts or unmounts, not on every render. */
function cursorRef(cid: string): (element: unknown) => void {
  let bind = cursorBinders.get(cid);
  if (!bind) {
    bind = (element) => {
      if (element instanceof HTMLElement) {
        cursorElements.set(cid, element);
      } else {
        cursorElements.delete(cid);
        cursorPlaced.delete(cid);
        cursorMovedAt.delete(cid);
        cursorBinders.delete(cid);
      }
    };
    cursorBinders.set(cid, bind);
  }
  return bind;
}

let frameHandle = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let inkDirty = true;
let inkSignature = "";
// The saved strokes are painted on their own canvas, and a new one is added on top
// of those there; the whole layer is painted again only when it was cleared or a
// stroke went away.
let marksDirty = true;
let marksCleared = true;
let marksDrawn: ReadonlySet<string> = new Set();
let backingRatio = 1;
let activeStroke: ActiveStroke | null = null;
const cursorThrottle = createLatestThrottle<LiveDemoPoint>(CURSOR_INTERVAL_MS, (point) => props.session.sendCursor(point));
let stopWake: (() => void) | null = null;

function wake(): void {
  if (!frameHandle) frameHandle = requestAnimationFrame(frame);
}

function frame(): void {
  frameHandle = 0;
  const now = performance.now();
  const { cursors, ink } = props.session;
  cursors.prune(now);
  if (ink.prune(now)) inkDirty = true;
  const strokes = ink.strokes();
  const drawingCids = new Set(strokes.filter((stroke) => !stroke.ended).map((stroke) => stroke.cid));
  let nextIdleAt = Number.POSITIVE_INFINITY;
  for (const [cid, element] of cursorElements) {
    const at = cursors.positionOf(cid, now);
    const placed = cursorPlaced.get(cid);
    if (!at) {
      if (placed !== undefined && placed !== "hidden") {
        element.style.opacity = "0";
        cursorPlaced.set(cid, "hidden");
      }
      continue;
    }
    const x = at.x * props.scale;
    const y = at.y * props.scale;
    const key = `${x.toFixed(1)},${y.toFixed(1)}`;
    if (placed !== key) {
      element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      if (placed === undefined || placed === "hidden") element.style.opacity = "1";
      // The name tag stays inside the frame: it turns to the left and above near the right and bottom edges.
      element.classList.toggle("is-left", x > props.width - CURSOR_TAG_ROOM_X);
      element.classList.toggle("is-above", y > props.height - CURSOR_TAG_ROOM_Y);
      cursorPlaced.set(cid, key);
      cursorMovedAt.set(cid, now);
    }
    const movedAt = cursorMovedAt.get(cid) ?? now;
    const drawingNow = drawingCids.has(cid);
    // Someone drawing keeps their name on show.
    const idle = !drawingNow && now - movedAt >= CURSOR_IDLE_MS;
    element.classList.toggle("is-idle", idle);
    element.classList.toggle("is-drawing", drawingNow);
    if (!idle) nextIdleAt = Math.min(nextIdleAt, movedAt + CURSOR_IDLE_MS);
  }
  if (marksDirty) paintMarks();
  let signature = String(strokes.length);
  for (const stroke of strokes) signature += `:${stroke.points.length}${stroke.ended ? "e" : ""}`;
  if (signature !== inkSignature) {
    inkSignature = signature;
    inkDirty = true;
  }
  if (inkDirty) {
    inkDirty = false;
    redrawInk();
  }
  // Strokes of others still need frames: an ended one must be dropped on time.
  if (cursors.animating(now) || strokes.length > 0) {
    frameHandle = requestAnimationFrame(frame);
  } else if (Number.isFinite(nextIdleAt)) {
    // A resting cursor needs one more frame, when its tag should fade.
    clearTimeout(idleTimer);
    idleTimer = setTimeout(wake, Math.max(16, nextIdleAt - now + 16));
  }
}

function context(canvas: HTMLCanvasElement | null): CanvasRenderingContext2D | null {
  const ctx = canvas?.getContext("2d") ?? null;
  ctx?.setTransform(backingRatio, 0, 0, backingRatio, 0, 0);
  return ctx;
}

function sizeCanvases(): void {
  const { pixelWidth, pixelHeight, ratio } = canvasBacking(props.width, props.height, window.devicePixelRatio || 1);
  backingRatio = ratio;
  for (const canvas of [marksCanvas.value, inkCanvas.value]) {
    if (!canvas) continue;
    // A new size empties the canvas.
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  invalidateMarks(true);
}

/** Paints the saved strokes at the next frame; `cleared` when the canvas is empty or its scale changed. */
function invalidateMarks(cleared: boolean): void {
  marksDirty = true;
  if (cleared) marksCleared = true;
  wake();
}

function personColor(cid: string): string {
  return peopleByCid.value.get(cid)?.color ?? "#71717a";
}

function paintMarks(): void {
  const ctx = context(marksCanvas.value);
  if (!ctx) return;
  marksDirty = false;
  const plan = planMarkPaint(marksDrawn, props.session.marks.value, marksCleared);
  if (plan.full) ctx.clearRect(0, 0, props.width, props.height);
  for (const mark of plan.paint) drawStroke(ctx, mark.points, props.scale, mark.author.color);
  marksDrawn = plan.ids;
  marksCleared = false;
}

function redrawInk(): void {
  const ctx = context(inkCanvas.value);
  if (!ctx) return;
  ctx.clearRect(0, 0, props.width, props.height);
  for (const stroke of props.session.ink.strokes()) drawStroke(ctx, stroke.points, props.scale, personColor(stroke.cid));
  // The stroke a list row points at is drawn thick over the saved one, so hovering never repaints the saved layer.
  const highlighted = props.highlightMarkId
    ? props.session.marks.value.find((mark) => mark.id === props.highlightMarkId)
    : undefined;
  if (highlighted?.kind === "stroke") drawStroke(ctx, highlighted.points, props.scale, highlighted.author.color, INK_WIDTH_HIGHLIGHT);
  const mine = props.session.viewerColor.value;
  // Yours that the server does not have yet: solid while the save is on its way, dashed once it had to wait.
  for (const entry of props.session.pending.value) {
    if (entry.body.kind !== "stroke") continue;
    if (!entry.waiting) {
      drawStroke(ctx, entry.body.points, props.scale, mine);
      continue;
    }
    ctx.save();
    ctx.setLineDash([7, 6]);
    ctx.globalAlpha = 0.6;
    drawStroke(ctx, entry.body.points, props.scale, mine);
    ctx.restore();
  }
  if (activeStroke) drawStroke(ctx, activeStroke.points, props.scale, mine);
}

function markInkDirty(): void {
  inkDirty = true;
  wake();
}

function pointFor(event: { clientX: number; clientY: number }, rect: DOMRect): LiveDemoPoint {
  return frameToDemo(event.clientX - rect.left, event.clientY - rect.top, props.scale);
}

function showGhost(event: PointerEvent | null, rect?: DOMRect): void {
  const element = ghost.value;
  if (!element) return;
  if (!event || !rect || !props.pinning || pinDraft.value) {
    element.classList.remove("is-on");
    return;
  }
  element.style.transform = `translate3d(${event.clientX - rect.left}px, ${event.clientY - rect.top}px, 0)`;
  element.classList.add("is-on");
}

function onPointerDown(event: PointerEvent): void {
  const element = surface.value;
  if (!element || event.button !== 0 || !event.isPrimary) return;
  const point = pointFor(event, element.getBoundingClientRect());
  if (props.pinning) {
    openPinEditor(point);
    showGhost(null);
    return;
  }
  if (activeStroke) return;
  element.setPointerCapture(event.pointerId);
  const id = newStrokeId();
  const batcher = createInkBatcher((points, end) => props.session.sendInk(id, points, end));
  activeStroke = { pointerId: event.pointerId, points: [point], batcher };
  batcher.add(point);
  markInkDirty();
}

function onPointerMove(event: PointerEvent): void {
  const element = surface.value;
  if (!element) return;
  const rect = element.getBoundingClientRect();
  cursorThrottle.push(pointFor(event, rect));
  showGhost(event, rect);
  const stroke = activeStroke;
  if (!stroke || event.pointerId !== stroke.pointerId) return;
  // A fast pointer reports several positions per event.
  const samples = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
  for (const sample of samples.length > 0 ? samples : [event]) {
    const point = pointFor(sample, rect);
    const last = stroke.points[stroke.points.length - 1];
    if (Math.hypot(point[0] - last[0], point[1] - last[1]) < MIN_POINT_STEP || stroke.points.length >= MAX_RAW_POINTS) continue;
    stroke.points.push(point);
    stroke.batcher.add(point);
  }
  markInkDirty();
}

function onPointerUp(event: PointerEvent): void {
  if (activeStroke && event.pointerId === activeStroke.pointerId) finishStroke(true);
}

function onPointerCancel(event: PointerEvent): void {
  // Losing the pointer mid-stroke ends it where it was; nothing is lost.
  if (activeStroke && event.pointerId === activeStroke.pointerId) finishStroke(true);
}

function onPointerLeave(): void {
  showGhost(null);
  if (activeStroke) return;
  cursorThrottle.cancel();
  props.session.sendCursor(null);
}

function finishStroke(save: boolean): void {
  const stroke = activeStroke;
  activeStroke = null;
  if (!stroke) return;
  stroke.batcher.end();
  const points = save ? simplifyStroke(stroke.points) : [];
  // It stays on screen from here: as a mark of yours that is saving, then as the saved mark.
  if (points.length >= 2) props.session.queueMark({ kind: "stroke", points });
  markInkDirty();
}

function openPinEditor(at: LiveDemoPoint): void {
  const [left, top] = demoToFrame(at, props.scale);
  const editorLeft = Math.max(4, Math.min(left + 14, props.width - EDITOR_WIDTH - 4));
  const below = top + 14;
  const bottom = Math.min(props.height, props.visibleHeight);
  const editorTop = below + EDITOR_HEIGHT > bottom ? Math.max(4, top - EDITOR_HEIGHT - 14) : below;
  // A second click moves the pin; what was typed stays.
  pinDraft.value = { at, anchor: null, left, top, editorLeft, editorTop, text: pinDraft.value?.text ?? "" };
  // The demo names the element while the note is typed; a pin saved before it answers goes without.
  // (The draft is reactive, so its point is a copy: compare the numbers. A pin moved since asks again.)
  void props.anchorAt?.(at).then((anchor) => {
    const draft = pinDraft.value;
    if (draft && draft.at[0] === at[0] && draft.at[1] === at[1]) draft.anchor = anchor;
  }, () => undefined);
  void nextTick(() => pinInput.value?.focus({ preventScroll: true }));
}

function savePin(): void {
  const draft = pinDraft.value;
  const text = draft?.text.trim() ?? "";
  if (!draft || !text) return;
  props.session.queueMark({ kind: "pin", at: draft.at, text, anchor: draft.anchor });
  pinDraft.value = null;
  emit("pinned");
}

function removePin(pin: PinView): void {
  if (pin.pendingKey !== null) emit("cancel-pending", pin.pendingKey);
  else emit("delete", pin.id);
}

/** Escape cancels the pin, or leaves draw mode, unless the person is typing somewhere else. */
function onEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape" || !(props.drawing || props.pinning)) return;
  const target = event.target;
  // Escape that belongs to something else (a dialog, a menu, another card) is left to it.
  const card = root.value?.closest(".room-inline-demo");
  const fromPage = target === document.body || target === document.documentElement || target === null;
  if (!fromPage && target instanceof Node && !card?.contains(target)) return;
  // An open panel (Marks, say) closes first; its own Escape handles that.
  if (target instanceof HTMLElement && target.closest(".live-demo-pop")) return;
  event.preventDefault();
  event.stopPropagation();
  if (props.pinning) emit("cancel-pin");
  else emit("exit");
}

/** Where a person's pointer is drawn now (frame px), or null when it is not on the demo. */
function cursorAt(cid: string): { x: number; y: number } | null {
  const at = props.session.cursors.positionOf(cid, performance.now());
  return cursorElements.has(cid) && at ? { x: at.x * props.scale, y: at.y * props.scale } : null;
}

/**
 * Rings a person's pointer twice and shows their name. False when their pointer
 * is not on the demo, so the card can say so.
 */
function ping(cid: string): boolean {
  const element = cursorElements.get(cid);
  const placed = cursorPlaced.get(cid);
  if (!element || placed === undefined || placed === "hidden") return false;
  cursorMovedAt.set(cid, performance.now());
  element.classList.remove("is-idle", "is-pinged");
  // Restarts the ring if it is still running.
  void element.offsetWidth;
  element.classList.add("is-pinged");
  setTimeout(() => element.classList.remove("is-pinged"), 2_000);
  wake();
  return true;
}

defineExpose({ ping, cursorAt });

function onWindowResize(): void {
  const { ratio } = canvasBacking(props.width, props.height, window.devicePixelRatio || 1);
  if (ratio === backingRatio) return;
  sizeCanvases();
  markInkDirty();
}

function listenForEscape(on: boolean): void {
  if (on) window.addEventListener("keydown", onEscape, true);
  else window.removeEventListener("keydown", onEscape, true);
}

watch(
  () => props.drawing || props.pinning,
  (active, before) => {
    listenForEscape(active);
    if (active && !before) {
      void nextTick(() => surface.value?.focus({ preventScroll: true }));
    } else if (!active) {
      finishStroke(true);
      pinDraft.value = null;
      showGhost(null);
      cursorThrottle.cancel();
      props.session.sendCursor(null);
    }
  },
);

watch(
  () => props.pinning,
  (pinning) => {
    if (pinning) return;
    pinDraft.value = null;
    showGhost(null);
    // Back to drawing after a pin: the keyboard goes back to the surface.
    if (props.drawing) void nextTick(() => surface.value?.focus({ preventScroll: true }));
  },
);

// A new mark only adds a stroke; a removed one makes `paintMarks` start over.
watch(() => props.session.marks.value, () => invalidateMarks(false));
watch(() => props.session.pending.value, () => markInkDirty());
watch(() => props.highlightMarkId, () => markInkDirty());

watch(
  [() => props.width, () => props.height],
  () => {
    sizeCanvases();
    markInkDirty();
  },
  { flush: "post" },
);

watch(
  () => props.scale,
  () => {
    cursorPlaced.clear();
    invalidateMarks(true);
    markInkDirty();
  },
);

// A cursor that has just mounted needs its first position.
watch(shownCursors, () => wake(), { flush: "post" });
watch(() => props.session.people.value, () => markInkDirty());

onMounted(() => {
  sizeCanvases();
  stopWake = props.session.onWake(wake);
  window.addEventListener("resize", onWindowResize);
  if (props.drawing || props.pinning) listenForEscape(true);
  wake();
});

onBeforeUnmount(() => {
  stopWake?.();
  window.removeEventListener("resize", onWindowResize);
  listenForEscape(false);
  if (frameHandle) cancelAnimationFrame(frameHandle);
  frameHandle = 0;
  clearTimeout(idleTimer);
  cursorThrottle.cancel();
  if (activeStroke) {
    activeStroke.batcher.end();
    activeStroke = null;
  }
  if (props.drawing || props.pinning) props.session.sendCursor(null);
});
</script>
