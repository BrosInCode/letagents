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
  mergeRoomSnapshotMessages,
  removeSnapshotReasoningSession,
  roomSnapshotsMatch,
  shouldRefreshMetadataForMessage,
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
  workers: Ref<WorkerSnapshot[]>;
}

const selectedSnapshotCacheLimit = 8;

export function useDesktopAppData(options: DesktopAppDataOptions) {
  let selectedSnapshotRequestId = 0;
  const selectedSnapshotLoading = ref(false);
  const cachedSelectedSnapshots = new Map<string, DesktopRoomSnapshot>();
  let nextSelectedSnapshotCacheAlias: string | null | undefined;
  let skipNextSelectedSnapshotCache = false;

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
    try {
      const requestedRootRoomIdentifier = options.selectedRootRoomIdentifier.value;
      const requestedRootPath = selectedRootPath();
      const [
        nextAppInfo,
        loadedRootRoomContext,
        nextWorkers,
        nextDiagnostics,
        nextAuthStatus,
        nextMcpInstallState,
        nextAccountRooms,
        nextSettingsAccountRooms,
      ] = await Promise.all([
        desktopIpc.app.getInfo(),
        loadRootRoomContext({
          roomIdentifier: requestedRootRoomIdentifier,
          rootPath: requestedRootPath,
        }),
        desktopIpc.workers.list(),
        desktopIpc.diagnostics.getSnapshot(),
        desktopIpc.auth.getStatus(),
        desktopIpc.setup.getMcpInstallState(),
        desktopIpc.room.listAccountRooms?.({ limit: 100 }).catch(() => []),
        desktopIpc.room.listAccountRooms?.({ includeArchived: true, limit: 100 }).catch(() => []),
      ]);
      const nextRootRoomSnapshot = await recoverRootRoomSnapshot(
        requestedRootRoomIdentifier,
        loadedRootRoomContext.snapshot,
        nextAccountRooms || nextSettingsAccountRooms || [],
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
      options.accountRooms.value = nextAccountRooms || [];
      options.settingsAccountRooms.value = nextSettingsAccountRooms || nextAccountRooms || [];
      options.selectedMcpTargetIds.value = options.selectedMcpTargetIds.value.length
        ? options.selectedMcpTargetIds.value
        : defaultMcpTargetSelection(nextMcpInstallState);
      options.reconcileActiveEntry();
      await refreshSelectedSnapshot(nextRootRoomSnapshot);
    } finally {
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
      const recoveredSnapshot = await desktopIpc.room.getSnapshot(accountRoomIdentifier);
      if (recoveredSnapshot.access.status === "ready") return recoveredSnapshot;
    }

    const workspaceSnapshot = await desktopIpc.room.getSnapshot(null);
    return workspaceSnapshot.access.status === "ready"
      ? workspaceSnapshot
      : snapshot;
  }

  async function loadRootRoomContext(input: {
    roomIdentifier: string | null;
    rootPath: string | null;
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
      desktopIpc.repos.getStatus(input.rootPath),
      desktopIpc.room.getSnapshot(input.roomIdentifier),
    ]);
    return {
      snapshot,
      repoStatus,
      openedRoom: null,
    };
  }

  async function refreshAccountRooms(): Promise<void> {
    const [nextAccountRooms, nextSettingsAccountRooms] = await Promise.all([
      desktopIpc.room.listAccountRooms?.({ limit: 100 }).catch(() => []),
      desktopIpc.room.listAccountRooms?.({ includeArchived: true, limit: 100 }).catch(() => []),
    ]);
    options.accountRooms.value = nextAccountRooms || [];
    options.settingsAccountRooms.value = nextSettingsAccountRooms || nextAccountRooms || [];
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
    try {
      const nextSnapshot = await desktopIpc.room.getSnapshot(roomIdentifier);
      if (requestId !== selectedSnapshotRequestId || options.activeEntry.value.id !== selectedRoomEntry.id) return;
      setSelectedSnapshot(mergeRoomSnapshotMessages(options.selectedSnapshot.value, nextSnapshot), { cacheAlias: roomIdentifier });
    } finally {
      if (requestId === selectedSnapshotRequestId) selectedSnapshotLoading.value = false;
    }
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
    if (!snapshotMatchesRoom(options.selectedSnapshot.value, event.roomIdentifier)) return;

    if (event.type === "open") {
      options.scheduleLiveMetadataRefresh(0);
      return;
    }

    if (event.type === "message") {
      setSelectedSnapshot(appendSnapshotMessage(options.selectedSnapshot.value, event.message));
      if (shouldRefreshMetadataForMessage(event.message)) {
        options.scheduleLiveMetadataRefresh();
      }
      return;
    }

    if (event.type === "task_update") {
      upsertSelectedTask(event.task);
      options.scheduleLiveMetadataRefresh();
      return;
    }

    if (event.type === "github_event") {
      setSelectedSnapshot(upsertSnapshotGitHubEvent(options.selectedSnapshot.value, event.event));
      options.scheduleLiveMetadataRefresh();
      return;
    }

    if (event.type === "artifact_update") {
      if (event.artifact) {
        setSelectedSnapshot(upsertSnapshotRoomArtifact(options.selectedSnapshot.value, event.artifact));
      }
      options.scheduleLiveMetadataRefresh();
      return;
    }

    if (event.type === "reasoning_update") {
      setSelectedSnapshot(upsertSnapshotReasoningSession(options.selectedSnapshot.value, event.session));
      options.scheduleLiveMetadataRefresh();
      return;
    }

    if (event.type === "reasoning_remove") {
      setSelectedSnapshot(removeSnapshotReasoningSession(options.selectedSnapshot.value, event.sessionId));
      options.scheduleLiveMetadataRefresh();
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
    void refreshSelectedSnapshot();
    options.scheduleLiveMetadataRefresh(0);
  }

  function handleMessageSent(message: DesktopRoomMessage): void {
    setSelectedSnapshot(appendSnapshotMessage(options.selectedSnapshot.value, message));
    options.scheduleLiveMetadataRefresh();
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
  };
}
