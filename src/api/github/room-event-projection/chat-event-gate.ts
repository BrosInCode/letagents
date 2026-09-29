import type { GitHubRoomChatEventKind } from "../../../../shared/room-settings.mjs";
import type { Project } from "../../db.js";
import { loadGitHubRoomChatEventKinds } from "../../db/room-settings.js";

export type GateRoom = Pick<Project, "id" | "parent_room_id">;

const UNREADABLE: unique symbol = Symbol("settings could not be read");

export interface GitHubChatEventGate {
  /** Whether this room takes the event as a message. */
  accepts(room: GateRoom): Promise<boolean>;
  /** The rooms that take the event, asked for in one query. */
  filter<Room extends GateRoom>(rooms: readonly Room[]): Promise<Room[]>;
}

/**
 * Decides, for one GitHub event, which rooms it is posted to as a message.
 *
 * A room admin can turn kinds of events off for the whole room. A room with no
 * choice of its own follows its parent, then the repository room. The event is
 * always recorded; this only decides whether it is also posted.
 *
 * A failed lookup delivers, as every event was delivered before this setting
 * existed: losing a webhook is worse than posting a message someone muted.
 */
export function createGitHubChatEventGate(input: {
  eventKind: GitHubRoomChatEventKind | null;
  repoRoomId: string;
  load?: typeof loadGitHubRoomChatEventKinds;
}): GitHubChatEventGate {
  const load = input.load ?? loadGitHubRoomChatEventKinds;
  // What each room has chosen: its kinds, null when it has not chosen, or
  // UNREADABLE when its settings could not be read.
  const chosenByRoomId = new Map<string, Promise<GitHubRoomChatEventKind[] | null | typeof UNREADABLE>>();

  const candidates = (room: GateRoom): string[] =>
    [...new Set([room.id, room.parent_room_id, input.repoRoomId])].filter((id): id is string => Boolean(id));

  function ensureLoaded(roomIds: readonly string[]): void {
    const missing = [...new Set(roomIds)].filter((id) => !chosenByRoomId.has(id));
    if (!missing.length) return;
    // The failure is handled here, once. Every room below shares this promise,
    // and a rejection left on any of them would end the process.
    const loaded = Promise.resolve()
      .then(() => load(missing))
      .then((kinds) => {
        // Checked inside the handled chain, so an answer of the wrong shape is a failed read too.
        if (!(kinds instanceof Map)) throw new TypeError("room settings were not returned as a map");
        return kinds;
      })
      .catch((error: unknown): typeof UNREADABLE => {
        console.error("[github event filter] settings lookup failed; delivering", { room_ids: missing, error });
        return UNREADABLE;
      });
    for (const id of missing) {
      chosenByRoomId.set(id, loaded.then((kinds) => kinds === UNREADABLE ? UNREADABLE : kinds.get(id) ?? null));
    }
  }

  async function decide(room: GateRoom): Promise<boolean> {
    const eventKind = input.eventKind;
    if (!eventKind) return true;
    for (const id of candidates(room)) {
      const chosen = await chosenByRoomId.get(id);
      if (chosen === UNREADABLE) return true;
      if (chosen) return chosen.includes(eventKind);
    }
    return true;
  }

  return {
    accepts(room) {
      if (input.eventKind) ensureLoaded(candidates(room));
      return decide(room);
    },
    async filter(rooms) {
      if (input.eventKind) ensureLoaded(rooms.flatMap(candidates));
      const accepted = await Promise.all(rooms.map(decide));
      return rooms.filter((_room, index) => accepted[index]);
    },
  };
}
