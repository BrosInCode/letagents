import { withStateFileLock } from "../../../shared/local-worker-state-fence.mjs";
import {
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { randomBytes } from "crypto";
import { dirname, resolve } from "path";

import { letagentsHome, letagentsHomePath } from "../../../shared/letagents-home.mjs";
import {
  ensurePrivateStateFolderSync,
  ownerPrivatePlatform,
  prepareOwnerPrivateReads,
  readOwnerPrivateFileSync,
  writePrivateFileAtomicallySync,
} from "../../../shared/owner-private-fs.mjs";
import { renameWithRetry } from "./rename-retry.js";
import type { LetagentsLocalState } from "./types.js";
import { currentSessionScope, requireScopeWhenHosted } from "../server/runtime/session-scope.js";

const DEFAULT_STATE_PATH = letagentsHomePath("mcp-state.json");
// Windows: the first state read checks the file's DACL; start PowerShell for it now (POSIX: nothing).
prepareOwnerPrivateReads();

export function getLocalStatePath(): string {
  // A remote session has no state file; the name keys per-session maps.
  const scope = currentSessionScope();
  if (scope) return `remote-mcp-session:${scope.sessionId}`;
  requireScopeWhenHosted("The MCP state file");
  return process.env.LETAGENTS_STATE_PATH || DEFAULT_STATE_PATH;
}

export type LocalStateSnapshot = {
  state: LetagentsLocalState;
  complete: boolean;
};

function readLocalStateSnapshotFromPath(statePath: string): LocalStateSnapshot {
  // The file holds the owner token and worker tokens. Windows reads it only
  // while its own DACL is private (POSIX: readFileSync); one that is not is
  // refused, never read as empty state that the next write would replace.
  try {
    const raw = readOwnerPrivateFileSync(statePath, "utf-8", { upgradeAdministratorsOnly: true });
    const parsed = JSON.parse(raw) as LetagentsLocalState;
    return typeof parsed === "object" && parsed && !Array.isArray(parsed)
      ? { state: parsed, complete: true }
      : { state: {}, complete: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EOWNERPRIVATE") throw error;
    return (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { state: {}, complete: true }
      : { state: {}, complete: false };
  }
}

function readLocalStateFromPath(statePath: string): LetagentsLocalState {
  return readLocalStateSnapshotFromPath(statePath).state;
}

export function readLocalStateSnapshot(): LocalStateSnapshot {
  const scope = currentSessionScope();
  // Callers own what they read, as with a fresh parse of the file.
  if (scope) return { state: structuredClone(scope.state.local), complete: true };
  requireScopeWhenHosted("The MCP state file");
  return readLocalStateSnapshotFromPath(getLocalStatePath());
}

export function readLocalState(): LetagentsLocalState {
  return readLocalStateSnapshot().state;
}

/** Hold the existing state lock through a short synchronous local effect. */
export function withLocalStateReadLock<T>(callback: (snapshot: LocalStateSnapshot) => T): T {
  // A session's state is in memory and its callbacks are synchronous.
  if (currentSessionScope()) return callback(readLocalStateSnapshot());
  requireScopeWhenHosted("The MCP state file");
  return withStateLock((statePath) => callback(readLocalStateSnapshotFromPath(statePath)));
}

function writeLocalStateUnlocked(statePath: string, state: LetagentsLocalState): void {
  // Windows has no mode bits: the new file is private from its exclusive
  // create, before any token is written in it. LetAgents' own folder is made
  // private when that hides nothing (then no tool runs per write); any other
  // folder is left as it is and each file gets a protected DACL of its own.
  if (ownerPrivatePlatform() === "win32") {
    if (resolve(dirname(statePath)) === resolve(letagentsHome())) ensurePrivateStateFolderSync(dirname(statePath));
    writePrivateFileAtomicallySync(statePath, JSON.stringify(state, null, 2) + "\n", { syncDirectory: false });
    return;
  }
  const tempPath = `${statePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(state, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
    // A reader may hold the file for a moment on Windows; the rename is retried briefly.
    renameWithRetry(renameSync, tempPath, statePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function withStateLock<T>(callback: (statePath: string) => T): T {
  return withStateFileLock(getLocalStatePath(), callback);
}

export function updateLocalState(
  updater: (state: LetagentsLocalState) => LetagentsLocalState | void
): LetagentsLocalState {
  const scope = currentSessionScope();
  if (scope) {
    const current = structuredClone(scope.state.local);
    const updated = updater(current) ?? current;
    scope.state.local = structuredClone(updated);
    scope.dirty = true;
    return updated;
  }
  requireScopeWhenHosted("The MCP state file");
  return withStateLock((statePath) => {
    const current = readLocalStateFromPath(statePath);
    const updated = updater(current) ?? current;
    writeLocalStateUnlocked(statePath, updated);
    return updated;
  });
}
