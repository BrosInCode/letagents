/**
 * The room ids the server last listed for the signed-in account. The desktop
 * reads it to tell a server room that has a local- looking id from a device
 * only room, without a network call per read.
 *
 * - Each successful `/account/rooms` fetch REPLACES the list (a 401 empties it).
 * - A sign-in, sign-out or account switch resets it (`clearJoinedRoomInfoCache`).
 * - Until the first list of an account has answered, the list is "not known".
 *   The first read of a folder-derived id waits once for it (bounded), so a
 *   cold start does not decide "local" and store a local record for a room
 *   that the server owns.
 */
const FIRST_LIST_WAIT_MS = 3000;

let listed = new Set<string>();
let known = false;
let waitedOut = false;
let waiters: Array<() => void> = [];
let waitGate: () => Promise<boolean> = async () => {
  const { readStoredAuth } = await import("../auth.js");
  return Boolean((await readStoredAuth()).token);
};

function settle(): void {
  known = true;
  const pending = waiters;
  waiters = [];
  for (const wake of pending) wake();
}

export function rememberServerListedRooms(
  rooms: readonly { roomIdentifier: string; archived: boolean }[],
  options: { signedOut?: boolean } = {},
): void {
  // The sidebar list holds active rooms only, so an archived room is not "listed".
  listed = new Set(options.signedOut ? [] : rooms.filter((room) => !room.archived).map((room) => room.roomIdentifier));
  settle();
}

export function isServerListedRoom(roomIdentifier: string): boolean {
  return listed.has(roomIdentifier);
}

export function resetServerListedRooms(): void {
  listed = new Set();
  known = false;
  waitedOut = false;
}

/**
 * Wait, once, for the first list of this account. It returns at once when the
 * list is known, when nobody is signed in (the gate says no), or after an
 * earlier wait already timed out.
 */
export async function waitForFirstServerList(timeoutMs = FIRST_LIST_WAIT_MS): Promise<void> {
  if (known || waitedOut || !await waitGate()) return;
  if (known) return;
  await new Promise<void>((resolve) => {
    const wake = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      waitedOut = true;
      waiters = waiters.filter((waiter) => waiter !== wake);
      resolve();
    }, timeoutMs);
    waiters.push(wake);
  });
}

/** The wait applies only to a signed-in account. The default reads the stored sign-in; a test sets its own. */
export function setServerListWaitGate(gate: () => Promise<boolean>): void {
  waitGate = gate;
}
