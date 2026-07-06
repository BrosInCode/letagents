import type { RepoStatus } from "../ipc-types.js";

export interface RepoStatusWatchWindowState {
  isDestroyed(): boolean;
  isVisible(): boolean;
}

export function repoStatusWatchFingerprint(status: RepoStatus): string {
  return JSON.stringify({
    rootPath: status.rootPath,
    mainRootPath: status.mainRootPath || null,
    isGitRepo: Boolean(status.isGitRepo),
    gitHeadPath: status.gitHeadPath || null,
    head: status.head || null,
    branch: status.branch || null,
    detached: Boolean(status.detached),
    defaultBranch: status.defaultBranch || null,
    upstream: status.upstream || null,
    ahead: status.ahead || 0,
    behind: status.behind || 0,
    changes: status.changes || null,
    branchDelta: status.branchDelta || null,
    branchDeltas: status.branchDeltas || [],
    dirty: Boolean(status.dirty),
    roomIdentifier: status.roomIdentifier || null,
    roomSource: status.roomSource || null,
    worktrees: status.worktrees.map((worktree) => ({
      path: worktree.path,
      branch: worktree.branch || null,
      head: worktree.head,
      isCurrent: Boolean(worktree.isCurrent),
      isMain: Boolean(worktree.isMain),
    })),
  });
}

export function repoStatusChanged(previousFingerprint: string | null, status: RepoStatus): boolean {
  return previousFingerprint !== repoStatusWatchFingerprint(status);
}

export function shouldPauseRepoStatusRefreshForWindow(
  window: RepoStatusWatchWindowState | null | undefined,
): boolean {
  return Boolean(window && !window.isDestroyed() && !window.isVisible());
}

export function shouldScheduleRepoStatusRefreshForWindow(
  window: RepoStatusWatchWindowState | null | undefined,
): boolean {
  return !shouldPauseRepoStatusRefreshForWindow(window);
}
