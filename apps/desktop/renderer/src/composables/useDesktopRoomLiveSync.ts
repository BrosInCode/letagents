import { ref, watch, type ComputedRef, type Ref } from "vue";
import type { DesktopRoomAgentWork, DesktopRoomSnapshot, WorkerSnapshot } from "../../../electron/ipc-types";
import {
  applyRoomLiveMetadata,
  mergeRoomSnapshotMessages,
  roomSnapshotsMatch,
  snapshotMatchesRoom,
} from "../domain/desktop-room-snapshots";
import { normalizeRoomIdentifier } from "../domain/sidebar-rooms";
import { shouldSkipPollTick } from "../domain/visibility-polling";
import { desktopIpc } from "../ipc/index.js";

interface DesktopRoomLiveSyncOptions {
  accountId: ComputedRef<string | null>;
  rootRoomSnapshot: Ref<DesktopRoomSnapshot | null>;
  selectedRoomIdentifier: ComputedRef<string | null>;
  selectedSnapshot: Ref<DesktopRoomSnapshot | null>;
  sessionGeneration: Ref<number>;
  workers: Ref<WorkerSnapshot[]>;
}

/**
 * Cadence of the periodic bounded room refresh. Presence/participants/
 * board-settings freshness is not latency-critical (everything actionable is
 * event-fed after PR #823), so a 15s tick is plenty and cuts steady-state room
 * traffic to a handful of light requests instead of a full ~10-request snapshot
 * rebuild every 5s.
 */
const PERIODIC_METADATA_REFRESH_INTERVAL_MS = 15_000;

export function useDesktopRoomLiveSync(options: DesktopRoomLiveSyncOptions) {
  let liveMetadataRefreshTimer: number | null = null;
  let liveMetadataRefreshInterval: number | null = null;
  let liveMetadataRefreshIntervalRoomIdentifier: string | null = null;
  let liveMetadataRefreshSequence = 0;
  let periodicMetadataRefreshInFlight = false;
  let roomAgentWorkCursor: string | null = null;
  let roomAgentWorkRefreshSequence = 0;
  let roomAgentWorkInFlightSequence: number | null = null;
  let roomAgentWorkInvalidationPending = false;
  let roomAgentWorkInvalidationQueued = false;
  let roomAgentWorkTrailingRefresh = false;
  const roomAgentWork = ref<DesktopRoomAgentWork[]>([]);
  const roomAgentWorkStatus = ref<"idle" | "loading" | "ready" | "stale" | "error" | "unavailable">("idle");
  const roomAgentWorkTruncated = ref(false);

  function clearSelectedRoomAgentWork(
    status: "idle" | "error" | "unavailable" = "idle",
  ): void {
    roomAgentWorkRefreshSequence += 1;
    roomAgentWorkInFlightSequence = null;
    roomAgentWorkInvalidationPending = false;
    roomAgentWorkInvalidationQueued = false;
    roomAgentWorkTrailingRefresh = false;
    roomAgentWorkCursor = null;
    roomAgentWork.value = [];
    roomAgentWorkTruncated.value = false;
    roomAgentWorkStatus.value = status;
  }

  function roomAgentWorkRequestIsCurrent(
    refreshSequence: number,
    roomIdentifier: string,
    sessionGeneration: number,
    accountId: string,
  ): boolean {
    return refreshSequence === roomAgentWorkRefreshSequence
      && sessionGeneration === options.sessionGeneration.value
      && accountId === options.accountId.value
      && normalizeRoomIdentifier(roomIdentifier) === normalizeRoomIdentifier(options.selectedRoomIdentifier.value);
  }

  async function refreshSelectedRoomAgentWork(): Promise<void> {
    const roomIdentifier = options.selectedRoomIdentifier.value;
    const accountId = options.accountId.value;
    if (!roomIdentifier || !accountId) {
      clearSelectedRoomAgentWork();
      return;
    }
    if (!desktopIpc.room.pollAgentWork) {
      clearSelectedRoomAgentWork("unavailable");
      return;
    }
    if (roomAgentWorkInFlightSequence !== null) {
      if (roomAgentWorkInvalidationPending) roomAgentWorkTrailingRefresh = true;
      return;
    }

    roomAgentWorkInvalidationPending = false;

    const sessionGeneration = options.sessionGeneration.value;
    const refreshSequence = ++roomAgentWorkRefreshSequence;
    roomAgentWorkInFlightSequence = refreshSequence;
    if (!roomAgentWork.value.length) roomAgentWorkStatus.value = "loading";
    try {
      const result = await desktopIpc.room.pollAgentWork(roomIdentifier, roomAgentWorkCursor);
      if (!roomAgentWorkRequestIsCurrent(refreshSequence, roomIdentifier, sessionGeneration, accountId)) return;
      if (result.status === "ready") {
        roomAgentWorkCursor = result.response.cursor;
        if (result.response.changed) {
          roomAgentWork.value = result.response.snapshot.work;
          roomAgentWorkTruncated.value = result.response.snapshot.truncated;
        }
        roomAgentWorkStatus.value = "ready";
        return;
      }
      clearSelectedRoomAgentWork(result.status === "invalid" ? "error" : "unavailable");
    } catch {
      if (!roomAgentWorkRequestIsCurrent(refreshSequence, roomIdentifier, sessionGeneration, accountId)) return;
      roomAgentWorkStatus.value = roomAgentWork.value.length ? "stale" : "error";
    } finally {
      if (roomAgentWorkInFlightSequence === refreshSequence) {
        roomAgentWorkInFlightSequence = null;
      }
      if (
        roomAgentWorkTrailingRefresh
        && roomAgentWorkRequestIsCurrent(refreshSequence, roomIdentifier, sessionGeneration, accountId)
      ) {
        roomAgentWorkTrailingRefresh = false;
        roomAgentWorkInvalidationPending = true;
        scheduleRoomAgentWorkInvalidationRefresh();
      }
    }
  }

  function scheduleRoomAgentWorkInvalidationRefresh(): void {
    if (roomAgentWorkInvalidationQueued) return;
    roomAgentWorkInvalidationQueued = true;
    queueMicrotask(() => {
      roomAgentWorkInvalidationQueued = false;
      if (!roomAgentWorkInvalidationPending) return;
      if (shouldSkipPollTick({ hidden: Boolean(window.document?.hidden) })) return;
      void refreshSelectedRoomAgentWork().catch(() => undefined);
    });
  }

  function invalidateSelectedRoomAgentWork(roomIdentifier: string): void {
    if (
      !options.accountId.value
      || (
        normalizeRoomIdentifier(roomIdentifier) !== normalizeRoomIdentifier(options.selectedRoomIdentifier.value)
        && !snapshotMatchesRoom(options.selectedSnapshot.value, roomIdentifier)
      )
    ) return;
    roomAgentWorkInvalidationPending = true;
    scheduleRoomAgentWorkInvalidationRefresh();
  }

  watch(
    () => [
      normalizeRoomIdentifier(options.selectedRoomIdentifier.value),
      options.sessionGeneration.value,
      options.accountId.value,
    ] as const,
    () => clearSelectedRoomAgentWork(),
    { flush: "sync" },
  );

  function isStaleRefresh(
    refreshSequence: number,
    roomIdentifier: string,
    sessionGeneration: number,
  ): boolean {
    return (
      refreshSequence !== liveMetadataRefreshSequence
      || sessionGeneration !== options.sessionGeneration.value
      || normalizeRoomIdentifier(options.selectedRoomIdentifier.value) !== normalizeRoomIdentifier(roomIdentifier)
    );
  }

  /**
   * FULL snapshot refetch — the consistency/backfill path. Used by the debounced
   * one-shot (`scheduleLiveMetadataRefresh`) on SSE reconnect (`open`), rental
   * events, manual refresh, and missing-thread backfill. Because there is no SSE
   * replay, this stays a full rebuild so it can reconcile anything missed during
   * an outage. NOT used by the periodic interval tick.
   */
  async function refreshSelectedRoomSnapshotFromServer(): Promise<void> {
    const roomIdentifier = options.selectedRoomIdentifier.value;
    if (!roomIdentifier) return;
    const sessionGeneration = options.sessionGeneration.value;
    const refreshSequence = ++liveMetadataRefreshSequence;
    const [snapshot, nextWorkers] = await Promise.all([
      desktopIpc.room.getSnapshot(roomIdentifier),
      desktopIpc.workers.list().catch(() => options.workers.value),
    ]);
    if (isStaleRefresh(refreshSequence, roomIdentifier, sessionGeneration)) return;
    options.workers.value = nextWorkers;
    options.selectedSnapshot.value = mergeRoomSnapshotMessages(options.selectedSnapshot.value, snapshot);
    if (options.rootRoomSnapshot.value && roomSnapshotsMatch(options.rootRoomSnapshot.value, snapshot)) {
      options.rootRoomSnapshot.value = mergeRoomSnapshotMessages(options.rootRoomSnapshot.value, snapshot);
    }
  }

  /**
   * Periodic bounded refresh — the interval tick. Fetches the metadata
   * the server pushes no events for (focus rooms, participants, presence,
   * recent activity, board settings), the retained room-work replacement, and
   * the cheap local `workers.list()`, then
   * applies them onto the current snapshot without touching event-fed sections
   * (messages, tasks, GitHub events, artifacts, reasoning).
   *
   * In-flight guard: if the previous tick is still running, skip this one so a
   * slow poll cannot stack overlapping request bursts. The shared sequence
   * counter still discards any stale result whose room changed mid-flight or
   * that a later full refresh superseded.
   *
   * Visibility guard: skip the tick entirely while the window is hidden — the
   * interval keeps ticking (Chromium throttles it to ~1s) but a background
   * window has no reason to fan out metadata IPC. SSE keeps running while
   * hidden, so event-fed sections stay current; App.vue calls this directly on
   * foreground return for an immediate poll-only catch-up. This same guard is
   * why the exposed function is safe to call on visibilitychange: by then the
   * document is visible so the tick proceeds normally.
   */
  async function refreshSelectedRoomLiveMetadata(): Promise<void> {
    const roomIdentifier = options.selectedRoomIdentifier.value;
    if (!roomIdentifier) return;
    if (shouldSkipPollTick({ hidden: Boolean(window.document?.hidden) })) return;
    const roomAgentWorkRefresh = refreshSelectedRoomAgentWork();
    // The retained-work poll is independent of the older live-metadata bridge:
    // a stale preload may omit either optional binding without suppressing the
    // other resource or causing a full-snapshot fallback.
    if (!desktopIpc.room.getLiveMetadata || periodicMetadataRefreshInFlight) {
      await roomAgentWorkRefresh;
      return;
    }
    periodicMetadataRefreshInFlight = true;
    const sessionGeneration = options.sessionGeneration.value;
    const refreshSequence = ++liveMetadataRefreshSequence;
    try {
      const [metadata, nextWorkers] = await Promise.all([
        desktopIpc.room.getLiveMetadata?.(roomIdentifier),
        desktopIpc.workers.list().catch(() => options.workers.value),
      ]);
      if (!metadata || isStaleRefresh(refreshSequence, roomIdentifier, sessionGeneration)) return;
      options.workers.value = nextWorkers;
      options.selectedSnapshot.value = applyRoomLiveMetadata(options.selectedSnapshot.value, metadata);
      if (
        options.rootRoomSnapshot.value
        && snapshotMatchesRoom(options.rootRoomSnapshot.value, metadata.roomIdentifier)
      ) {
        options.rootRoomSnapshot.value = applyRoomLiveMetadata(options.rootRoomSnapshot.value, metadata);
      }
    } finally {
      periodicMetadataRefreshInFlight = false;
    }
    await roomAgentWorkRefresh;
  }

  function scheduleLiveMetadataRefresh(delayMs = 800): void {
    if (liveMetadataRefreshTimer) {
      window.clearTimeout(liveMetadataRefreshTimer);
    }
    liveMetadataRefreshTimer = window.setTimeout(() => {
      liveMetadataRefreshTimer = null;
      void refreshSelectedRoomSnapshotFromServer().catch(() => undefined);
    }, delayMs);
  }

  function clearLiveMetadataRefreshTimer(): void {
    if (!liveMetadataRefreshTimer) return;
    window.clearTimeout(liveMetadataRefreshTimer);
    liveMetadataRefreshTimer = null;
  }

  /**
   * Start (or keep) the periodic metadata interval for a room. Idempotent: if an
   * interval is already running for the same room it is left alone rather than
   * cleared and recreated — the every-message stream sync no longer resets the
   * countdown on each incoming message. A different room clears and restarts.
   */
  function startLiveMetadataRefreshInterval(roomIdentifier: string): void {
    if (
      liveMetadataRefreshInterval !== null
      && normalizeRoomIdentifier(liveMetadataRefreshIntervalRoomIdentifier) === normalizeRoomIdentifier(roomIdentifier)
    ) {
      return;
    }
    clearLiveMetadataRefreshInterval();
    liveMetadataRefreshIntervalRoomIdentifier = roomIdentifier;
    liveMetadataRefreshInterval = window.setInterval(() => {
      void refreshSelectedRoomLiveMetadata().catch(() => undefined);
    }, PERIODIC_METADATA_REFRESH_INTERVAL_MS);
  }

  function clearLiveMetadataRefreshInterval(): void {
    if (liveMetadataRefreshInterval === null) return;
    window.clearInterval(liveMetadataRefreshInterval);
    liveMetadataRefreshInterval = null;
    liveMetadataRefreshIntervalRoomIdentifier = null;
  }

  async function syncSelectedRoomStream(
    roomIdentifier: string | null,
    afterMessageId?: string | null,
  ): Promise<void> {
    if (!desktopIpc.room?.startStream) return;
    if (!roomIdentifier) {
      clearLiveMetadataRefreshInterval();
      clearSelectedRoomAgentWork();
      await desktopIpc.room.stopStream();
      return;
    }
    const latestMessageId = afterMessageId === undefined
      ? options.selectedSnapshot.value?.messages.at(-1)?.id || null
      : afterMessageId;
    const shouldRefreshRoomAgentWork = roomAgentWorkStatus.value === "idle";
    await desktopIpc.room.startStream(roomIdentifier, latestMessageId);
    startLiveMetadataRefreshInterval(roomIdentifier);
    if (shouldRefreshRoomAgentWork) void refreshSelectedRoomAgentWork();
  }

  return {
    clearLiveMetadataRefreshInterval,
    clearLiveMetadataRefreshTimer,
    clearSelectedRoomAgentWork,
    refreshSelectedRoomLiveMetadata,
    invalidateSelectedRoomAgentWork,
    roomAgentWork,
    roomAgentWorkStatus,
    roomAgentWorkTruncated,
    scheduleLiveMetadataRefresh,
    syncSelectedRoomStream,
  };
}
