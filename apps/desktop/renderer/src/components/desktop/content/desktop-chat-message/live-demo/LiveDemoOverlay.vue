<template>
  <div
    ref="root"
    class="live-demo-overlay"
    :class="{ 'is-drawing': drawing }"
    :style="{ width: `${width}px`, height: `${height}px` }"
  >
    <canvas ref="marksCanvas" class="live-demo-canvas" aria-hidden="true" />
    <canvas ref="inkCanvas" class="live-demo-canvas" aria-hidden="true" />
    <div class="live-demo-cursors" aria-hidden="true">
      <div
        v-for="cursor in shownCursors"
        :key="cursor.cid"
        :ref="cursorRef(cursor.cid)"
        class="live-demo-cursor"
        :style="{ '--live-color': cursor.color, '--live-ink': cursor.ink }"
      >
        <svg class="live-demo-cursor-arrow" width="16" height="22" viewBox="0 0 16 22">
          <path d="M1.5 1.5v16.2l4.3-4 3.3 7 2.9-1.4-3.3-6.9h6.1L1.5 1.5z" />
        </svg>
        <span class="live-demo-cursor-tag">{{ cursor.name }}</span>
      </div>
    </div>
    <div
      v-if="drawing"
      ref="surface"
      class="live-demo-surface"
      :class="`is-${tool}`"
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
        :class="{ 'is-flipped': pin.flipped, 'is-above': pin.above, 'is-highlighted': pin.id === highlightMarkId }"
        :style="{ left: `${pin.left}px`, top: `${pin.top}px`, '--live-color': pin.color, '--live-ink': pin.ink }"
      >
        <button
          class="live-demo-pin-dot"
          type="button"
          :aria-label="`Pin ${pin.number} by ${pin.author}: ${pin.text}`"
        >{{ pin.number }}</button>
        <div class="live-demo-pin-card">
          <strong>{{ pin.author }}</strong>
          <p>{{ pin.text }}</p>
          <button v-if="pin.own" class="live-demo-pin-delete" type="button" @click="removePin(pin.id)">Delete</button>
        </div>
      </div>
      <span
        v-if="pinDraft"
        class="live-demo-pin-draft"
        :style="{ left: `${pinDraft.left}px`, top: `${pinDraft.top}px`, '--live-color': session.viewerColor.value }"
      />
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
        :disabled="pinDraft.saving"
      >
      <p v-if="pinDraft.error" class="live-demo-pin-error" role="alert">{{ pinDraft.error }}</p>
      <div class="live-demo-pin-actions">
        <button type="button" :disabled="pinDraft.saving" @click="closePinEditor">Cancel</button>
        <button type="submit" class="is-primary" :disabled="pinDraft.saving || !pinDraft.text.trim()">
          {{ pinDraft.saving ? "Saving…" : "Add pin" }}
        </button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { drawStroke, INK_WIDTH_HIGHLIGHT } from "./canvas-draw";
import { createLatestThrottle, createInkBatcher, CURSOR_INTERVAL_MS, type InkBatcher } from "./throttle";
import { canvasBacking, demoToFrame, frameToDemo } from "./geometry";
import { readableTextColor } from "./people";
import { LIVE_DEMO, type DemoMark, type LiveDemoPoint } from "./protocol";
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
  tool: "pen" | "pin";
  highlightMarkId: string | null;
}>();

const emit = defineEmits<{
  /** Escape in draw mode. */
  exit: [];
  /** Something the person should read (a mark that was not saved). */
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
const EDITOR_WIDTH = 236;
const EDITOR_HEIGHT = 112;

type PinMark = Extract<DemoMark, { kind: "pin" }>;

interface PinDraft {
  at: LiveDemoPoint;
  left: number;
  top: number;
  editorLeft: number;
  editorTop: number;
  text: string;
  saving: boolean;
  error: string;
}

interface ActiveStroke {
  pointerId: number;
  points: LiveDemoPoint[];
  batcher: InkBatcher;
}

const root = ref<HTMLElement | null>(null);
const marksCanvas = ref<HTMLCanvasElement | null>(null);
const inkCanvas = ref<HTMLCanvasElement | null>(null);
const surface = ref<HTMLElement | null>(null);
const pinInput = ref<HTMLInputElement | null>(null);
const pinDraft = ref<PinDraft | null>(null);

const peopleByCid = computed(() => new Map(props.session.people.value.map((person) => [person.cid, person])));

const shownCursors = computed(() => {
  // Raised when a cursor appears or goes; the cursors themselves move outside Vue.
  void props.session.cursorVersion.value;
  return props.session.cursors.cids().flatMap((cid) => {
    const person = peopleByCid.value.get(cid);
    return person ? [{ cid, name: person.name, color: person.color, ink: readableTextColor(person.color) }] : [];
  });
});

const pins = computed(() => {
  const list = props.session.marks.value.filter((mark): mark is PinMark => mark.kind === "pin");
  return list.map((mark, index) => {
    const [left, top] = demoToFrame(mark.at, props.scale);
    return {
      id: mark.id,
      number: index + 1,
      left,
      top,
      text: mark.text,
      author: mark.author.name,
      color: mark.author.color,
      ink: readableTextColor(mark.author.color),
      own: props.session.isOwnMark(mark),
      flipped: left > props.width - 250,
      above: top > props.height - 140,
    };
  });
});

// Cursors move in a frame loop: a network frame only adds a sample (see cursor-interpolation.ts).
const cursorElements = new Map<string, HTMLElement>();
const cursorBinders = new Map<string, (element: unknown) => void>();
/** Where each cursor is drawn now ("hidden" before its first sample), to skip a write that changes nothing. */
const cursorPlaced = new Map<string, string>();

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
        cursorBinders.delete(cid);
      }
    };
    cursorBinders.set(cid, bind);
  }
  return bind;
}

let frameHandle = 0;
let inkDirty = true;
let inkSignature = "";
let backingRatio = 1;
let activeStroke: ActiveStroke | null = null;
let pendingSeq = 0;
const pendingStrokes = new Map<number, LiveDemoPoint[]>();
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
    if (placed === key) continue;
    element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    if (placed === undefined || placed === "hidden") element.style.opacity = "1";
    // The name tag stays inside the frame: it turns to the left and above near the right and bottom edges.
    element.classList.toggle("is-left", x > props.width - CURSOR_TAG_ROOM_X);
    element.classList.toggle("is-above", y > props.height - CURSOR_TAG_ROOM_Y);
    cursorPlaced.set(cid, key);
  }
  if (ink.prune(now)) inkDirty = true;
  const strokes = ink.strokes();
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
  if (cursors.animating(now) || strokes.length > 0) frameHandle = requestAnimationFrame(frame);
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
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
}

function personColor(cid: string): string {
  return peopleByCid.value.get(cid)?.color ?? "#71717a";
}

function redrawMarks(): void {
  const ctx = context(marksCanvas.value);
  if (!ctx) return;
  ctx.clearRect(0, 0, props.width, props.height);
  for (const mark of props.session.marks.value) {
    if (mark.kind !== "stroke") continue;
    drawStroke(ctx, mark.points, props.scale, mark.author.color, mark.id === props.highlightMarkId ? INK_WIDTH_HIGHLIGHT : undefined);
  }
}

function redrawInk(): void {
  const ctx = context(inkCanvas.value);
  if (!ctx) return;
  ctx.clearRect(0, 0, props.width, props.height);
  for (const stroke of props.session.ink.strokes()) drawStroke(ctx, stroke.points, props.scale, personColor(stroke.cid));
  const mine = props.session.viewerColor.value;
  for (const points of pendingStrokes.values()) drawStroke(ctx, points, props.scale, mine);
  if (activeStroke) drawStroke(ctx, activeStroke.points, props.scale, mine);
}

function markInkDirty(): void {
  inkDirty = true;
  wake();
}

function pointFor(event: { clientX: number; clientY: number }, rect: DOMRect): LiveDemoPoint {
  return frameToDemo(event.clientX - rect.left, event.clientY - rect.top, props.scale);
}

function onPointerDown(event: PointerEvent): void {
  const element = surface.value;
  if (!element || event.button !== 0 || !event.isPrimary) return;
  const point = pointFor(event, element.getBoundingClientRect());
  if (props.tool === "pin") {
    openPinEditor(point);
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
  if (activeStroke && event.pointerId === activeStroke.pointerId) void finishStroke(true);
}

function onPointerCancel(event: PointerEvent): void {
  // Losing the pointer mid-stroke ends it where it was; nothing is lost.
  if (activeStroke && event.pointerId === activeStroke.pointerId) void finishStroke(true);
}

function onPointerLeave(): void {
  if (activeStroke) return;
  cursorThrottle.cancel();
  props.session.sendCursor(null);
}

async function finishStroke(save: boolean): Promise<void> {
  const stroke = activeStroke;
  activeStroke = null;
  if (!stroke) return;
  stroke.batcher.end();
  const points = save ? simplifyStroke(stroke.points) : [];
  if (points.length < 2) {
    markInkDirty();
    return;
  }
  const key = ++pendingSeq;
  // The stroke stays on screen while it saves; the saved mark replaces it.
  pendingStrokes.set(key, points);
  markInkDirty();
  try {
    await props.session.addStroke(points);
  } catch {
    emit("notice", "Could not save the drawing. Try again.");
  } finally {
    pendingStrokes.delete(key);
    markInkDirty();
  }
}

function openPinEditor(at: LiveDemoPoint): void {
  const [left, top] = demoToFrame(at, props.scale);
  const editorLeft = Math.max(4, Math.min(left - 10, props.width - EDITOR_WIDTH - 4));
  const below = top + 16;
  const editorTop = below + EDITOR_HEIGHT > props.height ? Math.max(4, top - EDITOR_HEIGHT - 8) : below;
  pinDraft.value = { at, left, top, editorLeft, editorTop, text: "", saving: false, error: "" };
  void nextTick(() => pinInput.value?.focus({ preventScroll: true }));
}

function closePinEditor(): void {
  pinDraft.value = null;
  void nextTick(() => surface.value?.focus({ preventScroll: true }));
}

async function savePin(): Promise<void> {
  const draft = pinDraft.value;
  const text = draft?.text.trim() ?? "";
  if (!draft || draft.saving || !text) return;
  draft.saving = true;
  draft.error = "";
  try {
    await props.session.addPin(draft.at, text);
    if (pinDraft.value === draft) closePinEditor();
  } catch {
    draft.saving = false;
    draft.error = "Could not save the pin. Try again.";
  }
}

async function removePin(id: string): Promise<void> {
  try {
    await props.session.deleteMark(id);
  } catch {
    emit("notice", "Could not delete the pin. Try again.");
  }
}

/** Escape closes the pin note first and then leaves draw mode, unless the person is typing elsewhere. */
function onEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape" || !props.drawing) return;
  const target = event.target;
  if (target instanceof HTMLElement && !root.value?.contains(target) && target.closest("input, textarea, select, [contenteditable]")) return;
  event.preventDefault();
  event.stopPropagation();
  if (pinDraft.value) closePinEditor();
  else emit("exit");
}

function onWindowResize(): void {
  const { ratio } = canvasBacking(props.width, props.height, window.devicePixelRatio || 1);
  if (ratio === backingRatio) return;
  sizeCanvases();
  redrawMarks();
  markInkDirty();
}

function stopDrawing(): void {
  window.removeEventListener("keydown", onEscape, true);
  void finishStroke(true);
  pinDraft.value = null;
  cursorThrottle.cancel();
  props.session.sendCursor(null);
}

watch(
  () => props.drawing,
  (drawing) => {
    if (drawing) {
      window.addEventListener("keydown", onEscape, true);
      void nextTick(() => surface.value?.focus({ preventScroll: true }));
    } else {
      stopDrawing();
    }
  },
);

watch(() => props.tool, () => { pinDraft.value = null; });

watch(
  [() => props.session.marks.value, () => props.scale, () => props.highlightMarkId],
  () => redrawMarks(),
  { flush: "post" },
);

watch(
  [() => props.width, () => props.height],
  () => {
    sizeCanvases();
    redrawMarks();
    markInkDirty();
  },
  { flush: "post" },
);

watch(
  () => props.scale,
  () => {
    cursorPlaced.clear();
    markInkDirty();
  },
);

// A cursor that has just mounted needs its first position.
watch(shownCursors, () => wake(), { flush: "post" });
watch(() => props.session.people.value, () => markInkDirty());

onMounted(() => {
  sizeCanvases();
  redrawMarks();
  stopWake = props.session.onWake(wake);
  window.addEventListener("resize", onWindowResize);
  if (props.drawing) window.addEventListener("keydown", onEscape, true);
  wake();
});

onBeforeUnmount(() => {
  stopWake?.();
  window.removeEventListener("resize", onWindowResize);
  window.removeEventListener("keydown", onEscape, true);
  if (frameHandle) cancelAnimationFrame(frameHandle);
  frameHandle = 0;
  cursorThrottle.cancel();
  if (activeStroke) {
    activeStroke.batcher.end();
    activeStroke = null;
  }
  if (props.drawing) props.session.sendCursor(null);
});
</script>
