/**
 * The room ids the server last listed for the signed-in account. The desktop
 * reads it to tell a server room that has a local- looking id from a device
 * only room, without a network call per read.
 *
 * - A successful `/account/rooms` fetch REPLACES the list. A full page (rows ==
 *   limit) may hide rooms, so it only adds active ids and removes archived ones.
 *   A 401 empties the list.
 * - A sign-in, sign-out or account switch resets it (`clearJoinedRoomInfoCache`).
 *   A fetch started before a reset is dropped when it answers.
 * - Until the first list of an account has answered, the list is "not known".
 *   The first read of a folder-derived id with no real local record waits once
 *   for it (bounded). A failed fetch ends the wait without making the list known.
 */
const FIRST_LIST_WAIT_MS = 3000;

type Waiter = { generation: number; wake: () => void };

let listed = new Set<string>();
let known = false;
let failed = false;
let waitedOut = false;
let generation = 0;
let waiters: Waiter[] = [];
let waitGate: () => Promise<boolean> = async () => {
  const { readStoredAuth } = await import("../auth.js");
  return Boolean((await readStoredAuth()).token);
};

function wakeWaiters(): void {
  const pending = waiters;
  waiters = [];
  for (const waiter of pending) waiter.wake();
}

/** Call before a list fetch starts; pass the result back with the answer. */
export function beginServerListFetch(): number {
  return generation;
}

export function rememberServerListedRooms(
  rooms: readonly { roomIdentifier: string; archived: boolean }[],
  options: { signedOut?: boolean; fullPage?: boolean; generation?: number } = {},
): void {
  if (options.generation !== undefined && options.generation !== generation) return;
  const active = rooms.filter((room) => !room.archived).map((room) => room.roomIdentifier);
  if (options.signedOut) listed = new Set();
  else if (options.fullPage) {
    for (const room of rooms) if (room.archived) listed.delete(room.roomIdentifier);
    for (const id of active) listed.add(id);
  } else listed = new Set(active);
  known = true;
  failed = false;
  wakeWaiters();
}

/** The list fetch failed (offline, server error): stop waiting, the list stays not known. */
export function noteServerListFailed(fetchGeneration?: number): void {
  if (fetchGeneration !== undefined && fetchGeneration !== generation) return;
  failed = true;
  wakeWaiters();
}

export function isServerListedRoom(roomIdentifier: string): boolean {
  return listed.has(roomIdentifier);
}

/** A signed-in account whose first list has not answered: a folder-derived id cannot be decided yet. */
export async function isServerListPending(): Promise<boolean> {
  return !known && await waitGate();
}

export function resetServerListedRooms(): void {
  listed = new Set();
  known = false;
  failed = false;
  waitedOut = false;
  generation += 1;
  wakeWaiters();
}

/**
 * Wait, once, for the first list of this account. It returns at once when the
 * list is known or failed, when nobody is signed in, or after an earlier wait
 * timed out.
 */
export async function waitForFirstServerList(timeoutMs = FIRST_LIST_WAIT_MS): Promise<void> {
  if (known || failed || waitedOut || !await waitGate()) return;
  if (known || failed) return;
  const waitGeneration = generation;
  await new Promise<void>((resolve) => {
    const waiter: Waiter = { generation: waitGeneration, wake: () => { clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => {
      waiters = waiters.filter((candidate) => candidate !== waiter);
      // A timer from before a reset says nothing about the new account.
      if (waitGeneration === generation) waitedOut = true;
      resolve();
    }, timeoutMs);
    waiters.push(waiter);
  });
}

/** The wait applies only to a signed-in account. The default reads the stored sign-in; a test sets its own. */
export function setServerListWaitGate(gate: () => Promise<boolean>): void {
  waitGate = gate;
}
