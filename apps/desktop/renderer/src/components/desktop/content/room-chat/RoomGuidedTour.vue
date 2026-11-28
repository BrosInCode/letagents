<template>
  <dialog ref="dialog" class="room-guide" aria-label="Quick tour" data-testid="room-guided-tour" @close="stop" @cancel.prevent="finish">
    <!-- One 2D canvas: a dim layer with an opening on the part being shown, and the strings shot to it. -->
    <canvas ref="canvas" class="room-guide-canvas" aria-hidden="true" @click="advance" />
    <section ref="card" class="room-guide-card" :style="cardStyle" @pointerenter="holdWelcome" @focusin="onCardFocus">
      <div class="room-guide-text" aria-live="polite">
        <Transition name="guide-example" mode="out-in">
          <div v-if="welcomeShown" key="welcome" class="room-guide-example" data-testid="room-guide-welcome">
            <h2>Welcome to LetAgents{{ welcomeName ? `, ${welcomeName}` : "" }}.</h2>
            <p>A place for you and your team to work together.</p>
            <p>LetAgents helps your team manage work better.</p>
          </div>
          <div v-else :key="step.title" class="room-guide-example">
            <span class="room-guide-position">{{ index + 1 }} of {{ availableSteps.length }}</span>
            <h2>{{ step.title }}</h2>
            <p>{{ step.description }}</p>
            <span class="room-guide-example-note">{{ step.example }}</span>
          </div>
        </Transition>
      </div>
      <footer class="room-guide-actions">
        <button type="button" class="room-guide-quiet" @click="finish">{{ welcomeShown ? "Not now" : "Skip" }}</button>
        <span v-if="!welcomeShown" class="room-guide-dots" role="group" aria-label="Tour steps">
          <button
            v-for="(item, dot) in availableSteps"
            :key="dot"
            type="button"
            class="room-guide-dot"
            :data-on="dot === index"
            :aria-label="`Step ${dot + 1}: ${item.title}`"
            :aria-current="dot === index ? 'step' : undefined"
            :data-testid="`room-guide-dot-${dot}`"
            @click="goToStep(dot)"
          ><i /></button>
        </span>
        <button ref="nextButton" type="button" class="room-guide-next" data-testid="room-guide-next" @click="advance">
          {{ welcomeShown ? "Show me around" : index + 1 === availableSteps.length ? "Done" : "Next" }}
        </button>
      </footer>
    </section>
  </dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onUnmounted, ref, shallowRef, watch } from "vue";
import { hasFirstRoomTour, takeFirstRoomTour } from "../../../../domain/first-room-tour";

const props = defineProps<{ roomIdentifier?: string | null; roomLoading?: boolean; viewerName?: string | null }>();

const steps = [
  { title: "Rooms", selector: "[data-testid='sidebar-rooms-heading'], [data-testid='sidebar-section-rooms']", description: "Each room keeps its own conversations, agents, and tasks together.", example: "Switch projects from the sidebar." },
  { title: "Chat", selector: "[data-testid='desktop-room-tab-chat']", description: "Talk to your team and mention an agent when you need its help.", example: "Ask for a second look in a thread." },
  { title: "Agents", selector: "[data-testid='desktop-room-tab-activity']", description: "See who’s in the room and what the agents are working on.", example: "Open an agent to see its activity." },
  { title: "Board", selector: "[data-testid='desktop-room-tab-board']", description: "Track assignments, reviews, and blockers for this room.", example: "Open a task to see what’s left." },
  { title: "Memory", selector: "[data-testid='desktop-room-tab-memory']", description: "Keep decisions and context where teammates can find them again.", example: "Save the reason behind a decision." },
  { title: "My work", selector: "[data-testid='sidebar-my-work']", description: "See your assignments across the rooms you work in.", example: "Pick up a task without searching through chat." },
];
type Step = typeof steps[number];

const dialog = ref<HTMLDialogElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const card = ref<HTMLElement | null>(null);
const nextButton = ref<HTMLButtonElement | null>(null);
const availableSteps = shallowRef<Step[]>(steps);
const index = ref(0);
const step = computed(() => availableSteps.value[index.value] ?? steps[1]);
const welcomeShown = ref(false);
const welcomeName = ref<string | null>(null);
const cardPos = ref({ x: 0, y: 0 });
const cardStyle = computed(() => ({ transform: `translate3d(${cardPos.value.x}px, ${cardPos.value.y}px, 0)` }));

// ---- Timing. The card stays still; only the strings move.
const SHOOT_MS = 420, OPEN_MS = 260, RELEASE_MS = 420, SHOOT_DELAY_MS = 140, WELCOME_MS = 3200, POINTS = 24;
// Once the strings land they sway for SWAY_MS, then come to rest and the loop stops: a tour
// someone is reading costs nothing until the step, the window or the part changes.
const SWAY_MS = 1400, STILL_MS = 700, MAX_AWAKE_MS = 4000, MOVED_CHECK_MS = 400;
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

type Rect = { x: number; y: number; w: number; h: number };
type Strand = {
  pts: Float32Array; prev: Float32Array; offset: number; spread: number; phase: number;
  alpha: number; state: "shooting" | "held" | "released"; t0: number; seg: number;
};
let strands: Strand[] = [];
let shootAt = 0, landedAt = 0, frame = 0, lastTick = 0, welcomeTimer = 0;
let settleObserver: ResizeObserver | null = null, settleFrame = 0;
// Layout reads for one frame. simulate() and draw() ask for the part and the card many times
// a frame; reading them once keeps a busy room from paying for repeated layout queries.
let frameTarget: Rect | null | undefined, frameCard: DOMRect | null | undefined;
// How far the strings moved in the last step (px), and where the last frame put the part and the card.
let motion = 0, drawnAt = "", movedTimer = 0;
let ctx: CanvasRenderingContext2D | null = null;
let accent = "#a8dec7";

function visibleTarget(selector: string): DOMRect | undefined {
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    if (element.closest('[inert], [hidden], [aria-hidden="true"]')) continue;
    const box = element.getBoundingClientRect();
    if (box.width && box.height && box.right > 0 && box.left < innerWidth && box.bottom > 0 && box.top < innerHeight) return box;
  }
}
/** Read every frame: the part may move (sidebar, resize, late layout). Null once it is gone. */
function targetRect(): Rect | null {
  if (frameTarget !== undefined) return frameTarget;
  if (welcomeShown.value) return null;
  const box = visibleTarget(step.value.selector);
  if (!box) return null;
  const pad = 6;
  return { x: box.left - pad, y: box.top - pad, w: box.width + pad * 2, h: box.height + pad * 2 };
}

/** The card sits in the middle of the room and does not move between steps. */
function placeCard() {
  const box = card.value?.getBoundingClientRect();
  if (!box) return;
  const room = dialog.value?.closest(".desktop-room-shell")?.getBoundingClientRect();
  const cx = room ? room.left + room.width / 2 : innerWidth / 2;
  cardPos.value = {
    x: Math.round(Math.min(Math.max(16, cx - box.width / 2), innerWidth - box.width - 16)),
    y: Math.round(Math.max(16, innerHeight * .52 - box.height / 2)),
  };
}

// ---- Strings: each strand is a chain of points (a Verlet rope). Its first point is held on the card;
// while shooting, the last point flies along an arc to the part; once it lands it is pinned there and
// the 6% slack makes it sag and sway. On the next step the strands let go, recoil and fade.
function cardBox(): DOMRect | null {
  if (frameCard !== undefined) return frameCard;
  return card.value?.getBoundingClientRect() ?? null;
}
function cardEdgeToward(target: { x: number; y: number }) {
  const box = cardBox();
  if (!box) return { x: innerWidth / 2, y: innerHeight / 2 };
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
  const dx = target.x - cx, dy = target.y - cy;
  const k = 1 / Math.max(Math.abs(dx) / (box.width / 2), Math.abs(dy) / (box.height / 2), 1e-3);
  return { x: cx + dx * k * .97, y: cy + dy * k * .97 };
}
function landingPoint(rect: Rect, offset: number) {
  const box = cardBox();
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  const fromX = box ? box.left + box.width / 2 : innerWidth / 2;
  const fromY = box ? box.top + box.height / 2 : innerHeight / 2;
  if (Math.abs(fromY - cy) > Math.abs(fromX - cx) * .6) return { x: cx + offset * Math.min(rect.w * .3, 22), y: fromY > cy ? rect.y + rect.h : rect.y };
  return { x: fromX > cx ? rect.x + rect.w : rect.x, y: cy + offset * Math.min(rect.h * .28, 9) };
}
function releaseStrands(now: number) {
  for (const strand of strands) if (strand.state !== "released") { strand.state = "released"; strand.t0 = now; }
}
function shoot(now: number) {
  const rect = targetRect();
  if (!rect) return;
  const anchor = cardEdgeToward({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
  releaseStrands(now);
  [-1, 0, 1].forEach((offset, i) => {
    const pts = new Float32Array(POINTS * 2), prev = new Float32Array(POINTS * 2);
    for (let j = 0; j < POINTS; j++) { pts[j * 2] = prev[j * 2] = anchor.x; pts[j * 2 + 1] = prev[j * 2 + 1] = anchor.y; }
    strands.push({ pts, prev, offset, spread: offset * 5, phase: i * 1.7 + Math.random(), alpha: 1, state: "shooting", t0: now + i * 45, seg: 1 });
  });
}
function simulate(now: number, dt: number) {
  const rect = targetRect();
  const gravity = 1400 * dt * dt;
  // The breeze dies down after the strings land, so they come to rest and the loop can stop.
  const calm = landedAt ? Math.max(0, 1 - (now - landedAt - OPEN_MS) / SWAY_MS) : 1;
  const breeze = 540 * dt * dt * Math.min(1, calm) ** 2;
  for (const strand of strands) {
    const { pts, prev } = strand;
    const target = rect ? landingPoint(rect, strand.offset) : null;
    const anchor0 = cardEdgeToward(target ?? { x: pts[(POINTS - 1) * 2], y: pts[(POINTS - 1) * 2 + 1] });
    const a = { x: anchor0.x + strand.spread, y: anchor0.y };
    let head: { x: number; y: number } | null = null;
    let length: number;
    if (strand.state !== "released" && !target) { strand.state = "released"; strand.t0 = now; }
    if (strand.state === "shooting" && target) {
      const t = Math.max(0, Math.min(1, (now - strand.t0) / SHOOT_MS));
      const e = 1 - (1 - t) ** 3;
      const reach = Math.hypot(target.x - a.x, target.y - a.y);
      const lift = -Math.sin(Math.PI * t) * Math.min(110, reach * .32) * (1 + strand.offset * .25);
      const nx = -(target.y - a.y) / (reach || 1), ny = (target.x - a.x) / (reach || 1);
      head = { x: a.x + (target.x - a.x) * e + nx * lift, y: a.y + (target.y - a.y) * e + ny * lift };
      length = Math.hypot(head.x - a.x, head.y - a.y) * 1.02;
      if (t >= 1) { strand.state = "held"; if (!landedAt) landedAt = now; }
    } else if (strand.state === "held" && target) {
      head = target;
      length = Math.hypot(target.x - a.x, target.y - a.y) * 1.06;
    } else {
      const t = Math.min(1, (now - strand.t0) / RELEASE_MS);
      length = Math.hypot(pts[(POINTS - 1) * 2] - a.x, pts[(POINTS - 1) * 2 + 1] - a.y) * (1 - t * .9);
      strand.alpha = 1 - t;
    }
    strand.seg = Math.max(.5, length / (POINTS - 1));
    for (let j = 1; j < POINTS; j++) {
      const x = pts[j * 2], y = pts[j * 2 + 1];
      const vx = (x - prev[j * 2]) * .975, vy = (y - prev[j * 2 + 1]) * .975;
      prev[j * 2] = x; prev[j * 2 + 1] = y;
      pts[j * 2] = x + vx + Math.sin(now / 900 + strand.phase + j * .35) * breeze;
      pts[j * 2 + 1] = y + vy + gravity;
    }
    for (let k = 0; k < 12; k++) {
      pts[0] = a.x; pts[1] = a.y;
      if (head) { pts[(POINTS - 1) * 2] = head.x; pts[(POINTS - 1) * 2 + 1] = head.y; }
      for (let j = 0; j < POINTS - 1; j++) {
        const i0 = j * 2, i1 = i0 + 2;
        const dx = pts[i1] - pts[i0], dy = pts[i1 + 1] - pts[i0 + 1];
        const dist = Math.hypot(dx, dy) || 1e-4;
        if (dist <= strand.seg) continue;  // a rope pulls; it does not push
        const diff = (dist - strand.seg) / dist;
        const fixed0 = j === 0, fixed1 = head !== null && j + 1 === POINTS - 1;
        const w0 = fixed0 ? 0 : fixed1 ? 1 : .5, w1 = fixed1 ? 0 : fixed0 ? 1 : .5;
        pts[i0] += dx * diff * w0; pts[i0 + 1] += dy * diff * w0;
        pts[i1] -= dx * diff * w1; pts[i1 + 1] -= dy * diff * w1;
      }
    }
    for (let j = 1; j < POINTS; j++) motion = Math.max(motion, Math.abs(pts[j * 2] - prev[j * 2]), Math.abs(pts[j * 2 + 1] - prev[j * 2 + 1]));
  }
  strands = strands.filter(strand => strand.alpha > .01);
}

// ---- Drawing
function resizeCanvas(): number {
  const element = canvas.value!;
  const ratio = Math.min(devicePixelRatio || 1, 2);
  const width = Math.round(innerWidth * ratio), height = Math.round(innerHeight * ratio);
  if (element.width !== width || element.height !== height) { element.width = width; element.height = height; }
  return ratio;
}
/**
 * The rope takes the room's accent, which follows the company's theme. The variable is a
 * light-dark() pair the canvas cannot read, so a hidden probe lets the browser resolve it
 * to one rgb() colour for the current appearance first.
 */
function readAccent() {
  if (!ctx || !dialog.value) return;
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;width:0;height:0;color:var(--workspace-accent, #a8dec7)";
  dialog.value.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  ctx.fillStyle = "#a8dec7";
  if (resolved) ctx.fillStyle = resolved;  // the canvas keeps the last valid colour if this one is not
  accent = String(ctx.fillStyle);
}
function withAlpha(color: string, alpha: number) {
  if (color.startsWith("#")) {
    const n = parseInt(color.slice(1, 7), 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${alpha})`;
  }
  return color.replace(/rgba?\(([^)]+)\)/, (_, parts: string) => `rgba(${parts.split(",").slice(0, 3).join(",")},${alpha})`);
}
function draw(now: number) {
  if (!ctx || !canvas.value) return;
  const ratio = resizeCanvas();
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  // The dim layer, with an opening that grows on the part once the strings land.
  ctx.fillStyle = "rgba(0,0,0,.72)";
  ctx.fillRect(0, 0, innerWidth, innerHeight);
  const rect = targetRect();
  drawnAt = placement(rect, cardBox());
  const open = landedAt ? (reducedMotion() ? 1 : Math.min(1, (now - landedAt) / OPEN_MS)) : 0;
  if (rect && open > 0) {
    const e = 1 - (1 - open) ** 3;
    const w = rect.w * e, h = rect.h * e;
    const x = rect.x + (rect.w - w) / 2, y = rect.y + (rect.h - h) / 2;
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.shadowColor = "#000"; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 10); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = withAlpha(accent, .38 * e);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(x + .5, y + .5, w - 1, h - 1, 10); ctx.stroke();
  }
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (const strand of strands) {
    const { pts } = strand;
    const path = new Path2D();
    path.moveTo(pts[0], pts[1]);
    for (let j = 1; j < POINTS - 1; j++) {
      path.quadraticCurveTo(pts[j * 2], pts[j * 2 + 1], (pts[j * 2] + pts[j * 2 + 2]) / 2, (pts[j * 2 + 1] + pts[j * 2 + 3]) / 2);
    }
    path.lineTo(pts[(POINTS - 1) * 2], pts[(POINTS - 1) * 2 + 1]);
    const alpha = strand.alpha * (strand.offset === 0 ? 1 : .6);
    // The glow is two wide, faint strokes under the core. Canvas shadows blur every pixel the
    // path covers on every frame; on a full-window canvas that was most of the tour's GPU work.
    ctx.strokeStyle = withAlpha(accent, .07 * alpha); ctx.lineWidth = 10; ctx.stroke(path);
    ctx.strokeStyle = withAlpha(accent, .22 * alpha); ctx.lineWidth = 4.5; ctx.stroke(path);
    ctx.strokeStyle = withAlpha(accent, .85 * alpha); ctx.lineWidth = strand.offset === 0 ? 1.7 : 1.1; ctx.stroke(path);
    ctx.strokeStyle = `rgba(255,255,255,${.5 * alpha})`; ctx.lineWidth = .6; ctx.stroke(path);
    const hx = pts[(POINTS - 1) * 2], hy = pts[(POINTS - 1) * 2 + 1], r = strand.state === "shooting" ? 2.4 : 1.7;
    ctx.fillStyle = withAlpha(accent, .22 * alpha);
    ctx.beginPath(); ctx.arc(hx, hy, r * 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${.9 * alpha})`;
    ctx.beginPath(); ctx.arc(hx, hy, r, 0, Math.PI * 2); ctx.fill();
  }
}

/** Reduced motion: the strings appear already settled; nothing sways or flies. */
function settleNow(now: number) {
  shoot(now);
  for (const strand of strands) if (strand.state === "shooting") strand.t0 = now - SHOOT_MS;
  for (let i = 0; i < 160; i++) simulate(now, 1 / 120);
  strands.forEach(strand => { strand.prev.set(strand.pts); });
  landedAt = now - OPEN_MS;
  draw(now);
  watchForMoves();
}

/**
 * Nothing left to move: no shot waiting, no string letting go, and the strings held and calm (or
 * none at all, as on the welcome). The last frame stays on screen and the loop stops until
 * run() starts it again: a new step, a resize, the window shown again, or the part moving.
 */
let wokeAt = 0;
function still(now: number) {
  if (shootAt || now - wokeAt < STILL_MS) return false;
  if (!strands.length) return true;
  const settled = landedAt > 0 && now - landedAt >= OPEN_MS + SWAY_MS && strands.every(strand => strand.state === "held");
  // Calm means the strings stopped swinging too, not only that the breeze ended; a long pull
  // (a resize) can leave a swing. MAX_AWAKE_MS caps the wait so a jitter cannot keep it awake.
  return settled && (motion < .05 || now - wokeAt >= MAX_AWAKE_MS);
}
function tick(now: number) {
  frame = 0;
  if (!dialog.value?.open || document.hidden) return;  // a hidden window costs nothing; visibilitychange resumes
  try {
    frameTarget = undefined; frameCard = undefined;
    frameCard = cardBox(); frameTarget = targetRect();
    if (shootAt && now >= shootAt) { shootAt = 0; shoot(now); }
    const dt = Math.min(1 / 30, lastTick ? (now - lastTick) / 1000 : 1 / 60);
    lastTick = now;
    motion = 0;
    simulate(now, dt / 2);
    simulate(now, dt / 2);
    draw(now);
  } finally {
    frameTarget = undefined; frameCard = undefined;
  }
  if (!still(now)) frame = requestAnimationFrame(tick);
  else watchForMoves();
}
function run() {
  cancelAnimationFrame(frame);
  window.clearTimeout(movedTimer);
  lastTick = 0;
  wokeAt = performance.now();
  if (reducedMotion()) { draw(wokeAt); watchForMoves(); return; }
  frame = requestAnimationFrame(tick);
}
function placement(rect: Rect | null, box: DOMRect | null) {
  const r = rect ? `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.w)},${Math.round(rect.h)}` : "-";
  return box ? `${r}|${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.width)},${Math.round(box.height)}` : r;
}
/**
 * While the loop is stopped, look every MOVED_CHECK_MS whether the part or the card moved: a tab
 * that slides when a badge grows next to it, a part drawn again as a new element. Two layout reads
 * a few times a second; any move wakes the loop (reduced motion settles again).
 */
function watchForMoves() {
  window.clearTimeout(movedTimer);
  movedTimer = window.setTimeout(() => {
    if (!dialog.value?.open || frame) return;
    if (document.hidden) { watchForMoves(); return; }
    if (placement(targetRect(), cardBox()) !== drawnAt) followTarget();
    else watchForMoves();
  }, MOVED_CHECK_MS);
}
function onVisibility() { if (!document.hidden && dialog.value?.open) run(); }
function resettle() { strands = []; settleNow(performance.now()); }
function onResize() { placeCard(); if (reducedMotion()) resettle(); else run(); }
/** The part moved while the loop was stopped: follow it (reduced motion settles again instead). */
function followTarget() {
  if (!dialog.value?.open) return;
  if (reducedMotion()) {
    cancelAnimationFrame(settleFrame);
    settleFrame = requestAnimationFrame(() => { if (dialog.value?.open) resettle(); });
  } else if (!frame) run();
}
/**
 * The loop stops at rest (and reduced motion draws once), so a part that changes size later (the
 * sidebar, a late layout) would leave the opening behind. Watch the part and the room; a part
 * that only moves is caught by watchForMoves().
 */
function watchTarget() {
  settleObserver?.disconnect();
  settleObserver = null;
  if (welcomeShown.value || typeof ResizeObserver !== "function") return;
  const target = [...document.querySelectorAll<HTMLElement>(step.value.selector)]
    .find(element => !element.closest('[inert], [hidden], [aria-hidden="true"]'));
  const room = dialog.value?.closest<HTMLElement>(".desktop-room-shell");
  settleObserver = new ResizeObserver(followTarget);
  for (const element of [target, room]) if (element) settleObserver.observe(element);
}
function onContextRestored() { readAccent(); run(); }

/** The parts on screen now. Read again on leaving the welcome: parts may appear after the tour opens. */
function readSteps() {
  const visible = steps.filter(item => visibleTarget(item.selector));
  availableSteps.value = visible.length ? visible : [steps[1]];
}
function showStep(next: number) {
  const now = performance.now();
  window.clearTimeout(welcomeTimer);
  if (welcomeShown.value && next === 0) readSteps();
  welcomeShown.value = false;
  index.value = next;
  releaseStrands(now);
  landedAt = 0;
  if (reducedMotion()) {
    strands = [];
    void nextTick(() => { settleNow(performance.now()); watchTarget(); });
    return;
  }
  shootAt = now + SHOOT_DELAY_MS;
  run();  // the loop may have stopped at rest on the last step
  void nextTick(watchTarget);
}
/** The welcome moves on by itself, unless the person is reading it (pointer or focus in the card). */
function holdWelcome() { window.clearTimeout(welcomeTimer); }
function onCardFocus(event: FocusEvent) { if (event.target !== nextButton.value) holdWelcome(); }
function advance() {
  window.clearTimeout(welcomeTimer);
  if (welcomeShown.value) return showStep(0);
  if (index.value + 1 >= availableSteps.value.length) return finish();
  showStep(index.value + 1);
}
/** A dot jumps to its step, back or forward. */
function goToStep(dot: number) {
  if (welcomeShown.value || dot === index.value || dot < 0 || dot >= availableSteps.value.length) return;
  window.clearTimeout(welcomeTimer);
  showStep(dot);
}
function onKey(event: KeyboardEvent) {
  if (event.key === "ArrowRight") { event.preventDefault(); advance(); }
  else if (event.key === "ArrowLeft" && !welcomeShown.value && index.value > 0) { event.preventDefault(); showStep(index.value - 1); }
}

/**
 * Opens the tour. With `welcome`, it first says what LetAgents is (the first room after onboarding),
 * then moves on by itself unless the person moves first.
 */
async function open(options: { welcome?: { name?: string | null } } = {}) {
  if (!dialog.value?.isConnected || dialog.value.open) return;
  const visible = steps.filter(item => visibleTarget(item.selector));
  if (!visible.length && !options.welcome) return;
  availableSteps.value = visible.length ? visible : [steps[1]];
  index.value = 0;
  welcomeShown.value = Boolean(options.welcome);
  welcomeName.value = options.welcome?.name?.trim() || null;
  strands = []; landedAt = 0; shootAt = 0;
  dialog.value.showModal();
  ctx = canvas.value?.getContext("2d") ?? null;
  canvas.value?.addEventListener("contextrestored", onContextRestored);
  readAccent();
  addEventListener("resize", onResize);
  addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", onVisibility);
  await nextTick();
  placeCard();
  nextButton.value?.focus();
  if (welcomeShown.value) {
    // Under reduced motion nothing changes by itself: the person moves on with the button.
    if (!reducedMotion()) {
      welcomeTimer = window.setTimeout(() => { if (welcomeShown.value && dialog.value?.open) showStep(0); }, WELCOME_MS);
    }
  } else if (reducedMotion()) {
    settleNow(performance.now());
    watchTarget();
  } else {
    shootAt = performance.now() + 240;
    watchTarget();
  }
  run();
}

function finish() { dialog.value?.close(); }
function stop() {
  cancelAnimationFrame(frame);
  frame = 0;
  window.clearTimeout(welcomeTimer);
  settleObserver?.disconnect(); settleObserver = null;
  cancelAnimationFrame(settleFrame);
  strands = []; shootAt = 0; landedAt = 0;
  removeEventListener("resize", onResize);
  removeEventListener("keydown", onKey);
  document.removeEventListener("visibilitychange", onVisibility);
  window.clearTimeout(movedTimer);
  canvas.value?.removeEventListener("contextrestored", onContextRestored);
}
function close() { dialog.value?.close(); }
// The first room after onboarding: once it is ready, say what LetAgents is, then show the room around.
let firstTourTimer = 0;
/** Another modal (a company invite, say) is open: the tour waits for it instead of opening on top. */
const otherModalOpen = () => [...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')]
  .some(element => element !== dialog.value);
function tryFirstTour(delay: number) {
  window.clearTimeout(firstTourTimer);
  if (props.roomLoading || !hasFirstRoomTour(props.roomIdentifier)) return;
  // Let the room's arrival and first paint settle before the tour dims it.
  firstTourTimer = window.setTimeout(() => {
    // The mark is used only when the tour can open: on the page, the window shown, nothing else on top.
    if (!dialog.value?.isConnected || document.hidden || otherModalOpen()) { tryFirstTour(700); return; }
    if (!takeFirstRoomTour(props.roomIdentifier)) return;
    void open({ welcome: { name: props.viewerName } });
  }, delay);
}
watch([() => props.roomIdentifier, () => props.roomLoading], () => tryFirstTour(900), { immediate: true });

onActivated(() => tryFirstTour(900));
onDeactivated(() => { window.clearTimeout(firstTourTimer); close(); });
onUnmounted(() => { stop(); window.clearTimeout(firstTourTimer); });
defineExpose({ open, close });
</script>

<style scoped>
.room-guide { position: fixed; inset: 0; width: 100vw; height: 100dvh; max-width: none; max-height: none; padding: 0; border: 0; color: var(--text); background: transparent; overflow: hidden; }
.room-guide[open] { display: block; }
.room-guide::backdrop { background: transparent; }
.room-guide-canvas { position: absolute; inset: 0; width: 100%; height: 100%; cursor: pointer; }
.room-guide-card {
  position: absolute; top: 0; left: 0; box-sizing: border-box; width: min(340px, calc(100vw - 32px)); padding: 20px 20px 14px;
  border: 1px solid var(--workspace-border, var(--border)); border-radius: 16px;
  /* Solid, not frosted: a backdrop blur over the canvas had to be redone on every frame the
     strings moved, and it showed the room's own heading as a smear through the card. */
  background: var(--workspace-canvas, var(--bg));
  box-shadow: 0 24px 60px -20px #000a;
  animation: room-guide-in 360ms cubic-bezier(.16, 1, .3, 1) both;
}
.room-guide-example { display: grid; align-content: start; gap: 8px; }
.room-guide-example h2 { margin: 0 0 2px; font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif; font-weight: 500; font-size: 32px; line-height: 1.02; letter-spacing: -.02em; text-wrap: balance; }
.room-guide-example p { margin: 0; color: var(--text-secondary); line-height: 1.45; }
.room-guide-example-note { display: block; width: fit-content; margin-top: 2px; padding: 5px 9px; border-radius: 6px; background: var(--workspace-composer, var(--bg-card)); color: var(--text-secondary); font-size: 12px; }
.room-guide-position { color: var(--text-secondary); font-size: 11.5px; letter-spacing: .03em; opacity: .75; }
.room-guide-actions { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 16px; }
.room-guide-quiet { min-height: 32px; padding: 0 2px; border: 0; background: none; color: var(--text-secondary); font: inherit; font-size: 13px; cursor: pointer; }
.room-guide-quiet:hover { color: var(--text); }
.room-guide-dots { display: flex; }
/* Each dot is a button with a larger target than the dot it shows (the row keeps its 5 px spacing). */
.room-guide-dot { display: grid; place-items: center; width: 14px; height: 22px; margin: 0 -2px; padding: 0; border: 0; border-radius: 6px; background: none; cursor: pointer; }
.room-guide-dot i { width: 5px; height: 5px; border-radius: 50%; background: color-mix(in srgb, var(--text) 20%, transparent); transition: background-color 220ms ease, transform 160ms cubic-bezier(0.23, 1, 0.32, 1); }
.room-guide-dot:hover i { background: color-mix(in srgb, var(--text) 55%, transparent); }
.room-guide-dot:active i { transform: scale(0.85); }
.room-guide-dot[data-on="true"] { cursor: default; }
.room-guide-dot[data-on="true"] i { background: var(--text); transform: scale(1.25); }
.room-guide-dot:focus-visible { outline: 2px solid var(--workspace-accent, var(--text)); outline-offset: -2px; }
.room-guide-next {
  min-height: 34px; padding: 0 14px; border: 1px solid var(--workspace-border, var(--border)); border-radius: 9px;
  background: var(--workspace-composer, var(--bg-card)); color: var(--text); font: inherit; font-size: 13px; font-weight: 560; cursor: pointer;
  transition: transform 160ms cubic-bezier(.23, 1, .32, 1), background-color 160ms ease;
}
.room-guide-next:hover { background: color-mix(in srgb, var(--workspace-composer, var(--bg-card)) 80%, var(--text) 8%); }
.room-guide-next:active { transform: scale(.97); }
.room-guide-next:focus-visible, .room-guide-quiet:focus-visible { outline: 2px solid var(--workspace-accent, var(--text)); outline-offset: 2px; }
.guide-example-enter-active { transition: opacity 220ms ease, filter 220ms ease, transform 300ms cubic-bezier(.16, 1, .3, 1); }
.guide-example-leave-active { transition: opacity 110ms ease, filter 110ms ease; }
.guide-example-enter-from { opacity: 0; filter: blur(5px); transform: translateY(5px); }
.guide-example-leave-to { opacity: 0; filter: blur(5px); }
@keyframes room-guide-in { from { opacity: 0; filter: blur(6px); } }
@media (prefers-reduced-motion: reduce) {
  .room-guide-card { animation: none; }
  .guide-example-enter-active, .guide-example-leave-active { transition: opacity 120ms linear; }
  .guide-example-enter-from, .guide-example-leave-to { filter: none; transform: none; }
}
</style>
