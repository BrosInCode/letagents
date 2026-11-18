/**
 * Pointer events from the one room stream the desktop already runs, for other
 * parts of main (room pages) that re-read through their own checked routes.
 * A pointer names a resource, never an item; `gap` means the stream may have
 * missed events, so a listener re-reads everything it shows. This module
 * imports nothing, so a listener never pulls in the stream client.
 */
export type RoomStreamPointer =
  | { roomIds: readonly string[]; resource: string }
  | { roomIds: readonly string[]; gap: true };

type Listener = (pointer: RoomStreamPointer) => void;

const listeners = new Set<Listener>();

export function subscribeRoomStreamPointers(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** `roomIds` holds the stream's room identifier and the server's canonical one, which can differ. */
export function publishRoomStreamPointer(pointer: RoomStreamPointer): void {
  for (const listener of listeners) {
    try {
      listener(pointer);
    } catch {
      // One listener that throws does not stop the stream or the others.
    }
  }
}
