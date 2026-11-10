import { watch } from "vue";
import type { RepoStatus } from "../../../../electron/ipc-types";
import { preserveRoomRepoStatistics } from "../../domain/repo-status";
import { activeRepoRoomContext, canonicalRepoIdentity, resolveActiveProjectRootPath } from "../../domain/room-project-context";
import { openManagedAgentWorktree } from "../../domain/managed-agent-worktrees";
import { readStoredString } from "../../domain/desktop-storage";
import type { RecentRootRoom } from "../../domain/sidebar-rooms";
import { desktopIpc } from "../../ipc/index.js";
import type { AppContextOf } from "./context";

/**
 * Whether the room a cold start opens can show project state, which comes
 * only from a project binding. Such a room waits for the binding migration;
 * without its binding it would show "Connect this room to its local project".
 *
 * A room needs no binding to open when it is a plain room: a remembered room
 * of kind "room" with no folder, not a migration candidate, and with an
 * identifier that cannot name a Git Room (no "/", no ":", not a local folder
 * room). Anything unknown waits, as before. The stored active entry counts
 * too, because the startup refresh shows it: a plain root room's own entry
 * or a non-room view does not wait; a focus or project entry waits.
 */
export function startupRoomNeedsProjectBindings(input: {
  rootRoomIdentifier: string | null;
  activeEntryId: string | null;
  recentRootRooms: readonly RecentRootRoom[];
  legacyRootBindings: Readonly<Record<string, string>>;
}): boolean {
  const legacyKeys = new Set(Object.keys(input.legacyRootBindings).map((key) => canonicalRepoIdentity(key)));
  const isPlainRoom = (identifier: string | null | undefined): boolean => {
    const normalized = identifier?.trim().toLowerCase();
    if (!normalized || /[/:]/.test(normalized) || /^local-/.test(normalized)) return false;
    if (legacyKeys.has(canonicalRepoIdentity(normalized))) return false;
    const recent = input.recentRootRooms.find((room) => room.identifier.trim().toLowerCase() === normalized);
    return Boolean(recent && recent.kind === "room" && !recent.rootPath);
  };
  if (!isPlainRoom(input.rootRoomIdentifier)) return true;
  const entryId = input.activeEntryId?.trim();
  if (!entryId) return false;
  if (entryId.startsWith("room:parent:")) {
    try {
      return !isPlainRoom(decodeURIComponent(entryId.slice("room:parent:".length)));
    } catch {
      return true;
    }
  }
  return entryId.startsWith("room:") || entryId.startsWith("project:");
}

/** The local project behind the active room: bindings, Git status watch, and opening its Git Room. */
export function useAppProjectRepo(context: unknown) {
  const app = context as AppContextOf<
      "useAppNavigation"
    | "useAppRoomContext"
    | "useAppSetupOnboarding"
    | "useAppState"
  >;
  const {
    authStatus, legacyRepositoryRootBindings, legacyRepositoryRootBindingsStorageKey, loading,
    openAddAgentAfterRepoPick, projectBindings, recentRootRooms, repoStatus, rootRoomSnapshot,
    selectedRootRoomIdentifier, sessionGeneration,
  } = app;
  let repoStatusRefreshInFlight = false;
  let repoStatusWatchRootPath: string | null = null;
  let repoStatusWatchRequestId = 0;

  async function refreshActiveRepoStatus(): Promise<void> {
    if (app.showFirstRunGate.value || !authStatus.value?.authenticated || repoStatusRefreshInFlight) return;
    const rootPath = activeProjectRootPath();
    if (!rootPath) return;
    repoStatusRefreshInFlight = true;
    const generation = sessionGeneration.value;
    try {
      const nextRepoStatus = await desktopIpc.repos.getStatus(rootPath).catch(() => null);
      if (generation === sessionGeneration.value && authStatus.value?.authenticated && nextRepoStatus) {
        repoStatus.value = nextRepoStatus;
      }
    } finally {
      repoStatusRefreshInFlight = false;
    }
  }

  function activeProjectRootPath(): string | null {
    // Derive the project context from the sidebar group that actually contains the
    // active room, NOT the last-opened global root snapshot (which can be a stale,
    // unrelated non-repo room). This is what keeps a focus room attached to its
    // real repo project. Fall back to the global root only when the active entry is
    // in no repo-backed group.
    const context = activeRepoRoomContext(app.activeEntry.value?.id, app.projectEntries.value);
    // Presence-based, not nullish: if the active room IS in a group, that group is
    // authoritative even when it's a non-repo group (null identifier/gitRoom) — a
    // grouped non-repo room must not inherit a stale repo snapshot. Fall back to the
    // global root only when the active entry is in no group at all.
    return resolveActiveProjectRootPath({
      activeRootIdentifier: context
        ? context.roomIdentifier
        : selectedRootRoomIdentifier.value ?? rootRoomSnapshot.value?.roomIdentifier,
      activeRootGitRoom: context
        ? context.gitRoom
        : rootRoomSnapshot.value?.room?.gitRoom ?? null,
      projectBindings: projectBindings.value,
    });
  }

  async function refreshProjectBindings(): Promise<void> {
    if (!desktopIpc.repos?.listProjectBindings) return;
    const generation = sessionGeneration.value;
    const nextBindings = await desktopIpc.repos.listProjectBindings().catch(() => projectBindings.value);
    if (generation !== sessionGeneration.value) return;
    projectBindings.value = nextBindings;
  }

  /** Set when the startup migration starts; it ends with a full binding list. */
  let startupMigration: Promise<void> | null = null;

  /**
   * The startup room load replaces the recent rooms. Before the migration has
   * started, its own final list sees that change, so no extra (Git) list runs
   * beside the first room load. While it runs, list once after it.
   */
  function refreshProjectBindingsAfterRecentRoomsChange(): void {
    if (!startupMigration) return;
    void startupMigration.then(refreshProjectBindings);
  }

  function startupRoomNeedsBindings(): boolean {
    return startupRoomNeedsProjectBindings({
      rootRoomIdentifier: selectedRootRoomIdentifier.value,
      activeEntryId: readStoredString(app.activeEntryStorageKey),
      recentRootRooms: recentRootRooms.value,
      legacyRootBindings: legacyRepositoryRootBindings,
    });
  }

  function initializeProjectBindings(): Promise<void> {
    startupMigration ??= migrateProjectBindings().catch(() => undefined);
    return startupMigration;
  }

  async function migrateProjectBindings(): Promise<void> {
    const generation = sessionGeneration.value;
    if (!desktopIpc.repos?.migrateProjectBindings) {
      await refreshProjectBindings();
      return;
    }
    const candidates = [
      ...Object.entries(legacyRepositoryRootBindings).map(([roomIdentifier, rootPath]) => ({
        legacyKey: roomIdentifier,
        context: { roomIdentifier },
        rootPath,
      })),
      ...recentRootRooms.value.flatMap((room) => room.rootPath ? [{
        context: { roomIdentifier: room.identifier },
        rootPath: room.rootPath,
      }] : []),
    ];
    try {
      const migration = await desktopIpc.repos.migrateProjectBindings(candidates);
      if (generation !== sessionGeneration.value) return;
      projectBindings.value = migration.bindings;
      const retryBindings = Object.fromEntries(
        migration.retryLegacyKeys.flatMap((key) => {
          const rootPath = legacyRepositoryRootBindings[key];
          return rootPath ? [[key, rootPath]] : [];
        }),
      );
      if (Object.keys(retryBindings).length) {
        window.localStorage.setItem(
          legacyRepositoryRootBindingsStorageKey,
          JSON.stringify(retryBindings),
        );
      } else {
        window.localStorage.removeItem(legacyRepositoryRootBindingsStorageKey);
      }
    } catch {
      if (generation !== sessionGeneration.value) return;
      await refreshProjectBindings();
    }
  }

  async function restartRepoStatusWatch(rootPath: string | null): Promise<void> {
    if (!desktopIpc.repos?.startStatusWatch) return;
    const nextRootPath = rootPath?.trim() || null;
    if (repoStatusWatchRootPath === nextRootPath) return;
    const requestId = ++repoStatusWatchRequestId;
    repoStatusWatchRootPath = nextRootPath;
    await desktopIpc.repos.stopStatusWatch?.().catch(() => undefined);
    if (requestId !== repoStatusWatchRequestId || repoStatusWatchRootPath !== nextRootPath) return;
    if (!nextRootPath) return;
    const nextStatus = await desktopIpc.repos.startStatusWatch(nextRootPath).catch(() => null);
    if (requestId === repoStatusWatchRequestId && nextStatus && activeProjectRootPath() === nextRootPath) {
      repoStatus.value = nextStatus;
    }
  }

  function handleRepoStatusChanged(nextStatus: RepoStatus): void {
    const rootPath = activeProjectRootPath();
    if (rootPath && nextStatus.rootPath !== rootPath) return;
    repoStatus.value = nextStatus;
  }

  async function openWorkspaceGitRoom(rootPathOverride?: string): Promise<boolean> {
    const rootPath = rootPathOverride || repoStatus.value?.rootPath || activeProjectRootPath();
    if (!rootPath) return false;
    loading.value = true;
    try {
      const selection = await desktopIpc.repos.openRoom(rootPath);
      if (selection.error || !selection.snapshot) {
        return false;
      }
      if (selection.repoStatus) {
        repoStatus.value = preserveRoomRepoStatistics(repoStatus.value, selection.repoStatus);
      }
      app.openRoomSnapshot(selection.snapshot, {
        aliasIdentifiers: [selection.roomIdentifier],
        rootPath: selection.repoPath || rootPath,
        kind: "project",
        meta: selection.repoStatus?.branch || null,
      });
      return true;
    } catch (error) {
      console.warn("Could not open the matching Git Room.", error);
      return false;
    } finally {
      loading.value = false;
    }
  }

  async function connectActiveRoomProject(): Promise<void> {
    const groupedContext = activeRepoRoomContext(app.activeEntry.value?.id, app.projectEntries.value);
    const context = groupedContext || {
      roomIdentifier: app.selectedRoomWithProjectContext.value.identifier,
      gitRoom: app.selectedRoomWithProjectContext.value.gitRoom,
    };
    if (!desktopIpc.repos?.connectProject) {
      app.pushActionToast("Restart LetAgents Desktop to connect this project.", "error");
      return;
    }
    const result = await desktopIpc.repos.connectProject(context).catch((error) => ({
      canceled: false,
      binding: null,
      repoStatus: null,
      error: error instanceof Error ? error.message : "LetAgents could not connect that project.",
    }));
    if (result.canceled) return;
    if (result.error || !result.binding) {
      app.pushActionToast(result.error || "LetAgents could not connect that project.", "error", 6_000);
      return;
    }
    await refreshProjectBindings();
    if (result.repoStatus) repoStatus.value = result.repoStatus;
    app.pushActionToast("This room is now connected to its local project.", "success");
  }

  async function openWorktreeForAgent(rootPath: string): Promise<void> {
    await openManagedAgentWorktree({
      rootPath,
      openWorkspaceGitRoom,
      setReopenAddAgent: (value) => {
        openAddAgentAfterRepoPick.value = value;
      },
    });
  }
  return {
    refreshActiveRepoStatus, activeProjectRootPath, refreshProjectBindings,
    initializeProjectBindings, refreshProjectBindingsAfterRecentRoomsChange, startupRoomNeedsBindings,
    restartRepoStatusWatch, handleRepoStatusChanged,
    openWorkspaceGitRoom, connectActiveRoomProject, openWorktreeForAgent,
  };
}

/** Follow the active project's Git status and bindings. */
export function useAppProjectRepoWatchers(context: unknown) {
  const app = context as AppContextOf<"useAppProjectRepo" | "useAppState">;
  const {
    activeProjectRootPath, recentRootRooms, refreshProjectBindingsAfterRecentRoomsChange,
    restartRepoStatusWatch,
  } = app;
  watch(
    () => activeProjectRootPath(),
    (rootPath) => {
      void restartRepoStatusWatch(rootPath);
    },
    { immediate: true }
  );

  // The list is only ever replaced, never edited in place, so an identity watch sees
  // every change without walking each room.
  watch(recentRootRooms, () => {
    refreshProjectBindingsAfterRecentRoomsChange();
  });
}
