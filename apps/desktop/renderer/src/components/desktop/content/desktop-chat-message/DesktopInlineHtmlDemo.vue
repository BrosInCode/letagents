<template>
  <section ref="card" class="room-inline-demo" :aria-label="`Interactive demo ${fileName}`">
    <header class="room-inline-demo-header">
      <FileCode class="room-inline-demo-icon" :size="16" aria-hidden="true" />
      <span class="room-inline-demo-title">
        <strong :title="fileName">{{ fileName }}</strong>
        <small>Interactive demo · locked, no network requests</small>
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
    <p v-if="expandError" class="room-inline-demo-note" role="alert">{{ expandError }}</p>
    <div
      class="room-inline-demo-body"
      :style="{ height: `${frameHeight}px` }"
      @pointerdown.capture="notePointerDown"
    >
      <webview
        v-if="lease"
        :key="lease.url"
        ref="view"
        class="room-inline-demo-view"
        :partition="lease.partition"
        :src="lease.url"
        @dom-ready="markRunning"
        @render-process-gone="markStopped"
        @did-fail-load="onLoadFailed"
        @focus="onViewFocus"
        @blur="onViewBlur"
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
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { FileCode, Maximize2, RotateCw } from "@lucide/vue";
import type {
  DesktopInlineHtmlDemoEvent,
  DesktopInlineHtmlDemoLease,
} from "../../../../../../electron/ipc-types";
import {
  htmlDemoErrorText,
  inlineDemoFrameHeight,
  inlineDemoMayTakeFocus,
  withinInlineDemoFocusWindow,
} from "./attachments";
import { inlineDemoEvents } from "./inline-demo-events";
import { inlineDemoSlots, MAX_RUNNING_INLINE_DEMOS, type InlineDemoSlot } from "./inline-demo-slots";
import { desktopIpc } from "../../../../ipc/index";

const props = defineProps<{
  href: string;
  fileName: string;
  senderLabel?: string | null;
}>();

type DemoStatus = "idle" | "waiting" | "starting" | "running" | "stopped" | "error";

// Off screen for this long, a running demo is released; scrolling past one does not restart it.
const PAUSE_AFTER_OFF_SCREEN_MS = 15_000;

const card = ref<HTMLElement | null>(null);
const view = ref<HTMLElement | null>(null);
const status = ref<DemoStatus>("idle");
const lease = ref<DesktopInlineHtmlDemoLease | null>(null);
const errorText = ref("");
// Kept across pauses and reloads so the chat does not jump while the demo is away.
const contentHeight = ref<number | null>(null);
const expanding = ref(false);
const expandError = ref("");

const frameHeight = computed(() => inlineDemoFrameHeight(contentHeight.value));
const statusText = computed(() => {
  switch (status.value) {
    case "waiting":
      return `Waiting: ${MAX_RUNNING_INLINE_DEMOS} demos are running. This one starts when one stops.`;
    case "starting":
      return "Starting the demo…";
    case "stopped":
      return "This demo stopped responding.";
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
let stopEvents: (() => void) | null = null;
let slot: InlineDemoSlot | null = null;
// Raised whenever a run starts or ends, so a late answer from main is ignored.
let generation = 0;

function releaseLease(url: string): void {
  // Main also drops a lease when its guest is gone, so a failed release is not news.
  void Promise.resolve(desktopIpc.room?.releaseInlineHtmlDemo?.(url)).catch(() => undefined);
}

/** Ends the current run: gives back the slot and the lease and removes the webview. */
function stopRun(): void {
  generation++;
  clearTimeout(pauseTimer);
  pauseTimer = undefined;
  slot?.release();
  slot = null;
  stopEvents?.();
  stopEvents = null;
  const url = lease.value?.url;
  lease.value = null;
  if (url) releaseLease(url);
}

function requestRun(): void {
  const version = ++generation;
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
  status.value = "idle";
  if (onScreen) requestRun();
}

function markRunning(): void {
  if (status.value === "starting") status.value = "running";
}

function markStopped(): void {
  if (!lease.value) return;
  stopRun();
  status.value = "stopped";
}

function onLoadFailed(event: Event): void {
  // -3 is a load cut short on purpose, as when the webview is removed.
  const { errorCode, isMainFrame } = event as Event & { errorCode?: number; isMainFrame?: boolean };
  if (isMainFrame && errorCode !== -3) markStopped();
}

function handleDemoEvent(event: DesktopInlineHtmlDemoEvent): void {
  if (event.type === "height") {
    contentHeight.value = event.height;
    markRunning();
  } else {
    markStopped();
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

// A demo takes focus only when the person clicks it or tabs to it. The webview's
// focus event is the only sign that a guest page grabbed focus, so it is judged here.
let pointerDownAt: number | null = null;
let tabKeyAt: number | null = null;
let holdsFocus = false;
let leftFocus: { element: HTMLElement; at: number } | null = null;

function notePointerDown(): void {
  pointerDownAt = performance.now();
}

function noteKeyDown(event: KeyboardEvent): void {
  if (event.key === "Tab") tabKeyAt = performance.now();
}

function noteFocusOut(event: FocusEvent): void {
  if (event.target instanceof HTMLElement && event.target !== view.value) {
    leftFocus = { element: event.target, at: performance.now() };
  }
}

function onViewFocus(): void {
  const now = performance.now();
  if (inlineDemoMayTakeFocus({ now, pointerDownAt, tabKeyAt, holdsFocus })) {
    holdsFocus = true;
    return;
  }
  view.value?.blur();
  if (leftFocus?.element.isConnected && withinInlineDemoFocusWindow(now, leftFocus.at)) {
    leftFocus.element.focus({ preventScroll: true });
  }
}

function onViewBlur(): void {
  // Switching away from the window leaves the webview as the active element; a
  // move to another element does not.
  if (document.activeElement !== view.value) holdsFocus = false;
}

watch(() => props.href, reload);

onMounted(() => {
  document.addEventListener("keydown", noteKeyDown, true);
  document.addEventListener("focusout", noteFocusOut, true);
  document.addEventListener("visibilitychange", syncOnScreen);
  if (!card.value) return;
  observer = new IntersectionObserver(
    (entries) => {
      intersecting = entries[entries.length - 1]?.isIntersecting ?? false;
      syncOnScreen();
    },
    { root: outermostScroller(card.value), rootMargin: "160px 0px" },
  );
  observer.observe(card.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  document.removeEventListener("keydown", noteKeyDown, true);
  document.removeEventListener("focusout", noteFocusOut, true);
  document.removeEventListener("visibilitychange", syncOnScreen);
  stopRun();
});
</script>
