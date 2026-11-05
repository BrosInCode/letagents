<template>
  <section
    ref="card"
    class="room-inline-demo"
    :class="{ 'is-live': liveLayout, 'is-capturing': capturing, 'is-drawing': drawing }"
    :style="liveEnabled ? { '--live-self': live.viewerColor.value } : undefined"
    :aria-label="`Interactive demo ${fileName}`"
    @keydown="onCardKey"
  >
    <header class="room-inline-demo-header" :class="{ 'is-live-head': liveEnabled }">
      <FileCode class="room-inline-demo-icon" :size="16" aria-hidden="true" />
      <span class="room-inline-demo-title">
        <strong :title="fileName">{{ fileName }}</strong>
        <small
          v-if="liveReady"
          class="live-demo-status"
          :class="[`is-${statusLine.tone}`, { 'is-task': pinning }]"
          role="status"
        >
          <i class="live-demo-status-dot" aria-hidden="true"></i>
          <!-- In Pin mode the line is the instruction only, so it fits. -->
          <span v-if="!pinning">{{ statusLine.label }}</span>
          <span v-if="statusHint" class="live-demo-status-hint">{{ pinning ? statusHint : `· ${statusHint}` }}</span>
        </small>
        <small v-else title="Runs in a locked view on this computer. It cannot load web pages or reach your LetAgents data.">Interactive demo · locked</small>
      </span>
      <template v-if="liveEnabled">
        <LiveDemoFaces
          v-if="liveReady"
          :people="live.people.value"
          :self-cid="live.selfCid.value"
          @find="findPerson"
        />
        <LiveDemoTools
          :ready="liveReady"
          :can-mark="canMark"
          :pinning="pinning"
          :drawing="drawing"
          :mark-count="markCount"
          :can-send="canSend"
          :send-busy="sendPhase !== 'idle' || !statusLine.canMark"
          :open-pop="openPop"
          @pin="togglePin"
          @draw="toggleDraw"
          @send="sendToThread"
          @toggle-pop="togglePop"
        />
      </template>
      <template v-else>
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
      </template>
    </header>
    <LiveDemoPopover
      :open="openPop === 'marks' && liveReady"
      :anchor="popAnchor('marks')"
      :container="card"
      label="Marks on this demo"
      @close="closePop"
    >
      <LiveDemoMarks
        :marks="live.marks.value"
        :pending="live.pending.value"
        :is-own="live.isOwnMark"
        :self-color="live.viewerColor.value"
        :busy="deleting"
        :now="marksNow"
        @highlight="highlightMark"
        @delete="deleteWithUndo([$event])"
        @cancel-pending="cancelPendingWithUndo"
        @clear-mine="clearMine"
      />
    </LiveDemoPopover>
    <LiveDemoPopover
      :open="openPop === 'send' && Boolean(capture)"
      :anchor="popAnchor('send')"
      :container="card"
      label="Send a picture to the thread"
      extra-class="is-send"
      @close="cancelSend"
    >
      <LiveDemoSendPanel
        v-if="capture"
        :preview-url="capture.previewDataUrl"
        :partial="capture.partial"
        :mark-count="capture.markCount"
        :notes="capture.notes"
        :sending="sendPhase === 'sending'"
        :error="sendError"
        @confirm="confirmSend"
        @cancel="cancelSend"
      />
    </LiveDemoPopover>
    <LiveDemoPopover
      :open="openPop === 'more'"
      :anchor="popAnchor('more')"
      :container="card"
      label="More"
      role="menu"
      extra-class="is-menu"
      @close="closePop"
    >
      <button type="button" role="menuitem" data-autofocus @click="closePop(); reload()">
        <RotateCw :size="14" aria-hidden="true" />
        <span>Reload demo</span>
      </button>
      <button type="button" role="menuitem" :disabled="expanding" @click="closePop(); expand()">
        <Maximize2 :size="14" aria-hidden="true" />
        <span>Open larger</span>
      </button>
      <p class="live-demo-menu-info" title="Runs in a locked view on this computer. It cannot load web pages or reach your LetAgents data.">
        <Lock :size="14" aria-hidden="true" />
        <span>Runs locked</span>
        <small>No web, no data</small>
      </p>
    </LiveDemoPopover>
    <p v-if="expandError" class="room-inline-demo-note" role="alert">{{ expandError }}</p>
    <div
      ref="clip"
      class="room-inline-demo-clip"
      :class="{ 'is-clipped': clipState?.clipped }"
      :style="{ ...(clipState?.clipped ? { height: `${clipState.visibleHeight + 2}px` } : {}), '--live-lift': `${liveLift}px` }"
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
          ref="overlay"
          :session="live"
          :width="frameWidth"
          :height="frameHeight"
          :scale="scale"
          :drawing="drawing"
          :pinning="pinning"
          :capturing="capturing"
          :highlight-mark-id="highlightedMarkId"
          :visible-height="clipState?.clipped ? clipState.visibleHeight : frameHeight"
          @exit="exitDraw"
          @cancel-pin="endPin"
          @pinned="endPin"
          @delete="deleteWithUndo([$event])"
          @cancel-pending="cancelPendingWithUndo"
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
      <div v-if="flashing" class="live-demo-flash" aria-hidden="true" @animationend="flashing = false"></div>
      <Transition name="live-demo-note">
        <p
          v-if="note"
          :key="note.id"
          class="room-inline-demo-live-note"
          :class="{ 'is-error': note.error, 'has-action': Boolean(note.action) }"
          :role="note.error ? 'alert' : 'status'"
        >
          <span>{{ note.text }}</span>
          <button v-if="note.action" type="button" @click="runNoteAction">{{ note.action.label }}</button>
        </p>
      </Transition>
      <!-- The drawing bar floats at the bottom of what the card shows, so a tall demo cannot hide it. -->
      <Transition name="live-demo-palette">
        <div v-if="drawing && !capturing" class="live-demo-palette" role="toolbar" aria-label="Drawing tools">
          <span class="live-demo-palette-me" title="Your ink colour"><i aria-hidden="true"></i>You</span>
          <span class="live-demo-palette-sep" aria-hidden="true"></span>
          <button
            class="live-demo-palette-button"
            type="button"
            :disabled="!canUndo"
            title="Undo your last mark (⌘Z)"
            @click="undoLast"
          >
            <Undo2 :size="15" aria-hidden="true" />
            <span>Undo</span>
          </button>
          <span class="live-demo-palette-sep" aria-hidden="true"></span>
          <button class="live-demo-palette-done" type="button" title="Stop drawing (Esc)" @click="exitDraw">Done</button>
        </div>
      </Transition>
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
import { computed, inject, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { FileCode, Lock, Maximize2, RotateCw, Undo2 } from "@lucide/vue";
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
import { roomThreadOpenKey, roomThreadReplyKey } from "../../../../composables/roomThreadReply";
import {
  LIVE_FALLBACK_SCALE,
  LIVE_MIN_FRAME_WIDTH,
  liveClip,
  liveFrameHeight,
  liveLayoutReady,
  liveReportedHeight,
  liveScale,
} from "./live-demo/geometry";
import { liveStatusLine } from "./live-demo/people";
import {
  elementClippingBoxes,
  markupFileName,
  markupNotes,
  markupReplyText,
  viewportBox,
  visibleCaptureRect,
  type MarkupNotes,
  type NoteMark,
} from "./live-demo/markup";
import { markBody, type MarkBody } from "./live-demo/pending-marks";
import { liveDemoKey, type DemoMark } from "./live-demo/protocol";
import { liveDemoAvailable, useLiveDemo } from "./live-demo/session";
import { createWidthSync, type WidthSync } from "./live-demo/width-sync";
import LiveDemoFaces from "./live-demo/LiveDemoFaces.vue";
import LiveDemoMarks from "./live-demo/LiveDemoMarks.vue";
import LiveDemoOverlay from "./live-demo/LiveDemoOverlay.vue";
import LiveDemoPopover from "./live-demo/LiveDemoPopover.vue";
import LiveDemoSendPanel from "./live-demo/LiveDemoSendPanel.vue";
import LiveDemoTools, { type LiveDemoPop } from "./live-demo/LiveDemoTools.vue";

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
// A live card waits this long after the page loaded for its scaled height; a page that sends none is shown anyway.
const HEIGHT_WAIT_MS = 3_000;

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
// Main's first height for this run. It is already scaled, so it is the one to wait for.
const heightReported = ref(false);
const layoutReady = computed(() => liveLayoutReady({
  liveLayout: liveLayout.value,
  scaleApplied: appliedScale.value !== null,
  heightReported: heightReported.value,
}));
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
// "Saved 2 marks", or why a mark of yours was given up.
const stopNotices = live.onNotice((notice) => showNote(notice.text, notice.error));
// The tools and overlay need a running demo that has its scale and its scaled height.
const liveReady = computed(() => liveEnabled.value && status.value === "running" && layoutReady.value && frameWidth.value > 0);
const statusLine = computed(() => liveStatusLine(live.status.value, live.joinError.value, live.statusReason.value));
const drawing = ref(false);
// The next click on the demo places a pin; then the card goes back to what it was doing.
const pinning = ref(false);
const canMark = computed(() => liveReady.value && statusLine.value.canMark);
const statusHint = computed(() => pinning.value ? "Click where the note goes · Esc to cancel" : statusLine.value.hint);
const openPop = ref<LiveDemoPop | null>(null);
const overlay = ref<InstanceType<typeof LiveDemoOverlay> | null>(null);
const highlightedMarkId = ref<string | null>(null);
const deleting = ref(false);
// The Marks list's ages are read when it opens.
const marksNow = ref(Date.now());
const ownMarks = computed(() => live.marks.value.filter((mark) => live.isOwnMark(mark)));
const markCount = computed(() => live.marks.value.length + live.pending.value.length);
const canUndo = computed(() => live.pending.value.length > 0 || ownMarks.value.length > 0);
let noteSeq = 0;
const note = ref<{ id: number; text: string; error: boolean; action?: { label: string; run: () => void } } | null>(null);
// Send to thread: capture, then the person looks at the picture ("review"), then it is sent.
const sendPhase = ref<"idle" | "capturing" | "review" | "sending">("idle");
const capture = ref<{
  room: string;
  uploadId: string;
  previewDataUrl: string | null;
  partial: boolean;
  markCount: number;
  notes: MarkupNotes;
} | null>(null);
// While the picture is taken: pointers, the fade and the notes stay out of it.
const capturing = ref(false);
const flashing = ref(false);
const sendError = ref("");
const sendThreadReply = inject(roomThreadReplyKey, null);
const openThread = inject(roomThreadOpenKey, null);
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
      // The page would show at the wrong size until main has laid it out and sent its height.
      return layoutReady.value ? "" : "Starting the demo…";
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
let heightWaitTimer: ReturnType<typeof setTimeout> | undefined;
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
  capturing.value = false;
  drawing.value = false;
  pinning.value = false;
  openPop.value = null;
  highlightedMarkId.value = null;
  live.stop();
  widthSync?.close();
  widthSync = null;
  appliedScale.value = null;
  heightReported.value = false;
  clearTimeout(heightWaitTimer);
  heightWaitTimer = undefined;
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
  if (liveLayout.value && !heightReported.value) {
    heightWaitTimer ??= setTimeout(() => { heightReported.value = true; }, HEIGHT_WAIT_MS);
  }
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
      heightReported.value = true;
      clearTimeout(heightWaitTimer);
      heightWaitTimer = undefined;
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
    // Unrounded, so main's zoom fills exactly LIVE_DEMO.width CSS px.
    frameWidth.value = width;
  });
  resizeObserver.observe(body.value);
}

/**
 * A short line over the demo. One with an action (Undo, Open thread) stays 6 s,
 * and a plain line does not push it out; an error does.
 */
function showNote(text: string, error: boolean, action?: { label: string; run: () => void }, answersClick = false): void {
  // A direct answer to a click is news the person waits for, so it may take the place of an Undo.
  if (!error && !action && !answersClick && note.value?.action) return;
  clearTimeout(noteTimer);
  note.value = { id: ++noteSeq, text, error, action };
  noteTimer = setTimeout(() => { note.value = null; }, error ? 8_000 : action ? 6_000 : 4_000);
}

function runNoteAction(): void {
  const action = note.value?.action;
  clearTimeout(noteTimer);
  note.value = null;
  action?.run();
}

/** Closes the open panel. The Send panel drops its picture, but stays while its reply is on the way. */
function closePop(): void {
  highlightedMarkId.value = null;
  if (openPop.value === "send") cancelSend();
  else openPop.value = null;
}

function togglePop(pop: LiveDemoPop): void {
  if (openPop.value === pop) {
    closePop();
    return;
  }
  // A picture that waits for a yes goes when another panel opens; one being sent keeps its panel.
  closePop();
  if (openPop.value === "send") return;
  if (pop === "marks") marksNow.value = Date.now();
  openPop.value = pop;
}

function popAnchor(pop: LiveDemoPop): HTMLElement | null {
  return card.value?.querySelector<HTMLElement>(`[data-pop="${pop}"]`) ?? null;
}

function toolButton(tool: "pin" | "draw"): HTMLElement | null {
  return card.value?.querySelector<HTMLElement>(`[data-tool="${tool}"]`) ?? null;
}

function togglePin(): void {
  if (pinning.value || !canMark.value) {
    pinning.value = false;
    return;
  }
  closePop();
  pinning.value = true;
}

function toggleDraw(): void {
  pinning.value = false;
  if (drawing.value) {
    exitDraw();
    return;
  }
  if (!canMark.value) return;
  closePop();
  drawing.value = true;
}

/** Leaves draw mode; the keyboard goes back to the Draw button, not to the page. */
function exitDraw(): void {
  pinning.value = false;
  drawing.value = false;
  void nextTick(() => toolButton("draw")?.focus({ preventScroll: true }));
}

/** The pin is placed or cancelled. In draw mode the drawing goes on; otherwise the keyboard goes back to the Pin button. */
function endPin(): void {
  pinning.value = false;
  if (!drawing.value) void nextTick(() => toolButton("pin")?.focus({ preventScroll: true }));
}

// While drawing, the bar (and a note) rise by how far the card runs past the bottom of the
// list, so a card taller than the window ("Show all") keeps Undo and Done in view.
const liveLift = ref(0);
let liftFrame = 0;
let liftScroller: HTMLElement | null = null;

function measureLift(): void {
  liftFrame = 0;
  const box = clip.value;
  if (!box || !liftScroller || !drawing.value) {
    liveLift.value = 0;
    return;
  }
  const c = box.getBoundingClientRect();
  const view = liftScroller.getBoundingClientRect();
  liveLift.value = Math.round(Math.max(0, Math.min(c.bottom - view.bottom, c.height - 80)));
}

function scheduleLift(): void {
  if (!liftFrame) liftFrame = requestAnimationFrame(measureLift);
}

function followScroll(on: boolean): void {
  liftScroller?.removeEventListener("scroll", scheduleLift);
  window.removeEventListener("resize", scheduleLift);
  liftScroller = on && card.value ? outermostScroller(card.value) : null;
  if (on) {
    liftScroller?.addEventListener("scroll", scheduleLift, { passive: true });
    window.addEventListener("resize", scheduleLift);
  }
  scheduleLift();
}

watch(drawing, (on) => followScroll(on));
watch([showAll, frameHeight], () => scheduleLift());

// Offline or refused: Pin and Draw are off, so their modes end too.
watch(canMark, (can) => {
  if (can) return;
  pinning.value = false;
  drawing.value = false;
});

/** A mark of yours below the clip cannot be seen: the card opens to show it. */
function highlightMark(id: string | null): void {
  highlightedMarkId.value = id;
  if (!id || !clipState.value?.clipped) return;
  const mark = live.marks.value.find((other) => other.id === id);
  if (!mark) return;
  const ys = mark.kind === "pin" ? [mark.at[1]] : mark.points.map((point) => point[1]);
  if (Math.min(...ys) * scale.value > clipState.value.visibleHeight - 24) showAll.value = true;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function putBack(bodies: readonly MarkBody[]): void {
  for (const body of bodies) live.queueMark(body);
}

/**
 * Deletes saved marks of yours; for 6 s, Undo puts them back (with `unsaved`,
 * marks of yours that were taken back before the server had them).
 */
async function deleteWithUndo(
  ids: readonly string[],
  options: { cleared?: boolean; unsaved?: readonly MarkBody[] } = {},
): Promise<void> {
  const unsaved = options.unsaved ?? [];
  if (deleting.value || ids.length + unsaved.length === 0) return;
  deleting.value = true;
  try {
    const gone: DemoMark[] = ids.length > 0 ? await live.deleteMarks(ids) : [];
    if (highlightedMarkId.value && ids.includes(highlightedMarkId.value)) highlightedMarkId.value = null;
    const bodies = [...gone.map(markBody), ...unsaved];
    const count = plural(bodies.length, "mark");
    const failed = ids.length - gone.length;
    const text = `${options.cleared ? "Cleared" : "Deleted"} ${count}${failed > 0 ? `. Could not delete ${plural(failed, "mark")}` : ""}`;
    showNote(text, false, { label: "Undo", run: () => putBack(bodies) });
  } catch (error) {
    if (unsaved.length > 0) putBack(unsaved);
    showNote(ipcErrorText(error, "Could not delete the mark. Try again."), true);
  } finally {
    deleting.value = false;
  }
}

function cancelPendingWithUndo(key: number): void {
  const body = live.cancelPending(key);
  if (body) showNote("Deleted 1 mark", false, { label: "Undo", run: () => putBack([body]) });
}

/** Your marks that wait for the link go at once; the saved ones go one by one. */
function clearMine(): void {
  if (deleting.value) return;
  const unsaved = live.pending.value
    .map((entry) => live.cancelPending(entry.key))
    .filter((body): body is MarkBody => body !== null);
  void deleteWithUndo(ownMarks.value.map((mark) => mark.id), { cleared: true, unsaved });
}

/** ⌘Z in draw mode, or Undo on the drawing bar: your newest mark goes. */
function undoLast(): void {
  const waiting = live.pending.value;
  const last = waiting[waiting.length - 1];
  if (last) {
    cancelPendingWithUndo(last.key);
    return;
  }
  const newest = [...ownMarks.value].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0];
  if (newest) void deleteWithUndo([newest.id]);
}

/**
 * Shows the person's pointer and rings it: the card opens past its clip when
 * the pointer is below it, and the chat scrolls the pointer into view.
 */
async function findPerson(cid: string): Promise<void> {
  const name = live.people.value.find((person) => person.cid === cid)?.name ?? "This person";
  const at = overlay.value?.cursorAt(cid) ?? null;
  if (!at) {
    showNote(`${name} is not pointing at the demo now.`, false, undefined, true);
    return;
  }
  if (clipState.value?.clipped && at.y > clipState.value.visibleHeight - 24) {
    showAll.value = true;
    await nextTick();
  }
  scrollFrameYIntoView(at.y);
  overlay.value?.ping(cid);
}

/** Scrolls the chat (never the clip, which must not scroll) so a height in the demo is in view. */
function scrollFrameYIntoView(frameY: number): void {
  const frame = body.value;
  const scroller = card.value ? outermostScroller(card.value) : null;
  if (!frame || !scroller) {
    card.value?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return;
  }
  const y = frame.getBoundingClientRect().top + frameY;
  const view = scroller.getBoundingClientRect();
  if (y < view.top + 40 || y > view.bottom - 40) scroller.scrollBy({ top: y - (view.top + view.height / 2), behavior: "smooth" });
}

/** Keys work while the keyboard is in the card: P pins, D draws, ⌘Z undoes in draw mode, Escape closes. */
function onCardKey(event: KeyboardEvent): void {
  if (!liveReady.value || event.defaultPrevented) return;
  const target = event.target;
  if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]")) return;
  const key = event.key.toLowerCase();
  const command = event.metaKey || event.ctrlKey;
  if (key === "escape" && openPop.value) {
    event.preventDefault();
    closePop();
  } else if (command && key === "z" && !event.shiftKey && drawing.value) {
    event.preventDefault();
    undoLast();
  } else if (!command && !event.altKey && key === "p") {
    event.preventDefault();
    togglePin();
  } else if (!command && !event.altKey && key === "d") {
    event.preventDefault();
    toggleDraw();
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
  discardCapture();
  closePop();
  sendPhase.value = "capturing";
  let uploadId: string | null = null;
  try {
    // Leaving draw and pin mode also closes an unsaved pin note, which should not be in the picture.
    drawing.value = false;
    pinning.value = false;
    highlightedMarkId.value = null;
    // Other people's pointers, the fade and Show all stay out of the picture.
    capturing.value = true;
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
    // What the marks say, as they are in the picture: yours that are not saved yet show there too.
    const marks = [...live.marks.value, ...unsavedNoteMarks()];
    const staged = await captureMarkup(room, rect, markupFileName(props.fileName));
    uploadId = staged.uploadId;
    if (!current()) return;
    capture.value = {
      room,
      uploadId,
      previewDataUrl: staged.previewDataUrl,
      // The card's own clip cuts a tall demo too.
      partial: !complete || Boolean(clipState.value?.clipped),
      markCount: marks.length,
      notes: markupNotes(marks),
    };
    uploadId = null;
    sendError.value = "";
    sendPhase.value = "review";
    capturing.value = false;
    if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) flashing.value = true;
    openPop.value = "send";
  } catch (error) {
    if (current()) showNote(ipcErrorText(error, "Could not take the picture. Try again."), true);
  } finally {
    if (current()) capturing.value = false;
    // A picture that was taken but is not waiting for a yes is of no use.
    if (uploadId) void Promise.resolve(desktopIpc.room?.discardAttachment?.(room, uploadId)).catch(() => undefined);
    if (current() && sendPhase.value === "capturing") sendPhase.value = "idle";
  }
}

/** Your marks that are not saved yet, for the text that goes with the picture. */
function unsavedNoteMarks(): NoteMark[] {
  const name = ownMarks.value[0]?.author.name
    ?? live.people.value.find((person) => person.cid === live.selfCid.value)?.name
    ?? "You";
  const author = { accountId: live.viewerId.value ?? "self", name, color: live.viewerColor.value };
  return live.pending.value.map((entry): NoteMark => entry.body.kind === "pin"
    ? { kind: "pin", text: entry.body.text, author }
    : { kind: "stroke", author });
}

/** The person said yes to the picture: post it, with the marks as text, as a reply in the demo's thread. */
async function confirmSend(personNote: string): Promise<void> {
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
      markupReplyText(props.fileName, waiting.notes, personNote),
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
    openPop.value = null;
    const open = openThread;
    showNote("Sent to the thread", false, open ? { label: "Open thread", run: () => open(threadRoot) } : undefined);
  } catch (error) {
    if (!current()) return;
    sendError.value = ipcErrorText(error, "Could not send the picture. Try again.");
    sendPhase.value = "review";
  }
}

function cancelSend(): void {
  // While the reply is on its way the panel stays, so its answer (or its error) has a place.
  if (sendPhase.value === "sending") return;
  if (openPop.value === "send") openPop.value = null;
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
  stopNotices();
  followScroll(false);
  if (liftFrame) cancelAnimationFrame(liftFrame);
  observer?.disconnect();
  resizeObserver?.disconnect();
  clearTimeout(noteTimer);
  document.removeEventListener("focusout", noteFocusOut, true);
  document.removeEventListener("visibilitychange", syncOnScreen);
  stopRun();
});
</script>
