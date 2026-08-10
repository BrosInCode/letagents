import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";

import type { RepoStatus } from "../ipc-types.js";
import {
  buildRepoStatus,
  refreshRepoStatus,
  type RepoStatusInvalidation,
} from "../repo-status.js";
import { runGitStdout } from "./git-exec.js";
import {
  repoStatusChanged,
  repoStatusWatchFingerprint,
  shouldScheduleRepoStatusRefreshForWindow,
  type RepoStatusWatchWindowState,
} from "./repo-status-watch-state.js";
import { emitToMainWindow, getMainWindow } from "./window.js";

const repoStatusReconciliationMs = 60_000;
const repoStatusChangeDebounceMs = 250;

type RepoStatusWatchHooks = {
  buildRepoStatus: typeof buildRepoStatus;
  refreshRepoStatus: typeof refreshRepoStatus;
  emitToMainWindow: typeof emitToMainWindow;
  getMainWindow: () => RepoStatusWatchWindowState | null;
};

type RepoStatusWatchTarget = {
  path: string;
  recursive: boolean;
  invalidation: RepoStatusInvalidation;
  workingTree: boolean;
  gitDirectory: boolean;
  reopenOnRename: boolean;
};

type ActiveRepoStatusWatch = {
  abortController: AbortController;
  rootPath: string;
  status: RepoStatus;
  watchTargetsKey: string;
  watchers: FSWatcher[];
  watchersNeedReopen: boolean;
  debounceTimer: NodeJS.Timeout | null;
  intervalTimer: NodeJS.Timeout | null;
  refreshInFlight: Promise<void> | null;
  pendingInvalidation: RepoStatusInvalidation | null;
  idlePromise: Promise<void> | null;
  resolveIdle: (() => void) | null;
  lastStatusFingerprint: string | null;
  windowState: RepoStatusWatchWindowState | null;
  windowResumeListener: (() => void) | null;
};

const defaultRepoStatusWatchHooks: RepoStatusWatchHooks = {
  buildRepoStatus,
  refreshRepoStatus,
  emitToMainWindow,
  getMainWindow,
};

let repoStatusWatchHooks = defaultRepoStatusWatchHooks;
let activeWatch: ActiveRepoStatusWatch | null = null;
let startingWatchAbortController: AbortController | null = null;
let watchRequestId = 0;

export async function startRepoStatusWatch(rootPath: string): Promise<RepoStatus> {
  const requestId = ++watchRequestId;
  closeActiveWatch();
  const abortController = new AbortController();
  startingWatchAbortController = abortController;
  let handedOff = false;

  try {
    const status = await repoStatusWatchHooks.buildRepoStatus(rootPath, {
      signal: abortController.signal,
    });
    abortController.signal.throwIfAborted();
    if (requestId !== watchRequestId) return status;

    const watchTargets = await repoStatusWatchTargets(status, abortController.signal);
    abortController.signal.throwIfAborted();
    if (requestId !== watchRequestId) return status;

    const watchState: ActiveRepoStatusWatch = {
      abortController,
      rootPath: status.rootPath || rootPath,
      status,
      watchTargetsKey: repoStatusWatchTargetsKey(watchTargets),
      watchers: [],
      watchersNeedReopen: false,
      debounceTimer: null,
      intervalTimer: null,
      refreshInFlight: null,
      pendingInvalidation: null,
      idlePromise: null,
      resolveIdle: null,
      lastStatusFingerprint: repoStatusWatchFingerprint(status),
      windowState: repoStatusWatchHooks.getMainWindow(),
      windowResumeListener: null,
    };
    activeWatch = watchState;
    handedOff = true;
    if (startingWatchAbortController === abortController) {
      startingWatchAbortController = null;
    }

    watchState.watchers = openWatchers(watchTargets, watchState);
    attachWindowResumeListener(watchState);
    watchState.intervalTimer = setInterval(() => {
      void requestRepoStatusRefresh(watchState, { full: true }, false);
    }, repoStatusReconciliationMs);

    // Listener installation is the race boundary. A full rebuild is intentional
    // here: incremental flags cannot repair a repository/layout change that
    // invalidated the initial root, gitdir, or HEAD path before listeners existed.
    void requestRepoStatusRefresh(watchState, { full: true }, false);
    // Await this first scan, not global queue idleness: a busy working tree may
    // keep contributing legitimate trailing invalidations indefinitely.
    const bootstrapRefresh = watchState.refreshInFlight;
    if (bootstrapRefresh) await bootstrapRefresh.catch(() => undefined);
    return activeWatch === watchState ? watchState.status : status;
  } finally {
    if (startingWatchAbortController === abortController) {
      startingWatchAbortController = null;
    }
    if (!handedOff) abortController.abort();
  }
}

export function stopRepoStatusWatch(): void {
  watchRequestId += 1;
  closeActiveWatch();
}

export function configureRepoStatusWatchForTest(
  hooks: Partial<RepoStatusWatchHooks>,
): () => void {
  repoStatusWatchHooks = {
    ...defaultRepoStatusWatchHooks,
    ...hooks,
  };
  return () => {
    repoStatusWatchHooks = defaultRepoStatusWatchHooks;
  };
}

export async function refreshActiveRepoStatusForTest(
  invalidation: RepoStatusInvalidation = { full: true },
): Promise<void> {
  if (!activeWatch) return;
  await requestRepoStatusRefresh(activeWatch, invalidation, false);
}

export async function waitForActiveRepoStatusRefreshForTest(): Promise<void> {
  const watchState = activeWatch;
  if (!watchState || (!watchState.refreshInFlight && !watchState.debounceTimer)) return;
  await repoStatusIdlePromise(watchState);
}

function closeActiveWatch(): void {
  const startingController = startingWatchAbortController;
  startingWatchAbortController = null;
  startingController?.abort();
  const watchState = activeWatch;
  activeWatch = null;
  if (!watchState) return;
  watchState.abortController.abort();
  closeWatchers(watchState);
  detachWindowResumeListener(watchState);
  if (watchState.debounceTimer) clearTimeout(watchState.debounceTimer);
  if (watchState.intervalTimer) clearInterval(watchState.intervalTimer);
  watchState.debounceTimer = null;
  watchState.intervalTimer = null;
  watchState.pendingInvalidation = null;
  resolveRepoStatusIdle(watchState);
}

function closeWatchers(watchState: ActiveRepoStatusWatch): void {
  for (const watcher of watchState.watchers) {
    try {
      watcher.close();
    } catch {
      // Watcher cleanup must not interrupt app shutdown or repo switching.
    }
  }
  watchState.watchers = [];
}

function attachWindowResumeListener(watchState: ActiveRepoStatusWatch): void {
  if (!watchState.windowState?.on) return;
  const listener = () => {
    const pending = watchState.pendingInvalidation ?? { status: true };
    void requestRepoStatusRefresh(watchState, pending, true);
  };
  watchState.windowResumeListener = listener;
  watchState.windowState.on("show", listener);
  watchState.windowState.on("focus", listener);
}

function detachWindowResumeListener(watchState: ActiveRepoStatusWatch): void {
  const listener = watchState.windowResumeListener;
  if (!listener || !watchState.windowState?.off) return;
  watchState.windowState.off("show", listener);
  watchState.windowState.off("focus", listener);
  watchState.windowResumeListener = null;
}

function openWatchers(
  targets: readonly RepoStatusWatchTarget[],
  watchState: ActiveRepoStatusWatch,
): FSWatcher[] {
  const watchers: FSWatcher[] = [];
  for (const target of targets) {
    try {
      const listener = (eventType: string, filename: string | Buffer | null) => {
        const invalidation = classifyWatchEvent(target, filename);
        if (!invalidation) return;
        if (eventType === "rename" && target.reopenOnRename) {
          // File targets may be atomically replaced. Re-open descriptors after
          // the resulting refresh so the watcher follows the new inode.
          watchState.watchersNeedReopen = true;
        }
        void requestRepoStatusRefresh(watchState, invalidation, true);
      };
      let watcher: FSWatcher;
      try {
        watcher = watch(
          target.path,
          { persistent: false, recursive: target.recursive },
          listener,
        );
      } catch (error) {
        if (!target.recursive) throw error;
        // Older runtimes/platforms may not support recursive watching. Keep a
        // direct watcher and let the reconciliation pass cover nested misses.
        watcher = watch(target.path, { persistent: false }, listener);
      }
      watcher.on("error", () => {
        watchState.watchersNeedReopen = true;
        void requestRepoStatusRefresh(watchState, { full: true }, true);
      });
      watchers.push(watcher);
    } catch {
      // A missing/unsupported target is repaired by the reconciliation scan.
      watchState.watchersNeedReopen = true;
    }
  }
  return watchers;
}

function classifyWatchEvent(
  target: RepoStatusWatchTarget,
  filename: string | Buffer | null,
): RepoStatusInvalidation | null {
  const normalizedFilename = filename === null
    ? null
    : String(filename).replaceAll("\\", "/");
  if (target.workingTree) {
    // Git metadata has dedicated watchers. Ignoring it here prevents one commit
    // from also looking like an unrelated working-tree edit.
    if (normalizedFilename === ".git") {
      try {
        // In a linked worktree `.git` is a pointer file. Replacing it can move
        // every metadata target; in a main checkout it is merely the directory
        // whose nested events are handled by dedicated watchers.
        return statSync(join(target.path, ".git")).isFile() ? { full: true } : null;
      } catch {
        return { full: true };
      }
    }
    if (normalizedFilename?.startsWith(".git/")) return null;
    if (normalizedFilename === null || normalizedFilename.split("/").at(-1) === ".letagents.json") {
      return mergeRepoStatusInvalidation(target.invalidation, { static: true });
    }
  }
  if (!target.gitDirectory) return target.invalidation;
  if (normalizedFilename === null) {
    return { status: true, head: true, refs: true, worktrees: true, static: true };
  }
  switch (normalizedFilename.split("/").at(-1)) {
    case "index":
      return { status: true };
    case "HEAD":
      return { head: true };
    case "config":
      return { static: true };
    case "packed-refs":
    case "FETCH_HEAD":
      return { refs: true };
    case "worktrees":
      return { worktrees: true };
    case "rebase-merge":
    case "rebase-apply":
    case "MERGE_HEAD":
    case "CHERRY_PICK_HEAD":
      return { status: true, head: true };
    default:
      return null;
  }
}

export function classifyRepoStatusWatchEventForTest(input: {
  workingTree?: boolean;
  gitDirectory?: boolean;
  filename: string | null;
}): RepoStatusInvalidation | null {
  return classifyWatchEvent({
    path: "/repo",
    recursive: true,
    invalidation: { status: true },
    workingTree: Boolean(input.workingTree),
    gitDirectory: Boolean(input.gitDirectory),
    reopenOnRename: false,
  }, input.filename);
}

function mergeRepoStatusInvalidation(
  left: RepoStatusInvalidation | null,
  right: RepoStatusInvalidation,
): RepoStatusInvalidation {
  if (left?.full || right.full) return { full: true };
  return {
    status: Boolean(left?.status || right.status),
    head: Boolean(left?.head || right.head),
    refs: Boolean(left?.refs || right.refs),
    worktrees: Boolean(left?.worktrees || right.worktrees),
    static: Boolean(left?.static || right.static),
  };
}

function requestRepoStatusRefresh(
  watchState: ActiveRepoStatusWatch,
  invalidation: RepoStatusInvalidation,
  debounce: boolean,
): Promise<void> {
  if (activeWatch !== watchState) return Promise.resolve();
  watchState.pendingInvalidation = mergeRepoStatusInvalidation(
    watchState.pendingInvalidation,
    invalidation,
  );
  if (!shouldScheduleRepoStatusRefreshForWindow(repoStatusWatchHooks.getMainWindow())) {
    return Promise.resolve();
  }

  const idle = repoStatusIdlePromise(watchState);
  if (watchState.refreshInFlight) return idle;

  if (watchState.debounceTimer) {
    if (debounce) return idle;
    clearTimeout(watchState.debounceTimer);
    watchState.debounceTimer = null;
  }
  if (debounce) {
    watchState.debounceTimer = setTimeout(() => {
      watchState.debounceTimer = null;
      startRefreshQueue(watchState);
    }, repoStatusChangeDebounceMs);
  } else {
    startRefreshQueue(watchState);
  }
  return idle;
}

function startRefreshQueue(watchState: ActiveRepoStatusWatch): void {
  if (activeWatch !== watchState || watchState.refreshInFlight) return;
  if (!shouldScheduleRepoStatusRefreshForWindow(repoStatusWatchHooks.getMainWindow())) {
    resolveRepoStatusIdle(watchState);
    return;
  }
  const invalidation = watchState.pendingInvalidation;
  if (!invalidation) {
    resolveRepoStatusIdle(watchState);
    return;
  }
  watchState.pendingInvalidation = null;

  const refreshPromise = performRepoStatusRefresh(watchState, invalidation);
  watchState.refreshInFlight = refreshPromise;
  const finishRefresh = () => {
    if (watchState.refreshInFlight === refreshPromise) {
      watchState.refreshInFlight = null;
    }
    if (
      activeWatch === watchState
      && watchState.pendingInvalidation
      && shouldScheduleRepoStatusRefreshForWindow(repoStatusWatchHooks.getMainWindow())
    ) {
      startRefreshQueue(watchState);
      return;
    }
    resolveRepoStatusIdle(watchState);
  };
  void refreshPromise.then(finishRefresh, finishRefresh);
}

function resolveRepoStatusIdle(watchState: ActiveRepoStatusWatch): void {
  watchState.resolveIdle?.();
  watchState.idlePromise = null;
  watchState.resolveIdle = null;
}

function repoStatusIdlePromise(watchState: ActiveRepoStatusWatch): Promise<void> {
  if (!watchState.idlePromise) {
    watchState.idlePromise = new Promise<void>((resolveIdle) => {
      watchState.resolveIdle = resolveIdle;
    });
  }
  return watchState.idlePromise;
}

async function performRepoStatusRefresh(
  watchState: ActiveRepoStatusWatch,
  invalidation: RepoStatusInvalidation,
): Promise<void> {
  if (activeWatch !== watchState) return;
  const status = await repoStatusWatchHooks.refreshRepoStatus(
    watchState.rootPath,
    watchState.status,
    invalidation,
    { signal: watchState.abortController.signal },
  ).catch(() => null);
  if (!status || activeWatch !== watchState) return;
  watchState.status = status;

  if (shouldRefreshWatchTargets(invalidation) || watchState.watchersNeedReopen) {
    const nextWatchTargets = await repoStatusWatchTargets(
      status,
      watchState.abortController.signal,
    );
    if (activeWatch !== watchState) return;
    const nextWatchTargetsKey = repoStatusWatchTargetsKey(nextWatchTargets);
    if (watchState.watchersNeedReopen || nextWatchTargetsKey !== watchState.watchTargetsKey) {
      closeWatchers(watchState);
      watchState.watchTargetsKey = nextWatchTargetsKey;
      watchState.watchersNeedReopen = false;
      watchState.watchers = openWatchers(nextWatchTargets, watchState);
    }
  }

  if (!repoStatusChanged(watchState.lastStatusFingerprint, status)) return;
  watchState.lastStatusFingerprint = repoStatusWatchFingerprint(status);
  repoStatusWatchHooks.emitToMainWindow("desktop:repos:status-changed", status);
}

function shouldRefreshWatchTargets(invalidation: RepoStatusInvalidation): boolean {
  // Ref contents change often, but their watched directories do not. Rebuild
  // descriptors only when repository layout or the selected HEAD can move them.
  return Boolean(
    invalidation.full
    || invalidation.head
    || invalidation.worktrees
    || invalidation.static,
  );
}

async function repoStatusWatchTargets(
  status: RepoStatus,
  signal: AbortSignal,
): Promise<RepoStatusWatchTarget[]> {
  if (!status.isGitRepo || !status.rootPath) return [];
  const [
    indexPath,
    packedRefsPath,
    headsPath,
    remotesPath,
    worktreesPath,
    configPath,
    gitDirectoryPath,
    commonGitDirectoryPath,
    branchPath,
    upstreamPath,
  ] = await Promise.all([
    gitPath(status.rootPath, "index", signal),
    gitPath(status.rootPath, "packed-refs", signal),
    gitPath(status.rootPath, "refs/heads", signal),
    gitPath(status.rootPath, "refs/remotes", signal),
    gitPath(status.rootPath, "worktrees", signal),
    gitPath(status.rootPath, "config", signal),
    gitPath(status.rootPath, ".", signal),
    gitCommonDirectory(status.rootPath, signal),
    status.branch ? gitPath(status.rootPath, `refs/heads/${status.branch}`, signal) : null,
    status.upstream ? gitPath(status.rootPath, `refs/remotes/${status.upstream}`, signal) : null,
  ]);
  const linkedWorktreeMetadataTargets = worktreeMetadataTargets(worktreesPath);

  return coalesceWatchTargets([
    watchTarget(status.rootPath, true, { status: true }, { workingTree: true }),
    watchTarget(status.gitHeadPath, false, { head: true }),
    watchTarget(indexPath, false, { status: true }),
    watchTarget(packedRefsPath, false, { refs: true }),
    watchTarget(headsPath, true, { refs: true }),
    watchTarget(remotesPath, true, { refs: true }),
    // Child add/remove events install or retire the exact per-worktree metadata
    // watchers below. Keep this non-recursive so another worktree's index churn
    // does not broaden the selected worktree's cheap status refresh.
    watchTarget(worktreesPath, false, { worktrees: true, refs: true }),
    watchTarget(configPath, false, { static: true }),
    watchTarget(
      gitDirectoryPath,
      false,
      { head: true, refs: true, worktrees: true },
      { gitDirectory: true },
    ),
    watchTarget(
      commonGitDirectoryPath,
      false,
      { head: true, refs: true, worktrees: true },
      { gitDirectory: true },
    ),
    watchTarget(branchPath, false, { refs: true }),
    watchTarget(upstreamPath, false, { refs: true }),
    ...linkedWorktreeMetadataTargets.map(({ path, invalidation }) => (
      watchTarget(path, false, invalidation)
    )),
  ]);
}

function watchTarget(
  path: string | null | undefined,
  recursive: boolean,
  invalidation: RepoStatusInvalidation,
  options: {
    workingTree?: boolean;
    gitDirectory?: boolean;
  } = {},
): RepoStatusWatchTarget | null {
  if (!path) return null;
  const absolutePath = resolve(path);
  if (!existsSync(absolutePath)) return null;
  let reopenOnRename = false;
  try {
    reopenOnRename = statSync(absolutePath).isFile();
  } catch {
    return null;
  }
  return {
    path: absolutePath,
    recursive,
    invalidation,
    workingTree: Boolean(options.workingTree),
    gitDirectory: Boolean(options.gitDirectory),
    reopenOnRename,
  };
}

function coalesceWatchTargets(
  candidates: Array<RepoStatusWatchTarget | null>,
): RepoStatusWatchTarget[] {
  const targets = new Map<string, RepoStatusWatchTarget>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = `${candidate.path}\n${candidate.recursive ? "recursive" : "direct"}`;
    const existing = targets.get(key);
    if (!existing) {
      targets.set(key, candidate);
      continue;
    }
    existing.invalidation = mergeRepoStatusInvalidation(
      existing.invalidation,
      candidate.invalidation,
    );
    existing.workingTree ||= candidate.workingTree;
    existing.gitDirectory ||= candidate.gitDirectory;
    existing.reopenOnRename ||= candidate.reopenOnRename;
  }
  return [...targets.values()].sort((left, right) => (
    left.path.localeCompare(right.path) || Number(left.recursive) - Number(right.recursive)
  ));
}

function repoStatusWatchTargetsKey(targets: readonly RepoStatusWatchTarget[]): string {
  return targets.map((target) => JSON.stringify(target)).join("\n");
}

async function gitPath(
  repoRoot: string,
  relativeGitPath: string,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const stdout = await runGitStdout(
      repoRoot,
      ["rev-parse", "--git-path", relativeGitPath],
      { signal },
    );
    const path = stdout.trim();
    if (!path) return null;
    return resolve(repoRoot, path);
  } catch {
    signal.throwIfAborted();
    return null;
  }
}

async function gitCommonDirectory(
  repoRoot: string,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const stdout = await runGitStdout(repoRoot, ["rev-parse", "--git-common-dir"], { signal });
    const path = stdout.trim();
    if (!path) return null;
    return resolve(repoRoot, path);
  } catch {
    signal.throwIfAborted();
    return null;
  }
}

function worktreeMetadataTargets(worktreesPath: string | null): Array<{
  path: string;
  invalidation: RepoStatusInvalidation;
}> {
  if (!worktreesPath) return [];
  try {
    return readdirSync(worktreesPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => [
        {
          path: join(worktreesPath, entry.name, "HEAD"),
          invalidation: { worktrees: true, refs: true },
        },
        {
          path: join(worktreesPath, entry.name, "gitdir"),
          invalidation: { full: true },
        },
        {
          path: join(worktreesPath, entry.name, "commondir"),
          invalidation: { full: true },
        },
      ])
      .filter((target) => existsSync(target.path));
  } catch {
    return [];
  }
}
