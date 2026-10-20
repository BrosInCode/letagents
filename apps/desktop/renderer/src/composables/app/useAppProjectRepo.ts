import { watch } from "vue";
import type { RepoStatus } from "../../../../electron/ipc-types";
import { preserveRoomRepoStatistics } from "../../domain/repo-status";
import { activeRepoRoomContext, resolveActiveProjectRootPath } from "../../domain/room-project-context";
import { openManagedAgentWorktree } from "../../domain/managed-agent-worktrees";
import { desktopIpc } from "../../ipc/index.js";
import type { AppContextOf } from "./context";

/** The local project behind the active room: bindings, Git status watch, and opening its Git Room. */
export function useAppProjectRepo(context: unknown) {
  const app = context as AppContextOf<
      "useAppNavigation"
    | "useAppRoomContext"
    | "useAppState"
    | "appVuePending"
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

  async function initializeProjectBindings(): Promise<void> {
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
    initializeProjectBindings, restartRepoStatusWatch, handleRepoStatusChanged,
    openWorkspaceGitRoom, connectActiveRoomProject, openWorktreeForAgent,
  };
}

/** Follow the active project's Git status and bindings. */
export function useAppProjectRepoWatchers(context: unknown) {
  const app = context as AppContextOf<"useAppProjectRepo" | "useAppState">;
  const {
    activeProjectRootPath, recentRootRooms, refreshProjectBindings, restartRepoStatusWatch,
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
    void refreshProjectBindings();
  });
}
