/**
 * The room ids the server last listed for the signed-in account. The desktop
 * reads it to tell a server room that has a local- looking id from a device
 * only room, without a network call. It fills from each account room fetch and
 * empties when the server answers 401 (signed out).
 */
const listed = new Set<string>();

export function rememberServerListedRooms(
  rooms: readonly { roomIdentifier: string; archived: boolean }[],
  options: { signedOut?: boolean } = {},
): void {
  if (options.signedOut) listed.clear();
  // The sidebar list holds active rooms only, so an archived room is not "listed".
  for (const room of rooms) {
    if (room.archived) listed.delete(room.roomIdentifier);
    else listed.add(room.roomIdentifier);
  }
}

export function isServerListedRoom(roomIdentifier: string): boolean {
  return listed.has(roomIdentifier);
}

export function resetServerListedRooms(): void {
  listed.clear();
}
