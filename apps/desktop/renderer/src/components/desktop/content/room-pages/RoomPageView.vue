<template>
  <section
    ref="root"
    class="room-tab-page room-page-view"
    :aria-label="page.title"
    :data-status="status"
    :data-testid="`room-page-view-${page.id}`"
  >
    <!-- What changed in this page, drawn by the app, never by the page. -->
    <div v-if="banner" class="room-page-banner" role="status" data-testid="room-page-banner">
      <template v-if="banner.kind === 'updated'">
        <span>Updated by {{ banner.label }}</span>
        <button type="button" class="room-page-banner-link" :aria-expanded="changesOpen" @click="changesOpen = !changesOpen">See changes</button>
        <button v-if="canManage && banner.undoVersion" type="button" class="room-page-banner-link" data-testid="room-page-undo" :disabled="undoing" @click="undo(banner.undoVersion)">{{ undoing ? "Undoing…" : "Undo" }}</button>
        <button type="button" class="room-page-banner-close" aria-label="Dismiss" @click="dismiss">×</button>
      </template>
      <template v-else>
        <span>Version {{ banner.version }} waits for your approval</span>
        <button type="button" class="room-page-banner-link" data-testid="room-page-review" @click="review">Review</button>
      </template>
    </div>
    <ul v-if="banner?.kind === 'updated' && changesOpen" class="room-page-changes" data-testid="room-page-changes">
      <li v-for="line in changes" :key="line">{{ line }}</li>
    </ul>
    <p v-if="bannerError" class="room-page-banner-error" role="alert">{{ bannerError }}</p>
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
import { pageUpdateChanges, pendingPageVersion, previousLiveVersion, type PageGrantSheetState } from "./room-page-admin";
import { requestRoomPagesRefresh } from "./useRoomPages";
import type { DesktopRoomPageInfo } from "../../../../../../electron/ipc-types";

type PageStatus = "loading" | "running" | "failed" | "stopped";

const props = defineProps<{
  roomIdentifier: string;
  page: DesktopRoomPage;
  /** This page's tab is the room's active tab. */
  active: boolean;
  /** A room admin: may undo an update and review a waiting version. */
  canManage: boolean;
}>();

const emit = defineEmits<{ review: [sheet: PageGrantSheetState] }>();

const info = ref<DesktopRoomPageInfo | null>(null);
const changesOpen = ref(false);
const undoing = ref(false);
const bannerError = ref("");
const dismissedVersion = ref<number | null>(null);
let infoGeneration = 0;

function bannerKey(): string {
  return `letagents-desktop:room-page-banner:${props.roomIdentifier}:${props.page.id}`;
}

function readDismissed(): number | null {
  try {
    const value = Number(window.localStorage.getItem(bannerKey()));
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** The page's registry detail: who made this version, what came before, and what waits. */
async function loadInfo(): Promise<void> {
  const read = desktopIpc.pages?.info;
  const current = ++infoGeneration;
  dismissedVersion.value = readDismissed();
  if (!read) return;
  try {
    const next = await read(props.roomIdentifier, props.page.id);
    if (current === infoGeneration) info.value = next;
  } catch {
    // The banner is extra: the page runs without it.
    if (current === infoGeneration) info.value = null;
  }
}

const banner = computed(() => {
  const detail = info.value?.detail;
  if (!detail) return null;
  const pending = props.canManage ? pendingPageVersion(detail) : null;
  if (pending) return { kind: "pending" as const, version: pending.version, capabilities: pending.capabilities };
  const previous = previousLiveVersion(detail);
  const label = info.value?.updatedByLabel;
  if (!previous || !label || detail.currentVersion === null || dismissedVersion.value === detail.currentVersion) return null;
  return { kind: "updated" as const, label, undoVersion: previous.version };
});

const changes = computed(() => (info.value ? pageUpdateChanges(info.value.detail) : []));

function dismiss(): void {
  const version = info.value?.detail.currentVersion ?? null;
  if (version === null) return;
  dismissedVersion.value = version;
  changesOpen.value = false;
  try {
    window.localStorage.setItem(bannerKey(), String(version));
  } catch {
    // Only a convenience: the banner shows again next time.
  }
}

async function undo(version: number): Promise<void> {
  const setCurrent = desktopIpc.pages?.setCurrent;
  if (!setCurrent || undoing.value) return;
  undoing.value = true;
  bannerError.value = "";
  try {
    await setCurrent(props.roomIdentifier, props.page.id, version);
    changesOpen.value = false;
    requestRoomPagesRefresh();
    await loadInfo();
  } catch (error) {
    bannerError.value = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "The page could not be rolled back.";
  } finally {
    undoing.value = false;
  }
}

function review(): void {
  const current = banner.value;
  if (current?.kind !== "pending") return;
  emit("review", { pageId: props.page.id, title: props.page.title, version: current.version, capabilities: [...current.capabilities], mode: "approve" });
}

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
  void loadInfo();
});

watch(() => props.active, syncVisible);

// A new version (an agent's update, or a rollback) opens in place of the old one.
watch(() => JSON.stringify([props.roomIdentifier, props.page.id, props.page.version]), () => {
  void start();
  void loadInfo();
});
// A new version waiting for approval shows no new live version, so the list cannot tell: ask the registry.
watch(() => props.active, (active) => { if (active) void loadInfo(); });

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
  grid-template-rows: auto auto auto minmax(0, 1fr);
  padding: 0;
  overflow: hidden;
}

.room-page-banner {
  grid-row: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 34px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: 0.8rem;
}

.room-page-banner-link,
.room-page-banner-close {
  padding: 0;
  border: 0;
  background: none;
  color: var(--text);
  font: inherit;
  cursor: pointer;
}

.room-page-banner-link:disabled {
  color: var(--text-muted);
  cursor: default;
}

.room-page-banner-close {
  margin-left: auto;
  color: var(--text-secondary);
  font-size: 1rem;
}

.room-page-changes {
  grid-row: 2;
  margin: 0;
  padding: 8px 16px 10px 32px;
  border-bottom: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: 0.8rem;
}

.room-page-banner-error {
  grid-row: 3;
  margin: 0;
  padding: 6px 16px;
  color: var(--red-text);
  font-size: 0.8rem;
}

.room-page-webview {
  grid-area: 4 / 1;
  width: 100%;
  height: 100%;
  border: 0;
}

.room-page-status {
  grid-area: 4 / 1;
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
