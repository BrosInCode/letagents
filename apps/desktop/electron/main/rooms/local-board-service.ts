import { resolve } from "node:path";
import { createLocalTaskStore } from "../../../../../shared/local-task-store.mjs";
import { onLocalBoardChanged } from "../../../../../shared/local-board-owner.mjs";
import { readLocalTaskRevision } from "../../../../../shared/local-task-revisions.mjs";
import { withRegisteredWorkerStateFence } from "../../../../../shared/local-worker-state-fence.mjs";
import { localChatDatabasePath } from "../chat-storage/settings.js";
import * as store from "./local-store.js";
import { revokeLocalSupervisorEntry, endLocalSupervisorSession } from "./local-supervision-authority.js";

const desktopMutations = {
  addLocalTask: store.addLocalTask,
  updateLocalTask: store.updateLocalTask,
  claimLocalTaskWorkLease: store.claimLocalTaskWorkLease,
  changeLocalTaskWorkLease: store.changeLocalTaskWorkLease,
  claimLocalTaskReviewLease: store.claimLocalTaskReviewLease,
  releaseLocalTaskReviewLease: store.releaseLocalTaskReviewLease,
  importLocalTasks: store.importLocalTasks,
  revokeLocalSupervisorEntry,
  endLocalSupervisorSession,
};
const mcpMutations = new Set(["addLocalTask", "updateLocalTask", "changeLocalTaskWorkLease", "claimLocalTaskReviewLease", "releaseLocalTaskReviewLease"]);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid local board request.");
  return value as Record<string, unknown>;
};

/** Called only within the daemon's generation-fenced board-owner context. */
export async function executeLocalBoardMutation(raw: unknown): Promise<unknown> {
  const input = object(raw);
  if (typeof input.databasePath !== "string" || resolve(input.databasePath) !== resolve(localChatDatabasePath)) {
    throw new Error("This board belongs to a different local data store.");
  }
  if (typeof input.operation !== "string" || !Array.isArray(input.args)) throw new Error("Invalid board operation.");
  if (input.domain === "desktop") {
    if (!Object.hasOwn(desktopMutations, input.operation)) throw new Error("Unknown board operation.");
    const operation = desktopMutations[input.operation as keyof typeof desktopMutations] as (...args: unknown[]) => unknown;
    return operation(...input.args);
  }
  if (input.domain !== "mcp" || !mcpMutations.has(input.operation) || typeof input.statePath !== "string") {
    throw new Error("Unknown board worker operation.");
  }
  // Explicit absence preserves legacy unleased-task operations. A malformed
  // supplied identity must never be downgraded to this non-worker path.
  const supplied = input.worker === null ? null : object(input.worker);
  if (supplied && input.args[0] !== supplied.room_id) throw new Error("The board request belongs to another worker room.");
  let current: Record<string, unknown> | undefined;
  const statePath = input.statePath;
  const tasks = createLocalTaskStore({
    getDb: store.getLocalTaskDatabase,
    currentWorkerCall: () => current as { session_id: string } | undefined,
    withWorkerStateFence: callback => !supplied ? callback() : withRegisteredWorkerStateFence(statePath, supplied, session => {
      current = session;
      try { return callback(); } finally { current = undefined; }
    }),
  });
  const operation = tasks[input.operation as keyof typeof tasks] as (...args: unknown[]) => unknown;
  return operation(...input.args);
}

/** One long-lived wait. No timeout, timer, or idle board read. */
export async function watchLocalBoard(raw: unknown, generation: number, signal: AbortSignal) {
  const input = object(raw);
  if (typeof input.roomId !== "string" || !input.roomId.trim() || input.roomId.length > 1024) throw new Error("Choose a board to watch.");
  const roomId = input.roomId;
  let wake!: () => void;
  let dirty = false;
  const changed = new Promise<void>(resolve => { wake = resolve; });
  const unsubscribe = onLocalBoardChanged(changedRoom => {
    if (changedRoom === roomId) { dirty = true; wake(); }
  });
  const aborted = () => wake();
  signal.addEventListener("abort", aborted, { once: true });
  try {
    signal.throwIfAborted();
    const database = await store.getLocalTaskDatabase();
    let revision = readLocalTaskRevision(database, roomId);
    if (input.generation === generation && input.revision === revision && !dirty) {
      await changed;
      signal.throwIfAborted();
      revision = readLocalTaskRevision(database, roomId);
    }
    const tasks = await store.listLocalTasks(roomId);
    signal.throwIfAborted();
    return { generation, revision, tasks };
  } finally {
    unsubscribe();
    signal.removeEventListener("abort", aborted);
  }
}
