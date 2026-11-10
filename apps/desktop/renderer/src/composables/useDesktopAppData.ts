import { activityUnread } from '../../../../../shared/ui/activity/unread';
import { computed, getCurrentScope, onScopeDispose, ref, toRaw, watch, type ComputedRef, type Ref } from "vue";
import type {
  DesktopAccountRoomEntry,
  DesktopAppInfo,
  DesktopAuthStatus,
  DesktopMcpInstallState,
  DesktopMcpInstallTargetId,
  DesktopRepoRoomSelection,
  DesktopRoomInfo,
  DesktopRoomMessage,
  DesktopRoomSnapshot,
  DesktopRoomStreamEvent,
  DesktopTaskSummary,
  DiagnosticsSnapshot,
  RepoStatus,
  WorkerSnapshot,
} from "../../../electron/ipc-types";
import type { RoomEntry, SidebarEntry } from "../components/desktop/types";
import { reuseUnchanged } from "../domain/reuse-unchanged";
import {
  appendSnapshotMessage,
  mergeDesktopRoomMessages,
  mergeRoomSnapshotMessages,
  messageReferencesMissingThreadContext,
  removeSnapshotLiveActivitySession,
  removeSnapshotReasoningSession,
  replaceSnapshotRoomArtifacts,
  roomSnapshotsMatch,
  snapshotMatchesRoom,
  upsertSnapshotLiveActivitySession,
  upsertSnapshotReasoningSession,
  upsertSnapshotGitHubEvent,
  upsertSnapshotRoomArtifact,
  upsertSnapshotTask,
} from "../domain/desktop-room-snapshots";
import { defaultMcpTargetSelection } from "../domain/mcp-install";
import { applySupervisedAgentsSupport } from "../domain/supervised-agents-support";
import { preserveRoomRepoStatistics } from "../domain/repo-status";
import { SelectedRoomSnapshotCache, withoutCachedPaint } from "./selected-room-snapshot-cache";
import { desktopIpc } from "../ipc/index.js";
import {
  normalizeRoomIdentifier,
  resolveAccountRoomAliasIdentifier,
  type RecentRootRoom,
  type RecentRootRoomKind,
} from "../domain/sidebar-rooms";

interface RememberRootRoomOptions {
  aliasIdentifiers?: readonly (string | null | undefined)[];
  displayName?: string | null;
  kind?: RecentRootRoomKind | null;
  rootPath?: string | null;
  meta?: string | null;
}

interface DesktopAppDataOptions {
  accountRooms: Ref<DesktopAccountRoomEntry[]>;
  activeEntry: Ref<SidebarEntry>;
  appInfo: Ref<DesktopAppInfo | null>;
  authStatus: Ref<DesktopAuthStatus | null>;
  currentParentRoom: ComputedRef<RoomEntry>;
  diagnostics: Ref<DiagnosticsSnapshot | null>;
  loading: Ref<boolean>;
  mcpInstallState: Ref<DesktopMcpInstallState | null>;
  reconcileActiveEntry: () => void;
  rememberRootRoomSnapshot: (
    snapshot: DesktopRoomSnapshot,
    options?: RememberRootRoomOptions,
  ) => void;
  recentRootRooms: Ref<RecentRootRoom[]>;
  repoStatus: Ref<RepoStatus | null>;
  resolveSelectedRoomIdentifier: (baseRootSnapshot: DesktopRoomSnapshot | null) => string | null;
  rootRoomSnapshot: Ref<DesktopRoomSnapshot | null>;
  scheduleLiveMetadataRefresh: (delayMs?: number) => void;
  sessionGeneration: Ref<number>;
  selectedMcpTargetIds: Ref<DesktopMcpInstallTargetId[]>;
  selectedRootRoomIdentifier: Ref<string | null>;
  selectedSnapshot: Ref<DesktopRoomSnapshot | null>;
  settingsAccountRooms: Ref<DesktopAccountRoomEntry[]>;
  deliveryRepairRetryMs?: number;
  streamBufferMaxBytes?: number;
  streamBufferMaxEvents?: number;
  snapshotTimeoutMs?: number;
  syncRoomStream: (roomIdentifier: string | null, afterMessageId?: string | null) => Promise<void>;
  workers: Ref<WorkerSnapshot[]>;
}

// One snapshot is about 90-190 KB; 8 rooms stay under about 1.5 MB and cover
// the set of rooms a person moves between in one session.
const selectedSnapshotCacheLimit = 8;
// A snapshot read returns the newest 150 messages plus thread ancestors, and
// live messages are appended to it. Keep only the newest page of a room.
const selectedSnapshotCacheMaxMessages = 200;
const defaultRoomSnapshotTimeoutMs = 15_000;
const defaultDeliveryRepairRetryMs = 500;
const maxDeliveryRepairRetryMs = 5_000;
const defaultStreamBufferMaxEvents = 256;
const defaultStreamBufferMaxBytes = 1024 * 1024;

interface PendingDeliveryRepairState {
  token: number;
  retryDelayMs: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

export function useDesktopAppData(options: DesktopAppDataOptions) {
  watch([
    () => options.authStatus.value?.authenticated ? options.authStatus.value.account?.id : null,
    () => options.authStatus.value?.apiUrl,
    () => options.sessionGeneration.value,
  ], ([account, apiUrl, generation]) => {
    activityUnread.setScope(account ? JSON.stringify([apiUrl, account, generation]) : null);
  }, { immediate: true, flush: "sync" });
  let selectedSnapshotRequestId = 0;
  const selectedSnapshotLoading = ref(false);
  const cachedSelectedSnapshots = new SelectedRoomSnapshotCache(
    selectedSnapshotCacheLimit,
    selectedSnapshotCacheMaxMessages,
  );
  /**
   * The cached snapshot painted for the selected room while its fresh read
   * runs, and the placeholder the uncached path shows instead. The first
   * fresh snapshot of the room replaces what came from the cache (see
   * mergeFreshSelectedSnapshot); changes made after the paint (stream
   * events, own sends) are kept exactly as without the cache.
   */
  let cachedPaint: {
    roomIdentifier: string;
    snapshot: DesktopRoomSnapshot;
    placeholder: DesktopRoomSnapshot;
  } | null = null;
  let nextSelectedSnapshotCacheAlias: string | null | undefined;
  let skipNextSelectedSnapshotCache = false;
  let streamReconcileGeneration = 0;
  let streamReconcileRoom: string | null = null;
  let activeStreamRoom: string | null = null;
  let activeActivityScope: string | null = null;
  let activeStreamToken = 0;
  let bufferedStreamEvents: DesktopRoomStreamEvent[] = [];
  let bufferedStreamEventBytes = 0;
  let streamBufferOverflow = false;
  const degradedStreamRooms = new Map<string, number>();
  const pendingVerifiedRecoveries = new Map<string, number>();
  // Recoveries not queued because the barrier read had not started yet.
  const skippedVerifiedRecoveries = new Map<string, number>();
  const pendingDeliveryRepairs = new Map<string, PendingDeliveryRepairState>();
  // The barrier token whose stream start is still awaited: its read has not
  // started yet, so every open the stream reports now precedes that read.
  let barrierAwaitingStream: number | null = null;
  let sameTaskSelectionRefresh: {
    key: string;
    base: DesktopRoomSnapshot | null;
    promise: Promise<void>;
  } | null = null;
  let artifactRefreshContext = 0;
  let artifactRefreshDisposed = false;
  let artifactRefresh: {
    context: number;
    roomIdentifier: string;
    streamGeneration: number;
    streamToken: number;
    invalidated: boolean;
  } | null = null;

  function invalidateArtifactRefresh(): void {
    artifactRefreshContext += 1;
    artifactRefresh = null;
  }

  watch([
    () => options.activeEntry.value.id,
    () => options.sessionGeneration.value,
    () => options.authStatus.value?.account?.id,
    () => options.authStatus.value?.apiUrl,
    () => normalizeRoomIdentifier(options.selectedSnapshot.value?.roomIdentifier),
  ], invalidateArtifactRefresh, { flush: "sync" });

  // Another account or server never sees this account's cached rooms.
  watch([
    () => options.authStatus.value?.authenticated ? options.authStatus.value.account?.id ?? null : null,
    () => options.authStatus.value?.apiUrl ?? null,
  ], () => clearSelectedSnapshotCache(), { flush: "sync" });

  // A room that left the account's room list (left, removed, archived or
  // deleted) is not painted from the cache again.
  watch(() => accountRoomKeys(options.accountRooms.value), (next, previous) => {
    if (!previous) return;
    const kept = new Set(next);
    cachedSelectedSnapshots.forget(previous.filter((key) => !kept.has(key)));
  }, { flush: "sync" });

  if (getCurrentScope()) onScopeDispose(() => {
    artifactRefreshDisposed = true;
    invalidateArtifactRefresh();
  });

  function sessionIsCurrent(generation: number): boolean {
    return generation === options.sessionGeneration.value;
  }

  function invalidateSession(): void {
    options.sessionGeneration.value += 1;
    selectedSnapshotRequestId += 1;
    clearSelectedSnapshotCache();
    clearPendingDeliveryRepairs();
  }

  function resetBufferedStreamEvents(): void {
    bufferedStreamEvents = [];
    bufferedStreamEventBytes = 0;
    streamBufferOverflow = false;
  }

  function serializedStreamEventBytes(event: DesktopRoomStreamEvent): number {
    try {
      return new TextEncoder().encode(JSON.stringify(event)).byteLength;
    } catch {
      return (options.streamBufferMaxBytes ?? defaultStreamBufferMaxBytes) + 1;
    }
  }

  function bufferStreamEvent(event: DesktopRoomStreamEvent): void {
    if (streamBufferOverflow) return;
    const bytes = serializedStreamEventBytes(event);
    if (
      bufferedStreamEvents.length >= (options.streamBufferMaxEvents ?? defaultStreamBufferMaxEvents)
      || bufferedStreamEventBytes + bytes > (options.streamBufferMaxBytes ?? defaultStreamBufferMaxBytes)
    ) {
      bufferedStreamEvents = [];
      bufferedStreamEventBytes = 0;
      streamBufferOverflow = true;
      return;
    }
    bufferedStreamEvents.push(event);
    bufferedStreamEventBytes += bytes;
  }

  function clearPendingDeliveryRepair(roomKey: string): void {
    const pending = pendingDeliveryRepairs.get(roomKey);
    if (pending?.retryTimer) clearTimeout(pending.retryTimer);
    pendingDeliveryRepairs.delete(roomKey);
  }

  function clearPendingDeliveryRepairs(): void {
    for (const roomKey of pendingDeliveryRepairs.keys()) clearPendingDeliveryRepair(roomKey);
  }

  function setPendingDeliveryRepair(roomIdentifier: string, token: number): void {
    const roomKey = normalizeRoomIdentifier(roomIdentifier);
    if (!roomKey) return;
    const existing = pendingDeliveryRepairs.get(roomKey);
    if (existing?.token === token) return;
    clearPendingDeliveryRepair(roomKey);
    pendingDeliveryRepairs.set(roomKey, {
      token,
      retryDelayMs: options.deliveryRepairRetryMs ?? defaultDeliveryRepairRetryMs,
      retryTimer: null,
    });
  }

  function schedulePendingDeliveryRepair(roomIdentifier: string, token: number): void {
    const roomKey = normalizeRoomIdentifier(roomIdentifier);
    const pending = roomKey ? pendingDeliveryRepairs.get(roomKey) : null;
    if (
      !roomKey
      || !pending
      || pending.token !== token
      || pending.retryTimer
      || normalizeRoomIdentifier(activeStreamRoom) !== roomKey
    ) return;
    const delayMs = pending.retryDelayMs;
    pending.retryTimer = setTimeout(() => {
      pending.retryTimer = null;
      if (
        pendingDeliveryRepairs.get(roomKey) === pending
        && normalizeRoomIdentifier(activeStreamRoom) === roomKey
      ) scheduleRoomStreamReconciliation(roomIdentifier);
    }, delayMs);
    pending.retryDelayMs = Math.min(delayMs * 2, maxDeliveryRepairRetryMs);
  }

  /**
   * Tells the main process that this authoritative snapshot closed a live gap,
   * so the stream's event cursor may advance. The acknowledgement waits until
   * the snapshot's messages and tasks loaded; a cursor that moved past a gap
   * the UI never showed would lose those messages.
   */
  async function acknowledgeStreamGapRepairFromSnapshot(
    roomIdentifier: string,
    repairedSnapshot: DesktopRoomSnapshot,
    token: number | null,
  ): Promise<boolean> {
    const roomKey = normalizeRoomIdentifier(roomIdentifier);
    const pending = roomKey ? pendingDeliveryRepairs.get(roomKey) : null;
    if (
      !roomKey
      || token === null
      || !pending
      || pending.token !== token
    ) return true;
    const deliverySourcesReady = repairedSnapshot.access.status === "ready" && (!repairedSnapshot.sourceStates
      || (
        repairedSnapshot.sourceStates.messages?.status === "ready"
        && repairedSnapshot.sourceStates.tasks?.status === "ready"
      ));
    if (!deliverySourcesReady || !desktopIpc.room.repairStreamDelivery) {
      schedulePendingDeliveryRepair(roomIdentifier, token);
      return false;
    }
    try {
      await desktopIpc.room.repairStreamDelivery(roomIdentifier, { token });
      if (pendingDeliveryRepairs.get(roomKey) === pending) {
        clearPendingDeliveryRepair(roomKey);
      }
      return true;
    } catch {
      // Keep the broker cursor uncommitted and retry this same repair token;
      // the main process ignores an acknowledgement whose token is stale.
      schedulePendingDeliveryRepair(roomIdentifier, token);
      return false;
    }
  }

  watch(options.selectedSnapshot, (snapshot) => {
    if (skipNextSelectedSnapshotCache) {
      skipNextSelectedSnapshotCache = false;
      nextSelectedSnapshotCacheAlias = undefined;
      return;
    }
    rememberCachedSelectedSnapshot(snapshot, nextSelectedSnapshotCacheAlias);
    nextSelectedSnapshotCacheAlias = undefined;
  }, { flush: "sync" });

  async function refresh(): Promise<void> {
    if (options.mcpInstallState.value && !options.mcpInstallState.value.completed) {
      return;
    }

    const sessionGeneration = options.sessionGeneration.value;
    options.loading.value = true;
    let rootBarrierToken: number | null = null;
    try {
      const requestedRootRoomIdentifier = options.selectedRootRoomIdentifier.value;
      const requestedRootPath = selectedRootPath();
      const preloadedRepoStatus = requestedRootRoomIdentifier
        ? null
        : await desktopIpc.repos.getStatus(requestedRootPath);
      if (!sessionIsCurrent(sessionGeneration)) return;
      const barrierRoomIdentifier = requestedRootRoomIdentifier || preloadedRepoStatus?.roomIdentifier || null;
      if (barrierRoomIdentifier) {
        rootBarrierToken = await beginRoomSnapshotBarrier(barrierRoomIdentifier);
      }
      const rootRepairToken = pendingRepairTokenFor(barrierRoomIdentifier);
      if (!sessionIsCurrent(sessionGeneration)) return;
      const [
        nextAppInfo,
        loadedRootRoomContext,
        nextWorkers,
        nextDiagnostics,
        nextAuthStatus,
        nextMcpInstallState,
        nextSettingsAccountRooms,
      ] = await withSnapshotTimeout(Promise.all([
        desktopIpc.app.getInfo(),
        loadRootRoomContext({
          roomIdentifier: requestedRootRoomIdentifier,
          rootPath: requestedRootPath,
          repoStatus: preloadedRepoStatus,
        }),
        desktopIpc.workers.list(),
        desktopIpc.diagnostics.getSnapshot(),
        desktopIpc.auth.getStatus(),
        desktopIpc.setup.getMcpInstallState(),
        // Single `include_archived=true` fetch; the non-archived subset below
        // feeds the sidebar and the full list feeds Settings.
        desktopIpc.room.listAccountRooms?.({ includeArchived: true, limit: 100 }).catch(() => []),
      ]), "root room refresh");
      if (!sessionIsCurrent(sessionGeneration)) return;
      const nextAccountRooms = (nextSettingsAccountRooms || []).filter((room) => !room.archived);
      const nextRootRoomSnapshot = await recoverRootRoomSnapshot(
        requestedRootRoomIdentifier,
        loadedRootRoomContext.snapshot,
        nextAccountRooms || nextSettingsAccountRooms || [],
      );
      if (!sessionIsCurrent(sessionGeneration)) return;
      const rootReadMatchesBarrier = Boolean(barrierRoomIdentifier)
        && normalizeRoomIdentifier(nextRootRoomSnapshot.roomIdentifier) === normalizeRoomIdentifier(barrierRoomIdentifier);
      await acknowledgeStreamGapRepairFromSnapshot(
        nextRootRoomSnapshot.roomIdentifier || "",
        nextRootRoomSnapshot,
        rootReadMatchesBarrier ? rootRepairToken : null,
      );
      if (!sessionIsCurrent(sessionGeneration)) return;
      cachedSelectedSnapshots.noteFreshAccess(nextRootRoomSnapshot);
      const recoveredAlias = recoveredRootRoomAlias(requestedRootRoomIdentifier, nextRootRoomSnapshot);
      options.appInfo.value = nextAppInfo;
      applySupervisedAgentsSupport(nextAppInfo);
      options.repoStatus.value = loadedRootRoomContext.openedRoom?.repoStatus
        ? preserveRoomRepoStatistics(options.repoStatus.value, loadedRootRoomContext.repoStatus)
        : loadedRootRoomContext.repoStatus;
      options.workers.value = nextWorkers;
      options.rootRoomSnapshot.value = nextRootRoomSnapshot;
      options.selectedRootRoomIdentifier.value = nextRootRoomSnapshot.roomIdentifier;
      options.rememberRootRoomSnapshot(nextRootRoomSnapshot, {
        aliasIdentifiers: [
          requestedRootRoomIdentifier,
          loadedRootRoomContext.openedRoom?.roomIdentifier,
          recoveredAlias,
        ],
        rootPath: loadedRootRoomContext.openedRoom?.repoPath || requestedRootPath,
        kind: loadedRootRoomContext.openedRoom ? "project" : null,
        meta: loadedRootRoomContext.openedRoom?.repoStatus?.branch || null,
      });
      options.diagnostics.value = nextDiagnostics;
      options.authStatus.value = nextAuthStatus;
      options.mcpInstallState.value = nextMcpInstallState;
      options.accountRooms.value = nextAccountRooms;
      options.settingsAccountRooms.value = nextSettingsAccountRooms || [];
      options.selectedMcpTargetIds.value = options.selectedMcpTargetIds.value.length
        ? options.selectedMcpTargetIds.value
        : defaultMcpTargetSelection(nextMcpInstallState);
      options.reconcileActiveEntry();
      if (nextRootRoomSnapshot.roomIdentifier) {
        if (rootReadMatchesBarrier) queueRepairReadIfGapChanged(nextRootRoomSnapshot.roomIdentifier, rootRepairToken);
        finishRoomSnapshotBarrier(nextRootRoomSnapshot.roomIdentifier, rootBarrierToken);
      }
      await refreshSelectedSnapshot(nextRootRoomSnapshot);
    } finally {
      queueSkippedRecoveryAfterFailedRead(streamReconcileRoom, rootBarrierToken);
      if (streamReconcileRoom) finishRoomSnapshotBarrier(streamReconcileRoom, rootBarrierToken);
      options.loading.value = false;
    }
  }

  async function recoverRootRoomSnapshot(
    requestedRoomIdentifier: string | null,
    snapshot: DesktopRoomSnapshot,
    accountRooms: readonly DesktopAccountRoomEntry[],
  ): Promise<DesktopRoomSnapshot> {
    if (!shouldRecoverRootRoomSnapshot(requestedRoomIdentifier, snapshot)) {
      return snapshot;
    }

    const accountRoomIdentifier = resolveAccountRoomAliasIdentifier(requestedRoomIdentifier, accountRooms);
    if (accountRoomIdentifier) {
      const recoveredSnapshot = await getRoomSnapshot(accountRoomIdentifier);
      if (recoveredSnapshot.access.status === "ready") return recoveredSnapshot;
    }

    const workspaceSnapshot = await getRoomSnapshot(null);
    return workspaceSnapshot.access.status === "ready"
      ? workspaceSnapshot
      : snapshot;
  }

  async function loadRootRoomContext(input: {
    roomIdentifier: string | null;
    rootPath: string | null;
    repoStatus?: RepoStatus | null;
  }): Promise<{
    snapshot: DesktopRoomSnapshot;
    repoStatus: RepoStatus;
    openedRoom: DesktopRepoRoomSelection | null;
  }> {
    if (input.rootPath && desktopIpc.repos.openRoom) {
      try {
        const openedRoom = await desktopIpc.repos.openRoom(input.rootPath);
        if (!openedRoom.error && openedRoom.snapshot) {
          return {
            snapshot: openedRoom.snapshot,
            repoStatus: openedRoom.repoStatus || await desktopIpc.repos.getStatus(openedRoom.repoPath || input.rootPath),
            openedRoom,
          };
        }
      } catch {
        // Fall back to the previous room id when path-based reopening is unavailable.
      }
    }

    const [repoStatus, snapshot] = await Promise.all([
      input.repoStatus ? Promise.resolve(input.repoStatus) : desktopIpc.repos.getStatus(input.rootPath),
      getRoomSnapshot(input.roomIdentifier),
    ]);
    return {
      snapshot,
      repoStatus,
      openedRoom: null,
    };
  }

  async function refreshAccountRooms(): Promise<void> {
    // A single `include_archived=true` fetch covers both consumers: the sidebar
    // uses the non-archived subset while Settings needs the full list. This
    // replaces the previous pair of `/account/rooms` requests per refresh tick.
    const sessionGeneration = options.sessionGeneration.value;
    const allAccountRooms =
      (await desktopIpc.room.listAccountRooms?.({ includeArchived: true, limit: 100 }).catch(() => [])) || [];
    if (!sessionIsCurrent(sessionGeneration)) return;
    // The two lists are separate arrays; their room objects are shared only
    // when unchanged. Never mutate a room entry in place.
    // An unchanged poll keeps the previous references, so the sidebar and
    // Settings do not recompute when the room list did not change.
    options.settingsAccountRooms.value = reuseUnchanged(toRaw(options.settingsAccountRooms.value), allAccountRooms);
    options.accountRooms.value = reuseUnchanged(
      toRaw(options.accountRooms.value),
      allAccountRooms.filter((room) => !room.archived),
    );
  }

  function selectedRootPath(): string | null {
    const identifier = normalizeRoomIdentifier(
      options.selectedRootRoomIdentifier.value || options.rootRoomSnapshot.value?.roomIdentifier
    );
    if (!identifier) return null;
    return options.recentRootRooms.value.find(
      (room) => normalizeRoomIdentifier(room.identifier) === identifier
    )?.rootPath || null;
  }

  function rootPathForRoomIdentifier(roomIdentifier: string | null | undefined): string | null {
    const identifier = normalizeRoomIdentifier(roomIdentifier);
    if (!identifier) return null;
    return options.recentRootRooms.value.find(
      (room) => normalizeRoomIdentifier(room.identifier) === identifier
    )?.rootPath || null;
  }

  /**
   * A cold start asks twice for the same selection in one task: refresh()
   * itself, and the active-entry watcher that reconcileActiveEntry woke. No
   * IPC reply or stream event can land between two calls in one task, so the
   * second call joins the first (which stays the current request) instead of
   * reading the room again. A call in a later task, or for another entry,
   * room, root snapshot object or session, runs on its own.
   *
   * The join entry ends with a microtask queued by the first call. The
   * watcher's flush was queued earlier (when reconcileActiveEntry changed the
   * entry), so it still joins; nothing from a later task can. A caller that
   * needs data newer than a read already in flight passes `fresh` and never
   * joins.
   */
  function refreshSelectedSnapshot(
    baseRootSnapshot: DesktopRoomSnapshot | null = options.rootRoomSnapshot.value,
    { fresh = false }: { fresh?: boolean } = {},
  ): Promise<void> {
    const entry = options.activeEntry.value;
    const key = JSON.stringify([
      options.sessionGeneration.value,
      entry.id,
      entry.type,
      baseRootSnapshot?.roomIdentifier ?? null,
      baseRootSnapshot ? options.resolveSelectedRoomIdentifier(baseRootSnapshot) : null,
    ]);
    const base = baseRootSnapshot ? toRaw(baseRootSnapshot) : null;
    if (!fresh && sameTaskSelectionRefresh?.key === key && sameTaskSelectionRefresh.base === base) {
      return sameTaskSelectionRefresh.promise;
    }
    const promise = refreshSelectedSnapshotNow(baseRootSnapshot);
    const current = { key, base, promise };
    sameTaskSelectionRefresh = current;
    const forget = () => {
      if (sameTaskSelectionRefresh === current) sameTaskSelectionRefresh = null;
    };
    queueMicrotask(forget);
    promise.then(forget, forget);
    return promise;
  }

  async function refreshSelectedSnapshotNow(baseRootSnapshot: DesktopRoomSnapshot | null): Promise<void> {
    const requestId = ++selectedSnapshotRequestId;

    if (!baseRootSnapshot) {
      if (requestId === selectedSnapshotRequestId) {
        setSelectedSnapshot(null, { cache: false });
        selectedSnapshotLoading.value = false;
      }
      return;
    }

    if (options.activeEntry.value.type !== "room") {
      if (requestId === selectedSnapshotRequestId) {
        setSelectedSnapshot(mergeFreshSelectedSnapshot(baseRootSnapshot), { activitySnapshot: true });
        selectedSnapshotLoading.value = false;
      }
      return;
    }

    const selectedRoomEntry = options.activeEntry.value;
    const roomIdentifier = options.resolveSelectedRoomIdentifier(baseRootSnapshot);
    if (
      selectedRoomEntry.kind === "parent"
      && roomIdentifier
      && normalizeRoomIdentifier(roomIdentifier) !== normalizeRoomIdentifier(baseRootSnapshot.roomIdentifier)
    ) {
      // A return to a room shown earlier in this session paints its last
      // known snapshot at once; the read below replaces it. Loading stays on
      // until then, so nothing that waits for a loaded room acts on it.
      if (!paintCachedSelectedSnapshot(requestId, selectedRoomEntry, roomIdentifier, baseRootSnapshot, { loading: true })) {
        publishOptimisticSelectedSnapshot(requestId, selectedRoomEntry, roomIdentifier, baseRootSnapshot);
      }
      let applied = false;
      try {
        const openedContext = await loadRootRoomContext({
          roomIdentifier,
          rootPath: rootPathForRoomIdentifier(roomIdentifier),
        });
        const nextRootSnapshot = openedContext.snapshot;
        const nextRepoStatus = openedContext.repoStatus;
        if (requestId !== selectedSnapshotRequestId || options.activeEntry.value.id !== selectedRoomEntry.id) return;
        options.repoStatus.value = openedContext.openedRoom?.repoStatus
          ? preserveRoomRepoStatistics(options.repoStatus.value, nextRepoStatus)
          : nextRepoStatus;
        options.rootRoomSnapshot.value = nextRootSnapshot;
        const aliases = [roomIdentifier, openedContext.openedRoom?.roomIdentifier];
        cachedSelectedSnapshots.noteFreshAccess(nextRootSnapshot, aliases);
        setSelectedSnapshot(mergeFreshSelectedSnapshot(nextRootSnapshot), { cache: false, activitySnapshot: true });
        applied = true;
        cachedSelectedSnapshots.remember(options.selectedSnapshot.value, aliases);
        options.selectedRootRoomIdentifier.value = nextRootSnapshot.roomIdentifier;
        options.rememberRootRoomSnapshot(nextRootSnapshot, {
          aliasIdentifiers: [roomIdentifier, openedContext.openedRoom?.roomIdentifier],
          rootPath: openedContext.openedRoom?.repoPath || rootPathForRoomIdentifier(roomIdentifier),
          kind: openedContext.openedRoom ? "project" : null,
          meta: openedContext.openedRoom?.repoStatus?.branch || null,
        });
        options.activeEntry.value = options.currentParentRoom.value;
      } finally {
        // A failed read shows what the uncached path shows, not the old snapshot as if it were fresh.
        if (!applied && requestId === selectedSnapshotRequestId) revertCachedPaint(roomIdentifier);
        if (requestId === selectedSnapshotRequestId) selectedSnapshotLoading.value = false;
      }
      return;
    }
    if (!roomIdentifier || roomIdentifier === baseRootSnapshot.roomIdentifier) {
      if (requestId === selectedSnapshotRequestId) {
        setSelectedSnapshot(mergeFreshSelectedSnapshot(baseRootSnapshot), { activitySnapshot: true });
        selectedSnapshotLoading.value = false;
      }
      return;
    }

    // A focus room keeps its earlier behaviour: the cached snapshot shows
    // without the loading state.
    if (!paintCachedSelectedSnapshot(requestId, selectedRoomEntry, roomIdentifier, baseRootSnapshot, { loading: false })) {
      publishOptimisticSelectedSnapshot(requestId, selectedRoomEntry, roomIdentifier, baseRootSnapshot);
    }
    let barrierToken: number | null = null;
    try {
      barrierToken = await beginRoomSnapshotBarrier(roomIdentifier);
      const repairToken = pendingRepairTokenFor(roomIdentifier);
      const nextSnapshot = await getRoomSnapshot(roomIdentifier);
      if (requestId !== selectedSnapshotRequestId || options.activeEntry.value.id !== selectedRoomEntry.id) return;
      await acknowledgeStreamGapRepairFromSnapshot(roomIdentifier, nextSnapshot, repairToken);
      if (requestId !== selectedSnapshotRequestId || options.activeEntry.value.id !== selectedRoomEntry.id) return;
      cachedSelectedSnapshots.noteFreshAccess(nextSnapshot, [roomIdentifier]);
      setSelectedSnapshot(mergeFreshSelectedSnapshot(nextSnapshot), { cacheAlias: roomIdentifier, activitySnapshot: true });
      queueRepairReadIfGapChanged(roomIdentifier, repairToken);
      finishRoomSnapshotBarrier(roomIdentifier, barrierToken);
    } finally {
      queueSkippedRecoveryAfterFailedRead(roomIdentifier, barrierToken);
      if (streamReconcileRoom === roomIdentifier) finishRoomSnapshotBarrier(roomIdentifier, barrierToken);
      if (requestId === selectedSnapshotRequestId) selectedSnapshotLoading.value = false;
    }
  }

  async function beginRoomSnapshotBarrier(roomIdentifier: string): Promise<number> {
    const roomKey = normalizeRoomIdentifier(roomIdentifier);
    const preserveDegradedStream = Boolean(
      roomKey
      && normalizeRoomIdentifier(activeStreamRoom) === roomKey
      && degradedStreamRooms.get(roomKey) === activeStreamToken,
    );
    if (!preserveDegradedStream) {
      pendingVerifiedRecoveries.clear();
      skippedVerifiedRecoveries.clear();
      clearPendingDeliveryRepairs();
      degradedStreamRooms.clear();
    }
    const token = ++streamReconcileGeneration;
    activeStreamRoom = roomIdentifier;
    activeActivityScope = activityUnread.scope;
    if (!preserveDegradedStream) activeStreamToken = token;
    streamReconcileRoom = roomIdentifier;
    resetBufferedStreamEvents();
    barrierAwaitingStream = token;
    try {
      await options.syncRoomStream(roomIdentifier, null);
      return token;
    } catch (error) {
      releaseRoomSnapshotBarrier(roomIdentifier, token, false);
      throw error;
    } finally {
      if (barrierAwaitingStream === token) barrierAwaitingStream = null;
    }
  }

  /** The repair token the stream reported so far; read it right before a barrier read starts. */
  function pendingRepairTokenFor(roomIdentifier: string | null | undefined): number | null {
    const roomKey = normalizeRoomIdentifier(roomIdentifier);
    return roomKey ? pendingDeliveryRepairs.get(roomKey)?.token ?? null : null;
  }

  /**
   * A barrier read closes only the gap whose token was pending when the read
   * started. If the stream reported a newer gap while the read ran, ask the
   * barrier release for one more read: it captures the new token first.
   */
  function queueRepairReadIfGapChanged(roomIdentifier: string, tokenAtReadStart: number | null): void {
    const roomKey = normalizeRoomIdentifier(roomIdentifier);
    if (!roomKey || normalizeRoomIdentifier(activeStreamRoom) !== roomKey) return;
    // This read completed after the boundary whose recovery was skipped.
    skippedVerifiedRecoveries.delete(roomKey);
    const pendingToken = pendingDeliveryRepairs.get(roomKey)?.token;
    if (pendingToken === undefined || pendingToken === tokenAtReadStart) return;
    pendingVerifiedRecoveries.set(roomKey, activeStreamToken);
  }

  /**
   * A barrier read that did not complete (error, timeout, or dropped) while
   * its room is still the stream's room: queue the recovery read that was
   * skipped because this read was expected to cover it. Call before the
   * barrier is released; the release then runs exactly one read.
   */
  function queueSkippedRecoveryAfterFailedRead(roomIdentifier: string | null, barrierToken: number | null): void {
    const roomKey = normalizeRoomIdentifier(roomIdentifier);
    if (
      !roomKey
      || barrierToken === null
      || barrierToken !== streamReconcileGeneration
      || normalizeRoomIdentifier(streamReconcileRoom) !== roomKey
      || normalizeRoomIdentifier(activeStreamRoom) !== roomKey
      || skippedVerifiedRecoveries.get(roomKey) !== activeStreamToken
    ) return;
    skippedVerifiedRecoveries.delete(roomKey);
    pendingVerifiedRecoveries.set(roomKey, activeStreamToken);
  }

  async function syncSelectedRoomStream(roomIdentifier: string | null): Promise<void> {
    const roomKey = normalizeRoomIdentifier(roomIdentifier);
    if (!roomKey) {
      ++streamReconcileGeneration;
      activeStreamRoom = null;
      activeStreamToken = 0;
      streamReconcileRoom = null;
      resetBufferedStreamEvents();
      degradedStreamRooms.clear();
      pendingVerifiedRecoveries.clear();
      skippedVerifiedRecoveries.clear();
      clearPendingDeliveryRepairs();
      await options.syncRoomStream(null);
      return;
    }
    if (normalizeRoomIdentifier(activeStreamRoom) !== roomKey) {
      const token = ++streamReconcileGeneration;
      activeStreamRoom = roomIdentifier;
      activeActivityScope = activityUnread.scope;
      activeStreamToken = token;
      streamReconcileRoom = null;
      resetBufferedStreamEvents();
      degradedStreamRooms.clear();
      pendingVerifiedRecoveries.clear();
      skippedVerifiedRecoveries.clear();
      clearPendingDeliveryRepairs();
    }
    await options.syncRoomStream(roomIdentifier);
  }

  function finishRoomSnapshotBarrier(roomIdentifier: string, token: number | null): void {
    releaseRoomSnapshotBarrier(roomIdentifier, token, true);
  }

  function releaseRoomSnapshotBarrier(
    roomIdentifier: string,
    token: number | null,
    reconcilePending: boolean,
  ): void {
    if (
      token !== streamReconcileGeneration
      || normalizeRoomIdentifier(streamReconcileRoom) !== normalizeRoomIdentifier(roomIdentifier)
    ) return;
    const pending = streamBufferOverflow ? [] : bufferedStreamEvents;
    const overflowed = streamBufferOverflow;
    resetBufferedStreamEvents();
    streamReconcileRoom = null;
    for (const buffered of pending) handleRoomStreamEvent(buffered);
    const roomKey = normalizeRoomIdentifier(roomIdentifier);
    if (reconcilePending && (
      roomKey
      && normalizeRoomIdentifier(activeStreamRoom) === roomKey
      && pendingVerifiedRecoveries.get(roomKey) === activeStreamToken
    )) {
      scheduleRoomStreamReconciliation(roomIdentifier);
    }
    if (overflowed && normalizeRoomIdentifier(activeStreamRoom) === roomKey) {
      scheduleRoomStreamReconciliation(roomIdentifier);
    }
  }

  function getRoomSnapshot(roomIdentifier: string | null): Promise<DesktopRoomSnapshot> {
    return withSnapshotTimeout(desktopIpc.room.getSnapshot(roomIdentifier), roomIdentifier || "workspace room");
  }

  function withSnapshotTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    const timeoutMs = options.snapshotTimeoutMs ?? defaultRoomSnapshotTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${label} snapshot timed out`)), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
  }

  function publishOptimisticSelectedSnapshot(
    requestId: number,
    entry: RoomEntry,
    roomIdentifier: string,
    baseRootSnapshot: DesktopRoomSnapshot,
  ): void {
    if (requestId !== selectedSnapshotRequestId) return;
    setSelectedSnapshot(createOptimisticSelectedSnapshot(entry, roomIdentifier, baseRootSnapshot), { cache: false });
    selectedSnapshotLoading.value = true;
  }

  function upsertSelectedTask(task: DesktopTaskSummary): void {
    setSelectedSnapshot(upsertSnapshotTask(options.selectedSnapshot.value, task));
  }

  function handleRoomStreamEvent(event: DesktopRoomStreamEvent): void {
    // Count canonical deliveries before buffering: a bootstrap snapshot may already
    // contain this event by the time the buffer is replayed.
    if (event.type === "github_event" && activeActivityScope === activityUnread.scope
      && normalizeRoomIdentifier(activeStreamRoom) === normalizeRoomIdentifier(event.roomIdentifier)) {
      const snapshot = options.selectedSnapshot.value;
      const identifier = snapshotMatchesRoom(snapshot, event.roomIdentifier)
        ? snapshot?.room?.identifier || snapshot?.roomIdentifier : activeStreamRoom;
      activityUnread.receive(normalizeRoomIdentifier(identifier) || "", [event.event.id]);
    }
    if (streamReconcileRoom && event.type !== "open") {
      if (normalizeRoomIdentifier(streamReconcileRoom) === normalizeRoomIdentifier(event.roomIdentifier)) {
        bufferStreamEvent(event);
      }
      return;
    }

    if (event.type === "open") {
      // A transport open is not a consistency boundary. A verified handshake
      // (or the bounded legacy timeout, represented as gap=true) starts one
      // authoritative snapshot while subsequent typed events are buffered and
      // replayed over it. This covers every snapshot resource, not only chat.
      const roomKey = normalizeRoomIdentifier(event.roomIdentifier);
      if (!roomKey || normalizeRoomIdentifier(activeStreamRoom) !== roomKey) return;
      if (event.gap && event.verified && typeof event.deliveryRepairToken === "number") {
        setPendingDeliveryRepair(event.roomIdentifier, event.deliveryRepairToken);
      }
      if (event.gap && normalizeRoomIdentifier(streamReconcileRoom) === roomKey) {
        degradedStreamRooms.set(roomKey, activeStreamToken);
        return;
      }
      if (
        event.verified
        && roomKey
        && normalizeRoomIdentifier(activeStreamRoom) === roomKey
        && degradedStreamRooms.get(roomKey) === activeStreamToken
        && normalizeRoomIdentifier(streamReconcileRoom) === roomKey
      ) {
        // While the barrier still awaits its stream, its read has not started:
        // that read comes after this verified boundary and already covers it.
        // Main sends a verified gap and then a verified gap:false boundary in
        // one handshake; queueing a recovery here read the room twice.
        // The skipped recovery is kept: if that read then fails, it is the
        // only retry (queueSkippedRecoveryAfterFailedRead).
        if (barrierAwaitingStream !== streamReconcileGeneration) {
          pendingVerifiedRecoveries.set(roomKey, activeStreamToken);
        } else {
          skippedVerifiedRecoveries.set(roomKey, activeStreamToken);
        }
        return;
      }
      if (event.verified && normalizeRoomIdentifier(streamReconcileRoom) === roomKey) return;
      if (
        event.verified
        && roomKey
        && normalizeRoomIdentifier(activeStreamRoom) === roomKey
        && degradedStreamRooms.get(roomKey) === activeStreamToken
        && snapshotMatchesRoom(options.selectedSnapshot.value, event.roomIdentifier)
      ) {
        scheduleRoomStreamReconciliation(event.roomIdentifier);
        return;
      }
      if (event.gap && !streamReconcileRoom) {
        scheduleRoomStreamReconciliation(event.roomIdentifier);
      }
      return;
    }

    if (!snapshotMatchesRoom(options.selectedSnapshot.value, event.roomIdentifier)) return;

    if (event.type === "message") {
      const priorMessages = options.selectedSnapshot.value?.messages ?? [];
      setSelectedSnapshot(appendSnapshotMessage(options.selectedSnapshot.value, event.message, event.live === true));
      if (messageReferencesMissingThreadContext(event.message, priorMessages)) {
        options.scheduleLiveMetadataRefresh();
      }
      return;
    }

    if (event.type === "message_window") {
      const snapshot = options.selectedSnapshot.value;
      if (snapshot) setSelectedSnapshot({ ...snapshot, messages: event.messages });
      return;
    }

    if (event.type === "message_batch") {
      const snapshot = options.selectedSnapshot.value;
      if (snapshot) setSelectedSnapshot({
        ...snapshot,
        messages: mergeDesktopRoomMessages(snapshot.messages, event.messages),
      });
      return;
    }

    if (event.type === "task_update") {
      upsertSelectedTask(event.task);
      return;
    }

    if (event.type === "task_remove") {
      const snapshot = options.selectedSnapshot.value;
      if (snapshot) setSelectedSnapshot({
        ...snapshot, tasks: snapshot.tasks.filter(task => task.id !== event.taskId),
      });
      return;
    }

    if (event.type === "github_event") {
      setSelectedSnapshot(upsertSnapshotGitHubEvent(options.selectedSnapshot.value, event.event));
      return;
    }

    if (event.type === "artifact_update") {
      if (event.artifact) {
        setSelectedSnapshot(upsertSnapshotRoomArtifact(options.selectedSnapshot.value, event.artifact));
      }
      void refreshSelectedRoomArtifacts(event.roomIdentifier);
      return;
    }

    if (event.type === "reasoning_update") {
      setSelectedSnapshot(upsertSnapshotReasoningSession(options.selectedSnapshot.value, event.session));
      return;
    }

    if (event.type === "reasoning_remove") {
      setSelectedSnapshot(removeSnapshotReasoningSession(options.selectedSnapshot.value, event.sessionId));
      return;
    }

    if (event.type === "live_activity_update") {
      setSelectedSnapshot(upsertSnapshotLiveActivitySession(options.selectedSnapshot.value, event.session));
      return;
    }

    if (event.type === "live_activity_remove") {
      setSelectedSnapshot(removeSnapshotLiveActivitySession(options.selectedSnapshot.value, event.sessionId));
      return;
    }

    if (
      event.type === "rental_activity" ||
      event.type === "rental_patch" ||
      event.type === "rental_usage"
    ) {
      options.scheduleLiveMetadataRefresh(0);
      return;
    }

    if (event.type === "rental_quota_exhausted") {
      options.scheduleLiveMetadataRefresh(0);
    }
  }

  async function reconcileRoomStreamSnapshot(roomIdentifier: string): Promise<void> {
    const generation = ++streamReconcileGeneration;
    const roomKey = normalizeRoomIdentifier(roomIdentifier);
    const deliveryRepairToken = roomKey
      ? pendingDeliveryRepairs.get(roomKey)?.token ?? null
      : null;
    streamReconcileRoom = roomIdentifier;
    resetBufferedStreamEvents();
    try {
      const snapshot = await getRoomSnapshot(roomIdentifier);
      if (
        generation !== streamReconcileGeneration
        || !roomKey
        || normalizeRoomIdentifier(activeStreamRoom) !== roomKey
      ) return;
      await acknowledgeStreamGapRepairFromSnapshot(
        roomIdentifier,
        snapshot,
        deliveryRepairToken,
      );
      if (
        generation !== streamReconcileGeneration
        || normalizeRoomIdentifier(activeStreamRoom) !== roomKey
      ) return;
      cachedSelectedSnapshots.noteFreshAccess(snapshot, [roomIdentifier]);
      setSelectedSnapshot(mergeFreshSelectedSnapshot(snapshot), { activitySnapshot: true });
      const pending = streamBufferOverflow ? [] : bufferedStreamEvents;
      const overflowed = streamBufferOverflow;
      resetBufferedStreamEvents();
      streamReconcileRoom = null;
      for (const buffered of pending) handleRoomStreamEvent(buffered);
      if (overflowed) scheduleRoomStreamReconciliation(roomIdentifier);
      if (roomKey) {
        degradedStreamRooms.delete(roomKey);
        pendingVerifiedRecoveries.delete(roomKey);
        skippedVerifiedRecoveries.delete(roomKey);
      }
    } finally {
      if (generation === streamReconcileGeneration) {
        const pending = streamBufferOverflow ? [] : bufferedStreamEvents;
        const overflowed = streamBufferOverflow;
        resetBufferedStreamEvents();
        streamReconcileRoom = null;
        for (const buffered of pending) handleRoomStreamEvent(buffered);
        if (overflowed && normalizeRoomIdentifier(activeStreamRoom) === roomKey) {
          scheduleRoomStreamReconciliation(roomIdentifier);
        }
      }
      if (
        roomKey
        && deliveryRepairToken !== null
        && pendingDeliveryRepairs.has(roomKey)
        && normalizeRoomIdentifier(activeStreamRoom) === roomKey
      ) {
        const pendingToken = pendingDeliveryRepairs.get(roomKey)?.token;
        if (pendingToken !== undefined) {
          if (pendingToken !== deliveryRepairToken) scheduleRoomStreamReconciliation(roomIdentifier);
          else schedulePendingDeliveryRepair(roomIdentifier, deliveryRepairToken);
        }
      }
    }
  }

  function scheduleRoomStreamReconciliation(roomIdentifier: string): void {
    void reconcileRoomStreamSnapshot(roomIdentifier).catch(() => undefined);
  }

  function scheduleSelectedSnapshotRefresh(): void {
    // An explicit room refresh wants data newer than any read in flight.
    void refreshSelectedSnapshot(options.rootRoomSnapshot.value, { fresh: true }).catch(() => undefined);
  }

  function handleRefreshRoom(snapshot?: DesktopRoomSnapshot): void {
    if (snapshot) {
      options.rootRoomSnapshot.value = snapshot;
      cachedPaint = null;
      cachedSelectedSnapshots.noteFreshAccess(snapshot);
      setSelectedSnapshot(snapshot, { activitySnapshot: true });
      options.selectedRootRoomIdentifier.value = snapshot.roomIdentifier;
      options.rememberRootRoomSnapshot(snapshot);
      options.reconcileActiveEntry();
      options.scheduleLiveMetadataRefresh(0);
      return;
    }
    // For the root room, refreshSelectedSnapshot only re-merges the local root
    // copy, whose event-fed tasks, reasoning and artifacts are older than what
    // is on screen. The full read scheduled below is the real refresh.
    if (!selectedRoomReusesRootSnapshot(options.rootRoomSnapshot.value)) scheduleSelectedSnapshotRefresh();
    options.scheduleLiveMetadataRefresh(0);
  }

  /** Whether refreshSelectedSnapshot would show the root snapshot as-is. */
  function selectedRoomReusesRootSnapshot(baseRootSnapshot: DesktopRoomSnapshot | null): boolean {
    if (!baseRootSnapshot || options.activeEntry.value.type !== "room") return false;
    const roomIdentifier = options.resolveSelectedRoomIdentifier(baseRootSnapshot);
    return !roomIdentifier || roomIdentifier === baseRootSnapshot.roomIdentifier;
  }

  function handleMessageSent(message: DesktopRoomMessage): void {
    const priorMessages = options.selectedSnapshot.value?.messages ?? [];
    setSelectedSnapshot(appendSnapshotMessage(options.selectedSnapshot.value, message, true));
    if (messageReferencesMissingThreadContext(message, priorMessages)) {
      options.scheduleLiveMetadataRefresh();
    }
  }

  async function refreshSelectedRoomArtifacts(roomIdentifier: string): Promise<void> {
    const isCurrent = (request: NonNullable<typeof artifactRefresh>): boolean => !artifactRefreshDisposed
      && artifactRefresh === request
      && request.context === artifactRefreshContext
      && request.streamGeneration === streamReconcileGeneration
      && request.streamToken === activeStreamToken
      && snapshotMatchesRoom(options.selectedSnapshot.value, request.roomIdentifier);
    if (artifactRefreshDisposed || !snapshotMatchesRoom(options.selectedSnapshot.value, roomIdentifier)) return;
    if (artifactRefresh && isCurrent(artifactRefresh)) {
      artifactRefresh.invalidated = true;
      return;
    }
    const request = {
      context: artifactRefreshContext, roomIdentifier,
      streamGeneration: streamReconcileGeneration, streamToken: activeStreamToken,
      invalidated: false,
    };
    artifactRefresh = request;
    const baseline = options.selectedSnapshot.value?.roomArtifacts;
    try {
      const artifacts = await desktopIpc.room.getArtifacts?.(roomIdentifier).catch(() => null);
      // A later event requires a trailing read. A newer snapshot or explicit
      // artifact mutation already owns the displayed list and must also win.
      if (!artifacts || !isCurrent(request) || request.invalidated
        || options.selectedSnapshot.value?.access.status !== "ready"
        || options.selectedSnapshot.value?.roomArtifacts !== baseline) return;
      setSelectedSnapshot(replaceSnapshotRoomArtifacts(options.selectedSnapshot.value, artifacts));
    } finally {
      const refreshAgain = isCurrent(request) && request.invalidated;
      if (artifactRefresh === request) artifactRefresh = null;
      if (refreshAgain) void refreshSelectedRoomArtifacts(roomIdentifier);
    }
  }

  function handleRoomRenamed(room: DesktopRoomInfo): void {
    if (!options.selectedSnapshot.value) return;
    setSelectedSnapshot({
      ...options.selectedSnapshot.value,
      room,
      roomIdentifier: room.identifier,
    });
    if (options.rootRoomSnapshot.value && roomSnapshotsMatch(options.rootRoomSnapshot.value, options.selectedSnapshot.value)) {
      options.rootRoomSnapshot.value = {
        ...options.rootRoomSnapshot.value,
        room,
        roomIdentifier: room.identifier,
      };
    }
  }

  function setSelectedSnapshot(
    snapshot: DesktopRoomSnapshot | null,
    input: { cache?: boolean; cacheAlias?: string | null; activitySnapshot?: boolean } = {},
  ): void {
    if (input.activitySnapshot && snapshot?.roomIdentifier && snapshot.githubEvents && snapshot.sourceStates?.githubEvents?.status !== "error") {
      activityUnread.observeLatest(normalizeRoomIdentifier(snapshot.room?.identifier || snapshot.roomIdentifier) || "", snapshot.githubEvents.events.map(event => event.id));
    }
    const previousSnapshot = options.selectedSnapshot.value;
    if (cachedPaint && !snapshotMatchesRoom(snapshot, cachedPaint.roomIdentifier)) cachedPaint = null;
    if (input.cache === false) {
      skipNextSelectedSnapshotCache = true;
      nextSelectedSnapshotCacheAlias = undefined;
    } else {
      nextSelectedSnapshotCacheAlias = input.cacheAlias;
    }
    options.selectedSnapshot.value = snapshot;
    if (previousSnapshot !== snapshot) return;
    if (skipNextSelectedSnapshotCache) {
      skipNextSelectedSnapshotCache = false;
      return;
    }
    rememberCachedSelectedSnapshot(snapshot, nextSelectedSnapshotCacheAlias);
    nextSelectedSnapshotCacheAlias = undefined;
  }

  function clearSelectedSnapshotCache(): void {
    cachedSelectedSnapshots.clear();
    cachedPaint = null;
  }

  function rememberCachedSelectedSnapshot(
    snapshot: DesktopRoomSnapshot | null,
    roomIdentifierAlias?: string | null,
  ): void {
    cachedSelectedSnapshots.remember(snapshot, [roomIdentifierAlias]);
  }

  /**
   * Shows the room's last known snapshot while its fresh read runs. Returns
   * false (and shows nothing) when the room has no usable cache entry.
   */
  function paintCachedSelectedSnapshot(
    requestId: number,
    entry: RoomEntry,
    roomIdentifier: string,
    baseRootSnapshot: DesktopRoomSnapshot,
    { loading }: { loading: boolean },
  ): boolean {
    if (requestId !== selectedSnapshotRequestId) return false;
    const cachedSnapshot = cachedSelectedSnapshots.read(roomIdentifier);
    if (!cachedSnapshot || cachedSnapshot.access.status !== "ready") return false;
    setSelectedSnapshot(cachedSnapshot, { cache: false });
    cachedPaint = {
      roomIdentifier,
      snapshot: cachedSnapshot,
      placeholder: createOptimisticSelectedSnapshot(entry, roomIdentifier, baseRootSnapshot),
    };
    selectedSnapshotLoading.value = loading;
    return true;
  }

  /**
   * The selected snapshot as the uncached path would hold it now: the
   * placeholder plus what changed after a cached paint. Unchanged without one.
   */
  function selectedSnapshotWithoutCachedPaint(): DesktopRoomSnapshot | null {
    const current = options.selectedSnapshot.value;
    if (!cachedPaint || !current || !snapshotMatchesRoom(current, cachedPaint.roomIdentifier)) return current;
    return withoutCachedPaint(current, cachedPaint.snapshot, cachedPaint.placeholder);
  }

  /** Applies a fresh snapshot through the usual merge; it replaces a cached paint. */
  function mergeFreshSelectedSnapshot(fresh: DesktopRoomSnapshot): DesktopRoomSnapshot {
    const current = selectedSnapshotWithoutCachedPaint();
    if (cachedPaint && snapshotMatchesRoom(fresh, cachedPaint.roomIdentifier)) cachedPaint = null;
    return mergeRoomSnapshotMessages(current, fresh);
  }

  function revertCachedPaint(roomIdentifier: string): void {
    if (!cachedPaint || cachedPaint.roomIdentifier !== roomIdentifier) return;
    const current = selectedSnapshotWithoutCachedPaint();
    cachedPaint = null;
    setSelectedSnapshot(current, { cache: false });
  }

  const repoStatusValue = computed<RepoStatus>(() => options.repoStatus.value || {
    rootPath: options.appInfo.value?.workspaceRoot || "",
    isGitRepo: false,
    gitHeadPath: null,
    head: null,
    branch: null,
    detached: false,
    defaultBranch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    changes: {
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
    },
    dirty: false,
    roomIdentifier: null,
    roomSource: null,
    worktrees: [],
  });

  return {
    clearSelectedSnapshotCache,
    handleMessageSent,
    handleRefreshRoom,
    handleRoomRenamed,
    handleRoomStreamEvent,
    invalidateSession,
    refresh,
    refreshAccountRooms,
    refreshSelectedSnapshot,
    repoStatusValue,
    selectedSnapshotLoading,
    syncSelectedRoomStream,
    upsertSelectedTask,
  };
}

function shouldRecoverRootRoomSnapshot(
  requestedRoomIdentifier: string | null,
  snapshot: DesktopRoomSnapshot,
): boolean {
  return Boolean(
    requestedRoomIdentifier
    && snapshot.access.status === "unavailable"
    && snapshot.access.httpStatus === 404
  );
}

function recoveredRootRoomAlias(
  requestedRoomIdentifier: string | null,
  snapshot: DesktopRoomSnapshot,
): string | null {
  const requestedIdentifier = normalizeRoomIdentifier(requestedRoomIdentifier);
  const recoveredIdentifier = normalizeRoomIdentifier(snapshot.roomIdentifier);
  if (!requestedIdentifier || !recoveredIdentifier) return null;
  return requestedIdentifier === recoveredIdentifier ? null : requestedRoomIdentifier;
}

function accountRoomKeys(rooms: readonly DesktopAccountRoomEntry[]): string[] {
  return rooms.flatMap((room) => [
    room.roomIdentifier,
    ...(room.focusRooms || []).map((focusRoom) => focusRoom.roomIdentifier),
  ]).map(normalizeRoomIdentifier).filter((key): key is string => Boolean(key));
}

function createOptimisticSelectedSnapshot(
  entry: RoomEntry,
  roomIdentifier: string,
  baseRootSnapshot: DesktopRoomSnapshot,
): DesktopRoomSnapshot {
  const normalizedRoomIdentifier = normalizeRoomIdentifier(roomIdentifier);
  const focusRoom = baseRootSnapshot.focusRooms.find((room) =>
    normalizeRoomIdentifier(room.identifier) === normalizedRoomIdentifier
    || `room:focus:${room.roomId}` === entry.id
  );
  const displayName = focusRoom?.displayName || entry.title || roomIdentifier;
  const kind: DesktopRoomInfo["kind"] = entry.kind === "focus" ? "focus" : "main";

  return {
    roomIdentifier,
    access: {
      status: "ready",
      title: "",
      message: "",
      roomIdentifier,
      deviceFlowUrl: null,
      code: null,
      httpStatus: null,
    },
    room: {
      identifier: roomIdentifier,
      code: focusRoom?.code || "",
      name: displayName,
      displayName,
      role: entry.meta.toLowerCase() === "admin" ? "admin" : "participant",
      authenticated: true,
      kind,
      parentRoomId: focusRoom?.parentRoomId || baseRootSnapshot.roomIdentifier || null,
      focusKey: focusRoom?.focusKey || null,
      sourceTaskId: focusRoom?.sourceTaskId || null,
      focusStatus: focusRoom?.focusStatus || null,
      focusParentVisibility: focusRoom?.focusParentVisibility || null,
      focusActivityScope: focusRoom?.focusActivityScope || null,
      focusGitHubEventRouting: focusRoom?.focusGitHubEventRouting || null,
      focusSettings: focusRoom?.focusSettings || null,
      focusArchivedAt: focusRoom?.focusArchivedAt || null,
      concludedAt: focusRoom?.concludedAt || null,
      conclusionSummary: focusRoom?.conclusionSummary || null,
      conclusionDetails: focusRoom?.conclusionDetails || null,
      gitRoom: focusRoom?.gitRoom || null,
    },
    storage: baseRootSnapshot.storage,
    focusRooms: [],
    tasks: [],
    participants: [],
    participantHiddenCount: 0,
    presence: [],
    reasoningSessions: [],
    liveActivitySessions: [],
    recentActivity: [],
    roomArtifacts: [],
    boardSettings: baseRootSnapshot.boardSettings,
    messages: [],
    githubEvents: null,
    // Optimistic placeholder while the focus room loads; inherit the root's
    // known source health until the real snapshot replaces it.
    sourceStates: baseRootSnapshot.sourceStates,
  };
}
