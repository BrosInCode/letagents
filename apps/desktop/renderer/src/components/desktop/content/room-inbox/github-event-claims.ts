import type { DesktopGitHubRoomEvent } from '../../../../../../electron/ipc-types.js';
import type { DesktopAttentionRoom } from '../../../../../../electron/ipc-types/knowledge.js';

/**
 * A focus room reads its repo room's GitHub events unless it owns its own
 * event lane, so rooms that share a lane carry the same events, with the same
 * ids. Each event goes to one room only: the repo room when it carries the
 * event, else the first carrier by room identifier. A focus room that owns its
 * lane has its own event ids, so it keeps all of them.
 *
 * Returns each room's events, in their original order, less the events that
 * another room keeps.
 */
export function claimGitHubEvents(rooms: readonly Pick<DesktopAttentionRoom, 'roomIdentifier' | 'parentRoomIdentifier' | 'updates'>[]): Map<string, DesktopGitHubRoomEvent[]> {
  const carriers = new Map<string, Set<string>>();
  for (const room of rooms) {
    for (const event of room.updates?.githubEvents?.events ?? []) {
      const ids = carriers.get(event.id) ?? new Set<string>();
      carriers.set(event.id, ids.add(room.roomIdentifier));
    }
  }
  const parents = new Map(rooms.map(room => [room.roomIdentifier, room.parentRoomIdentifier]));
  const keeper = new Map<string, string>();
  for (const [eventId, ids] of carriers) {
    const sorted = [...ids].sort();
    keeper.set(eventId, sorted.find(id => sorted.some(other => parents.get(other) === id)) ?? sorted[0]);
  }
  return new Map(rooms.map(room => [room.roomIdentifier,
    (room.updates?.githubEvents?.events ?? []).filter(event => keeper.get(event.id) === room.roomIdentifier)]));
}
