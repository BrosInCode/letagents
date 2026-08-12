import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
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
import {
  appendSnapshotMessage,
  mergeDesktopRoomMessages,
  mergeRoomSnapshotMessages,
  messageReferencesMissingThreadContext,
  removeSnapshotReasoningSession,
  replaceSnapshotRoomArtifacts,
  roomSnapshotsMatch,
  snapshotMatchesRoom,
  upsertSnapshotReasoningSession,
  upsertSnapshotGitHubEvent,
  upsertSnapshotRoomArtifact,
  upsertSnapshotTask,
} from "../domain/desktop-room-snapshots";
import { defaultMcpTargetSelection } from "../domain/mcp-install";
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

const selectedSnapshotCacheLimit = 8;
const defaultRoomSnapshotTimeoutMs = 15_000;
const defaultDeliveryRepairRetryMs = 500;
const maxDeliveryRepairRetryMs = 5_000;
const defaultStreamBufferMaxEvents = 256;
const defaultStreamBufferMaxBytes = 1024 * 1024;

interface PendingDeliveryRepairState {
  token: number;
  baseline: DesktopRoomSnapshot | null;
  retryDelayMs: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

export function buildRoomStreamDeliveryRepair(
  previous: DesktopRoomSnapshot,
  repaired: DesktopRoomSnapshot,
): { messages: DesktopRoomMessage[]; tasks: DesktopTaskSummary[] } {
  const previousMessageIds = new Set(previous.messages.map((message) => message.id));
  const previousTaskVersions = new Map(
    previous.tasks.map((task) => [task.id, task.updatedAt]),
  );
  return {
    messages: repaired.messages.filter((message) => !previousMessageIds.has(message.id)),
    tasks: repaired.tasks.filter(
      (task) => previousTaskVersions.get(task.id) !== task.updatedAt,
    ),
  };
}

export function useDesktopAppData(options: DesktopAppDataOptions) {
  let selectedSnapshotRequestId = 0;
  const selectedSnapshotLoading = ref(false);
  const cachedSelectedSnapshots = new Map<string, DesktopRoomSnapshot>();
  let nextSelectedSnapshotCacheAlias: string | null | undefined;
  let skipNextSelectedSnapshotCache = false;
  let streamReconcileGeneration = 0;
  let streamReconcileRoom: string | null = null;
  let activeStreamRoom: string | null = null;
  let activeStreamToken = 0;
  let bufferedStreamEvents: DesktopRoomStreamEvent[] = [];
  let bufferedStreamEventBytes = 0;
  let streamBufferOverflow = false;
  const degradedStreamRooms = new Map<string, number>();
  const pendingVerifiedRecoveries = new Map<string, number>();
  const pendingDeliveryRepairs = new Map<string, PendingDeliveryRepairState>();

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
      baseline: snapshotMatchesRoom(options.selectedSnapshot.value, roomIdentifier)
        ? options.selectedSnapshot.value
        : null,
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

  async function repairManagedAgentDeliveryFromSnapshot(
    roomIdentifier: string,
    previousSnapshot: DesktopRoomSnapshot | null,
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
    const baseline = pending.baseline
      || (snapshotMatchesRoom(previousSnapshot, roomIdentifier) ? previousSnapshot : null);
    if (baseline && !pending.baseline) pending.baseline = baseline;
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
      await desktopIpc.room.repairStreamDelivery(roomIdentifier, {
        token,
        ...(baseline
          ? buildRoomStreamDeliveryRepair(baseline, repairedSnapshot)
          : { messages: repairedSnapshot.messages, tasks: repairedSnapshot.tasks }),
      });
      if (pendingDeliveryRepairs.get(roomKey) === pending) {
        clearPendingDeliveryRepair(roomKey);
      }
      return true;
    } catch {
      // Keep the broker cursor uncommitted and retry this same repair token.
      // The main-process delivery tracker makes repeated handoffs idempotent.
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

    options.loading.value = true;
    let rootBarrierToken: number | null = null;
    try {
      const requestedRootRoomIdentifier = options.selectedRootRoomIdentifier.value;
      const requestedRootPath = selectedRootPath();
      const preloadedRepoStatus = requestedRootRoomIdentifier
        ? null
        : await desktopIpc.repos.getStatus(requestedRootPath);
      const barrierRoomIdentifier = requestedRootRoomIdentifier || preloadedRepoStatus?.roomIdentifier || null;
      if (barrierRoomIdentifier) {
        rootBarrierToken = await beginRoomSnapshotBarrier(barrierRoomIdentifier);
      }
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
      const nextAccountRooms = (nextSettingsAccountRooms || []).filter((room) => !room.archived);
      const nextRootRoomSnapshot = await recoverRootRoomSnapshot(
        requestedRootRoomIdentifier,
        loadedRootRoomContext.snapshot,
        nextAccountRooms || nextSettingsAccountRooms || [],
      );
      const nextRootRoomKey = normalizeRoomIdentifier(nextRootRoomSnapshot.roomIdentifier);
      await repairManagedAgentDeliveryFromSnapshot(
        nextRootRoomSnapshot.roomIdentifier || "",
        options.selectedSnapshot.value,
        nextRootRoomSnapshot,
        nextRootRoomKey ? pendingDeliveryRepairs.get(nextRootRoomKey)?.token ?? null : null,
      );
      const recoveredAlias = recoveredRootRoomAlias(requestedRootRoomIdentifier, nextRootRoomSnapshot);
      options.appInfo.value = nextAppInfo;
      options.repoStatus.value = loadedRootRoomContext.repoStatus;
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
        finishRoomSnapshotBarrier(nextRootRoomSnapshot.roomIdentifier, rootBarrierToken);
      }
      await refreshSelectedSnapshot(nextRootRoomSnapshot);
    } finally {
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
    const allAccountRooms =
      (await desktopIpc.room.listAccountRooms?.({ includeArchived: true, limit: 100 }).catch(() => [])) || [];
    options.settingsAccountRooms.value = allAccountRooms;
    options.accountRooms.value = allAccountRooms.filter((room) => !room.archived);
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

  async function refreshSelectedSnapshot(baseRootSnapshot: DesktopRoomSnapshot | null = options.rootRoomSnapshot.value): Promise<void> {
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
        setSelectedSnapshot(mergeRoomSnapshotMessages(options.selectedSnapshot.value, baseRootSnapshot));
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
      publishOptimisticSelectedSnapshot(requestId, selectedRoomEntry, roomIdentifier, baseRootSnapshot);
      try {
        const openedContext = await loadRootRoomContext({
          roomIdentifier,
          rootPath: rootPathForRoomIdentifier(roomIdentifier),
        });
        const nextRootSnapshot = openedContext.snapshot;
        const nextRepoStatus = openedContext.repoStatus;
        if (requestId !== selectedSnapshotRequestId || options.activeEntry.value.id !== selectedRoomEntry.id) return;
        options.repoStatus.value = nextRepoStatus;
        options.rootRoomSnapshot.value = nextRootSnapshot;
        setSelectedSnapshot(mergeRoomSnapshotMessages(options.selectedSnapshot.value, nextRootSnapshot), { cache: false });
        options.selectedRootRoomIdentifier.value = nextRootSnapshot.roomIdentifier;
        options.rememberRootRoomSnapshot(nextRootSnapshot, {
          aliasIdentifiers: [roomIdentifier, openedContext.openedRoom?.roomIdentifier],
          rootPath: openedContext.openedRoom?.repoPath || rootPathForRoomIdentifier(roomIdentifier),
          kind: openedContext.openedRoom ? "project" : null,
          meta: openedContext.openedRoom?.repoStatus?.branch || null,
        });
        options.activeEntry.value = options.currentParentRoom.value;
      } finally {
        if (requestId === selectedSnapshotRequestId) selectedSnapshotLoading.value = false;
      }
      return;
    }
    if (!roomIdentifier || roomIdentifier === baseRootSnapshot.roomIdentifier) {
      if (requestId === selectedSnapshotRequestId) {
        setSelectedSnapshot(mergeRoomSnapshotMessages(options.selectedSnapshot.value, baseRootSnapshot));
        selectedSnapshotLoading.value = false;
      }
      return;
    }

    const cachedSnapshot = readCachedSelectedSnapshot(roomIdentifier);
    if (cachedSnapshot) {
      setSelectedSnapshot(cachedSnapshot, { cacheAlias: roomIdentifier });
      selectedSnapshotLoading.value = false;
    } else {
      publishOptimisticSelectedSnapshot(requestId, selectedRoomEntry, roomIdentifier, baseRootSnapshot);
    }
    let barrierToken: number | null = null;
    try {
      barrierToken = await beginRoomSnapshotBarrier(roomIdentifier);
      const nextSnapshot = await getRoomSnapshot(roomIdentifier);
      if (requestId !== selectedSnapshotRequestId || options.activeEntry.value.id !== selectedRoomEntry.id) return;
      const roomKey = normalizeRoomIdentifier(roomIdentifier);
      await repairManagedAgentDeliveryFromSnapshot(
        roomIdentifier,
        options.selectedSnapshot.value,
        nextSnapshot,
        roomKey ? pendingDeliveryRepairs.get(roomKey)?.token ?? null : null,
      );
      if (requestId !== selectedSnapshotRequestId || options.activeEntry.value.id !== selectedRoomEntry.id) return;
      setSelectedSnapshot(mergeRoomSnapshotMessages(options.selectedSnapshot.value, nextSnapshot), { cacheAlias: roomIdentifier });
      finishRoomSnapshotBarrier(roomIdentifier, barrierToken);
    } finally {
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
      clearPendingDeliveryRepairs();
      degradedStreamRooms.clear();
    }
    const token = ++streamReconcileGeneration;
    activeStreamRoom = roomIdentifier;
    if (!preserveDegradedStream) activeStreamToken = token;
    streamReconcileRoom = roomIdentifier;
    resetBufferedStreamEvents();
    try {
      await options.syncRoomStream(roomIdentifier, null);
      return token;
    } catch (error) {
      releaseRoomSnapshotBarrier(roomIdentifier, token, false);
      throw error;
    }
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
      clearPendingDeliveryRepairs();
      await options.syncRoomStream(null);
      return;
    }
    if (normalizeRoomIdentifier(activeStreamRoom) !== roomKey) {
      const token = ++streamReconcileGeneration;
      activeStreamRoom = roomIdentifier;
      activeStreamToken = token;
      streamReconcileRoom = null;
      resetBufferedStreamEvents();
      degradedStreamRooms.clear();
      pendingVerifiedRecoveries.clear();
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
        pendingVerifiedRecoveries.set(roomKey, activeStreamToken);
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
      setSelectedSnapshot(appendSnapshotMessage(options.selectedSnapshot.value, event.message));
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
      const previousSnapshot = options.selectedSnapshot.value;
      await repairManagedAgentDeliveryFromSnapshot(
        roomIdentifier,
        previousSnapshot,
        snapshot,
        deliveryRepairToken,
      );
      if (
        generation !== streamReconcileGeneration
        || normalizeRoomIdentifier(activeStreamRoom) !== roomKey
      ) return;
      setSelectedSnapshot(mergeRoomSnapshotMessages(options.selectedSnapshot.value, snapshot));
      const pending = streamBufferOverflow ? [] : bufferedStreamEvents;
      const overflowed = streamBufferOverflow;
      resetBufferedStreamEvents();
      streamReconcileRoom = null;
      for (const buffered of pending) handleRoomStreamEvent(buffered);
      if (overflowed) scheduleRoomStreamReconciliation(roomIdentifier);
      if (roomKey) {
        degradedStreamRooms.delete(roomKey);
        pendingVerifiedRecoveries.delete(roomKey);
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
    void refreshSelectedSnapshot().catch(() => undefined);
  }

  function handleRefreshRoom(snapshot?: DesktopRoomSnapshot): void {
    if (snapshot) {
      options.rootRoomSnapshot.value = snapshot;
      setSelectedSnapshot(snapshot);
      options.selectedRootRoomIdentifier.value = snapshot.roomIdentifier;
      options.rememberRootRoomSnapshot(snapshot);
      options.reconcileActiveEntry();
      options.scheduleLiveMetadataRefresh(0);
      return;
    }
    scheduleSelectedSnapshotRefresh();
    options.scheduleLiveMetadataRefresh(0);
  }

  function handleMessageSent(message: DesktopRoomMessage): void {
    const priorMessages = options.selectedSnapshot.value?.messages ?? [];
    setSelectedSnapshot(appendSnapshotMessage(options.selectedSnapshot.value, message));
    if (messageReferencesMissingThreadContext(message, priorMessages)) {
      options.scheduleLiveMetadataRefresh();
    }
  }

  async function refreshSelectedRoomArtifacts(roomIdentifier: string): Promise<void> {
    const artifacts = await desktopIpc.room.getArtifacts?.(roomIdentifier).catch(() => null);
    if (!artifacts) return;
    if (!snapshotMatchesRoom(options.selectedSnapshot.value, roomIdentifier)) return;
    setSelectedSnapshot(replaceSnapshotRoomArtifacts(options.selectedSnapshot.value, artifacts));
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
    input: { cache?: boolean; cacheAlias?: string | null } = {},
  ): void {
    const previousSnapshot = options.selectedSnapshot.value;
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
  }

  function readCachedSelectedSnapshot(roomIdentifier: string): DesktopRoomSnapshot | null {
    const cacheKey = selectedSnapshotCacheKey(roomIdentifier);
    if (!cacheKey) return null;
    const cachedSnapshot = cachedSelectedSnapshots.get(cacheKey) || null;
    if (!cachedSnapshot) return null;
    cachedSelectedSnapshots.delete(cacheKey);
    cachedSelectedSnapshots.set(cacheKey, cachedSnapshot);
    return cachedSnapshot;
  }

  function rememberCachedSelectedSnapshot(
    snapshot: DesktopRoomSnapshot | null,
    roomIdentifierAlias?: string | null,
  ): void {
    const cacheKey = selectedSnapshotCacheKey(roomIdentifierAlias || snapshot?.roomIdentifier || snapshot?.room?.identifier);
    if (!cacheKey) return;
    if (!snapshot || snapshot.access.status !== "ready" || snapshot.room?.kind !== "focus") {
      cachedSelectedSnapshots.delete(cacheKey);
      return;
    }
    cachedSelectedSnapshots.delete(cacheKey);
    cachedSelectedSnapshots.set(cacheKey, snapshot);
    while (cachedSelectedSnapshots.size > selectedSnapshotCacheLimit) {
      const oldestKey = cachedSelectedSnapshots.keys().next().value as string | undefined;
      if (!oldestKey) break;
      cachedSelectedSnapshots.delete(oldestKey);
    }
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

function selectedSnapshotCacheKey(roomIdentifier: string | null | undefined): string | null {
  return normalizeRoomIdentifier(roomIdentifier);
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
