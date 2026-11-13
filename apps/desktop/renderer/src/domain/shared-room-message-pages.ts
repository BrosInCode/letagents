import type { DesktopRoomMessage } from "../../../electron/ipc-types";
import { roomReadKey } from "./desktop-room-read-state";

export type RoomMessagePage = { messages: DesktopRoomMessage[]; hasMore: boolean };
type LoadRoomMessagePage = (roomIdentifier: string, afterMessageId: string | null) => Promise<RoomMessagePage>;

function messageNumber(id: string | null | undefined): number | null {
  if (!id || !/^msg_[1-9]\d*$/.test(id)) return null;
  const value = Number(id.slice(4));
  return Number.isSafeInteger(value) ? value : null;
}

/** A finished read can still answer the other reader for this long. */
export const SHARED_ROOM_MESSAGE_PAGE_MS = 2_000;

/**
 * One read of "the messages after X" for the two readers that want it. A new
 * message makes the unread counter and the notification check ask for the
 * same page of the same room, at the same moment or (in a burst of messages)
 * a moment apart; the second one takes the first one's answer.
 *
 * - Each reader takes a given read once. A reader that asks again (a recount)
 *   always reads again.
 * - An answer is shared only when it reaches the message the caller knows to
 *   be the newest (`latestMessageId`): a read that started before that message
 *   existed is never handed to a caller that needs it.
 * - Reads of different accounts are kept apart.
 */
export function createSharedRoomMessagePages(now: () => number = Date.now) {
  type SharedRead = { promise: Promise<RoomMessagePage>; settledAt: number | null; takenBy: Set<string> };
  const reads = new Map<string, SharedRead>();

  function read(key: string, reader: string, start: () => Promise<RoomMessagePage>): Promise<RoomMessagePage> {
    const entry: SharedRead = { promise: start(), settledAt: null, takenBy: new Set([reader]) };
    reads.set(key, entry);
    entry.promise.then(
      () => { entry.settledAt = now(); },
      () => { if (reads.get(key) === entry) reads.delete(key); },
    );
    return entry.promise;
  }

  async function load(input: {
    accountId: string;
    /** Who asks: a reader never takes the same read twice. */
    reader: string;
    roomIdentifier: string;
    afterMessageId: string | null;
    /** The newest message the caller knows of. */
    latestMessageId: string | null;
    loadPage: LoadRoomMessagePage;
  }): Promise<RoomMessagePage> {
    const key = JSON.stringify([input.accountId, roomReadKey(input.roomIdentifier) ?? input.roomIdentifier, input.afterMessageId]);
    const start = () => input.loadPage(input.roomIdentifier, input.afterMessageId);
    const time = now();
    for (const [oldKey, entry] of reads) {
      if (entry.settledAt !== null && time - entry.settledAt > SHARED_ROOM_MESSAGE_PAGE_MS) reads.delete(oldKey);
    }
    const shared = reads.get(key);
    const latest = messageNumber(input.latestMessageId);
    if (!shared || latest === null || shared.takenBy.has(input.reader)) return read(key, input.reader, start);
    shared.takenBy.add(input.reader);
    const page = await shared.promise.catch(() => null);
    if (page?.messages?.some((message) => (messageNumber(message.id) ?? 0) >= latest)) return page;
    return read(key, input.reader, start);
  }

  return { load };
}

/** The app's one share, used by the unread counter and the notification check. */
export const sharedRoomMessagePages = createSharedRoomMessagePages();
