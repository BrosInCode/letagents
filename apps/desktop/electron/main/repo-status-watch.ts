import { existsSync, watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { RepoStatus } from "../ipc-types.js";
import { buildRepoStatus } from "../repo-status.js";
import { emitToMainWindow } from "./window.js";

const repoStatusSlowRefreshMs = 5_000;
const repoStatusChangeDebounceMs = 1_500;
const execFileAsync = promisify(execFile);

let activeWatch: {
  rootPath: string;
  watchPathsKey: string;
  watchers: FSWatcher[];
  debounceTimer: NodeJS.Timeout | null;
  intervalTimer: NodeJS.Timeout | null;
  sequence: number;
} | null = null;
let watchRequestId = 0;

export async function startRepoStatusWatch(rootPath: string): Promise<RepoStatus> {
  const requestId = ++watchRequestId;
  closeActiveWatch();

  const status = await buildRepoStatus(rootPath);
  if (requestId !== watchRequestId) {
    return status;
  }

  const watchPaths = await repoStatusWatchPaths(status);
  if (requestId !== watchRequestId) {
    return status;
  }
  const watchState = {
    rootPath: status.rootPath || rootPath,
    watchPathsKey: watchPaths.join("\n"),
    watchers: [] as FSWatcher[],
    debounceTimer: null as NodeJS.Timeout | null,
    intervalTimer: null as NodeJS.Timeout | null,
    sequence: 0,
  };
  activeWatch = watchState;

  watchState.watchers = openWatchers(watchPaths, watchState);

  watchState.intervalTimer = setInterval(() => {
    scheduleRepoStatusRefresh(watchState);
  }, repoStatusSlowRefreshMs);

  return status;
}

export function stopRepoStatusWatch(): void {
  watchRequestId += 1;
  closeActiveWatch();
}

function closeActiveWatch(): void {
  const watchState = activeWatch;
  activeWatch = null;
  if (!watchState) return;
  closeWatchers(watchState);
  if (watchState.debounceTimer) {
    clearTimeout(watchState.debounceTimer);
    watchState.debounceTimer = null;
  }
  if (watchState.intervalTimer) {
    clearInterval(watchState.intervalTimer);
    watchState.intervalTimer = null;
  }
}

function closeWatchers(watchState: NonNullable<typeof activeWatch>): void {
  for (const watcher of watchState.watchers) {
    try {
      watcher.close();
    } catch {
      // Watcher cleanup must not interrupt app shutdown or repo switching.
    }
  }
  watchState.watchers = [];
}

function openWatchers(
  paths: readonly string[],
  watchState: NonNullable<typeof activeWatch>,
): FSWatcher[] {
  const watchers: FSWatcher[] = [];
  for (const path of paths) {
    try {
      const watcher = watch(path, { persistent: false }, () => {
        scheduleRepoStatusRefresh(watchState);
      });
      watcher.on("error", () => {
        scheduleRepoStatusRefresh(watchState);
      });
      watchers.push(watcher);
    } catch {
      // Missing refs are covered by packed-refs and the slow refresh.
    }
  }
  return watchers;
}

function scheduleRepoStatusRefresh(watchState: NonNullable<typeof activeWatch>): void {
  if (activeWatch !== watchState) return;
  if (watchState.debounceTimer) {
    clearTimeout(watchState.debounceTimer);
  }
  watchState.debounceTimer = setTimeout(() => {
    watchState.debounceTimer = null;
    void refreshRepoStatus(watchState);
  }, repoStatusChangeDebounceMs);
}

async function refreshRepoStatus(watchState: NonNullable<typeof activeWatch>): Promise<void> {
  if (activeWatch !== watchState) return;
  const sequence = ++watchState.sequence;
  const status = await buildRepoStatus(watchState.rootPath).catch(() => null);
  if (!status || activeWatch !== watchState || sequence !== watchState.sequence) return;

  const nextWatchPaths = await repoStatusWatchPaths(status);
  if (activeWatch !== watchState || sequence !== watchState.sequence) return;
  const nextWatchPathsKey = nextWatchPaths.join("\n");
  if (nextWatchPathsKey !== watchState.watchPathsKey) {
    closeWatchers(watchState);
    watchState.watchPathsKey = nextWatchPathsKey;
    watchState.watchers = openWatchers(nextWatchPaths, watchState);
  }

  emitToMainWindow("desktop:repos:status-changed", status);
}

async function repoStatusWatchPaths(status: RepoStatus): Promise<string[]> {
  if (!status.isGitRepo || !status.rootPath) return [];
  const candidates = [
    status.gitHeadPath,
    await gitPath(status.rootPath, "index"),
    await gitPath(status.rootPath, "packed-refs"),
    status.branch ? await gitPath(status.rootPath, `refs/heads/${status.branch}`) : null,
    status.upstream ? await gitPath(status.rootPath, `refs/remotes/${status.upstream}`) : null,
    status.rootPath,
  ];

  return Array.from(new Set(candidates
    .filter((path): path is string => Boolean(path))
    .map((path) => resolve(path))
    .filter((path) => existsSync(path))));
}

async function gitPath(repoRoot: string, relativeGitPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--git-path", relativeGitPath], {
      cwd: repoRoot,
    });
    const path = stdout.trim();
    if (!path) return null;
    return resolve(repoRoot, path);
  } catch {
    return null;
  }
}
