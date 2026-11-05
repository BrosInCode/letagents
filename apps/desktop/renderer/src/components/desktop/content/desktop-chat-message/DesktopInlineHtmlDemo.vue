<template>
  <section
    ref="card"
    class="room-inline-demo"
    :class="{ 'is-live': liveLayout }"
    :aria-label="`Interactive demo ${fileName}`"
  >
    <header class="room-inline-demo-header">
      <FileCode class="room-inline-demo-icon" :size="16" aria-hidden="true" />
      <span class="room-inline-demo-title">
        <strong :title="fileName">{{ fileName }}</strong>
        <small title="Runs in a locked view on this computer. It cannot load web pages or reach your LetAgents data.">Interactive demo · locked</small>
      </span>
      <button
        class="room-inline-demo-action"
        type="button"
        aria-label="Reload demo"
        title="Reload demo"
        @click="reload"
      >
        <RotateCw :size="14" aria-hidden="true" />
      </button>
      <button
        class="room-inline-demo-action"
        type="button"
        aria-label="Expand demo"
        title="Open in a larger window"
        :disabled="expanding"
        @click="expand"
      >
        <Maximize2 :size="14" aria-hidden="true" />
      </button>
    </header>
    <LiveDemoBar
      v-if="liveReady"
      :people="live.people.value"
      :self-cid="live.selfCid.value"
      :status-text="liveStatus"
      :drawing="drawing"
      :tool="tool"
      :draw-disabled="live.status.value === 'refused' || Boolean(live.joinError.value)"
      :mark-count="live.marks.value.length"
      :marks-open="marksOpen"
      :can-send="canSend"
      :send-phase="sendPhase"
      @toggle-draw="toggleDraw"
      @set-tool="tool = $event"
      @toggle-marks="marksOpen = !marksOpen"
      @send="sendToThread"
    />
    <div v-else-if="liveEnabled && (status === 'starting' || status === 'running')" class="room-inline-demo-live is-placeholder" aria-hidden="true"></div>
    <LiveDemoSendPreview
      v-if="capture"
      :preview-url="capture.previewDataUrl"
      :partial="capture.partial"
      :sending="sendPhase === 'sending'"
      :error="sendError"
      @confirm="confirmSend"
      @cancel="cancelSend"
    />
    <LiveDemoMarkList
      v-if="liveReady && marksOpen && live.marks.value.length > 0"
      :marks="live.marks.value"
      :is-own="live.isOwnMark"
      :busy-ids="deletingMarkIds"
      @highlight="highlightedMarkId = $event"
      @delete="deleteMark"
    />
    <p v-if="expandError" class="room-inline-demo-note" role="alert">{{ expandError }}</p>
    <div
      ref="clip"
      class="room-inline-demo-clip"
      :class="{ 'is-clipped': clipState?.clipped }"
      :style="clipState?.clipped ? { height: `${clipState.visibleHeight + 2}px` } : undefined"
    >
      <div
        ref="body"
        class="room-inline-demo-body"
        :style="{ height: `${frameHeight}px` }"
      >
        <webview
          v-if="lease"
          :key="lease.url"
          ref="view"
          class="room-inline-demo-view"
          :partition="lease.partition"
          :src="lease.url"
          @dom-ready="onViewReady"
          @render-process-gone="onViewGone"
          @did-fail-load="onLoadFailed"
          @destroyed="onViewDestroyed"
        />
        <LiveDemoOverlay
          v-if="liveReady"
          :session="live"
          :width="frameWidth"
          :height="frameHeight"
          :scale="scale"
          :drawing="drawing"
          :tool="tool"
          :highlight-mark-id="highlightedMarkId"
          @exit="drawing = false"
          @notice="showNote($event, true)"
        />
        <div
          v-if="statusText"
          class="room-inline-demo-status"
          :class="{ 'is-error': status === 'error' }"
          :role="status === 'error' ? 'alert' : 'status'"
        >
          <p>{{ statusText }}</p>
          <button v-if="status === 'stopped' || status === 'error'" type="button" @click="reload">Reload</button>
        </div>
      </div>
      <div v-if="clipState?.clipped" class="room-inline-demo-fade" aria-hidden="true"></div>
      <p
        v-if="note"
        class="room-inline-demo-live-note"
        :class="{ 'is-error': note.error }"
        :role="note.error ? 'alert' : 'status'"
      >{{ note.text }}</p>
    </div>
    <button
      v-if="clipState?.clippable"
      class="room-inline-demo-more"
      type="button"
      :aria-expanded="showAll"
      @click="showAll = !showAll"
    >{{ showAll ? "Show less" : "Show all" }}</button>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, shallowRef, watch } from "vue";
import { FileCode, Maximize2, RotateCw } from "@lucide/vue";
import type {
  DesktopInlineHtmlDemoEvent,
  DesktopInlineHtmlDemoLease,
} from "../../../../../../electron/ipc-types";
import {
  htmlDemoErrorText,
  inlineDemoFrameHeight,
  inlineDemoFocusToRestore,
  inlineDemoMayRestart,
  inlineDemoStoppedText,
  ipcErrorText,
  type InlineDemoStopReason,
} from "./attachments";
import { inlineDemoEvents } from "./inline-demo-events";
import {
  dropPendingInlineDemoHeight,
  inlineDemoHeightSettleDelay,
  newInlineDemoHeight,
  reportInlineDemoHeight,
  settleInlineDemoHeight,
  type InlineDemoHeight,
} from "./inline-demo-height";
import { inlineDemoSlots, MAX_RUNNING_INLINE_DEMOS, type InlineDemoSlot } from "./inline-demo-slots";
import { desktopIpc } from "../../../../ipc/index";
import { isLocalRoomIdentifier } from "../../../../domain/room-urls";
import { roomThreadReplyKey } from "../../../../composables/roomThreadReply";
import {
  LIVE_FALLBACK_SCALE,
  LIVE_MIN_FRAME_WIDTH,
  liveClip,
  liveFrameHeight,
  liveReportedHeight,
  liveScale,
} from "./live-demo/geometry";
import { liveStatusText } from "./live-demo/people";
import {
  elementClippingBoxes,
  markupFileName,
  markupReplyText,
  viewportBox,
  visibleCaptureRect,
} from "./live-demo/markup";
import { liveDemoKey } from "./live-demo/protocol";
import { liveDemoAvailable, useLiveDemo } from "./live-demo/session";
import { createWidthSync, type WidthSync } from "./live-demo/width-sync";
import LiveDemoBar from "./live-demo/LiveDemoBar.vue";
import LiveDemoMarkList from "./live-demo/LiveDemoMarkList.vue";
import LiveDemoOverlay from "./live-demo/LiveDemoOverlay.vue";
import LiveDemoSendPreview from "./live-demo/LiveDemoSendPreview.vue";

const props = defineProps<{
  href: string;
  fileName: string;
  senderLabel?: string | null;
  /** With the message and attachment ids, these make the demo live: shared with the room. */
  roomIdentifier?: string | null;
  messageId?: string | null;
  attachmentId?: string | null;
  /** The thread a picture of the demo is sent to. */
  threadRootId?: string | null;
}>();

type DemoStatus = "idle" | "waiting" | "starting" | "running" | "stopped" | "error";

// Off screen for this long, a running demo is released; scrolling past one does not restart it.
const PAUSE_AFTER_OFF_SCREEN_MS = 15_000;
// A lease whose webview never loads (main refused it, say) ends in the error state.
const START_TIMEOUT_MS = 15_000;

const card = ref<HTMLElement | null>(null);
const clip = ref<HTMLElement | null>(null);
const body = ref<HTMLElement | null>(null);
const view = ref<HTMLElement | null>(null);
const status = ref<DemoStatus>("idle");
const lease = ref<DesktopInlineHtmlDemoLease | null>(null);
const errorText = ref("");
const stoppedReason = ref<InlineDemoStopReason>("unresponsive");
// Kept across pauses and reloads so the chat does not jump while the demo is away.
const heightState = ref<InlineDemoHeight>(newInlineDemoHeight());
const expanding = ref(false);
const expandError = ref("");

// Live layout: the demo is laid out 760 px wide, scaled to the card, at its full
// height (main reports that height already scaled, in frame px). Any demo with an
// attachment id gets it when main can do it; the rest keep the fixed-height frame
// with scrolling inside.
const widthApiAvailable = typeof desktopIpc.room?.setInlineDemoWidth === "function";
const layoutFailed = ref(false);
const liveLayout = computed(() => widthApiAvailable && Boolean(props.attachmentId) && !layoutFailed.value);
const frameWidth = ref(0);
// What main applied; the frame width gives the same number until it answers.
const appliedScale = ref<number | null>(null);
const showAll = ref(false);
const scale = computed(() => appliedScale.value ?? liveScale(frameWidth.value) ?? LIVE_FALLBACK_SCALE);
const frameHeight = computed(() => liveLayout.value
  ? liveFrameHeight(heightState.value.shown, scale.value)
  : inlineDemoFrameHeight(heightState.value.shown));
const clipState = computed(() => liveLayout.value ? liveClip(frameHeight.value, showAll.value) : null);

// Live session: who is on the demo, their cursors, the ink and the saved marks.
const liveRoom = computed(() => props.roomIdentifier && !isLocalRoomIdentifier(props.roomIdentifier) ? props.roomIdentifier : null);
const demoKey = computed(() =>
  props.messageId && props.attachmentId && !props.messageId.startsWith("pending:")
    ? liveDemoKey(props.messageId, props.attachmentId)
    : null);
const liveAvailable = liveDemoAvailable();
const liveEnabled = computed(() => liveAvailable && liveLayout.value && Boolean(liveRoom.value && demoKey.value));
const live = useLiveDemo({ roomIdentifier: () => liveRoom.value, demoKey: () => demoKey.value });
// The bar and overlay need a running demo that has its scale.
const liveReady = computed(() => liveEnabled.value && status.value === "running" && appliedScale.value !== null && frameWidth.value > 0);
const liveStatus = computed(() => liveStatusText(live.status.value, live.joinError.value, live.statusReason.value));
const drawing = ref(false);
const tool = ref<"pen" | "pin">("pen");
const marksOpen = ref(false);
const highlightedMarkId = ref<string | null>(null);
const deletingMarkIds = shallowRef<ReadonlySet<string>>(new Set());
const note = ref<{ text: string; error: boolean } | null>(null);
// Send to thread: capture, then the person looks at the picture ("review"), then it is sent.
const sendPhase = ref<"idle" | "capturing" | "review" | "sending">("idle");
const capture = ref<{ room: string; uploadId: string; previewDataUrl: string | null; partial: boolean } | null>(null);
const sendError = ref("");
const sendThreadReply = inject(roomThreadReplyKey, null);
const canSend = computed(() =>
  Boolean(sendThreadReply && props.threadRootId && liveRoom.value)
  && typeof desktopIpc.room?.captureDemoMarkup === "function");

const statusText = computed(() => {
  switch (status.value) {
    case "waiting":
      return `Waiting: ${MAX_RUNNING_INLINE_DEMOS} demos are running. This one starts when one stops.`;
    case "starting":
      return "Starting the demo…";
    case "running":
      // The page would show at the wrong size until main has laid it out.
      return liveLayout.value && appliedScale.value === null ? "Starting the demo…" : "";
    case "stopped":
      return inlineDemoStoppedText(stoppedReason.value);
    case "error":
      return errorText.value;
    default:
      return "";
  }
});

let observer: IntersectionObserver | undefined;
let intersecting = false;
let onScreen = false;
let pauseTimer: ReturnType<typeof setTimeout> | undefined;
let startTimer: ReturnType<typeof setTimeout> | undefined;
let heightTimer: ReturnType<typeof setTimeout> | undefined;
// The room view is kept alive, not unmounted, when the person opens Settings.
let deactivated = false;
let restartedAt: number[] = [];
let stopEvents: (() => void) | null = null;
let slot: InlineDemoSlot | null = null;
// Raised whenever a run starts or ends, so a late answer from main is ignored.
let generation = 0;
let widthSync: WidthSync | null = null;
let resizeObserver: ResizeObserver | undefined;
let noteTimer: ReturnType<typeof setTimeout> | undefined;
// Raised by each "Send to thread", so a card that left or restarted drops a late answer.
let sendRun = 0;

function releaseLease(url: string): void {
  // Main also drops a lease when its guest is gone, so a failed release is not news.
  void Promise.resolve(desktopIpc.room?.releaseInlineHtmlDemo?.(url)).catch(() => undefined);
}

/** Ends the current run: gives back the slot and the lease and removes the webview. */
function stopRun(): void {
  generation++;
  clearTimeout(pauseTimer);
  pauseTimer = undefined;
  clearTimeout(startTimer);
  startTimer = undefined;
  clearTimeout(heightTimer);
  heightTimer = undefined;
  heightState.value = dropPendingInlineDemoHeight(heightState.value);
  slot?.release();
  slot = null;
  stopEvents?.();
  stopEvents = null;
  stopLive();
  const url = lease.value?.url;
  lease.value = null;
  if (url) releaseLease(url);
}

/** Leaves the live session and forgets the layout main applied to the guest that is gone. */
function stopLive(): void {
  sendRun++;
  sendPhase.value = "idle";
  discardCapture();
  drawing.value = false;
  marksOpen.value = false;
  highlightedMarkId.value = null;
  live.stop();
  widthSync?.close();
  widthSync = null;
  appliedScale.value = null;
}

function requestRun(): void {
  const version = ++generation;
  if (layoutFailed.value) {
    // A new run tries the live layout again. The kept height was for the plain frame.
    layoutFailed.value = false;
    heightState.value = newInlineDemoHeight();
  }
  status.value = "waiting";
  slot = inlineDemoSlots.request(() => {
    if (version === generation) void startRun(version);
  });
  // A grant that comes at once can end the run before `slot` is set.
  if (version !== generation) {
    slot.release();
    slot = null;
  }
}

async function startRun(version: number): Promise<void> {
  status.value = "starting";
  try {
    const prepare = desktopIpc.room?.prepareInlineHtmlDemo;
    if (!prepare) throw new Error("Update LetAgents to run demos here.");
    const next = await prepare(props.href);
    if (version !== generation) {
      releaseLease(next.url);
      return;
    }
    lease.value = next;
    stopEvents = inlineDemoEvents.register(next.url, handleDemoEvent);
    startTimer = setTimeout(startTimedOut, START_TIMEOUT_MS);
    if (liveEnabled.value) live.start(next.url);
  } catch (error) {
    if (version !== generation) return;
    stopRun();
    errorText.value = htmlDemoErrorText(error);
    status.value = "error";
  }
}

function reload(): void {
  stopRun();
  errorText.value = "";
  restartedAt = [];
  heightState.value = newInlineDemoHeight(heightState.value.shown);
  status.value = "idle";
  if (onScreen) requestRun();
}

function markRunning(): void {
  if (status.value !== "starting") return;
  clearTimeout(startTimer);
  startTimer = undefined;
  status.value = "running";
}

function markStopped(reason: InlineDemoStopReason): void {
  if (!lease.value) return;
  stopRun();
  stoppedReason.value = reason;
  status.value = "stopped";
}

function startTimedOut(): void {
  if (status.value !== "starting" || !lease.value) return;
  stopRun();
  errorText.value = "This demo did not start.";
  status.value = "error";
}

/** The guest is gone and nothing said why: start a fresh lease if the card is in view. */
function restartAfterLoss(): void {
  stopRun();
  status.value = "idle";
  if (!onScreen) return;
  const now = performance.now();
  if (inlineDemoMayRestart(now, restartedAt)) {
    restartedAt = [...restartedAt, now].slice(-4);
    requestRun();
  } else {
    stoppedReason.value = "crashed";
    status.value = "stopped";
  }
}

// A webview that was removed can still report late; only the current one counts.
function ownsEvent(event: Event): boolean {
  return lease.value !== null && event.target === view.value;
}

function onViewReady(event: Event): void {
  if (!ownsEvent(event)) return;
  markRunning();
  // The page may have been reloaded, which resets its zoom.
  syncWidth(true);
}

function onViewGone(event: Event): void {
  if (ownsEvent(event)) markStopped("crashed");
}

function onViewDestroyed(event: Event): void {
  if (ownsEvent(event) && !deactivated) restartAfterLoss();
}

function onLoadFailed(event: Event): void {
  // -3 is a load cut short on purpose, as when the webview is removed.
  const { errorCode, isMainFrame } = event as Event & { errorCode?: number; isMainFrame?: boolean };
  if (ownsEvent(event) && isMainFrame && errorCode !== -3) markStopped("crashed");
}

function scheduleHeightSettle(): void {
  clearTimeout(heightTimer);
  heightTimer = undefined;
  const delay = inlineDemoHeightSettleDelay(heightState.value, performance.now());
  if (delay === null) return;
  heightTimer = setTimeout(() => {
    heightState.value = settleInlineDemoHeight(heightState.value, performance.now());
    scheduleHeightSettle();
  }, delay);
}

function handleDemoEvent(event: DesktopInlineHtmlDemoEvent): void {
  switch (event.type) {
    case "height":
      heightState.value = reportInlineDemoHeight(
        heightState.value,
        event.height,
        performance.now(),
        liveLayout.value ? liveReportedHeight : undefined,
      );
      scheduleHeightSettle();
      markRunning();
      break;
    case "stopped":
      markStopped(event.reason);
      break;
    case "focus-refused":
      giveFocusBack();
      break;
  }
}

async function expand(): Promise<void> {
  if (expanding.value) return;
  expandError.value = "";
  expanding.value = true;
  try {
    const open = desktopIpc.room?.openHtmlDemo;
    if (!open) throw new Error("Update LetAgents to open demos.");
    await open(props.href, props.fileName, props.senderLabel ?? null);
  } catch (error) {
    expandError.value = htmlDemoErrorText(error);
  } finally {
    expanding.value = false;
  }
}

function syncOnScreen(): void {
  const next = intersecting && document.visibilityState === "visible";
  if (next === onScreen) return;
  onScreen = next;
  if (next) {
    clearTimeout(pauseTimer);
    pauseTimer = undefined;
    if (status.value === "idle") requestRun();
  } else if (status.value === "waiting") {
    // Nothing runs yet, so there is nothing to keep warm.
    stopRun();
    status.value = "idle";
  } else if ((status.value === "starting" || status.value === "running") && pauseTimer === undefined) {
    pauseTimer = setTimeout(() => {
      stopRun();
      status.value = "idle";
    }, PAUSE_AFTER_OFF_SCREEN_MS);
  }
}

/**
 * The outermost scroller, so the observer's margin reaches past the edge of the
 * list. The scrollers between it and the card still clip it as usual.
 */
function outermostScroller(element: HTMLElement): HTMLElement | null {
  let found: HTMLElement | null = null;
  for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
    if (/auto|scroll|overlay/.test(getComputedStyle(node).overflowY)) found = node;
  }
  return found;
}

// Main refuses a demo's focus when the person did not click or tab into it. Input
// inside a webview never reaches this page, so only main can tell. Putting focus
// back needs the element that lost it to the demo.
let leftFocus: { element: HTMLElement; at: number } | null = null;

function noteFocusOut(event: FocusEvent): void {
  if (event.target instanceof HTMLElement && event.target !== view.value) {
    leftFocus = { element: event.target, at: performance.now() };
  }
}

function giveFocusBack(): void {
  const demo = view.value;
  if (!demo) return;
  const holder = document.activeElement;
  demo.blur();
  // Someone who already moved on to another element keeps it.
  if (holder && holder !== demo && holder !== document.body) return;
  inlineDemoFocusToRestore(leftFocus, performance.now())?.focus({ preventScroll: true });
}

watch(() => props.href, reload);

/**
 * Tells main how wide the frame is, so it lays the page out at 760 px and scales
 * it to fit. Main may hear it before the webview attaches and applies it then.
 */
function syncWidth(force = false): void {
  const url = lease.value?.url;
  const width = frameWidth.value;
  const setWidth = desktopIpc.room?.setInlineDemoWidth;
  if (!liveLayout.value || !url || !setWidth || width < LIVE_MIN_FRAME_WIDTH) return;
  widthSync ??= createWidthSync(
    (next) => setWidth(url, next),
    (applied) => { appliedScale.value = applied; },
    onWidthFailed,
  );
  widthSync.request(width, force);
}

/** Main cannot lay the page out at the live width: the card falls back to the plain frame. */
function onWidthFailed(): void {
  if (!liveLayout.value) return;
  stopLive();
  layoutFailed.value = true;
  heightState.value = newInlineDemoHeight();
}

watch([frameWidth, () => lease.value?.url], () => syncWidth());

function observeWidth(): void {
  resizeObserver?.disconnect();
  if (!body.value || !widthApiAvailable || !props.attachmentId || typeof ResizeObserver === "undefined") return;
  resizeObserver = new ResizeObserver((entries) => {
    const width = entries[entries.length - 1]?.contentRect.width ?? 0;
    frameWidth.value = Math.floor(width);
  });
  resizeObserver.observe(body.value);
}

function showNote(text: string, error: boolean): void {
  clearTimeout(noteTimer);
  note.value = { text, error };
  noteTimer = setTimeout(() => { note.value = null; }, error ? 8_000 : 5_000);
}

function toggleDraw(): void {
  drawing.value = !drawing.value && liveReady.value;
}

async function deleteMark(id: string): Promise<void> {
  if (deletingMarkIds.value.has(id)) return;
  deletingMarkIds.value = new Set([...deletingMarkIds.value, id]);
  try {
    await live.deleteMark(id);
  } catch {
    showNote("Could not delete the mark. Try again.", true);
  } finally {
    const rest = new Set(deletingMarkIds.value);
    rest.delete(id);
    deletingMarkIds.value = rest;
    if (highlightedMarkId.value === id) highlightedMarkId.value = null;
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Drops the picture that waits for a yes, from main's staging. */
function discardCapture(): void {
  const waiting = capture.value;
  capture.value = null;
  sendError.value = "";
  if (waiting) void Promise.resolve(desktopIpc.room?.discardAttachment?.(waiting.room, waiting.uploadId)).catch(() => undefined);
}

/**
 * Takes a picture of the card, with its marks, and shows it. Nothing is posted
 * until the person says yes (`confirmSend`). The window only has the pixels
 * that are on screen, so the card is scrolled into view first, and the picture
 * is cut to where the card, the window and every box that clips the card
 * overlap. That keeps the composer, which lies outside the message list, out of
 * a card that is taller than the list.
 */
async function sendToThread(): Promise<void> {
  const room = liveRoom.value;
  const captureMarkup = desktopIpc.room?.captureDemoMarkup;
  const target = clip.value;
  if (sendPhase.value !== "idle" || !sendThreadReply || !props.threadRootId || !room || !captureMarkup || !target) return;
  const run = ++sendRun;
  const current = () => run === sendRun;
  clearTimeout(noteTimer);
  note.value = null;
  discardCapture();
  sendPhase.value = "capturing";
  let uploadId: string | null = null;
  try {
    // Leaving draw mode also closes an unsaved pin note, which should not be in the picture.
    drawing.value = false;
    highlightedMarkId.value = null;
    await nextTick();
    target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    await nextFrame();
    await nextFrame();
    if (!current()) return;
    const box = target.getBoundingClientRect();
    const { rect, complete } = visibleCaptureRect(
      { x: box.left, y: box.top, width: box.width, height: box.height },
      [viewportBox(window.innerWidth, window.innerHeight), ...elementClippingBoxes(target)],
    );
    if (!rect) throw new Error("The demo is not on screen.");
    const staged = await captureMarkup(room, rect, markupFileName(props.fileName));
    uploadId = staged.uploadId;
    if (!current()) return;
    capture.value = { room, uploadId, previewDataUrl: staged.previewDataUrl, partial: !complete };
    uploadId = null;
    sendError.value = "";
    sendPhase.value = "review";
  } catch (error) {
    if (current()) showNote(ipcErrorText(error, "Could not take the picture. Try again."), true);
  } finally {
    // A picture that was taken but is not waiting for a yes is of no use.
    if (uploadId) void Promise.resolve(desktopIpc.room?.discardAttachment?.(room, uploadId)).catch(() => undefined);
    if (current() && sendPhase.value === "capturing") sendPhase.value = "idle";
  }
}

/** The person said yes to the picture: post it as a reply in the demo's thread. */
async function confirmSend(): Promise<void> {
  const reply = sendThreadReply;
  const waiting = capture.value;
  const threadRoot = props.threadRootId;
  if (sendPhase.value !== "review" || !reply || !waiting || !threadRoot) return;
  const run = sendRun;
  const current = () => run === sendRun;
  sendPhase.value = "sending";
  sendError.value = "";
  try {
    const accepted = await reply(
      threadRoot,
      markupReplyText(props.fileName, live.marks.value.length),
      [{ upload_id: waiting.uploadId }],
    );
    if (!current()) return;
    if (!accepted) {
      sendError.value = "Could not send the picture. Try again.";
      sendPhase.value = "review";
      return;
    }
    // The message owns the picture now.
    capture.value = null;
    sendPhase.value = "idle";
    showNote("Sent to the thread.", false);
  } catch (error) {
    if (!current()) return;
    sendError.value = ipcErrorText(error, "Could not send the picture. Try again.");
    sendPhase.value = "review";
  }
}

function cancelSend(): void {
  if (sendPhase.value !== "review") return;
  discardCapture();
  sendPhase.value = "idle";
}

function observe(): void {
  observer?.disconnect();
  if (!card.value) return;
  observer = new IntersectionObserver(
    (entries) => {
      if (deactivated) return;
      intersecting = entries[entries.length - 1]?.isIntersecting ?? false;
      syncOnScreen();
    },
    { root: outermostScroller(card.value), rootMargin: "160px 0px" },
  );
  observer.observe(card.value);
}

onMounted(() => {
  document.addEventListener("focusout", noteFocusOut, true);
  document.addEventListener("visibilitychange", syncOnScreen);
  observe();
  observeWidth();
});

// Moved out of the document, the webview's guest is destroyed and main ends its
// lease. The card is not on screen then; coming back starts a fresh lease.
onDeactivated(() => {
  deactivated = true;
  observer?.disconnect();
  intersecting = false;
  onScreen = false;
  const wasRunning = status.value === "waiting" || status.value === "starting" || status.value === "running";
  stopRun();
  if (wasRunning) status.value = "idle";
});

onActivated(() => {
  if (!deactivated) return;
  deactivated = false;
  observe();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  resizeObserver?.disconnect();
  clearTimeout(noteTimer);
  document.removeEventListener("focusout", noteFocusOut, true);
  document.removeEventListener("visibilitychange", syncOnScreen);
  stopRun();
});
</script>
