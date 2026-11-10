import type { Express } from "express";

import { loadAccountAttention, type AccountAttentionRoomInput } from "../../account-unread/attention.js";
import { loadAccountRoomUnread, UNREAD_COUNT_CAP } from "../../account-unread/unread.js";
import { getAccountRoomsForAccount } from "../../account-room-membership/list.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import { resolveAccountRoomAccessForEmit } from "../../server/events.js";

export interface AccountUnreadRouteDeps {
  getAccountRoomsForAccount: typeof getAccountRoomsForAccount;
  loadAccountRoomUnread: typeof loadAccountRoomUnread;
  loadAccountAttention: typeof loadAccountAttention;
  /**
   * Whether the account may read the room now, from cached answers only. The
   * room list keeps a repo room it cannot decide (a GitHub outage); a count is
   * given only for an allowed room.
   */
  mayCount(accountId: string, roomId: string): Promise<boolean>;
}

const defaultDeps: AccountUnreadRouteDeps = {
  getAccountRoomsForAccount, loadAccountRoomUnread, loadAccountAttention,
  mayCount: async (accountId, roomId) => (await resolveAccountRoomAccessForEmit({ accountId, roomId })) === "allow",
};

/** Rooms checked at once. */
const CHECKS_AT_ONCE = 3;

/** The room list is capped at this many rooms, as the sidebar and the activity stream are. */
const ACCOUNT_ROOM_LIMIT = 100;

function signedIn(req: AuthenticatedRequest) {
  return req.sessionAccount && (req.authKind === "session" || req.authKind === "owner_token") ? req.sessionAccount : null;
}

/** The rooms `/account/rooms?limit=100` lists, with their focus rooms. */
async function accountRooms(deps: AccountUnreadRouteDeps, accountId: string, login: string): Promise<{ rooms: AccountAttentionRoomInput[]; limited: boolean }> {
  const rooms = await deps.getAccountRoomsForAccount(accountId, { login, limit: ACCOUNT_ROOM_LIMIT });
  return {
    rooms: rooms.flatMap((room) => [room, ...room.focus_rooms]).map((room) => ({
      room_id: room.room_id, role: room.role, latest_message_at: room.latest_message_at,
    })),
    limited: rooms.length >= ACCOUNT_ROOM_LIMIT,
  };
}

/**
 * Account-level reads that replace one request per room:
 * - `GET /account/unread`: each listed room's read point and unread counts,
 *   from the read ranges the account's clients report.
 * - `GET /account/attention`: each listed room's "Needs you" items, with the
 *   per-room access check of `GET /rooms/:room/attention`.
 */
export function registerAccountUnreadRoutes(app: Express, deps: AccountUnreadRouteDeps = defaultDeps): void {
  app.get("/account/unread", async (req: AuthenticatedRequest, res) => {
    const account = signedIn(req);
    if (!account) {
      res.status(401).json({ error: "Unread counts require a signed-in account." });
      return;
    }
    try {
      const { rooms, limited } = await accountRooms(deps, account.account_id, account.login);
      const displayName = "display_name" in account ? account.display_name : null;
      const allowed = new Set<string>();
      const queue = rooms.map((room) => room.room_id);
      await Promise.all(Array.from({ length: Math.min(CHECKS_AT_ONCE, queue.length) }, async () => {
        for (let roomId = queue.shift(); roomId; roomId = queue.shift()) {
          if (await deps.mayCount(account.account_id, roomId).catch(() => false)) allowed.add(roomId);
        }
      }));
      const unread = new Map((await deps.loadAccountRoomUnread({
        accountId: account.account_id,
        ownSenderNames: [account.login, displayName ?? ""],
        roomIds: [...allowed],
      })).map((row) => [row.room_id, row]));
      // A room that cannot be decided now has no count; the desktop then counts it from room history, as before.
      res.json({
        rooms: rooms.map((room) => unread.get(room.room_id)
          ?? { room_id: room.room_id, read_message_id: null, unread_count: null, github_unread_count: null }),
        cap: UNREAD_COUNT_CAP, limited,
      });
    } catch (error) {
      console.error("[account unread] could not load", error);
      res.status(500).json({ error: "Unread counts could not be loaded. Please retry." });
    }
  });

  app.get("/account/attention", async (req: AuthenticatedRequest, res) => {
    const account = signedIn(req);
    if (!account) {
      res.status(401).json({ error: "Needs you requires a signed-in account." });
      return;
    }
    try {
      const { rooms, limited } = await accountRooms(deps, account.account_id, account.login);
      const attention = await deps.loadAccountAttention(account, rooms);
      res.json({ ...attention, limited });
    } catch (error) {
      console.error("[account attention] could not load", error);
      res.status(500).json({ error: "Needs you could not be loaded. Please retry." });
    }
  });
}
