import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { randomBytes } from "crypto";
import { homedir } from "os";
import { dirname, join } from "path";

import type { LetagentsLocalState } from "./types.js";

const DEFAULT_STATE_PATH = join(homedir(), ".letagents", "mcp-state.json");
const STATE_LOCK_WAIT_MS = 25;
const STATE_LOCK_TIMEOUT_MS = 2_000;
const STATE_LOCK_STALE_MS = 10_000;
const STATE_LOCK_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export function getLocalStatePath(): string {
  return process.env.LETAGENTS_STATE_PATH || DEFAULT_STATE_PATH;
}

function readLocalStateFromPath(statePath: string): LetagentsLocalState {
  if (!existsSync(statePath)) {
    return {};
  }

  try {
    const raw = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as LetagentsLocalState;
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

export function readLocalState(): LetagentsLocalState {
  return readLocalStateFromPath(getLocalStatePath());
}

function sleepSync(ms: number): void {
  if (ms > 0) {
    Atomics.wait(STATE_LOCK_SLEEP_BUFFER, 0, 0, ms);
  }
}

function writeLocalStateUnlocked(statePath: string, state: LetagentsLocalState): void {
  const tempPath = `${statePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(state, null, 2) + "\n", "utf-8");
    renameSync(tempPath, statePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function withStateLock<T>(callback: (statePath: string) => T): T {
  const statePath = getLocalStatePath();
  mkdirSync(dirname(statePath), { recursive: true });

  const lockPath = `${statePath}.lock`;
  const startedAt = Date.now();

  while (true) {
    let lockFd: number | null = null;

    try {
      lockFd = openSync(lockPath, "wx");
      return callback(statePath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }

      try {
        const stats = statSync(lockPath);
        if (Date.now() - stats.mtimeMs > STATE_LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() - startedAt >= STATE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out acquiring local state lock at ${lockPath}`);
      }

      sleepSync(STATE_LOCK_WAIT_MS);
    } finally {
      if (lockFd !== null) {
        closeSync(lockFd);
        rmSync(lockPath, { force: true });
      }
    }
  }
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
