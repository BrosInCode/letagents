import { withStateFileLock } from "../../../shared/local-worker-state-fence.mjs";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { randomBytes } from "crypto";
import { homedir } from "os";
import { dirname, join } from "path";

import type { LetagentsLocalState } from "./types.js";

const DEFAULT_STATE_PATH = join(homedir(), ".letagents", "mcp-state.json");

export function getLocalStatePath(): string {
  return process.env.LETAGENTS_STATE_PATH || DEFAULT_STATE_PATH;
}

export type LocalStateSnapshot = {
  state: LetagentsLocalState;
  complete: boolean;
};

function readLocalStateSnapshotFromPath(statePath: string): LocalStateSnapshot {
  try {
    const raw = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as LetagentsLocalState;
    return typeof parsed === "object" && parsed && !Array.isArray(parsed)
      ? { state: parsed, complete: true }
      : { state: {}, complete: false };
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { state: {}, complete: true }
      : { state: {}, complete: false };
  }
}

function readLocalStateFromPath(statePath: string): LetagentsLocalState {
  return readLocalStateSnapshotFromPath(statePath).state;
}

export function readLocalStateSnapshot(): LocalStateSnapshot {
  return readLocalStateSnapshotFromPath(getLocalStatePath());
}

export function readLocalState(): LetagentsLocalState {
  return readLocalStateSnapshot().state;
}

/** Hold the existing state lock through a short synchronous local effect. */
export function withLocalStateReadLock<T>(callback: (snapshot: LocalStateSnapshot) => T): T {
  return withStateLock((statePath) => callback(readLocalStateSnapshotFromPath(statePath)));
}

function writeLocalStateUnlocked(statePath: string, state: LetagentsLocalState): void {
  const tempPath = `${statePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(state, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
    renameSync(tempPath, statePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function withStateLock<T>(callback: (statePath: string) => T): T {
  return withStateFileLock(getLocalStatePath(), callback);
}

export function writeLocalState(state: LetagentsLocalState): void {
  withStateLock((statePath) => {
    writeLocalStateUnlocked(statePath, state);
  });
}

export function updateLocalState(
  updater: (state: LetagentsLocalState) => LetagentsLocalState | void
): LetagentsLocalState {
  return withStateLock((statePath) => {
    const current = readLocalStateFromPath(statePath);
    const updated = updater(current) ?? current;
    writeLocalStateUnlocked(statePath, updated);
    return updated;
  });
}
