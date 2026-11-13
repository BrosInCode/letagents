import type { DesktopRoomMessage } from "../../../electron/ipc-types";
import { roomReadKey } from "./desktop-room-read-state";

export type RoomMessagePage = { messages: DesktopRoomMessage[]; hasMore: boolean };
type LoadRoomMessagePage = (roomIdentifier: string, afterMessageId: string | null) => Promise<RoomMessagePage>;

function messageNumber(id: string | null | undefined): number | null {
  if (!id || !/^msg_[1-9]\d*$/.test(id)) return null;
  const value = Number(id.slice(4));
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * One read of "the messages after X" for the callers that ask while it is in
 * progress. A new message makes the unread counter and the notification check
 * ask for the same page of the same room at the same moment; the second one
 * takes the first one's answer. A finished read is not kept: the next caller
 * reads again.
 *
 * An answer is shared only when it reaches the message the caller knows to be
 * the newest (`latestMessageId`): a read that started before that message
 * existed is never handed to a caller that needs it. Reads of different
 * accounts are kept apart.
 */
export function createSharedRoomMessagePages() {
  const reads = new Map<string, Promise<RoomMessagePage>>();

  function read(key: string, start: () => Promise<RoomMessagePage>): Promise<RoomMessagePage> {
    const promise = start();
    reads.set(key, promise);
    const forget = () => { if (reads.get(key) === promise) reads.delete(key); };
    promise.then(forget, forget);
    return promise;
  }

  async function load(input: {
    accountId: string;
    roomIdentifier: string;
    afterMessageId: string | null;
    /** The newest message the caller knows of. */
    latestMessageId: string | null;
    loadPage: LoadRoomMessagePage;
  }): Promise<RoomMessagePage> {
    const key = JSON.stringify([input.accountId, roomReadKey(input.roomIdentifier) ?? input.roomIdentifier, input.afterMessageId]);
    const start = () => input.loadPage(input.roomIdentifier, input.afterMessageId);
    const shared = reads.get(key);
    const latest = messageNumber(input.latestMessageId);
    if (!shared || latest === null) return read(key, start);
    const page = await shared.catch(() => null);
    if (page?.messages?.some((message) => (messageNumber(message.id) ?? 0) >= latest)) return page;
    // Another caller may have started a newer read while this one waited.
    const newer = reads.get(key);
    return newer && newer !== shared ? newer : read(key, start);
  }

  return { load };
}

/** The app's one share, used by the unread counter and the notification check. */
export const sharedRoomMessagePages = createSharedRoomMessagePages();
