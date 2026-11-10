import type { DesktopRoomStreamEvent } from "../../ipc-types.js";

let streamRevision = 0;

export function invalidateInFlightRoomReads(event: DesktopRoomStreamEvent): void {
  if (event.type === "open" || (event.type === "resource_invalidation"
    && (event.resource === "message_pins" || event.resource === "message_reactions"))) {
    // Fence before notifying the renderer. A new view may replace the one that
    // started the old read, so it cannot rely on that old view's queued refresh.
    // All pending pin/reaction reads are fenced to also cover room aliases.
    streamRevision += 1;
  }
}

/** Share concurrent reads only; settled data must never mask a later invalidation. */
export function createInFlightRoomReads<T>(
  load: (path: string) => Promise<T>,
  readAuth: () => Promise<{ token: string | null }>,
) {
  const pending = new Map<string, { room: string; token: string | null; revision: number; promise: Promise<T> }>();
  return {
    async get(path: string, room: string): Promise<T> {
      const { token } = await readAuth();
      const existing = pending.get(path);
      // Viewer-specific reaction state and private-room data cannot cross sign-ins.
      if (existing?.token === token && existing.revision === streamRevision) return existing.promise;
      const entry = { room, token, revision: streamRevision, promise: Promise.resolve().then(() => load(path)) };
      pending.set(path, entry);
      try {
        return await entry.promise;
      } finally {
        if (pending.get(path) === entry) pending.delete(path);
      }
    },
    invalidate(room: string): void {
      // A post-mutation repair must not reuse a read begun before that write.
      for (const [path, entry] of pending) {
        if (entry.room === room) pending.delete(path);
      }
    },
  };
}
