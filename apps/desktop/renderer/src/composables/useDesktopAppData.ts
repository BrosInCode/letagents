import { computed, ref, type ComputedRef, type Ref } from "vue";
import type {
  DesktopAccountRoomEntry,
  DesktopAppInfo,
  DesktopAuthStatus,
  DesktopMcpInstallState,
  DesktopMcpInstallTargetId,
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
  upsertSnapshotTask,
} from "../domain/desktop-room-snapshots";
import { defaultMcpTargetSelection } from "../domain/mcp-install";
import { normalizeRoomIdentifier, type RecentRootRoom, type RecentRootRoomKind } from "../domain/sidebar-rooms";

interface RememberRootRoomOptions {
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

export function useDesktopAppData(options: DesktopAppDataOptions) {
  let selectedSnapshotRequestId = 0;
  const selectedSnapshotLoading = ref(false);

  async function refresh(): Promise<void> {
    if (options.mcpInstallState.value && !options.mcpInstallState.value.completed) {
      return;
    }

    options.loading.value = true;
    try {
      const [
        nextAppInfo,
        nextRepoStatus,
        nextWorkers,
        nextRootRoomSnapshot,
        nextDiagnostics,
        nextAuthStatus,
        nextMcpInstallState,
        nextAccountRooms,
        nextSettingsAccountRooms,
      ] = await Promise.all([
        window.letagentsDesktop.app.getInfo(),
        window.letagentsDesktop.repos.getStatus(selectedRootPath()),
        window.letagentsDesktop.workers.list(),
        window.letagentsDesktop.room.getSnapshot(options.selectedRootRoomIdentifier.value),
        window.letagentsDesktop.diagnostics.getSnapshot(),
        window.letagentsDesktop.auth.getStatus(),
        window.letagentsDesktop.setup.getMcpInstallState(),
        window.letagentsDesktop.room.listAccountRooms?.({ limit: 100 }).catch(() => []),
        window.letagentsDesktop.room.listAccountRooms?.({ includeArchived: true, limit: 100 }).catch(() => []),
      ]);
      options.appInfo.value = nextAppInfo;
      options.repoStatus.value = nextRepoStatus;
      options.workers.value = nextWorkers;
      options.rootRoomSnapshot.value = nextRootRoomSnapshot;
      options.selectedRootRoomIdentifier.value = nextRootRoomSnapshot.roomIdentifier;
      options.rememberRootRoomSnapshot(nextRootRoomSnapshot);
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

  async function refreshAccountRooms(): Promise<void> {
    const [nextAccountRooms, nextSettingsAccountRooms] = await Promise.all([
      window.letagentsDesktop.room.listAccountRooms?.({ limit: 100 }).catch(() => []),
      window.letagentsDesktop.room.listAccountRooms?.({ includeArchived: true, limit: 100 }).catch(() => []),
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
        options.selectedSnapshot.value = null;
        selectedSnapshotLoading.value = false;
      }
      return;
    }

    if (options.activeEntry.value.type !== "room") {
      if (requestId === selectedSnapshotRequestId) {
        options.selectedSnapshot.value = mergeRoomSnapshotMessages(options.selectedSnapshot.value, baseRootSnapshot);
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
        const [nextRootSnapshot, nextRepoStatus] = await Promise.all([
          window.letagentsDesktop.room.getSnapshot(roomIdentifier),
          window.letagentsDesktop.repos.getStatus(rootPathForRoomIdentifier(roomIdentifier)),
        ]);
        if (requestId !== selectedSnapshotRequestId || options.activeEntry.value.id !== selectedRoomEntry.id) return;
        options.repoStatus.value = nextRepoStatus;
        options.rootRoomSnapshot.value = nextRootSnapshot;
        options.selectedSnapshot.value = mergeRoomSnapshotMessages(options.selectedSnapshot.value, nextRootSnapshot);
        options.selectedRootRoomIdentifier.value = nextRootSnapshot.roomIdentifier;
        options.rememberRootRoomSnapshot(nextRootSnapshot);
        options.activeEntry.value = options.currentParentRoom.value;
      } finally {
        if (requestId === selectedSnapshotRequestId) selectedSnapshotLoading.value = false;
      }
      return;
    }
    if (!roomIdentifier || roomIdentifier === baseRootSnapshot.roomIdentifier) {
      if (requestId === selectedSnapshotRequestId) {
        options.selectedSnapshot.value = mergeRoomSnapshotMessages(options.selectedSnapshot.value, baseRootSnapshot);
        selectedSnapshotLoading.value = false;
      }
      return;
    }

    publishOptimisticSelectedSnapshot(requestId, selectedRoomEntry, roomIdentifier, baseRootSnapshot);
    try {
      const nextSnapshot = await window.letagentsDesktop.room.getSnapshot(roomIdentifier);
      if (requestId !== selectedSnapshotRequestId || options.activeEntry.value.id !== selectedRoomEntry.id) return;
      options.selectedSnapshot.value = mergeRoomSnapshotMessages(options.selectedSnapshot.value, nextSnapshot);
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
    selectedSnapshotLoading.value = true;
    options.selectedSnapshot.value = createOptimisticSelectedSnapshot(entry, roomIdentifier, baseRootSnapshot);
  }

  function upsertSelectedTask(task: DesktopTaskSummary): void {
    options.selectedSnapshot.value = upsertSnapshotTask(options.selectedSnapshot.value, task);
  }

  function handleRoomStreamEvent(event: DesktopRoomStreamEvent): void {
    if (!snapshotMatchesRoom(options.selectedSnapshot.value, event.roomIdentifier)) return;

    if (event.type === "open") {
      options.scheduleLiveMetadataRefresh(0);
      return;
    }

    if (event.type === "message") {
      options.selectedSnapshot.value = appendSnapshotMessage(options.selectedSnapshot.value, event.message);
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

    if (event.type === "reasoning_update") {
      options.selectedSnapshot.value = upsertSnapshotReasoningSession(options.selectedSnapshot.value, event.session);
      options.scheduleLiveMetadataRefresh();
      return;
    }

    if (event.type === "reasoning_remove") {
      options.selectedSnapshot.value = removeSnapshotReasoningSession(options.selectedSnapshot.value, event.sessionId);
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

  function handleRefreshRoom(): void {
    void refreshSelectedSnapshot();
    options.scheduleLiveMetadataRefresh(0);
  }

  function handleMessageSent(message: DesktopRoomMessage): void {
    options.selectedSnapshot.value = appendSnapshotMessage(options.selectedSnapshot.value, message);
    options.scheduleLiveMetadataRefresh();
  }

  function handleRoomRenamed(room: DesktopRoomInfo): void {
    if (!options.selectedSnapshot.value) return;
    options.selectedSnapshot.value = {
      ...options.selectedSnapshot.value,
      room,
      roomIdentifier: room.identifier,
    };
    if (options.rootRoomSnapshot.value && roomSnapshotsMatch(options.rootRoomSnapshot.value, options.selectedSnapshot.value)) {
      options.rootRoomSnapshot.value = {
        ...options.rootRoomSnapshot.value,
        room,
        roomIdentifier: room.identifier,
      };
    }
  }

  async function loadFirstRunRoomContext(): Promise<void> {
    try {
      const [nextAppInfo, nextRepoStatus, nextRootRoomSnapshot] = await Promise.all([
        window.letagentsDesktop.app.getInfo(),
        window.letagentsDesktop.repos.getStatus(selectedRootPath()),
        window.letagentsDesktop.room.getSnapshot(options.selectedRootRoomIdentifier.value),
      ]);
      options.appInfo.value = nextAppInfo;
      options.repoStatus.value = nextRepoStatus;
      options.rootRoomSnapshot.value = nextRootRoomSnapshot;
      options.selectedSnapshot.value = nextRootRoomSnapshot;
      options.selectedRootRoomIdentifier.value = nextRootRoomSnapshot.roomIdentifier;
      options.rememberRootRoomSnapshot(nextRootRoomSnapshot);
      options.reconcileActiveEntry();
    } catch {
      // First-run should still be usable if room preview is unavailable before auth.
    }
  }

  const repoStatusValue = computed<RepoStatus>(() => options.repoStatus.value || {
    rootPath: options.appInfo.value?.workspaceRoot || "",
    branch: null,
    worktrees: [],
  });

  return {
    handleMessageSent,
    handleRefreshRoom,
    handleRoomRenamed,
    handleRoomStreamEvent,
    loadFirstRunRoomContext,
    refresh,
    refreshAccountRooms,
    refreshSelectedSnapshot,
    repoStatusValue,
    selectedSnapshotLoading,
    upsertSelectedTask,
  };
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
      concludedAt: focusRoom?.concludedAt || null,
      conclusionSummary: focusRoom?.conclusionSummary || null,
      conclusionDetails: focusRoom?.conclusionDetails || null,
    },
    focusRooms: [],
    tasks: [],
    participants: [],
    participantHiddenCount: 0,
    presence: [],
    reasoningSessions: [],
    recentActivity: [],
    messages: [],
  };
}
