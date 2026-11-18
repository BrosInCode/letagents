<template>
  <section
    ref="root"
    class="room-tab-page room-page-view"
    :aria-label="page.title"
    :data-status="status"
    :data-testid="`room-page-view-${page.id}`"
  >
    <webview
      v-if="lease"
      :key="lease.url"
      ref="view"
      class="room-page-webview"
      :partition="lease.partition"
      :src="lease.url"
      @dom-ready="onViewReady"
      @render-process-gone="onViewGone"
      @did-fail-load="onLoadFailed"
    />
    <div v-if="status !== 'running'" class="room-page-status" :role="status === 'loading' ? 'status' : 'alert'">
      <p>{{ statusText }}</p>
      <button v-if="status !== 'loading'" class="ghost-button" type="button" data-testid="room-page-retry" @click="start">Try again</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { DesktopRoomPage, DesktopRoomPageEvent, DesktopRoomPageLease } from "../../../../../../electron/ipc-types";
import { desktopIpc } from "../../../../ipc";
import { pageThemeModeOf } from "./room-pages";

type PageStatus = "loading" | "running" | "failed" | "stopped";

const props = defineProps<{
  roomIdentifier: string;
  page: DesktopRoomPage;
  /** This page's tab is the room's active tab. */
  active: boolean;
}>();

const root = ref<HTMLElement | null>(null);
const view = ref<HTMLElement | null>(null);
const lease = ref<DesktopRoomPageLease | null>(null);
const status = ref<PageStatus>("loading");
const errorText = ref("");
const stoppedReason = ref<DesktopRoomPageEvent["reason"]>("crashed");
let generation = 0;
let stopEvents: (() => void) | null = null;
let colorQuery: MediaQueryList | null = null;

const statusText = computed(() => {
  if (status.value === "loading") return `Opening ${props.page.title}…`;
  if (status.value === "failed") return errorText.value || "This page could not be opened.";
  if (stoppedReason.value === "unresponsive") return "This page stopped responding, so it was closed.";
  if (stoppedReason.value === "overloaded") return "This page sent too many events, so it was closed.";
  return "This page closed unexpectedly.";
});

/** Ends the current run: the webview goes, and main frees the lease. */
function stopRun(): void {
  generation += 1;
  const current = lease.value;
  lease.value = null;
  if (current) void desktopIpc.pages?.release(current.url).catch(() => undefined);
}

async function start(): Promise<void> {
  stopRun();
  const run = generation;
  status.value = "loading";
  errorText.value = "";
  const prepare = desktopIpc.pages?.prepare;
  if (!prepare) {
    status.value = "failed";
    errorText.value = "Update LetAgents to open room pages.";
    return;
  }
  try {
    const next = await prepare(props.roomIdentifier, props.page.id);
    if (run !== generation) {
      void desktopIpc.pages?.release(next.url).catch(() => undefined);
      return;
    }
    lease.value = next;
    syncVisible();
  } catch (error) {
    if (run !== generation) return;
    status.value = "failed";
    errorText.value = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "";
  }
}

// A webview that was removed can still report late; only the current one counts.
function ownsEvent(event: Event): boolean {
  return lease.value !== null && event.target === view.value;
}

function onViewReady(event: Event): void {
  if (ownsEvent(event)) status.value = "running";
}

function onViewGone(event: Event): void {
  if (!ownsEvent(event)) return;
  stoppedReason.value = "crashed";
  status.value = "stopped";
}

function onLoadFailed(event: Event): void {
  // -3 is a load cut short on purpose, as when the webview is removed.
  const { errorCode, isMainFrame } = event as Event & { errorCode?: number; isMainFrame?: boolean };
  if (!ownsEvent(event) || !isMainFrame || errorCode === -3) return;
  status.value = "failed";
  errorText.value = "This page could not be opened.";
}

/**
 * Main lets only the page in the active tab, in a window the person can see,
 * open links, copy or ask for a confirm sheet.
 */
function syncVisible(): void {
  const current = lease.value;
  if (!current) return;
  const visible = props.active && document.visibilityState === "visible";
  void desktopIpc.pages?.setVisible(current.url, visible).catch(() => undefined);
}

/** Pages follow the light or dark mode the app draws this tab in. */
function syncTheme(): void {
  const element = root.value;
  if (!element) return;
  const mode = pageThemeModeOf(getComputedStyle(element).colorScheme || "", Boolean(colorQuery?.matches));
  void desktopIpc.pages?.setTheme(mode).catch(() => undefined);
}

onMounted(() => {
  stopEvents = desktopIpc.pages?.onEvent((event) => {
    if (event.type !== "stopped" || event.url !== lease.value?.url) return;
    stoppedReason.value = event.reason;
    status.value = "stopped";
    // Main already ended the lease; the webview goes with it.
    lease.value = null;
  }) ?? null;
  colorQuery = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  colorQuery?.addEventListener("change", syncTheme);
  syncTheme();
  document.addEventListener("visibilitychange", syncVisible);
  void start();
});

watch(() => props.active, syncVisible);

// A new version (an agent's update, or a rollback) opens in place of the old one.
watch(() => JSON.stringify([props.roomIdentifier, props.page.id, props.page.version]), () => { void start(); });

onBeforeUnmount(() => {
  stopEvents?.();
  stopEvents = null;
  colorQuery?.removeEventListener("change", syncTheme);
  document.removeEventListener("visibilitychange", syncVisible);
  stopRun();
});
</script>

<style scoped>
.room-page-view {
  position: relative;
  display: grid;
  padding: 0;
  overflow: hidden;
}

.room-page-webview {
  grid-area: 1 / 1;
  width: 100%;
  height: 100%;
  border: 0;
}

.room-page-status {
  grid-area: 1 / 1;
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 12px;
  padding: 24px;
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 0.88rem;
  text-align: center;
}

.room-page-status p {
  max-width: 420px;
  margin: 0;
}

.room-page-status .ghost-button {
  min-height: 34px;
  font-size: 0.82rem;
}
</style>
